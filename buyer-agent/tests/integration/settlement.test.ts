import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ReplayDetected,
  SettlementTooCloseToDeadline,
} from "../../src/errors.js";
import { hashCanonical } from "../../src/manifest/hash.js";
import {
  SettlementCoordinator,
  type SettlementChain,
} from "../../src/chain/settlement-coordinator.js";
import type { StoredManifest } from "../../src/manifest/store.js";
import type { TaskQuote, TaskStateView } from "../../src/types.js";

const buyer = Keypair.generate().publicKey;
const verifier = Keypair.generate().publicKey;
const taskState = Keypair.generate().publicKey;
const vault = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const seller = Keypair.generate().publicKey;
const sellerTokenAccount = Keypair.generate().publicKey;
const buyerAta = Keypair.generate().publicKey;

const quote: TaskQuote = {
  taskId: 7n,
  programId: Keypair.generate().publicKey.toBase58(),
  taskStatePda: taskState.toBase58(),
  vaultPda: vault.toBase58(),
  mint: mint.toBase58(),
  sellerTokenAccount: sellerTokenAccount.toBase58(),
  verifier: verifier.toBase58(),
  amount: 10n,
  timeoutSeconds: 60,
  isPrivate: false,
  protocolFeeBps: 100,
  raw: {} as TaskQuote["raw"],
};

function pending(deadlineUnix = 200, isPrivate = false): TaskStateView {
  return {
    buyer: buyer.toBase58(),
    seller: seller.toBase58(),
    verifier: verifier.toBase58(),
    mint: mint.toBase58(),
    taskId: 7n,
    amount: 10n,
    deadlineUnix,
    status: "pending",
    isPrivate,
    bump: 1,
  };
}

const manifest = {
  version: "1" as const,
  taskId: "7",
  serviceId: "legacy-rest",
  buyer: buyer.toBase58(),
  sellerTokenAccount: sellerTokenAccount.toBase58(),
  sellerOwner: seller.toBase58(),
  verifier: verifier.toBase58(),
  mint: mint.toBase58(),
  amountBaseUnits: "10",
  timeoutSeconds: 60,
  isPrivate: false,
  taskSpecHash: "11".repeat(32),
  policyHash: "22".repeat(32),
  quoteHash: "33".repeat(32),
};
const record: StoredManifest = {
  manifest,
  manifestHash: hashCanonical(manifest),
  initializeSignature: "init-sig",
};

function fakeChain(state = pending()) {
  const calls: string[] = [];
  let current = state;
  const chain: SettlementChain = {
    buyer,
    verifier,
    async fetchTaskState() {
      calls.push("fetch");
      return current;
    },
    async verifyManifestMemo() {
      calls.push("memo");
    },
    async settlePublic() {
      calls.push("settlePublic");
      current = { ...current, status: "settled" };
      return "settle-sig";
    },
    async settlePrivate() {
      calls.push("settlePrivate");
      current = { ...current, status: "settled" };
      return "private-sig";
    },
    async fetchNullifierRecord() {
      calls.push("nullifier");
      return null;
    },
    async requireBuyerAta() {
      calls.push("ata");
      return buyerAta;
    },
    async refund() {
      calls.push("refund");
      current = { ...current, status: "refunded" };
      return "refund-sig";
    },
    async cancel() {
      calls.push("cancel");
      current = { ...current, status: "refunded" };
      return "cancel-sig";
    },
  };
  return { chain, calls };
}

describe("settlement coordination", () => {
  it("verifies the manifest memo before public settlement and re-reads state", async () => {
    const { chain, calls } = fakeChain();
    const result = await new SettlementCoordinator(chain, 5).settle(
      quote,
      record,
      { nowUnix: 100 }
    );
    expect(result.signature).toBe("settle-sig");
    expect(calls).toEqual(["fetch", "memo", "settlePublic", "fetch"]);
  });

  it("refuses settlement inside the safety margin", async () => {
    const { chain, calls } = fakeChain(pending(105));
    await expect(
      new SettlementCoordinator(chain, 5).settle(quote, record, {
        nowUnix: 100,
      })
    ).rejects.toBeInstanceOf(SettlementTooCloseToDeadline);
    expect(calls).toEqual(["fetch"]);
  });

  it("checks the on-chain NullifierRecord before private settlement", async () => {
    const { chain, calls } = fakeChain(pending(200, true));
    chain.fetchNullifierRecord = async () => ({ already: "spent" });
    await expect(
      new SettlementCoordinator(chain, 5).settle(
        { ...quote, isPrivate: true },
        {
          ...record,
          manifest: { ...manifest, isPrivate: true },
          manifestHash: hashCanonical({ ...manifest, isPrivate: true }),
        },
        { nowUnix: 100, nullifier: new Uint8Array(32) }
      )
    ).rejects.toBeInstanceOf(ReplayDetected);
    expect(calls.includes("settlePrivate")).toBe(false);
  });

  it("does not let a Redis cache failure overturn private settlement", async () => {
    const { chain } = fakeChain(pending(200, true));
    const privateManifest = { ...manifest, isPrivate: true };
    const result = await new SettlementCoordinator(chain, 5, async () => {
      throw new Error("redis unavailable");
    }).settle(
      { ...quote, isPrivate: true },
      {
        ...record,
        manifest: privateManifest,
        manifestHash: hashCanonical(privateManifest),
      },
      { nowUnix: 100, nullifier: new Uint8Array(32).fill(9) }
    );
    expect(result.state.status).toBe("settled");
  });

  it("uses refund only at or after the on-chain deadline", async () => {
    const { chain, calls } = fakeChain(pending(100));
    const result = await new SettlementCoordinator(chain, 5).refundExpired(
      quote,
      100
    );
    expect(result).toBe("refund-sig");
    expect(calls).toEqual(["fetch", "ata", "refund", "fetch"]);
  });
});
