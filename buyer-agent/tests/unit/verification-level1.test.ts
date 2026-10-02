import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkArtifactIntegrity } from "../../src/verification/level1/artifact-integrity.js";
import { checkFreshness } from "../../src/verification/level1/freshness.js";
import { checkJsonSchema } from "../../src/verification/level1/json-schema.js";
import { checkRecordCount } from "../../src/verification/level1/record-count.js";
import { checkRequiredFields } from "../../src/verification/level1/required-fields.js";
import { checkSolanaState } from "../../src/verification/level1/solana-state.js";
import { checkUnique } from "../../src/verification/level1/unique.js";

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

describe("Level-1 json_schema", () => {
  const schemas = new Map<string, unknown>([
    [
      "records-v1",
      {
        type: "object",
        required: ["records"],
        properties: { records: { type: "array", items: { type: "object" } } },
        additionalProperties: false,
      },
    ],
  ]);

  it.each([
    ["valid", { records: [] }, true],
    ["invalid", { records: "no" }, false],
    ["malformed", null, false],
    ["missing required field", {}, false],
    ["boundary empty array", { records: [] }, true],
  ])("handles %s input", async (_name, result, passed) => {
    const check = await checkJsonSchema(
      { type: "json_schema", schema_ref: "records-v1" },
      result,
      { schemas }
    );
    expect(check.passed).toBe(passed);
  });

  it("rejects remote refs and maliciously deep schemas", async () => {
    const remote = new Map<string, unknown>([
      ["remote", { $ref: "https://attacker.invalid/schema.json" }],
    ]);
    expect(
      (
        await checkJsonSchema(
          { type: "json_schema", schema_ref: "remote" },
          {},
          { schemas: remote }
        )
      ).passed
    ).toBe(false);

    let deep: unknown = { type: "string" };
    for (let index = 0; index < 40; index += 1) deep = { items: deep };
    expect(
      (
        await checkJsonSchema({ type: "json_schema", schema_ref: "deep" }, [], {
          schemas: new Map([["deep", deep]]),
        })
      ).passed
    ).toBe(false);
  });
});

describe("Level-1 record_count", () => {
  it.each([
    ["valid", { records: [1, 2] }, { min: 1, max: 3 }, true],
    ["invalid", { records: [1] }, { exact: 2 }, false],
    ["malformed", { records: "one" }, { min: 1 }, false],
    ["missing", {}, { min: 0 }, false],
    ["boundary", { records: [1, 2] }, { min: 2, max: 2 }, true],
  ])("handles %s input", (_name, result, limits, passed) => {
    expect(
      checkRecordCount(
        { type: "record_count", pointer: "/records", ...limits },
        result
      ).passed
    ).toBe(passed);
  });
});

describe("Level-1 required_fields", () => {
  it.each([
    ["valid", [{ a: 1 }, { a: 2 }], undefined, true],
    ["invalid", [{ a: 1 }, {}], undefined, false],
    ["malformed", ["not-object"], undefined, false],
    ["missing", {}, undefined, false],
    ["boundary ratio", [{ a: 1 }, {}], 5000, true],
  ])("handles %s input", (_name, records, ratio, passed) => {
    expect(
      checkRequiredFields(
        {
          type: "required_fields",
          pointer: "/records",
          fields: ["a"],
          ...(ratio === undefined ? {} : { minimum_valid_ratio_bps: ratio }),
        },
        { records }
      ).passed
    ).toBe(passed);
  });
});

describe("Level-1 unique", () => {
  it.each([
    ["valid", [{ id: "a" }, { id: "b" }], true],
    ["duplicate", [{ id: "a" }, { id: "a" }], false],
    ["malformed", [1], false],
    ["missing field", [{ id: "a" }, {}], false],
    ["boundary empty", [], true],
  ])("handles %s input", (_name, records, passed) => {
    expect(
      checkUnique(
        { type: "unique", pointer: "/records", field: "id" },
        { records }
      ).passed
    ).toBe(passed);
  });
});

