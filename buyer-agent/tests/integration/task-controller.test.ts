import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { ProtectedTaskController } from "../../src/core/task-controller.js";
import { verificationHarness } from "../fixtures/verification-harness.js";
const call = {
  task_id: "99",
  buyer: Keypair.generate().publicKey.toBase58(),
  service_id: "fixture-service",
  is_private: false,
  input: { records: [{}] },
  transport: "MCP" as const,
};
function setup() {
  const h = verificationHarness(
    {
      version: "1",
      level: 1,
      checks: [{ type: "record_count", pointer: "/records", exact: 1 }],
    },
    call.input
  );
  const counts = { fund: 0, run: 0 };
  let chainState: unknown = null;
  const deps = {
    async quote() {
      return h.quote;
    },
    normalizeQuote() {
      return h.quote;
    },
    async fund() {
      counts.fund++;
      chainState = { status: "pending", deadlineUnix: 100 };
      return {};
    },
    async run() {
      counts.run++;
      return { status: "settled", report: { passed: true } };
    },
    async state() {
      return chainState as ReturnType<typeof h.current> | null;
    },
    async now() {
      return 50;
    },
    async refund() {
      chainState = { status: "refunded" };
      return "refund-sig";
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "setra-controller-"));
  return {
    counts,
    deps,
    dir,
    controller: new ProtectedTaskController(dir, deps),
  };
}
describe("shared terminal task lifecycle retry guard", () => {
  it("returns payment_required before funding", async () =>
    expect(await setup().controller.protectedCall(call)).toMatchObject({
      status: "payment_required",
    }));
  it("funded retry executes once and replays the saved result", async () => {
    const s = setup();
    await s.controller.protectedCall(call);
    await s.controller.fund(call);
    await s.controller.protectedCall(call);
    await s.controller.protectedCall(call);
    expect(s.counts).toEqual({ fund: 1, run: 1 });
  });
  it("concurrent retries share one execution", async () => {
    const s = setup();
    await s.controller.protectedCall(call);
    await s.controller.fund(call);
    await Promise.all([
      s.controller.protectedCall(call),
      s.controller.protectedCall(call),
    ]);
    expect(s.counts.run).toBe(1);
  });
  it("restart replays without funding/execution again", async () => {
    const s = setup();
    await s.controller.protectedCall(call);
    await s.controller.fund(call);
    await s.controller.protectedCall(call);
    await new ProtectedTaskController(s.dir, s.deps).protectedCall(call);
    expect(s.counts).toEqual({ fund: 1, run: 1 });
  });
  it("rejects task identity reuse with changed input", async () => {
    const s = setup();
    await s.controller.protectedCall(call);
    await expect(
      s.controller.protectedCall({ ...call, input: { records: [] } })
    ).rejects.toThrow(/identity/);
  });
  it("failed verification waits for real chain deadline", async () => {
    const s = setup();
    s.deps.run = async () => ({
      status: "verification_failed",
      report: { passed: false },
    });
    await s.controller.protectedCall(call);
    await s.controller.fund(call);
    await s.controller.protectedCall(call);
    expect(await s.controller.status(call)).toMatchObject({
      chainAction: "awaiting_refund_deadline",
    });
  });
  it("unknown execution outcome fails closed after restart", async () => {
    const s = setup();
    s.deps.run = async () => {
      throw new Error("crash");
    };
    await s.controller.protectedCall(call);
    await s.controller.fund(call);
    await expect(s.controller.protectedCall(call)).rejects.toThrow("crash");
    await expect(
      new ProtectedTaskController(s.dir, s.deps).protectedCall(call)
    ).rejects.toThrow(/reconciliation/);
  });
});
