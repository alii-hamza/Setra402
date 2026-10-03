import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Connection, Keypair } from "@solana/web3.js";
import { DurableJournal } from "../../src/core/journal.js";
import {
  FinancialJournal,
  type PreparedTransaction,
} from "../../src/chain/financial-journal.js";

const temporary = () => mkdtempSync(join(tmpdir(), "setra35-journal-"));
describe("Phase 3.5 atomic journal failures (ACTUAL filesystem)", () => {
  it.each([
    "before_temp_write",
    "after_temp_write",
    "before_fsync",
    "after_fsync",
    "before_publish",
  ])("%s failure publishes no partial JSON", (point) => {
    const path = join(temporary(), "record.json");
    const j = new DurableJournal((p) => {
      if (p === point)
        throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" });
    });
    expect(() => j.write(path, { completed: true })).toThrow("ENOSPC");
    expect(new DurableJournal().read(path)).toBeNull();
  });
  it("crash after publication preserves the complete record for restart", () => {
    const path = join(temporary(), "record.json");
    const j = new DurableJournal((p) => {
      if (p === "after_publish") throw new Error("crash");
    });
    expect(() => j.write(path, { completed: true })).toThrow("crash");
    expect(new DurableJournal().read(path)).toEqual({ completed: true });
  });
  it.each(["{", "null", '{"version":1}', '{"status":"settled"}'])(
    "rejects corrupt/torn %s",
    (bytes) => {
      const path = join(temporary(), "record.json");
      writeFileSync(path, bytes);
      expect(() => new DurableJournal().read(path)).toThrow(/reconciliation/);
    }
  );
  it("rejects syntactically valid record modification", () => {
    const path = join(temporary(), "record.json"),
      j = new DurableJournal();
    j.write(path, { passed: false });
    const bytes = JSON.parse(readFileSync(path, "utf8"));
    bytes.value.passed = true;
    writeFileSync(path, JSON.stringify(bytes));
    expect(() => j.read(path)).toThrow(/corrupt/);
  });
  it("ignores a stale temporary file rather than activating it", () => {
    const path = join(temporary(), "record.json");
    writeFileSync(path + ".old.tmp", '{"passed":true}');
    expect(new DurableJournal().read(path)).toBeNull();
  });
  it("exclusive publication across independent writers retains one winner", () => {
    const path = join(temporary(), "record.json");
    expect(new DurableJournal().publish(path, { owner: 1 })).toBe(true);
    expect(new DurableJournal().publish(path, { owner: 2 })).toBe(false);
    expect(new DurableJournal().read(path)).toEqual({ owner: 1 });
  });
});

