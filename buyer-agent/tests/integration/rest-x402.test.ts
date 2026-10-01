import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskExpired } from "../../src/errors.js";
import { RestX402Transport } from "../../src/transport/rest-x402.js";
import type { LegacyTaskQuoteWire, TaskQuote } from "../../src/types.js";

describe("REST/x402 transport", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let attempts = 0;

  const quote: LegacyTaskQuoteWire = {
    task_id: 1,
    program_id: "11111111111111111111111111111111",
    task_state_pda: "11111111111111111111111111111111",
    vault_pda: "11111111111111111111111111111111",
    mint: "11111111111111111111111111111111",
    seller_token_account: "11111111111111111111111111111111",
    verifier: "11111111111111111111111111111111",
    amount: 1,
    timeout_seconds: 10,
    is_private: false,
    protocol_fee_bps: 100,
  };

  beforeEach(async () => {
    attempts = 0;
    server = createServer((req, res) => {
      attempts += 1;
      const taskId = req.url?.split("/")[2];
      res.setHeader("content-type", "application/json");
      if (taskId === "1" || (taskId === "5" && attempts === 1)) {
        res.statusCode = 402;
        res.end(JSON.stringify(quote));
      } else if (taskId === "2") {
        res.statusCode = 410;
        res.end(JSON.stringify({ error: "expired" }));
      } else if (taskId === "3" && attempts === 1) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "temporary" }));
      } else if (taskId === "4") {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "permanent" }));
      } else {
        res.statusCode = 200;
        res.end(
          JSON.stringify({ input: { ok: true }, output_hash: "ab".repeat(32) })
        );
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(
    async () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve()))
      )
  );

  const normalize = (wire: LegacyTaskQuoteWire): TaskQuote => ({
    taskId: BigInt(wire.task_id),
    programId: wire.program_id,
    taskStatePda: wire.task_state_pda,
    vaultPda: wire.vault_pda,
    mint: wire.mint,
    sellerTokenAccount: wire.seller_token_account,
    verifier: wire.verifier,
    amount: BigInt(wire.amount),
    timeoutSeconds: wire.timeout_seconds,
    isPrivate: wire.is_private,
    protocolFeeBps: wire.protocol_fee_bps,
    raw: wire,
  });

  it("turns a real HTTP 402 response into a normalized quote", async () => {
    const transport = new RestX402Transport(baseUrl, normalize, {
      maxAttempts: 2,
      baseDelayMs: 1,
    });
    const result = await transport.requestQuote({
      taskId: 1n,
      buyer: "buyer",
      input: {},
      isPrivate: false,
    });
    expect(result.amount).toBe(1n);
    expect(attempts).toBe(1);
  });

  it("treats HTTP 410 as terminal and never retries", async () => {
    const transport = new RestX402Transport(baseUrl, normalize, {
      maxAttempts: 3,
      baseDelayMs: 1,
    });
    await expect(
      transport.executeFundedTask({
        taskId: 2n,
        buyer: "buyer",
        input: {},
        isPrivate: false,
      })
    ).rejects.toBeInstanceOf(TaskExpired);
    expect(attempts).toBe(1);
  });

  it("retries a transient 5xx response with bounded backoff", async () => {
    const transport = new RestX402Transport(baseUrl, normalize, {
      maxAttempts: 2,
      baseDelayMs: 1,
    });
    const result = await transport.executeFundedTask({
      taskId: 3n,
      buyer: "buyer",
      input: {},
      isPrivate: false,
    });
    expect("output_hash" in result).toBe(true);
    expect(attempts).toBe(2);
  });

  it("retries a post-funding 402 while the seller RPC waits for finality", async () => {
    const transport = new RestX402Transport(baseUrl, normalize, {
      maxAttempts: 2,
      baseDelayMs: 1,
    });
    const result = await transport.executeFundedTask({
      taskId: 5n,
      buyer: "buyer",
      input: {},
      isPrivate: false,
    });
    expect("output_hash" in result).toBe(true);
    expect(attempts).toBe(2);
  });

  it("does not retry a permanent 400 response", async () => {
    const transport = new RestX402Transport(baseUrl, normalize, {
      maxAttempts: 3,
      baseDelayMs: 1,
    });
    await expect(
      transport.executeFundedTask({
        taskId: 4n,
        buyer: "buyer",
        input: {},
        isPrivate: false,
      })
    ).rejects.toThrow(/permanent/);
    expect(attempts).toBe(1);
  });
});
