import { describe, expect, it } from "vitest";
import { hashCanonical } from "../../src/manifest/hash.js";
import { VerificationEngine } from "../../src/verification/engine.js";
import type {
  ResultEnvelopeV1,
  TaskManifestV1,
  VerificationPolicyV1,
} from "../../src/types.js";

const policy: VerificationPolicyV1 = {
  version: "1",
  level: 1,
  checks: [
    { type: "json_schema", schema_ref: "records-v1" },
    { type: "record_count", pointer: "/records", min: 1 },
    { type: "required_fields", pointer: "/records", fields: ["id"] },
    { type: "unique", pointer: "/records", field: "id" },
  ],
};
const resultValue = { records: [{ id: "one" }] };
const result: ResultEnvelopeV1 = {
  version: "1",
  taskId: "7",
  serviceId: "service",
  result: resultValue,
  resultHash: hashCanonical(resultValue),
  evidence: [],
  completedAtUnix: 100,
  input: resultValue,
  output_hash: hashCanonical(resultValue),
};
const manifest: TaskManifestV1 = {
  version: "1",
  taskId: "7",
  serviceId: "service",
  buyer: "buyer",
  sellerTokenAccount: "seller-token",
  sellerOwner: "seller",
  verifier: "verifier",
  mint: "mint",
  amountBaseUnits: "10",
  timeoutSeconds: 60,
  isPrivate: false,
  taskSpecHash: "11".repeat(32),
  policyHash: hashCanonical(policy),
  quoteHash: "22".repeat(32),
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    committedManifestHash: hashCanonical(manifest),
    verifierPubkey: "verifier",
    nowUnix: 100,
    schemas: new Map([
      [
        "records-v1",
        {
          type: "object",
          required: ["records"],
          properties: {
            records: {
              type: "array",
              items: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      ],
    ]),
    async verifyManifestCommitment() {},
    async loadArtifact() {
      return null;
    },
    solana: {
      async getTransaction() {
        return null;
      },
      async getAccount() {
        return null;
      },
    },
    ...overrides,
  };
}

describe("VerificationEngine", () => {
  it("passes only after commitments and all mandatory checks pass", async () => {
    const report = await new VerificationEngine().verify(
      manifest,
      policy,
      result,
      context()
    );
    expect(report.passed).toBe(true);
    expect(report.checks.every((check) => check.passed)).toBe(true);
    expect(report.verifierPubkey).toBe("verifier");
  });

  it.each([
    ["manifest", { committedManifestHash: "ff".repeat(32) }, policy, result],
    [
      "policy",
      {},
      {
        ...policy,
        checks: [{ type: "record_count", pointer: "/records", min: 2 }],
      },
      result,
    ],
    ["result", {}, policy, { ...result, resultHash: "ff".repeat(32) }],
    ["verifier", { verifierPubkey: "different" }, policy, result],
  ] as const)(
    "fails before Level-1 checks on %s tampering",
    async (_name, ctx, candidatePolicy, candidateResult) => {
      const report = await new VerificationEngine().verify(
        manifest,
        candidatePolicy as VerificationPolicyV1,
        candidateResult as ResultEnvelopeV1,
        context(ctx)
      );
      expect(report.passed).toBe(false);
      expect(report.checks.some((check) => !check.passed)).toBe(true);
      expect(report.checks.some((check) => check.type === "record_count")).toBe(
        false
      );
    }
  );

  it("fails when any mandatory Level-1 check fails", async () => {
    const badResultValue = {
      records: [{ id: "duplicate" }, { id: "duplicate" }],
    };
    const badResult = {
      ...result,
      result: badResultValue,
      resultHash: hashCanonical(badResultValue),
    };
    const report = await new VerificationEngine().verify(
      manifest,
      policy,
      badResult,
      context()
    );
    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.type === "unique")?.passed).toBe(
      false
    );
  });

  it("does not treat a matching legacy output_hash as settlement authority", async () => {
    const failingPolicy: VerificationPolicyV1 = {
      version: "1",
      level: 1,
      checks: [{ type: "record_count", pointer: "/records", min: 2 }],
    };
    const committedManifest = {
      ...manifest,
      policyHash: hashCanonical(failingPolicy),
    };
    const legacyMatch = {
      ...result,
      output_hash: hashCanonical(result.input),
    };
    const report = await new VerificationEngine().verify(
      committedManifest,
      failingPolicy,
      legacyMatch,
      context({ committedManifestHash: hashCanonical(committedManifest) })
    );
    expect(legacyMatch.output_hash).toBe(hashCanonical(legacyMatch.input));
    expect(report.passed).toBe(false);
  });
});
