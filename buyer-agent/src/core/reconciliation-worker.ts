import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { hashCanonical } from "../manifest/hash.js";
import type { FinancialReconciliationResult } from "../chain/financial-reconciliation.js";
import type { ProviderEvidenceAssessment } from "../provider/evidence.js";
import type { VoucherRecoveryView } from "../privacy/voucher-recovery.js";
import type { VerificationRecoveryV1 } from "../verification/recovery.js";
import type { VerificationReport } from "../types.js";
import {
  scanRecoveryInventory,
  type RecoveryInventoryOptions,
  type RecoveryInventoryV1,
} from "./recovery-inventory.js";
import {
  ReconciliationClaims,
  type ClaimResult,
} from "./reconciliation-claims.js";
import {
  ReconciliationRecords,
  reconciliationRecordV1Schema,
  type ReconciliationFindingV1,
  type ReconciliationRecordV1,
} from "./reconciliation-records.js";

type Task = RecoveryInventoryV1["tasks"][number];
export interface ReconciliationSources {
  financial?(task: Task): Promise<FinancialReconciliationResult[]>;
  provider?(task: Task): Promise<ProviderEvidenceAssessment>;
  voucher?(task: Task): Promise<VoucherRecoveryView>;
  verification(task: Task): Promise<VerificationRecoveryV1>;
  /** This implementation must load the immutable saved result through RunCheckpoints and save via RunCheckpoints. */
  reverify?(task: Task): Promise<VerificationReport>;
}
export interface ReconciliationWorkerOptions {
  stateDirectory: string;
  inventory: RecoveryInventoryOptions;
  sources: ReconciliationSources;
  claims?: ReconciliationClaims;
  records?: ReconciliationRecords;
  maxReadAttempts?: number;
  backoffMs?: number;
  now?: () => number;
  /** Test-only crash boundary. */
  fault?: (stage: string) => void;
}
export type WorkerRunResult =
  | { status: "COMPLETED" | "UNCHANGED"; record: ReconciliationRecordV1 }
  | { status: "BUSY" | "OPERATOR_REVIEW_REQUIRED"; reason: string };

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function revision(inventory: RecoveryInventoryV1, task: Task): string {
  const digests = Object.values(task.evidence)
    .flat()
    .map((record) => {
      const stat = statSync(record.path);
      if (!stat.isFile() || stat.size > 16_777_216)
        throw new Error("recovery evidence file unavailable or oversized");
      return {
        family: record.family,
        role: record.role,
        path: record.path,
        sha256: createHash("sha256")
          .update(readFileSync(record.path))
          .digest("hex"),
      };
    });
  return hashCanonical({
    version: "1",
    families: inventory.families,
    task,
    conflicts: inventory.conflicts,
    staleTemporaryFiles: inventory.staleTemporaryFiles,
    digests,
  });
}
function finding(
  source: ReconciliationFindingV1["source"],
  authority: ReconciliationFindingV1["authority"],
  status: ReconciliationFindingV1["status"],
  classification: ReconciliationFindingV1["classification"],
  reason: string,
  evidence: unknown = null
): ReconciliationFindingV1 {
  return {
    source,
    authority,
    status,
    classification,
    evidenceHash: evidence === null ? null : hashCanonical(evidence),
    reason: reason.slice(0, 512),
  };
}

