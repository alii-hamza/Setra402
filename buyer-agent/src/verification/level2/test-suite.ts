import { createHash } from "node:crypto";
import type {
  Evidence,
  TestSuiteCheckV1,
  VerificationCheckResult,
} from "../../types.js";
import { fail, pass, isPlainObject } from "../level1/common.js";
import type { ArtifactContext } from "../level1/artifact-integrity.js";
import type { Sandbox } from "./docker-sandbox.js";
import type { RunnerProfileRegistry } from "./runner-registry.js";

export interface TestSuiteContext extends ArtifactContext {
  runners: RunnerProfileRegistry;
  sandbox: Sandbox;
}
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export async function checkTestSuite(
  policy: TestSuiteCheckV1,
  evidence: Evidence[],
  context?: TestSuiteContext,
  result?: unknown
): Promise<VerificationCheckResult> {
  if (!context) return fail(policy.type, "safe sandbox is not configured");
  const profile = context.runners.get(policy.runner_profile);
  if (!profile) return fail(policy.type, "unknown trusted runner profile");
  if (sha256(profile.testBundle) !== policy.test_bundle_hash)
    return fail(policy.type, "trusted test bundle hash mismatch; no execution");
  const claims = evidence.filter(
    (e) => e.type === "artifact" && e.id === profile.artifactEvidenceId
  );
  if (claims.length !== 1)
    return fail(policy.type, "exactly one committed artifact is required");
  const claim = claims[0]!;
  const descriptor = isPlainObject(result) ? result.artifact : null;
  if (
    !isPlainObject(descriptor) ||
    descriptor.id !== profile.artifactEvidenceId ||
    descriptor.content_hash !== claim.content_hash ||
    descriptor.size_bytes !== claim.size_bytes
  )
    return fail(
      policy.type,
      "artifact descriptor must be bound into the canonical result; no execution"
    );
  try {
    const artifact = await context.loadArtifact(
      profile.artifactEvidenceId,
      profile.maxArtifactBytes
    );
    if (
      !artifact ||
      artifact.bytes.byteLength > profile.maxArtifactBytes ||
      artifact.bytes.byteLength === 0 ||
      sha256(artifact.bytes) !== claim.content_hash ||
      artifact.bytes.byteLength !== claim.size_bytes
    )
      return fail(
        policy.type,
        "artifact commitment mismatch or malformed artifact; no execution"
      );
    new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes);
    const execution = await context.sandbox.execute(
      profile,
      Uint8Array.from(artifact.bytes),
      policy.timeout_seconds
    );
    const details = {
      runner_profile: profile.id,
      test_bundle_hash: policy.test_bundle_hash,
      artifact_hash: sha256(artifact.bytes),
      exit_code: execution.exitCode,
      duration_ms: execution.durationMs,
      output: execution.output,
    };
    return (execution.exitCode === 0 ? pass : fail)(
      policy.type,
      execution.exitCode === 0
        ? "trusted tests passed in isolated sandbox"
        : "trusted tests failed in isolated sandbox",
      details
    );
  } catch (error) {
    return fail(
      policy.type,
      error instanceof Error ? error.message : "sandbox failure"
    );
  }
}
