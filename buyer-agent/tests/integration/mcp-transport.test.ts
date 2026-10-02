import { createServer } from "node:http";
import { Keypair } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SellerMcpAdapter } from "../../src/mcp/seller-adapter.js";
import { createMcpServer } from "../../src/mcp/protocol.js";
import { McpTransport } from "../../src/transport/mcp.js";
import { RestX402Transport } from "../../src/transport/rest-x402.js";
import { hashCanonical } from "../../src/manifest/hash.js";
import type { TaskQuote } from "../../src/types.js";
let origin: string,
  endpoint: string,
  funded = false,
  calls = 0;
const policy = {
  version: "1",
  level: 1,
  checks: [{ type: "record_count", pointer: "/records", exact: 1 }],
};
const services = [
  {
    id: "fixture-one",
    verification_policy: policy,
    policy_hash: hashCanonical(policy),
  },
  {
    id: "fixture-two",
    verification_policy: policy,
    policy_hash: hashCanonical(policy),
  },
];
const seller = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/services") {
    res.end(JSON.stringify(services));
    return;
  }
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = JSON.parse(text);
  if (body.input.expired) {
    res.writeHead(410).end(JSON.stringify({ error: "expired" }));
    return;
  }
  if (!funded) {
    res
      .writeHead(402)
      .end(
        JSON.stringify({
          task_id: "9",
          service_id: body.service_id,
          verification_policy: policy,
          policy_hash: hashCanonical(policy),
        })
      );
    return;
  }
  calls++;
  const result = { records: [{ name: "Acme" }] };
  res.end(
    JSON.stringify({
      version: "1",
      task_id: "9",
      service_id: body.service_id,
      input: body.input,
      output_hash: hashCanonical(body.input),
      result,
      result_hash: hashCanonical(result),
      evidence: [],
      completed_at_unix: 50,
    })
  );
});
let bridge: ReturnType<typeof createMcpServer>;
const listen = (server: typeof seller) =>
  new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    )
  );
beforeAll(async () => {
  origin = await listen(seller);
  bridge = createMcpServer(new SellerMcpAdapter(origin));
  endpoint = (await listen(bridge)) + "/mcp";
});
afterAll(async () => {
  await Promise.all([
    new Promise<void>((r) => seller.close(() => r())),
    new Promise<void>((r) => bridge.close(() => r())),
  ]);
});
const context = {
  taskId: 9n,
  buyer: Keypair.generate().publicKey.toBase58(),
  serviceId: "fixture-one",
  isPrivate: false,
  input: { query: "test" },
};
const normalize = (wire: unknown) => wire as TaskQuote;
describe("registry-backed MCP/REST normalized parity", () => {
  it("discovers all registry services without a hardcoded tool list", async () =>
    expect(
      await new McpTransport(endpoint, normalize).discoverServices()
    ).toEqual({ services }));
  it("returns payment_required with identical policy hash and quote", async () => {
    funded = false;
    const rest = await new RestX402Transport(origin, normalize).requestQuote(
      context
    );
    const mcp = await new McpTransport(endpoint, normalize).requestQuote(
      context
    );
    expect(mcp).toEqual(rest);
  });
  it("funded retry returns identical immutable result semantics", async () => {
    funded = true;
    expect(
      await new McpTransport(endpoint, normalize).executeFundedTask(context)
    ).toEqual(
      await new RestX402Transport(origin, normalize).executeFundedTask(context)
    );
    expect(calls).toBe(2); // this fixture simulates shared seller execution, no signing here
  });
  it("preserves expired 410 refund disposition", async () => {
    await expect(
      new McpTransport(endpoint, normalize).executeFundedTask({
        ...context,
        input: { expired: true },
      })
    ).rejects.toMatchObject({ disposition: "refund" });
  });
  it("rejects browser origins", async () =>
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: {
            origin: "https://attacker.example",
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status
    ).toBe(403));
  it("rejects oversized MCP envelopes", async () =>
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "x".repeat(132000),
        })
      ).status
    ).toBe(413));
});
