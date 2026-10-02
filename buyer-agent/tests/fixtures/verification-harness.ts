import { Keypair } from "@solana/web3.js";
import {
  SettlementCoordinator,
  type SettlementChain,
} from "../../src/chain/settlement-coordinator.js";
import { hashCanonical } from "../../src/manifest/hash.js";
import type { StoredManifest } from "../../src/manifest/store.js";
import type {
  ResultEnvelopeV1,
  TaskQuote,
  TaskStateView,
  VerificationPolicyV1,
} from "../../src/types.js";
import {
  VerificationEngine,
  type VerificationContext,
} from "../../src/verification/engine.js";

// Simulation boundary: only the chain reader/signer is fake; the engine and
// SettlementCoordinator are the production implementations.
export function verificationHarness(
  policy: VerificationPolicyV1,
  value: unknown
) {
  const buyer = Keypair.generate().publicKey,
    verifier = Keypair.generate().publicKey;
  const seller = Keypair.generate().publicKey,
    mint = Keypair.generate().publicKey;
  const quote: TaskQuote = {
    taskId: 99n,
    serviceId: "fixture-service",
    programId: Keypair.generate().publicKey.toBase58(),
    taskStatePda: Keypair.generate().publicKey.toBase58(),
    vaultPda: Keypair.generate().publicKey.toBase58(),
    mint: mint.toBase58(),
    sellerTokenAccount: Keypair.generate().publicKey.toBase58(),
    verifier: verifier.toBase58(),
    amount: 10n,
    timeoutSeconds: 60,
    isPrivate: false,
    protocolFeeBps: 100,
    verificationPolicy: policy,
    policyHash: hashCanonical(policy),
    raw: {} as TaskQuote["raw"],
  };
  const manifest = {
    version: "1" as const,
    taskId: "99",
    serviceId: quote.serviceId,
    buyer: buyer.toBase58(),
    sellerTokenAccount: quote.sellerTokenAccount,
    sellerOwner: seller.toBase58(),
    verifier: quote.verifier,
    mint: quote.mint,
    amountBaseUnits: "10",
    timeoutSeconds: 60,
    isPrivate: false,
    taskSpecHash: hashCanonical(value),
    policyHash: quote.policyHash,
    quoteHash: hashCanonical(quote.raw),
  };
  const record: StoredManifest = {
    manifest,
    manifestHash: hashCanonical(manifest),
    initializeSignature: "init",
  };
  const result: ResultEnvelopeV1 = {
    version: "1",
    taskId: "99",
    serviceId: quote.serviceId,
    result: value,
    resultHash: hashCanonical(value),
    evidence: [],
    completedAtUnix: 50,
    input: value,
    output_hash: hashCanonical(value),
  };
  let state: TaskStateView = {
    buyer: buyer.toBase58(),
    seller: seller.toBase58(),
    verifier: verifier.toBase58(),
    mint: mint.toBase58(),
    taskId: quote.taskId,
    amount: quote.amount,
    deadlineUnix: 100,
    status: "pending",
    isPrivate: false,
    bump: 1,
  };
  const calls: string[] = [];
  const chain: SettlementChain = {
    buyer,
    verifier,
    async fetchTaskState() {
      calls.push("fetch");
      return state;
    },
    async getChainUnixTime() {
      return 50;
    },
    async verifyManifestMemo() {
      calls.push("memo");
    },
    async settlePublic() {
      calls.push("settle");
      state = { ...state, status: "settled" };
      return "settled";
    },
    async settlePrivate() {
      throw new Error("not used");
    },
    async fetchNullifierRecord() {
      return null;
    },
    async requireBuyerAta() {
      return buyer;
    },
    async refund() {
      calls.push("refund");
      state = { ...state, status: "refunded" };
      return "refunded";
    },
    async cancel() {
      calls.push("cancel");
      throw new Error("must never cancel");
    },
  };
  const context: VerificationContext = {
    committedManifestHash: record.manifestHash,
    verifierPubkey: quote.verifier,
    nowUnix: 50,
    schemas: new Map(),
    async verifyManifestCommitment() {},
    async loadArtifact() {
      return null;
    },
    solana: {
      async getAccount() {
        return null;
      },
      async getTransaction() {
        return null;
      },
    },
  };
  return {
    quote,
    manifest,
    record,
    result,
    context,
    chain,
    calls,
    current: () => state,
    settlement: new SettlementCoordinator(chain, 1),
    engine: new VerificationEngine(),
  };
}
