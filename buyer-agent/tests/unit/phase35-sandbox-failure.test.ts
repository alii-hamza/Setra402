import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { DockerSandbox } from "../../src/verification/level2/docker-sandbox.js";
import { SandboxLeases } from "../../src/verification/level2/sandbox-leases.js";
import { defaultRunners } from "../../src/verification/level2/default-runners.js";
import { protectedCallSchema } from "../../src/mcp/contracts.js";
describe("Phase 3.5 unavailable isolation (SIMULATED daemon, ACTUAL CLI/filesystem)", () => {
  it.each(["before", "during"])(
    "daemon loss %s execution never returns PASS and retains unresolved cleanup evidence",
    async (when) => {
      const root = mkdtempSync(join(tmpdir(), "setra35-daemon-")),
        helper = join(root, "daemon.cjs"),
        leases = join(root, "leases");
      writeFileSync(
        helper,
        `const a=process.argv.slice(2);if(a[0]==="create"&&${JSON.stringify(
          when
        )}==="during")process.exit(0);console.error("daemon unavailable");process.exit(1);`
      );
      const sandbox = new DockerSandbox(
        { executable: process.execPath, prefix: [helper] },
        65536,
        new SandboxLeases(leases)
      );
      await expect(
        sandbox.execute(
          defaultRunners().get("node22-test-v1")!,
          Buffer.from("malicious artifact never executed on host"),
          1
        )
      ).rejects.toThrow(/sandbox/);
      expect(
        readdirSync(leases).filter((file) => file.endsWith(".lease"))
      ).toHaveLength(1);
    }
  );
  it("all privileged operator/MCP fields are rejected, including JSON duplicate-field attempts", () => {
    const call = {
      task_id: "35",
      buyer: "11111111111111111111111111111111",
      service_id: "legacy-rest",
      is_private: false,
      input: {},
    };
    for (const field of [
      "signer",
      "secret_key",
      "buyer_private_key",
      "verifier_private_key",
      "settlement_destination",
      "protocol_treasury",
      "policy_hash",
      "verification_result",
      "runner_command",
      "docker_image",
      "test_bundle",
      "host_path",
      "mcp_stdio_command",
    ]) {
      expect(
        protectedCallSchema.safeParse({ ...call, [field]: "evil" }).success
      ).toBe(false);
      const raw =
        JSON.stringify(call).slice(0, -1) +
        `,${JSON.stringify(field)}:"trusted",${JSON.stringify(field)}:"evil"}`;
      expect(protectedCallSchema.safeParse(JSON.parse(raw)).success).toBe(
        false
      );
    }
    expect(
      protectedCallSchema.safeParse({
        ...call,
        input: { data: "x".repeat(65537) },
      }).success
    ).toBe(false);
  });
});
