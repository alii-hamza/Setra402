import { mkdtempSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { loadKeypair } from "../../src/config.js";
import { createRuntime } from "../../src/core/runtime.js";
import { hashCanonical } from "../../src/manifest/hash.js";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} required for live refund scheduler`);
  return value;
};
let nextTask = BigInt(Date.now()) + 7_000_000n;
function liveFixture() {
  const directory = mkdtempSync(
    join(process.cwd(), "../target/setra4a7-live-")
  );
  const buyer = loadKeypair(required("ROLE_C_BUYER_KEYPAIR_PATH"));
  const runtime = createRuntime({
    directory,
    expectedMint: new PublicKey(required("ROLE_C_EXPECTED_MINT")),
    config: {
      programId: new PublicKey(required("ROLE_C_PROGRAM_ID")),
      rpcUrl: required("ROLE_C_RPC_URL"),
      sellerUrl: required("ROLE_C_SELLER_URL"),
      buyer,
      verifier: loadKeypair(required("ROLE_C_VERIFIER_KEYPAIR_PATH")),
      protocolTreasuryAddress: new PublicKey(
        required("ROLE_C_PROTOCOL_TREASURY")
      ),
      settlementSafetyMarginSec: 1,
    },
  });
  const call = {
    buyer: buyer.publicKey.toBase58(),
    task_id: (nextTask++).toString(),
    service_id: "legacy-rest",
    is_private: false,
    input: { audit: "phase4a7" },
    transport: "REST" as const,
  };
  const taskKey = hashCanonical({ buyer: call.buyer, task_id: call.task_id });
  return { runtime, call, taskKey, directory };
}
async function awaitDeadline(f: ReturnType<typeof liveFixture>) {
  const status = (await f.runtime.controller.status(f.call)) as {
    chainState: { deadlineUnix: number };
  };
  while (
    (await f.runtime.chain.getChainUnixTime()) < status.chainState.deadlineUnix
  )
    await new Promise((resolve) => setTimeout(resolve, 150));
}
describe("4A.7 live refund scheduler (ACTUAL validator)", () => {
  it("survives actual process exit after confirmed submission and before local scheduler record", async () => {
    const f = liveFixture();
    await f.runtime.controller.protectedCall(f.call);
    await f.runtime.controller.fund(f.call);
    await awaitDeadline(f);
    const child = spawnSync(
      process.execPath,
      [join(process.cwd(), "tests/helpers/refund-scheduler-crash.mjs")],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SETRA_REFUND_CRASH_DIRECTORY: f.directory,
          SETRA_REFUND_CRASH_TASK_KEY: f.taskKey,
          SETRA_REFUND_CRASH_STAGE: "after_submit",
        },
        timeout: 30_000,
        encoding: "utf8",
        windowsHide: true,
      }
    );
    expect(child.status, child.stderr).toBe(83);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const result = await f.runtime.refundScheduler().runTask(f.taskKey);
    expect(result.status).toBe("RECORDED");
    if (result.status === "RECORDED")
      expect(result.record.outcome).toBe("CONFIRMED");
    expect(await f.runtime.controller.status(f.call)).toMatchObject({
      chainState: { status: "refunded" },
    });
    expect(
      readdirSync(join(f.directory, "transactions")).filter((file) =>
        file.endsWith(".transaction.json")
      )
    ).toHaveLength(2);
  }, 55_000);
  it("submits one eligible refund, then restart reconciles it without another send", async () => {
    const f = liveFixture();
    await f.runtime.controller.protectedCall(f.call);
    await f.runtime.controller.fund(f.call);
    const before = await f.runtime.refundScheduler().runTask(f.taskKey);
    expect(before.status).toBe("RECORDED");
    if (before.status === "RECORDED")
      expect(before.record.outcome).toBe("BLOCKED");
    await awaitDeadline(f);
    const result = await f.runtime.refundScheduler().runTask(f.taskKey);
    expect(result.status).toBe("RECORDED");
    if (result.status === "RECORDED") {
      expect(result.record.outcome).toBe("CONFIRMED");
      expect(result.record.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/);
    }
    expect(await f.runtime.controller.status(f.call)).toMatchObject({
      chainState: { status: "refunded" },
    });
    const preparedBefore = readdirSync(
      join(f.directory, "transactions")
    ).filter((file) => file.endsWith(".transaction.json"));
    expect(preparedBefore).toHaveLength(2); // funding + one refund
    const restarted = f.runtime.refundScheduler();
    const replay = await restarted.runTask(f.taskKey);
    expect(replay.status).toBe("RECORDED");
    if (replay.status === "RECORDED")
      expect(replay.record.outcome).toBe("CONFIRMED");
    expect(
      readdirSync(join(f.directory, "transactions")).filter((file) =>
        file.endsWith(".transaction.json")
      )
    ).toEqual(preparedBefore);
  }, 45_000);
  it("manual refund racing the scheduler yields one authoritative refund", async () => {
    const f = liveFixture();
    const quote = await f.runtime.transports.REST.requestQuote({
      buyer: f.call.buyer,
      taskId: BigInt(f.call.task_id),
      input: f.call.input,
      isPrivate: false,
      serviceId: f.call.service_id,
    });
    await f.runtime.controller.protectedCall(f.call);
    await f.runtime.controller.fund(f.call);
    await awaitDeadline(f);
    let reached!: () => void, release!: () => void;
    const staged = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.runtime.settlement.refundExpired.bind(
      f.runtime.settlement
    );
    f.runtime.settlement.refundExpired = async (...args) => {
      reached();
      await barrier;
      return original(...args);
    };
    const pending = f.runtime.refundScheduler().runTask(f.taskKey);
    await staged;
    const manual = f.runtime.refundScheduler();
    expect((await manual.runTask(f.taskKey)).status).toBe("BUSY");
    const other = createRuntime({
      directory: f.directory,
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
    try {
      await other.settlement.refundExpired(quote);
    } finally {
      release();
    }
    expect((await pending).status).toBe("RECORDED");
    expect(await f.runtime.controller.status(f.call)).toMatchObject({
      chainState: { status: "refunded" },
    });
    const replay = await f.runtime.refundScheduler().runTask(f.taskKey);
    expect(replay.status).toBe("RECORDED");
    if (replay.status === "RECORDED")
      expect(replay.record.outcome).toBe("CONFIRMED");
    expect(
      readdirSync(join(f.directory, "transactions")).filter((file) =>
        file.endsWith(".transaction.json")
      )
    ).toHaveLength(2);
  }, 45_000);
  it.each(["settled", "cancelled"] as const)(
    "does not refund a task already %s on chain",
    async (ending) => {
      const f = liveFixture();
      const quote = await f.runtime.transports.REST.requestQuote({
        buyer: f.call.buyer,
        taskId: BigInt(f.call.task_id),
        input: f.call.input,
        isPrivate: false,
        serviceId: f.call.service_id,
      });
      await f.runtime.controller.protectedCall(f.call);
      await f.runtime.controller.fund(f.call);
      if (ending === "settled")
        expect(await f.runtime.controller.protectedCall(f.call)).toMatchObject({
          status: "settled",
        });
      else await f.runtime.settlement.cancelVoluntarily(quote);
      await awaitDeadline(f);
      const result = await f.runtime.refundScheduler().runTask(f.taskKey);
      expect(result.status).toBe("RECORDED");
      if (result.status === "RECORDED")
        expect(result.record.outcome).toBe("BLOCKED");
      expect(await f.runtime.controller.status(f.call)).toMatchObject({
        chainState: { status: ending === "settled" ? "settled" : "refunded" },
      });
    },
    45_000
  );
});
