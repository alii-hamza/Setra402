import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  SourceSamplingCheckV1,
  VerificationPolicyV1,
} from "../../src/types.js";
import { FileChallengeStore } from "../../src/verification/level2/challenge-store.js";
import { parseVerificationPolicy } from "../../src/verification/policy.js";
import { verificationHarness } from "../fixtures/verification-harness.js";

const source: SourceSamplingCheckV1 = {
  type: "source_sampling",
  pointer: "/records",
  sample_count: 2,
  source_url_field: "source_url",
  fields: ["id"],
  allowed_domains: ["example.com"],
  minimum_match_bps: 10_000,
};
const policy: VerificationPolicyV1 = {
  version: "1",
  level: 2,
  checks: [{ type: "record_count", pointer: "/records", exact: 2 }, source],
};
const value = {
  records: [
    { id: "a", source_url: "https://example.com/a" },
    { id: "b", source_url: "https://example.com/b" },
  ],
};
async function harness(pass = true) {
  const h = verificationHarness(policy, value);
  const challenges = new FileChallengeStore(
    await mkdtemp(join(tmpdir(), "setra-engine-challenges-"))
  );
  h.context.source = {
    challenges,
    sourceClient: {
      async retrieve(url) {
        return { id: pass ? url.split("/").pop() : "wrong" };
      },
    },
  };
  return h;
}
describe("L1 AND L2 authoritative report", () => {
  it("settles a combined PASS only through the existing SettlementCoordinator", async () => {
    const h = await harness();
    const report = await h.engine.verify(
      h.manifest,
      policy,
      h.result,
      h.context
    );
    expect(report.passed).toBe(true);
    expect(report.level).toBe(2);
    await h.settlement.settle(h.quote, h.record, { report });
    expect(h.calls.filter((c) => c === "settle")).toHaveLength(1);
  });
  it("L2 failure never settles or cancels and refund waits for the chain deadline", async () => {
    const h = await harness(false);
    const report = await h.engine.verify(
      h.manifest,
      policy,
      h.result,
      h.context
    );
    expect(report.passed).toBe(false);
    await expect(
      h.settlement.settle(h.quote, h.record, { report })
    ).rejects.toThrow();
    expect(h.current().status).toBe("pending");
    expect(h.calls).not.toContain("settle");
    expect(h.calls).not.toContain("cancel");
    await expect(h.settlement.refundExpired(h.quote, 99)).rejects.toThrow();
    await h.settlement.refundExpired(h.quote, 100);
    expect(h.current().status).toBe("refunded");
  });
  it("L1 failure cannot be averaged away by L2 PASS", async () => {
    const candidate: VerificationPolicyV1 = {
      ...policy,
      checks: [{ type: "record_count", pointer: "/records", exact: 3 }, source],
    };
    const h = verificationHarness(candidate, value);
    h.context.source = (await harness()).context.source!;
    const report = await h.engine.verify(
      h.manifest,
      candidate,
      h.result,
      h.context
    );
    expect(
      report.checks.find((c) => c.type === "source_sampling")?.passed
    ).toBe(true);
    expect(report.passed).toBe(false);
  });
  it("generates no challenge before validating final result and commitments", async () => {
    const h = await harness();
    const spy = vi.spyOn(h.context.source!.challenges, "getOrCreate");
    await h.engine.verify(
      h.manifest,
      policy,
      { ...h.result, resultHash: "ff".repeat(32) },
      h.context
    );
    expect(spy).not.toHaveBeenCalled();
    const report = await h.engine.verify(
      h.manifest,
      policy,
      h.result,
      h.context
    );
    expect(spy).toHaveBeenCalledOnce();
    expect(report.passed).toBe(true);
  });
  it("holds an immutable result snapshot across async commitment checks", async () => {
    const h = await harness();
    const savedHash = h.result.resultHash;
    h.context.verifyManifestCommitment = async () => {
      h.result.result = { records: [] };
    };
    const report = await h.engine.verify(
      h.manifest,
      policy,
      h.result,
      h.context
    );
    expect(report.passed).toBe(true);
    expect(report.resultHash).toBe(savedHash);
  });
  it.each([1, 3])("rejects incorrect level %s for L2 checks", (level) => {
    expect(() => parseVerificationPolicy({ ...policy, level })).toThrow();
  });
});
