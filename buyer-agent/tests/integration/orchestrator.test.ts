import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { TaskExpired, VerificationFailed } from "../../src/errors.js";
import { hashCanonical } from "../../src/manifest/hash.js";
import { BuyerOrchestrator } from "../../src/orchestrator.js";
import type { StoredManifest } from "../../src/manifest/store.js";
import type { SetraTransport } from "../../src/transport/types.js";
import type { TaskQuote, TaskStateView } from "../../src/types.js";

const quote: TaskQuote = {
  taskId: 9n,
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
  policyHash: "22".repeat(32),
  quoteHash: "33".repeat(32),
};
const record: StoredManifest = {
  manifest,
  manifestHash: hashCanonical(manifest),
  initializeSignature: "init",
};

function harness(
  outputHash: string,
  options: { expired?: boolean; isPrivate?: boolean } = {}
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
      return { input: context.input, output_hash: outputHash };
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
      settlementOptions?: { nullifier?: Uint8Array }
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
  return {
    orchestrator: new BuyerOrchestrator(
      transport,
      funding,
      settlement,
      privateTasks
    ),
    calls,
  };
}

describe("legacy public/private compatibility orchestration", () => {
  it("funds, retries seller execution, verifies the legacy hash, then settles", async () => {
    const input = { job: "baseline" };
    const { orchestrator, calls } = harness(hashCanonical(input));
    const result = await orchestrator.runLegacy({
      taskId: 9n,
      buyer: state.buyer,
      input,
      isPrivate: false,
      serviceId: "legacy-rest",
      policyHash: "22".repeat(32),
    });
    expect(result.status).toBe("settled");
    if (result.status !== "settled") throw new Error("expected settlement");
    expect(result.settlement.signature).toBe("settled");
    expect(calls).toEqual(["quote", "fund", "execute", "settle"]);
  });

  it("never settles a mismatched legacy result", async () => {
    const { orchestrator, calls } = harness("ff".repeat(32));
    await expect(
      orchestrator.runLegacy({
        taskId: 9n,
        buyer: state.buyer,
        input: { job: "baseline" },
        isPrivate: false,
        serviceId: "legacy-rest",
        policyHash: "22".repeat(32),
      })
    ).rejects.toBeInstanceOf(VerificationFailed);
    expect(calls.includes("settle")).toBe(false);
  });

  it("enters the refund path on HTTP 410 and never settles", async () => {
    const input = { job: "expired" };
    const { orchestrator, calls } = harness(hashCanonical(input), {
      expired: true,
    });
    const result = await orchestrator.runLegacy({
      taskId: 9n,
      buyer: state.buyer,
      input,
      isPrivate: false,
      serviceId: "legacy-rest",
      policyHash: "22".repeat(32),
    });
    expect(result.status).toBe("refunded");
    expect(calls).toEqual(["quote", "fund", "execute", "refund"]);
  });

  it("requires and verifies a blind voucher before private settlement", async () => {
    const input = { job: "private" };
    const { orchestrator, calls } = harness(hashCanonical(input), {
      isPrivate: true,
    });
    const result = await orchestrator.runLegacy({
      taskId: 9n,
      buyer: state.buyer,
      input,
      isPrivate: true,
      serviceId: "legacy-rest",
      policyHash: "22".repeat(32),
    });
    expect(result.status).toBe("settled");
    expect(calls).toEqual(["quote", "fund", "execute", "voucher", "settle"]);
  });
});
