import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { EscrowCoordinator, type EscrowChain } from "../../src/chain/escrow.js";
import { ManifestStore } from "../../src/manifest/store.js";
import type { TaskQuote, TaskStateView } from "../../src/types.js";
import { hashCanonical } from "../../src/manifest/hash.js";
import { TransactionSubmissionError } from "../../src/errors.js";
import { ProtectedTaskController } from "../../src/core/task-controller.js";

const policy = {
  version: "1",
  level: 1,
  checks: [{ type: "json_schema", schema_ref: "generic-object-v1" }],
} as const;
const policyHash = hashCanonical(policy);

const buyer = Keypair.generate().publicKey;
const sellerOwner = Keypair.generate().publicKey;
const sellerTokenAccount = Keypair.generate().publicKey;
const verifier = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const taskState = Keypair.generate().publicKey;
const vault = Keypair.generate().publicKey;
const buyerAta = Keypair.generate().publicKey;

const quote: TaskQuote = {
  taskId: 42n,
  serviceId: "legacy-rest",
  programId: Keypair.generate().publicKey.toBase58(),
  taskStatePda: taskState.toBase58(),
  vaultPda: vault.toBase58(),
  mint: mint.toBase58(),
  sellerTokenAccount: sellerTokenAccount.toBase58(),
  verifier: verifier.toBase58(),
  amount: 1_500_000n,
  timeoutSeconds: 180,
  isPrivate: false,
  protocolFeeBps: 100,
  verificationPolicy: policy,
  policyHash,
  raw: {
    task_id: "42",
    program_id: Keypair.generate().publicKey.toBase58(),
    task_state_pda: taskState.toBase58(),
    vault_pda: vault.toBase58(),
    mint: mint.toBase58(),
    seller_token_account: sellerTokenAccount.toBase58(),
    verifier: verifier.toBase58(),
    amount: "1500000",
    timeout_seconds: 180,
    is_private: false,
    protocol_fee_bps: 100,
    service_id: "legacy-rest",
    verification_policy: policy,
    policy_hash: policyHash,
  },
};

function fundedState(): TaskStateView {
  return {
    buyer: buyer.toBase58(),
    seller: sellerOwner.toBase58(),
    verifier: verifier.toBase58(),
    mint: mint.toBase58(),
    taskId: 42n,
    amount: 1_500_000n,
    deadlineUnix: Math.floor(Date.now() / 1000) + 180,
    status: "pending",
    isPrivate: false,
    bump: 1,
  };
}

function fakeChain(options: { initializationFails?: boolean } = {}) {
  const calls: string[] = [];
  let reads = 0;
  const chain: EscrowChain = {
    buyer,
    async confirmSignature() {
      return true;
    },
    async verifyManifestMemo() {},
    async fetchTaskState() {
      calls.push("fetchTaskState");
      reads += 1;
      return reads === 1 ? null : fundedState();
    },
    async resolveTokenAccountOwner() {
      calls.push("resolveSellerOwner");
      return sellerOwner;
    },
    async requireBuyerAta() {
      calls.push("requireBuyerAta");
      return buyerAta;
    },
    async tokenBalance() {
      calls.push("tokenBalance");
      return 2_000_000n;
    },
    async initializeTaskWithMemo(input) {
      calls.push("initializeTask");
      expect(input.seller.equals(sellerOwner)).toBe(true);
      expect(input.buyerTokenAccount.equals(buyerAta)).toBe(true);
      input.onSigned?.("init-signature");
      if (options.initializationFails)
        throw new TransactionSubmissionError(
          "ambiguous RPC failure",
          "init-signature"
        );
      return "init-signature";
    },
  };
  return { chain, calls };
}