describe("Level-1 freshness", () => {
  const nowUnix = 1_000;
  it.each([
    ["valid", 950, true],
    ["expired", 899, false],
    ["malformed", "950", false],
    ["missing", undefined, false],
    ["boundary", 900, true],
    ["future", 1_001, false],
  ])("handles %s input", (_name, timestamp, passed) => {
    const result = timestamp === undefined ? {} : { generated: timestamp };
    expect(
      checkFreshness(
        {
          type: "freshness",
          timestamp_pointer: "/generated",
          max_age_seconds: 100,
        },
        result,
        nowUnix
      ).passed
    ).toBe(passed);
  });
});

describe("Level-1 artifact_integrity", () => {
  const bytes = new TextEncoder().encode("artifact");
  const hash = sha256(bytes);
  const loadArtifact = async (id: string) =>
    id === "present" ? { bytes, mimeType: "application/json" } : null;

  it.each([
    ["valid", "present", hash, 8, ["application/json"], true],
    ["wrong hash", "present", "00".repeat(32), 8, undefined, false],
    ["malformed evidence", "present", "not-a-hash", 8, undefined, false],
    ["missing artifact", "missing", hash, 8, undefined, false],
    ["size boundary", "present", hash, bytes.length, undefined, true],
    ["oversized", "present", hash, bytes.length - 1, undefined, false],
    ["wrong MIME", "present", hash, 8, ["text/plain"], false],
  ])(
    "handles %s",
    async (_name, id, evidenceHash, maxSize, allowedMimeTypes, passed) => {
      const check = await checkArtifactIntegrity(
        {
          type: "artifact_integrity",
          evidence_id: id,
          max_size_bytes: maxSize,
          ...(allowedMimeTypes ? { allowed_mime_types: allowedMimeTypes } : {}),
        },
        [
          {
            type: "artifact",
            id,
            content_hash: evidenceHash,
            size_bytes: bytes.length,
            mime_type: "application/json",
          },
        ],
        { loadArtifact }
      );
      expect(check.passed).toBe(passed);
    }
  );
});

describe("Level-1 solana_state", () => {
  const reader = {
    async getTransaction(signature: string) {
      if (signature === "missing") return null;
      if (signature === "multi")
        return {
          transfers: [
            { recipient: "other", mint: "other", amountBaseUnits: "1" },
            { recipient: "recipient", mint: "mint", amountBaseUnits: "10" },
          ],
        };
      return {
        recipient: "recipient",
        mint: "mint",
        amountBaseUnits: "10",
      };
    },
    async getAccount(address: string) {
      if (address === "missing") return null;
      return { owner: "owner" };
    },
  };

  it.each([
    ["valid transaction", "sig", "recipient", "mint", true],
    ["wrong recipient", "sig", "wrong", "mint", false],
    ["wrong mint", "sig", "recipient", "wrong", false],
    ["missing transaction", "missing", "recipient", "mint", false],
    ["malformed amount", "sig", "recipient", "mint", false, "01"],
    ["amount boundary", "sig", "recipient", "mint", true, "10"],
    ["matching inner transfer", "multi", "recipient", "mint", true, "10"],
  ])(
    "handles %s",
    async (_name, signature, recipient, mint, passed, amount = "10") => {
      const check = await checkSolanaState(
        {
          type: "solana_state",
          target: "transaction",
          signature,
          commitment: "confirmed",
          expected_recipient: recipient,
          expected_mint: mint,
          expected_amount_base_units: amount,
        },
        reader
      );
      expect(check.passed).toBe(passed);
    }
  );

  it.each([
    ["valid account", "account", "owner", true],
    ["wrong owner", "account", "wrong", false],
    ["missing account", "missing", "owner", false],
  ])("handles %s", async (_name, account, owner, passed) => {
    expect(
      (
        await checkSolanaState(
          {
            type: "solana_state",
            target: "account",
            account,
            commitment: "finalized",
            expected_owner: owner,
          },
          reader
        )
      ).passed
    ).toBe(passed);
  });
});
