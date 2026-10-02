import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { TaskExpired } from "../../src/errors.js";
import { hashCanonical } from "../../src/manifest/hash.js";
import { BuyerOrchestrator } from "../../src/orchestrator.js";
import type { StoredManifest } from "../../src/manifest/store.js";
import type { SetraTransport } from "../../src/transport/types.js";
import type {
  ResultEnvelopeV1,
  TaskQuote,
  TaskStateView,
  VerificationReport,
} from "../../src/types.js";

const policy = {
  version: "1",
  level: 1,
  checks: [{ type: "json_schema", schema_ref: "generic-object-v1" }],
} as const;

const quote: TaskQuote = {
  taskId: 9n,
  serviceId: "legacy-rest",
  programId: Keypair.generate().publicKey.toBase58(),
  taskStatePda: Keypair.generate().publicKey.toBase58(),
  vaultPda: Keypair.generate().publicKey.toBase58(),
  mint: Keypair.generate().publicKey.toBase58(),
  sellerTokenAccount: Keypair.generate().publicKey.toBase58(),
  verifier: Keypair.generate().publicKey.toBase58(),
  amount: 1n,
  timeoutSeconds: 60,
  isPrivate: false,
  protocolFeeBps: 100,
  verificationPolicy: policy,
  policyHash: hashCanonical(policy),
  raw: {} as TaskQuote["raw"],
};
const state: TaskStateView = {
  buyer: Keypair.generate().publicKey.toBase58(),
  seller: Keypair.generate().publicKey.toBase58(),
  verifier: quote.verifier,
  mint: quote.mint,
  taskId: 9n,
  amount: 1n,
  deadlineUnix: 9999999999,
  status: "pending",
  isPrivate: false,
  bump: 1,
};
const manifest = {
  version: "1" as const,
  taskId: "9",
  serviceId: "legacy-rest",
  buyer: state.buyer,
  sellerTokenAccount: quote.sellerTokenAccount,
  sellerOwner: state.seller,
  verifier: quote.verifier,
  mint: quote.mint,
  amountBaseUnits: "1",
  timeoutSeconds: 60,
  isPrivate: false,
  taskSpecHash: "11".repeat(32),
  policyHash: quote.policyHash,
  quoteHash: "33".repeat(32),
};
const record: StoredManifest = {
  manifest,
  manifestHash: hashCanonical(manifest),
  initializeSignature: "init",
};

function harness(
  options: { expired?: boolean; isPrivate?: boolean; passed?: boolean } = {}
) {
  const calls: string[] = [];
  const effectiveQuote = { ...quote, isPrivate: options.isPrivate ?? false };
  const transport: SetraTransport = {
    async requestQuote() {
      calls.push("quote");
      return effectiveQuote;
    },
    async executeFundedTask(context) {
      calls.push("execute");
      if (options.expired) throw new TaskExpired("expired");
      const envelope: ResultEnvelopeV1 = {
        version: "1",
        taskId: context.taskId.toString(),
        serviceId: "legacy-rest",
        result: context.input,
        resultHash: hashCanonical(context.input),
        evidence: [],
        completedAtUnix: 100,
        input: context.input,
        output_hash: hashCanonical(context.input),
      };
      return envelope;
    },
  };
  const funding = {
    async ensureFunded() {
      calls.push("fund");
      return { state, record, initializeSignature: "init" };
    },
  };
  const settlement = {
    async settle(
      _quote: TaskQuote,
      _record: StoredManifest,
      settlementOptions: { report: VerificationReport; nullifier?: Uint8Array }
    ) {
      calls.push("settle");
      if (options.isPrivate)
        expect(settlementOptions?.nullifier).toEqual(
          new Uint8Array(32).fill(7)
        );
      return {
        signature: "settled",
        state: { ...state, status: "settled" as const },
      };
    },
    async refundExpired() {
      calls.push("refund");
      return "refund-signature";
    },
  };
  const privateTasks = {
    async createVoucher() {
      calls.push("voucher");
      return { nullifier: new Uint8Array(32).fill(7) };
    },
  };
  const verification = {
    async verify() {
      calls.push("verify");
      return {
        taskId: quote.taskId.toString(),
        serviceId: quote.serviceId,
        level: 1 as const,
        manifestHash: record.manifestHash,
        policyHash: quote.policyHash,
        resultHash: "44".repeat(32),
        checks: [
          {
            type: "json_schema",
            passed: options.passed ?? true,
            message: "fixture",
          },
        ],
        passed: options.passed ?? true,
        verifierPubkey: quote.verifier,
        startedAtUnix: 100,
        completedAtUnix: 100,
      };
    },
  };
  return {
    orchestrator: new BuyerOrchestrator(
      transport,
      funding,
      settlement,
      verification,
      privateTasks
    ),
    calls,
  };
}

describe("policy-driven public/private compatibility orchestration", () => {
  it("funds, verifies the policy, then settles", async () => {
    const input = { job: "baseline" };
    const { orchestrator, calls } = harness();
    const result = await orchestrator.runLegacy({
      taskId: 9n,
      buyer: state.buyer,
      input,
      isPrivate: false,
      serviceId: "legacy-rest",
      policyHash: quote.policyHash,
    });
    expect(result.status).toBe("settled");
    if (result.status !== "settled") throw new Error("expected settlement");
    expect(result.settlement.signature).toBe("settled");
    expect(calls).toEqual(["quote", "fund", "execute", "verify", "settle"]);
  });

  it("returns verification_failed and never settles on a failed report", async () => {
    const { orchestrator, calls } = harness({ passed: false });
    const result = await orchestrator.runLegacy({
      taskId: 9n,
      buyer: state.buyer,
      input: { job: "baseline" },
      isPrivate: false,
      serviceId: "legacy-rest",
      policyHash: quote.policyHash,
    });
    expect(result.status).toBe("verification_failed");
    expect(calls.includes("settle")).toBe(false);
  });

  it("enters the refund path on HTTP 410 and never settles", async () => {
    const input = { job: "expired" };
    const { orchestrator, calls } = harness({
      expired: true,
    });
    const result = await orchestrator.runLegacy({
      taskId: 9n,
      buyer: state.buyer,
      input,
      isPrivate: false,
      serviceId: "legacy-rest",
      policyHash: quote.policyHash,
    });
    expect(result.status).toBe("refunded");
    expect(calls).toEqual(["quote", "fund", "execute", "refund"]);
  });

  it("requires and verifies a blind voucher before private settlement", async () => {
    const input = { job: "private" };
    const { orchestrator, calls } = harness({
      isPrivate: true,
    });
    const result = await orchestrator.runLegacy({
      taskId: 9n,
      buyer: state.buyer,
      input,
      isPrivate: true,
      serviceId: "legacy-rest",
      policyHash: quote.policyHash,
    });
    expect(result.status).toBe("settled");
    expect(calls).toEqual([
      "quote",
      "fund",
      "execute",
      "verify",
      "voucher",
      "settle",
    ]);
  });
});
