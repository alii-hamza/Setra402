import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { DurableJournal } from "../../src/core/journal.js";
import {
  ReconciliationClaims,
  processStartIdentity,
} from "../../src/core/reconciliation-claims.js";
import { ReconciliationWorker } from "../../src/core/reconciliation-worker.js";
import { OperatorRecovery } from "../../src/core/operator-recovery.js";
import { inspectOperatorHealth } from "../../src/core/operator-health.js";
import {
  metricsText,
  structuredReconciliationLog,
  type ReconciliationLogV1,
} from "../../src/core/operator-telemetry.js";
import { runOperatorCli } from "../../src/core/operator-cli.js";
import { deriveTaskPda, deriveVaultPda } from "../../src/chain/pda.js";
import { hashCanonical } from "../../src/manifest/hash.js";
import { ManifestStore } from "../../src/manifest/store.js";
import type { VerificationRecoveryV1 } from "../../src/verification/recovery.js";

const key = () => Keypair.generate().publicKey.toBase58();
function fixture(privateTask = false) {
  const root = mkdtempSync(join(tmpdir(), "setra4a8-"));
  const buyer = Keypair.generate().publicKey,
    program = Keypair.generate().publicKey,
    taskId = "41";
  const policy = {
    version: "1",
    level: 1,
    checks: [{ type: "record_count", pointer: "/records", exact: 1 }],
  };
  const input = { records: [{ id: 1 }] },
    serviceId = "fixture-service";
  const [pda] = deriveTaskPda(program, buyer, BigInt(taskId));
  const [vault] = deriveVaultPda(program, pda);
  const quote = {
    task_id: taskId,
    program_id: program.toBase58(),
    task_state_pda: pda.toBase58(),
    vault_pda: vault.toBase58(),
    mint: key(),
    seller_token_account: key(),
    verifier: key(),
    amount: "10",
    timeout_seconds: 60,
    is_private: privateTask,
    protocol_fee_bps: 100,
    service_id: serviceId,
    verification_policy: policy,
    policy_hash: hashCanonical(policy),
  };
  const manifest = {
    version: "1" as const,
    taskId,
    serviceId,
    buyer: buyer.toBase58(),
    sellerTokenAccount: quote.seller_token_account,
    sellerOwner: key(),
    verifier: quote.verifier,
    mint: quote.mint,
    amountBaseUnits: "10",
    timeoutSeconds: 60,
    isPrivate: privateTask,
    taskSpecHash: hashCanonical(input),
    policyHash: quote.policy_hash,
    quoteHash: hashCanonical(quote),
  };
  const taskKey = hashCanonical({ buyer: buyer.toBase58(), task_id: taskId });
  new ManifestStore(join(root, "manifests")).save(pda.toBase58(), {
    manifest,
    manifestHash: hashCanonical(manifest),
    initializeSignature: "init",
  });
  const journal = new DurableJournal();
  journal.write(join(root, "tasks", `${taskKey}.quote.json`), quote);
  writeFileSync(
    join(root, "tasks", `${taskKey}.identity`),
    hashCanonical({
      buyer: buyer.toBase58(),
      task_id: taskId,
      service_id: serviceId,
      is_private: privateTask,
      input,
    })
  );
  for (const family of [
    "transactions",
    "checkpoints",
    "vouchers",
    "challenges",
    "sandbox-leases",
  ])
    mkdirSync(join(root, family), { recursive: true });
  const inventory = {
    stateDirectory: root,
    sellerUrl: "https://fixture.example",
  };
  const operator = (
    options: {
      now?: () => number;
      probe?: (pid: number) => string | null | undefined;
    } = {}
  ) => new OperatorRecovery(inventory, options);
  const verification = (): VerificationRecoveryV1 => ({
    version: "1",
    taskKey,
    evidence: {
      manifest: "VALID",
      quote: "VALID",
      result: "ABSENT",
      report: "ABSENT",
      sourceChallenge: "NOT_REQUIRED",
    },
    sandboxLeases: [],
    reportVerdict: "NONE",
    classification: "UNKNOWN_EXTERNAL_EFFECT",
    recommendedAction: "READ_ONLY_RECONCILIATION",
    reasons: [],
  });
  const reconcile = async (
    options: {
      financial?: boolean;
      provider?: boolean;
      observe?: (event: ReconciliationLogV1) => void;
    } = {}
  ) => {
    const claims = new ReconciliationClaims(root, {
      probe: () => "process-start",
    });
    return new ReconciliationWorker({
      stateDirectory: root,
      inventory,
      sources: {
        ...(options.financial
          ? {
              financial: async () => [
                {
                  version: "1" as const,
                  kind: "funding" as const,
                  classification: "UNKNOWN_FINANCIAL_OUTCOME" as const,
                  chainOutcome: "UNKNOWN" as const,
                  receipt: "UNRESOLVED" as const,
                  preparedSignature: null,
                  reason: "chain unavailable",
                  recommendedAction: "READ_ONLY_RECONCILIATION" as const,
                },
              ],
            }
          : {}),
        ...(options.provider
          ? {
              provider: async () => ({
                status: "UNKNOWN_EXTERNAL_EFFECT" as const,
                evidence: {
                  record_state: "INTENT_ONLY" as const,
                  input_hash: "a".repeat(64),
                  result_hash: null,
                } as never,
              }),
            }
          : {}),
        verification: async () => verification(),
      },
      claims,
      maxReadAttempts: 1,
      backoffMs: 0,
      ...(options.observe ? { observe: options.observe } : {}),
    }).runTask(taskKey);
  };
  const addFinancial = () => {
    const operation = {
      programId: quote.program_id,
      taskState: quote.task_state_pda,
      kind: "funding",
      binding: "a".repeat(64),
    };
    journal.write(
      join(
        root,
        "transactions",
        `${hashCanonical({
          programId: operation.programId,
          taskState: operation.taskState,
          kind: operation.kind,
        })}.intent`
      ),
      { operation, state: "UNKNOWN_FINANCIAL_OUTCOME" }
    );
  };
  const addRun = () =>
    journal.write(join(root, "tasks", `${taskKey}.run.intent`), {
      state: "UNKNOWN_EXTERNAL_EFFECT",
      identity: join(root, "tasks", `${taskKey}.identity`),
    });
  return {
    root,
    taskKey,
    inventory,
    operator,
    reconcile,
    journal,
    quote,
    addFinancial,
    addRun,
    buyer: buyer.toBase58(),
  };
}