describe("escrow funding coordination", () => {
  it.each(["confirmation", "memo"])(
    "controller cached receipt reaches real escrow %s validation",
    async (kind) => {
      const { chain, calls } = fakeChain();
      const directory = mkdtempSync(join(tmpdir(), "setra35-funding-"));
      const escrow = new EscrowCoordinator(
        chain,
        new ManifestStore(join(directory, "manifests"))
      );
      const funding = {
        quote,
        serviceId: quote.serviceId,
        input: {},
        policyHash,
      };
      let state: TaskStateView | null = null;
      const deps = {
        async quote() {
          return quote;
        },
        normalizeQuote() {
          return quote;
        },
        async state() {
          return state;
        },
        async now() {
          return 50;
        },
        async fund() {
          const result = await escrow.ensureFunded(funding);
          state = result.state;
          return result;
        },
        async validateFundingReceipt() {
          await escrow.ensureFunded(funding, true);
        },
        async run() {
          throw new Error("not used");
        },
        async refund() {
          throw new Error("not used");
        },
      };
      const call = {
        buyer: buyer.toBase58(),
        task_id: "42",
        service_id: quote.serviceId,
        input: {},
        is_private: false,
        transport: "REST",
      };
      await new ProtectedTaskController(directory, deps).fund(call);
      if (kind === "confirmation") chain.confirmSignature = async () => false;
      else
        chain.verifyManifestMemo = async () => {
          throw new Error("memo mismatch");
        };
      await expect(
        new ProtectedTaskController(directory, deps).fund({
          ...call,
          transport: "MCP",
        })
      ).rejects.toThrow(kind === "confirmation" ? /reconciliation/ : /memo/);
      expect(calls.filter((c) => c === "initializeTask")).toHaveLength(1);
    }
  );
  it("read-only cached receipt validation cannot initialize an absent TaskState", async () => {
    const { chain, calls } = fakeChain();
    const escrow = new EscrowCoordinator(
      chain,
      new ManifestStore(mkdtempSync(join(tmpdir(), "setra35-readonly-")))
    );
    await expect(
      escrow.ensureFunded(
        { quote, serviceId: quote.serviceId, input: {}, policyHash },
        true
      )
    ).rejects.toThrow(/existing TaskState/);
    expect(calls).not.toContain("initializeTask");
  });
  it("resolves seller owner, uses buyer ATA, confirms, and re-reads TaskState", async () => {
    const { chain, calls } = fakeChain();
    const directory = mkdtempSync(join(tmpdir(), "setra402-manifests-"));
    const store = new ManifestStore(directory);
    const coordinator = new EscrowCoordinator(chain, store);
    const result = await coordinator.ensureFunded({
      quote,
      serviceId: "legacy-rest",
      input: { job: "baseline" },
      policyHash: "ab".repeat(32),
    });

    expect(result.initializeSignature).toBe("init-signature");
    expect(calls).toEqual([
      "fetchTaskState",
      "resolveSellerOwner",
      "requireBuyerAta",
      "tokenBalance",
      "initializeTask",
      "fetchTaskState",
    ]);
    const envelope = JSON.parse(
      readFileSync(join(directory, `${taskState.toBase58()}.json`), "utf8")
    );
    expect(envelope.checksum).toMatch(/^[0-9a-f]{64}$/);
    const stored = envelope.value;
    expect(stored.manifest.sellerOwner).toBe(sellerOwner.toBase58());
    expect(stored.initializeSignature).toBe("init-signature");
  });

  it("treats a matching on-chain state as success after an ambiguous initialize error", async () => {
    const { chain, calls } = fakeChain({ initializationFails: true });
    const coordinator = new EscrowCoordinator(
      chain,
      new ManifestStore(mkdtempSync(join(tmpdir(), "setra402-manifests-")))
    );
    const result = await coordinator.ensureFunded({
      quote,
      serviceId: "legacy-rest",
      input: {},
      policyHash: "cd".repeat(32),
    });
    expect(result.state.status).toBe("pending");
    expect(result.initializeSignature).toBe("init-signature");
    expect(calls.filter((call) => call === "initializeTask")).toHaveLength(1);
  });

  it("rejects reuse of a funded task with a different committed input", async () => {
    const { chain } = fakeChain();
    let reads = 0;
    chain.fetchTaskState = async () => {
      reads += 1;
      return reads === 1 ? null : fundedState();
    };
    const store = new ManifestStore(
      mkdtempSync(join(tmpdir(), "setra402-manifests-"))
    );
    const coordinator = new EscrowCoordinator(chain, store);
    await coordinator.ensureFunded({
      quote,
      serviceId: "legacy-rest",
      input: { committed: true },
      policyHash: "ef".repeat(32),
    });

    await expect(
      coordinator.ensureFunded({
        quote,
        serviceId: "legacy-rest",
        input: { committed: false },
        policyHash: "ef".repeat(32),
      })
    ).rejects.toThrow(/manifest/i);
  });

  it.each([false, true])(
    "ambiguous funding requires confirmation and memo evidence (confirmed=%s)",
    async (confirmed) => {
      const { chain } = fakeChain({ initializationFails: true });
      chain.confirmSignature = async () => confirmed;
      chain.verifyManifestMemo = async () => {
        throw new Error("memo mismatch");
      };
      const coordinator = new EscrowCoordinator(
        chain,
        new ManifestStore(mkdtempSync(join(tmpdir(), "setra35-receipt-")))
      );
      await expect(
        coordinator.ensureFunded({
          quote,
          serviceId: "legacy-rest",
          input: {},
          policyHash,
        })
      ).rejects.toThrow(confirmed ? /memo/ : /ambiguous/);
    }
  );
});
