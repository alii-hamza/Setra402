import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { DurableJournal } from "../../src/core/journal.js";
import { scanRecoveryInventory } from "../../src/core/recovery-inventory.js";
import { deriveTaskPda, deriveVaultPda } from "../../src/chain/pda.js";
import { hashCanonical } from "../../src/manifest/hash.js";
import { ManifestStore } from "../../src/manifest/store.js";

const journal = new DurableJournal();
const key = () => Keypair.generate().publicKey.toBase58();
function fixture(privateTask = false, sourceSampling = false) {
  const root = mkdtempSync(
    join(process.cwd(), "../target/setra4a1-inventory-")
  );
  const seller = join(root, "seller-store");
  const buyer = Keypair.generate().publicKey;
  const program = Keypair.generate().publicKey;
  const taskId = "41";
  const serviceId = "fixture-service";
  const input = { records: [{ id: 1 }] };
  const policy = sourceSampling
    ? {
        version: "1",
        level: 2,
        checks: [
          {
            type: "source_sampling",
            pointer: "/records",
            sample_count: 1,
            source_url_field: "url",
            fields: ["id"],
            allowed_domains: ["example.com"],
            minimum_match_bps: 10_000,
          },
        ],
      }
    : {
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
  const manifestHash = hashCanonical(manifest);
  const stem = hashCanonical({ buyer: buyer.toBase58(), task_id: taskId });
  const checkpointStem = hashCanonical({ buyer: buyer.toBase58(), taskId });
  const sellerUrl = "https://fixture.example";
  const voucherStem = hashCanonical({
    seller: sellerUrl,
    buyer: buyer.toBase58(),
    taskId,
  });
  const path = (family: string, name: string) => join(root, family, name);
  const save = (family: string, name: string, value: unknown) =>
    journal.write(path(family, name), value);
  const inventory = () =>
    scanRecoveryInventory({
      stateDirectory: root,
      sellerExecutionDirectory: seller,
      sellerUrl,
    });
  new ManifestStore(join(root, "manifests")).save(taskState.toBase58(), {
    manifest,
    manifestHash,
    initializeSignature: "init",
  });
  save("tasks", `${stem}.quote.json`, quote);
  mkdirSync(join(root, "tasks"), { recursive: true });
  writeFileSync(
    path("tasks", `${stem}.identity`),
    hashCanonical({
      buyer: buyer.toBase58(),
      task_id: taskId,
      service_id: serviceId,
      is_private: privateTask,
      input,
    })
  );
  const result = {
    version: "1",
    taskId,
    serviceId,
    result: input,
    resultHash: hashCanonical(input),
    evidence: [],
    completedAtUnix: 50,
    input,
    output_hash: hashCanonical(input),
  };
  const report = {
    taskId,
    serviceId,
    level: policy.level,
    manifestHash,
    policyHash: quote.policy_hash,
    resultHash: result.resultHash,
    checks: [{ type: "record_count", passed: true, message: "count" }],
    passed: true,
    verifierPubkey: quote.verifier,
    startedAtUnix: 50,
    completedAtUnix: 51,
  };
  const financial = (
    kind: "funding" | "settlement" | "refund" | "cancel",
    stage: "intent" | "transaction.json" | "confirmed.json" = "intent"
  ) => {
    const operation = {
      programId: quote.program_id,
      taskState: quote.task_state_pda,
      kind,
      binding: hashCanonical({ kind }),
    };
    const id = hashCanonical({
      programId: quote.program_id,
      taskState: quote.task_state_pda,
      kind,
    });
    if (stage === "intent")
      save("transactions", `${id}.intent`, {
        operation,
        state: "UNKNOWN_FINANCIAL_OUTCOME",
      });
    if (stage === "transaction.json")
      save("transactions", `${id}.transaction.json`, {
        signature: "3".repeat(88),
        blockhash: key(),
        lastValidBlockHeight: 100,
        fingerprint: operation.binding,
        signedAtUnix: 50,
      });
    if (stage === "confirmed.json")
      save("transactions", `${id}.confirmed.json`, {
        signature: "3".repeat(88),
        confirmedAtUnix: 51,
      });
    return id;
  };
  const executed = () => {
    save("tasks", `${stem}.run.intent`, {
      state: "UNKNOWN_EXTERNAL_EFFECT",
      identity: path("tasks", `${stem}.identity`),
    });
    save("checkpoints", `${checkpointStem}.result.json`, result);
    save("checkpoints", `${checkpointStem}.report.json`, report);
    mkdirSync(seller, { recursive: true });
    writeFileSync(
      join(seller, `${taskState.toBase58()}.intent`),
      JSON.stringify({
        version: 1,
        input_hash: hashCanonical(input),
        service_id: serviceId,
        state: "UNKNOWN_EXTERNAL_EFFECT",
      })
    );
    const wire = {
      version: "1",
      task_id: taskId,
      service_id: serviceId,
      input,
      output_hash: hashCanonical(input),
      result: input,
      result_hash: hashCanonical(input),
      evidence: [],
      completed_at_unix: 50,
    };
    writeFileSync(
      join(seller, `${taskState.toBase58()}.json`),
      JSON.stringify({
        version: 1,
        checksum: hashCanonical(wire),
        result: wire,
      })
    );
  };
  return {
    root,
    seller,
    buyer: buyer.toBase58(),
    taskId,
    serviceId,
    stem,
    checkpointStem,
    voucherStem,
    sellerUrl,
    quote,
    manifest,
    result,
    report,
    taskState: taskState.toBase58(),
    path,
    save,
    inventory,
    executed,
    financial,
  };
}
function snapshot(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory()
        ? snapshot(path)
        : [`${path}:${readFileSync(path, "utf8")}`];
    })
    .sort();
}
describe("Phase 4A.1 recovery inventory (local evidence only)", () => {
  it("inventories a complete task without asserting chain certainty or mutating state", () => {
    const f = fixture();
    f.executed();
    f.financial("funding");
    f.financial("funding", "transaction.json");
    f.financial("funding", "confirmed.json");
    const before = snapshot(f.root);
    const view = f.inventory();
    expect(view.version).toBe("1");
    expect(view.tasks).toHaveLength(1);
    expect(view.tasks[0]?.taskIdentity).toMatchObject({
      buyer: f.buyer,
      taskId: f.taskId,
    });
    expect(view.tasks[0]?.evidence.manifest).toHaveLength(1);
    expect(view.tasks[0]?.evidence.result).toHaveLength(1);
    expect(view.tasks[0]?.evidence.verification).toHaveLength(1);
    expect(view.tasks[0]?.evidence.execution).toHaveLength(2);
    expect(view.tasks[0]?.classifications).toContain(
      "UNKNOWN_FINANCIAL_OUTCOME"
    );
    expect(view.tasks[0]?.classifications).not.toContain("PROVEN_OCCURRED");
    expect(snapshot(f.root)).toEqual(before);
  });
  it("preserves a funded in-progress task and an unknown provider effect", () => {
    const f = fixture();
    f.save("tasks", `${f.stem}.fund.intent`, {
      state: "UNKNOWN_FINANCIAL_OUTCOME",
    });
    f.save("tasks", `${f.stem}.funded.json`, { status: "funded" });
    f.save("tasks", `${f.stem}.run.intent`, {
      state: "UNKNOWN_EXTERNAL_EFFECT",
      identity: f.path("tasks", `${f.stem}.identity`),
    });
    expect(f.inventory().tasks[0]?.classifications).toEqual(
      expect.arrayContaining([
        "UNKNOWN_EXTERNAL_EFFECT",
        "UNKNOWN_FINANCIAL_OUTCOME",
      ])
    );
  });
  it.each(["verification_failed", "settled", "refunded"])(
    "keeps %s as local outcome only",
    (status) => {
      const f = fixture();
      f.executed();
      f.save("tasks", `${f.stem}.result.json`, {
        status,
        result: f.result,
        report: f.report,
      });
      const task = f.inventory().tasks[0]!;
      expect(task.classifications).not.toContain("PROVEN_OCCURRED");
      if (status === "settled" || status === "refunded")
        expect(task.classifications).toContain("UNKNOWN_FINANCIAL_OUTCOME");
      if (status === "verification_failed")
        expect(task.recommendedAction).not.toBe("SAFE_TO_RETRY");
    }
  );
  it("inventories private voucher material without claiming nullifier proof", () => {
    const f = fixture(true);
    f.executed();
    f.save("vouchers", `${f.voucherStem}.intent`, {
      nullifierScalar: "1",
      blindingScalar: "2",
      blindedPointHex: "a".repeat(64),
    });
    f.save("vouchers", `${f.voucherStem}.voucher.json`, {
      blind_signature: "a".repeat(64),
      mint_pubkey: "b".repeat(64),
    });
    expect(f.inventory().tasks[0]?.evidence.voucherIssuance).toHaveLength(2);
  });
  it("keeps an unacknowledged private voucher issuance as an unknown external effect", () => {
    const f = fixture(true);
    f.save("vouchers", `${f.voucherStem}.intent`, {
      nullifierScalar: "1",
      blindingScalar: "2",
      blindedPointHex: "a".repeat(64),
    });
    const task = f.inventory().tasks[0]!;
    expect(task.classifications).toContain("UNKNOWN_EXTERNAL_EFFECT");
    expect(task.classifications).not.toContain("UNKNOWN_FINANCIAL_OUTCOME");
  });
  it.each(["truncated", "checksum", "future-version", "wrong-key"])(
    "fails closed on %s journal",
    (damage) => {
      const f = fixture();
      const path = f.path("tasks", `${f.stem}.quote.json`);
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (damage === "truncated") writeFileSync(path, "{");
      if (damage === "checksum") {
        raw.value.amount = "11";
        writeFileSync(path, JSON.stringify(raw));
      }
      if (damage === "future-version") {
        raw.version = 2;
        writeFileSync(path, JSON.stringify(raw));
      }
      if (damage === "wrong-key") {
        raw.key = "wrong";
        writeFileSync(path, JSON.stringify(raw));
      }
      const task = f.inventory().tasks[0]!;
      expect(
        task.evidence.tasks?.find((r) => r.role === "quote.json")?.status
      ).toBe("CORRUPT");
      expect(task.classifications).toEqual(["RECONCILIATION_REQUIRED"]);
    }
  );
  it.each([
    "buyer",
    "taskId",
    "serviceId",
    "isPrivate",
    "policyHash",
    "quoteHash",
  ])("detects changed manifest %s", (field) => {
    const f = fixture();
    const changed = {
      ...f.manifest,
      [field]:
        field === "isPrivate"
          ? true
          : field === "buyer"
          ? key()
          : field === "taskId"
          ? "42"
          : field === "serviceId"
          ? "other"
          : "a".repeat(64),
    };
    new ManifestStore(join(f.root, "manifests")).save(f.taskState, {
      manifest: changed as typeof f.manifest,
      manifestHash: hashCanonical(changed),
      initializeSignature: "init",
    });
    const view = f.inventory();
    expect(
      view.conflicts.length +
        view.tasks.flatMap((task) => task.conflicts).length
    ).toBeGreaterThan(0);
  });
  it("detects orphan financial prepared and completion records", () => {
    const f = fixture();
    f.financial("refund", "transaction.json");
    f.financial("refund", "confirmed.json");
    const view = f.inventory();
    expect(view.conflicts.some((c) => c.includes("orphan financial"))).toBe(
      true
    );
    expect(view.unattached).toHaveLength(2);
  });
  it("detects orphan completion after intent but without prepared transaction", () => {
    const f = fixture();
    f.financial("refund");
    f.financial("refund", "confirmed.json");
    expect(f.inventory().tasks[0]?.conflicts).toContain(
      "orphan financial completion without prepared transaction"
    );
  });
  it("detects duplicate canonical quote and conflicting result copies", () => {
    const f = fixture();
    f.executed();
    f.save("tasks", `${"b".repeat(64)}.quote.json`, f.quote);
    f.save("tasks", `${f.stem}.result.json`, {
      status: "settled",
      result: { ...f.result, resultHash: "a".repeat(64) },
      report: f.report,
    });
    const view = scanRecoveryInventory({
      stateDirectory: f.root,
      sellerExecutionDirectory: f.seller,
      sellerUrl: f.sellerUrl,
      configuredBuyer: f.buyer,
    });
    expect(view.tasks.flatMap((task) => task.conflicts).join(" ")).toMatch(
      /duplicate|conflict/
    );
  });
  it("ignores a stale temp file but reports it", () => {
    const f = fixture();
    writeFileSync(f.path("tasks", `${f.stem}.quote.json.old.tmp`), "truncated");
    expect(f.inventory().staleTemporaryFiles).toHaveLength(1);
    expect(f.inventory().tasks[0]?.evidence.tasks).toHaveLength(2);
  });
  it("moves and restores state directories without rewriting embedded absolute intent paths", () => {
    const f = fixture();
    f.executed();
    const backup = mkdtempSync(
      join(process.cwd(), "../target/setra4a1-backup-")
    );
    cpSync(f.root, backup, { recursive: true });
    const moved = `${f.root}-moved`;
    renameSync(f.root, moved);
    const movedView = scanRecoveryInventory({
      stateDirectory: moved,
      sellerExecutionDirectory: join(moved, "seller-store"),
    });
    expect(movedView.tasks[0]?.conflicts).toEqual([]);
    const restoredView = scanRecoveryInventory({
      stateDirectory: backup,
      sellerExecutionDirectory: join(backup, "seller-store"),
    });
    expect(restoredView.tasks[0]?.conflicts).toEqual([]);
  });
  it("reports partial restoration and missing families without converting absence into failure", () => {
    const f = fixture();
    f.executed();
    rmSync(join(f.root, "checkpoints"), { recursive: true });
    rmSync(f.seller, { recursive: true });
    const task = f.inventory().tasks[0]!;
    expect(task.evidence.result).toBeUndefined();
    expect(task.classifications).toContain("UNKNOWN_EXTERNAL_EFFECT");
  });
  it("keeps the external effect unknown when only the seller-side result survived", () => {
    const f = fixture();
    f.executed();
    rmSync(join(f.root, "checkpoints"), { recursive: true });
    expect(f.inventory().tasks[0]?.classifications).toContain(
      "UNKNOWN_EXTERNAL_EFFECT"
    );
  });
  it("detects cross-task contamination and never associates unkeyed leases by guess", () => {
    const f = fixture();
    f.executed();
    f.save("sandbox-leases", "container.lease", {
      pid: 1,
      container: "container",
      directory: "untrusted",
    });
    f.save("checkpoints", `${"f".repeat(64)}.result.json`, f.result);
    const view = f.inventory();
    expect(view.conflicts.some((c) => c.includes("orphan checkpoint"))).toBe(
      true
    );
    expect(view.unattached.some((r) => r.family === "sandboxLease")).toBe(true);
  });
  it("rejects a result checkpoint with altered immutable linkage", () => {
    const f = fixture();
    f.executed();
    f.save("checkpoints", `${f.checkpointStem}.result.json`, {
      ...f.result,
      serviceId: "other-service",
    });
    expect(f.inventory().tasks[0]?.conflicts).toContain(
      "result checkpoint identity conflicts"
    );
  });
  it("rejects a report linked to a different result or verifier", () => {
    const f = fixture();
    f.executed();
    f.save("checkpoints", `${f.checkpointStem}.report.json`, {
      ...f.report,
      resultHash: "a".repeat(64),
      verifierPubkey: key(),
    });
    expect(f.inventory().tasks[0]?.classifications).toEqual([
      "RECONCILIATION_REQUIRED",
    ]);
  });
  it("rejects a future seller journal version and retains the seller intent", () => {
    const f = fixture();
    f.executed();
    const path = join(f.seller, `${f.taskState}.json`);
    const value = JSON.parse(readFileSync(path, "utf8"));
    value.version = 2;
    writeFileSync(path, JSON.stringify(value));
    const task = f.inventory().tasks[0]!;
    expect(
      task.evidence.execution?.find((r) => r.role === "json")?.status
    ).toBe("CORRUPT");
    expect(
      task.evidence.execution?.find((r) => r.role === "intent")?.status
    ).toBe("VALID");
    expect(task.classifications).toEqual(["RECONCILIATION_REQUIRED"]);
  });
  it("reports a voucher response without its issuance intent", () => {
    const f = fixture(true);
    f.save("vouchers", `${f.voucherStem}.voucher.json`, {
      blind_signature: "a".repeat(64),
      mint_pubkey: "b".repeat(64),
    });
    expect(f.inventory().tasks[0]?.conflicts).toContain(
      "orphan voucher response without intent"
    );
  });
  it("marks a checksum-valid but malformed voucher payload corrupt", () => {
    const f = fixture(true);
    f.save("vouchers", `${f.voucherStem}.intent`, ["not", "material"]);
    expect(f.inventory().tasks[0]?.evidence.voucherIssuance?.[0]?.status).toBe(
      "CORRUPT"
    );
    expect(f.inventory().tasks[0]?.classifications).toEqual([
      "RECONCILIATION_REQUIRED",
    ]);
  });
  it("fails closed when a manifest has a checksum-valid invalid buyer", () => {
    const f = fixture();
    const changed = { ...f.manifest, buyer: "not-a-public-key" };
    new ManifestStore(join(f.root, "manifests")).save(f.taskState, {
      manifest: changed,
      manifestHash: hashCanonical(changed),
      initializeSignature: "init",
    });
    const view = f.inventory();
    expect(
      view.unattached.some(
        (r) => r.family === "manifest" && r.status === "CORRUPT"
      )
    ).toBe(true);
    expect(view.recommendedAction).toBe("OPERATOR_REVIEW_REQUIRED");
  });
  it("fails closed when the configured state root is a file", () => {
    const f = fixture();
    const path = join(f.root, "not-a-directory");
    writeFileSync(path, "x");
    const view = scanRecoveryInventory({ stateDirectory: path });
    expect(view.recommendedAction).toBe("OPERATOR_REVIEW_REQUIRED");
    expect(view.tasks).toEqual([]);
  });
  it("inventories cancellation and refund intents without taking action", () => {
    const f = fixture();
    f.financial("cancel");
    f.financial("refund");
    const task = f.inventory().tasks[0]!;
    expect(task.evidence.transactions).toHaveLength(2);
    expect(task.classifications).toContain("UNKNOWN_FINANCIAL_OUTCOME");
    expect(task.recommendedAction).toBe("READ_ONLY_RECONCILIATION");
  });
  it("attaches a persisted source challenge only by committed context", () => {
    const f = fixture(false, true);
    f.executed();
    const immutableContext = hashCanonical({
      manifestHash: hashCanonical(f.manifest),
      policyHash: f.quote.policy_hash,
      resultHash: f.result.resultHash,
      checkIndex: 0,
    });
    const name = `${hashCanonical({
      immutableContext,
      policy: f.quote.verification_policy.checks[0],
    })}.seed`;
    mkdirSync(join(f.root, "challenges"), { recursive: true });
    writeFileSync(f.path("challenges", name), "a".repeat(64));
    expect(f.inventory().tasks[0]?.evidence.challenge).toHaveLength(1);
  });
  it("reports absent families explicitly and never calls absence non-occurrence", () => {
    const f = fixture();
    const view = f.inventory();
    expect(view.families.transactions).toBe("MISSING");
    expect(view.families.checkpoints).toBe("MISSING");
    expect(view.authoritativeExternalEvidence).toBe("NOT_QUERIED");
    expect(view.tasks[0]?.classifications).not.toContain("PROVEN_NOT_OCCURRED");
  });
  it("rejects corrupt lease records without deleting them", () => {
    const f = fixture();
    f.save("sandbox-leases", "setra402-verify-invalid.lease", {
      pid: 1,
      container: "other",
      directory: "x",
    });
    const before = snapshot(f.root);
    const view = f.inventory();
    expect(view.conflicts).toContain(
      "sandbox lease setra402-verify-invalid.lease is corrupt"
    );
    expect(view.recommendedAction).toBe("OPERATOR_REVIEW_REQUIRED");
    expect(snapshot(f.root)).toEqual(before);
  });
  it("rejects unknown journal family content without claiming recovery", () => {
    const f = fixture();
    writeFileSync(f.path("tasks", "unrecognized.json"), "{}");
    expect(f.inventory().recommendedAction).toBe("OPERATOR_REVIEW_REQUIRED");
  });
  it("reports unknown seller effect and financial outcome independently", () => {
    const f = fixture();
    f.save("tasks", `${f.stem}.run.intent`, {
      state: "UNKNOWN_EXTERNAL_EFFECT",
      identity: f.path("tasks", `${f.stem}.identity`),
    });
    f.financial("settlement");
    expect(f.inventory().tasks[0]?.classifications).toEqual(
      expect.arrayContaining([
        "UNKNOWN_EXTERNAL_EFFECT",
        "UNKNOWN_FINANCIAL_OUTCOME",
      ])
    );
  });
});
