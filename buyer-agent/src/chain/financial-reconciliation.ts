import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { DurableJournal } from "../core/journal.js";
import { hashCanonical } from "../manifest/hash.js";
import type { StoredManifest } from "../manifest/store.js";
import type { TaskQuote, TaskStateView } from "../types.js";
import { deriveTaskPda, deriveVaultPda } from "./pda.js";
import type {
  FinancialOperation,
  PreparedTransaction,
} from "./financial-journal.js";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/);
const intentSchema = z
  .object({
    operation: z
      .object({
        programId: z.string(),
        taskState: z.string(),
        kind: z.enum(["funding", "settlement", "refund", "cancel"]),
        binding: hash,
      })
      .strict(),
    state: z.literal("UNKNOWN_FINANCIAL_OUTCOME"),
  })
  .strict();
const preparedSchema = z
  .object({
    signature,
    blockhash: z.string().min(32).max(44),
    lastValidBlockHeight: z.number().int().safe().nonnegative(),
    fingerprint: hash,
    signedAtUnix: z.number().int().safe().nonnegative(),
  })
  .strict();
const completionSchema = z
  .object({ signature, confirmedAtUnix: z.number().int().safe().nonnegative() })
  .strict();

export type RecoveryFinancialKind =
  | "funding"
  | "settlement"
  | "refund"
  | "cancel";
export interface FinancialRecoveryRequest {
  quote: TaskQuote;
  manifest: StoredManifest;
  operation: FinancialOperation & {
    kind: RecoveryFinancialKind;
    binding: string;
    programId: string;
  };
  /** Required for private settlement; 4A.4 can recover this from saved voucher material. */
  nullifier?: Uint8Array;
}
export interface FinancialRecoverySnapshot {
  /** Minimum context slot across all account and Clock reads in this snapshot. */
  slot: number;
  taskState: TaskStateView | null;
  vault: { amount: bigint; mint: string; owner: string } | null;
  clockUnix: number;
  nullifierRecord?: { taskId: bigint; nullifierHex: string } | null;
}
export interface FinancialSignatureEvidence {
  contextSlot: number;
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
  err: unknown | null;
}
export interface FinancialRecoveryReader {
  snapshot(
    request: FinancialRecoveryRequest,
    minimumSlot?: number
  ): Promise<FinancialRecoverySnapshot>;
  signature(signature: string): Promise<FinancialSignatureEvidence>;
  finalizedFence(): Promise<{ slot: number; blockHeight: number | null }>;
  /** Search full history again after the finalized fence, not only recent status cache. */
  fencedSignature(
    signature: string,
    minimumSlot: number
  ): Promise<FinancialSignatureEvidence>;
  manifestMemo(
    signature: string,
    manifestHash: string
  ): Promise<"MATCH" | "MISMATCH" | "UNAVAILABLE">;
}
export type FinancialRecoveryClassification =
  | "PROVEN_OCCURRED"
  | "PROVEN_NOT_OCCURRED"
  | "SAFE_TO_RETRY"
  | "UNKNOWN_FINANCIAL_OUTCOME"
  | "RECONCILIATION_REQUIRED";
export interface FinancialReconciliationResult {
  version: "1";
  kind: RecoveryFinancialKind;
  classification: FinancialRecoveryClassification;
  chainOutcome: "OCCURRED" | "NOT_OCCURRED" | "UNKNOWN";
  receipt: "CONFIRMED" | "UNRESOLVED" | "NONE";
  preparedSignature: string | null;
  reason: string;
  /** The reconciler never executes this recommendation. */
  recommendedAction:
    | "NO_ACTION"
    | "READ_ONLY_RECONCILIATION"
    | "OPERATOR_REVIEW_REQUIRED";
}

