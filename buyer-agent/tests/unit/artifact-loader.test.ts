import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DirectoryArtifactLoader } from "../../src/verification/artifact-loader.js";

describe("DirectoryArtifactLoader", () => {
  it("loads only registered files under its allowlisted root", async () => {
    const parent = mkdtempSync(join(tmpdir(), "setra402-artifacts-"));
    const root = join(parent, "root");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(root);
    writeFileSync(join(root, "result.json"), "fixture");
    writeFileSync(join(parent, "outside.json"), "secret");
    const loader = new DirectoryArtifactLoader(
      root,
      new Map([
        [
          "valid",
          { relativePath: "result.json", mimeType: "application/json" },
        ],
        [
          "escape",
          { relativePath: "../outside.json", mimeType: "application/json" },
        ],
      ])
    );
    await expect(loader.loadArtifact("missing", 100)).resolves.toBeNull();
    await expect(loader.loadArtifact("escape", 100)).resolves.toBeNull();
    await expect(loader.loadArtifact("valid", 6)).resolves.toBeNull();
    const artifact = await loader.loadArtifact("valid", 7);
    expect(new TextDecoder().decode(artifact?.bytes)).toBe("fixture");
    expect(artifact?.mimeType).toBe("application/json");
  });
});