describe("4A.8 read-only operator evidence", () => {
  it("observes a real OS process-start identity for the active worker", () => {
    expect(processStartIdentity(process.pid)).toMatch(/\S+/);
  });
  it("shows task identity, stable correlation, and separate chain/local/provider provenance", async () => {
    const f = fixture();
    f.addFinancial();
    f.addRun();
    await f.reconcile({ financial: true, provider: true });
    const detail = f.operator().task(f.taskKey)!;
    expect(detail.identity?.taskId).toBe("41");
    expect(detail.correlationId).toBe(
      hashCanonical({ version: "1", taskKey: f.taskKey })
    );
    expect(detail.evidence.local.manifest).toHaveLength(1);
    expect(detail.evidence.chain).toHaveLength(1);
    expect(detail.evidence.provider).toHaveLength(1);
    expect(detail.classifications).toContain("UNKNOWN_FINANCIAL_OUTCOME");
    expect(detail.classifications).toContain("UNKNOWN_EXTERNAL_EFFECT");
    expect(detail.onChainState).toBe("NOT_QUERIED");
  });
  it("bounds pagination and filters unresolved tasks without executing retries", () => {
    const f = fixture();
    const view = f.operator();
    expect(view.list("ALL", 0, 1).items).toHaveLength(1);
    expect(view.list("UNKNOWN_EXTERNAL_EFFECT").total).toBe(0);
    expect(view.list("ALL", 1, 1).items).toHaveLength(0);
    expect(() => view.list("ALL", 0, 101)).toThrow();
    expect(() => view.list("BOGUS" as never)).toThrow();
  });
  it("keeps a safe-to-retry recommendation advisory and refresh read-only", async () => {
    const f = fixture();
    f.addFinancial();
    const before = readFileSync(
      join(
        f.root,
        "transactions",
        `${hashCanonical({
          programId: f.quote.program_id,
          taskState: f.quote.task_state_pda,
          kind: "funding",
        })}.intent`
      )
    );
    const detail = f.operator().refresh(f.taskKey)!;
    expect(detail.classifications).toContain("UNKNOWN_FINANCIAL_OUTCOME");
    expect(
      readFileSync(
        join(
          f.root,
          "transactions",
          `${hashCanonical({
            programId: f.quote.program_id,
            taskState: f.quote.task_state_pda,
            kind: "funding",
          })}.intent`
        )
      )
    ).toEqual(before);
  });
  it("shows stale claims and never takes them over", () => {
    const f = fixture();
    let now = 1_000;
    const claims = new ReconciliationClaims(f.root, {
      now: () => now,
      probe: () => "old",
      leaseMs: 1_000,
    });
    const held = claims.acquire(f.taskKey);
    expect(held.status).toBe("ACQUIRED");
    now = 3_000;
    const view = f
      .operator({ now: () => now, probe: () => "new" })
      .task(f.taskKey)!;
    expect(view.claim.status).toBe("STALE");
    expect(
      f
        .operator({ now: () => now, probe: () => "new" })
        .list("STALE_WORKER_CLAIM").total
    ).toBe(1);
    if (held.status === "ACQUIRED") claims.release(held.claim);
    const history = readdirSync(
      join(f.root, "reconciliation", "claim-history")
    );
    expect(history).toHaveLength(1);
    expect(
      new DurableJournal().read(
        join(f.root, "reconciliation", "claim-history", history[0]!)
      )
    ).toMatchObject({ taskKey: f.taskKey });
  });
  it("warns when durable evidence changes after the last reconciliation", async () => {
    const f = fixture();
    await f.reconcile();
    f.addRun();
    const view = f.operator().task(f.taskKey)!;
    expect(view.unresolvedReasons).toContain(
      "reconciliation observation predates current durable evidence"
    );
    expect(view.recommendedAction).toBe("OPERATOR_REVIEW_REQUIRED");
  });
  it("validates clean, missing-family, corrupt, and incompatible restored state", () => {
    const clean = fixture();
    expect(clean.operator().validateBackup().status).toBe("VALID");
    const missing = fixture();
    rmSync(join(missing.root, "challenges"), { recursive: true });
    expect(missing.operator().validateBackup().status).toBe(
      "VALID_WITH_WARNINGS"
    );
    const stale = fixture();
    writeFileSync(join(stale.root, "tasks", "unknown.tmp"), "stale");
    expect(stale.operator().validateBackup().status).toBe(
      "VALID_WITH_WARNINGS"
    );
    const corrupt = fixture();
    writeFileSync(
      join(corrupt.root, "tasks", `${corrupt.taskKey}.quote.json`),
      "{"
    );
    expect(corrupt.operator().validateBackup().status).toBe("INVALID");
    const incompatible = fixture();
    const altered = { ...incompatible.quote, service_id: "another-service" };
    incompatible.journal.write(
      join(incompatible.root, "tasks", `${incompatible.taskKey}.quote.json`),
      altered
    );
    expect(incompatible.operator().validateBackup().status).toBe(
      "RECONCILIATION_REQUIRED"
    );
  });
  it("rejects an unknown reconciliation version and reports orphan records", async () => {
    const f = fixture();
    await f.reconcile();
    const dir = join(f.root, "reconciliation", "records");
    const file = join(dir, `${f.taskKey}.1.record`);
    f.journal.write(file, { version: "2" });
    expect(f.operator().validateBackup().status).toBe("INVALID");
    expect(f.operator().task(f.taskKey)?.unresolvedReasons).toContain(
      "reconciliation history corrupt or unknown version"
    );
  });
  it("exports aggregate metrics without identifiers or secret-bearing labels", async () => {
    const f = fixture();
    f.addRun();
    await f.reconcile();
    const metrics = f.operator().metrics(),
      text = metricsText(metrics);
    expect(metrics.tasksScanned).toBe(1);
    expect(metrics.reconciliationCompleted).toBe(1);
    expect(metrics.unknownExternalEffect).toBe(1);
    expect(text).not.toContain(f.taskKey);
    expect(text).not.toContain("{");
  });
  it("surfaces unresolved sandbox leases and private voucher intents", () => {
    const f = fixture(true);
    const voucherStem = hashCanonical({
      seller: f.inventory.sellerUrl,
      buyer: f.buyer,
      taskId: f.quote.task_id,
    });
    f.journal.write(join(f.root, "vouchers", `${voucherStem}.intent`), {
      nullifierScalar: "1",
      blindingScalar: "2",
      blindedPointHex: "a".repeat(64),
    });
    f.journal.write(
      join(f.root, "sandbox-leases", "setra402-verify-lease.lease"),
      { broken: true }
    );
    const view = f.operator().task(f.taskKey)!;
    expect(view.voucherUnresolved).toBe(true);
    expect(view.sandboxUnresolved).toBe(true);
    expect(f.operator().list("VOUCHER_UNRESOLVED").total).toBe(1);
    expect(f.operator().list("SANDBOX_UNRESOLVED").total).toBe(1);
    expect(f.operator().metrics().voucherUnresolvedIntents).toBe(1);
  });
  it("displays safe-to-reverify and safe-to-retry as advice without execution", async () => {
    const f = fixture();
    f.addRun();
    const input = { records: [{ id: 1 }] },
      checkpointStem = hashCanonical({
        buyer: f.buyer,
        taskId: f.quote.task_id,
      });
    f.journal.write(
      join(f.root, "checkpoints", `${checkpointStem}.result.json`),
      {
        version: "1",
        taskId: f.quote.task_id,
        serviceId: f.quote.service_id,
        result: input,
        resultHash: hashCanonical(input),
        evidence: [],
        completedAtUnix: 50,
        input,
        output_hash: hashCanonical(input),
      }
    );
    const claims = new ReconciliationClaims(f.root, {
      probe: () => "process-start",
    });
    await new ReconciliationWorker({
      stateDirectory: f.root,
      inventory: f.inventory,
      claims,
      sources: {
        provider: async () =>
          ({
            status: "RESULT_PERSISTED_UNVERIFIED",
            evidence: {
              record_state: "RESULT_PERSISTED",
              input_hash: hashCanonical(input),
              result_hash: hashCanonical(input),
            },
          } as never),
        verification: async () => ({
          version: "1",
          taskKey: f.taskKey,
          evidence: {
            manifest: "VALID",
            quote: "VALID",
            result: "VALID",
            report: "ABSENT",
            sourceChallenge: "NOT_REQUIRED",
          },
          sandboxLeases: [],
          reportVerdict: "NONE",
          classification: "SAFE_TO_REVERIFY",
          recommendedAction: "SAFE_TO_REVERIFY",
          reasons: [],
        }),
      },
      maxReadAttempts: 1,
      backoffMs: 0,
    }).runTask(f.taskKey);
    const view = f.operator().task(f.taskKey)!;
    expect(view.classifications).toContain("SAFE_TO_REVERIFY");
    expect(view.recommendedAction).toBe("SAFE_TO_REVERIFY");
    const g = fixture();
    g.addFinancial();
    await new ReconciliationWorker({
      stateDirectory: g.root,
      inventory: g.inventory,
      claims: new ReconciliationClaims(g.root, {
        probe: () => "process-start",
      }),
      sources: {
        financial: async () => [
          {
            version: "1",
            kind: "funding",
            classification: "SAFE_TO_RETRY",
            chainOutcome: "NOT_OCCURRED",
            receipt: "NONE",
            preparedSignature: null,
            reason: "rooted expiry and absent history",
            recommendedAction: "NO_ACTION",
          },
        ],
        verification: async () => ({
          version: "1",
          taskKey: g.taskKey,
          evidence: {
            manifest: "VALID",
            quote: "VALID",
            result: "ABSENT",
            report: "ABSENT",
            sourceChallenge: "NOT_REQUIRED",
          },
          sandboxLeases: [],
          reportVerdict: "NONE",
          classification: "UNKNOWN_EXTERNAL_EFFECT",
          recommendedAction: "READ_ONLY_RECONCILIATION",
          reasons: [],
        }),
      },
      maxReadAttempts: 1,
      backoffMs: 0,
    }).runTask(g.taskKey);
    expect(g.operator().task(g.taskKey)?.classifications).toContain(
      "SAFE_TO_RETRY"
    );
    expect(g.operator().task(g.taskKey)?.recommendedAction).toBe(
      "SAFE_TO_RETRY"
    );
  });
  it("emits structured events with error class and never logs error messages", async () => {
    const f = fixture();
    f.addRun();
    const events: ReconciliationLogV1[] = [];
    const claims = new ReconciliationClaims(f.root, {
      probe: () => "process-start",
    });
    await new ReconciliationWorker({
      stateDirectory: f.root,
      inventory: f.inventory,
      claims,
      sources: {
        provider: async () => {
          throw new Error("PRIVATE_KEY=secret-value");
        },
        verification: async () => ({
          version: "1",
          taskKey: f.taskKey,
          evidence: {
            manifest: "VALID",
            quote: "VALID",
            result: "ABSENT",
            report: "ABSENT",
            sourceChallenge: "NOT_REQUIRED",
          },
          sandboxLeases: [],
          reportVerdict: "NONE",
          classification: "UNKNOWN_EXTERNAL_EFFECT",
          recommendedAction: "READ_ONLY_RECONCILIATION",
          reasons: [],
        }),
      },
      maxReadAttempts: 1,
      backoffMs: 0,
      observe: (event) => events.push(event),
    }).runTask(f.taskKey);
    expect(
      events.some(
        (event) =>
          event.evidenceSource === "PROVIDER" && event.errorClass === "Error"
      )
    ).toBe(true);
    expect(events.map(structuredReconciliationLog).join("\n")).not.toContain(
      "secret-value"
    );
  });
  it("reports RPC, Docker, disk, and lease health without changing state", async () => {
    const f = fixture();
    const before = readFileSync(
      join(f.root, "tasks", `${f.taskKey}.quote.json`)
    );
    const health = await inspectOperatorHealth(
      f.root,
      {
        rpc: async () => false,
        seller: async () => true,
        redis: async () => false,
        docker: async () => false,
        disk: () => 10,
      },
      100
    );
    expect(health.resources.rpc).toBe("UNAVAILABLE");
    expect(health.resources.docker).toBe("UNAVAILABLE");
    expect(health.resources.diskCapacity).toBe("DEGRADED");
    expect(health.resources.workerLeases).toBe("UNAVAILABLE");
    expect(
      readFileSync(join(f.root, "tasks", `${f.taskKey}.quote.json`))
    ).toEqual(before);
  });
  it("runs only bounded inspection CLI commands", async () => {
    const f = fixture();
    const env = {
      SETRA_STATE_DIR: f.root,
      SETRA_SELLER_URL: f.inventory.sellerUrl,
    };
    expect(
      JSON.parse(await runOperatorCli(["list", "ALL", "0", "1"], env)).total
    ).toBe(1);
    expect(JSON.parse(await runOperatorCli(["validate"], env)).status).toBe(
      "VALID"
    );
    await expect(runOperatorCli(["refund", f.taskKey], env)).rejects.toThrow(
      "usage"
    );
  });
  it("advises refund eligibility only from a matching pending TaskState and chain clock", async () => {
    const f = fixture();
    let now = 90;
    const chain = {
      readTaskState: vi.fn(async () => ({
        buyer: f.buyer,
        seller: key(),
        verifier: f.quote.verifier,
        mint: f.quote.mint,
        taskId: BigInt(f.quote.task_id),
        amount: BigInt(f.quote.amount),
        deadlineUnix: 100,
        status: "pending" as const,
        isPrivate: false,
        bump: 1,
      })),
      readChainUnixTime: vi.fn(async () => now),
    };
    expect(
      (await f.operator().taskWithChain(f.taskKey, chain))?.refundEligibility
    ).toBe("AWAIT_DEADLINE");
    now = 101;
    const eligible = await f.operator().taskWithChain(f.taskKey, chain);
    expect(eligible?.refundEligibility).toBe("ELIGIBLE");
    expect(eligible?.recommendedAction).toBe("REFUND_ELIGIBLE");
    expect((await f.operator().listRefundEligible(chain)).total).toBe(1);
    expect((await f.operator().metricsWithChain(chain)).refundEligible).toBe(1);
    expect(chain.readTaskState).toHaveBeenCalled();
  });
  it("does not infer refund eligibility from an unavailable or conflicting chain read", async () => {
    const f = fixture();
    const unavailable = {
      readTaskState: async () => {
        throw new Error("RPC down");
      },
      readChainUnixTime: async () => 1_000,
    };
    expect(
      (await f.operator().taskWithChain(f.taskKey, unavailable))
        ?.refundEligibility
    ).toBe("UNKNOWN");
    const conflicting = {
      readTaskState: async () => ({
        buyer: key(),
        seller: key(),
        verifier: f.quote.verifier,
        mint: f.quote.mint,
        taskId: 41n,
        amount: 10n,
        deadlineUnix: 1,
        status: "pending" as const,
        isPrivate: false,
        bump: 1,
      }),
      readChainUnixTime: async () => 1_000,
    };
    expect(
      (await f.operator().taskWithChain(f.taskKey, conflicting))
        ?.recommendedAction
    ).toBe("OPERATOR_REVIEW_REQUIRED");
  });
});
