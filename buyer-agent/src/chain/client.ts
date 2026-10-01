import { Program, AnchorProvider, Wallet, type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import bs58 from "bs58";
import { getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
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
import type { TaskStateView, TaskStatus } from "../types.js";
import { encodeManifestMemo, MEMO_PROGRAM_ID } from "./memo.js";
import { deriveBuyerAta, deriveNullifierPda } from "./pda.js";
import type { EscrowChain, InitializeTaskInput } from "./escrow.js";

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
}

export interface SendRebuiltTransactionOptions {
  connection: Connection;
  buildInstructions: () => Promise<TransactionInstruction[]>;
  payer: Keypair;
  signers: Signer[];
  maxAttempts: number;
  onSigned?: (signature: string) => void;
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
        if (status.value?.err === null) return signature;
        knownFailure = status.value !== null;
      } catch {
        // The signature remains usable for state-based ambiguity recovery.
      }
      lastError = error;
      if (knownFailure) break;
      if (staleBlockhash(error) && attempt < options.maxAttempts) continue;
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

  constructor(private readonly options: ChainClientOptions) {
    this.buyer = options.buyer.publicKey;
    this.verifier = options.verifier.publicKey;
    this.maxSendAttempts = options.maxSendAttempts ?? 2;
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
    const account = await (this.program.account as any).taskState.fetchNullable(
      address
    );
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

  async getChainUnixTime(): Promise<number> {
    const clock = await this.options.connection.getAccountInfo(
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
    return this.sendRebuilt(
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
      input.onSigned
    );
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
      [this.options.verifier]
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
      [this.options.verifier]
    );
  }

  async refund(
    taskState: PublicKey,
    vault: PublicKey,
    buyerTokenAccount: PublicKey
  ): Promise<string> {
    return this.sendRebuilt(
      async () => [
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
      ],
      this.options.buyer,
      [this.options.buyer]
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
      [this.options.buyer]
    );
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
    onSigned?: (signature: string) => void
  ): Promise<string> {
    return sendRebuiltTransaction({
      connection: this.options.connection,
      buildInstructions,
      payer,
      signers,
      maxAttempts: this.maxSendAttempts,
      ...(onSigned ? { onSigned } : {}),
    });
  }
}
