import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import type {
  FinancialRecoveryRequest,
  FinancialReconciliationResult,
} from "../chain/financial-reconciliation.js";
import { hashCanonical } from "../manifest/hash.js";
import { ManifestStore, type StoredManifest } from "../manifest/store.js";
import { validateQuote } from "../quote.js";
import type {
  LegacyTaskQuoteWire,
  TaskQuote,
  TaskStateView,
} from "../types.js";
import { DurableJournal } from "./journal.js";
import {
  ReconciliationClaims,
  type ClaimResult,
} from "./reconciliation-claims.js";
import {
  scanRecoveryInventory,
  type RecoveryInventoryV1,
} from "./recovery-inventory.js";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const financialKind = z.enum(["funding", "settlement", "cancel", "refund"]);
const operationSchema = z
  .object({
    programId: z.string(),
    taskState: z.string(),
    kind: financialKind,
    binding: hash,
  })
  .strict();
export const refundSchedulerRecordV1Schema = z
  .object({
    version: z.literal("1"),
    taskKey: hash,
    correlationId: hash,
    claimId: z.string().uuid(),
    operation: z.literal("refund"),
    outcome: z.enum([
      "BLOCKED",
      "ELIGIBLE",
      "SUBMITTED",
      "CONFIRMED",
      "AMBIGUOUS",
    ]),
    classification: z.enum([
      "PROVEN_OCCURRED",
      "PROVEN_NOT_OCCURRED",
      "SAFE_TO_RETRY",
      "UNKNOWN_FINANCIAL_OUTCOME",
      "RECONCILIATION_REQUIRED",
    ]),
    reason: z.string().min(1).max(256),
    signature: z.string().nullable(),
    startedAtUnixMs: z.number().int().safe().nonnegative(),
    completedAtUnixMs: z.number().int().safe().nonnegative(),
  })
  .strict();
export type RefundSchedulerRecordV1 = z.infer<
  typeof refundSchedulerRecordV1Schema
>;
type Task = RecoveryInventoryV1["tasks"][number];

export interface RefundChainReader {
  refundOperation(
    quote: TaskQuote
  ): Promise<FinancialRecoveryRequest["operation"]>;
  refundState(
    quote: TaskQuote
  ): Promise<{ state: TaskStateView | null; slot: number; clockUnix: number }>;
  reconcileFinancial(
    request: FinancialRecoveryRequest
  ): Promise<FinancialReconciliationResult>;
}
export interface RefundSubmitter {
  refundExpired(quote: TaskQuote): Promise<string>;
  retryRefundExpired?(
    request: FinancialRecoveryRequest,
    proveSafe: (signature: string) => Promise<boolean>
  ): Promise<string>;
}
export interface RefundSchedulerOptions {
  stateDirectory: string;
  sellerUrl: string;
  programId: PublicKey;
  expectedMint: PublicKey;
  buyer: PublicKey;
  verifier: PublicKey;
  reader: RefundChainReader;
  submitter: RefundSubmitter;
  claims?: ReconciliationClaims;
  observe?: (event: RefundSchedulerEventV1) => void;
  now?: () => number;
  /** Test-only crash boundary; no runtime caller may configure this. */
  fault?: (stage: string) => void;
}
export interface RefundSchedulerEventV1 {
  version: "1";
  correlationId: string;
  taskKey: string;
  operation: "refund";
  claimId: string | null;
  result: RefundSchedulerRecordV1["outcome"] | "CLAIM_CONFLICT";
  classification: RefundSchedulerRecordV1["classification"] | null;
  signature: string | null;
  durationMs: number;
  errorClass: string | null;
}
export interface RefundSchedulerMetricsV1 {
  version: "1";
  candidates: number;
  eligible: number;
  attempts: number;
  submitted: number;
  confirmed: number;
  ambiguous: number;
  blockedByReconciliation: number;
  claimConflicts: number;
}
export const refundSchedulerEventV1Schema = z
  .object({
    version: z.literal("1"),
    correlationId: hash,
    taskKey: hash,
    operation: z.literal("refund"),
    claimId: z.string().uuid().nullable(),
    result: z.enum([
      "BLOCKED",
      "ELIGIBLE",
      "SUBMITTED",
      "CONFIRMED",
      "AMBIGUOUS",
      "CLAIM_CONFLICT",
    ]),
    classification:
      refundSchedulerRecordV1Schema.shape.classification.nullable(),
    signature: z
      .string()
      .regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/)
      .nullable(),
    durationMs: z.number().int().nonnegative(),
    errorClass: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/)
      .nullable(),
  })
  .strict();
