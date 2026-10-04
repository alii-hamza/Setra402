import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { DurableJournal } from "../../src/core/journal.js";
import { ReconciliationClaims } from "../../src/core/reconciliation-claims.js";
import {
  RefundScheduler,
  refundSchedulerMetricsText,
  structuredRefundSchedulerLog,
} from "../../src/core/refund-scheduler.js";
import { ManifestStore } from "../../src/manifest/store.js";
import { hashCanonical } from "../../src/manifest/hash.js";
import { deriveTaskPda, deriveVaultPda } from "../../src/chain/pda.js";
import type { FinancialReconciliationResult } from "../../src/chain/financial-reconciliation.js";
import type { TaskStateView } from "../../src/types.js";

const key = () => Keypair.generate().publicKey.toBase58();
function finding(
  kind: "funding" | "refund" | "settlement" | "cancel",
  classification: FinancialReconciliationResult["classification"],
  signature: string | null = null
): FinancialReconciliationResult {
  return {
    version: "1",
    kind,
    classification,
    chainOutcome:
      classification === "PROVEN_OCCURRED"
        ? "OCCURRED"
        : classification === "PROVEN_NOT_OCCURRED" ||
          classification === "SAFE_TO_RETRY"
        ? "NOT_OCCURRED"
        : "UNKNOWN",
    receipt: classification === "PROVEN_OCCURRED" ? "CONFIRMED" : "NONE",
    preparedSignature: signature,
    reason: classification,
    recommendedAction: "NO_ACTION",
  };
}
function fixture() {
  const root = mkdtempSync(join(process.cwd(), "../target/setra4a7-"));
  const journal = new DurableJournal();
  const buyer = Keypair.generate().publicKey;
  const program = Keypair.generate().publicKey;
  const verifier = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const taskId = 41n;
  const [taskState] = deriveTaskPda(program, buyer, taskId);
  const [vault] = deriveVaultPda(program, taskState);
  const policy = {
    version: "1" as const,
    level: 1 as const,
    checks: [{ type: "record_count" as const, pointer: "/records", exact: 1 }],
  };
  const raw = {
    task_id: taskId.toString(),
    program_id: program.toBase58(),
    task_state_pda: taskState.toBase58(),
    vault_pda: vault.toBase58(),
    mint: mint.toBase58(),
    seller_token_account: key(),
    verifier: verifier.toBase58(),
    amount: "10",
    timeout_seconds: 60,
    is_private: false,
    protocol_fee_bps: 100,
    service_id: "refund-fixture",
    verification_policy: policy,
    policy_hash: hashCanonical(policy),
  };
  const sellerOwner = key();
  const manifest = {
    version: "1" as const,
    taskId: taskId.toString(),
    serviceId: raw.service_id,
    buyer: buyer.toBase58(),
    sellerTokenAccount: raw.seller_token_account,
    sellerOwner,
    verifier: raw.verifier,
    mint: raw.mint,
    amountBaseUnits: raw.amount,
    timeoutSeconds: 60,
    isPrivate: false,
    taskSpecHash: hashCanonical({ job: "refund" }),
    policyHash: raw.policy_hash,
    quoteHash: hashCanonical(raw),
  };
  new ManifestStore(join(root, "manifests")).save(taskState.toBase58(), {
    manifest,
    manifestHash: hashCanonical(manifest),
    initializeSignature: "init",
  });
  const taskKey = hashCanonical({
    buyer: buyer.toBase58(),
    task_id: taskId.toString(),
  });
  journal.write(join(root, "tasks", `${taskKey}.quote.json`), raw);
  writeFileSync(
    join(root, "tasks", `${taskKey}.identity`),
    hashCanonical({
      buyer: buyer.toBase58(),
      task_id: taskId.toString(),
      service_id: raw.service_id,
      is_private: false,
      input: { job: "refund" },
    })
  );
  const writeIntent = (
    kind: "funding" | "refund" | "settlement" | "cancel"
  ) => {
    if (kind === "refund")
      mkdirSync(join(root, "refund-retry-evidence"), { recursive: true });
    const operation = {
      programId: program.toBase58(),
      taskState: taskState.toBase58(),
      kind,
      binding: "a".repeat(64),
    };
    const id = hashCanonical({
      programId: operation.programId,
      taskState: operation.taskState,
      kind,
    });
    journal.write(join(root, "transactions", `${id}.intent`), {
      operation,
      state: "UNKNOWN_FINANCIAL_OUTCOME",
    });
    return { id, operation };
  };
  writeIntent("funding");
  let chainClock = 99;
  let status: TaskStateView["status"] = "pending";
  let refundFinding = finding("refund", "UNKNOWN_FINANCIAL_OUTCOME");
  const state = (): TaskStateView => ({
    buyer: buyer.toBase58(),
    seller: sellerOwner,
    verifier: verifier.toBase58(),
    mint: mint.toBase58(),
    taskId,
    amount: 10n,
    deadlineUnix: 100,
    status,
    isPrivate: false,
    bump: 255,
  });
  const submit = vi.fn(async () => {
    status = "refunded";
    refundFinding = finding("refund", "PROVEN_OCCURRED", "3".repeat(88));
    return "3".repeat(88);
  });
  const retry = vi.fn(
    async (_request, proveSafe: (signature: string) => Promise<boolean>) => {
      if (!(await proveSafe("3".repeat(88)))) throw new Error("unsafe retry");
      return submit();
    }
  );
  const options = {
    stateDirectory: root,
    sellerUrl: "https://fixture.example",
    programId: program,
    expectedMint: mint,
    buyer,
    verifier,
    reader: {
      refundOperation: async () => ({
        programId: program.toBase58(),
        taskState: taskState.toBase58(),
        kind: "refund" as const,
        binding: "a".repeat(64),
      }),
      refundState: async () => ({
        state: state(),
        slot: 10,
        clockUnix: chainClock,
      }),
      reconcileFinancial: async (request) =>
        request.operation.kind === "refund"
          ? refundFinding
          : finding(request.operation.kind, "PROVEN_OCCURRED"),
    },
    submitter: {
      refundExpired: submit,
      retryRefundExpired: retry,
    },
    claims: new ReconciliationClaims(join(root, "refund-claims"), {
      probe: () => "test-incarnation",
    }),
  } satisfies ConstructorParameters<typeof RefundScheduler>[0];
  return {
    root,
    taskKey,
    journal,
    options,
    submit,
    retry,
    writeIntent,
    taskState: taskState.toBase58(),
    setClock(value: number) {
      chainClock = value;
    },
    setStatus(value: TaskStateView["status"]) {
      status = value;
    },
    setRefundFinding(value: FinancialReconciliationResult) {
      refundFinding = value;
    },
  };
}

