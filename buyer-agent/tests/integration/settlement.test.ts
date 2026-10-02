import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ReplayDetected,
  SettlementTooCloseToDeadline,
  TransactionSubmissionError,
  VerificationFailed,
} from "../../src/errors.js";
import { hashCanonical } from "../../src/manifest/hash.js";
import {
  SettlementCoordinator,
  type SettlementChain,
} from "../../src/chain/settlement-coordinator.js";
import type { StoredManifest } from "../../src/manifest/store.js";
import type {
  TaskQuote,
  TaskStateView,
  VerificationReport,
} from "../../src/types.js";

const policy = {
  version: "1",
  level: 1,
  checks: [{ type: "json_schema", schema_ref: "generic-object-v1" }],
} as const;

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
  serviceId: "legacy-rest",
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
  verificationPolicy: policy,
  policyHash: hashCanonical(policy),
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
  policyHash: quote.policyHash,
  quoteHash: hashCanonical(quote.raw),
};
const record: StoredManifest = {
  manifest,
  manifestHash: hashCanonical(manifest),
  initializeSignature: "init-sig",
};

function passingReport(
  overrides: Partial<VerificationReport> = {}
): VerificationReport {
  return {
    taskId: quote.taskId.toString(),
    serviceId: quote.serviceId,
    level: 1,
    manifestHash: record.manifestHash,
    policyHash: quote.policyHash,
    resultHash: "33".repeat(32),
    checks: [{ type: "json_schema", passed: true, message: "ok" }],
    passed: true,
    verifierPubkey: quote.verifier,
    startedAtUnix: 90,
    completedAtUnix: 91,
    ...overrides,
  };
}

