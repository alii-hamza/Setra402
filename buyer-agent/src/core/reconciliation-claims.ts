import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  DurableJournal,
  ensureDurableDirectory,
  syncDirectory,
} from "./journal.js";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const reconciliationClaimV1Schema = z
  .object({
    version: z.literal("1"),
    taskKey: hash,
    claimId: z.string().uuid(),
    instanceId: z.string().uuid(),
    pid: z.number().int().positive(),
    processStartIdentity: z.string().min(1).max(160),
    createdAtUnixMs: z.number().int().safe().nonnegative(),
    heartbeatAtUnixMs: z.number().int().safe().nonnegative(),
    expiresAtUnixMs: z.number().int().safe().nonnegative(),
  })
  .strict()
  .superRefine((claim, context) => {
    if (
      claim.createdAtUnixMs > claim.heartbeatAtUnixMs ||
      claim.heartbeatAtUnixMs > claim.expiresAtUnixMs
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "invalid claim lease chronology",
      });
  });
export type ReconciliationClaimV1 = z.infer<typeof reconciliationClaimV1Schema>;
export type ProcessIdentityProbe = (pid: number) => string | null | undefined;

/** The start identity is OS-observed, not inferred from PID or a wall-clock guess. */
export const processStartIdentity: ProcessIdentityProbe = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "win32") {
      const output = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks`,
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 2_000,
          maxBuffer: 1_024,
        }
      ).trim();
      return output || null;
    }
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = after[19]; // /proc field 22, after fields 1 and 2.
    return boot && ticks ? `${boot}:${ticks}` : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return undefined;
  }
};

export type ClaimResult =
  | {
      status: "ACQUIRED";
      claim: ReconciliationClaimV1;
      recoveredStale: boolean;
    }
  | { status: "BUSY" | "OPERATOR_REVIEW_REQUIRED"; reason: string };

/** Exclusive local claim. The short filesystem gate is never auto-broken. */
export class ReconciliationClaims {
  private readonly journal = new DurableJournal();
  readonly root: string;
  readonly instanceId = randomUUID();
  readonly pid = process.pid;
  readonly startIdentity: string;
  constructor(
    stateDirectory: string,
    private readonly options: {
      now?: () => number;
      probe?: ProcessIdentityProbe;
      leaseMs?: number;
    } = {}
  ) {
    this.root = resolve(stateDirectory, "reconciliation");
    const leaseMs = options.leaseMs ?? 30_000;
    if (
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 1_000 ||
      leaseMs > 3_600_000
    )
      throw new Error("invalid reconciliation lease duration");
    this.startIdentity =
      (options.probe ?? processStartIdentity)(this.pid) ?? "";
    if (!this.startIdentity)
      throw new Error("OS process-start identity unavailable; worker disabled");
    for (const name of ["claims", "claim-history", "gates"])
      ensureDurableDirectory(join(this.root, name));
  }
  private get now() {
    return this.options.now ?? Date.now;
  }
  private get probe() {
    return this.options.probe ?? processStartIdentity;
  }
  private get leaseMs() {
    return this.options.leaseMs ?? 30_000;
  }
  private claimPath(taskKey: string) {
    hash.parse(taskKey);
    return join(this.root, "claims", `${taskKey}.claim`);
  }
  private gate(
    taskKey: string,
    work: () => ClaimResult | void
  ): ClaimResult | void {
    hash.parse(taskKey);
    const path = join(this.root, "gates", `${taskKey}.gate`);
    try {
      mkdirSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        return {
          status: "OPERATOR_REVIEW_REQUIRED",
          reason: "claim gate is occupied; ownership not proven",
        };
      throw error;
    }
    try {
      return work();
    } finally {
      rmdirSync(path);
      syncDirectory(join(this.root, "gates"));
    }
  }
  read(taskKey: string): ReconciliationClaimV1 | null {
    const value = this.journal.read(this.claimPath(taskKey));
    if (value === null) return null;
    const claim = reconciliationClaimV1Schema.parse(value);
    if (claim.taskKey !== taskKey)
      throw new Error("claim task binding conflict");
    return claim;
  }
  private archive(
    claim: ReconciliationClaimV1,
    suffix: "stale" | "released"
  ): void {
    const target = join(
      this.root,
      "claim-history",
      `${claim.taskKey}.${claim.claimId}.${suffix}.json`
    );
    if (existsSync(target)) throw new Error("claim history collision");
    renameSync(this.claimPath(claim.taskKey), target);
    syncDirectory(join(this.root, "claims"));
    syncDirectory(join(this.root, "claim-history"));
  }
  acquire(taskKey: string): ClaimResult {
    return this.gate(taskKey, () => {
      let prior: ReconciliationClaimV1 | null;
      try {
        prior = this.read(taskKey);
      } catch {
        return {
          status: "OPERATOR_REVIEW_REQUIRED",
          reason: "corrupt or unknown-version claim",
        };
      }
      let recoveredStale = false;
      if (prior) {
        if (this.now() <= prior.expiresAtUnixMs)
          return { status: "BUSY", reason: "claim lease has not expired" };
        const observed = this.probe(prior.pid);
        if (observed === undefined)
          return {
            status: "OPERATOR_REVIEW_REQUIRED",
            reason: "process incarnation cannot be established",
          };
        if (observed === prior.processStartIdentity)
          return {
            status: "BUSY",
            reason: "recorded process incarnation is still present",
          };
        // An expired lease plus absent/different OS start identity proves
        // the recorded process incarnation is gone. PID absence alone never
        // triggers takeover. The gate serializes competing claimants.
        this.archive(prior, "stale");
        recoveredStale = true;
      }
      const now = this.now();
      const claim = reconciliationClaimV1Schema.parse({
        version: "1",
        taskKey,
        claimId: randomUUID(),
        instanceId: this.instanceId,
        pid: this.pid,
        processStartIdentity: this.startIdentity,
        createdAtUnixMs: now,
        heartbeatAtUnixMs: now,
        expiresAtUnixMs: now + this.leaseMs,
      });
      if (!this.journal.publish(this.claimPath(taskKey), claim))
        return {
          status: "BUSY",
          reason: "another worker won exclusive publication",
        };
      return { status: "ACQUIRED", claim, recoveredStale };
    }) as ClaimResult;
  }
  heartbeat(claim: ReconciliationClaimV1): void {
    const result = this.gate(claim.taskKey, () => {
      const current = this.read(claim.taskKey);
      if (
        !current ||
        current.claimId !== claim.claimId ||
        current.instanceId !== this.instanceId
      )
        throw new Error("reconciliation claim ownership lost");
      const now = this.now();
      this.journal.write(this.claimPath(claim.taskKey), {
        ...current,
        heartbeatAtUnixMs: now,
        expiresAtUnixMs: now + this.leaseMs,
      });
    });
    if (result) throw new Error("reconciliation claim gate unavailable");
  }
  release(claim: ReconciliationClaimV1): void {
    const result = this.gate(claim.taskKey, () => {
      const current = this.read(claim.taskKey);
      if (
        !current ||
        current.claimId !== claim.claimId ||
        current.instanceId !== this.instanceId
      )
        throw new Error("reconciliation claim ownership lost");
      this.archive(current, "released");
    });
    if (result) throw new Error("reconciliation claim gate unavailable");
  }
  listActive(): ReconciliationClaimV1[] {
    return readdirSync(join(this.root, "claims"))
      .filter((name) => name.endsWith(".claim"))
      .map((name) => this.read(name.slice(0, -6))!);
  }
  listGates(): string[] {
    return readdirSync(join(this.root, "gates")).sort();
  }
}
