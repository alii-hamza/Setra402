import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DurableJournal } from "../../src/core/journal.js";
import { FinancialJournal } from "../../src/chain/financial-journal.js";
import { hashCanonical } from "../../src/manifest/hash.js";

function fixture() {
  const root = mkdtempSync(join(process.cwd(), "../target/setra4a7-retry-"));
  const directory = join(root, "transactions");
  const operation = {
    programId: "program",
    taskState: "task",
    kind: "refund",
    binding: "a".repeat(64),
  };
  const id = hashCanonical({
    programId: operation.programId,
    taskState: operation.taskState,
    kind: operation.kind,
  });
  const old = {
    signature: "3".repeat(88),
    blockhash: "4".repeat(44),
    lastValidBlockHeight: 20,
    fingerprint: operation.binding,
    signedAtUnix: 10,
  };
  const next = { ...old, signature: "5".repeat(88), blockhash: "6".repeat(44) };
  const journal = new DurableJournal();
  journal.write(join(directory, `${id}.intent`), {
    operation,
    state: "UNKNOWN_FINANCIAL_OUTCOME",
  });
  journal.write(join(directory, `${id}.transaction.json`), old);
  const archive = join(root, "refund-retry-evidence", `${id}.prior.json`);
  mkdirSync(join(root, "refund-retry-evidence"));
  const financial = new FinancialJournal(directory);
  const account = async () => ({ completed: false, permits: true, state: {} });
  return {
    root,
    directory,
    id,
    operation,
    old,
    next,
    archive,
    financial,
    account,
    journal,
  };
}

describe("4A.7 existing financial journal refund retry", () => {
  it("rejects a partial restore missing the refund retry evidence family", async () => {
    const f = fixture();
    rmSync(join(f.root, "refund-retry-evidence"), { recursive: true });
    const send = vi.fn(async () => f.next.signature);
    await expect(
      f.financial.retryRefund(f.operation, f.account, async () => true, send)
    ).rejects.toThrow("refund retry evidence family is missing");
    expect(send).not.toHaveBeenCalled();
  });
  it("archives the original signed evidence before preparing one replacement", async () => {
    const f = fixture();
    const proof = vi.fn(
      async (signature: string) => signature === f.old.signature
    );
    const signature = await f.financial.retryRefund(
      f.operation,
      f.account,
      proof,
      async (persist) => {
        expect(existsSync(f.archive)).toBe(true);
        expect(f.journal.read(f.archive)).toEqual({
          operation: f.operation,
          prepared: f.old,
        });
        persist(f.next);
        return f.next.signature;
      }
    );
    expect(signature).toBe(f.next.signature);
    expect(proof).toHaveBeenCalledExactlyOnceWith(f.old.signature);
    expect(
      f.journal.read(join(f.directory, `${f.id}.transaction.json`))
    ).toEqual(f.next);
    expect(
      f.journal.read(join(f.directory, `${f.id}.confirmed.json`))
    ).toMatchObject({
      signature: f.next.signature,
    });
  });
  it("keeps a new ambiguous signature and refuses a second automatic replacement", async () => {
    const f = fixture();
    await expect(
      f.financial.retryRefund(
        f.operation,
        f.account,
        async () => true,
        async (persist) => {
          persist(f.next);
          throw new Error("RPC response lost");
        }
      )
    ).rejects.toThrow("RPC response lost");
    expect(
      f.journal.read(join(f.directory, `${f.id}.transaction.json`))
    ).toEqual(f.next);
    expect(f.journal.read(f.archive)).toMatchObject({ prepared: f.old });
    const send = vi.fn();
    await expect(
      f.financial.retryRefund(f.operation, f.account, async () => true, send)
    ).rejects.toThrow(/history conflicts or is exhausted/);
    expect(send).not.toHaveBeenCalled();
  });
  it("restarts safely after archival but before preparation", async () => {
    const f = fixture();
    await expect(
      f.financial.retryRefund(
        f.operation,
        f.account,
        async () => true,
        async () => {
          throw new Error("terminated before preparation");
        }
      )
    ).rejects.toThrow("terminated before preparation");
    expect(
      f.journal.read(join(f.directory, `${f.id}.transaction.json`))
    ).toEqual(f.old);
    const replay = await f.financial.retryRefund(
      f.operation,
      f.account,
      async (signature) => signature === f.old.signature,
      async (persist) => {
        persist(f.next);
        return f.next.signature;
      }
    );
    expect(replay).toBe(f.next.signature);
  });
  it("fails closed on corrupt archive or missing original preparation", async () => {
    const f = fixture();
    await f.financial
      .retryRefund(
        f.operation,
        f.account,
        async () => true,
        async () => {
          throw new Error("stop");
        }
      )
      .catch(() => undefined);
    writeFileSync(f.archive, readFileSync(f.archive, "utf8").slice(0, 8));
    await expect(
      f.financial.retryRefund(f.operation, f.account, async () => true, vi.fn())
    ).rejects.toThrow(/corrupt or legacy journal/);
  });
});