function result(
  request: FinancialRecoveryRequest,
  classification: FinancialRecoveryClassification,
  chainOutcome: FinancialReconciliationResult["chainOutcome"],
  receipt: FinancialReconciliationResult["receipt"],
  preparedSignature: string | null,
  reason: string
): FinancialReconciliationResult {
  return {
    version: "1",
    kind: request.operation.kind,
    classification,
    chainOutcome,
    receipt,
    preparedSignature,
    reason,
    recommendedAction:
      classification === "RECONCILIATION_REQUIRED"
        ? "OPERATOR_REVIEW_REQUIRED"
        : classification === "UNKNOWN_FINANCIAL_OUTCOME"
        ? "READ_ONLY_RECONCILIATION"
        : "NO_ACTION",
  };
}
function matchTask(
  request: FinancialRecoveryRequest,
  snapshot: FinancialRecoverySnapshot
): boolean {
  const task = snapshot.taskState,
    manifest = request.manifest.manifest,
    quote = request.quote;
  if (!task) return false;
  return (
    task.buyer === manifest.buyer &&
    task.taskId.toString() === manifest.taskId &&
    task.seller === manifest.sellerOwner &&
    task.verifier === manifest.verifier &&
    task.mint === manifest.mint &&
    task.amount.toString() === manifest.amountBaseUnits &&
    task.isPrivate === manifest.isPrivate &&
    quote.isPrivate === manifest.isPrivate
  );
}
function validVault(
  request: FinancialRecoveryRequest,
  snapshot: FinancialRecoverySnapshot
): boolean {
  return (
    !!snapshot.vault &&
    snapshot.vault.mint === request.quote.mint &&
    snapshot.vault.owner === request.quote.taskStatePda
  );
}
function completed(
  request: FinancialRecoveryRequest,
  snapshot: FinancialRecoverySnapshot
): boolean {
  const task = snapshot.taskState;
  if (!task || !validVault(request, snapshot)) return false;
  if (request.operation.kind === "funding")
    return task.status === "pending"
      ? snapshot.vault!.amount === task.amount
      : snapshot.vault!.amount === 0n;
  if (request.operation.kind === "settlement") {
    if (task.status !== "settled" || snapshot.vault!.amount !== 0n)
      return false;
    if (!request.quote.isPrivate) return true;
    return (
      !!request.nullifier &&
      request.nullifier.length === 32 &&
      snapshot.nullifierRecord?.taskId === task.taskId &&
      snapshot.nullifierRecord.nullifierHex ===
        Buffer.from(request.nullifier).toString("hex")
    );
  }
  return task.status === "refunded" && snapshot.vault!.amount === 0n;
}
function inconsistentTerminalEvidence(
  request: FinancialRecoveryRequest,
  snapshot: FinancialRecoverySnapshot
): boolean {
  const state = snapshot.taskState;
  if (!state) return false;
  if (request.operation.kind === "funding")
    return !completed(request, snapshot);
  if (request.operation.kind === "settlement" && state.status === "settled")
    return !completed(request, snapshot);
  if (
    (request.operation.kind === "refund" ||
      request.operation.kind === "cancel") &&
    state.status === "refunded"
  )
    return !completed(request, snapshot);
  return false;
}
function permits(
  request: FinancialRecoveryRequest,
  snapshot: FinancialRecoverySnapshot
): boolean {
  const task = snapshot.taskState;
  if (request.operation.kind === "funding") return !task && !snapshot.vault;
  if (
    !task ||
    task.status !== "pending" ||
    !validVault(request, snapshot) ||
    snapshot.vault!.amount !== task.amount
  )
    return false;
  if (request.operation.kind === "refund")
    return snapshot.clockUnix >= task.deadlineUnix;
  return snapshot.clockUnix < task.deadlineUnix;
}
function safeContext(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Read-only authoritative evidence layer. It neither signs nor submits any operation. */
export class FinancialReconciler {
  private readonly journal = new DurableJournal();
  constructor(
    private readonly directory: string,
    private readonly reader: FinancialRecoveryReader
  ) {}

  async reconcile(
    request: FinancialRecoveryRequest
  ): Promise<FinancialReconciliationResult> {
    const operation = request.operation,
      quote = request.quote,
      manifest = request.manifest;
    let localValidated = false;
    try {
      if (
        operation.programId !== quote.programId ||
        operation.taskState !== quote.taskStatePda ||
        !hash.safeParse(operation.binding).success ||
        manifest.manifestHash !== hashCanonical(manifest.manifest) ||
        manifest.manifest.quoteHash !== hashCanonical(quote.raw) ||
        manifest.manifest.policyHash !== quote.policyHash ||
        manifest.manifest.taskId !== quote.taskId.toString() ||
        manifest.manifest.serviceId !== quote.serviceId ||
        manifest.manifest.isPrivate !== quote.isPrivate
      )
        return result(
          request,
          "RECONCILIATION_REQUIRED",
          "UNKNOWN",
          "NONE",
          null,
          "immutable request binding conflict"
        );
      const [taskPda] = deriveTaskPda(
        new PublicKey(quote.programId),
        new PublicKey(manifest.manifest.buyer),
        quote.taskId
      );
      const [vaultPda] = deriveVaultPda(
        new PublicKey(quote.programId),
        taskPda
      );
      if (
        taskPda.toBase58() !== quote.taskStatePda ||
        vaultPda.toBase58() !== quote.vaultPda
      )
        return result(
          request,
          "RECONCILIATION_REQUIRED",
          "UNKNOWN",
          "NONE",
          null,
          "PDA binding conflict"
        );
      if (
        operation.kind === "settlement" &&
        quote.isPrivate &&
        (!request.nullifier || request.nullifier.length !== 32)
      )
        return result(
          request,
          "RECONCILIATION_REQUIRED",
          "UNKNOWN",
          "NONE",
          null,
          "private nullifier evidence is unavailable"
        );
      const id = hashCanonical({
        programId: operation.programId,
        taskState: operation.taskState,
        kind: operation.kind,
      });
      const intentRaw = this.journal.read(join(this.directory, `${id}.intent`));
      const preparedRaw = this.journal.read(
        join(this.directory, `${id}.transaction.json`)
      );
      const completionRaw = this.journal.read(
        join(this.directory, `${id}.confirmed.json`)
      );
      if (!intentRaw)
        return result(
          request,
          "RECONCILIATION_REQUIRED",
          "UNKNOWN",
          "NONE",
          null,
          preparedRaw || completionRaw
            ? "orphan financial record"
            : "no durable financial intent"
        );
      const intent = intentSchema.parse(intentRaw);
      if (hashCanonical(intent.operation) !== hashCanonical(operation))
        return result(
          request,
          "RECONCILIATION_REQUIRED",
          "UNKNOWN",
          "NONE",
          null,
          "financial operation binding conflict"
        );
      if (completionRaw && !preparedRaw)
        return result(
          request,
          "RECONCILIATION_REQUIRED",
          "UNKNOWN",
          "NONE",
          null,
          "completion without prepared signature"
        );
      const prepared: PreparedTransaction | null = preparedRaw
        ? preparedSchema.parse(preparedRaw)
        : null;
      const completion = completionRaw
        ? completionSchema.parse(completionRaw)
        : null;
      if (
        prepared &&
        (prepared.fingerprint !== operation.binding ||
          (completion && completion.signature !== prepared.signature))
      )
        return result(
          request,
          "RECONCILIATION_REQUIRED",
          "UNKNOWN",
          "NONE",
          prepared.signature,
          "prepared fingerprint or completion signature conflict"
        );
      localValidated = true;
      const snapshot = await this.reader.snapshot(request);
      if (
        !safeContext(snapshot.slot) ||
        !Number.isSafeInteger(snapshot.clockUnix) ||
        (snapshot.taskState && !matchTask(request, snapshot)) ||
        (snapshot.vault && !validVault(request, snapshot))
      )
        return result(
          request,
          "RECONCILIATION_REQUIRED",
          "UNKNOWN",
          "NONE",
          prepared?.signature ?? null,
          "authoritative account identity or context conflict"
        );
      if (inconsistentTerminalEvidence(request, snapshot))
        return result(
          request,
          "RECONCILIATION_REQUIRED",
          "UNKNOWN",
          "UNRESOLVED",
          prepared?.signature ?? null,
          "terminal or funded account evidence conflicts with vault/nullifier evidence"
        );
      if (!prepared)
        return result(
          request,
          "UNKNOWN_FINANCIAL_OUTCOME",
          completed(request, snapshot) ? "OCCURRED" : "UNKNOWN",
          "UNRESOLVED",
          null,
          "intent exists without prepared signature"
        );
      const status = await this.reader.signature(prepared.signature);
      if (!safeContext(status.contextSlot))
        return result(
          request,
          "UNKNOWN_FINANCIAL_OUTCOME",
          "UNKNOWN",
          "UNRESOLVED",
          prepared.signature,
          "signature context unavailable"
        );
      const confirmed =
        (status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized") &&
        status.err === null;
      if (confirmed && completed(request, snapshot)) {
        if (operation.kind === "funding") {
          const memo = await this.reader.manifestMemo(
            prepared.signature,
            manifest.manifestHash
          );
          if (memo !== "MATCH")
            return result(
              request,
              memo === "MISMATCH"
                ? "RECONCILIATION_REQUIRED"
                : "UNKNOWN_FINANCIAL_OUTCOME",
              "OCCURRED",
              "UNRESOLVED",
              prepared.signature,
              "funding manifest memo is not confirmed"
            );
        }
        return result(
          request,
          "PROVEN_OCCURRED",
          "OCCURRED",
          "CONFIRMED",
          prepared.signature,
          "successful signature and matching authoritative account outcome"
        );
      }
      if (completed(request, snapshot))
        return result(
          request,
          "PROVEN_OCCURRED",
          "OCCURRED",
          "UNRESOLVED",
          prepared.signature,
          "authoritative account outcome exists; original receipt remains unresolved"
        );
      const fence = await this.reader.finalizedFence();
      if (!safeContext(fence.slot) || !safeContext(fence.blockHeight ?? -1))
        return result(
          request,
          "UNKNOWN_FINANCIAL_OUTCOME",
          "UNKNOWN",
          "UNRESOLVED",
          prepared.signature,
          "finalized block-height fence unavailable"
        );
      if (
        fence.blockHeight! <= prepared.lastValidBlockHeight &&
        !(status.confirmationStatus === "finalized" && status.err !== null)
      )
        return result(
          request,
          "UNKNOWN_FINANCIAL_OUTCOME",
          "UNKNOWN",
          "UNRESOLVED",
          prepared.signature,
          "original transaction can still land"
        );
      const fencedStatus = await this.reader.fencedSignature(
        prepared.signature,
        fence.slot
      );
      const fenced = await this.reader.snapshot(request, fence.slot);
      if (
        !safeContext(fencedStatus.contextSlot) ||
        fencedStatus.contextSlot < fence.slot ||
        !safeContext(fenced.slot) ||
        fenced.slot < fence.slot ||
        (fenced.taskState && !matchTask(request, fenced)) ||
        (fenced.vault && !validVault(request, fenced))
      )
        return result(
          request,
          "UNKNOWN_FINANCIAL_OUTCOME",
          "UNKNOWN",
          "UNRESOLVED",
          prepared.signature,
          "fenced history or account read is stale/inconsistent"
        );
      if (inconsistentTerminalEvidence(request, fenced))
        return result(
          request,
          "RECONCILIATION_REQUIRED",
          "UNKNOWN",
          "UNRESOLVED",
          prepared.signature,
          "fenced terminal or funded account evidence conflicts with vault/nullifier evidence"
        );
      if (completed(request, fenced))
        return result(
          request,
          "PROVEN_OCCURRED",
          "OCCURRED",
          "UNRESOLVED",
          prepared.signature,
          "fenced account outcome exists; receipt remains unresolved"
        );
      const cannotLand =
        (fence.blockHeight! > prepared.lastValidBlockHeight &&
          fencedStatus.confirmationStatus === null) ||
        (fencedStatus.confirmationStatus === "finalized" &&
          fencedStatus.err !== null);
      if (
        !cannotLand ||
        (fencedStatus.confirmationStatus === "confirmed" &&
          fencedStatus.err === null)
      )
        return result(
          request,
          "UNKNOWN_FINANCIAL_OUTCOME",
          "UNKNOWN",
          "UNRESOLVED",
          prepared.signature,
          "signature history remains ambiguous"
        );
      if (operation.kind === "settlement")
        return result(
          request,
          "PROVEN_NOT_OCCURRED",
          "NOT_OCCURRED",
          "NONE",
          prepared.signature,
          "original settlement cannot land; verification authority still controls any new settlement"
        );
      return result(
        request,
        permits(request, fenced) ? "SAFE_TO_RETRY" : "PROVEN_NOT_OCCURRED",
        "NOT_OCCURRED",
        "NONE",
        prepared.signature,
        "original transaction cannot land after finalized fence; no submission performed"
      );
    } catch {
      return result(
        request,
        localValidated
          ? "UNKNOWN_FINANCIAL_OUTCOME"
          : "RECONCILIATION_REQUIRED",
        "UNKNOWN",
        "UNRESOLVED",
        null,
        localValidated
          ? "authoritative chain evidence unavailable"
          : "corrupt local evidence"
      );
    }
  }
}
