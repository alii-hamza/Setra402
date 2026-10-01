import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { Idl } from "@coral-xyz/anchor";
import { ChainClient } from "../../src/chain/client.js";
import { EscrowCoordinator } from "../../src/chain/escrow.js";
import { SettlementCoordinator } from "../../src/chain/settlement-coordinator.js";
import { loadKeypair } from "../../src/config.js";
import { ReplayDetected } from "../../src/errors.js";
import { hashCanonical } from "../../src/manifest/hash.js";
import { ManifestStore } from "../../src/manifest/store.js";
import { BuyerOrchestrator } from "../../src/orchestrator.js";
import { LegacyChaumianClient } from "../../src/privacy/legacy-chaumian.js";
import { validateQuote } from "../../src/quote.js";
import { RestX402Transport } from "../../src/transport/rest-x402.js";
import type { SetraTransport } from "../../src/transport/types.js";
import type { TaskQuote } from "../../src/types.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for live E2E`);
  return value;
};

describe("Phase 1 live REST/on-chain flow", () => {
  let chain: ChainClient;
  let escrow: EscrowCoordinator;
  let settlement: SettlementCoordinator;
  let transport: RestX402Transport;
  let privacy: LegacyChaumianClient;
  let buyerAddress: string;
  const policyHash = hashCanonical({
    compatibility: "legacy-hash",
    version: "1",
  });
  let nextTaskId = BigInt(Date.now());

  beforeAll(() => {
    const rpcUrl = required("ROLE_C_RPC_URL");
    const sellerUrl = required("ROLE_C_SELLER_URL");
    const programId = new PublicKey(required("ROLE_C_PROGRAM_ID"));
    const expectedMint = new PublicKey(required("ROLE_C_EXPECTED_MINT"));
    const buyer = loadKeypair(required("ROLE_C_BUYER_KEYPAIR_PATH"));
    const verifier = loadKeypair(required("ROLE_C_VERIFIER_KEYPAIR_PATH"));
    buyerAddress = buyer.publicKey.toBase58();
    const idl = JSON.parse(
      readFileSync(
        new URL("../../../target/idl/setra402.json", import.meta.url),
        "utf8"
      )
    ) as Idl;
    chain = new ChainClient({
      connection: new Connection(rpcUrl, "confirmed"),
      idl,
      programId,
      buyer,
      verifier,
      protocolTreasury: new PublicKey(required("ROLE_C_PROTOCOL_TREASURY")),
    });
    escrow = new EscrowCoordinator(
      chain,
      new ManifestStore(mkdtempSync(join(tmpdir(), "setra402-e2e-manifests-")))
    );
    privacy = new LegacyChaumianClient(sellerUrl);
    settlement = new SettlementCoordinator(chain, 1, async (nullifier) => {
      await privacy.mirrorNullifierAfterSettlement(nullifier);
    });
    transport = new RestX402Transport(
      sellerUrl,
      (wire, context) =>
        validateQuote(wire, {
          programId,
          buyer: buyer.publicKey,
          verifier: verifier.publicKey,
          expectedMint,
          taskId: context.taskId,
          isPrivate: context.isPrivate,
        }),
      { maxAttempts: 3, baseDelayMs: 20 }
    );
  });

  const context = (isPrivate: boolean, input: unknown) => ({
    taskId: nextTaskId++,
    buyer: buyerAddress,
    input,
    isPrivate,
  });

  it("unpaid 402 -> initialize_task -> funded re-read -> seller retry -> public settlement", async () => {
    const run = context(false, { job: "public-e2e", value: 1 });
    const result = await new BuyerOrchestrator(
      transport,
      escrow,
      settlement
    ).runLegacy({
      ...run,
      serviceId: "legacy-rest",
      policyHash,
    });
    expect(result.status).toBe("settled");
    if (result.status !== "settled") throw new Error("expected settlement");
    expect(result.funded.state.status).toBe("pending");
    expect(result.settlement.state.status).toBe("settled");
  });

  it("preserves private settlement and rejects duplicate nullifier from on-chain state", async () => {
    const first = context(true, { job: "private-e2e", value: 1 });
    const firstQuote = await transport.requestQuote(first);
    const firstFunded = await escrow.ensureFunded({
      quote: firstQuote,
      serviceId: "legacy-rest",
      input: first.input,
      policyHash,
    });
    await transport.executeFundedTask(first);
    const voucher = await privacy.createVoucher({
      buyer: first.buyer,
      taskId: first.taskId,
    });
    const firstSettlement = await settlement.settle(
      firstQuote,
      firstFunded.record,
      { nullifier: voucher.nullifier }
    );
    expect(firstSettlement.state.status).toBe("settled");

    const second = context(true, { job: "private-e2e", value: 2 });
    const secondQuote = await transport.requestQuote(second);
    const secondFunded = await escrow.ensureFunded({
      quote: secondQuote,
      serviceId: "legacy-rest",
      input: second.input,
      policyHash,
    });
    await transport.executeFundedTask(second);
    await expect(
      settlement.settle(secondQuote, secondFunded.record, {
        nullifier: voucher.nullifier,
      })
    ).rejects.toBeInstanceOf(ReplayDetected);
  });

  it("maps live 410 to the timeout-refund path", async () => {
    const run = context(false, { job: "expired-e2e" });
    const quoteHolder: { current: TaskQuote | null } = { current: null };
    const delayedTransport: SetraTransport = {
      async requestQuote(request) {
        quoteHolder.current = await transport.requestQuote(request);
        return quoteHolder.current;
      },
      async executeFundedTask(request) {
        const quote = quoteHolder.current;
        if (!quote) throw new Error("quote missing");
        const funded = await chain.fetchTaskState(
          new PublicKey(quote.taskStatePda)
        );
        if (!funded) throw new Error("funded TaskState missing");
        const waitMs = Math.max(
          0,
          (funded.deadlineUnix - Math.floor(Date.now() / 1000) + 1) * 1000
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return transport.executeFundedTask(request);
      },
    };
    const result = await new BuyerOrchestrator(
      delayedTransport,
      escrow,
      settlement
    ).runLegacy({
      ...run,
      serviceId: "legacy-rest",
      policyHash,
    });
    expect(result.status).toBe("refunded");
    expect(
      (await chain.fetchTaskState(new PublicKey(result.quote.taskStatePda)))
        ?.status
    ).toBe("refunded");
  }, 20_000);

  it("keeps voluntary cancellation compatible with the 5% on-chain path", async () => {
    const run = context(false, { job: "cancel-e2e" });
    const quote = await transport.requestQuote(run);
    await escrow.ensureFunded({
      quote,
      serviceId: "legacy-rest",
      input: run.input,
      policyHash,
    });
    await settlement.cancelVoluntarily(quote);
    expect(
      (await chain.fetchTaskState(new PublicKey(quote.taskStatePda)))?.status
    ).toBe("refunded");
  });
});
