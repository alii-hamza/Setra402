import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createRuntime } from "../../src/core/runtime.js";
import { loadKeypair } from "../../src/config.js";
import { createMcpServer, McpDispatcher } from "../../src/mcp/protocol.js";
import { SellerMcpAdapter } from "../../src/mcp/seller-adapter.js";
import { CoreMcpTools } from "../../src/mcp/core-tools.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const required = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} required`);
  return v;
};
let runtime: ReturnType<typeof createRuntime>,
  bridge: ReturnType<typeof createMcpServer>,
  tools: CoreMcpTools;
let next = BigInt(Date.now()) + 300_000n;
beforeAll(async () => {
  bridge = createMcpServer(new SellerMcpAdapter(required("ROLE_C_SELLER_URL")));
  await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
  runtime = createRuntime({
    directory: mkdtempSync(join(tmpdir(), "setra-terminal-")),
    mcpUrl: `http://127.0.0.1:${
      (bridge.address() as { port: number }).port
    }/mcp`,
    expectedMint: new PublicKey(required("ROLE_C_EXPECTED_MINT")),
    config: {
      programId: new PublicKey(required("ROLE_C_PROGRAM_ID")),
      rpcUrl: required("ROLE_C_RPC_URL"),
      sellerUrl: required("ROLE_C_SELLER_URL"),
      buyer: loadKeypair(required("ROLE_C_BUYER_KEYPAIR_PATH")),
      verifier: loadKeypair(required("ROLE_C_VERIFIER_KEYPAIR_PATH")),
      protocolTreasuryAddress: new PublicKey(
        required("ROLE_C_PROTOCOL_TREASURY")
      ),
      settlementSafetyMarginSec: 1,
    },
  });
  tools = new CoreMcpTools(
    runtime.controller,
    runtime.config.sellerUrl,
    runtime.config.buyer.publicKey.toBase58()
  );
});
afterAll(async () => {
  bridge.closeAllConnections();
  await new Promise<void>((r) => bridge.close(() => r()));
});
const call = (
  service_id = "legacy-rest",
  is_private = false,
  input: Record<string, unknown> = { job: "terminal" }
) => ({
  task_id: (next++).toString(),
  buyer: runtime.config.buyer.publicKey.toBase58(),
  service_id,
  is_private,
  input,
});
describe("terminal MCP tools with real shared orchestrator and chain", () => {
  it("completes a task through a real newline JSON-RPC stdio process", async () => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../../dist/mcp/stdio.js", import.meta.url))],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PROGRAM_ID: required("ROLE_C_PROGRAM_ID"),
          RPC_URL: required("ROLE_C_RPC_URL"),
          SELLER_URL: required("ROLE_C_SELLER_URL"),
          EXPECTED_MINT: required("ROLE_C_EXPECTED_MINT"),
          BUYER_KEYPAIR_PATH: required("ROLE_C_BUYER_KEYPAIR_PATH"),
          VERIFIER_KEYPAIR_PATH: required("ROLE_C_VERIFIER_KEYPAIR_PATH"),
          PROTOCOL_TREASURY_ADDRESS: required("ROLE_C_PROTOCOL_TREASURY"),
          SETTLEMENT_SAFETY_MARGIN_SEC: "1",
          MCP_URL: `http://127.0.0.1:${
            (bridge.address() as { port: number }).port
          }/mcp`,
          SETRA_STATE_DIR: mkdtempSync(join(tmpdir(), "setra-stdio-")),
        },
      }
    );
    let text = "",
      seq = 1;
    const waiters = new Map<number, (value: unknown) => void>();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      text += chunk;
      let nl;
      while ((nl = text.indexOf("\n")) >= 0) {
        const line = text.slice(0, nl);
        text = text.slice(nl + 1);
        const reply = JSON.parse(line);
        waiters.get(reply.id)?.(reply);
      }
    });
    const rpc = (method: string, params: unknown) =>
      new Promise<any>((resolve, reject) => {
        const id = seq++;
        const timer = setTimeout(
          () => reject(new Error("stdio response timeout")),
          15000
        );
        waiters.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
        );
      });
    try {
      expect(
        await rpc("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        })
      ).toMatchObject({ result: { protocolVersion: "2025-03-26" } });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n"
      );
      const args = call();
      const tool = async (name: string) => {
        const reply = await rpc("tools/call", { name, arguments: args });
        return JSON.parse(reply.result.content[0].text);
      };
      expect(await tool("protected_call")).toMatchObject({
        status: "payment_required",
      });
      expect(await tool("fund_task")).toMatchObject({ status: "funded" });
      expect(await tool("protected_call")).toMatchObject({
        status: "settled",
        report: { passed: true },
      });
    } finally {
      child.kill();
    }
  }, 30_000);
  it("payment challenge -> funding -> L1 PASS -> settlement -> idempotent retry", async () => {
    const args = call();
    expect(await tools.call("protected_call", args)).toMatchObject({
      status: "payment_required",
    });
    await tools.call("fund_task", args);
    const first = await tools.call("protected_call", args);
    expect(first).toMatchObject({
      status: "settled",
      report: { passed: true },
      settlement: { state: { status: "settled" } },
    });
    expect(await tools.call("protected_call", args)).toEqual(first);
  }, 30_000);
  it("L1 FAIL stays Pending until refund eligibility", async () => {
    const args = call("lead-scraper-demo", false, { fixture: "invalid" });
    await tools.call("protected_call", args);
    await tools.call("fund_task", args);
    expect(await tools.call("protected_call", args)).toMatchObject({
      status: "verification_failed",
      settlement: null,
    });
    expect(await tools.call("task_status", args)).toMatchObject({
      chainState: { status: "pending" },
      chainAction: "awaiting_refund_deadline",
    });
    await expect(tools.call("refund_task", args)).rejects.toThrow(/deadline/);
  }, 30_000);
  it("private compatibility uses the same coordinator and voucher flow", async () => {
    const args = call("legacy-rest", true);
    await tools.call("protected_call", args);
    await tools.call("fund_task", args);
    expect(await tools.call("protected_call", args)).toMatchObject({
      status: "settled",
      quote: { isPrivate: true },
      report: { passed: true },
    });
  }, 30_000);
  it("expired funded retry preserves 410 -> confirmed timeout refund", async () => {
    const args = call();
    await tools.call("protected_call", args);
    await tools.call("fund_task", args);
    await new Promise((r) => setTimeout(r, 6500));
    expect(await tools.call("protected_call", args)).toMatchObject({
      status: "refunded",
      refundSignature: expect.any(String),
    });
  }, 30_000);
  it("MCP protocol invokes core tools without browser interaction", async () => {
    const reply = await new McpDispatcher(tools).dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "discover_services", arguments: {} },
    });
    expect(reply).toMatchObject({
      result: {
        content: [
          { type: "text", text: expect.stringContaining("lead-scraper-demo") },
        ],
      },
    });
  });
});
