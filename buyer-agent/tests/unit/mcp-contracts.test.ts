import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { protectedCallSchema } from "../../src/mcp/contracts.js";
import { CoreMcpTools } from "../../src/mcp/core-tools.js";
import { McpDispatcher } from "../../src/mcp/protocol.js";
const valid = {
  task_id: "18446744073709551615",
  buyer: Keypair.generate().publicKey.toBase58(),
  service_id: "lead-scraper-demo",
  is_private: false,
  input: { query: "Acme" },
};
describe("MCP hostile input boundary", () => {
  it("accepts u64 decimal strings without precision loss", () =>
    expect(protectedCallSchema.parse(valid).task_id).toBe(valid.task_id));
  it.each(["-1", "1.5", "01", "18446744073709551616"])(
    "rejects malformed task ID %s",
    (task_id) =>
      expect(() => protectedCallSchema.parse({ ...valid, task_id })).toThrow()
  );
  it.each([
    "secret_key",
    "verifier_key",
    "policy_override",
    "verification_result",
    "runner_command",
    "settlement_signature",
  ])("rejects privileged field %s", (key) =>
    expect(() =>
      protectedCallSchema.parse({ ...valid, [key]: "hostile" })
    ).toThrow()
  );
  it("rejects invalid buyer", () =>
    expect(() =>
      protectedCallSchema.parse({ ...valid, buyer: "bad" })
    ).toThrow());
  it("rejects invalid privacy flag", () =>
    expect(() =>
      protectedCallSchema.parse({ ...valid, is_private: "false" })
    ).toThrow());
  it("rejects oversized input", () =>
    expect(() =>
      protectedCallSchema.parse({
        ...valid,
        input: { text: "x".repeat(66000) },
      })
    ).toThrow());
  it("rejects noncanonical floating input", () =>
    expect(() =>
      protectedCallSchema.parse({ ...valid, input: { price: 1.5 } })
    ).toThrow());
  it("rejects malformed service slug", () =>
    expect(() =>
      protectedCallSchema.parse({ ...valid, service_id: "../command" })
    ).toThrow());
  it("supports initialization, tool listing and notifications", async () => {
    const protocol = new McpDispatcher({
      tools: [],
      async call() {
        throw new Error("unused");
      },
    });
    expect(
      await protocol.dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      })
    ).toMatchObject({
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "setra402", version: "0.3.0" },
      },
    });
    expect(
      await protocol.dispatch({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      })
    ).toBeNull();
    expect(
      await protocol.dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    ).toMatchObject({ result: { tools: [] } });
  });

  it("publishes only the five agent-facing product tools with safety guidance", () => {
    const tools = new CoreMcpTools(
      {} as ConstructorParameters<typeof CoreMcpTools>[0],
      "http://127.0.0.1:3001",
      valid.buyer
    ).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "discover_services",
      "protected_call",
      "fund_task",
      "task_status",
      "refund_task",
    ]);
    const descriptions = tools.map((tool) => tool.description).join(" ");
    // Current descriptions are terse - will be enhanced in Batch A R6
    expect(descriptions).toContain("verification");
    expect(descriptions).toContain("escrow");
    expect(descriptions).toContain("refund");
    expect(tools[1]?.inputSchema).toMatchObject({
      properties: {
        task_id: { type: "string", pattern: expect.any(String) },
        input: { type: "object" },
      },
    });
  });
});