describe("4A.7 refund scheduler evidence gate", () => {
  it("does not refund before the chain deadline, including deadline minus one", async () => {
    const f = fixture();
    const result = await new RefundScheduler(f.options).runTask(f.taskKey);
    expect(result.status).toBe("RECORDED");
    if (result.status === "RECORDED")
      expect(result.record.outcome).toBe("BLOCKED");
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("submits at the exact Solana Clock deadline and confirms the result", async () => {
    const f = fixture();
    f.setClock(100);
    const result = await new RefundScheduler(f.options).runTask(f.taskKey);
    expect(result.status).toBe("RECORDED");
    if (result.status === "RECORDED")
      expect(result.record.outcome).toBe("CONFIRMED");
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it("submits at the deadline plus one using chain Clock", async () => {
    const f = fixture();
    f.setClock(101);
    const result = await new RefundScheduler(f.options).runTask(f.taskKey);
    expect(result.status).toBe("RECORDED");
    if (result.status === "RECORDED")
      expect(result.record.outcome).toBe("CONFIRMED");
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it("blocks a prior refund with unknown outcome", async () => {
    const f = fixture();
    f.setClock(101);
    f.writeIntent("refund");
    const result = await new RefundScheduler(f.options).runTask(f.taskKey);
    expect(result.status).toBe("RECORDED");
    if (result.status === "RECORDED")
      expect(result.record.outcome).toBe("BLOCKED");
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.retry).not.toHaveBeenCalled();
  });
  it("allows only a refund-specific SAFE_TO_RETRY classification", async () => {
    const f = fixture();
    f.setClock(101);
    f.writeIntent("refund");
    f.setRefundFinding(finding("refund", "SAFE_TO_RETRY", "3".repeat(88)));
    const result = await new RefundScheduler(f.options).runTask(f.taskKey);
    expect(result.status).toBe("RECORDED");
    if (result.status === "RECORDED")
      expect(result.record.outcome).toBe("CONFIRMED");
    expect(f.retry).toHaveBeenCalledTimes(1);
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it("blocks a second automatic refund replacement and an absent retry-evidence family", async () => {
    for (const lostFamily of [false, true]) {
      const f = fixture();
      f.setClock(101);
      const { id, operation } = f.writeIntent("refund");
      const current = {
        signature: "4".repeat(88),
        blockhash: key(),
        lastValidBlockHeight: 20,
        fingerprint: operation.binding,
        signedAtUnix: 10,
      };
      f.journal.write(
        join(f.root, "transactions", `${id}.transaction.json`),
        current
      );
      f.setRefundFinding(finding("refund", "SAFE_TO_RETRY", current.signature));
      if (lostFamily)
        rmSync(join(f.root, "refund-retry-evidence"), { recursive: true });
      else
        f.journal.write(
          join(f.root, "refund-retry-evidence", `${id}.prior.json`),
          {
            operation,
            prepared: { ...current, signature: "3".repeat(88) },
          }
        );
      const result = await new RefundScheduler(f.options).runTask(f.taskKey);
      expect(result.status).toBe("RECORDED");
      if (result.status === "RECORDED")
        expect(result.record.outcome).toBe("BLOCKED");
      expect(f.retry).not.toHaveBeenCalled();
      expect(f.submit).not.toHaveBeenCalled();
    }
  });
  it("does not submit against settled or refunded TaskState", async () => {
    for (const status of ["settled", "refunded"] as const) {
      const f = fixture();
      f.setClock(101);
      f.setStatus(status);
      const result = await new RefundScheduler(f.options).runTask(f.taskKey);
      expect(result.status).toBe("RECORDED");
      if (result.status === "RECORDED")
        expect(result.record.outcome).toBe("BLOCKED");
      expect(f.submit).not.toHaveBeenCalled();
    }
  });
  it("fails closed when Clock, TaskState binding, or financial history is unavailable", async () => {
    for (const failure of ["clock", "binding", "history"] as const) {
      const f = fixture();
      f.setClock(101);
      if (failure === "clock")
        f.options.reader.refundState = async () => {
          throw new Error("RPC unavailable");
        };
      if (failure === "binding")
        f.options.reader.refundState = async () => ({
          state: {
            buyer: key(),
            seller: key(),
            verifier: key(),
            mint: key(),
            taskId: 41n,
            amount: 10n,
            deadlineUnix: 100,
            status: "pending",
            isPrivate: false,
            bump: 255,
          },
          slot: 10,
          clockUnix: 101,
        });
      if (failure === "history")
        f.options.reader.reconcileFinancial = async () => {
          throw new Error("history unavailable");
        };
      const result = await new RefundScheduler(f.options).runTask(f.taskKey);
      expect(result.status).toBe("RECORDED");
      if (result.status === "RECORDED")
        expect(result.record.outcome).toBe("BLOCKED");
      expect(f.submit).not.toHaveBeenCalled();
    }
  });
  it("does not borrow SAFE_TO_RETRY from a cancellation or settlement", async () => {
    for (const kind of ["cancel", "settlement"] as const) {
      const f = fixture();
      f.setClock(101);
      f.writeIntent(kind);
      f.options.reader.reconcileFinancial = async (request) =>
        request.operation.kind === kind
          ? finding(kind, "SAFE_TO_RETRY", "3".repeat(88))
          : finding(request.operation.kind, "PROVEN_OCCURRED");
      const result = await new RefundScheduler(f.options).runTask(f.taskKey);
      expect(result.status).toBe("RECORDED");
      if (result.status === "RECORDED")
        expect(result.record.outcome).toBe("BLOCKED");
      expect(f.submit).not.toHaveBeenCalled();
    }
  });
  it("rejects corrupt refund intent and corrupt scheduler claim", async () => {
    const f = fixture();
    f.setClock(101);
    const prior = f.writeIntent("refund");
    const intentPath = join(f.root, "transactions", `${prior.id}.intent`);
    writeFileSync(intentPath, readFileSync(intentPath, "utf8").slice(0, 8));
    const first = await new RefundScheduler(f.options).runTask(f.taskKey);
    expect(first.status).toBe("RECORDED");
    if (first.status === "RECORDED")
      expect(first.record.outcome).toBe("BLOCKED");
    expect(f.submit).not.toHaveBeenCalled();
    const g = fixture();
    const claimKey = hashCanonical({
      version: "1",
      taskKey: g.taskKey,
      operation: "refund",
    });
    const claim = g.options.claims.acquire(claimKey);
    expect(claim.status).toBe("ACQUIRED");
    const claimPath = join(
      g.root,
      "refund-claims",
      "reconciliation",
      "claims",
      `${claimKey}.claim`
    );
    writeFileSync(claimPath, "{truncated");
    const second = await new RefundScheduler(g.options).runTask(g.taskKey);
    expect(second.status).toBe("OPERATOR_REVIEW_REQUIRED");
    expect(g.submit).not.toHaveBeenCalled();
  });
  it("recovers an expired claim only after the recorded process incarnation is gone", async () => {
    const f = fixture();
    f.setClock(101);
    let time = 1_000;
    const root = join(f.root, "refund-claims");
    const old = new ReconciliationClaims(root, {
      now: () => time,
      leaseMs: 1_000,
      probe: () => "old-incarnation",
    });
    const claimKey = hashCanonical({
      version: "1",
      taskKey: f.taskKey,
      operation: "refund",
    });
    expect(old.acquire(claimKey).status).toBe("ACQUIRED");
    time = 2_001;
    const stillPresent = new ReconciliationClaims(root, {
      now: () => time,
      leaseMs: 1_000,
      probe: () => "old-incarnation",
    });
    expect(
      (
        await new RefundScheduler({
          ...f.options,
          claims: stillPresent,
        }).runTask(f.taskKey)
      ).status
    ).toBe("BUSY");
    const gone = new ReconciliationClaims(root, {
      now: () => time,
      leaseMs: 1_000,
      probe: () => "new-incarnation",
    });
    const result = await new RefundScheduler({
      ...f.options,
      claims: gone,
    }).runTask(f.taskKey);
    expect(result.status).toBe("RECORDED");
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it("allows only one active scheduler to hold the refund claim", async () => {
    const f = fixture();
    f.setClock(101);
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.options.submitter.refundExpired = vi.fn(async () => {
      reached();
      await barrier;
      return f.submit();
    });
    const first = new RefundScheduler(f.options).runTask(f.taskKey);
    await entered;
    const other = new RefundScheduler({
      ...f.options,
      claims: new ReconciliationClaims(join(f.root, "refund-claims"), {
        probe: () => "test-incarnation",
      }),
    });
    expect((await other.runTask(f.taskKey)).status).toBe("BUSY");
    release();
    expect((await first).status).toBe("RECORDED");
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it("keeps lost RPC acknowledgement ambiguous and does not resubmit on restart", async () => {
    const f = fixture();
    f.setClock(101);
    f.options.submitter.refundExpired = vi.fn(async () => {
      f.writeIntent("refund");
      f.setRefundFinding(
        finding("refund", "UNKNOWN_FINANCIAL_OUTCOME", "3".repeat(88))
      );
      throw new Error("RPC reply lost");
    });
    const first = await new RefundScheduler(f.options).runTask(f.taskKey);
    expect(first.status).toBe("RECORDED");
    if (first.status === "RECORDED")
      expect(first.record.outcome).toBe("AMBIGUOUS");
    const restarted = await new RefundScheduler(f.options).runTask(f.taskKey);
    expect(restarted.status).toBe("RECORDED");
    if (restarted.status === "RECORDED")
      expect(restarted.record.outcome).toBe("BLOCKED");
    expect(f.options.submitter.refundExpired).toHaveBeenCalledTimes(1);
  });
  it("recognizes a confirmed refund without local scheduler completion", async () => {
    const f = fixture();
    f.setClock(101);
    f.setStatus("refunded");
    f.writeIntent("refund");
    f.setRefundFinding(finding("refund", "PROVEN_OCCURRED", "3".repeat(88)));
    const result = await new RefundScheduler(f.options).runTask(f.taskKey);
    expect(result.status).toBe("RECORDED");
    if (result.status === "RECORDED")
      expect(result.record.outcome).toBe("CONFIRMED");
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("cannot turn a manual refund race into a second submission", async () => {
    const f = fixture();
    f.setClock(101);
    f.options.submitter.refundExpired = vi.fn(async () => {
      f.setStatus("refunded");
      throw new Error("manual refund won the chain race");
    });
    const first = await new RefundScheduler(f.options).runTask(f.taskKey);
    expect(first.status).toBe("RECORDED");
    const second = await new RefundScheduler(f.options).runTask(f.taskKey);
    expect(second.status).toBe("RECORDED");
    if (second.status === "RECORDED")
      expect(second.record.outcome).toBe("BLOCKED");
    expect(f.options.submitter.refundExpired).toHaveBeenCalledTimes(1);
  });
  it.each(["settled", "refunded"] as const)(
    "reconciles a %s chain transition racing the refund submission",
    async (ending) => {
      const f = fixture();
      f.setClock(101);
      f.options.submitter.refundExpired = vi.fn(async () => {
        f.setStatus(ending);
        throw new Error("competing chain transition won");
      });
      const first = await new RefundScheduler(f.options).runTask(f.taskKey);
      expect(first.status).toBe("RECORDED");
      if (first.status === "RECORDED")
        expect(first.record.outcome).toBe("AMBIGUOUS");
      const restart = await new RefundScheduler(f.options).runTask(f.taskKey);
      expect(restart.status).toBe("RECORDED");
      if (restart.status === "RECORDED")
        expect(restart.record.outcome).toBe("BLOCKED");
      expect(f.options.submitter.refundExpired).toHaveBeenCalledTimes(1);
    }
  );
  it.each([
    "after_claim",
    "after_inventory",
    "after_reconciliation",
    "after_eligibility",
    "before_submit",
    "after_submit",
    "after_chain_confirmation",
    "before_record_persist",
    "after_record_persist",
  ])(
    "restart after injected %s boundary never makes a second refund",
    async (stage) => {
      const f = fixture();
      f.setClock(101);
      f.options.submitter.refundExpired = vi.fn(async () => {
        f.writeIntent("refund");
        return f.submit();
      });
      let thrown = false;
      const scheduler = new RefundScheduler({
        ...f.options,
        fault: (point) => {
          if (point === stage && !thrown) {
            thrown = true;
            throw new Error("simulated process interruption");
          }
        },
      });
      try {
        await scheduler.runTask(f.taskKey);
      } catch {
        /* local fault boundary */
      }
      const attempts = f.options.submitter.refundExpired.mock.calls.length;
      const restarted = await new RefundScheduler(f.options).runTask(f.taskKey);
      expect(restarted.status).toBe("RECORDED");
      expect(f.options.submitter.refundExpired).toHaveBeenCalledTimes(1);
      expect(attempts).toBe(
        stage.startsWith("after_submit") ||
          stage === "after_chain_confirmation" ||
          stage.endsWith("record_persist")
          ? 1
          : 0
      );
    }
  );
  it("emits bounded aggregate metrics and fixed-field secret-free logs", async () => {
    const f = fixture();
    const events: string[] = [];
    const scheduler = new RefundScheduler({
      ...f.options,
      observe: (event) => events.push(structuredRefundSchedulerLog(event)),
    });
    await scheduler.runCandidates(10);
    expect(events).toHaveLength(1);
    expect(events[0]).not.toContain(f.options.buyer.toBase58());
    expect(events[0]).not.toContain("secretKey");
    const metrics = refundSchedulerMetricsText(scheduler.metricsSnapshot());
    expect(metrics).toContain("setra_refund_scheduler_candidates 1");
    expect(metrics).not.toContain(f.taskKey);
  });
});
