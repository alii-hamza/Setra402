import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { DurableJournal } from "../core/journal.js";
import {
  scanRecoveryInventory,
  type RecoveryInventoryOptions,
} from "../core/recovery-inventory.js";
import { parseVerificationPolicy } from "./policy.js";

const evidence = z.enum(["ABSENT", "VALID", "CORRUPT"]);
export const verificationRecoveryV1Schema = z
  .object({
    version: z.literal("1"),
    taskKey: z.string().regex(/^[0-9a-f]{64}$/),
    evidence: z
      .object({
        manifest: evidence,
        quote: evidence,
        result: evidence,
        report: evidence,
        sourceChallenge: z.enum([
          "NOT_REQUIRED",
          "UNDETERMINED",
          "VALID",
          "MISSING",
          "CORRUPT",
        ]),
      })
      .strict(),
    sandboxLeases: z.array(
      z
        .object({
          container: z.string(),
          owner: z.enum([
            "PID_PRESENT_UNVERIFIED",
            "PID_ABSENT",
            "PROBE_UNAVAILABLE",
            "CORRUPT",
          ]),
          containerState: z.literal("NOT_QUERIED"),
        })
        .strict()
    ),
    reportVerdict: z.enum(["PASS_RECORDED", "FAIL_RECORDED", "NONE"]),
    classification: z.enum([
      "PROVEN_OCCURRED",
      "SAFE_TO_REVERIFY",
      "UNKNOWN_EXTERNAL_EFFECT",
      "RECONCILIATION_REQUIRED",
    ]),
    recommendedAction: z.enum([
      "NO_ACTION",
      "READ_ONLY_RECONCILIATION",
      "SAFE_TO_REVERIFY",
      "OPERATOR_REVIEW_REQUIRED",
    ]),
    reasons: z.array(z.string()),
  })
  .strict();
export type VerificationRecoveryV1 = z.infer<
  typeof verificationRecoveryV1Schema
>;

function status(
  records: { status: "VALID" | "CORRUPT" }[] | undefined
): "ABSENT" | "VALID" | "CORRUPT" {
  if (!records?.length) return "ABSENT";
  return records.some((r) => r.status === "CORRUPT") ? "CORRUPT" : "VALID";
}

