import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  SettlementCoordinator,
  type SettlementChain,
} from "../../src/chain/settlement-coordinator.js";
import { TaskConflict, VerificationFailed } from "../../src/errors.js";
import { hashCanonical } from "../../src/manifest/hash.js";
import type { StoredManifest } from "../../src/manifest/store.js";
import type {
  ResultEnvelopeV1,
  TaskQuote,
  TaskStateView,
  VerificationPolicyV1,
} from "../../src/types.js";
import { VerificationEngine } from "../../src/verification/engine.js";

const buyer = Keypair.generate().publicKey;
const verifier = Keypair.generate().publicKey;
const seller = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const taskState = Keypair.generate().publicKey;
const vault = Keypair.generate().publicKey;
const sellerToken = Keypair.generate().publicKey;
const buyerAta = Keypair.generate().publicKey;

const policy: VerificationPolicyV1 = {
  version: "1",
  level: 1,
  checks: [
    { type: "record_count", pointer: "/records", min: 2 },
    { type: "required_fields", pointer: "/records", fields: ["id"] },
    { type: "unique", pointer: "/records", field: "id" },
  ],
};
const quote: TaskQuote = {
  taskId: 88n,
  serviceId: "lead-scraper-demo",
  programId: Keypair.generate().publicKey.toBase58(),
  taskStatePda: taskState.toBase58(),
  vaultPda: vault.toBase58(),
  mint: mint.toBase58(),
  sellerTokenAccount: sellerToken.toBase58(),
  verifier: verifier.toBase58(),
  amount: 10n,
  timeoutSeconds: 50,
  isPrivate: false,
  protocolFeeBps: 100,
  verificationPolicy: policy,
  policyHash: hashCanonical(policy),
  raw: {} as TaskQuote["raw"],
};
const manifest = {
  version: "1" as const,
  taskId: quote.taskId.toString(),
  serviceId: quote.serviceId,
  buyer: buyer.toBase58(),
  sellerTokenAccount: sellerToken.toBase58(),
  sellerOwner: seller.toBase58(),
  verifier: verifier.toBase58(),
  mint: mint.toBase58(),
  amountBaseUnits: quote.amount.toString(),
  timeoutSeconds: quote.timeoutSeconds,
  isPrivate: false,
  taskSpecHash: "11".repeat(32),
  policyHash: quote.policyHash,
  quoteHash: hashCanonical(quote.raw),
};
const record: StoredManifest = {
  manifest,
  manifestHash: hashCanonical(manifest),
  initializeSignature: "init-signature",
};

function envelope(value: unknown): ResultEnvelopeV1 {
  return {
    version: "1",
    taskId: quote.taskId.toString(),
    serviceId: quote.serviceId,
    result: value,
    resultHash: hashCanonical(value),
    evidence: [],
    completedAtUnix: 50,
    input: value,
    output_hash: hashCanonical(value),
  };
}

function settlementHarness() {
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
      return buyerAta;
    },
    async refund() {
      calls.push("refund");
      state = { ...state, status: "refunded" };
      return "refunded";
    },
    async cancel() {
      throw new Error("verification failure must never cancel");
    },
  };
  return { chain, calls, current: () => state };
}

async function verify(
  candidateManifest = manifest,
  candidatePolicy: VerificationPolicyV1 = policy,
  candidateResult = envelope({ records: [{ id: "a" }, { id: "b" }] })
) {
  return new VerificationEngine().verify(
    candidateManifest,
    candidatePolicy,
    candidateResult,
    {
      committedManifestHash: record.manifestHash,
      verifierPubkey: verifier.toBase58(),
      nowUnix: 50,
      schemas: new Map(),
      async verifyManifestCommitment() {},
      async loadArtifact() {
        return null;
      },
      solana: {
        async getTransaction() {
          return null;
        },
        async getAccount() {
          return null;
        },
      },
    }
  );
}

describe("Level-1 verification to settlement integration", () => {
  it("settles only after a real engine report passes", async () => {
    const report = await verify();
    expect(report.passed).toBe(true);
    const harness = settlementHarness();
    await new SettlementCoordinator(harness.chain, 5).settle(quote, record, {
      report,
      nowUnix: 50,
    });
    expect(harness.current().status).toBe("settled");
    expect(harness.calls).toContain("settle");
  });

  it("matching legacy output_hash cannot override policy failure; refund waits for deadline", async () => {
    const failedResult = envelope({ records: [{ id: "only-one" }] });
    expect(failedResult.output_hash).toBe(hashCanonical(failedResult.input));
    const report = await verify(manifest, policy, failedResult);
    expect(report.passed).toBe(false);
    const harness = settlementHarness();
    const coordinator = new SettlementCoordinator(harness.chain, 5);
    await expect(
      coordinator.settle(quote, record, { report, nowUnix: 50 })
    ).rejects.toBeInstanceOf(VerificationFailed);
    expect(harness.calls).not.toContain("settle");
    await expect(coordinator.refundExpired(quote, 99)).rejects.toBeInstanceOf(
      TaskConflict
    );
    await expect(coordinator.refundExpired(quote, 100)).resolves.toBe(
      "refunded"
    );
    expect(harness.calls).not.toContain("cancel");
  });

  it("fails closed on result, policy, and manifest tampering", async () => {
    const valid = envelope({ records: [{ id: "a" }, { id: "b" }] });
    const tamperedResult = { ...valid, resultHash: "ff".repeat(32) };
    const tamperedPolicy: VerificationPolicyV1 = {
      ...policy,
      checks: [{ type: "record_count", pointer: "/records", min: 3 }],
    };
    const tamperedManifest = { ...manifest, taskSpecHash: "ff".repeat(32) };
    expect((await verify(manifest, policy, tamperedResult)).passed).toBe(false);
    expect((await verify(manifest, tamperedPolicy, valid)).passed).toBe(false);
    expect((await verify(tamperedManifest, policy, valid)).passed).toBe(false);
  });
});