/** Explicit/periodic read-only evidence worker. It has no provider or financial mutation dependency. */
export class ReconciliationWorker {
  readonly claims: ReconciliationClaims;
  readonly records: ReconciliationRecords;
  private readonly maxReadAttempts: number;
  private readonly backoffMs: number;
  constructor(private readonly options: ReconciliationWorkerOptions) {
    this.claims =
      options.claims ?? new ReconciliationClaims(options.stateDirectory);
    this.records =
      options.records ?? new ReconciliationRecords(options.stateDirectory);
    this.maxReadAttempts = options.maxReadAttempts ?? 2;
    this.backoffMs = options.backoffMs ?? 50;
    if (
      !Number.isSafeInteger(this.maxReadAttempts) ||
      this.maxReadAttempts < 1 ||
      this.maxReadAttempts > 3 ||
      !Number.isSafeInteger(this.backoffMs) ||
      this.backoffMs < 0 ||
      this.backoffMs > 2_000
    )
      throw new Error("invalid read-only retry budget");
    if (options.fault && process.env.NODE_ENV !== "test")
      throw new Error("worker failpoints are test-only");
  }
  private point(stage: string) {
    this.options.fault?.(stage);
  }
  private async read<T>(
    source: string,
    action: () => Promise<T>
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
    let last = "unavailable";
    for (let attempt = 1; attempt <= this.maxReadAttempts; attempt++) {
      try {
        return { ok: true, value: await action() };
      } catch (error) {
        last = error instanceof Error ? error.name : "UnknownError";
        if (attempt < this.maxReadAttempts)
          await sleep(this.backoffMs * attempt);
      }
    }
    return {
      ok: false,
      reason: `${source} unavailable after ${this.maxReadAttempts} read-only attempts (${last})`,
    };
  }
  async runTask(taskKey: string): Promise<WorkerRunResult> {
    this.point("before_claim");
    const acquired: ClaimResult = this.claims.acquire(taskKey);
    if (acquired.status !== "ACQUIRED") return acquired;
    const claim = acquired.claim;
    const startedAt = this.options.now?.() ?? Date.now();
    try {
      this.point("after_claim");
      const inventory = scanRecoveryInventory(this.options.inventory);
      const task = inventory.tasks.find(
        (candidate) => candidate.taskKey === taskKey
      );
      if (!task)
        throw new Error(
          "claimed task missing from inventory; no absence inference"
        );
      const inventoryRevision = revision(inventory, task);
      this.point("after_inventory");
      const findings: ReconciliationFindingV1[] = [
        finding(
          "INVENTORY",
          "LOCAL",
          task.conflicts.length || inventory.conflicts.length
            ? "CONFLICT"
            : "OBSERVED",
          task.conflicts.length || inventory.conflicts.length
            ? "RECONCILIATION_REQUIRED"
            : null,
          task.conflicts.length || inventory.conflicts.length
            ? "inventory contains conflicts"
            : "versioned local inventory validated",
          { task, conflicts: inventory.conflicts }
        ),
      ];
      let financial: FinancialReconciliationResult[] | null = null;
      let provider: ProviderEvidenceAssessment | null = null;
      let voucher: VoucherRecoveryView | null = null;
      let verification: VerificationRecoveryV1 | null = null;
      let failedRead = false;
      if (
        this.options.sources.financial &&
        task.evidence.transactions?.some((r) => r.role === "intent")
      ) {
        const r = await this.read("financial", () =>
          this.options.sources.financial!(task)
        );
        if (r.ok) {
          financial = r.value;
          for (const item of financial)
            findings.push(
              finding(
                "FINANCIAL",
                "CHAIN",
                "OBSERVED",
                item.classification,
                item.reason,
                {
                  kind: item.kind,
                  classification: item.classification,
                  chainOutcome: item.chainOutcome,
                  receipt: item.receipt,
                  preparedSignature: item.preparedSignature,
                }
              )
            );
        } else {
          failedRead = true;
          findings.push(
            finding(
              "FINANCIAL",
              "CHAIN",
              "UNAVAILABLE",
              "UNKNOWN_FINANCIAL_OUTCOME",
              r.reason
            )
          );
        }
      }
      this.point("after_chain_query");
      if (
        this.options.sources.provider &&
        task.evidence.tasks?.some((r) => r.role === "run.intent")
      ) {
        const r = await this.read("provider", () =>
          this.options.sources.provider!(task)
        );
        if (r.ok) {
          provider = r.value;
          findings.push(
            finding(
              "PROVIDER",
              "SELLER",
              "OBSERVED",
              provider.status === "UNKNOWN_EXTERNAL_EFFECT"
                ? "UNKNOWN_EXTERNAL_EFFECT"
                : null,
              provider.status,
              {
                recordState: provider.evidence.record_state,
                inputHash: provider.evidence.input_hash,
                resultHash: provider.evidence.result_hash,
              }
            )
          );
        } else {
          failedRead = true;
          findings.push(
            finding(
              "PROVIDER",
              "SELLER",
              "UNAVAILABLE",
              "UNKNOWN_EXTERNAL_EFFECT",
              r.reason
            )
          );
        }
      }
      this.point("after_provider_query");
      if (
        this.options.sources.voucher &&
        task.taskIdentity?.privacy &&
        task.evidence.voucherIssuance?.length
      ) {
        const r = await this.read("voucher", () =>
          this.options.sources.voucher!(task)
        );
        if (r.ok) {
          voucher = r.value;
          findings.push(
            finding(
              "VOUCHER",
              "SELLER",
              "OBSERVED",
              voucher.classification,
              `${voucher.sellerEvidence}; mint identity ${voucher.mintIdentity}`,
              {
                classification: voucher.classification,
                localIntent: voucher.localIntent,
                localResponse: voucher.localResponse,
                sellerEvidence: voucher.sellerEvidence,
                mintIdentity: voucher.mintIdentity,
              }
            )
          );
        } else {
          failedRead = true;
          findings.push(
            finding(
              "VOUCHER",
              "SELLER",
              "UNAVAILABLE",
              "UNKNOWN_EXTERNAL_EFFECT",
              r.reason
            )
          );
        }
      }
      const v = await this.read("verification", () =>
        this.options.sources.verification(task)
      );
      if (v.ok) {
        verification = v.value;
        findings.push(
          finding(
            "VERIFICATION",
            "DERIVED",
            "OBSERVED",
            verification.classification,
            `${verification.recommendedAction}; ${
              verification.reasons.join("; ") || "no conflicts"
            }`,
            {
              evidence: verification.evidence,
              sandboxLeases: verification.sandboxLeases,
              reportVerdict: verification.reportVerdict,
            }
          )
        );
      } else {
        failedRead = true;
        findings.push(
          finding(
            "VERIFICATION",
            "DERIVED",
            "UNAVAILABLE",
            "RECONCILIATION_REQUIRED",
            v.reason
          )
        );
      }
      this.point("after_verification_query");
      const unresolved =
        findings.some(
          (item) =>
            item.classification === "UNKNOWN_EXTERNAL_EFFECT" ||
            item.classification === "UNKNOWN_FINANCIAL_OUTCOME" ||
            item.classification === "RECONCILIATION_REQUIRED"
        ) ||
        task.classifications.includes("RECONCILIATION_REQUIRED") ||
        (task.classifications.includes("UNKNOWN_EXTERNAL_EFFECT") &&
          provider?.status !== "RESULT_PERSISTED_UNVERIFIED") ||
        (task.classifications.includes("UNKNOWN_FINANCIAL_OUTCOME") &&
          (!financial?.length ||
            financial.some(
              (item) => item.classification === "UNKNOWN_FINANCIAL_OUTCOME"
            )));
      const immutableResultReady =
        verification?.evidence.manifest === "VALID" &&
        verification.evidence.quote === "VALID" &&
        verification.evidence.result === "VALID" &&
        verification.evidence.report === "ABSENT" &&
        (verification.evidence.sourceChallenge === "NOT_REQUIRED" ||
          verification.evidence.sourceChallenge === "VALID") &&
        verification.sandboxLeases.length === 0 &&
        verification.reasons.length === 0 &&
        task.evidence.result?.some((item) => item.status === "VALID") ===
          true &&
        !task.evidence.verification?.length;
      if (
        immutableResultReady &&
        verification?.classification === "SAFE_TO_REVERIFY" &&
        verification.taskKey === taskKey &&
        this.options.sources.reverify &&
        !failedRead &&
        !unresolved &&
        !inventory.conflicts.length &&
        !task.conflicts.length
      ) {
        const fresh = await this.read("verification", () =>
          this.options.sources.verification(task)
        );
        if (fresh.ok && fresh.value.classification === "SAFE_TO_REVERIFY") {
          // Verification may execute an isolated artifact and publish a report;
          // it is deliberately invoked once, never through the read retry loop.
          let rechecked:
            | { ok: true; value: VerificationReport }
            | { ok: false; reason: string };
          try {
            rechecked = {
              ok: true,
              value: await this.options.sources.reverify(task),
            };
          } catch (error) {
            rechecked = {
              ok: false,
              reason: `reverification failed (${
                error instanceof Error ? error.name : "UnknownError"
              })`,
            };
          }
          if (rechecked.ok)
            findings.push(
              finding(
                "REVERIFICATION",
                "DERIVED",
                "OBSERVED",
                "PROVEN_OCCURRED",
                rechecked.value.passed
                  ? "linked report saved: PASS recorded"
                  : "linked report saved: FAIL recorded",
                {
                  taskId: rechecked.value.taskId,
                  resultHash: rechecked.value.resultHash,
                  reportPassed: rechecked.value.passed,
                }
              )
            );
          else {
            failedRead = true;
            findings.push(
              finding(
                "REVERIFICATION",
                "DERIVED",
                "UNAVAILABLE",
                "RECONCILIATION_REQUIRED",
                rechecked.reason
              )
            );
          }
        } else {
          failedRead = true;
          findings.push(
            finding(
              "VERIFICATION",
              "DERIVED",
              "CONFLICT",
              "RECONCILIATION_REQUIRED",
              "safe reverification eligibility changed"
            )
          );
        }
      }
      const classifications = new Set<string>(task.classifications);
      if (financial?.length) {
        if (
          financial.every(
            (item) =>
              item.classification !== "UNKNOWN_FINANCIAL_OUTCOME" &&
              item.classification !== "RECONCILIATION_REQUIRED"
          )
        )
          classifications.delete("UNKNOWN_FINANCIAL_OUTCOME");
        for (const item of financial) classifications.add(item.classification);
      }
      if (
        provider?.status === "UNKNOWN_EXTERNAL_EFFECT" ||
        findings.some(
          (item) => item.source === "PROVIDER" && item.status === "UNAVAILABLE"
        )
      )
        classifications.add("UNKNOWN_EXTERNAL_EFFECT");
      if (
        provider?.status === "RESULT_PERSISTED_UNVERIFIED" &&
        voucher?.classification !== "UNKNOWN_EXTERNAL_EFFECT" &&
        !findings.some(
          (item) => item.source === "PROVIDER" && item.status === "UNAVAILABLE"
        )
      )
        classifications.delete("UNKNOWN_EXTERNAL_EFFECT");
      if (
        voucher?.classification === "PROVEN_OCCURRED" &&
        !task.evidence.tasks?.some((item) => item.role === "run.intent") &&
        !findings.some(
          (item) => item.source === "VOUCHER" && item.status === "UNAVAILABLE"
        )
      )
        classifications.delete("UNKNOWN_EXTERNAL_EFFECT");
      if (voucher?.classification === "RECONCILIATION_REQUIRED")
        classifications.add("RECONCILIATION_REQUIRED");
      if (voucher?.classification === "UNKNOWN_EXTERNAL_EFFECT")
        classifications.add("UNKNOWN_EXTERNAL_EFFECT");
      if (
        verification?.classification === "RECONCILIATION_REQUIRED" ||
        findings.some((item) => item.status === "CONFLICT")
      )
        classifications.add("RECONCILIATION_REQUIRED");
      if (
        verification?.classification === "SAFE_TO_REVERIFY" &&
        !findings.some(
          (item) =>
            item.source === "REVERIFICATION" && item.status === "OBSERVED"
        )
      )
        classifications.add("SAFE_TO_REVERIFY");
      if (
        findings.some(
          (item) =>
            item.source === "REVERIFICATION" && item.status === "OBSERVED"
        )
      )
        classifications.delete("SAFE_TO_REVERIFY");
      if (failedRead) {
        if (
          findings.some(
            (item) =>
              item.source === "FINANCIAL" && item.status === "UNAVAILABLE"
          )
        )
          classifications.add("UNKNOWN_FINANCIAL_OUTCOME");
        if (
          findings.some(
            (item) =>
              item.source === "PROVIDER" && item.status === "UNAVAILABLE"
          )
        )
          classifications.add("UNKNOWN_EXTERNAL_EFFECT");
        if (
          findings.some(
            (item) =>
              item.source === "VERIFICATION" && item.status === "UNAVAILABLE"
          )
        )
          classifications.add("RECONCILIATION_REQUIRED");
      }
      const labels = [...classifications].sort();
      const recommendedAction = labels.includes("RECONCILIATION_REQUIRED")
        ? "OPERATOR_REVIEW_REQUIRED"
        : labels.includes("UNKNOWN_EXTERNAL_EFFECT") ||
          labels.includes("UNKNOWN_FINANCIAL_OUTCOME")
        ? "WAIT_FOR_EVIDENCE"
        : labels.includes("SAFE_TO_REVERIFY")
        ? "SAFE_TO_REVERIFY"
        : labels.includes("SAFE_TO_RETRY")
        ? "SAFE_TO_RETRY"
        : "NO_ACTION";
      const evidenceProvenance = findings.map((item) => ({
        source: item.source,
        authority: item.authority,
        evidenceHash: item.evidenceHash,
      }));
      const evidenceRevision = hashCanonical({
        inventoryRevision,
        findings,
        classifications: labels,
        recommendedAction,
        evidenceProvenance,
      });
      const previous = this.records.latest(taskKey);
      if (previous?.evidenceRevision === evidenceRevision)
        return { status: "UNCHANGED", record: previous };
      const record = reconciliationRecordV1Schema.parse({
        version: "1",
        taskKey,
        correlationId: hashCanonical({ version: "1", taskKey }),
        attempt: (previous?.attempt ?? 0) + 1,
        startedAtUnixMs: startedAt,
        completedAtUnixMs: Math.max(
          startedAt,
          this.options.now?.() ?? Date.now()
        ),
        inventoryRevision,
        evidenceRevision,
        previousRecordHash: previous ? hashCanonical(previous) : null,
        findings,
        classifications: labels,
        recommendedAction,
        evidenceProvenance,
      });
      this.point("before_record_publish");
      this.records.publish(record);
      this.point("after_record_publish");
      return { status: "COMPLETED", record };
    } finally {
      this.point("before_claim_release");
      this.claims.release(claim);
    }
  }
  async runPending(limit = 100): Promise<WorkerRunResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
      throw new Error("invalid reconciliation batch limit");
    const inventory = scanRecoveryInventory(this.options.inventory);
    const pending = inventory.tasks
      .filter((task) => task.recommendedAction !== "NO_ACTION")
      .slice(0, limit);
    const results: WorkerRunResult[] = [];
    for (const task of pending) results.push(await this.runTask(task.taskKey));
    return results;
  }
}
