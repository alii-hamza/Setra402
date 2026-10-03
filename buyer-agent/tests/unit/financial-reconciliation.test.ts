import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { DurableJournal } from "../../src/core/journal.js";
import {
  FinancialReconciler,
  type FinancialRecoveryReader,
  type FinancialRecoverySnapshot,
} from "../../src/chain/financial-reconciliation.js";
import { deriveTaskPda, deriveVaultPda } from "../../src/chain/pda.js";
import { hashCanonical } from "../../src/manifest/hash.js";
import type { StoredManifest } from "../../src/manifest/store.js";
import type { TaskQuote, TaskStateView } from "../../src/types.js";

const key = () => Keypair.generate().publicKey.toBase58();
const signature = "3".repeat(88);
function snapshotFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory()
        ? snapshotFiles(path)
        : [`${path}:${readFileSync(path, "utf8")}`];
    })
    .sort();
}
function fixture(
  kind: "funding" | "settlement" | "refund" | "cancel" = "funding",
  privateTask = false
) {
  const root = mkdtempSync(
    join(process.cwd(), "../target/setra4a2-financial-")
  );
  const buyer = Keypair.generate().publicKey,
    program = Keypair.generate().publicKey;
  const taskId = 17n,
    [taskPda] = deriveTaskPda(program, buyer, taskId);
  const [vaultPda] = deriveVaultPda(program, taskPda);
  const policy = {
    version: "1" as const,
    level: 1 as const,
    checks: [{ type: "record_count" as const, pointer: "/records", exact: 1 }],
  };
  const raw = {
    task_id: taskId.toString(),
    program_id: program.toBase58(),
    task_state_pda: taskPda.toBase58(),
    vault_pda: vaultPda.toBase58(),
    mint: key(),
    seller_token_account: key(),
    verifier: key(),
    amount: "10",
    timeout_seconds: 60,
    is_private: privateTask,
    protocol_fee_bps: 100,
    service_id: "fixture-service",
    verification_policy: policy,
    policy_hash: hashCanonical(policy),
  };
  const quote: TaskQuote = {
    taskId,
    serviceId: raw.service_id,
    programId: raw.program_id,
    taskStatePda: raw.task_state_pda,
    vaultPda: raw.vault_pda,
    mint: raw.mint,
    sellerTokenAccount: raw.seller_token_account,
    verifier: raw.verifier,
    amount: 10n,
    timeoutSeconds: 60,
    isPrivate: privateTask,
    protocolFeeBps: 100,
    verificationPolicy: policy,
    policyHash: raw.policy_hash,
    raw,
  };
  const manifest = {
    version: "1" as const,
    taskId: taskId.toString(),
    serviceId: quote.serviceId,
    buyer: buyer.toBase58(),
    sellerTokenAccount: quote.sellerTokenAccount,
    sellerOwner: key(),
    verifier: quote.verifier,
    mint: quote.mint,
    amountBaseUnits: "10",
    timeoutSeconds: 60,
    isPrivate: privateTask,
    taskSpecHash: hashCanonical({ records: [1] }),
    policyHash: quote.policyHash,
    quoteHash: hashCanonical(raw),
  };
  const record: StoredManifest = {
    manifest,
    manifestHash: hashCanonical(manifest),
    initializeSignature: "init",
  };
  const operation = {
    programId: quote.programId,
    taskState: quote.taskStatePda,
    kind,
    binding: hashCanonical({ kind, taskState: quote.taskStatePda }),
  };
  const id = hashCanonical({
    programId: operation.programId,
    taskState: operation.taskState,
    kind,
  });
  const journal = new DurableJournal();
  const path = (suffix: string) => join(root, `${id}.${suffix}`);
  journal.write(path("intent"), {
    operation,
    state: "UNKNOWN_FINANCIAL_OUTCOME",
  });
  const prepared = () =>
    journal.write(path("transaction.json"), {
      signature,
      blockhash: key(),
      lastValidBlockHeight: 100,
      fingerprint: operation.binding,
      signedAtUnix: 50,
    });
  const confirmed = () =>
    journal.write(path("confirmed.json"), { signature, confirmedAtUnix: 51 });
  const task: TaskStateView = {
    buyer: manifest.buyer,
    seller: manifest.sellerOwner,
    verifier: manifest.verifier,
    mint: manifest.mint,
    taskId,
    amount: 10n,
    deadlineUnix: 100,
    status: "pending",
    isPrivate: privateTask,
    bump: 1,
  };
  const current: FinancialRecoverySnapshot = {
    slot: 150,
    taskState: task,
    vault: { amount: 10n, mint: quote.mint, owner: quote.taskStatePda },
    clockUnix: 75,
    nullifierRecord: null,
  };
  let status: Awaited<ReturnType<FinancialRecoveryReader["signature"]>> = {
    contextSlot: 150,
    confirmationStatus: "confirmed",
    err: null,
  };
  let fencedStatus = { ...status };
  let fence = { slot: 150, blockHeight: 120 as number | null };
  let memo: "MATCH" | "MISMATCH" | "UNAVAILABLE" = "MATCH";
  const calls = { snapshots: 0, status: 0, fence: 0, memo: 0 };
  const reader: FinancialRecoveryReader = {
    async snapshot(_request, minimumSlot) {
      calls.snapshots++;
      return { ...current, slot: minimumSlot ?? current.slot };
    },
    async signature() {
      calls.status++;
      return status;
    },
    async fencedSignature() {
      calls.status++;
      return fencedStatus;
    },
    async finalizedFence() {
      calls.fence++;
      return fence;
    },
    async manifestMemo() {
      calls.memo++;
      return memo;
    },
  };
  const request = { quote, manifest: record, operation };
  const reconcile = (nullifier?: Uint8Array) =>
    new FinancialReconciler(root, reader).reconcile({
      ...request,
      ...(nullifier ? { nullifier } : {}),
    });
  return {
    root,
    path,
    quote,
    record,
    operation,
    current,
    calls,
    prepared,
    confirmed,
    reconcile,
    reader,
    setStatus: (value: typeof status) => {
      status = value;
    },
    setFencedStatus: (value: typeof status) => {
      fencedStatus = value;
    },
    setFence: (value: typeof fence) => {
      fence = value;
    },
    setMemo: (value: typeof memo) => {
      memo = value;
    },
  };
}
describe("Phase 4A.2 read-only financial reconciliation (SIMULATED RPC, ACTUAL journal)", () => {
  it("proves funding only with signed receipt, task/vault and matching manifest memo", async () => {
    const f = fixture();
    f.prepared();
    f.confirmed();
    const before = snapshotFiles(f.root);
    const value = await f.reconcile();
    expect(value).toMatchObject({
      classification: "PROVEN_OCCURRED",
      chainOutcome: "OCCURRED",
      receipt: "CONFIRMED",
    });
    expect(f.calls.memo).toBe(1);
    expect(snapshotFiles(f.root)).toEqual(before);
  });
  it.each(["MISMATCH", "UNAVAILABLE"] as const)(
    "does not issue a funding receipt with %s memo evidence",
    async (memo) => {
      const f = fixture();
      f.prepared();
      f.setMemo(memo);
      expect((await f.reconcile()).receipt).toBe("UNRESOLVED");
    }
  );
  it("proves public settlement only with terminal state and drained vault", async () => {
    const f = fixture("settlement");
    f.prepared();
    f.current.taskState = { ...f.current.taskState!, status: "settled" };
    f.current.vault = { ...f.current.vault!, amount: 0n };
    expect(await f.reconcile()).toMatchObject({
      classification: "PROVEN_OCCURRED",
      receipt: "CONFIRMED",
    });
  });
  it("requires matching on-chain NullifierRecord for private settlement", async () => {
    const f = fixture("settlement", true);
    f.prepared();
    const nullifier = new Uint8Array(32).fill(7);
    f.current.taskState = { ...f.current.taskState!, status: "settled" };
    f.current.vault = { ...f.current.vault!, amount: 0n };
    expect((await f.reconcile(nullifier)).classification).not.toBe(
      "PROVEN_OCCURRED"
    );
    f.current.nullifierRecord = {
      taskId: f.quote.taskId,
      nullifierHex: Buffer.from(nullifier).toString("hex"),
    };
    expect((await f.reconcile(nullifier)).classification).toBe(
      "PROVEN_OCCURRED"
    );
  });
  it.each(["refund", "cancel"] as const)(
    "proves %s only with refunded task and drained vault",
    async (kind) => {
      const f = fixture(kind);
      f.prepared();
      f.current.taskState = { ...f.current.taskState!, status: "refunded" };
      f.current.vault = { ...f.current.vault!, amount: 0n };
      expect((await f.reconcile()).classification).toBe("PROVEN_OCCURRED");
    }
  );
  it("reports account outcome separately when original signature receipt is unavailable", async () => {
    const f = fixture("refund");
    f.prepared();
    f.current.taskState = { ...f.current.taskState!, status: "refunded" };
    f.current.vault = { ...f.current.vault!, amount: 0n };
    f.setStatus({ contextSlot: 150, confirmationStatus: null, err: null });
    expect(await f.reconcile()).toMatchObject({
      classification: "PROVEN_OCCURRED",
      chainOutcome: "OCCURRED",
      receipt: "UNRESOLVED",
    });
  });
  it("keeps an intent without prepared signature unknown", async () => {
    const f = fixture();
    expect(await f.reconcile()).toMatchObject({
      classification: "UNKNOWN_FINANCIAL_OUTCOME",
      receipt: "UNRESOLVED",
    });
    expect(f.calls.status).toBe(0);
  });
  it("does not retry while the original transaction can still land", async () => {
    const f = fixture("refund");
    f.prepared();
    f.setStatus({ contextSlot: 150, confirmationStatus: null, err: null });
    f.setFence({ slot: 150, blockHeight: 100 });
    expect((await f.reconcile()).classification).toBe(
      "UNKNOWN_FINANCIAL_OUTCOME"
    );
  });
  it("reports evidence-only safe retry after rooted expiry and fenced absence", async () => {
    const f = fixture("refund");
    f.prepared();
    f.current.clockUnix = 100;
    f.setStatus({ contextSlot: 150, confirmationStatus: null, err: null });
    f.setFencedStatus({
      contextSlot: 150,
      confirmationStatus: null,
      err: null,
    });
    expect(await f.reconcile()).toMatchObject({
      classification: "SAFE_TO_RETRY",
      chainOutcome: "NOT_OCCURRED",
      recommendedAction: "NO_ACTION",
    });
  });
  it("does not expose a settlement retry without verification authority", async () => {
    const f = fixture("settlement");
    f.prepared();
    f.setStatus({ contextSlot: 150, confirmationStatus: null, err: null });
    f.setFencedStatus({
      contextSlot: 150,
      confirmationStatus: null,
      err: null,
    });
    expect((await f.reconcile()).classification).toBe("PROVEN_NOT_OCCURRED");
  });
  it("fails closed on stale fenced signature context", async () => {
    const f = fixture("refund");
    f.prepared();
    f.setStatus({ contextSlot: 150, confirmationStatus: null, err: null });
    f.setFencedStatus({
      contextSlot: 149,
      confirmationStatus: null,
      err: null,
    });
    expect((await f.reconcile()).classification).toBe(
      "UNKNOWN_FINANCIAL_OUTCOME"
    );
  });
  it("rejects an orphan completion and changed operation binding", async () => {
    const f = fixture();
    f.confirmed();
    expect((await f.reconcile()).classification).toBe(
      "RECONCILIATION_REQUIRED"
    );
    const g = fixture();
    g.prepared();
    g.operation.binding = "a".repeat(64);
    expect((await g.reconcile()).classification).toBe(
      "RECONCILIATION_REQUIRED"
    );
  });
  it("rejects a changed immutable TaskState identity and never submits", async () => {
    const f = fixture();
    f.prepared();
    f.current.taskState = { ...f.current.taskState!, buyer: key() };
    expect((await f.reconcile()).classification).toBe(
      "RECONCILIATION_REQUIRED"
    );
  });
  it("keeps RPC outage unknown and preserves every journal byte", async () => {
    const f = fixture("refund");
    f.prepared();
    const before = snapshotFiles(f.root);
    f.reader.signature = async () => {
      throw new Error("RPC unavailable");
    };
    expect((await f.reconcile()).classification).toBe(
      "UNKNOWN_FINANCIAL_OUTCOME"
    );
    expect(snapshotFiles(f.root)).toEqual(before);
  });
  it("flags funded account/vault conflict instead of claiming non-occurrence", async () => {
    const f = fixture();
    f.prepared();
    f.current.vault = { ...f.current.vault!, amount: 9n };
    expect((await f.reconcile()).classification).toBe(
      "RECONCILIATION_REQUIRED"
    );
  });
});