/** Evidence-only assessment. It never invokes a verifier, sandbox or signer. */
export function inspectVerificationRecovery(
  options: RecoveryInventoryOptions & { taskKey: string },
  pidProbe: (pid: number) => "PRESENT" | "ABSENT" | "UNAVAILABLE" = (pid) => {
    try {
      process.kill(pid, 0);
      return "PRESENT";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH"
        ? "ABSENT"
        : "UNAVAILABLE";
    }
  }
): VerificationRecoveryV1 {
  if (!/^[0-9a-f]{64}$/.test(options.taskKey))
    throw new Error("invalid recovery task key");
  const inventory = scanRecoveryInventory(options);
  const task = inventory.tasks.find(
    (candidate) => candidate.taskKey === options.taskKey
  );
  if (!task)
    throw new Error(
      "task absent from recovery inventory; absence is not non-occurrence proof"
    );
  const records = task.evidence;
  const result = status(records.result);
  const report = status(records.verification);
  const quoteRecords = records.tasks?.filter(
    (record) => record.role === "quote.json"
  );
  const quote = status(quoteRecords);
  const manifest = status(records.manifest);
  const reasons = [...inventory.conflicts, ...task.conflicts];
  if (inventory.staleTemporaryFiles.length)
    reasons.push(
      "stale temporary journal file; publication outcome unresolved"
    );
  const leases = inventory.unattached
    .filter((record) => record.family === "sandboxLease")
    .map((record) => {
      let owner:
        | "PID_PRESENT_UNVERIFIED"
        | "PID_ABSENT"
        | "PROBE_UNAVAILABLE"
        | "CORRUPT" = "CORRUPT";
      let container = basename(record.path, ".lease");
      if (record.status === "VALID") {
        try {
          const lease = new DurableJournal().read(record.path) as {
            pid: number;
            container: string;
            directory: string;
          };
          if (
            lease.container !== container ||
            dirname(resolve(lease.directory)) !== resolve(tmpdir()) ||
            !basename(lease.directory).startsWith(
              `${lease.container.slice(0, -37)}-input-`
            )
          )
            throw new Error("invalid lease path");
          container = lease.container;
          const pid = pidProbe(lease.pid);
          owner =
            pid === "PRESENT"
              ? "PID_PRESENT_UNVERIFIED"
              : pid === "ABSENT"
              ? "PID_ABSENT"
              : "PROBE_UNAVAILABLE";
        } catch {
          owner = "CORRUPT";
        }
      }
      return { container, owner, containerState: "NOT_QUERIED" as const };
    });
  if (leases.length)
    reasons.push("unattributed sandbox lease; container state not established");

  let sourceChallenge: VerificationRecoveryV1["evidence"]["sourceChallenge"] =
    "NOT_REQUIRED";
  if (quote === "VALID") {
    try {
      const quoteRecord = quoteRecords?.find((r) => r.status === "VALID");
      const saved = new DurableJournal().read(quoteRecord!.path) as {
        verification_policy: unknown;
      };
      const count = parseVerificationPolicy(
        saved.verification_policy
      ).checks.filter((check) => check.type === "source_sampling").length;
      if (count) {
        if (result === "ABSENT") sourceChallenge = "UNDETERMINED";
        else {
          const challenges = records.challenge ?? [];
          sourceChallenge = challenges.some((r) => r.status === "CORRUPT")
            ? "CORRUPT"
            : challenges.length === count
            ? "VALID"
            : "MISSING";
          if (sourceChallenge !== "VALID")
            reasons.push("committed source challenge missing or corrupt");
        }
      }
    } catch {
      sourceChallenge = "CORRUPT";
      reasons.push("verification policy could not be read");
    }
  }
  let reportVerdict: VerificationRecoveryV1["reportVerdict"] = "NONE";
  if (report === "VALID") {
    try {
      const record = records.verification!.find((r) => r.status === "VALID")!;
      const saved = new DurableJournal().read(record.path) as {
        passed: boolean;
      };
      reportVerdict = saved.passed ? "PASS_RECORDED" : "FAIL_RECORDED";
    } catch {
      reasons.push("verification report could not be read");
    }
  }
  let classification: VerificationRecoveryV1["classification"];
  let recommendedAction: VerificationRecoveryV1["recommendedAction"];
  if (
    reasons.length ||
    [manifest, quote, result, report].includes("CORRUPT") ||
    sourceChallenge === "CORRUPT"
  ) {
    classification = "RECONCILIATION_REQUIRED";
    recommendedAction = "OPERATOR_REVIEW_REQUIRED";
  } else if (result === "ABSENT") {
    classification = records.tasks?.some((r) => r.role === "run.intent")
      ? "UNKNOWN_EXTERNAL_EFFECT"
      : "RECONCILIATION_REQUIRED";
    recommendedAction = "READ_ONLY_RECONCILIATION";
  } else if (
    manifest !== "VALID" ||
    quote !== "VALID" ||
    sourceChallenge === "MISSING"
  ) {
    classification = "RECONCILIATION_REQUIRED";
    recommendedAction = "READ_ONLY_RECONCILIATION";
  } else if (report === "VALID") {
    classification = "PROVEN_OCCURRED"; // Only local report publication, never current verdict or settlement authority.
    recommendedAction = "READ_ONLY_RECONCILIATION";
  } else {
    classification = "SAFE_TO_REVERIFY";
    recommendedAction = "SAFE_TO_REVERIFY";
  }
  return verificationRecoveryV1Schema.parse({
    version: "1",
    taskKey: options.taskKey,
    evidence: { manifest, quote, result, report, sourceChallenge },
    sandboxLeases: leases,
    reportVerdict,
    classification,
    recommendedAction,
    reasons,
  });
}
