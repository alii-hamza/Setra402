import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DurableJournal } from "./journal.js";
import {
  processStartIdentity,
  reconciliationClaimV1Schema,
  type ProcessIdentityProbe,
  type ReconciliationClaimV1,
} from "./reconciliation-claims.js";
import {
  ReconciliationRecords,
  type ReconciliationFindingV1,
  type ReconciliationRecordV1,
} from "./reconciliation-records.js";
import {
  scanRecoveryInventory,
  type RecoveryInventoryOptions,
  type RecoveryInventoryV1,
} from "./recovery-inventory.js";
import { recoveryInventoryRevision } from "./reconciliation-worker.js";
import { hashCanonical } from "../manifest/hash.js";
import type { OperatorMetricsV1 } from "./operator-telemetry.js";
import { PublicKey } from "@solana/web3.js";
import { deriveTaskPda } from "../chain/pda.js";
import type { TaskStateView } from "../types.js";

type Task = RecoveryInventoryV1["tasks"][number];
export type OperatorFilter =
  | "ALL"
  | "UNKNOWN_EXTERNAL_EFFECT"
  | "UNKNOWN_FINANCIAL_OUTCOME"
  | "RECONCILIATION_REQUIRED"
  | "SAFE_TO_REVERIFY"
  | "SAFE_TO_RETRY"
  | "REFUND_ELIGIBLE"
  | "STALE_WORKER_CLAIM"
  | "SANDBOX_UNRESOLVED"
  | "VOUCHER_UNRESOLVED";
export type ClaimInspection = {
  status: "ABSENT" | "ACTIVE" | "STALE" | "OWNERSHIP_UNKNOWN" | "CORRUPT";
  claim?: ReconciliationClaimV1;
  reason?: string;
};
export type OperatorAction = ReconciliationRecordV1["recommendedAction"];
/** Narrow read-only chain surface; no signer or transaction methods. */
export interface OperatorChainReader {
  readTaskState(taskStatePda: string): Promise<TaskStateView | null>;
  readChainUnixTime(): Promise<number>;
}
export interface OperatorTaskViewV1 {
  version: "1";
  taskKey: string;
  correlationId: string;
  identity: Task["taskIdentity"];
  classifications: string[];
  recommendedAction: OperatorAction;
  evidence: {
    local: Task["evidence"];
    chain: ReconciliationFindingV1[];
    provider: ReconciliationFindingV1[];
    derived: ReconciliationFindingV1[];
  };
  onChainState:
    | "NOT_QUERIED"
    | "NOT_FOUND_AT_READ"
    | "pending"
    | "settled"
    | "refunded"
    | "QUERY_UNAVAILABLE";
  refundEligibility:
    | "NOT_QUERIED"
    | "AWAIT_DEADLINE"
    | "ELIGIBLE"
    | "NOT_APPLICABLE"
    | "UNKNOWN";
  claim: ClaimInspection;
  latestReconciliation: ReconciliationRecordV1 | null;
  unresolvedReasons: string[];
  provenance: ReconciliationRecordV1["evidenceProvenance"];
  sandboxUnresolved: boolean;
  voucherUnresolved: boolean;
}
export interface OperatorListPageV1 {
  version: "1";
  total: number;
  offset: number;
  limit: number;
  items: OperatorTaskViewV1[];
}
export interface BackupValidationV1 {
  version: "1";
  status:
    | "VALID"
    | "VALID_WITH_WARNINGS"
    | "RECONCILIATION_REQUIRED"
    | "INVALID";
  warnings: string[];
  conflicts: string[];
  tasks: number;
}