describe("Phase 3.5 financial intents (SIMULATED RPC, ACTUAL filesystem)", () => {
  for (const kind of ["funding", "settlement", "refund"]) {
    function fixture() {
      const dir = temporary(),
        operation = { kind, taskState: "test-task" };
      const prepared: PreparedTransaction = {
        signature: "1".repeat(88),
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 100,
        fingerprint: "a".repeat(64),
        signedAtUnix: 1,
      };
      let completed = false,
        status: unknown = null,
        height = 50,
        sends = 0,
        fence = 1,
        fenceHeight: number | null = null;
      const connection = {
        async getSignatureStatus() {
          return { context: { slot: 1 }, value: status };
        },
        async getBlockHeight() {
          return height;
        },
        async getSlot() {
          return fence;
        },
        async getParsedBlock() {
          return { blockHeight: fenceHeight ?? height };
        },
      } as unknown as Connection;
      const account = async () => ({
        completed,
        permits: !completed,
        state: completed ? "terminal" : "pending",
        slot: 1,
      });
      return {
        dir,
        operation,
        prepared,
        connection,
        account,
        count: () => sends,
        sent: () => {
          sends++;
        },
        landed: () => {
          completed = true;
          status = { err: null, confirmationStatus: "confirmed" };
        },
        expire: () => {
          height = 101;
        },
        lag: () => {
          height = 101;
          fence = 2;
        },
        inconsistentHeight: () => {
          height = 101;
          fenceHeight = 50;
        },
        journal: () => new FinancialJournal(dir),
      };
    }
    it(`${kind}: two processes/controllers cannot both claim submission`, async () => {
      const f = fixture();
      let release!: () => void;
      const wait = new Promise<void>((r) => {
        release = r;
      });
      const first = f
        .journal()
        .run(f.operation, f.connection, f.account, async (persist) => {
          persist(f.prepared);
          f.sent();
          await wait;
          f.landed();
          return f.prepared.signature;
        });
      await expect(
        f.journal().run(f.operation, f.connection, f.account, async () => {
          f.sent();
          return "duplicate";
        })
      ).rejects.toThrow(/reconciliation/);
      release();
      await first;
      expect(f.count()).toBe(1);
    });
    it(`${kind}: signed before-send crash retains evidence and forbids replacement`, async () => {
      const f = fixture();
      await expect(
        f
          .journal()
          .run(f.operation, f.connection, f.account, async (persist) => {
            persist(f.prepared);
            throw new Error("crash before send");
          })
      ).rejects.toThrow("crash");
      const evidence = await f
        .journal()
        .inspect(f.operation, f.connection, f.account);
      expect(evidence).toMatchObject({
        classification: "UNKNOWN_FINANCIAL_OUTCOME",
        prepared: f.prepared,
      });
      await expect(
        f.journal().run(f.operation, f.connection, f.account, async () => {
          f.sent();
          return "duplicate";
        })
      ).rejects.toThrow(/reconciliation/);
      expect(f.count()).toBe(0);
    });
    it(`${kind}: chain landed before acknowledgement/completion persistence is reconciled`, async () => {
      const f = fixture();
      await expect(
        f
          .journal()
          .run(f.operation, f.connection, f.account, async (persist) => {
            persist(f.prepared);
            f.sent();
            f.landed();
            throw new Error("response lost");
          })
      ).rejects.toThrow("lost");
      const recovered = await f
        .journal()
        .run(f.operation, f.connection, f.account, async () => {
          f.sent();
          return "duplicate";
        });
      expect(recovered).toBe(f.prepared.signature);
      expect(f.count()).toBe(1);
    });
    it(`${kind}: intent persisted before signing remains explicit and is not automatically retried`, async () => {
      const f = fixture();
      await expect(
        f.journal().run(f.operation, f.connection, f.account, async () => {
          throw new Error("crash before signing");
        })
      ).rejects.toThrow("crash");
      expect(
        await f.journal().inspect(f.operation, f.connection, f.account)
      ).toMatchObject({
        classification: "UNKNOWN_FINANCIAL_OUTCOME",
        prepared: null,
      });
      await expect(
        f.journal().run(f.operation, f.connection, f.account, async () => {
          f.sent();
          return "duplicate";
        })
      ).rejects.toThrow(/reconciliation/);
      expect(f.count()).toBe(0);
    });
    it(`${kind}: rooted expiry plus absent status/state classifies safe retry without automatically submitting`, async () => {
      const f = fixture();
      await expect(
        f
          .journal()
          .run(f.operation, f.connection, f.account, async (persist) => {
            persist(f.prepared);
            throw new Error("timeout");
          })
      ).rejects.toThrow("timeout");
      f.expire();
      expect(
        await f.journal().inspect(f.operation, f.connection, f.account)
      ).toMatchObject({ classification: "SAFE_TO_RETRY" });
      await expect(
        f.journal().run(f.operation, f.connection, f.account, async () => {
          f.sent();
          return "duplicate";
        })
      ).rejects.toThrow(/reconciliation/);
      expect(f.count()).toBe(0);
    });
    it(`${kind}: prepared-record persistence failure prevents send`, async () => {
      const f = fixture();
      const journal = new FinancialJournal(
        f.dir,
        new DurableJournal((point, path) => {
          if (point === "before_publish" && path.endsWith("transaction.json"))
            throw new Error("injected rename failure");
        })
      );
      await expect(
        journal.run(f.operation, f.connection, f.account, async (persist) => {
          persist(f.prepared);
          f.sent();
          return "unsafe";
        })
      ).rejects.toThrow("rename failure");
      expect(f.count()).toBe(0);
      expect(readdirSync(f.dir).some((name) => name.endsWith(".intent"))).toBe(
        true
      );
    });
    it(`${kind}: orphan signed evidence is never overwritten or resubmitted`, async () => {
      const f = fixture();
      await expect(
        f
          .journal()
          .run(f.operation, f.connection, f.account, async (persist) => {
            persist(f.prepared);
            throw new Error("lost");
          })
      ).rejects.toThrow("lost");
      const intent = readdirSync(f.dir).find((name) =>
        name.endsWith(".intent")
      )!;
      unlinkSync(join(f.dir, intent));
      await expect(
        f.journal().run(f.operation, f.connection, f.account, async () => {
          f.sent();
          return "duplicate";
        })
      ).rejects.toThrow(/orphan/);
      expect(f.count()).toBe(0);
    });
    it(`${kind}: a changed operation binding cannot reuse a confirmed signature`, async () => {
      const f = fixture();
      await f
        .journal()
        .run(f.operation, f.connection, f.account, async (persist) => {
          persist(f.prepared);
          f.sent();
          f.landed();
          return f.prepared.signature;
        });
      await expect(
        f
          .journal()
          .run(
            { ...f.operation, binding: "b".repeat(64) },
            f.connection,
            f.account,
            async () => {
              f.sent();
              return "duplicate";
            }
          )
      ).rejects.toThrow(/binding/);
      expect(f.count()).toBe(1);
    });
    it(`${kind}: stale RPC contexts cannot establish safe expiry recovery`, async () => {
      const f = fixture();
      await expect(
        f
          .journal()
          .run(f.operation, f.connection, f.account, async (persist) => {
            persist(f.prepared);
            throw new Error("timeout");
          })
      ).rejects.toThrow("timeout");
      f.lag();
      expect(
        await f.journal().inspect(f.operation, f.connection, f.account)
      ).toMatchObject({ classification: "UNKNOWN_FINANCIAL_OUTCOME" });
      expect(f.count()).toBe(0);
    });
    it(`${kind}: a newer unrelated height cannot prove expiry at an older slot fence`, async () => {
      const f = fixture();
      await expect(
        f
          .journal()
          .run(f.operation, f.connection, f.account, async (persist) => {
            persist(f.prepared);
            throw new Error("timeout");
          })
      ).rejects.toThrow("timeout");
      f.inconsistentHeight();
      expect(
        await f.journal().inspect(f.operation, f.connection, f.account)
      ).toMatchObject({ classification: "UNKNOWN_FINANCIAL_OUTCOME" });
    });
    it(`${kind}: chain confirmation survives local completion write failure`, async () => {
      const f = fixture();
      const j = new FinancialJournal(
        f.dir,
        new DurableJournal((point, path) => {
          if (point === "before_publish" && path.endsWith("confirmed.json"))
            throw new Error("completion write failed");
        })
      );
      await expect(
        j.run(f.operation, f.connection, f.account, async (persist) => {
          persist(f.prepared);
          f.sent();
          f.landed();
          return f.prepared.signature;
        })
      ).rejects.toThrow("write failed");
      await expect(
        f.journal().run(f.operation, f.connection, f.account, async () => {
          f.sent();
          return "duplicate";
        })
      ).resolves.toBe(f.prepared.signature);
      expect(f.count()).toBe(1);
    });
  }
});
