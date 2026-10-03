import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RunnerProfileRegistry } from "../../src/verification/level2/runner-registry.js";
import {
  checkTestSuite as verifyTestSuite,
  type TestSuiteContext,
} from "../../src/verification/level2/test-suite.js";
import type { Evidence, TestSuiteCheckV1 } from "../../src/types.js";
import { parseVerificationPolicy } from "../../src/verification/policy.js";

const bytes = Buffer.from("export const add = (a,b) => a+b;");
const bundle = Buffer.from("trusted test bundle");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const policy = {
  type: "test_suite" as const,
  runner_profile: "node22-test-v1",
  test_bundle_hash: sha(bundle),
  timeout_seconds: 2,
};
const evidence = [
  {
    type: "artifact",
    id: "code-module",
    content_hash: sha(bytes),
    size_bytes: bytes.length,
  },
];
const committedResult = {
  artifact: {
    id: "code-module",
    content_hash: sha(bytes),
    size_bytes: bytes.length,
  },
};
const checkTestSuite = (
  p: TestSuiteCheckV1,
  e: Evidence[],
  c?: TestSuiteContext
) => verifyTestSuite(p, e, c, committedResult);
function context() {
  const execute = vi.fn(async () => ({
    exitCode: 0,
    output: "pass",
    durationMs: 1,
  }));
  return {
    runners: new RunnerProfileRegistry([
      {
        id: "node22-test-v1",
        image: "node@sha256:" + "ab".repeat(32),
        command: ["node", "--test", "/input/tests.mjs"],
        artifactEvidenceId: "code-module",
        testBundle: bundle,
        maxArtifactBytes: 1_048_576,
      },
    ]),
    sandbox: { execute },
    loadArtifact: async () => ({ bytes }),
  };
}
describe("trusted test-suite boundary", () => {
  it("rejects artifact bytes changed after the canonical descriptor was committed", async () => {
    const ctx = context();
    ctx.loadArtifact = async () => ({
      bytes: Buffer.from("export const add=()=>999;"),
    });
    expect((await checkTestSuite(policy, evidence, ctx)).passed).toBe(false);
    expect(ctx.sandbox.execute).not.toHaveBeenCalled();
  });
  it("runs the committed trusted bundle and artifact", async () => {
    const ctx = context();
    expect((await checkTestSuite(policy, evidence, ctx)).passed).toBe(true);
    expect(ctx.sandbox.execute).toHaveBeenCalledOnce();
  });
  it.each([
    "wrong-hash",
    "unknown-runner",
    "artifact-hash",
    "artifact-size",
    "missing-artifact",
  ])("fails before execution on %s", async (problem) => {
    const ctx = context();
    const check = { ...policy };
    const items = structuredClone(evidence);
    if (problem === "wrong-hash") check.test_bundle_hash = "ff".repeat(32);
    if (problem === "unknown-runner") check.runner_profile = "unknown";
    if (problem === "artifact-hash") items[0]!.content_hash = "ff".repeat(32);
    if (problem === "artifact-size") items[0]!.size_bytes++;
    if (problem === "missing-artifact") items.length = 0;
    expect((await checkTestSuite(check, items, ctx)).passed).toBe(false);
    expect(ctx.sandbox.execute).not.toHaveBeenCalled();
  });
  it("fails closed if sandbox is unavailable", async () => {
    expect((await checkTestSuite(policy, evidence)).passed).toBe(false);
  });
  it("rejects artifact evidence not committed in the result", async () => {
    const ctx = context();
    expect((await verifyTestSuite(policy, evidence, ctx, {})).passed).toBe(
      false
    );
    expect(ctx.sandbox.execute).not.toHaveBeenCalled();
  });
  it("does not turn a failed test run into PASS", async () => {
    const ctx = context();
    ctx.sandbox.execute.mockResolvedValue({
      exitCode: 1,
      output: "test failed",
      durationMs: 1,
    });
    expect((await checkTestSuite(policy, evidence, ctx)).passed).toBe(false);
  });
  it.each([
    "command",
    "shell",
    "entrypoint",
    "test_bundle",
    "docker_flags",
    "host_path",
  ])("rejects seller-controlled %s", (field) => {
    expect(() =>
      parseVerificationPolicy({
        version: "1",
        level: 2,
        checks: [{ ...policy, [field]: "evil" }],
      })
    ).toThrow();
  });
});
