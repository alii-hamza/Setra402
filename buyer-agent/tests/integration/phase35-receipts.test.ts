import { describe, it, expect } from "vitest";
import { verificationHarness } from "../fixtures/verification-harness.js";
import { TransactionSubmissionError } from "../../src/errors.js";
import { hashCanonical } from "../../src/manifest/hash.js";

describe("Phase 3.5 receipts (SIMULATED signature/account responses)", () => {
  it.each(["public", "private", "refund", "cancel"])(
    "%s does not promote an unconfirmed signature from final account state",
    async (action) => {
      const h = verificationHarness(
        {
          version: "1",
          level: 1,
          checks: [{ type: "record_count", pointer: "/records", exact: 1 }],
        },
        { records: [{}] }
      );
      if (action === "private") {
        h.quote.isPrivate = true;
        h.manifest.isPrivate = true;
        h.current().isPrivate = true;
        h.record.manifestHash = hashCanonical(h.manifest);
        h.context.committedManifestHash = h.record.manifestHash;
      }
      const report = await h.engine.verify(
        h.manifest,
        h.quote.verificationPolicy,
        h.result,
        h.context
      );
      const failure = new TransactionSubmissionError(
        "unknown receipt",
        "unconfirmed-signature"
      );
      const execute = async () => {
        h.current().status =
          action === "public" || action === "private" ? "settled" : "refunded";
        throw failure;
      };
      h.chain.settlePublic = execute;
      h.chain.settlePrivate = execute;
      h.chain.refund = execute;
      h.chain.cancel = execute;
      let reads = 0;
      h.chain.fetchNullifierRecord = async () => (++reads === 1 ? null : {});
      h.chain.confirmSignature = async () => false;
      const call = () =>
        action === "refund"
          ? h.settlement.refundExpired(h.quote, 100)
          : action === "cancel"
          ? h.settlement.cancelVoluntarily(h.quote, 50)
          : h.settlement.settle(h.quote, h.record, {
              report,
              nullifier: new Uint8Array(32),
            });
      await expect(call()).rejects.toBe(failure);
      h.reset();
      reads = 0;
      h.chain.confirmSignature = async () => true;
      await expect(call()).resolves.toBeDefined();
    }
  );
});
