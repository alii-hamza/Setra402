import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { VerificationFailed } from "../../src/errors.js";
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

function harness(outputHash: string) {
  const calls: string[] = [];
  const transport: SetraTransport = {
    async requestQuote() {
      calls.push("quote");
      return quote;
    },
    async executeFundedTask(context) {
      calls.push("execute");
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
    async settle() {
      calls.push("settle");
      return {
        signature: "settled",
        state: { ...state, status: "settled" as const },
      };
    },
  };
  return {
    orchestrator: new BuyerOrchestrator(transport, funding, settlement),
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
});