function fakeChain(state = pending()) {
  const calls: string[] = [];
  let current = state;
  const chain: SettlementChain = {
    buyer,
    verifier,
    async getChainUnixTime() {
      return 100;
    },
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
  return {
    chain,
    calls,
    setState(next: TaskStateView) {
      current = next;
    },
  };
}

describe("settlement coordination", () => {
  it("verifies the manifest memo before public settlement and re-reads state", async () => {
    const { chain, calls } = fakeChain();
    const result = await new SettlementCoordinator(chain, 5).settle(
      quote,
      record,
      { report: passingReport(), nowUnix: 100 }
    );
    expect(result.signature).toBe("settle-sig");
    expect(calls).toEqual(["fetch", "memo", "settlePublic", "fetch"]);
  });

  it("rejects a quote whose payout account differs from the committed manifest", async () => {
    const { chain, calls } = fakeChain();
    await expect(
      new SettlementCoordinator(chain, 5).settle(
        {
          ...quote,
          sellerTokenAccount: Keypair.generate().publicKey.toBase58(),
        },
        record,
        { report: passingReport(), nowUnix: 100 }
      )
    ).rejects.toThrow(/sellerTokenAccount/);
    expect(calls.includes("settlePublic")).toBe(false);
  });

  it("refuses settlement inside the safety margin", async () => {
    const { chain, calls } = fakeChain(pending(105));
    await expect(
      new SettlementCoordinator(chain, 5).settle(quote, record, {
        report: passingReport(),
        nowUnix: 100,
      })
    ).rejects.toBeInstanceOf(SettlementTooCloseToDeadline);
    expect(calls).toEqual(["fetch"]);
  });

  it("uses the on-chain clock for the settlement safety margin", async () => {
    const deadlineUnix = Number.MAX_SAFE_INTEGER;
    const { chain, calls } = fakeChain(pending(deadlineUnix));
    chain.getChainUnixTime = async () => deadlineUnix - 5;
    await expect(
      new SettlementCoordinator(chain, 5).settle(quote, record, {
        report: passingReport(),
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
        {
          report: passingReport({
            manifestHash: hashCanonical({ ...manifest, isPrivate: true }),
          }),
          nowUnix: 100,
          nullifier: new Uint8Array(32),
        }
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
      {
        report: passingReport({
          manifestHash: hashCanonical(privateManifest),
        }),
        nowUnix: 100,
        nullifier: new Uint8Array(32).fill(9),
      }
    );
    expect(result.state.status).toBe("settled");
  });

  it("recovers an ambiguously confirmed public settlement from TaskState", async () => {
    const harness = fakeChain();
    harness.chain.settlePublic = async () => {
      harness.setState({ ...pending(), status: "settled" });
      throw new TransactionSubmissionError(
        "ambiguous",
        "ambiguous-settle-signature"
      );
    };
    const result = await new SettlementCoordinator(harness.chain, 5).settle(
      quote,
      record,
      { report: passingReport(), nowUnix: 100 }
    );
    expect(result.signature).toBe("ambiguous-settle-signature");
    expect(result.state.status).toBe("settled");
  });

  it("recovers an ambiguously confirmed private settlement from TaskState", async () => {
    const harness = fakeChain(pending(200, true));
    let nullifierReads = 0;
    harness.chain.fetchNullifierRecord = async () =>
      nullifierReads++ === 0 ? null : { settled: true };
    harness.chain.settlePrivate = async () => {
      harness.setState({ ...pending(200, true), status: "settled" });
      throw new TransactionSubmissionError(
        "ambiguous",
        "ambiguous-private-signature"
      );
    };
    const privateManifest = { ...manifest, isPrivate: true };
    const result = await new SettlementCoordinator(harness.chain, 5).settle(
      { ...quote, isPrivate: true },
      {
        ...record,
        manifest: privateManifest,
        manifestHash: hashCanonical(privateManifest),
      },
      {
        report: passingReport({
          manifestHash: hashCanonical(privateManifest),
        }),
        nowUnix: 100,
        nullifier: new Uint8Array(32).fill(4),
      }
    );
    expect(result.signature).toBe("ambiguous-private-signature");
    expect(result.state.status).toBe("settled");
  });

  it("does not misattribute another private settlement after an ambiguous result", async () => {
    const harness = fakeChain(pending(200, true));
    harness.chain.settlePrivate = async () => {
      harness.setState({ ...pending(200, true), status: "settled" });
      throw new TransactionSubmissionError(
        "ambiguous",
        "ambiguous-private-signature"
      );
    };
    const privateManifest = { ...manifest, isPrivate: true };
    await expect(
      new SettlementCoordinator(harness.chain, 5).settle(
        { ...quote, isPrivate: true },
        {
          ...record,
          manifest: privateManifest,
          manifestHash: hashCanonical(privateManifest),
        },
        {
          report: passingReport({
            manifestHash: hashCanonical(privateManifest),
          }),
          nowUnix: 100,
          nullifier: new Uint8Array(32).fill(4),
        }
      )
    ).rejects.toBeInstanceOf(TransactionSubmissionError);
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

  it("refuses settlement when VerificationReport.passed is false", async () => {
    const { chain, calls } = fakeChain();
    await expect(
      new SettlementCoordinator(chain, 5).settle(quote, record, {
        report: passingReport({ passed: false }),
        nowUnix: 100,
      })
    ).rejects.toBeInstanceOf(VerificationFailed);
    expect(calls).toEqual([]);
  });

  it("refuses an internally inconsistent passing report", async () => {
    const { chain, calls } = fakeChain();
    await expect(
      new SettlementCoordinator(chain, 5).settle(quote, record, {
        report: passingReport({
          checks: [{ type: "record_count", passed: false, message: "failed" }],
        }),
        nowUnix: 100,
      })
    ).rejects.toBeInstanceOf(VerificationFailed);
    expect(calls).toEqual([]);
  });

  it("recovers an ambiguously confirmed refund from TaskState", async () => {
    const harness = fakeChain(pending(100));
    harness.chain.refund = async () => {
      harness.setState({ ...pending(100), status: "refunded" });
      throw new TransactionSubmissionError(
        "ambiguous",
        "ambiguous-refund-signature"
      );
    };
    await expect(
      new SettlementCoordinator(harness.chain, 5).refundExpired(quote, 100)
    ).resolves.toBe("ambiguous-refund-signature");
  });

  it("waits for the on-chain clock before refunding after seller expiration", async () => {
    const harness = fakeChain(pending(100));
    let chainUnix = 99;
    Object.assign(harness.chain, {
      async getChainUnixTime() {
        const current = chainUnix;
        chainUnix += 1;
        return current;
      },
    });
    harness.chain.refund = async () => {
      if (chainUnix <= 100)
        throw new TransactionSubmissionError(
          "on-chain deadline has not been reached",
          "early-refund-signature"
        );
      harness.setState({ ...pending(100), status: "refunded" });
      return "refund-after-chain-deadline";
    };

    await expect(
      new SettlementCoordinator(harness.chain, 5).refundExpired(quote)
    ).resolves.toBe("refund-after-chain-deadline");
  });

  it("recovers an ambiguously confirmed cancellation from TaskState", async () => {
    const harness = fakeChain(pending(200));
    harness.chain.cancel = async () => {
      harness.setState({ ...pending(200), status: "refunded" });
      throw new TransactionSubmissionError(
        "ambiguous",
        "ambiguous-cancel-signature"
      );
    };
    await expect(
      new SettlementCoordinator(harness.chain, 5).cancelVoluntarily(quote, 100)
    ).resolves.toBe("ambiguous-cancel-signature");
  });
});
