import { readFileSync } from "node:fs";
import { RunnerProfileRegistry } from "./runner-registry.js";

export function defaultRunners(): RunnerProfileRegistry {
  return new RunnerProfileRegistry([
    {
      id: "node22-test-v1",
      image:
        "node@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402",
      command: ["node", "--disable-sigusr1", "--test", "/tmp/tests.mjs"],
      artifactEvidenceId: "code-module",
      testBundle: readFileSync(
        new URL("../../../config/test-bundles/add-v1.mjs", import.meta.url)
      ),
      maxArtifactBytes: 1_048_576,
    },
  ]);
}
