import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { protectedCallSchema } from "../../src/mcp/contracts.js";
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
      result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } },
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
});
