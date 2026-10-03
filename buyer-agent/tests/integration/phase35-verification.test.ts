import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { verificationHarness } from "../fixtures/verification-harness.js";
import { RunCheckpoints } from "../../src/core/run-checkpoints.js";
import { DurableJournal } from "../../src/core/journal.js";
import { SettlementCoordinator } from "../../src/chain/settlement-coordinator.js";
import { ProtectedTaskController } from "../../src/core/task-controller.js";
import { SourceClient } from "../../src/verification/level2/source-client.js";
import { FileChallengeStore } from "../../src/verification/level2/challenge-store.js";

const fixture = () =>
  verificationHarness(
    {
      version: "1",
      level: 1,
      checks: [{ type: "record_count", pointer: "/records", exact: 1 }],
    },
    { records: [{}] }
  );
const directory = () => mkdtempSync(join(tmpdir(), "setra35-verify-"));
describe("Phase 3.5 verification restart (ACTUAL journals, SIMULATED chain)", () => {
  it.each(["before_publish", "after_publish"])(
    "report persistence interruption at %s resumes immutable verification without provider dispatch",
    async (point) => {
      const h = fixture(),
        dir = directory(),
        input = {
          buyer: h.chain.buyer.toBase58(),
          taskId: 99n,
          input: h.result.input,
          isPrivate: false,
          serviceId: h.quote.serviceId,
        };
      const checkpoints = new RunCheckpoints(
        dir,
        new DurableJournal((p, path) => {
          if (p === point && path.endsWith(".report.json"))
            throw new Error("verifier crash");
        })
      );
      checkpoints.saveResult(input, h.quote, h.result);
      const report = await h.engine.verify(
        h.manifest,
        h.quote.verificationPolicy,
        h.result,
        h.context
      );
      expect(() =>
        checkpoints.saveReport(input, h.quote, h.record, report)
      ).toThrow("crash");
      const restarted = new RunCheckpoints(dir),
        result = restarted.loadResult(input, h.quote)!;
      expect(result).toEqual(h.result);
      const replayed = await h.engine.verify(
        h.manifest,
        h.quote.verificationPolicy,
        result,
        h.context
      );
      expect(replayed.passed).toBe(true);
      restarted.saveReport(input, h.quote, h.record, replayed);
      h.chain.getChainUnixTime = async () => 100;
      await expect(
        h.settlement.settle(h.quote, h.record, { report: replayed })
      ).rejects.toThrow(/margin/);
      expect(h.calls).not.toContain("settle");
    }
  );
  it("DNS becomes private after persisted challenge: no retrieval and no new seed", async () => {
    const dir = directory(),
      store = new FileChallengeStore(dir),
      context = "b".repeat(64);
    const seed = await store.getOrCreate(context);
    const client = new SourceClient({}, async () => [
      { address: "169.254.169.254", family: 4 },
    ]);
    await expect(
      client.retrieve("https://example.com/company", ["example.com"])
    ).rejects.toThrow();
    expect(await new FileChallengeStore(dir).getOrCreate(context)).toBe(seed);
  });
  it.each([99, 100, 101])(
    "chain time %s governs settlement, refund and application state independently of browser time",
    async (clock) => {
      const h = fixture(),
        report = await h.engine.verify(
          h.manifest,
          h.quote.verificationPolicy,
          h.result,
          h.context
        );
      h.chain.getChainUnixTime = async () => clock;
      const coordinator = new SettlementCoordinator(h.chain, 0);
      if (clock < 100)
        await expect(
          coordinator.settle(h.quote, h.record, { report })
        ).resolves.toMatchObject({ state: { status: "settled" } });
      else
        await expect(
          coordinator.settle(h.quote, h.record, { report })
        ).rejects.toThrow(/margin/);
      h.reset();
      const call = {
        buyer: h.chain.buyer.toBase58(),
        task_id: "99",
        service_id: h.quote.serviceId,
        input: h.result.input,
        is_private: false,
        transport: "MCP",
      };
      const controller = new ProtectedTaskController(directory(), {
        async quote() {
          return h.quote;
        },
        normalizeQuote() {
          return h.quote;
        },
        async state() {
          return h.current();
        },
        async now() {
          return clock;
        },
        async fund() {
          throw new Error("no funding");
        },
        async run() {
          throw new Error("no execution");
        },
        async refund() {
          return coordinator.refundExpired(h.quote);
        },
      });
      expect(await controller.status(call)).toMatchObject({
        chainUnixTime: clock,
        chainAction:
          clock < 100 ? "awaiting_refund_deadline" : "refund_available",
      });
      if (clock < 100)
        await expect(controller.refund(call)).rejects.toThrow(/eligible/);
      else
        await expect(controller.refund(call)).resolves.toMatchObject({
          chainAction: "refunded",
        });
    }
  );
  it("the settlement safety margin still blocks deadline minus one with a PASS report", async () => {
    const h = fixture(),
      report = await h.engine.verify(
        h.manifest,
        h.quote.verificationPolicy,
        h.result,
        h.context
      );
    h.chain.getChainUnixTime = async () => 99;
    await expect(
      h.settlement.settle(h.quote, h.record, { report })
    ).rejects.toThrow(/margin/);
    expect(h.calls).not.toContain("settle");
  });
});