export function structuredRefundSchedulerLog(
  value: RefundSchedulerEventV1
): string {
  return JSON.stringify(refundSchedulerEventV1Schema.parse(value));
}
export function refundSchedulerMetricsText(
  value: RefundSchedulerMetricsV1
): string {
  const lines: string[] = [];
  for (const [key, count] of Object.entries(value)) {
    if (key === "version") continue;
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error("invalid aggregate refund metric");
    lines.push(
      `setra_refund_scheduler_${key.replace(
        /[A-Z]/g,
        (letter) => `_${letter.toLowerCase()}`
      )} ${count}`
    );
  }
  return `${lines.join("\n")}\n`;
}
export type RefundRunResult =
  | { status: "RECORDED"; record: RefundSchedulerRecordV1 }
  | Exclude<ClaimResult, { status: "ACQUIRED" }>;

/** Explicitly invoked refund-only scheduler. It never calls 4A.6 worker actions. */
export class RefundScheduler {
  private readonly journal = new DurableJournal();
  private readonly claims: ReconciliationClaims;
  private readonly metrics: RefundSchedulerMetricsV1 = {
    version: "1",
    candidates: 0,
    eligible: 0,
    attempts: 0,
    submitted: 0,
    confirmed: 0,
    ambiguous: 0,
    blockedByReconciliation: 0,
    claimConflicts: 0,
  };
  constructor(private readonly options: RefundSchedulerOptions) {
    if (options.fault && process.env.NODE_ENV !== "test")
      throw new Error("refund scheduler failpoints are test-only");
    this.claims =
      options.claims ??
      new ReconciliationClaims(join(options.stateDirectory, "refund-claims"));
  }
  private point(stage: string): void {
    this.options.fault?.(stage);
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  metricsSnapshot(): RefundSchedulerMetricsV1 {
    return { ...this.metrics };
  }
  private record(value: RefundSchedulerRecordV1): RefundRunResult {
    const parsed = refundSchedulerRecordV1Schema.parse(value);
    const path = join(
      this.options.stateDirectory,
      "refund-records",
      `${parsed.taskKey}.${parsed.claimId}.json`
    );
    if (!this.journal.publish(path, parsed))
      throw new Error("refund scheduler record collision");
    return { status: "RECORDED", record: parsed };
  }
  private bound(task: Task): { quote: TaskQuote; manifest: StoredManifest } {
    const id = task.taskIdentity;
    if (!id || task.conflicts.length)
      throw new Error("task identity or inventory conflict");
    const manifestRecord = task.evidence.manifest?.find(
      (item) => item.status === "VALID"
    );
    const quoteRecord = task.evidence.tasks?.find(
      (item) => item.role === "quote.json" && item.status === "VALID"
    );
    if (!manifestRecord || !quoteRecord)
      throw new Error("manifest or quote missing");
    const manifest = new ManifestStore(dirname(manifestRecord.path)).load(
      basename(manifestRecord.path).slice(0, -5)
    );
    if (!manifest) throw new Error("manifest disappeared");
    const raw = this.journal.read(quoteRecord.path) as LegacyTaskQuoteWire;
    const quote = validateQuote(raw, {
      programId: this.options.programId,
      buyer: this.options.buyer,
      verifier: this.options.verifier,
      expectedMint: this.options.expectedMint,
      taskId: BigInt(id.taskId),
      isPrivate: id.privacy,
      serviceId: id.serviceId,
    });
    if (
      manifest.manifestHash !== hashCanonical(manifest.manifest) ||
      manifest.manifest.quoteHash !== hashCanonical(raw) ||
      manifest.manifest.policyHash !== quote.policyHash ||
      manifest.manifest.buyer !== id.buyer ||
      manifest.manifest.taskId !== id.taskId ||
      manifest.manifest.serviceId !== id.serviceId ||
      manifest.manifest.isPrivate !== id.privacy ||
      manifest.manifest.mint !== quote.mint ||
      manifest.manifest.verifier !== quote.verifier ||
      manifest.manifest.amountBaseUnits !== quote.amount.toString()
    )
      throw new Error("immutable refund task binding conflict");
    return { quote, manifest };
  }
  private async safeState(quote: TaskQuote, manifest: StoredManifest) {
    const { state, slot, clockUnix } = await this.options.reader.refundState(
      quote
    );
    if (
      !Number.isSafeInteger(slot) ||
      slot < 0 ||
      !Number.isSafeInteger(clockUnix) ||
      !state ||
      state.buyer !== manifest.manifest.buyer ||
      state.taskId !== quote.taskId ||
      state.seller !== manifest.manifest.sellerOwner ||
      state.verifier !== quote.verifier ||
      state.mint !== quote.mint ||
      state.amount !== quote.amount ||
      state.isPrivate !== quote.isPrivate
    )
      return {
        safe: false as const,
        reason: "fresh TaskState or immutable binding unavailable",
      };
    if (state.status !== "pending")
      return {
        safe: false as const,
        reason: `fresh TaskState is ${state.status}`,
      };
    if (clockUnix < state.deadlineUnix)
      return {
        safe: false as const,
        reason: "Solana Clock precedes refund deadline",
      };
    return {
      safe: true as const,
      reason: "fresh Pending TaskState and Solana Clock are eligible",
    };
  }
  private async financial(
    inventory: RecoveryInventoryV1,
    task: Task,
    quote: TaskQuote,
    manifest: StoredManifest
  ): Promise<{
    safe: boolean;
    retry: boolean;
    completed: boolean;
    classification: RefundSchedulerRecordV1["classification"];
    reason: string;
    signature: string | null;
    request: FinancialRecoveryRequest;
  }> {
    const refundOperation = await this.options.reader.refundOperation(quote);
    if (
      refundOperation.kind !== "refund" ||
      refundOperation.programId !== quote.programId ||
      refundOperation.taskState !== quote.taskStatePda ||
      !hash.safeParse(refundOperation.binding).success
    )
      throw new Error("refund operation fingerprint unavailable");
    const refundRequest: FinancialRecoveryRequest = {
      quote,
      manifest,
      operation: refundOperation as FinancialRecoveryRequest["operation"],
    };
    const intents =
      task.evidence.transactions?.filter((item) => item.role === "intent") ??
      [];
    const seen = new Set<string>();
    let prior: FinancialReconciliationResult | null = null;
    for (const intent of intents) {
      if (intent.status !== "VALID")
        throw new Error("corrupt financial intent");
      const value = this.journal.read(intent.path) as {
        operation: FinancialRecoveryRequest["operation"];
      };
      const operation = operationSchema.parse(value.operation);
      if (
        operation.programId !== quote.programId ||
        operation.taskState !== quote.taskStatePda ||
        seen.has(operation.kind)
      )
        throw new Error("financial intent task or operation conflict");
      seen.add(operation.kind);
      const request: FinancialRecoveryRequest = {
        quote,
        manifest,
        operation,
      };
      const result = await this.options.reader.reconcileFinancial(request);
      if (result.kind !== operation.kind)
        throw new Error("financial reconciliation operation conflict");
      if (operation.kind === "refund") {
        if (operation.binding !== refundOperation.binding)
          throw new Error("refund fingerprint conflict");
        prior = result;
      } else if (
        operation.kind === "funding" &&
        !(
          result.classification === "PROVEN_OCCURRED" &&
          result.receipt === "CONFIRMED"
        )
      )
        throw new Error("funding receipt is not authoritative and confirmed");
      else if (
        (operation.kind === "settlement" || operation.kind === "cancel") &&
        result.classification !== "PROVEN_NOT_OCCURRED"
      )
        throw new Error(`${operation.kind} can still affect the task`);
    }
    if (!seen.has("funding")) throw new Error("funding intent is absent");
    if (!prior)
      return {
        safe: true,
        retry: false,
        completed: false,
        classification: "PROVEN_NOT_OCCURRED",
        reason:
          "no refund intent and all existing financial effects reconciled",
        signature: null,
        request: refundRequest,
      };
    if (inventory.families["refund-retry-evidence"] !== "PRESENT")
      throw new Error("refund retry evidence family is missing");
    if (
      prior.classification === "PROVEN_OCCURRED" &&
      prior.receipt === "CONFIRMED"
    )
      return {
        safe: false,
        retry: false,
        completed: true,
        classification: "PROVEN_OCCURRED",
        reason: "confirmed refund already exists",
        signature: prior.preparedSignature,
        request: refundRequest,
      };
    const retryArchive = task.evidence["refund-retry-evidence"];
    if (retryArchive?.length) {
      if (retryArchive.length !== 1 || retryArchive[0]?.status !== "VALID")
        throw new Error("refund retry history is conflicting");
      const archived = this.journal.read(retryArchive[0].path) as {
        operation: FinancialRecoveryRequest["operation"];
        prepared: { signature: string };
      };
      if (hashCanonical(archived.operation) !== hashCanonical(refundOperation))
        throw new Error("refund retry history binding conflicts");
      if (archived.prepared.signature !== prior.preparedSignature)
        return {
          safe: false,
          retry: false,
          completed: false,
          classification: "RECONCILIATION_REQUIRED",
          reason: "automatic refund replacement already used",
          signature: prior.preparedSignature,
          request: refundRequest,
        };
    }
    const safe =
      prior.classification === "SAFE_TO_RETRY" &&
      prior.kind === "refund" &&
      prior.chainOutcome === "NOT_OCCURRED";
    return {
      safe,
      retry: safe,
      completed: false,
      classification: prior.classification,
      reason: prior.reason,
      signature: prior.preparedSignature,
      request: refundRequest,
    };
  }
  async runTask(taskKey: string): Promise<RefundRunResult> {
    hash.parse(taskKey);
    this.point("before_claim");
    const claimKey = hashCanonical({
      version: "1",
      taskKey,
      operation: "refund",
    });
    const acquired = this.claims.acquire(claimKey);
    if (acquired.status !== "ACQUIRED") {
      this.metrics.claimConflicts++;
      try {
        this.options.observe?.({
          version: "1",
          correlationId: hashCanonical({ version: "1", taskKey }),
          taskKey,
          operation: "refund",
          claimId: null,
          result: "CLAIM_CONFLICT",
          classification: null,
          signature: null,
          durationMs: 0,
          errorClass: acquired.status === "BUSY" ? null : "ClaimUnavailable",
        });
      } catch {
        // Logging is not an authority boundary.
      }
      return acquired;
    }
    const claim = acquired.claim;
    const started = this.now();
    let outcome: RefundSchedulerRecordV1["outcome"] = "BLOCKED";
    let classification: RefundSchedulerRecordV1["classification"] =
      "RECONCILIATION_REQUIRED";
    let reason = "required evidence unavailable";
    let signature: string | null = null;
    let attempted = false;
    try {
      this.point("after_claim");
      const inventory = scanRecoveryInventory({
        stateDirectory: this.options.stateDirectory,
        sellerUrl: this.options.sellerUrl,
      });
      const task = inventory.tasks.find((item) => item.taskKey === taskKey);
      if (
        !task ||
        inventory.conflicts.length ||
        inventory.staleTemporaryFiles.length ||
        task.conflicts.length
      )
        throw new Error("recovery inventory is missing or conflicting");
      if (
        Object.values(inventory.families).some(
          (status) => status === "UNREADABLE"
        )
      )
        throw new Error("recovery journal family is unreadable");
      this.point("after_inventory");
      const { quote, manifest } = this.bound(task);
      const financial = await this.financial(inventory, task, quote, manifest);
      classification = financial.classification;
      reason = financial.reason;
      signature = financial.signature;
      this.point("after_reconciliation");
      if (financial.completed) {
        outcome = "CONFIRMED";
      } else if (financial.safe) {
        const current = await this.safeState(quote, manifest);
        if (current.safe) {
          outcome = "ELIGIBLE";
          this.metrics.eligible++;
          this.point("after_eligibility");
          // Re-read every journal family and chain condition immediately before
          // entering the existing financial path; a stale projection cannot sign.
          const freshInventory = scanRecoveryInventory({
            stateDirectory: this.options.stateDirectory,
            sellerUrl: this.options.sellerUrl,
          });
          const freshTask = freshInventory.tasks.find(
            (item) => item.taskKey === taskKey
          );
          if (
            !freshTask ||
            freshInventory.conflicts.length ||
            freshInventory.staleTemporaryFiles.length ||
            freshTask.conflicts.length
          )
            throw new Error("refund evidence changed before submission");
          const fresh = await this.financial(
            freshInventory,
            freshTask,
            quote,
            manifest
          );
          const freshState = await this.safeState(quote, manifest);
          if (
            !freshState.safe ||
            !fresh.safe ||
            fresh.retry !== financial.retry ||
            fresh.request.operation.binding !==
              financial.request.operation.binding
          )
            throw new Error("refund eligibility changed before submission");
          this.point("before_submit");
          this.metrics.attempts++;
          attempted = true;
          if (financial.retry) {
            if (!this.options.submitter.retryRefundExpired)
              throw new Error("operation-specific safe retry path unavailable");
            signature = await this.options.submitter.retryRefundExpired(
              fresh.request,
              async (priorSignature) => {
                const evidence = await this.options.reader.reconcileFinancial(
                  fresh.request
                );
                return (
                  evidence.kind === "refund" &&
                  evidence.classification === "SAFE_TO_RETRY" &&
                  evidence.chainOutcome === "NOT_OCCURRED" &&
                  evidence.preparedSignature === priorSignature &&
                  (await this.safeState(quote, manifest)).safe
                );
              }
            );
          } else signature = await this.options.submitter.refundExpired(quote);
          outcome = "SUBMITTED";
          this.metrics.submitted++;
          this.point("after_submit");
          const confirmed = await this.options.reader.reconcileFinancial(
            fresh.request
          );
          if (
            confirmed.classification === "PROVEN_OCCURRED" &&
            confirmed.receipt === "CONFIRMED" &&
            confirmed.preparedSignature === signature
          ) {
            outcome = "CONFIRMED";
            classification = "PROVEN_OCCURRED";
            reason = "refund signature and chain outcome confirmed";
          } else {
            outcome = "AMBIGUOUS";
            classification = confirmed.classification;
            reason = "refund submission receipt requires reconciliation";
          }
          this.point("after_chain_confirmation");
        } else reason = current.reason;
      }
      if (outcome === "CONFIRMED") this.metrics.confirmed++;
      if (outcome === "AMBIGUOUS") this.metrics.ambiguous++;
      if (
        outcome === "BLOCKED" &&
        (classification === "RECONCILIATION_REQUIRED" ||
          classification === "UNKNOWN_FINANCIAL_OUTCOME")
      )
        this.metrics.blockedByReconciliation++;
    } catch (error) {
      outcome = attempted ? "AMBIGUOUS" : "BLOCKED";
      classification = attempted
        ? "UNKNOWN_FINANCIAL_OUTCOME"
        : "RECONCILIATION_REQUIRED";
      reason = `refund evidence unavailable (${
        error instanceof Error ? error.name : "UnknownError"
      })`;
      if (attempted) this.metrics.ambiguous++;
      else this.metrics.blockedByReconciliation++;
    } finally {
      try {
        const record = refundSchedulerRecordV1Schema.parse({
          version: "1",
          taskKey,
          correlationId: hashCanonical({ version: "1", taskKey }),
          claimId: claim.claimId,
          operation: "refund",
          outcome,
          classification,
          reason,
          signature,
          startedAtUnixMs: started,
          completedAtUnixMs: Math.max(started, this.now()),
        });
        this.point("before_record_persist");
        const result = this.record(record);
        this.point("after_record_persist");
        try {
          this.options.observe?.({
            version: "1",
            correlationId: record.correlationId,
            taskKey,
            operation: "refund",
            claimId: claim.claimId,
            result: outcome,
            classification,
            signature,
            durationMs: record.completedAtUnixMs - started,
            errorClass: outcome === "AMBIGUOUS" ? "EvidenceUnavailable" : null,
          });
        } catch {
          // Logging cannot modify the financial outcome.
        }
        return result;
      } finally {
        this.claims.release(claim);
      }
    }
  }
  async runCandidates(limit = 100): Promise<RefundRunResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
      throw new Error("invalid refund scheduler batch limit");
    const inventory = scanRecoveryInventory({
      stateDirectory: this.options.stateDirectory,
      sellerUrl: this.options.sellerUrl,
    });
    if (inventory.conflicts.length)
      throw new Error(
        "recovery inventory conflicts block refund candidate scan"
      );
    const candidates = inventory.tasks
      .filter(
        (task) =>
          task.evidence.transactions?.some((item) => item.role === "intent") ||
          task.evidence.tasks?.some((item) => item.role === "funded.json")
      )
      .slice(0, limit);
    this.metrics.candidates += candidates.length;
    const results: RefundRunResult[] = [];
    for (const candidate of candidates)
      results.push(await this.runTask(candidate.taskKey));
    return results;
  }
}
