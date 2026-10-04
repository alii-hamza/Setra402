import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableJournal } from "../../src/core/journal.js";
import { ReconciliationClaims } from "../../src/core/reconciliation-claims.js";
import { ReconciliationRecords } from "../../src/core/reconciliation-records.js";
import {
  ReconciliationWorker,
  type ReconciliationSources,
} from "../../src/core/reconciliation-worker.js";
import { createReconciliationSources } from "../../src/core/reconciliation-sources.js";
import { scanRecoveryInventory } from "../../src/core/recovery-inventory.js";
import { inspectVerificationRecovery } from "../../src/verification/recovery.js";
import type {
  FinancialReconciliationResult,
  FinancialRecoveryRequest,
} from "../../src/chain/financial-reconciliation.js";
import type { ProviderEvidenceAssessment } from "../../src/provider/evidence.js";
import { deriveTaskPda, deriveVaultPda } from "../../src/chain/pda.js";
import { hashCanonical } from "../../src/manifest/hash.js";
import { ManifestStore } from "../../src/manifest/store.js";
import type { VerificationRecoveryV1 } from "../../src/verification/recovery.js";

const key = () => Keypair.generate().publicKey.toBase58();
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
});

function fixture(privateTask = false) {
  const root = mkdtempSync(join(tmpdir(), "setra4a6-"));
  roots.push(root);
  const buyer = Keypair.generate().publicKey;
  const program = Keypair.generate().publicKey;
  const taskId = "41";
  const serviceId = "fixture-service";
  const input = { records: [{ id: 1 }] };
  const policy = {
    version: "1",
    level: 1,
    checks: [{ type: "record_count", pointer: "/records", exact: 1 }],
  };
  const [taskState] = deriveTaskPda(program, buyer, BigInt(taskId));
  const [vault] = deriveVaultPda(program, taskState);
  const quote = {
    task_id: taskId,
    program_id: program.toBase58(),
    task_state_pda: taskState.toBase58(),
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
  new ManifestStore(join(root, "manifests")).save(taskState.toBase58(), {
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
  const inventory = {
    stateDirectory: root,
    sellerUrl: "https://fixture.example",
  };
  const verification = (
    classification: VerificationRecoveryV1["classification"] = "UNKNOWN_EXTERNAL_EFFECT"
  ): VerificationRecoveryV1 => ({
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
    classification,
    recommendedAction:
      classification === "SAFE_TO_REVERIFY"
        ? "SAFE_TO_REVERIFY"
        : "READ_ONLY_RECONCILIATION",
    reasons: [],
  });
  return {
    root,
    taskKey,
    journal,
    inventory,
    verification,
    quote,
    buyer: buyer.toBase58(),
  };
}
function worker(
  f: ReturnType<typeof fixture>,
  sources: ReconciliationSources,
  options: {
    now?: () => number;
    probe?: (pid: number) => string | null | undefined;
    fault?: (stage: string) => void;
    maxReadAttempts?: number;
  } = {}
) {
  const claims = new ReconciliationClaims(f.root, {
    ...(options.now ? { now: options.now } : {}),
    probe: options.probe ?? (() => "process-start"),
    leaseMs: 1_000,
  });
  return new ReconciliationWorker({
    stateDirectory: f.root,
    inventory: f.inventory,
    sources,
    claims,
    maxReadAttempts: options.maxReadAttempts ?? 1,
    backoffMs: 0,
    ...(options.now ? { now: options.now } : {}),
    ...(options.fault ? { fault: options.fault } : {}),
  });
}
function financialIntent(f: ReturnType<typeof fixture>) {
  const operation = {
    programId: f.quote.program_id,
    taskState: f.quote.task_state_pda,
    kind: "funding",
    binding: "a".repeat(64),
  };
  f.journal.write(
    join(
      f.root,
      "transactions",
      `${hashCanonical({
        programId: operation.programId,
        taskState: operation.taskState,
        kind: operation.kind,
      })}.intent`
    ),
    { operation, state: "UNKNOWN_FINANCIAL_OUTCOME" }
  );
}
function persistedResult(f: ReturnType<typeof fixture>) {
  const input = { records: [{ id: 1 }] };
  f.journal.write(join(f.root, "tasks", `${f.taskKey}.run.intent`), {
    state: "UNKNOWN_EXTERNAL_EFFECT",
    identity: join(f.root, "tasks", `${f.taskKey}.identity`),
  });
  const checkpointStem = hashCanonical({
    buyer: f.buyer,
    taskId: f.quote.task_id,
  });
  const result = {
    version: "1",
    taskId: f.quote.task_id,
    serviceId: f.quote.service_id,
    result: input,
    resultHash: hashCanonical(input),
    evidence: [],
    completedAtUnix: 50,
    input,
    output_hash: hashCanonical(input),
  };
  f.journal.write(
    join(f.root, "checkpoints", `${checkpointStem}.result.json`),
    result
  );
  return result;
}
function financialResult(
  classification: FinancialReconciliationResult["classification"]
): FinancialReconciliationResult {
  return {
    version: "1",
    kind: "funding",
    classification,
    chainOutcome:
      classification === "PROVEN_OCCURRED"
        ? "OCCURRED"
        : classification === "SAFE_TO_RETRY"
        ? "NOT_OCCURRED"
        : "UNKNOWN",
    receipt: classification === "PROVEN_OCCURRED" ? "CONFIRMED" : "UNRESOLVED",
    preparedSignature: null,
    reason: "authoritative chain observation",
    recommendedAction: "NO_ACTION",
  };
}

describe("4A.6 durable reconciliation worker", () => {
  it("publishes a checksummed, task-bound record without mutating evidence", async () => {
    const f = fixture();
    const before = readFileSync(
      join(f.root, "tasks", `${f.taskKey}.quote.json`)
    );
    const w = worker(f, { verification: async () => f.verification() });
    const result = await w.runTask(f.taskKey);
    expect(result.status).toBe("COMPLETED");
    expect(new ReconciliationRecords(f.root).history(f.taskKey)).toHaveLength(
      1
    );
    expect(
      readFileSync(join(f.root, "tasks", `${f.taskKey}.quote.json`))
    ).toEqual(before);
    expect(readdirSync(join(f.root, "reconciliation", "claims"))).toEqual([]);
    expect((await w.runTask(f.taskKey)).status).toBe("UNCHANGED");
    expect(new ReconciliationRecords(f.root).history(f.taskKey)).toHaveLength(
      1
    );
  });

  it("blocks two workers on one task and permits distinct tasks", async () => {
    const f = fixture();
    const w1 = worker(f, { verification: async () => f.verification() });
    const w2 = worker(f, { verification: async () => f.verification() });
    const held = w1.claims.acquire(f.taskKey);
    expect(held.status).toBe("ACQUIRED");
    expect((await w2.runTask(f.taskKey)).status).toBe("BUSY");
    if (held.status === "ACQUIRED") w1.claims.release(held.claim);
    expect((await w2.runTask(f.taskKey)).status).toBe("COMPLETED");
    const other = fixture();
    expect(
      (
        await worker(other, {
          verification: async () => other.verification(),
        }).runTask(other.taskKey)
      ).status
    ).toBe("COMPLETED");
  });

  it("recovers only expired claims whose OS incarnation is proven gone", () => {
    const f = fixture();
    let time = 1_000;
    const old = new ReconciliationClaims(f.root, {
      now: () => time,
      probe: () => "old",
      leaseMs: 1_000,
    });
    expect(old.acquire(f.taskKey).status).toBe("ACQUIRED");
    time = 3_000;
    let observed: string | undefined = "new";
    const unknown = new ReconciliationClaims(f.root, {
      now: () => time,
      probe: () => observed,
      leaseMs: 1_000,
    });
    observed = undefined;
    expect(unknown.acquire(f.taskKey).status).toBe("OPERATOR_REVIEW_REQUIRED");
    observed = "new";
    const recovered = unknown.acquire(f.taskKey);
    expect(recovered.status).toBe("ACQUIRED");
    if (recovered.status === "ACQUIRED")
      expect(recovered.recoveredStale).toBe(true);
  });

  it("preserves unknown external and financial outcomes when readers are unavailable", async () => {
    const f = fixture();
    financialIntent(f);
    f.journal.write(join(f.root, "tasks", `${f.taskKey}.run.intent`), {
      state: "UNKNOWN_EXTERNAL_EFFECT",
      identity: join(f.root, "tasks", `${f.taskKey}.identity`),
    });
    const financial = vi.fn().mockRejectedValue(new Error("RPC unavailable"));
    const provider = vi.fn().mockRejectedValue(new Error("seller unavailable"));
    const result = await worker(
      f,
      { financial, provider, verification: async () => f.verification() },
      { maxReadAttempts: 2 }
    ).runTask(f.taskKey);
    expect(result.status).toBe("COMPLETED");
    if (result.status === "COMPLETED") {
      expect(result.record.classifications).toContain(
        "UNKNOWN_FINANCIAL_OUTCOME"
      );
      expect(result.record.classifications).toContain(
        "UNKNOWN_EXTERNAL_EFFECT"
      );
    }
    expect(financial).toHaveBeenCalledTimes(2);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("never re-verifies while financial ambiguity remains", async () => {
    const f = fixture();
    const reverify = vi.fn();
    financialIntent(f);
    const result = await worker(f, {
      financial: async () => [],
      verification: async () => f.verification("SAFE_TO_REVERIFY"),
      reverify,
    }).runTask(f.taskKey);
    expect(result.status).toBe("COMPLETED");
    expect(reverify).not.toHaveBeenCalled();
    if (result.status === "COMPLETED")
      expect(result.record.classifications).not.toContain("SAFE_TO_REVERIFY");
  });

  it("does not advertise safe reverification without an immutable result", async () => {
    const f = fixture();
    const result = await worker(f, {
      verification: async () => f.verification("SAFE_TO_REVERIFY"),
    }).runTask(f.taskKey);
    expect(result.status).toBe("COMPLETED");
    if (result.status === "COMPLETED")
      expect(result.record.recommendedAction).not.toBe("SAFE_TO_REVERIFY");
  });

  it("fails closed on corrupt claims and unknown record versions", async () => {
    const f = fixture();
    const w = worker(f, { verification: async () => f.verification() });
    f.journal.write(
      join(f.root, "reconciliation", "claims", `${f.taskKey}.claim`),
      { version: "2" }
    );
    expect((await w.runTask(f.taskKey)).status).toBe(
      "OPERATOR_REVIEW_REQUIRED"
    );
  });

  it.each(["PROVEN_OCCURRED", "SAFE_TO_RETRY"] as const)(
    "converges to %s only after authoritative financial evidence",
    async (classification) => {
      const f = fixture();
      financialIntent(f);
      let result = financialResult("UNKNOWN_FINANCIAL_OUTCOME");
      const w = worker(f, {
        financial: async () => [result],
        verification: async () => f.verification(),
      });
      const first = await w.runTask(f.taskKey);
      expect(first.status).toBe("COMPLETED");
      if (first.status === "COMPLETED")
        expect(first.record.classifications).toContain(
          "UNKNOWN_FINANCIAL_OUTCOME"
        );
      result = financialResult(classification);
      const second = await w.runTask(f.taskKey);
      expect(second.status).toBe("COMPLETED");
      if (second.status === "COMPLETED") {
        expect(second.record.classifications).toContain(classification);
        expect(second.record.classifications).not.toContain(
          "UNKNOWN_FINANCIAL_OUTCOME"
        );
        expect(second.record.attempt).toBe(2);
      }
    }
  );

  it("records a provider result appearing later without redispatch", async () => {
    const f = fixture();
    f.journal.write(join(f.root, "tasks", `${f.taskKey}.run.intent`), {
      state: "UNKNOWN_EXTERNAL_EFFECT",
      identity: join(f.root, "tasks", `${f.taskKey}.identity`),
    });
    let status: ProviderEvidenceAssessment["status"] =
      "UNKNOWN_EXTERNAL_EFFECT";
    const provider = vi.fn(
      async () =>
        ({
          status,
          evidence: {
            record_state:
              status === "UNKNOWN_EXTERNAL_EFFECT"
                ? "INTENT_ONLY"
                : "RESULT_PERSISTED",
            input_hash: "a".repeat(64),
            result_hash:
              status === "UNKNOWN_EXTERNAL_EFFECT" ? null : "b".repeat(64),
          },
        } as ProviderEvidenceAssessment)
    );
    const w = worker(f, {
      provider,
      verification: async () => f.verification(),
    });
    const first = await w.runTask(f.taskKey);
    expect(first.status).toBe("COMPLETED");
    if (first.status === "COMPLETED")
      expect(first.record.classifications).toContain("UNKNOWN_EXTERNAL_EFFECT");
    status = "RESULT_PERSISTED_UNVERIFIED";
    const second = await w.runTask(f.taskKey);
    expect(second.status).toBe("COMPLETED");
    if (second.status === "COMPLETED")
      expect(second.record.classifications).not.toContain(
        "UNKNOWN_EXTERNAL_EFFECT"
      );
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("moves voucher issuance uncertainty only when receipt evidence appears", async () => {
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
    let classification: "UNKNOWN_EXTERNAL_EFFECT" | "PROVEN_OCCURRED" =
      "UNKNOWN_EXTERNAL_EFFECT";
    const w = worker(f, {
      verification: async () => f.verification(),
      voucher: async () => ({
        version: "1",
        classification,
        localIntent: "VALID",
        localResponse:
          classification === "PROVEN_OCCURRED" ? "VALID" : "ABSENT",
        sellerEvidence:
          classification === "PROVEN_OCCURRED"
            ? "RESPONSE_PERSISTED"
            : "INTENT_ONLY",
        mintIdentity: "MATCHES",
      }),
    });
    const first = await w.runTask(f.taskKey);
    if (first.status === "COMPLETED")
      expect(first.record.classifications).toContain("UNKNOWN_EXTERNAL_EFFECT");
    classification = "PROVEN_OCCURRED";
    const second = await w.runTask(f.taskKey);
    if (second.status === "COMPLETED")
      expect(second.record.classifications).not.toContain(
        "UNKNOWN_EXTERNAL_EFFECT"
      );
    expect(second.status).toBe("COMPLETED");
  });

  it.each([
    "after_claim",
    "after_inventory",
    "after_chain_query",
    "after_provider_query",
    "after_verification_query",
    "before_record_publish",
    "after_record_publish",
  ])("restarts safely after %s boundary", async (stage) => {
    const f = fixture();
    const sources = { verification: async () => f.verification() };
    await expect(
      worker(f, sources, {
        fault: (point) => {
          if (point === stage) throw new Error("simulated crash");
        },
      }).runTask(f.taskKey)
    ).rejects.toThrow("simulated crash");
    const result = await worker(f, sources).runTask(f.taskKey);
    expect(["COMPLETED", "UNCHANGED"]).toContain(result.status);
    expect(new ReconciliationRecords(f.root).history(f.taskKey)).toHaveLength(
      1
    );
  });

  it("does not settle when a PASS verification report already exists", async () => {
    const f = fixture();
    const reverify = vi.fn();
    const result = await worker(f, {
      verification: async () => ({
        ...f.verification("PROVEN_OCCURRED"),
        reportVerdict: "PASS_RECORDED",
      }),
      reverify,
    }).runTask(f.taskKey);
    expect(result.status).toBe("COMPLETED");
    expect(reverify).not.toHaveBeenCalled();
  });

  it("reverifies a valid immutable saved result once and never invokes settlement", async () => {
    const f = fixture();
    const result = persistedResult(f);
    const provider = async () =>
      ({
        status: "RESULT_PERSISTED_UNVERIFIED",
        evidence: {
          record_state: "RESULT_PERSISTED",
          input_hash: hashCanonical(result.input),
          result_hash: result.resultHash,
        },
      } as ProviderEvidenceAssessment);
    const reverify = vi.fn(async () => ({
      taskId: f.quote.task_id,
      serviceId: f.quote.service_id,
      level: 1 as const,
      manifestHash: "a".repeat(64),
      policyHash: f.quote.policy_hash,
      resultHash: result.resultHash,
      checks: [{ type: "record_count", passed: true, message: "count" }],
      passed: true,
      verifierPubkey: f.quote.verifier,
      startedAtUnix: 50,
      completedAtUnix: 51,
    }));
    const sources = {
      provider,
      verification: async () =>
        inspectVerificationRecovery({ ...f.inventory, taskKey: f.taskKey }),
      reverify,
    };
    const view = await sources.verification();
    expect(view.classification).toBe("SAFE_TO_REVERIFY");
    const run = await worker(f, sources).runTask(f.taskKey);
    expect(run.status).toBe("COMPLETED");
    expect(reverify).toHaveBeenCalledTimes(1);
    expect(
      run.status === "COMPLETED" &&
        run.record.findings.some((item) => item.source === "REVERIFICATION")
    ).toBe(true);
  });

  it("blocks reverification when an unattributed sandbox lease remains", async () => {
    const f = fixture();
    persistedResult(f);
    const reverify = vi.fn();
    const result = await worker(f, {
      provider: async () =>
        ({
          status: "RESULT_PERSISTED_UNVERIFIED",
          evidence: {
            record_state: "RESULT_PERSISTED",
            input_hash: "a".repeat(64),
            result_hash: "b".repeat(64),
          },
        } as ProviderEvidenceAssessment),
      verification: async () => ({
        ...f.verification("SAFE_TO_REVERIFY"),
        evidence: {
          manifest: "VALID",
          quote: "VALID",
          result: "VALID",
          report: "ABSENT",
          sourceChallenge: "NOT_REQUIRED",
        },
        sandboxLeases: [
          {
            container: "unassigned",
            owner: "PID_ABSENT",
            containerState: "NOT_QUERIED",
          },
        ],
      }),
      reverify,
    }).runTask(f.taskKey);
    expect(result.status).toBe("COMPLETED");
    expect(reverify).not.toHaveBeenCalled();
  });

  it("preserves reconciliation-required when a private mint identity changes", async () => {
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
    const result = await worker(f, {
      verification: async () => f.verification(),
      voucher: async () => ({
        version: "1",
        classification: "RECONCILIATION_REQUIRED",
        localIntent: "VALID",
        localResponse: "ABSENT",
        sellerEvidence: "CONFLICT",
        mintIdentity: "CHANGED",
      }),
    }).runTask(f.taskKey);
    expect(result.status).toBe("COMPLETED");
    if (result.status === "COMPLETED")
      expect(result.record.classifications).toContain(
        "RECONCILIATION_REQUIRED"
      );
  });

  it("restarts after publication without duplicating the same evidence record", async () => {
    const f = fixture();
    let now = 1_000;
    const sources = { verification: async () => f.verification() };
    const first = worker(f, sources, {
      now: () => now,
      probe: () => "old",
      fault: (point) => {
        if (point === "before_claim_release")
          throw new Error("process terminated");
      },
    });
    await expect(first.runTask(f.taskKey)).rejects.toThrow(
      "process terminated"
    );
    expect(new ReconciliationRecords(f.root).history(f.taskKey)).toHaveLength(
      1
    );
    expect(
      (
        await worker(f, sources, {
          now: () => now,
          probe: () => "new",
        }).runTask(f.taskKey)
      ).status
    ).toBe("BUSY");
    now = 3_000;
    const resumed = await worker(f, sources, {
      now: () => now,
      probe: () => "new",
    }).runTask(f.taskKey);
    expect(resumed.status).toBe("UNCHANGED");
    expect(new ReconciliationRecords(f.root).history(f.taskKey)).toHaveLength(
      1
    );
  });

  it("binds the concrete financial reader to the committed quote and manifest", async () => {
    const f = fixture();
    financialIntent(f);
    const reconcileFinancial = vi.fn(
      async (_request: FinancialRecoveryRequest) =>
        financialResult("PROVEN_OCCURRED")
    );
    const sources = createReconciliationSources({
      stateDirectory: f.root,
      sellerUrl: f.inventory.sellerUrl,
      programId: new PublicKey(f.quote.program_id),
      expectedMint: new PublicKey(f.quote.mint),
      verifier: new PublicKey(f.quote.verifier),
      chain: { reconcileFinancial },
    });
    const task = scanRecoveryInventory(f.inventory).tasks.find(
      (item) => item.taskKey === f.taskKey
    )!;
    const result = await sources.financial!(task);
    expect(result[0]?.classification).toBe("PROVEN_OCCURRED");
    expect(reconcileFinancial).toHaveBeenCalledTimes(1);
    expect(reconcileFinancial.mock.calls[0]?.[0].manifest.manifest.taskId).toBe(
      f.quote.task_id
    );
    expect(reconcileFinancial.mock.calls[0]?.[0].operation.taskState).toBe(
      f.quote.task_state_pda
    );
  });
});
