import { PublicKey } from "@solana/web3.js";
import { InvalidQuote } from "../errors.js";
import { hashCanonical } from "../manifest/hash.js";
import type { ManifestStore, StoredManifest } from "../manifest/store.js";
import type { TaskManifestV1, TaskQuote, TaskStateView } from "../types.js";

export interface InitializeTaskInput {
  taskId: bigint;
  amount: bigint;
  timeoutSeconds: number;
  isPrivate: boolean;
  seller: PublicKey;
  verifier: PublicKey;
  mint: PublicKey;
  taskState: PublicKey;
  vault: PublicKey;
  buyerTokenAccount: PublicKey;
  manifestHash: string;
}

export interface EscrowChain {
  buyer: PublicKey;
  fetchTaskState(address: PublicKey): Promise<TaskStateView | null>;
  resolveTokenAccountOwner(
    address: PublicKey,
    expectedMint?: PublicKey
  ): Promise<PublicKey>;
  requireBuyerAta(mint: PublicKey): Promise<PublicKey>;
  tokenBalance(address: PublicKey): Promise<bigint>;
  initializeTaskWithMemo(input: InitializeTaskInput): Promise<string>;
}

export interface EnsureFundedInput {
  quote: TaskQuote;
  serviceId: string;
  input: unknown;
  policyHash: string;
}

export interface FundedEscrow {
  state: TaskStateView;
  record: StoredManifest;
  initializeSignature: string | null;
}

function assertHexHash(name: string, value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value))
    throw new InvalidQuote(`${name} must be 32-byte lowercase hex`);
}

function assertFundedState(
  state: TaskStateView,
  quote: TaskQuote,
  buyer: PublicKey,
  seller: PublicKey
): void {
  const expected = {
    buyer: buyer.toBase58(),
    seller: seller.toBase58(),
    verifier: quote.verifier,
    mint: quote.mint,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (state[field as keyof TaskStateView] !== value)
      throw new InvalidQuote(`funded TaskState ${field} mismatch`);
  }
  if (state.taskId !== quote.taskId)
    throw new InvalidQuote("funded TaskState taskId mismatch");
  if (state.amount !== quote.amount)
    throw new InvalidQuote("funded TaskState amount mismatch");
  if (state.isPrivate !== quote.isPrivate)
    throw new InvalidQuote("funded TaskState privacy mismatch");
  if (state.status !== "pending")
    throw new InvalidQuote(`funded TaskState is ${state.status}, not pending`);
}

export class EscrowCoordinator {
  constructor(
    private readonly chain: EscrowChain,
    private readonly manifests: ManifestStore
  ) {}

  async ensureFunded(input: EnsureFundedInput): Promise<FundedEscrow> {
    assertHexHash("policyHash", input.policyHash);
    const quote = input.quote;
    const taskState = new PublicKey(quote.taskStatePda);
    const sellerTokenAccount = new PublicKey(quote.sellerTokenAccount);
    const existing = await this.chain.fetchTaskState(taskState);
    const sellerOwner = await this.chain.resolveTokenAccountOwner(
      sellerTokenAccount,
      new PublicKey(quote.mint)
    );
    if (existing) {
      assertFundedState(existing, quote, this.chain.buyer, sellerOwner);
      const record = this.manifests.load(quote.taskStatePda);
      if (!record)
        throw new InvalidQuote(
          "task is funded but its local manifest record is missing"
        );
      return {
        state: existing,
        record,
        initializeSignature: record.initializeSignature,
      };
    }

    const buyerTokenAccount = await this.chain.requireBuyerAta(
      new PublicKey(quote.mint)
    );
    const balance = await this.chain.tokenBalance(buyerTokenAccount);
    if (balance < quote.amount)
      throw new InvalidQuote("buyer ATA balance is below quoted amount");

    const manifest: TaskManifestV1 = {
      version: "1",
      taskId: quote.taskId.toString(),
      serviceId: input.serviceId,
      buyer: this.chain.buyer.toBase58(),
      sellerTokenAccount: quote.sellerTokenAccount,
      sellerOwner: sellerOwner.toBase58(),
      verifier: quote.verifier,
      mint: quote.mint,
      amountBaseUnits: quote.amount.toString(),
      timeoutSeconds: quote.timeoutSeconds,
      isPrivate: quote.isPrivate,
      taskSpecHash: hashCanonical(input.input),
      policyHash: input.policyHash,
      quoteHash: hashCanonical(quote.raw),
    };
    const manifestHash = hashCanonical(manifest);
    let record: StoredManifest = {
      manifest,
      manifestHash,
      initializeSignature: null,
    };
    this.manifests.save(quote.taskStatePda, record);

    let initializeSignature: string | null = null;
    try {
      initializeSignature = await this.chain.initializeTaskWithMemo({
        taskId: quote.taskId,
        amount: quote.amount,
        timeoutSeconds: quote.timeoutSeconds,
        isPrivate: quote.isPrivate,
        seller: sellerOwner,
        verifier: new PublicKey(quote.verifier),
        mint: new PublicKey(quote.mint),
        taskState,
        vault: new PublicKey(quote.vaultPda),
        buyerTokenAccount,
        manifestHash,
      });
    } catch (error) {
      const recovered = await this.chain.fetchTaskState(taskState);
      if (!recovered) throw error;
      assertFundedState(recovered, quote, this.chain.buyer, sellerOwner);
      return { state: recovered, record, initializeSignature: null };
    }

    const funded = await this.chain.fetchTaskState(taskState);
    if (!funded)
      throw new InvalidQuote(
        "initialize_task confirmed but TaskState is missing"
      );
    assertFundedState(funded, quote, this.chain.buyer, sellerOwner);
    record = { ...record, initializeSignature };
    this.manifests.save(quote.taskStatePda, record);
    return { state: funded, record, initializeSignature };
  }
}
