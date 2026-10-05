import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { taskCallSchema } from "../../src/core/task-controller.js";
import type { ProviderDefinitionV1 } from "../../src/registry/providers.js";
import { normalizeService } from "../../src/registry/services.js";

const service = {
  id: "orders",
  name: "Orders",
  description: "Creates an order",
  capability: "orders.create",
  exposure: "both",
  price_base_units: "1",
  timeout_seconds: 30,
  privacy_support: false,
  provider_connector_ref: "rest-orders",
  verification_policy: {
    version: "1",
    level: 1,
    checks: [{ type: "json_schema", schema_ref: "generic-object-v1" }],
  },
};
const provider: ProviderDefinitionV1 = {
  version: "1",
  provider_id: "rest-orders",
  display_name: "Orders",
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
};

describe("Phase 4B.2 provider secret boundaries", () => {
  it.each([
    { provider_api_secret: "raw" },
    { secret_ref: "orders-api-v1" },
    { credential: "raw" },
    { authorization: "Bearer raw" },
  ])("rejects raw or ref provisioning from service onboarding: %j", (extra) => {
    expect(() =>
      normalizeService({ ...service, ...extra }, [provider])
    ).toThrow();
  });

  it.each([
    { provider_api_secret: "raw" },
    { secret_ref: "orders-api-v1" },
    { provider_config: { endpoint: "https://provider.example" } },
  ])(
    "rejects provider secret/config fields from buyer task inputs: %j",
    (extra) => {
      expect(() =>
        taskCallSchema.parse({
          task_id: "1",
          buyer: Keypair.generate().publicKey.toBase58(),
          service_id: "orders",
          is_private: false,
          input: { order: 1 },
          transport: "MCP",
          ...extra,
        })
      ).toThrow();
    }
  );
});
