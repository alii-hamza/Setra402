import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { PublicKey } from "@solana/web3.js";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createRuntime } from "../../src/core/runtime.js";
import { loadKeypair } from "../../src/config.js";
import type { BuyerAgentConfig } from "../../src/config.js";
import { SellerMcpAdapter } from "../../src/mcp/seller-adapter.js";
import { createMcpServer, McpDispatcher } from "../../src/mcp/protocol.js";
import { createServer } from "node:http";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} required`);
  return value;
};
let bridge: ReturnType<typeof createMcpServer>,
  config: BuyerAgentConfig,
  mcpUrl: string;
let next = BigInt(Date.now()) + 900_000n;
beforeAll(async () => {
  bridge = createMcpServer(new SellerMcpAdapter(required("ROLE_C_SELLER_URL")));
  await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
  mcpUrl = `http://127.0.0.1:${
    (bridge.address() as { port: number }).port
  }/mcp`;
  config = {
    programId: new PublicKey(required("ROLE_C_PROGRAM_ID")),
    rpcUrl: required("ROLE_C_RPC_URL"),
    sellerUrl: required("ROLE_C_SELLER_URL"),
    buyer: loadKeypair(required("ROLE_C_BUYER_KEYPAIR_PATH")),
    verifier: loadKeypair(required("ROLE_C_VERIFIER_KEYPAIR_PATH")),
    protocolTreasuryAddress: new PublicKey(
      required("ROLE_C_PROTOCOL_TREASURY")
    ),
    settlementSafetyMarginSec: 1,
  };
});
afterAll(async () => {
  bridge.closeAllConnections();
  await new Promise<void>((r) => bridge.close(() => r()));
});
function fixture(is_private = false) {
  const directory = mkdtempSync(join(tmpdir(), "setra35-live-"));
  const options = {
    directory,
    config,
    mcpUrl,
    expectedMint: new PublicKey(required("ROLE_C_EXPECTED_MINT")),
  };
  const runtime = createRuntime(options);
  const call = {
    buyer: config!.buyer.publicKey.toBase58(),
    task_id: (next++).toString(),
    service_id: "legacy-rest",
    is_private,
    input: { audit: "phase35" },
    transport: "REST" as const,
  };
  return { directory, options, runtime, call };
}
async function crashAfterConfirmedSend(
  f: ReturnType<typeof fixture>,
  action: "fund" | "protectedCall" | "refund",
  fundInInitializedChild = false
) {
  const script = `import {createRuntime} from ${JSON.stringify(
    new URL("../../dist/core/runtime.js", import.meta.url).href
  )};const r=createRuntime();${
    fundInInitializedChild
      ? `await r.controller.fund(${JSON.stringify(f.call)});`
      : ""
  }const c=r.chain.options.connection;const send=c.sendRawTransaction.bind(c);c.sendRawTransaction=async raw=>{const sig=await send(raw);await c.confirmTransaction(sig,"confirmed");process.exit(79)};await r.controller.${action}(${JSON.stringify(
    f.call
  )});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
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
      SETRA_STATE_DIR: f.directory,
      MCP_URL: mcpUrl,
    },
  });
  let errors = "";
  child.stderr.on("data", (b) => {
    errors += b.toString();
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const code = await new Promise<number | null>((r) => child.once("exit", r));
  clearTimeout(timer);
  expect(code, errors).toBe(79);
}
describe("Phase 3.5 live concurrency and crash recovery (ACTUAL chain/seller/MCP/process)", () => {
  it("lost MCP responses preserve execution evidence and restart resumes via read-only seller result", async () => {
    const f = fixture();
    await f.runtime.controller.protectedCall(f.call);
    await f.runtime.controller.fund(f.call);
    const dispatcher = new McpDispatcher(
      new SellerMcpAdapter(config.sellerUrl)
    );
    let disconnected = 0;
    const proxy = createServer(async (req, res) => {
      let bytes = "";
      for await (const chunk of req) bytes += chunk.toString();
      const payload = JSON.parse(bytes),
        reply = await dispatcher.dispatch(payload);
      if (
        payload.method === "tools/call" &&
        payload.params.name === "protected_call"
      ) {
        disconnected++;
        res.destroy();
        return;
      }
      res
        .writeHead(reply === null ? 202 : 200, {
          "content-type": "application/json",
        })
        .end(reply === null ? undefined : JSON.stringify(reply));
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    try {
      const losing = createRuntime({
        ...f.options,
        mcpUrl: `http://127.0.0.1:${
          (proxy.address() as { port: number }).port
        }/mcp`,
      });
      await expect(
        losing.controller.protectedCall({ ...f.call, transport: "MCP" })
      ).rejects.toThrow();
      expect(disconnected).toBeGreaterThan(0);
      expect(await f.runtime.controller.status(f.call)).toMatchObject({
        chainState: { status: "pending" },
        classification: "UNKNOWN_EXTERNAL_EFFECT",
        reconciliationRequired: true,
      });
      const restarted = createRuntime(f.options);
      expect(
        await restarted.controller.protectedCall({
          ...f.call,
          transport: "MCP",
        })
      ).toMatchObject({ status: "settled", report: { passed: true } });
      expect(
        readdirSync(join(f.directory, "checkpoints")).filter((file) =>
          file.endsWith(".result.json")
        )
      ).toHaveLength(1);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((r) => proxy.close(() => r()));
    }
  }, 30_000);
  it.each(["refund", "cancel"])(
    "a staged passing settlement cannot double-finalize against actual %s",
    async (action) => {
      const f = fixture();
      const quote = await f.runtime.transports.REST.requestQuote({
        buyer: f.call.buyer,
        taskId: BigInt(f.call.task_id),
        input: f.call.input,
        isPrivate: false,
        serviceId: f.call.service_id,
      });
      await f.runtime.controller.protectedCall(f.call);
      await f.runtime.controller.fund(f.call);
      let staged!: () => void, release!: () => void;
      const reached = new Promise<void>((r) => {
          staged = r;
        }),
        barrier = new Promise<void>((r) => {
          release = r;
        });
      const original = f.runtime.chain.settlePublic.bind(f.runtime.chain);
      f.runtime.chain.settlePublic = async (...args) => {
        staged();
        await barrier;
        return original(...args);
      };
      const run = f.runtime.controller
        .protectedCall(f.call)
        .catch((error) => error);
      await reached;
      const other = createRuntime(f.options);
      try {
        if (action === "refund") await other.settlement.refundExpired(quote);
        else await other.settlement.cancelVoluntarily(quote);
      } finally {
        release();
      }
      const outcome = await run;
      expect(outcome).toBeInstanceOf(Error);
      expect(await f.runtime.controller.status(f.call)).toMatchObject({
        chainAction: "refunded",
        chainState: { status: "refunded" },
      });
    },
    30_000
  );
  it("confirmed refund survives an actual process exit before local acknowledgement", async () => {
    const f = fixture();
    await f.runtime.controller.protectedCall(f.call);
    await f.runtime.controller.fund(f.call);
    const status = (await f.runtime.controller.status(f.call)) as {
      chainState: { deadlineUnix: number };
    };
    while (
      (await f.runtime.chain.getChainUnixTime()) <
      status.chainState.deadlineUnix
    )
      await new Promise((r) => setTimeout(r, 150));
    await crashAfterConfirmedSend(f, "refund");
    expect(
      await createRuntime(f.options).controller.refund({
        ...f.call,
        transport: "MCP",
      })
    ).toMatchObject({ chainAction: "refunded" });
    const records = readdirSync(join(f.directory, "transactions")).filter(
      (file) => file.endsWith(".confirmed.json")
    );
    expect(records).toHaveLength(1); // Funding recorded; refund process died before recording.
  }, 30_000);
  it("concurrent REST/MCP funding and execution share one canonical result", async () => {
    const f = fixture();
    await f.runtime.controller.protectedCall(f.call);
    const funding = await Promise.all([
      f.runtime.controller.fund(f.call),
      f.runtime.controller.fund({ ...f.call, transport: "MCP" }),
    ]);
    expect(funding[0]).toEqual(funding[1]);
    const results = await Promise.all([
      f.runtime.controller.protectedCall(f.call),
      f.runtime.controller.protectedCall({ ...f.call, transport: "MCP" }),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ status: "settled" });
    expect(
      (await createRuntime(f.options).controller.status(f.call)) as object
    ).toMatchObject({ chainAction: "settled" });
  }, 30_000);
  it("actual process exit after confirmed funding cannot fund a second time", async () => {
    const f = fixture();
    await f.runtime.controller.protectedCall(f.call);
    await crashAfterConfirmedSend(f, "fund");
    const files = readdirSync(join(f.directory, "transactions"));
    expect(
      files.filter((file) => file.endsWith(".transaction.json"))
    ).toHaveLength(1);
    expect(
      files.filter((file) => file.endsWith(".confirmed.json"))
    ).toHaveLength(0);
    expect(
      await createRuntime(f.options).controller.fund({
        ...f.call,
        transport: "MCP",
      })
    ).toMatchObject({ status: "funded" });
    expect(
      readdirSync(join(f.directory, "transactions")).filter((file) =>
        file.endsWith(".transaction.json")
      )
    ).toHaveLength(1);
  }, 30_000);
  it("actual process exit after settlement confirmation reconciles chain and persisted report", async () => {
    const f = fixture();
    await f.runtime.controller.protectedCall(f.call);
    // Initialize the child before funding so startup does not consume the
    // committed deadline of the settlement-crash fixture.
    await crashAfterConfirmedSend(f, "protectedCall", true);
    const checkpointFiles = readdirSync(join(f.directory, "checkpoints"));
    const report = JSON.parse(
      readFileSync(
        join(
          f.directory,
          "checkpoints",
          checkpointFiles.find((file) => file.endsWith(".report.json"))!
        ),
        "utf8"
      )
    ).value;
    expect(report.passed).toBe(true);
    const restarted = createRuntime(f.options);
    expect(
      await restarted.controller.status({ ...f.call, transport: "MCP" })
    ).toMatchObject({
      chainAction: "settled",
      outcome: { report: { passed: true } },
    });
    expect(
      await restarted.controller.protectedCall({ ...f.call, transport: "MCP" })
    ).toMatchObject({ status: "settled" });
  }, 30_000);
  it("private completed task replays through another transport without a second credential or payment", async () => {
    const f = fixture(true);
    await f.runtime.controller.protectedCall(f.call);
    await f.runtime.controller.fund(f.call);
    const first = await f.runtime.controller.protectedCall(f.call);
    expect(first).toMatchObject({ status: "settled" });
    const replay = await createRuntime(f.options).controller.protectedCall({
      ...f.call,
      transport: "MCP",
    });
    expect(replay).toEqual(first);
    expect(
      readdirSync(join(f.directory, "vouchers")).filter((file) =>
        file.endsWith(".voucher.json")
      )
    ).toHaveLength(1);
  }, 30_000);
});
