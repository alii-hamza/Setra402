import { describe, expect, it } from "vitest";
import {
  parseProviderDefinitions,
  providerDefinitionV1Schema,
} from "../../src/registry/providers.js";
import { PROVIDER_PROFILES } from "../../src/registry/services.js";

const keyed = {
  version: "1",
  provider_id: "rest-orders",
  display_name: "REST orders",
  connector_type: "REST_API",
  execution_profile: "orders-v1",
  capabilities: ["orders.create"],
  privacy_support: false,
  active: true,
  recovery_capabilities: {
    idempotency: "KEYED",
    execution_id: true,
    status_query: true,
    durable_receipt: true,
    deterministic_replay: true,
    may_produce_non_idempotent_external_effect: false,
  },
  secret_refs: ["orders-api-v1"],
} as const;

describe("Phase 4B.1 provider definition contract", () => {
  it("accepts a strict versioned provider definition", () => {
    expect(providerDefinitionV1Schema.parse(keyed)).toEqual(keyed);
  });

  it.each([
    ["unknown version", { version: "2" }],
    ["invalid provider ID", { provider_id: "Bad Provider" }],
    ["unknown connector type", { connector_type: "SHELL" }],
  ])("rejects %s", (_name, change) => {
    expect(() =>
      providerDefinitionV1Schema.parse({ ...keyed, ...change })
    ).toThrow();
  });

  it("rejects missing recovery declarations", () => {
    const { deterministic_replay: _removed, ...recovery } =
      keyed.recovery_capabilities;
    expect(() =>
      providerDefinitionV1Schema.parse({
        ...keyed,
        recovery_capabilities: recovery,
      })
    ).toThrow();
  });

  it.each([
    [
      "status without execution ID",
      { execution_id: false, status_query: true },
    ],
    [
      "receipt without execution ID",
      { execution_id: false, durable_receipt: true },
    ],
    [
      "deterministic replay without keyed idempotency",
      { idempotency: "NONE", deterministic_replay: true },
    ],
    [
      "non-idempotent side effect with deterministic replay",
      {
        may_produce_non_idempotent_external_effect: true,
        deterministic_replay: true,
      },
    ],
  ])("rejects unsupported capability combination: %s", (_name, change) => {
    expect(() =>
      providerDefinitionV1Schema.parse({
        ...keyed,
        recovery_capabilities: {
          ...keyed.recovery_capabilities,
          ...change,
        },
      })
    ).toThrow();
  });

  it("preserves a provider with no idempotency or recovery support", () => {
    const parsed = providerDefinitionV1Schema.parse({
      ...keyed,
      provider_id: "unsafe-effects",
      recovery_capabilities: {
        idempotency: "NONE",
        execution_id: false,
        status_query: false,
        durable_receipt: false,
        deterministic_replay: false,
        may_produce_non_idempotent_external_effect: true,
      },
    });
    expect(parsed.recovery_capabilities.idempotency).toBe("NONE");
  });

  it("preserves explicit inactive state", () => {
    expect(
      providerDefinitionV1Schema.parse({ ...keyed, active: false }).active
    ).toBe(false);
  });

  it("rejects duplicate provider IDs", () => {
    expect(() => parseProviderDefinitions([keyed, keyed])).toThrow(
      /duplicate provider_id/
    );
  });

  it("keeps every checked-in fixture compatible and explicit", () => {
    expect(PROVIDER_PROFILES).toHaveLength(4);
    for (const profile of PROVIDER_PROFILES) {
      expect(profile.connector_type).toBe("LOCAL_FIXTURE");
      expect(profile.active).toBe(true);
      expect(profile.secret_refs).toEqual([]);
      expect(profile.recovery_capabilities).toEqual({
        idempotency: "KEYED",
        execution_id: false,
        status_query: false,
        durable_receipt: true,
        deterministic_replay: true,
        may_produce_non_idempotent_external_effect: false,
      });
    }
  });
});
