import { Program, AnchorProvider, Wallet, type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import bs58 from "bs58";
import { getAccount, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Signer,
} from "@solana/web3.js";
import { ManifestMismatch, TransactionSubmissionError } from "../errors.js";
import type { TaskQuote, TaskStateView, TaskStatus } from "../types.js";
import { encodeManifestMemo, MEMO_PROGRAM_ID } from "./memo.js";
import { deriveBuyerAta, deriveNullifierPda } from "./pda.js";
import type { EscrowChain, InitializeTaskInput } from "./escrow.js";
import { resolve } from "node:path";
import { hashCanonical } from "../manifest/hash.js";
import {
  FinancialJournal,
  type PreparedTransaction,
} from "./financial-journal.js";
import {
  FinancialReconciler,
  type FinancialRecoveryRequest,
  type FinancialReconciliationResult,
} from "./financial-reconciliation.js";

function statusName(status: unknown): TaskStatus {
  if (!status || typeof status !== "object")
    throw new Error("TaskState has invalid status");
  const key = Object.keys(status)[0]?.toLowerCase();
  if (key === "pending" || key === "settled" || key === "refunded") return key;
  throw new Error(`TaskState has unknown status ${String(key)}`);
}

function bigintValue(value: { toString(): string }): bigint {
  return BigInt(value.toString());
}

function safeNumber(value: { toString(): string }, field: string): number {
  const result = Number(value.toString());
  if (!Number.isSafeInteger(result))
    throw new RangeError(`${field} is outside JavaScript safe integer range`);
  return result;
}

function staleBlockhash(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /blockhash not found|block height exceeded|transaction expired/i.test(
    message
  );
}

export interface ChainClientOptions {
  connection: Connection;
  idl: Idl;
  programId: PublicKey;
  buyer: Keypair;
  verifier: Keypair;
  protocolTreasury: PublicKey;
  maxSendAttempts?: number;
  transactionDirectory?: string;
}

export interface SendRebuiltTransactionOptions {
  connection: Connection;
  buildInstructions: () => Promise<TransactionInstruction[]>;
  payer: Keypair;
  signers: Signer[];
  maxAttempts: number;
  onSigned?: (signature: string) => void;
  onPrepared?: (transaction: PreparedTransaction) => void;
  canRebuild?: (minimumSlot: number) => Promise<boolean>;
}

export async function sendRebuiltTransaction(
  options: SendRebuiltTransactionOptions
): Promise<string> {
  if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1)
    throw new RangeError("maxAttempts must be a positive safe integer");
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const latest = await options.connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({
      feePayer: options.payer.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    });
    transaction.add(...(await options.buildInstructions()));
    transaction.sign(...options.signers);
    if (!transaction.signature)
      throw new Error("signed transaction has no payer signature");
    const expectedSignature = bs58.encode(transaction.signature);
    options.onPrepared?.({
      signature: expectedSignature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      fingerprint: hashCanonical(
        transaction.instructions.map((instruction) => ({
          program: instruction.programId.toBase58(),
          accounts: instruction.keys.map((key) => ({
            pubkey: key.pubkey.toBase58(),
            signer: key.isSigner,
            writable: key.isWritable,
          })),
          data: instruction.data.toString("hex"),
        }))
      ),
      signedAtUnix: Math.floor(Date.now() / 1000),
    });
    options.onSigned?.(expectedSignature);
    let signature = expectedSignature;
    try {
      const rpcSignature = await options.connection.sendRawTransaction(
        transaction.serialize()
      );
      if (rpcSignature !== expectedSignature)
        throw new Error(
          "RPC returned a signature that differs from the signed transaction"
        );
      signature = rpcSignature;
      const confirmation = await options.connection.confirmTransaction(
        { signature, ...latest },
        "confirmed"
      );
      if (confirmation.value.err) {
        throw new Error(
          `transaction ${signature} failed: ${JSON.stringify(
            confirmation.value.err
          )}`
        );
      }
      return signature;
    } catch (error) {
      let knownFailure = false;
      try {
        const status = await options.connection.getSignatureStatus(signature, {
          searchTransactionHistory: true,
        });
        if (
          status.value?.err === null &&
          (status.value.confirmationStatus === "confirmed" ||
            status.value.confirmationStatus === "finalized")
        )
          return signature;
        knownFailure =
          status.value !== null &&
          status.value.err !== null &&
          (status.value.confirmationStatus === "confirmed" ||
            status.value.confirmationStatus === "finalized");
      } catch {
        // The signature remains usable for state-based ambiguity recovery.
      }
      lastError = error;
      if (knownFailure) break;
      if (staleBlockhash(error) && attempt < options.maxAttempts) {
        // An RPC error string cannot establish expiry. Query a rooted height,
        // then query history again after that fence before rebuilding.
        try {
          const fence = await options.connection.getSlot("finalized");
          const block = await options.connection.getParsedBlock(fence, {
            commitment: "finalized",
            transactionDetails: "none",
            rewards: false,
            maxSupportedTransactionVersion: 0,
          });
          const height = block?.blockHeight;
          const afterExpiry = await options.connection.getSignatureStatus(
            signature,
            { searchTransactionHistory: true }
          );
          if (
            height !== undefined &&
            height !== null &&
            height > latest.lastValidBlockHeight &&
            afterExpiry.value === null &&
            afterExpiry.context.slot >= fence &&
            (await options.canRebuild?.(fence))
          )
            continue;
        } catch {
          /* Unavailable evidence remains ambiguous. */
        }
      }
      throw new TransactionSubmissionError(
        `transaction ${signature} has an ambiguous submission result`,
        signature,
        error
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export class ChainClient implements EscrowChain {
  readonly buyer: PublicKey;
  readonly verifier: PublicKey;
  readonly program: Program;
  private readonly memoProgram = new PublicKey(MEMO_PROGRAM_ID);
  private readonly maxSendAttempts: number;
  private readonly financial: FinancialJournal;

  constructor(private readonly options: ChainClientOptions) {
    this.buyer = options.buyer.publicKey;
    this.verifier = options.verifier.publicKey;
    this.maxSendAttempts = options.maxSendAttempts ?? 2;
    this.financial = new FinancialJournal(
      options.transactionDirectory ??
        resolve(process.env.SETRA_STATE_DIR ?? ".setra-state", "transactions")
    );
    if (!Number.isSafeInteger(this.maxSendAttempts) || this.maxSendAttempts < 1)
      throw new RangeError("maxSendAttempts must be a positive safe integer");
    const idlAddress =
      "address" in options.idl
        ? new PublicKey(String(options.idl.address))
        : null;
    if (!idlAddress?.equals(options.programId))
      throw new Error("IDL address does not match PROGRAM_ID");
    const provider = new AnchorProvider(
      options.connection,
      new Wallet(options.buyer),
      { commitment: "confirmed" }
    );
    this.program = new Program(options.idl, provider);
  }

  async fetchTaskState(address: PublicKey): Promise<TaskStateView | null> {
    return (await this.fetchTaskEvidence(address)).state;
  }
  private async fetchTaskEvidence(address: PublicKey, minimumSlot?: number) {
    const response = await this.options.connection.getAccountInfoAndContext(
      address,
      {
        commitment: "confirmed",
        ...(minimumSlot === undefined ? {} : { minContextSlot: minimumSlot }),
      }
    );
    if (minimumSlot !== undefined && response.context.slot < minimumSlot)
      throw new Error("RPC task evidence is older than the recovery fence");
    if (response.value && !response.value.owner.equals(this.options.programId))
      throw new Error("TaskState account owner mismatch");
    const account = response.value
      ? this.program.coder.accounts.decode<any>(
          "taskState",
          response.value.data
        )
      : null;
    return { slot: response.context.slot, state: this.taskView(account) };
  }
  private taskView(account: any): TaskStateView | null {
    if (!account) return null;
    return {
      buyer: account.buyer.toBase58(),
      seller: account.seller.toBase58(),
      verifier: account.verifier.toBase58(),
      mint: account.mint.toBase58(),
      taskId: bigintValue(account.taskId),
      amount: bigintValue(account.amount),
      deadlineUnix: safeNumber(account.deadlineUnix, "deadlineUnix"),
      status: statusName(account.status),
      isPrivate: account.isPrivate,
      bump: account.bump,
    };
  }

  async fetchNullifierRecord(nullifier: Uint8Array): Promise<unknown | null> {
    const [address] = deriveNullifierPda(this.options.programId, nullifier);
    return (this.program.account as any).nullifierRecord.fetchNullable(address);
  }

  /** Read-only reconciliation entry point. No signer or transaction sender is invoked. */
  async reconcileFinancial(
    request: FinancialRecoveryRequest
  ): Promise<FinancialReconciliationResult> {
    const connection = this.options.connection;
    const transactions =
      this.options.transactionDirectory ??
      resolve(process.env.SETRA_STATE_DIR ?? ".setra-state", "transactions");
    return new FinancialReconciler(transactions, {
      snapshot: async (input, minimumSlot) => {
        const options = {
          commitment: "confirmed" as const,
          ...(minimumSlot === undefined ? {} : { minContextSlot: minimumSlot }),
        };
        const taskAddress = new PublicKey(input.quote.taskStatePda);
        const vaultAddress = new PublicKey(input.quote.vaultPda);
        const task = await this.fetchTaskEvidence(taskAddress, minimumSlot);
        const vaultResponse = await connection.getAccountInfoAndContext(
          vaultAddress,
          options
        );
        const clockResponse = await connection.getAccountInfoAndContext(
          SYSVAR_CLOCK_PUBKEY,
          options
        );
        if (!clockResponse.value || clockResponse.value.data.length < 40)
          throw new Error("Solana Clock unavailable");
        const clockUnix = Number(clockResponse.value.data.readBigInt64LE(32));
        if (!Number.isSafeInteger(clockUnix))
          throw new Error("Solana Clock outside safe range");
        let nullifierRecord: { taskId: bigint; nullifierHex: string } | null =
          null;
        let nullifierSlot = Number.MAX_SAFE_INTEGER;
        if (
          input.quote.isPrivate &&
          input.operation.kind === "settlement" &&
          input.nullifier
        ) {
          const [address] = deriveNullifierPda(
            this.options.programId,
            input.nullifier
          );
          const response = await connection.getAccountInfoAndContext(
            address,
            options
          );
          nullifierSlot = response.context.slot;
          if (response.value) {
            if (!response.value.owner.equals(this.options.programId))
              throw new Error("NullifierRecord account owner mismatch");
            const decoded = this.program.coder.accounts.decode<any>(
              "nullifierRecord",
              response.value.data
            );
            nullifierRecord = {
              taskId: bigintValue(decoded.taskId),
              nullifierHex: Buffer.from(decoded.nullifier).toString("hex"),
            };
          }
        }
        const vault = vaultResponse.value
          ? (() => {
              if (!vaultResponse.value!.owner.equals(TOKEN_PROGRAM_ID))
                throw new Error("vault token account owner mismatch");
              const account = unpackAccount(
                vaultAddress,
                vaultResponse.value!,
                TOKEN_PROGRAM_ID
              );
              return {
                amount: account.amount,
                mint: account.mint.toBase58(),
                owner: account.owner.toBase58(),
              };
            })()
          : null;
        const slot = Math.min(
          task.slot,
          vaultResponse.context.slot,
          clockResponse.context.slot,
          nullifierSlot
        );
        if (minimumSlot !== undefined && slot < minimumSlot)
          throw new Error(
            "authoritative recovery snapshot is older than finalized fence"
          );
        return {
          slot,
          taskState: task.state,
          vault,
          clockUnix,
          nullifierRecord,
        };
      },
      signature: async (value) => {
        const response = await connection.getSignatureStatus(value, {
          searchTransactionHistory: true,
        });
        return {
          contextSlot: response.context.slot,
          confirmationStatus: response.value?.confirmationStatus ?? null,
          err: response.value?.err ?? null,
        };
      },
      fencedSignature: async (value, minimumSlot) => {
        const response = await connection.getSignatureStatus(value, {
          searchTransactionHistory: true,
        });
        if (response.context.slot < minimumSlot)
          throw new Error("signature history is older than finalized fence");
        return {
          contextSlot: response.context.slot,
          confirmationStatus: response.value?.confirmationStatus ?? null,
          err: response.value?.err ?? null,
        };
      },
      finalizedFence: async () => {
        const slot = await connection.getSlot("finalized");
        const block = await connection.getParsedBlock(slot, {
          commitment: "finalized",
          transactionDetails: "none",
          rewards: false,
          maxSupportedTransactionVersion: 0,
        });
        return { slot, blockHeight: block?.blockHeight ?? null };
      },
      manifestMemo: async (value, expectedHash) => {
        try {
          await this.verifyManifestMemo(value, expectedHash);
          return "MATCH" as const;
        } catch (error) {
          return error instanceof ManifestMismatch &&
            !/unavailable/i.test(error.message)
            ? ("MISMATCH" as const)
            : ("UNAVAILABLE" as const);
        }
      },
    }).reconcile(request);
  }

  async resolveTokenAccountOwner(
    address: PublicKey,
    expectedMint?: PublicKey
  ): Promise<PublicKey> {
    const account = await getAccount(
      this.options.connection,
      address,
      "confirmed"
    );
    if (expectedMint && !account.mint.equals(expectedMint))
      throw new Error("seller token account mint does not match quote");
    return account.owner;
  }

  async requireBuyerAta(mint: PublicKey): Promise<PublicKey> {
    const address = deriveBuyerAta(mint, this.buyer);
    const account = await getAccount(
      this.options.connection,
      address,
      "confirmed"
    );
    if (!account.owner.equals(this.buyer))
      throw new Error("buyer ATA owner mismatch");
    if (!account.mint.equals(mint)) throw new Error("buyer ATA mint mismatch");
    return address;
  }

  async tokenBalance(address: PublicKey): Promise<bigint> {
    return BigInt(
      (
        await this.options.connection.getTokenAccountBalance(
          address,
          "confirmed"
        )
      ).value.amount
    );
  }

  async getChainUnixTime(minimumSlot?: number): Promise<number> {
    const fenced =
      minimumSlot === undefined
        ? null
        : await this.options.connection.getAccountInfoAndContext(
            SYSVAR_CLOCK_PUBKEY,
            { commitment: "confirmed", minContextSlot: minimumSlot }
          );
    if (fenced && fenced.context.slot < minimumSlot!)
      throw new Error("RPC clock evidence is older than the recovery fence");
    const clock = fenced
      ? fenced.value
      : await this.options.connection.getAccountInfo(
          SYSVAR_CLOCK_PUBKEY,
          "confirmed"
        );
    if (!clock || clock.data.length < 40)
      throw new Error("Solana Clock sysvar is unavailable or malformed");
    const unixTimestamp = clock.data.readBigInt64LE(32);
    const result = Number(unixTimestamp);
    if (!Number.isSafeInteger(result))
      throw new RangeError("Solana Clock unix_timestamp is outside safe range");
    return result;
  }

  async initializeTaskWithMemo(input: InitializeTaskInput): Promise<string> {
    const signature = await this.sendRebuilt(
      async () => {
        const initialize = await (this.program.methods as any)
          .initializeTask(
            new BN(input.taskId.toString()),
            new BN(input.amount.toString()),
            new BN(input.timeoutSeconds),
            input.isPrivate
          )
          .accounts({
            buyer: this.options.buyer.publicKey,
            seller: input.seller,
            verifier: input.verifier,
            mint: input.mint,
            taskState: input.taskState,
            vault: input.vault,
            buyerTokenAccount: input.buyerTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction();
        const memo = new TransactionInstruction({
          programId: this.memoProgram,
          keys: [],
          data: Buffer.from(encodeManifestMemo(input.manifestHash), "utf8"),
        });
        return [initialize, memo];
      },
      this.options.buyer,
      [this.options.buyer],
      {
        kind: "funding",
        taskState: input.taskState,
        expected: {
          buyer: this.buyer.toBase58(),
          seller: input.seller.toBase58(),
          verifier: input.verifier.toBase58(),
          mint: input.mint.toBase58(),
          taskId: input.taskId,
          amount: input.amount,
          isPrivate: input.isPrivate,
        },
      },
      input.onSigned
    );
    await this.verifyManifestMemo(signature, input.manifestHash);
    return signature;
  }

  async settlePublic(
    taskState: PublicKey,
    vault: PublicKey,
    sellerTokenAccount: PublicKey
  ): Promise<string> {
    await this.requireTreasuryMint(taskState);
    return this.sendRebuilt(
      async () => [
        await (this.program.methods as any)
          .settleTask()
          .accounts({
            taskState,
            verifier: this.options.verifier.publicKey,
            vault,
            sellerTokenAccount,
            protocolTreasury: this.options.protocolTreasury,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ],
      this.options.verifier,
      [this.options.verifier],
      { kind: "settlement", taskState }
    );
  }

  async settlePrivate(
    taskState: PublicKey,
    vault: PublicKey,
    sellerTokenAccount: PublicKey,
    nullifier: Uint8Array
  ): Promise<string> {
    await this.requireTreasuryMint(taskState);
    const [nullifierRecord] = deriveNullifierPda(
      this.options.programId,
      nullifier
    );
    return this.sendRebuilt(
      async () => [
        await (this.program.methods as any)
          .settleTaskPrivate(Array.from(nullifier))
          .accounts({
            taskState,
            verifier: this.options.verifier.publicKey,
            nullifierRecord,
            vault,
            sellerTokenAccount,
            protocolTreasury: this.options.protocolTreasury,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      ],
      this.options.verifier,
      [this.options.verifier],
      { kind: "settlement", taskState, nullifier }
    );
  }

  async refund(
    taskState: PublicKey,
    vault: PublicKey,
    buyerTokenAccount: PublicKey
  ): Promise<string> {
    return this.sendRebuilt(
      () => this.refundInstructions(taskState, vault, buyerTokenAccount),
      this.options.buyer,
      [this.options.buyer],
      { kind: "refund", taskState },
      undefined,
      undefined,
      1
    );
  }

  private async refundInstructions(
    taskState: PublicKey,
    vault: PublicKey,
    buyerTokenAccount: PublicKey
  ): Promise<TransactionInstruction[]> {
    return [
      await (this.program.methods as any)
        .refundTask()
        .accounts({
          taskState,
          buyer: this.buyer,
          vault,
          buyerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
    ];
  }

  async refundOperation(
    quote: TaskQuote
  ): Promise<FinancialRecoveryRequest["operation"]> {
    const taskState = new PublicKey(quote.taskStatePda);
    const vault = new PublicKey(quote.vaultPda);
    const buyerAta = await this.requireBuyerAta(new PublicKey(quote.mint));
    const instructions = await this.refundInstructions(
      taskState,
      vault,
      buyerAta
    );
    return {
      programId: this.options.programId.toBase58(),
      taskState: quote.taskStatePda,
      kind: "refund",
      binding: this.instructionFingerprint(instructions),
    };
  }

  async refundState(quote: TaskQuote): Promise<{
    state: TaskStateView | null;
    slot: number;
    clockUnix: number;
  }> {
    const { state, slot } = await this.fetchTaskEvidence(
      new PublicKey(quote.taskStatePda)
    );
    return { state, slot, clockUnix: await this.getChainUnixTime(slot) };
  }

  async retryRefund(
    quote: TaskQuote,
    proveSafe: (signature: string) => Promise<boolean>
  ): Promise<string> {
    const taskState = new PublicKey(quote.taskStatePda);
    const vault = new PublicKey(quote.vaultPda);
    const buyerAta = await this.requireBuyerAta(new PublicKey(quote.mint));
    return this.sendRebuilt(
      () => this.refundInstructions(taskState, vault, buyerAta),
      this.options.buyer,
      [this.options.buyer],
      { kind: "refund", taskState },
      undefined,
      proveSafe,
      1
    );
  }

  async cancel(
    taskState: PublicKey,
    vault: PublicKey,
    buyerTokenAccount: PublicKey
  ): Promise<string> {
    await this.requireTreasuryMint(taskState);
    return this.sendRebuilt(
      async () => [
        await (this.program.methods as any)
          .cancelTask()
          .accounts({
            taskState,
            buyer: this.buyer,
            vault,
            buyerTokenAccount,
            protocolTreasury: this.options.protocolTreasury,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ],
      this.options.buyer,
      [this.options.buyer],
      { kind: "cancel", taskState }
    );
  }

  async confirmSignature(signature: string): Promise<boolean> {
    try {
      const { value } = await this.options.connection.getSignatureStatus(
        signature,
        { searchTransactionHistory: true }
      );
      return (
        value !== null &&
        value.err === null &&
        (value.confirmationStatus === "confirmed" ||
          value.confirmationStatus === "finalized")
      );
    } catch {
      return false;
    }
  }

  async verifyManifestMemo(
    signature: string,
    expectedHash: string
  ): Promise<void> {
    const transaction = await this.options.connection.getParsedTransaction(
      signature,
      {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }
    );
    if (!transaction)
      throw new ManifestMismatch("initialize transaction is unavailable");
    if (!transaction.meta || transaction.meta.err !== null)
      throw new ManifestMismatch("initialize transaction did not succeed");
    const memos: string[] = [];
    for (const instruction of transaction.transaction.message.instructions) {
      if (!instruction.programId.equals(this.memoProgram)) continue;
      if ("parsed" in instruction) {
        const parsed = instruction.parsed;
        if (typeof parsed === "string") memos.push(parsed);
        else if (
          parsed &&
          typeof parsed === "object" &&
          "memo" in parsed &&
          typeof parsed.memo === "string"
        )
          memos.push(parsed.memo);
      } else if ("data" in instruction) {
        memos.push(Buffer.from(bs58.decode(instruction.data)).toString("utf8"));
      }
    }
    if (!memos.includes(encodeManifestMemo(expectedHash))) {
      throw new ManifestMismatch(
        "initialize transaction does not contain the expected manifest memo"
      );
    }
  }

  private async requireTreasuryMint(taskState: PublicKey): Promise<void> {
    const state = await this.fetchTaskState(taskState);
    if (!state) throw new Error("TaskState does not exist");
    const treasury = await getAccount(
      this.options.connection,
      this.options.protocolTreasury,
      "confirmed"
    );
    if (!treasury.mint.equals(new PublicKey(state.mint)))
      throw new Error("protocol treasury token account mint mismatch");
  }

  private async sendRebuilt(
    buildInstructions: () => Promise<TransactionInstruction[]>,
    payer: Keypair,
    signers: Signer[],
    operation: {
      kind: "funding" | "settlement" | "refund" | "cancel";
      taskState: PublicKey;
      nullifier?: Uint8Array;
      expected?: Partial<TaskStateView>;
    },
    onSigned?: (signature: string) => void,
    retryProof?: (signature: string) => Promise<boolean>,
    maxAttempts = this.maxSendAttempts
  ): Promise<string> {
    const instructions = await buildInstructions();
    const binding = this.instructionFingerprint(instructions);
    const identity = {
      programId: this.options.programId.toBase58(),
      taskState: operation.taskState.toBase58(),
      kind: operation.kind,
      binding,
    };
    const account = async (minimumSlot?: number) => {
      const { state, slot } = await this.fetchTaskEvidence(
        operation.taskState,
        minimumSlot
      );
      const now = state ? await this.getChainUnixTime(minimumSlot) : 0;
      const completed =
        operation.kind === "funding"
          ? !!state &&
            Object.entries(operation.expected ?? {}).every(
              ([key, value]) => state[key as keyof TaskStateView] === value
            )
          : operation.kind === "settlement"
          ? state?.status === "settled" &&
            (!operation.nullifier ||
              !!(await this.fetchNullifierRecord(operation.nullifier)))
          : state?.status === "refunded";
      const permits =
        operation.kind === "funding"
          ? !state
          : state?.status === "pending" &&
            (operation.kind === "refund"
              ? now >= state.deadlineUnix
              : now < state.deadlineUnix);
      return { completed, permits, state, slot };
    };
    const send = (persist: (value: PreparedTransaction) => void) =>
      sendRebuiltTransaction({
        connection: this.options.connection,
        buildInstructions: async () => instructions,
        payer,
        signers,
        maxAttempts,
        onPrepared: persist,
        canRebuild: async (minimumSlot) => (await account(minimumSlot)).permits,
        ...(onSigned ? { onSigned } : {}),
      });
    return retryProof
      ? this.financial.retryRefund(identity, account, retryProof, send)
      : this.financial.run(identity, this.options.connection, account, send);
  }

  private instructionFingerprint(
    instructions: TransactionInstruction[]
  ): string {
    return hashCanonical(
      instructions.map((instruction) => ({
        program: instruction.programId.toBase58(),
        accounts: instruction.keys.map((key) => ({
          pubkey: key.pubkey.toBase58(),
          signer: key.isSigner,
          writable: key.isWritable,
        })),
        data: instruction.data.toString("hex"),
      }))
    );
  }
}
