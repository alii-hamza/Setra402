import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { DurableJournal } from "./journal.js";
import { hashCanonical } from "../manifest/hash.js";
import { ManifestStore, type StoredManifest } from "../manifest/store.js";
import { parseResultEnvelope } from "../verification/contracts.js";
import { parseVerificationPolicy } from "../verification/policy.js";
import { deriveTaskPda, deriveVaultPda } from "../chain/pda.js";
import type { ResultEnvelopeV1, VerificationReport } from "../types.js";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const decimal = z.string().regex(/^(0|[1-9]\d*)$/);
const pubkey = z.string().refine((value) => {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
});
const classificationSchema = z.enum([
  "PROVEN_NOT_OCCURRED",
  "PROVEN_OCCURRED",
  "SAFE_TO_RETRY",
  "UNKNOWN_EXTERNAL_EFFECT",
  "UNKNOWN_FINANCIAL_OUTCOME",
  "RECONCILIATION_REQUIRED",
]);
const recordSchema = z
  .object({
    family: z.string(),
    role: z.string(),
    path: z.string(),
    source: z.enum(["buyer_local", "seller_local"]),
    status: z.enum(["VALID", "CORRUPT"]),
  })
  .strict();
const taskSchema = z
  .object({
    taskKey: z.string(),
    taskIdentity: z
      .object({
        buyer: pubkey,
        taskId: decimal,
        serviceId: z.string().min(1),
        privacy: z.boolean(),
      })
      .strict()
      .nullable(),
    evidence: z.record(z.array(recordSchema)),
    authoritativeEvidence: z
      .object({
        taskState: z.literal("NOT_QUERIED"),
        nullifierRecord: z.literal("NOT_QUERIED"),
      })
      .strict(),
    conflicts: z.array(z.string()),
    classifications: z.array(classificationSchema),
    recommendedAction: z.enum([
      "READ_ONLY_RECONCILIATION",
      "SAFE_TO_REVERIFY",
      "SAFE_TO_RETRY",
      "NO_ACTION",
      "OPERATOR_REVIEW_REQUIRED",
    ]),
  })
  .strict();
export const recoveryInventoryV1Schema = z
  .object({
    version: z.literal("1"),
    families: z.record(
      z.enum(["PRESENT", "MISSING", "UNREADABLE", "NOT_CONFIGURED"])
    ),
    authoritativeExternalEvidence: z.literal("NOT_QUERIED"),
    recommendedAction: z.enum([
      "READ_ONLY_RECONCILIATION",
      "SAFE_TO_REVERIFY",
      "SAFE_TO_RETRY",
      "NO_ACTION",
      "OPERATOR_REVIEW_REQUIRED",
    ]),
    tasks: z.array(taskSchema),
    unattached: z.array(recordSchema),
    conflicts: z.array(z.string()),
    staleTemporaryFiles: z.array(z.string()),
  })
  .strict();
export type RecoveryInventoryV1 = z.infer<typeof recoveryInventoryV1Schema>;
type Task = RecoveryInventoryV1["tasks"][number];
type RecordStatus = z.infer<typeof recordSchema>;
type Family =
  | "tasks"
  | "manifests"
  | "transactions"
  | "checkpoints"
  | "vouchers"
  | "challenges"
  | "sandbox-leases"
  | "seller-executions"
  | "mint-issuance";
const buyerFamilies: Family[] = [
  "tasks",
  "manifests",
  "transactions",
  "checkpoints",
  "vouchers",
  "challenges",
  "sandbox-leases",
];
const hexKey = /^[0-9a-f]{64}$/;
const taskName =
  /^([0-9a-f]{64})\.(identity|quote\.json|fund\.intent|funded\.json|run\.intent|result\.json)$/;
const financialName =
  /^([0-9a-f]{64})\.(intent|transaction\.json|confirmed\.json)$/;
const checkpointName = /^([0-9a-f]{64})\.(result|report)\.json$/;
const voucherName = /^([0-9a-f]{64})\.(intent|voucher\.json)$/;
const sellerName = /^([1-9A-HJ-NP-Za-km-z]{32,44})\.(intent|json)$/;
const journal = new DurableJournal();
const financialIntentSchema = z
  .object({
    operation: z
      .object({
        programId: pubkey.optional(),
        taskState: pubkey,
        kind: z.enum(["funding", "settlement", "refund", "cancel"]),
        binding: hash.optional(),
      })
      .strict(),
    state: z.literal("UNKNOWN_FINANCIAL_OUTCOME"),
  })
  .strict();
const preparedSchema = z
  .object({
    signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/),
    blockhash: pubkey,
    lastValidBlockHeight: z.number().int().safe().nonnegative(),
    fingerprint: hash,
    signedAtUnix: z.number().int().safe().nonnegative(),
  })
  .strict();
