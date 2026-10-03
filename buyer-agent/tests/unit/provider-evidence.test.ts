import { Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { deriveTaskPda } from "../../src/chain/pda.js";
import { hashCanonical } from "../../src/manifest/hash.js";
import {
  assessProviderEvidence,
  queryProviderEvidence,
} from "../../src/provider/evidence.js";

const buyer = Keypair.generate().publicKey,
  program = Keypair.generate().publicKey;
const [pda] = deriveTaskPda(program, buyer, 41n);
const input = { records: [1] };
const expected = {
  programId: program.toBase58(),
  buyer: buyer.toBase58(),
  taskId: "41",
  taskStatePda: pda.toBase58(),
  serviceId: "fixture-service",
  input,
};
function evidence(
  recordState:
    | "STORE_UNAVAILABLE"
    | "NO_LOCAL_EVIDENCE"
    | "INTENT_ONLY"
    | "RESULT_PERSISTED"
) {
  const hasIntent =
    recordState === "INTENT_ONLY" || recordState === "RESULT_PERSISTED";
  return {
    version: "1",
    buyer: expected.buyer,
    task_id: expected.taskId,
    task_state_pda: expected.taskStatePda,
    record_state: recordState,
    service_id: hasIntent ? expected.serviceId : null,
    input_hash: hasIntent ? hashCanonical(input) : null,
    result_hash:
      recordState === "RESULT_PERSISTED" ? hashCanonical({ done: true }) : null,
    provider_connector_ref: hasIntent ? "fixture-echo" : null,
    recovery_capability: hasIntent ? "DURABLE_RESULT_REPLAY_ONLY" : "NONE",
    profile_binding: "CURRENT_REGISTRY_ONLY",
    idempotency_key: null,
    provider_execution_id: null,
    status_query_supported: false,
    durable_receipt_supported: false,
  };
}
describe("Phase 4A.3 provider evidence contract", () => {
  it.each(["STORE_UNAVAILABLE", "NO_LOCAL_EVIDENCE", "INTENT_ONLY"] as const)(
    "keeps %s unknown",
    (state) => {
      expect(assessProviderEvidence(evidence(state), expected).status).toBe(
        "UNKNOWN_EXTERNAL_EFFECT"
      );
    }
  );
  it("reports a durable seller result only as unverified replay evidence", () => {
    expect(
      assessProviderEvidence(evidence("RESULT_PERSISTED"), expected).status
    ).toBe("RESULT_PERSISTED_UNVERIFIED");
  });
  it.each([
    "buyer",
    "task_id",
    "task_state_pda",
    "service_id",
    "input_hash",
  ] as const)("rejects wrong %s binding", (field) => {
    const changed = {
      ...evidence("RESULT_PERSISTED"),
      [field]:
        field === "task_id"
          ? "42"
          : field === "buyer" || field === "task_state_pda"
          ? Keypair.generate().publicKey.toBase58()
          : field === "input_hash"
          ? "a".repeat(64)
          : "other-service",
    };
    expect(() => assessProviderEvidence(changed, expected)).toThrow();
  });
  it("rejects fabricated provider IDs, status-query support, and unknown profile", () => {
    expect(() =>
      assessProviderEvidence(
        { ...evidence("INTENT_ONLY"), provider_execution_id: "job-1" },
        expected
      )
    ).toThrow();
    expect(() =>
      assessProviderEvidence(
        { ...evidence("INTENT_ONLY"), status_query_supported: true },
        expected
      )
    ).toThrow();
    expect(() =>
      assessProviderEvidence(
        { ...evidence("INTENT_ONLY"), provider_connector_ref: "unknown" },
        expected
      )
    ).toThrow();
  });
  it("rejects a result hash without durable result state", () => {
    expect(() =>
      assessProviderEvidence(
        { ...evidence("INTENT_ONLY"), result_hash: "a".repeat(64) },
        expected
      )
    ).toThrow();
  });
  it("rejects partial identity fields in an absent-state response", () => {
    expect(() =>
      assessProviderEvidence(
        { ...evidence("NO_LOCAL_EVIDENCE"), service_id: expected.serviceId },
        expected
      )
    ).toThrow();
  });
  it("uses GET only and rejects oversized responses", async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify(evidence("INTENT_ONLY")));
    });
    expect(
      (
        await queryProviderEvidence(
          "https://seller.example",
          expected,
          1000,
          fetcher as typeof fetch
        )
      ).status
    ).toBe("UNKNOWN_EXTERNAL_EFFECT");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const large = vi.fn(async () => new Response("x".repeat(16_385)));
    await expect(
      queryProviderEvidence(
        "https://seller.example",
        expected,
        1000,
        large as typeof fetch
      )
    ).rejects.toThrow(/byte limit/);
  });
});
