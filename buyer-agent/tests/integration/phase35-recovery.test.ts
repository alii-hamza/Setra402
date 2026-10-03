import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { hashCanonical } from "../../src/manifest/hash.js";
import { DurableJournal } from "../../src/core/journal.js";
import {
  ProtectedTaskController,
  type TaskDependencies,
} from "../../src/core/task-controller.js";
import { verificationHarness } from "../fixtures/verification-harness.js";

const call = {
  buyer: Keypair.generate().publicKey.toBase58(),
  task_id: "35",
  service_id: "fixture-service",
  input: { records: [{}] },
  is_private: false,
  transport: "REST" as const,
};
function fixture() {
  const h = verificationHarness(
    {
      version: "1",
      level: 1,
      checks: [{ type: "record_count", pointer: "/records", exact: 1 }],
    },
    call.input
  );
  const dir = mkdtempSync(join(tmpdir(), "setra35-recovery-"));
  const counts = { run: 0, fund: 0 };
  const deps: TaskDependencies = {
    async validateFundingReceipt() {}, // SIMULATED confirmed receipt.
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
      return 50;
    },
    async fund() {
      counts.fund++;
      return {};
    },
    async run() {
      counts.run++;
      return { status: "settled", report: { passed: true } };
    },
    async refund() {
      return "refund-signature";
    },
  };
  const path = (suffix: string) =>
    join(
      dir,
      `${hashCanonical({ buyer: call.buyer, task_id: call.task_id })}.${suffix}`
    );
  return {
    h,
    dir,
    counts,
    deps,
    path,
    controller: new ProtectedTaskController(dir, deps),
  };
}
describe("Phase 3.5 durable controller recovery (SIMULATED chain)", () => {
  it.each(["signature unavailable", "memo mismatch"])(
    "cached funding cannot bypass %s",
    async (message) => {
      const f = fixture();
      await f.controller.fund(call);
      f.deps.validateFundingReceipt = async () => {
        throw new Error(message);
      };
      await expect(
        new ProtectedTaskController(f.dir, f.deps).fund({
          ...call,
          transport: "MCP",
        })
      ).rejects.toThrow(message);
      expect(f.counts.fund).toBe(1);
    }
  );
  it.each(["input", "privacy", "service"])(
    "cross-transport retry rejects changed %s",
    async (field) => {
      const f = fixture();
      await f.controller.protectedCall(call);
      const changed =
        field === "input"
          ? { input: {} }
          : field === "privacy"
          ? { is_private: true }
          : { service_id: "other-service" };
      await expect(
        new ProtectedTaskController(f.dir, f.deps).protectedCall({
          ...call,
          transport: "MCP",
          ...changed,
        })
      ).rejects.toThrow(/identity/);
      expect(f.counts.run).toBe(1);
    }
  );
  it("independent REST/MCP controllers cannot both dispatch an ambiguous execution", async () => {
    const f = fixture();
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    f.deps.run = async () => {
      f.counts.run++;
      await barrier;
      throw new Error("provider response lost");
    };
    const first = f.controller.protectedCall(call).catch((e) => e);
    await new Promise((r) => setTimeout(r, 20));
    await expect(
      new ProtectedTaskController(f.dir, f.deps).protectedCall({
        ...call,
        transport: "MCP",
      })
    ).rejects.toThrow(/reconciliation/);
    release();
    await first;
    await expect(
      new ProtectedTaskController(f.dir, f.deps).protectedCall(call)
    ).rejects.toThrow(/reconciliation/);
    expect(f.counts.run).toBe(1);
  });
  it("independent concurrent funding claims cannot duplicate an external submission", async () => {
    const f = fixture();
    let funded = false;
    f.deps.state = async () => (funded ? f.h.current() : null);
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    f.deps.fund = async () => {
      f.counts.fund++;
      await barrier;
      funded = true;
      return {};
    };
    const first = f.controller.fund(call);
    await new Promise((r) => setTimeout(r, 20));
    await expect(
      new ProtectedTaskController(f.dir, f.deps).fund({
        ...call,
        transport: "MCP",
      })
    ).rejects.toThrow(/reconciliation/);
    release();
    await first;
    await new ProtectedTaskController(f.dir, f.deps).fund(call);
    expect(f.counts.fund).toBe(1);
  });
  it("a stale funded completion cannot claim payment when the chain account is absent", async () => {
    const f = fixture();
    f.deps.state = async () => null;
    new DurableJournal().write(f.path("funded.json"), { status: "funded" });
    await expect(f.controller.fund(call)).rejects.toThrow(
      /reconciliation|unknown/i
    );
    expect(f.counts.fund).toBe(0);
  });
  it("a saved settled response cannot override a fresh Pending chain state", async () => {
    const f = fixture();
    new DurableJournal().write(f.path("result.json"), { status: "settled" });
    expect(await f.controller.protectedCall(call)).toMatchObject({
      status: "pending",
      reconciliationRequired: true,
    });
    expect(f.counts.run).toBe(0);
  });
  it.each(["null", '{"status":"settled"}', '{"status":"funded"}'])(
    "rejects incomplete or corrupt journal %s",
    async (bytes) => {
      const f = fixture();
      writeFileSync(f.path("result.json"), bytes);
      await expect(f.controller.protectedCall(call)).rejects.toThrow(
        /journal|corrupt|reconciliation/i
      );
      expect(f.counts).toEqual({ run: 0, fund: 0 });
    }
  );
  it("publishes one immutable quote across concurrent controller instances", async () => {
    const f = fixture();
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    let firstStarted!: () => void;
    const started = new Promise<void>((r) => {
      firstStarted = r;
    });
    const firstQuote = { ...f.h.quote, raw: { ...f.h.quote.raw, amount: 1 } };
    const secondQuote = { ...f.h.quote, raw: { ...f.h.quote.raw, amount: 2 } };
    f.deps.state = async () => null;
    const first = new ProtectedTaskController(f.dir, {
      ...f.deps,
      async quote() {
        firstStarted();
        await barrier;
        return firstQuote;
      },
      normalizeQuote(raw) {
        return { ...f.h.quote, raw: raw as typeof f.h.quote.raw };
      },
    });
    const second = new ProtectedTaskController(f.dir, {
      ...f.deps,
      async quote() {
        return secondQuote;
      },
      normalizeQuote(raw) {
        return { ...f.h.quote, raw: raw as typeof f.h.quote.raw };
      },
    });
    const pending = first.protectedCall(call);
    await started;
    const winner = await second.protectedCall({ ...call, transport: "MCP" });
    release();
    const loser = await pending;
    expect(loser).toEqual(winner);
  });
});