const confirmationSchema = z
  .object({
    signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/),
    confirmedAtUnix: z.number().int().safe().nonnegative(),
  })
  .strict();

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("record is not an object");
  return value as Record<string, unknown>;
}
function strictKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join(",") !== keys.sort().join(","))
    throw new Error("record keys do not match the committed format");
}
function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile())
        throw new Error(`unexpected non-file in ${directory}`);
      return entry.name;
    })
    .sort();
}
function taskFor(map: Map<string, Task>, key: string): Task {
  let task = map.get(key);
  if (!task) {
    task = {
      taskKey: key,
      taskIdentity: null,
      evidence: {},
      authoritativeEvidence: {
        taskState: "NOT_QUERIED",
        nullifierRecord: "NOT_QUERIED",
      },
      conflicts: [],
      classifications: [],
      recommendedAction: "OPERATOR_REVIEW_REQUIRED",
    };
    map.set(key, task);
  }
  return task;
}
function add(task: Task, record: RecordStatus): void {
  (task.evidence[record.family] ??= []).push(record);
  if (record.status === "CORRUPT")
    task.conflicts.push(`${record.family}: corrupt ${record.role}`);
}
function conflict(task: Task, message: string): void {
  if (!task.conflicts.includes(message)) task.conflicts.push(message);
}
function inspect(
  directory: string,
  name: string,
  family: string,
  role: string,
  source: RecordStatus["source"],
  parse: (path: string) => unknown
): { record: RecordStatus; value: unknown | null } {
  const path = join(directory, name);
  try {
    const value = parse(path);
    return {
      record: { family, role, path, source, status: "VALID" },
      value,
    };
  } catch {
    return {
      record: { family, role, path, source, status: "CORRUPT" },
      value: null,
    };
  }
}
function readJournal(path: string): unknown {
  const value = journal.read(path);
  if (value === null) throw new Error("journal disappeared during scan");
  return value;
}
function readManifest(path: string): StoredManifest {
  const value = new ManifestStore(dirname(path)).load(basename(path, ".json"));
  if (!value) throw new Error("manifest disappeared during scan");
  pubkey.parse(value.manifest.buyer);
  return value;
}
function readQuote(path: string): Record<string, unknown> {
  const value = object(readJournal(path));
  strictKeys(value, [
    "task_id",
    "program_id",
    "task_state_pda",
    "vault_pda",
    "mint",
    "seller_token_account",
    "verifier",
    "amount",
    "timeout_seconds",
    "is_private",
    "protocol_fee_bps",
    "service_id",
    "verification_policy",
    "policy_hash",
  ]);
  const policy = parseVerificationPolicy(value.verification_policy);
  if (
    !(
      typeof value.task_id === "string" || Number.isSafeInteger(value.task_id)
    ) ||
    !decimal.safeParse(String(value.task_id)).success ||
    !pubkey.safeParse(value.program_id).success ||
    !pubkey.safeParse(value.task_state_pda).success ||
    !pubkey.safeParse(value.vault_pda).success ||
    !pubkey.safeParse(value.mint).success ||
    !pubkey.safeParse(value.seller_token_account).success ||
    !pubkey.safeParse(value.verifier).success ||
    !(typeof value.amount === "string" || Number.isSafeInteger(value.amount)) ||
    !decimal.safeParse(String(value.amount)).success ||
    BigInt(String(value.amount)) <= 0n ||
    !Number.isSafeInteger(value.timeout_seconds) ||
    Number(value.timeout_seconds) <= 0 ||
    typeof value.is_private !== "boolean" ||
    value.protocol_fee_bps !== 100 ||
    typeof value.service_id !== "string" ||
    value.service_id.length === 0 ||
    value.policy_hash !== hashCanonical(policy)
  )
    throw new Error("invalid canonical quote");
  return value;
}
function readResult(path: string): ResultEnvelopeV1 {
  const result = parseResultEnvelope(readJournal(path));
  if (
    result.resultHash !== hashCanonical(result.result) ||
    result.output_hash !== hashCanonical(result.input)
  )
    throw new Error("result commitment mismatch");
  return result;
}
function readReport(path: string): VerificationReport {
  const raw = object(readJournal(path));
  strictKeys(raw, [
    "taskId",
    "serviceId",
    "level",
    "manifestHash",
    "policyHash",
    "resultHash",
    "checks",
    "passed",
    "verifierPubkey",
    "startedAtUnix",
    "completedAtUnix",
  ]);
  if (
    !decimal.safeParse(raw.taskId).success ||
    typeof raw.serviceId !== "string" ||
    ![1, 2].includes(raw.level as number) ||
    !hash.safeParse(raw.manifestHash).success ||
    !hash.safeParse(raw.policyHash).success ||
    !hash.safeParse(raw.resultHash).success ||
    !pubkey.safeParse(raw.verifierPubkey).success ||
    !Array.isArray(raw.checks) ||
    raw.checks.length === 0 ||
    raw.checks.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        typeof item.type !== "string" ||
        typeof item.passed !== "boolean" ||
        typeof item.message !== "string"
    ) ||
    typeof raw.passed !== "boolean" ||
    raw.passed !==
      raw.checks.every((item: { passed: boolean }) => item.passed) ||
    !Number.isSafeInteger(raw.startedAtUnix) ||
    !Number.isSafeInteger(raw.completedAtUnix)
  )
    throw new Error("invalid verification report");
  return raw as unknown as VerificationReport;
}

export interface RecoveryInventoryOptions {
  stateDirectory: string;
  sellerExecutionDirectory?: string;
  sellerMintDirectory?: string;
  sellerUrl?: string;
  configuredBuyer?: string;
}

