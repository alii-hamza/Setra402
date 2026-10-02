import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  ServiceRegistry,
  PROVIDER_PROFILES,
} from "../../src/registry/services.js";
import { defaultRunners } from "../../src/verification/level2/default-runners.js";
import { hashCanonical } from "../../src/manifest/hash.js";
const baseline = new URL(
  "../../../seller-server/config/services.json",
  import.meta.url
);
const valid = {
  id: "registered-service",
  name: "Registered service",
  description: "Deterministic provider",
  capability: "setra402.task.echo",
  exposure: "both",
  price_base_units: "1500000",
  timeout_seconds: 30,
  privacy_support: true,
  provider_connector_ref: "fixture-echo",
  verification_policy: {
    version: "1",
    level: 1,
    checks: [{ type: "json_schema", schema_ref: "generic-object-v1" }],
  },
};
function setup(enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), "setra-registry-"));
  return {
    dir,
    registry: new ServiceRegistry(
      baseline,
      join(dir, "services.local.json"),
      enabled
    ),
  };
}
describe("server authoritative onboarding registry", () => {
  it("registers L1 with canonical server hash and read-back", async () => {
    const s = setup(),
      before = readFileSync(baseline);
    const saved = await s.registry.register(valid);
    expect(saved.policy_hash).toBe(hashCanonical(valid.verification_policy));
    expect(s.registry.list().find((v) => v.id === valid.id)).toEqual(saved);
    expect(readFileSync(baseline)).toEqual(before);
  });
  it("ignores a fake browser policy_hash and recomputes it", async () =>
    expect(
      (
        await setup().registry.register({
          ...valid,
          policy_hash: "f".repeat(64),
        })
      ).policy_hash
    ).toBe(hashCanonical(valid.verification_policy)));
  it("supports L2 source registration", async () => {
    const policy = {
      version: "1",
      level: 2,
      checks: [
        {
          type: "source_sampling",
          pointer: "/records",
          sample_count: 1,
          source_url_field: "source_url",
          fields: ["company"],
          allowed_domains: ["example.com"],
          minimum_match_bps: 10000,
        },
      ],
    };
    expect(
      (
        await setup().registry.register({
          ...valid,
          provider_connector_ref: "fixture-source",
          verification_policy: policy,
        })
      ).verification_policy
    ).toEqual(policy);
  });
  it("supports trusted L2 test registration", async () => {
    const policy = {
      version: "1",
      level: 2,
      checks: [
        {
          type: "test_suite",
          runner_profile: "node22-test-v1",
          test_bundle_hash: defaultRunners().list()[0]!.test_bundle_hash,
          timeout_seconds: 10,
        },
      ],
    };
    expect(
      (
        await setup().registry.register({
          ...valid,
          provider_connector_ref: "fixture-code",
          verification_policy: policy,
        })
      ).verification_policy
    ).toEqual(policy);
  });
  it("rejects baseline duplicate", async () => {
    await expect(
      setup().registry.register({ ...valid, id: "legacy-rest" })
    ).rejects.toThrow(/duplicate/);
  });
  it("rejects local duplicate", async () => {
    const s = setup();
    await s.registry.register(valid);
    await expect(s.registry.register(valid)).rejects.toThrow(/duplicate/);
  });
  it.each([
    { id: "../bad" },
    { name: "" },
    { capability: "bad capability" },
    { price_base_units: "0" },
    { price_base_units: "-1" },
    { price_base_units: "1.5" },
    { price_base_units: 1.5 },
    { timeout_seconds: 0 },
    { timeout_seconds: 1.5 },
    { exposure: "stdio" },
    { provider_connector_ref: "shell" },
    { shell: "bash" },
    { mcp_stdio_command: "node evil" },
    { provider_api_secret: "secret" },
  ])("rejects invalid or unsafe fields %j", async (patch) => {
    await expect(
      setup().registry.register({ ...valid, ...patch })
    ).rejects.toThrow();
  });
  it.each([
    { version: "1", level: 3, checks: [] },
    { version: "1", level: 1, checks: [{ type: "ai_advisory" }] },
    { version: "1", level: 1, checks: [{ type: "unknown" }] },
    {
      version: "1",
      level: 1,
      checks: [
        { type: "json_schema", schema_ref: "generic-object-v1", shell: "bash" },
      ],
    },
  ])(
    "rejects unknown policy or deferred verification %j",
    async (verification_policy) => {
      await expect(
        setup().registry.register({ ...valid, verification_policy })
      ).rejects.toThrow();
    }
  );
  it("enforces trusted test bundle hash before registration", async () => {
    await expect(
      setup().registry.register({
        ...valid,
        verification_policy: {
          version: "1",
          level: 2,
          checks: [
            {
              type: "test_suite",
              runner_profile: "node22-test-v1",
              test_bundle_hash: "0".repeat(64),
              timeout_seconds: 10,
            },
          ],
        },
      })
    ).rejects.toThrow(/bundle/);
  });
  it("write disabled leaves discovery available", async () => {
    const s = setup(false);
    expect(s.registry.list()).toHaveLength(2);
    await expect(s.registry.register(valid)).rejects.toThrow(/disabled/);
  });
  it("malformed overlay safely leaves baseline readable and blocks writes", async () => {
    const s = setup();
    writeFileSync(join(s.dir, "services.local.json"), "{broken");
    expect(s.registry.list()).toHaveLength(2);
    await expect(s.registry.register(valid)).rejects.toThrow(/malformed/);
  });
  it("atomic write has no leftover temporary/lock files", async () => {
    const s = setup();
    await s.registry.register(valid);
    expect(readdirSync(s.dir)).toEqual(["services.local.json"]);
    expect(existsSync(join(s.dir, "services.local.json.lock"))).toBe(false);
  });
  it("concurrent writers cannot silently overwrite the overlay", async () => {
    const s = setup();
    await Promise.all([
      s.registry.register(valid),
      s.registry.register({ ...valid, id: "second-service" }),
    ]);
    expect(s.registry.list()).toHaveLength(4);
  });
  it("profiles are server-only fixture configuration with no secrets", () => {
    expect(PROVIDER_PROFILES).toHaveLength(4);
    expect(JSON.stringify(PROVIDER_PROFILES)).not.toMatch(
      /secret|command|host_path/
    );
  });
});
