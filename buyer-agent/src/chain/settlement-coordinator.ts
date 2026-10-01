import { PublicKey } from "@solana/web3.js";
import {
  InvalidQuote,
  ManifestMismatch,
  ReplayDetected,
  SettlementTooCloseToDeadline,
  TaskConflict,
  TransactionSubmissionError,
} from "../errors.js";
import { hashCanonical } from "../manifest/hash.js";
import type { StoredManifest } from "../manifest/store.js";
import type { TaskQuote, TaskStateView } from "../types.js";
import { canSettleBeforeDeadline } from "./settlement.js";

const REFUND_CLOCK_POLL_MS = 250;
const MAX_REFUND_CLOCK_WAIT_MS = 10_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface SettlementChain {
  buyer: PublicKey;
  verifier: PublicKey;
  fetchTaskState(address: PublicKey): Promise<TaskStateView | null>;
  getChainUnixTime(): Promise<number>;
  verifyManifestMemo(signature: string, expectedHash: string): Promise<void>;
  settlePublic(
    taskState: PublicKey,
    vault: PublicKey,
    sellerTokenAccount: PublicKey
  ): Promise<string>;
  settlePrivate(
    taskState: PublicKey,
    vault: PublicKey,
    sellerTokenAccount: PublicKey,
    nullifier: Uint8Array
  ): Promise<string>;
  fetchNullifierRecord(nullifier: Uint8Array): Promise<unknown | null>;
  requireBuyerAta(mint: PublicKey): Promise<PublicKey>;
  refund(
    taskState: PublicKey,
    vault: PublicKey,
    buyerTokenAccount: PublicKey
  ): Promise<string>;
  cancel(
    taskState: PublicKey,
    vault: PublicKey,
    buyerTokenAccount: PublicKey
  ): Promise<string>;
}

export interface SettlementResult {
  signature: string;
  state: TaskStateView;
  nullifier?: Uint8Array;
}

export class SettlementCoordinator {
  constructor(
    private readonly chain: SettlementChain,
    private readonly safetyMarginSeconds: number,
    private readonly mirrorNullifier?: (nullifier: Uint8Array) => Promise<void>
  ) {}

  async settle(
    quote: TaskQuote,
    record: StoredManifest,
    options: { nowUnix?: number; nullifier?: Uint8Array } = {}
  ): Promise<SettlementResult> {
    const taskStateAddress = new PublicKey(quote.taskStatePda);
    const state = await this.requirePending(taskStateAddress);
    if (
      !this.chain.verifier.equals(new PublicKey(state.verifier)) ||
      state.verifier !== quote.verifier
    ) {
      throw new InvalidQuote(
        "configured verifier does not match TaskState and quote"
      );
    }
    if (state.isPrivate !== quote.isPrivate)
      throw new InvalidQuote("TaskState privacy does not match quote");
    const nowUnix =
      options.nowUnix === undefined
        ? await this.chain.getChainUnixTime()
        : options.nowUnix;
    if (!Number.isSafeInteger(nowUnix))
      throw new RangeError("nowUnix must be a safe integer");
    if (
      !canSettleBeforeDeadline(
        nowUnix,
        state.deadlineUnix,
        this.safetyMarginSeconds
      )
    ) {
      throw new SettlementTooCloseToDeadline(
        "settlement safety margin has been reached"
      );
    }
    this.assertLocalManifest(quote, record, state);
    if (!record.initializeSignature)
      throw new ManifestMismatch("initialize transaction signature is missing");
    await this.chain.verifyManifestMemo(
      record.initializeSignature,
      record.manifestHash
    );

    const vault = new PublicKey(quote.vaultPda);
    const sellerTokenAccount = new PublicKey(quote.sellerTokenAccount);
    let signature: string;
    let nullifier: Uint8Array | undefined;
    let recoveredState: TaskStateView | null = null;
    if (quote.isPrivate) {
      nullifier = options.nullifier;
      if (!nullifier)
        throw new InvalidQuote(
          "private settlement requires a verified Chaumian voucher nullifier"
        );
      if (nullifier.length !== 32)
        throw new RangeError("nullifier must be exactly 32 bytes");
      if (await this.chain.fetchNullifierRecord(nullifier))
        throw new ReplayDetected("nullifier already exists on chain");
      try {
        signature = await this.chain.settlePrivate(
          taskStateAddress,
          vault,
          sellerTokenAccount,
          nullifier
        );
      } catch (error) {
        if (!(error instanceof TransactionSubmissionError)) throw error;
        recoveredState = await this.chain.fetchTaskState(taskStateAddress);
        if (recoveredState?.status !== "settled") throw error;
        if (!(await this.chain.fetchNullifierRecord(nullifier))) throw error;
        signature = error.signature;
      }
      if (this.mirrorNullifier) {
        try {
          await this.mirrorNullifier(nullifier);
        } catch {
          // Redis is a cache. A cache failure cannot overturn confirmed settlement.
        }
      }
    } else {
      try {
        signature = await this.chain.settlePublic(
          taskStateAddress,
          vault,
          sellerTokenAccount
        );
      } catch (error) {
        if (!(error instanceof TransactionSubmissionError)) throw error;
        recoveredState = await this.chain.fetchTaskState(taskStateAddress);
        if (recoveredState?.status !== "settled") throw error;
        signature = error.signature;
      }
    }

    const settled =
      recoveredState ?? (await this.chain.fetchTaskState(taskStateAddress));
    if (!settled || settled.status !== "settled")
      throw new TaskConflict(
        "settlement confirmed but TaskState is not settled"
      );
    return nullifier
      ? { signature, state: settled, nullifier }
      : { signature, state: settled };
  }