/** Local evidence discovery only. It never calls RPC, HTTP, Docker or a signer. */
export function scanRecoveryInventory(
  options: RecoveryInventoryOptions
): RecoveryInventoryV1 {
  const root = resolve(options.stateDirectory);
  const tasks = new Map<string, Task>();
  const unattached: RecordStatus[] = [];
  const conflicts: string[] = [];
  const staleTemporaryFiles: string[] = [];
  const families: Record<
    string,
    "PRESENT" | "MISSING" | "UNREADABLE" | "NOT_CONFIGURED"
  > = {};
  if (!existsSync(root) || !statSync(root).isDirectory())
    return recoveryInventoryV1Schema.parse({
      version: "1",
      families: Object.fromEntries(
        [...buyerFamilies, "seller-executions", "mint-issuance"].map((name) => [
          name,
          "MISSING",
        ])
      ),
      authoritativeExternalEvidence: "NOT_QUERIED",
      recommendedAction: "OPERATOR_REVIEW_REQUIRED",
      tasks: [],
      unattached: [],
      conflicts: ["state root is missing; no non-occurrence can be inferred"],
      staleTemporaryFiles: [],
    });
  const familyPath = (family: Family) =>
    family === "seller-executions"
      ? resolve(options.sellerExecutionDirectory!)
      : family === "mint-issuance"
      ? resolve(
          options.sellerMintDirectory ??
            join(dirname(options.sellerExecutionDirectory!), "mint-issuance")
        )
      : join(root, family);
  const listing = new Map<Family, string[]>();
  for (const family of buyerFamilies) {
    const directory = familyPath(family);
    families[family] = existsSync(directory) ? "PRESENT" : "MISSING";
    try {
      listing.set(
        family,
        files(directory).filter((name) => {
          if (!name.endsWith(".tmp")) return true;
          staleTemporaryFiles.push(join(directory, name));
          return false;
        })
      );
    } catch {
      families[family] = "UNREADABLE";
      conflicts.push(`${family}: unreadable or unexpected directory contents`);
      listing.set(family, []);
    }
  }
  if (options.sellerExecutionDirectory) {
    const directory = familyPath("seller-executions");
    families["seller-executions"] = existsSync(directory)
      ? "PRESENT"
      : "MISSING";
    try {
      listing.set(
        "seller-executions",
        files(directory).filter((name) => {
          if (!name.endsWith(".tmp")) return true;
          staleTemporaryFiles.push(join(directory, name));
          return false;
        })
      );
    } catch {
      families["seller-executions"] = "UNREADABLE";
      conflicts.push(
        "seller-executions: unreadable or unexpected directory contents"
      );
      listing.set("seller-executions", []);
    }
  } else families["seller-executions"] = "NOT_CONFIGURED";
  if (options.sellerMintDirectory || options.sellerExecutionDirectory) {
    const directory = familyPath("mint-issuance");
    families["mint-issuance"] = existsSync(directory) ? "PRESENT" : "MISSING";
    try {
      listing.set(
        "mint-issuance",
        files(directory).filter((name) => {
          if (!name.endsWith(".tmp")) return true;
          staleTemporaryFiles.push(join(directory, name));
          return false;
        })
      );
    } catch {
      families["mint-issuance"] = "UNREADABLE";
      conflicts.push(
        "mint-issuance: unreadable or unexpected directory contents"
      );
      listing.set("mint-issuance", []);
    }
  } else families["mint-issuance"] = "NOT_CONFIGURED";

  const byPda = new Map<string, Task>();
  const byController = new Map<string, Task>();
  const byCheckpoint = new Map<string, Task>();
  const byVoucher = new Map<string, Task>();
  for (const name of listing.get("manifests") ?? []) {
    if (!/^([1-9A-HJ-NP-Za-km-z]{32,44})\.json$/.test(name)) {
      conflicts.push(`manifests: unexpected record ${name}`);
      continue;
    }
    const pda = name.slice(0, -5);
    const { record, value } = inspect(
      familyPath("manifests"),
      name,
      "manifest",
      "record",
      "buyer_local",
      readManifest
    );
    if (!value) {
      unattached.push(record);
      conflicts.push(`manifest ${name} is corrupt`);
      continue;
    }
    const manifest = (value as StoredManifest).manifest;
    const key = hashCanonical({
      buyer: manifest.buyer,
      task_id: manifest.taskId,
    });
    const task = taskFor(tasks, key);
    if (task.evidence.manifest?.length)
      conflict(task, "duplicate canonical manifest for task identity");
    add(task, record);
    if (
      task.taskIdentity &&
      (task.taskIdentity.serviceId !== manifest.serviceId ||
        task.taskIdentity.privacy !== manifest.isPrivate)
    )
      conflict(task, "conflicting immutable manifest identity");
    task.taskIdentity = {
      buyer: manifest.buyer,
      taskId: manifest.taskId,
      serviceId: manifest.serviceId,
      privacy: manifest.isPrivate,
    };
    if (byPda.has(pda)) conflict(task, "duplicate canonical manifest");
    byPda.set(pda, task);
    byController.set(key, task);
    byCheckpoint.set(
      hashCanonical({ buyer: manifest.buyer, taskId: manifest.taskId }),
      task
    );
    if (options.sellerUrl)
      byVoucher.set(
        hashCanonical({
          seller: options.sellerUrl,
          buyer: manifest.buyer,
          taskId: manifest.taskId,
        }),
        task
      );
    if (!pubkey.safeParse(pda).success)
      conflict(task, "manifest filename is not a TaskState PDA");
  }

  const raw = new Map<string, unknown>();
  for (const name of listing.get("tasks") ?? []) {
    const match = taskName.exec(name);
    if (!match) {
      conflicts.push(`tasks: unexpected record ${name}`);
      continue;
    }
    const [, stem, role] = match;
    if (!stem || !role) continue;
    const parsed = inspect(
      familyPath("tasks"),
      name,
      "tasks",
      role,
      "buyer_local",
      (path) => {
        if (role === "identity") {
          const value = readFileSync(path, "utf8");
          return hash.parse(value);
        }
        if (role === "quote.json") return readQuote(path);
        const value = readJournal(path);
        if (role === "fund.intent") {
          const intent = object(value);
          strictKeys(intent, ["state"]);
          if (intent.state !== "UNKNOWN_FINANCIAL_OUTCOME")
            throw new Error("invalid funding intent");
          return intent;
        }
        if (role === "run.intent") {
          const intent = object(value);
          strictKeys(intent, ["state", "identity"]);
          if (
            intent.state !== "UNKNOWN_EXTERNAL_EFFECT" ||
            typeof intent.identity !== "string"
          )
            throw new Error("invalid execution intent");
          return intent;
        }
        return object(value);
      }
    );
    let task = byController.get(stem);
    if (!task && role === "quote.json" && parsed.value) {
      const quote = parsed.value as Record<string, unknown>;
      const linked = byPda.get(String(quote.task_state_pda));
      if (linked) {
        task = linked;
        if (stem !== task.taskKey)
          conflict(task, "duplicate or miskeyed canonical quote");
      }
    }
    if (
      !task &&
      role === "quote.json" &&
      parsed.value &&
      options.configuredBuyer
    ) {
      const quote = parsed.value as Record<string, unknown>;
      const expected = hashCanonical({
        buyer: options.configuredBuyer,
        task_id: String(quote.task_id),
      });
      task = taskFor(tasks, expected);
      byController.set(expected, task);
      task.taskIdentity ??= {
        buyer: options.configuredBuyer,
        taskId: String(quote.task_id),
        serviceId: String(quote.service_id),
        privacy: Boolean(quote.is_private),
      };
      byPda.set(String(quote.task_state_pda), task);
      byCheckpoint.set(
        hashCanonical({
          buyer: options.configuredBuyer,
          taskId: String(quote.task_id),
        }),
        task
      );
      if (options.sellerUrl)
        byVoucher.set(
          hashCanonical({
            seller: options.sellerUrl,
            buyer: options.configuredBuyer,
            taskId: String(quote.task_id),
          }),
          task
        );
      if (stem !== expected)
        conflict(task, "duplicate or miskeyed canonical quote");
    }
    task ??= taskFor(tasks, stem);
    byController.set(stem, task);
    if (
      role === "quote.json" &&
      task.evidence.tasks?.some((record) => record.role === role)
    )
      conflict(task, "duplicate canonical quote records");
    add(task, parsed.record);
    if (parsed.value !== null) raw.set(`${task.taskKey}:${role}`, parsed.value);
  }

  for (const task of tasks.values()) {
    const id = task.taskIdentity;
    if (!id) {
      conflict(task, "task identity cannot be established from local evidence");
      continue;
    }
    const stem = task.taskKey;
    const manifestRecord = task.evidence.manifest?.find(
      (r) => r.status === "VALID"
    );
    const manifest = manifestRecord ? readManifest(manifestRecord.path) : null;
    const quote = raw.get(`${stem}:quote.json`) as
      | Record<string, unknown>
      | undefined;
    const identity = raw.get(`${stem}:identity`);
    const run = raw.get(`${stem}:run.intent`) as
      | Record<string, unknown>
      | undefined;
    const outcome = raw.get(`${stem}:result.json`) as
      | Record<string, unknown>
      | undefined;
    const funded = raw.get(`${stem}:funded.json`) as
      | Record<string, unknown>
      | undefined;
    if (manifest && quote) {
      const m = manifest.manifest;
      if (
        quote.task_id?.toString() !== m.taskId ||
        quote.service_id !== m.serviceId ||
        quote.is_private !== m.isPrivate ||
        quote.task_state_pda !== basename(manifestRecord!.path, ".json") ||
        quote.policy_hash !== m.policyHash ||
        quote.seller_token_account !== m.sellerTokenAccount ||
        quote.verifier !== m.verifier ||
        quote.mint !== m.mint ||
        quote.timeout_seconds !== m.timeoutSeconds ||
        quote.amount?.toString() !== m.amountBaseUnits ||
        hashCanonical(quote) !== m.quoteHash
      )
        conflict(task, "quote and manifest immutable commitments conflict");
    }
    if (quote) {
      try {
        const [pda] = deriveTaskPda(
          new PublicKey(String(quote.program_id)),
          new PublicKey(id.buyer),
          BigInt(id.taskId)
        );
        const [vault] = deriveVaultPda(
          new PublicKey(String(quote.program_id)),
          pda
        );
        if (
          pda.toBase58() !== quote.task_state_pda ||
          vault.toBase58() !== quote.vault_pda
        )
          conflict(task, "quote PDA binding conflicts with task identity");
      } catch {
        conflict(task, "quote PDA binding is invalid");
      }
    }
    if (run && basename(String(run.identity)) !== `${stem}.identity`)
      conflict(task, "execution intent identity binding conflicts");
    if (funded && raw.get(`${stem}:fund.intent`) === undefined)
      conflict(task, "orphan funding completion without intent");
    if (outcome && raw.get(`${stem}:run.intent`) === undefined)
      conflict(task, "orphan task outcome without execution intent");
    const embedded = outcome?.result;
    if (embedded && typeof embedded === "object" && "version" in embedded) {
      try {
        const result = parseResultEnvelope(embedded);
        if (
          result.taskId !== id.taskId ||
          result.serviceId !== id.serviceId ||
          result.resultHash !== hashCanonical(result.result)
        )
          conflict(
            task,
            "task outcome result identity or commitment conflicts"
          );
      } catch {
        conflict(task, "task outcome contains malformed result");
      }
    }
    if (manifest && outcome?.report && typeof outcome.report === "object") {
      const report = outcome.report as VerificationReport;
      if (
        report.manifestHash !== manifest.manifestHash ||
        report.policyHash !== manifest.manifest.policyHash
      )
        conflict(task, "task outcome report commitment conflicts");
    }
    if (identity && typeof identity !== "string")
      conflict(task, "task identity hash is malformed");
    if (identity && manifest && outcome?.result) {
      const result = outcome.result as ResultEnvelopeV1;
      if (
        result.input &&
        identity !==
          hashCanonical({
            buyer: id.buyer,
            task_id: id.taskId,
            service_id: id.serviceId,
            is_private: id.privacy,
            input: result.input,
          })
      )
        conflict(task, "task identity hash conflicts with result input");
    }
  }

  // Remaining families are keyed by their existing immutable filenames. No
  // network query is made to fill missing evidence.
  for (const name of listing.get("checkpoints") ?? []) {
    const match = checkpointName.exec(name);
    if (!match) {
      conflicts.push(`checkpoints: unexpected record ${name}`);
      continue;
    }
    const stem = match[1]!,
      role = match[2]!;
    const parsed = inspect(
      familyPath("checkpoints"),
      name,
      role === "result" ? "result" : "verification",
      role,
      "buyer_local",
      role === "result" ? readResult : readReport
    );
    const task = byCheckpoint.get(stem);
    if (!task) {
      unattached.push(parsed.record);
      conflicts.push(`orphan checkpoint ${name}`);
      continue;
    }
    add(task, parsed.record);
    if (parsed.value === null || !task.taskIdentity) continue;
    const id = task.taskIdentity;
    if (role === "result") {
      const result = parsed.value as ResultEnvelopeV1;
      if (result.taskId !== id.taskId || result.serviceId !== id.serviceId)
        conflict(task, "result checkpoint identity conflicts");
      const manifest = task.evidence.manifest?.find(
        (r) => r.status === "VALID"
      );
      if (
        manifest &&
        readManifest(manifest.path).manifest.taskSpecHash !== result.output_hash
      )
        conflict(task, "result checkpoint input conflicts with manifest");
      raw.set(`${task.taskKey}:checkpoint-result`, result);
    } else raw.set(`${task.taskKey}:checkpoint-report`, parsed.value);
  }
  for (const task of tasks.values()) {
    const result = raw.get(`${task.taskKey}:checkpoint-result`) as
      | ResultEnvelopeV1
      | undefined;
    const report = raw.get(`${task.taskKey}:checkpoint-report`) as
      | VerificationReport
      | undefined;
    const outcome = raw.get(`${task.taskKey}:result.json`) as
      | Record<string, unknown>
      | undefined;
    const identity = raw.get(`${task.taskKey}:identity`);
    if (
      result &&
      task.taskIdentity &&
      typeof identity === "string" &&
      identity !==
        hashCanonical({
          buyer: task.taskIdentity.buyer,
          task_id: task.taskIdentity.taskId,
          service_id: task.taskIdentity.serviceId,
          is_private: task.taskIdentity.privacy,
          input: result.input,
        })
    )
      conflict(task, "task identity hash conflicts with result input");
    if (report && !result)
      conflict(task, "orphan verification report without raw result");
    if (
      report &&
      result &&
      (report.taskId !== result.taskId ||
        report.serviceId !== result.serviceId ||
        report.resultHash !== result.resultHash ||
        report.manifestHash !==
          (task.evidence.manifest?.find((r) => r.status === "VALID")
            ? readManifest(
                task.evidence.manifest!.find((r) => r.status === "VALID")!.path
              ).manifestHash
            : "") ||
        report.policyHash !==
          (task.evidence.manifest?.find((r) => r.status === "VALID")
            ? readManifest(
                task.evidence.manifest!.find((r) => r.status === "VALID")!.path
              ).manifest.policyHash
            : ""))
    )
      conflict(task, "verification report linkage conflicts");
    const quote = raw.get(`${task.taskKey}:quote.json`) as
      | Record<string, unknown>
      | undefined;
    if (
      report &&
      quote &&
      (report.verifierPubkey !== quote.verifier ||
        report.level !== (quote.verification_policy as { level: number }).level)
    )
      conflict(task, "verification report authority or level conflicts");
    if (result && !task.evidence.tasks?.some((r) => r.role === "run.intent"))
      conflict(task, "orphan result checkpoint without execution intent");
    if (
      outcome?.result &&
      result &&
      hashCanonical(outcome.result) !== hashCanonical(result)
    )
      conflict(task, "duplicate conflicting result copies");
  }

  for (const name of listing.get("transactions") ?? []) {
    const match = financialName.exec(name);
    if (!match) {
      conflicts.push(`transactions: unexpected record ${name}`);
      continue;
    }
    const stem = match[1]!,
      role = match[2]!;
    const parsed = inspect(
      familyPath("transactions"),
      name,
      "transactions",
      role,
      "buyer_local",
      (path) =>
        role === "intent"
          ? financialIntentSchema.parse(readJournal(path))
          : readJournal(path)
    );
    if (role === "intent" && parsed.value === null) {
      unattached.push(parsed.record);
      conflicts.push(`financial intent ${name} is corrupt`);
      continue;
    }
    if (role === "intent" && parsed.value !== null)
      raw.set(`financial:${stem}:${role}`, parsed.value);
    const intent = raw.get(`financial:${stem}:intent`);
    if (role === "intent" && intent) {
      const obj = financialIntentSchema.parse(intent),
        operation = obj.operation;
      const kind = String(operation.kind);
      const expected = hashCanonical({
        programId: operation.programId ?? "test",
        taskState: operation.taskState,
        kind,
      });
      const task = byPda.get(operation.taskState);
      if (!task) {
        unattached.push(parsed.record);
        conflicts.push(`orphan financial intent ${name}`);
        continue;
      }
      add(task, parsed.record);
      if (expected !== stem)
        conflict(
          task,
          "financial intent format or immutable binding conflicts"
        );
      if (
        task.taskIdentity &&
        task.evidence.manifest?.some((r) => r.status === "VALID")
      ) {
        const quote = raw.get(`${task.taskKey}:quote.json`) as
          | Record<string, unknown>
          | undefined;
        if (quote && operation.programId !== quote.program_id)
          conflict(task, "financial program binding conflicts with quote");
      }
    }
  }
  for (const name of [...(listing.get("transactions") ?? [])].sort(
    (a, b) =>
      Number(a.endsWith("confirmed.json")) -
      Number(b.endsWith("confirmed.json"))
  )) {
    const match = financialName.exec(name);
    if (!match || match[2] === "intent") continue;
    const stem = match[1]!,
      role = match[2]!;
    const intent = raw.get(`financial:${stem}:intent`);
    const parsed = inspect(
      familyPath("transactions"),
      name,
      "transactions",
      role,
      "buyer_local",
      (path) =>
        role === "transaction.json"
          ? preparedSchema.parse(readJournal(path))
          : confirmationSchema.parse(readJournal(path))
    );
    const operation = intent
      ? financialIntentSchema.parse(intent).operation
      : null;
    const task = operation ? byPda.get(String(operation.taskState)) : null;
    if (!task) {
      unattached.push(parsed.record);
      conflicts.push(`orphan financial ${role} ${name}`);
      continue;
    }
    add(task, parsed.record);
    if (!intent) {
      conflict(task, `orphan financial ${role} without intent`);
      continue;
    }
    if (parsed.value === null) continue;
    raw.set(`financial:${stem}:${role}`, parsed.value);
    const value = object(parsed.value);
    if (role === "transaction.json") {
      if (operation?.binding && value.fingerprint !== operation.binding)
        conflict(
          task,
          "prepared financial transaction is invalid or conflicts with intent"
        );
    } else {
      const prepared = raw.get(`financial:${stem}:transaction.json`) as
        | Record<string, unknown>
        | undefined;
      if (!prepared)
        conflict(
          task,
          "orphan financial completion without prepared transaction"
        );
      else if (prepared.signature !== value.signature)
        conflict(
          task,
          "financial completion signature conflicts with prepared transaction"
        );
    }
  }

  for (const name of listing.get("seller-executions") ?? []) {
    const match = sellerName.exec(name);
    if (!match) {
      conflicts.push(`seller-executions: unexpected record ${name}`);
      continue;
    }
    const pda = match[1]!,
      role = match[2]!;
    const parsed = inspect(
      familyPath("seller-executions"),
      name,
      "execution",
      role,
      "seller_local",
      (path) => {
        const value = object(JSON.parse(readFileSync(path, "utf8")));
        if (role === "intent") {
          strictKeys(value, ["version", "input_hash", "service_id", "state"]);
          if (
            value.version !== 1 ||
            !hash.safeParse(value.input_hash).success ||
            typeof value.service_id !== "string" ||
            value.state !== "UNKNOWN_EXTERNAL_EFFECT"
          )
            throw new Error("invalid seller intent");
        } else {
          strictKeys(value, ["version", "checksum", "result"]);
          if (
            value.version !== 1 ||
            value.checksum !== hashCanonical(value.result)
          )
            throw new Error("invalid seller result envelope");
          const result = object(value.result);
          if (
            result.version !== "1" ||
            result.output_hash !== hashCanonical(result.input) ||
            result.result_hash !== hashCanonical(result.result)
          )
            throw new Error("invalid seller result commitment");
        }
        return value;
      }
    );
    const task = byPda.get(pda);
    if (!task) {
      unattached.push(parsed.record);
      conflicts.push(`orphan seller execution ${name}`);
      continue;
    }
    add(task, parsed.record);
    if (parsed.value === null) continue;
    const value = parsed.value as Record<string, unknown>;
    if (role === "intent") {
      const id = task.taskIdentity;
      const manifest = task.evidence.manifest?.find(
        (r) => r.status === "VALID"
      );
      if (
        id &&
        (value.service_id !== id.serviceId ||
          (manifest &&
            value.input_hash !==
              readManifest(manifest.path).manifest.taskSpecHash))
      )
        conflict(task, "seller execution intent binding conflicts");
    } else {
      const result = object(value.result);
      if (
        result.task_id !== task.taskIdentity?.taskId ||
        result.service_id !== task.taskIdentity?.serviceId
      )
        conflict(task, "seller result identity conflicts");
      const manifest = task.evidence.manifest?.find(
        (r) => r.status === "VALID"
      );
      if (
        manifest &&
        result.output_hash !== readManifest(manifest.path).manifest.taskSpecHash
      )
        conflict(
          task,
          "seller result input commitment conflicts with manifest"
        );
      const checkpoint = raw.get(`${task.taskKey}:checkpoint-result`) as
        | ResultEnvelopeV1
        | undefined;
      if (
        checkpoint &&
        (result.result_hash !== checkpoint.resultHash ||
          result.output_hash !== checkpoint.output_hash)
      )
        conflict(task, "seller and buyer result copies conflict");
      if (!(listing.get("seller-executions") ?? []).includes(`${pda}.intent`))
        conflict(task, "orphan seller result without execution intent");
    }
  }

  const issuance = new Map<string, Record<string, unknown>>();
  for (const name of listing.get("mint-issuance") ?? []) {
    const match = /^([1-9A-HJ-NP-Za-km-z]{32,44})\.(intent|receipt)$/.exec(
      name
    );
    if (!match) {
      conflicts.push(`mint-issuance: unexpected record ${name}`);
      continue;
    }
    const pda = match[1]!,
      role = match[2]!;
    const parsed = inspect(
      familyPath("mint-issuance"),
      name,
      "voucherIssuance",
      `seller-${role}`,
      "seller_local",
      (path) => {
        const envelope = object(JSON.parse(readFileSync(path, "utf8")));
        strictKeys(envelope, ["version", "checksum", "value"]);
        if (
          envelope.version !== 1 ||
          envelope.checksum !== hashCanonical(envelope.value)
        )
          throw new Error("invalid issuance envelope");
        const value = object(envelope.value);
        strictKeys(
          value,
          role === "intent"
            ? ["version", "buyer", "task_id", "blinded_point", "mint_pubkey"]
            : [
                "version",
                "buyer",
                "task_id",
                "blinded_point",
                "mint_pubkey",
                "blind_signature",
              ]
        );
        if (
          value.version !== 1 ||
          !pubkey.safeParse(value.buyer).success ||
          typeof value.task_id !== "number" ||
          !Number.isSafeInteger(value.task_id) ||
          value.task_id < 0 ||
          !hash.safeParse(value.blinded_point).success ||
          !hash.safeParse(value.mint_pubkey).success ||
          (role === "receipt" && !hash.safeParse(value.blind_signature).success)
        )
          throw new Error("invalid issuance payload");
        return value;
      }
    );
    const task = byPda.get(pda);
    if (!task) {
      unattached.push(parsed.record);
      conflicts.push(`orphan mint issuance ${name}`);
      continue;
    }
    add(task, parsed.record);
    if (!parsed.value) continue;
    const value = parsed.value as Record<string, unknown>;
    if (
      value.buyer !== task.taskIdentity?.buyer ||
      String(value.task_id) !== task.taskIdentity?.taskId
    )
      conflict(task, "mint issuance task binding conflicts");
    if (!task.taskIdentity?.privacy)
      conflict(task, "mint issuance attached to public task");
    if (role === "intent") issuance.set(pda, value);
    else {
      const intent = issuance.get(pda);
      if (
        !intent ||
        ["buyer", "task_id", "blinded_point", "mint_pubkey"].some(
          (field) => intent[field] !== value[field]
        )
      )
        conflict(task, "orphan or conflicting mint issuance receipt");
    }
  }

  for (const name of listing.get("vouchers") ?? []) {
    const match = voucherName.exec(name);
    if (!match) {
      conflicts.push(`vouchers: unexpected record ${name}`);
      continue;
    }
    const stem = match[1]!,
      role = match[2]!;
    const parsed = inspect(
      familyPath("vouchers"),
      name,
      "voucherIssuance",
      role,
      "buyer_local",
      (path) => {
        const value = object(readJournal(path));
        if (role === "intent") {
          strictKeys(value, [
            "nullifierScalar",
            "blindingScalar",
            "blindedPointHex",
          ]);
          if (
            !decimal.safeParse(value.nullifierScalar).success ||
            !decimal.safeParse(value.blindingScalar).success ||
            !/^[0-9a-f]{64}$/.test(String(value.blindedPointHex))
          )
            throw new Error("invalid voucher intent");
        } else {
          strictKeys(value, ["blind_signature", "mint_pubkey"]);
          if (
            !/^[0-9a-f]{64}$/.test(String(value.blind_signature)) ||
            !/^[0-9a-f]{64}$/.test(String(value.mint_pubkey))
          )
            throw new Error("invalid voucher response");
        }
        return value;
      }
    );
    const task = byVoucher.get(stem);
    if (!task) {
      unattached.push(parsed.record);
      conflicts.push(`unattributed voucher ${name}`);
      continue;
    }
    add(task, parsed.record);
    if (parsed.value === null) continue;
    if (
      role === "voucher.json" &&
      !(listing.get("vouchers") ?? []).includes(`${stem}.intent`)
    )
      conflict(task, "orphan voucher response without intent");
  }

  for (const name of listing.get("challenges") ?? []) {
    if (!/^([0-9a-f]{64})\.seed$/.test(name)) {
      conflicts.push(`challenges: unexpected record ${name}`);
      continue;
    }
    const parsed = inspect(
      familyPath("challenges"),
      name,
      "challenge",
      "seed",
      "buyer_local",
      (path) => hash.parse(readFileSync(path, "utf8"))
    );
    let task: Task | undefined;
    for (const candidate of tasks.values()) {
      const manifestRecord = candidate.evidence.manifest?.find(
        (r) => r.status === "VALID"
      );
      const result = raw.get(`${candidate.taskKey}:checkpoint-result`) as
        | ResultEnvelopeV1
        | undefined;
      const quote = raw.get(`${candidate.taskKey}:quote.json`) as
        | Record<string, unknown>
        | undefined;
      if (!manifestRecord || !result || !quote) continue;
      const manifest = readManifest(manifestRecord.path);
      const policy = parseVerificationPolicy(quote.verification_policy);
      for (const [checkIndex, check] of policy.checks.entries()) {
        if (check.type !== "source_sampling") continue;
        const immutableContext = hashCanonical({
          manifestHash: manifest.manifestHash,
          policyHash: manifest.manifest.policyHash,
          resultHash: result.resultHash,
          checkIndex,
        });
        if (
          `${hashCanonical({ immutableContext, policy: check })}.seed` === name
        )
          task = candidate;
      }
    }
    if (!task) {
      unattached.push(parsed.record);
      conflicts.push(`unattributed challenge ${name}`);
    } else add(task, parsed.record);
  }
  for (const name of listing.get("sandbox-leases") ?? []) {
    if (!name.endsWith(".lease")) {
      conflicts.push(`sandbox-leases: unexpected record ${name}`);
      continue;
    }
    const parsed = inspect(
      familyPath("sandbox-leases"),
      name,
      "sandboxLease",
      "lease",
      "buyer_local",
      (path) => {
        const lease = object(readJournal(path));
        strictKeys(lease, ["pid", "container", "directory"]);
        if (
          !Number.isSafeInteger(lease.pid) ||
          Number(lease.pid) <= 0 ||
          typeof lease.directory !== "string" ||
          typeof lease.container !== "string" ||
          !/^setra402-verify-[0-9a-f-]{36}-[0-9a-f-]{36}$/.test(
            lease.container
          ) ||
          `${lease.container}.lease` !== name
        )
          throw new Error("invalid sandbox lease");
        return lease;
      }
    );
    unattached.push(parsed.record);
    if (parsed.record.status === "CORRUPT")
      conflicts.push(`sandbox lease ${name} is corrupt`);
    // Phase 3.5 leases do not contain task identity. Never guess an association.
  }

  for (const task of tasks.values()) {
    if (
      task.conflicts.length ||
      Object.values(task.evidence)
        .flat()
        .some((r) => r.status === "CORRUPT")
    ) {
      task.classifications = ["RECONCILIATION_REQUIRED"];
      task.recommendedAction = "OPERATOR_REVIEW_REQUIRED";
      continue;
    }
    const financial =
      task.evidence.transactions?.length ||
      task.evidence.tasks?.some(
        (r) => r.role === "fund.intent" || r.role === "funded.json"
      ) ||
      ["settled", "refunded"].includes(
        (
          raw.get(`${task.taskKey}:result.json`) as
            | { status?: string }
            | undefined
        )?.status ?? ""
      );
    const executionUnknown =
      (task.evidence.tasks?.some((r) => r.role === "run.intent") &&
        !task.evidence.result?.some((r) => r.status === "VALID")) ||
      (task.evidence.voucherIssuance?.some((r) => r.role === "intent") &&
        !task.evidence.voucherIssuance?.some(
          (r) => r.role === "voucher.json"
        )) ||
      (task.evidence.voucherIssuance?.some((r) => r.role === "seller-intent") &&
        !task.evidence.voucherIssuance?.some(
          (r) => r.role === "seller-receipt"
        ));
    task.classifications = [
      ...(financial ? ["UNKNOWN_FINANCIAL_OUTCOME" as const] : []),
      ...(executionUnknown ? ["UNKNOWN_EXTERNAL_EFFECT" as const] : []),
    ];
    if (executionUnknown || financial)
      task.recommendedAction = "READ_ONLY_RECONCILIATION";
    else if (task.evidence.result?.some((r) => r.status === "VALID"))
      task.recommendedAction = "SAFE_TO_REVERIFY";
    else task.recommendedAction = "NO_ACTION";
  }
  return recoveryInventoryV1Schema.parse({
    version: "1",
    families,
    authoritativeExternalEvidence: "NOT_QUERIED",
    recommendedAction:
      conflicts.length ||
      [...tasks.values()].some(
        (task) => task.recommendedAction === "OPERATOR_REVIEW_REQUIRED"
      )
        ? "OPERATOR_REVIEW_REQUIRED"
        : unattached.some((record) => record.family === "sandboxLease") ||
          [...tasks.values()].some(
            (task) => task.recommendedAction === "READ_ONLY_RECONCILIATION"
          )
        ? "READ_ONLY_RECONCILIATION"
        : "NO_ACTION",
    tasks: [...tasks.values()].sort((a, b) =>
      a.taskKey.localeCompare(b.taskKey)
    ),
    unattached,
    conflicts,
    staleTemporaryFiles,
  });
}