/** Read-only operator projection; it never constructs a writer, controller, or signer. */
export class OperatorRecovery {
  private readonly records: ReconciliationRecords;
  private readonly journal = new DurableJournal();
  private readonly stateRoot: string;
  constructor(
    private readonly inventoryOptions: RecoveryInventoryOptions,
    private readonly options: {
      now?: () => number;
      probe?: ProcessIdentityProbe;
    } = {}
  ) {
    this.stateRoot = resolve(inventoryOptions.stateDirectory);
    this.records = new ReconciliationRecords(this.stateRoot, false);
  }
  private get now() {
    return this.options.now?.() ?? Date.now();
  }
  private get probe() {
    return this.options.probe ?? processStartIdentity;
  }
  inventory(): RecoveryInventoryV1 {
    return scanRecoveryInventory(this.inventoryOptions);
  }
  inspectClaim(taskKey: string): ClaimInspection {
    if (!/^[0-9a-f]{64}$/.test(taskKey))
      throw new Error("invalid operator task key");
    const path = join(
      this.stateRoot,
      "reconciliation",
      "claims",
      `${taskKey}.claim`
    );
    if (!existsSync(path)) return { status: "ABSENT" };
    try {
      const claim = reconciliationClaimV1Schema.parse(this.journal.read(path));
      if (claim.taskKey !== taskKey)
        throw new Error("claim task binding conflict");
      if (this.now <= claim.expiresAtUnixMs) return { status: "ACTIVE", claim };
      const observed = this.probe(claim.pid);
      if (observed === undefined)
        return {
          status: "OWNERSHIP_UNKNOWN",
          claim,
          reason: "OS process identity unavailable",
        };
      if (observed === claim.processStartIdentity)
        return { status: "ACTIVE", claim };
      return {
        status: "STALE",
        claim,
        reason: "expired lease and recorded process incarnation absent",
      };
    } catch {
      return { status: "CORRUPT", reason: "claim cannot be validated" };
    }
  }
  private view(task: Task, inventory: RecoveryInventoryV1): OperatorTaskViewV1 {
    let latest: ReconciliationRecordV1 | null = null;
    const reasons = [...task.conflicts];
    try {
      latest = this.records.latest(task.taskKey);
    } catch {
      reasons.push("reconciliation history corrupt or unknown version");
    }
    if (latest) {
      try {
        if (
          latest.inventoryRevision !==
          recoveryInventoryRevision(inventory, task)
        )
          reasons.push(
            "reconciliation observation predates current durable evidence"
          );
      } catch {
        reasons.push("current durable evidence cannot be hashed");
      }
    }
    const claim = this.inspectClaim(task.taskKey);
    if (
      claim.status === "CORRUPT" ||
      claim.status === "OWNERSHIP_UNKNOWN" ||
      claim.status === "STALE"
    )
      reasons.push(`worker claim ${claim.status.toLowerCase()}`);
    const findings = latest?.findings ?? [];
    for (const item of findings)
      if (item.status === "UNAVAILABLE" || item.status === "CONFLICT")
        reasons.push(`${item.source}: ${item.reason}`);
    const sandboxUnresolved = inventory.unattached.some(
      (record) => record.family === "sandboxLease"
    );
    const voucher = task.evidence.voucherIssuance ?? [];
    const voucherUnresolved =
      voucher.some((record) => record.role === "intent") &&
      !voucher.some((record) => record.role === "voucher.json");
    const current =
      latest &&
      !reasons.some(
        (reason) =>
          reason.startsWith("reconciliation observation predates") ||
          reason.startsWith("current durable")
      );
    const classifications = [
      ...(current ? latest!.classifications : task.classifications),
    ];
    if (reasons.length && !classifications.includes("RECONCILIATION_REQUIRED"))
      classifications.push("RECONCILIATION_REQUIRED");
    const action = current ? latest!.recommendedAction : task.recommendedAction;
    return {
      version: "1",
      taskKey: task.taskKey,
      correlationId:
        latest?.correlationId ??
        hashCanonical({ version: "1", taskKey: task.taskKey }),
      identity: task.taskIdentity,
      classifications,
      recommendedAction: reasons.length ? "OPERATOR_REVIEW_REQUIRED" : action,
      evidence: {
        local: task.evidence,
        chain: findings.filter((item) => item.authority === "CHAIN"),
        provider: findings.filter((item) => item.authority === "SELLER"),
        derived: findings.filter(
          (item) => item.authority === "DERIVED" || item.authority === "LOCAL"
        ),
      },
      onChainState: "NOT_QUERIED",
      refundEligibility: "NOT_QUERIED",
      claim,
      latestReconciliation: latest,
      unresolvedReasons: reasons,
      provenance: latest?.evidenceProvenance ?? [],
      sandboxUnresolved,
      voucherUnresolved,
    };
  }
  task(taskKey: string): OperatorTaskViewV1 | null {
    const inventory = this.inventory();
    const task = inventory.tasks.find((item) => item.taskKey === taskKey);
    return task ? this.view(task, inventory) : null;
  }
  async taskWithChain(
    taskKey: string,
    chain: OperatorChainReader
  ): Promise<OperatorTaskViewV1 | null> {
    const view = this.task(taskKey);
    if (!view) return null;
    return this.withChain(view, chain);
  }
  private async withChain(
    view: OperatorTaskViewV1,
    chain: OperatorChainReader
  ): Promise<OperatorTaskViewV1> {
    const quoteRecord = view.evidence.local.tasks?.find(
      (record) => record.role === "quote.json" && record.status === "VALID"
    );
    if (!quoteRecord || !view.identity || view.unresolvedReasons.length)
      return view;
    try {
      const quote = this.journal.read(quoteRecord.path) as {
        program_id: string;
        task_state_pda: string;
        mint: string;
        verifier: string;
        amount: string;
      };
      const [expected] = deriveTaskPda(
        new PublicKey(quote.program_id),
        new PublicKey(view.identity.buyer),
        BigInt(view.identity.taskId)
      );
      if (expected.toBase58() !== quote.task_state_pda)
        throw new Error("quote PDA binding conflict");
      const state = await chain.readTaskState(quote.task_state_pda);
      if (!state)
        return {
          ...view,
          onChainState: "NOT_FOUND_AT_READ",
          refundEligibility: "UNKNOWN",
        };
      if (
        state.buyer !== view.identity.buyer ||
        state.taskId !== BigInt(view.identity.taskId) ||
        state.isPrivate !== view.identity.privacy ||
        state.mint !== quote.mint ||
        state.verifier !== quote.verifier ||
        state.amount !== BigInt(quote.amount)
      )
        throw new Error("TaskState immutable binding conflict");
      if (state.status !== "pending")
        return {
          ...view,
          onChainState: state.status,
          refundEligibility: "NOT_APPLICABLE",
        };
      const now = await chain.readChainUnixTime();
      if (!Number.isSafeInteger(now))
        throw new Error("Solana Clock unavailable");
      const eligible = now >= state.deadlineUnix;
      return {
        ...view,
        onChainState: "pending",
        refundEligibility: eligible ? "ELIGIBLE" : "AWAIT_DEADLINE",
        recommendedAction: eligible
          ? "REFUND_ELIGIBLE"
          : view.recommendedAction,
      };
    } catch {
      return {
        ...view,
        onChainState: "QUERY_UNAVAILABLE",
        refundEligibility: "UNKNOWN",
        recommendedAction: "OPERATOR_REVIEW_REQUIRED",
        unresolvedReasons: [
          ...view.unresolvedReasons,
          "authoritative chain observation unavailable or conflicting",
        ],
      };
    }
  }
  async listRefundEligible(
    chain: OperatorChainReader,
    offset = 0,
    limit = 50,
    maxScan = 1_000
  ): Promise<OperatorListPageV1> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(maxScan) ||
      maxScan < 1 ||
      maxScan > 1_000
    )
      throw new Error("invalid refund inspection bounds");
    const inventory = this.inventory();
    if (inventory.tasks.length > maxScan)
      throw new Error("refund inspection scan limit exceeded");
    const inspected: OperatorTaskViewV1[] = [];
    for (let start = 0; start < inventory.tasks.length; start += 8) {
      const chunk = inventory.tasks.slice(start, start + 8);
      inspected.push(
        ...(await Promise.all(
          chunk.map((task) => this.withChain(this.view(task, inventory), chain))
        ))
      );
    }
    const matches = inspected.filter(
      (view): view is OperatorTaskViewV1 =>
        view?.refundEligibility === "ELIGIBLE"
    );
    return {
      version: "1",
      total: matches.length,
      offset,
      limit,
      items: matches.slice(offset, offset + limit),
    };
  }
  list(
    filter: OperatorFilter = "ALL",
    offset = 0,
    limit = 50
  ): OperatorListPageV1 {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("invalid operator pagination");
    const allowed: OperatorFilter[] = [
      "ALL",
      "UNKNOWN_EXTERNAL_EFFECT",
      "UNKNOWN_FINANCIAL_OUTCOME",
      "RECONCILIATION_REQUIRED",
      "SAFE_TO_REVERIFY",
      "SAFE_TO_RETRY",
      "REFUND_ELIGIBLE",
      "STALE_WORKER_CLAIM",
      "SANDBOX_UNRESOLVED",
      "VOUCHER_UNRESOLVED",
    ];
    if (!allowed.includes(filter)) throw new Error("invalid operator filter");
    const inventory = this.inventory();
    const views = inventory.tasks.map((task) => this.view(task, inventory));
    const matches = views.filter(
      (view) =>
        filter === "ALL" ||
        (filter === "REFUND_ELIGIBLE"
          ? view.recommendedAction === "REFUND_ELIGIBLE"
          : filter === "STALE_WORKER_CLAIM"
          ? view.claim.status === "STALE"
          : filter === "SANDBOX_UNRESOLVED"
          ? view.sandboxUnresolved
          : filter === "VOUCHER_UNRESOLVED"
          ? view.voucherUnresolved
          : view.classifications.includes(filter))
    );
    return {
      version: "1",
      total: matches.length,
      offset,
      limit,
      items: matches.slice(offset, offset + limit),
    };
  }
  /** Re-scan evidence only; no worker claim, verifier, provider call, or transaction. */
  refresh(taskKey: string): OperatorTaskViewV1 | null {
    return this.task(taskKey);
  }
  metrics(): OperatorMetricsV1 {
    const inventory = this.inventory();
    const views = inventory.tasks.map((task) => this.view(task, inventory));
    const count = (predicate: (view: OperatorTaskViewV1) => boolean) =>
      views.filter(predicate).length;
    return {
      version: "1",
      tasksScanned: views.length,
      reconciliationCompleted: count(
        (view) => view.latestReconciliation !== null
      ),
      unknownExternalEffect: count((view) =>
        view.classifications.includes("UNKNOWN_EXTERNAL_EFFECT")
      ),
      unknownFinancialOutcome: count((view) =>
        view.classifications.includes("UNKNOWN_FINANCIAL_OUTCOME")
      ),
      reconciliationRequired: count((view) =>
        view.classifications.includes("RECONCILIATION_REQUIRED")
      ),
      safeToReverify: count((view) =>
        view.classifications.includes("SAFE_TO_REVERIFY")
      ),
      safeToRetry: count((view) =>
        view.classifications.includes("SAFE_TO_RETRY")
      ),
      refundEligible: count(
        (view) => view.recommendedAction === "REFUND_ELIGIBLE"
      ),
      staleClaims: count((view) => view.claim.status === "STALE"),
      failedEvidenceQueries: views.reduce(
        (sum, view) =>
          sum +
          (view.latestReconciliation?.findings.filter(
            (item) => item.status === "UNAVAILABLE"
          ).length ?? 0),
        0
      ),
      sandboxUnresolvedLeases: inventory.unattached.filter(
        (record) => record.family === "sandboxLease"
      ).length,
      voucherUnresolvedIntents: count((view) => view.voucherUnresolved),
    };
  }
  async metricsWithChain(
    chain: OperatorChainReader
  ): Promise<OperatorMetricsV1> {
    const local = this.metrics();
    const eligible = await this.listRefundEligible(chain, 0, 1);
    return { ...local, refundEligible: eligible.total };
  }
  validateBackup(): BackupValidationV1 {
    if (!existsSync(this.stateRoot))
      return {
        version: "1",
        status: "INVALID",
        warnings: [],
        conflicts: ["state root absent"],
        tasks: 0,
      };
    const inventory = this.inventory();
    const warnings: string[] = [];
    const conflicts = [...inventory.conflicts];
    let invalid = false;
    for (const [family, status] of Object.entries(inventory.families))
      if (status === "MISSING" || status === "UNREADABLE")
        warnings.push(`${family}: ${status.toLowerCase()}`);
    if (inventory.staleTemporaryFiles.length)
      warnings.push(
        `${inventory.staleTemporaryFiles.length} stale temporary file(s)`
      );
    for (const task of inventory.tasks) {
      conflicts.push(
        ...task.conflicts.map((reason) => `${task.taskKey}: ${reason}`)
      );
      if (
        Object.values(task.evidence)
          .flat()
          .some((record) => record.status === "CORRUPT")
      )
        invalid = true;
      const claim = this.inspectClaim(task.taskKey);
      if (claim.status === "CORRUPT") invalid = true;
      else if (claim.status !== "ABSENT")
        warnings.push(
          `${task.taskKey}: worker claim ${claim.status.toLowerCase()}`
        );
      try {
        this.records.history(task.taskKey);
      } catch {
        invalid = true;
        conflicts.push(`${task.taskKey}: reconciliation history invalid`);
      }
    }
    const recordDir = join(this.stateRoot, "reconciliation", "records");
    if (existsSync(recordDir))
      for (const name of readdirSync(recordDir)) {
        const match = /^([0-9a-f]{64})\.([1-9][0-9]*)\.record$/.exec(name);
        if (!match) {
          invalid = true;
          conflicts.push(`unexpected reconciliation record ${name}`);
          continue;
        }
        if (!inventory.tasks.some((task) => task.taskKey === match[1]))
          conflicts.push(`orphan reconciliation record ${name}`);
      }
    const claimDir = join(this.stateRoot, "reconciliation", "claims");
    if (existsSync(claimDir))
      for (const name of readdirSync(claimDir)) {
        const match = /^([0-9a-f]{64})\.claim$/.exec(name);
        if (!match) {
          invalid = true;
          conflicts.push(`unexpected worker claim ${name}`);
          continue;
        }
        if (!inventory.tasks.some((task) => task.taskKey === match[1]))
          conflicts.push(`orphan worker claim ${name}`);
      }
    const claimHistory = join(
      this.stateRoot,
      "reconciliation",
      "claim-history"
    );
    if (existsSync(claimHistory))
      for (const name of readdirSync(claimHistory)) {
        const match =
          /^([0-9a-f]{64})\.([0-9a-f-]{36})\.(stale|released)\.json$/.exec(
            name
          );
        if (!match) {
          invalid = true;
          conflicts.push(`unexpected worker claim history ${name}`);
          continue;
        }
        try {
          const claim = reconciliationClaimV1Schema.parse(
            this.journal.read(join(claimHistory, name))
          );
          if (claim.taskKey !== match[1] || claim.claimId !== match[2])
            throw new Error("claim history binding conflict");
        } catch {
          invalid = true;
          conflicts.push(`invalid worker claim history ${name}`);
        }
        if (!inventory.tasks.some((task) => task.taskKey === match[1]))
          conflicts.push(`orphan worker claim history ${name}`);
      }
    const gates = join(this.stateRoot, "reconciliation", "gates");
    if (existsSync(gates))
      for (const name of readdirSync(gates))
        warnings.push(`unresolved worker gate ${name}`);
    return {
      version: "1",
      status: invalid
        ? "INVALID"
        : conflicts.length
        ? "RECONCILIATION_REQUIRED"
        : warnings.length
        ? "VALID_WITH_WARNINGS"
        : "VALID",
      warnings,
      conflicts,
      tasks: inventory.tasks.length,
    };
  }
}