  async refundExpired(quote: TaskQuote, nowUnix?: number): Promise<string> {
    const taskState = new PublicKey(quote.taskStatePda);
    const state = await this.requirePending(taskState);
    if (nowUnix === undefined) {
      await this.waitForRefundDeadline(state.deadlineUnix);
    } else {
      if (!Number.isSafeInteger(nowUnix))
        throw new RangeError("nowUnix must be a safe integer");
      if (nowUnix < state.deadlineUnix)
        throw new TaskConflict("refund is not yet available");
    }
    const buyerAta = await this.chain.requireBuyerAta(
      new PublicKey(state.mint)
    );
    let signature: string;
    let refunded: TaskStateView | null = null;
    try {
      signature = await this.chain.refund(
        taskState,
        new PublicKey(quote.vaultPda),
        buyerAta
      );
    } catch (error) {
      if (!(error instanceof TransactionSubmissionError)) throw error;
      refunded = await this.chain.fetchTaskState(taskState);
      if (refunded?.status !== "refunded") throw error;
      signature = error.signature;
    }
    refunded ??= await this.chain.fetchTaskState(taskState);
    if (!refunded || refunded.status !== "refunded")
      throw new TaskConflict("refund confirmed but TaskState is not refunded");
    return signature;
  }

  async cancelVoluntarily(
    quote: TaskQuote,
    nowUnix = Math.floor(Date.now() / 1000)
  ): Promise<string> {
    const taskState = new PublicKey(quote.taskStatePda);
    const state = await this.requirePending(taskState);
    if (nowUnix >= state.deadlineUnix)
      throw new TaskConflict(
        "task is expired; use timeout refund instead of cancellation"
      );
    const buyerAta = await this.chain.requireBuyerAta(
      new PublicKey(state.mint)
    );
    let signature: string;
    let cancelled: TaskStateView | null = null;
    try {
      signature = await this.chain.cancel(
        taskState,
        new PublicKey(quote.vaultPda),
        buyerAta
      );
    } catch (error) {
      if (!(error instanceof TransactionSubmissionError)) throw error;
      cancelled = await this.chain.fetchTaskState(taskState);
      if (cancelled?.status !== "refunded") throw error;
      signature = error.signature;
    }
    cancelled ??= await this.chain.fetchTaskState(taskState);
    if (!cancelled || cancelled.status !== "refunded")
      throw new TaskConflict(
        "cancellation confirmed but TaskState is not refunded"
      );
    return signature;
  }

  private async requirePending(address: PublicKey): Promise<TaskStateView> {
    const state = await this.chain.fetchTaskState(address);
    if (!state) throw new TaskConflict("TaskState does not exist");
    if (state.status !== "pending")
      throw new TaskConflict(`TaskState is ${state.status}, not pending`);
    return state;
  }

  private async waitForRefundDeadline(deadlineUnix: number): Promise<void> {
    const stopAt = Date.now() + MAX_REFUND_CLOCK_WAIT_MS;
    while (true) {
      if ((await this.chain.getChainUnixTime()) >= deadlineUnix) return;
      if (Date.now() >= stopAt)
        throw new TaskConflict(
          "seller reported expiration but the on-chain clock has not reached the refund deadline"
        );
      await delay(REFUND_CLOCK_POLL_MS);
    }
  }

  private assertLocalManifest(
    quote: TaskQuote,
    record: StoredManifest,
    state: TaskStateView
  ): void {
    if (hashCanonical(record.manifest) !== record.manifestHash)
      throw new ManifestMismatch("local manifest hash mismatch");
    if (record.manifest.taskId !== quote.taskId.toString())
      throw new ManifestMismatch("manifest taskId mismatch");
    if (record.manifest.buyer !== this.chain.buyer.toBase58())
      throw new ManifestMismatch("manifest buyer mismatch");
    if (record.manifest.sellerTokenAccount !== quote.sellerTokenAccount)
      throw new ManifestMismatch("manifest sellerTokenAccount mismatch");
    if (record.manifest.sellerOwner !== state.seller)
      throw new ManifestMismatch("manifest sellerOwner mismatch");
    if (record.manifest.verifier !== quote.verifier)
      throw new ManifestMismatch("manifest verifier mismatch");
    if (record.manifest.mint !== quote.mint)
      throw new ManifestMismatch("manifest mint mismatch");
    if (record.manifest.amountBaseUnits !== quote.amount.toString())
      throw new ManifestMismatch("manifest amount mismatch");
    if (record.manifest.timeoutSeconds !== quote.timeoutSeconds)
      throw new ManifestMismatch("manifest timeout mismatch");
    if (record.manifest.isPrivate !== quote.isPrivate)
      throw new ManifestMismatch("manifest privacy mismatch");
    if (record.manifest.quoteHash !== hashCanonical(quote.raw))
      throw new ManifestMismatch("manifest quote hash mismatch");
    if (state.taskId !== quote.taskId)
      throw new ManifestMismatch("TaskState taskId mismatch");
    if (state.amount !== quote.amount)
      throw new ManifestMismatch("TaskState amount mismatch");
    if (state.mint !== quote.mint)
      throw new ManifestMismatch("TaskState mint mismatch");
  }
}
