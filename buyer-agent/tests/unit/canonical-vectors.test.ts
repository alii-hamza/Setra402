import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/manifest/canonicalize.js";
import { hashCanonical } from "../../src/manifest/hash.js";

interface CanonicalVector {
  name: string;
  value: unknown;
  canonical: string;
  sha256: string;
}

describe("shared Phase 2 canonical hash vectors", () => {
  const path = new URL(
    "../../../shared/test-vectors/phase2-canonical-hashes.json",
    import.meta.url
  );
  const vectors = JSON.parse(readFileSync(path, "utf8")) as CanonicalVector[];

  it("contains at least ten cross-language fixtures", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(10);
  });

  it.each(vectors)("matches $name", (vector) => {
    expect(canonicalize(vector.value)).toBe(vector.canonical);
    expect(hashCanonical(vector.value)).toBe(vector.sha256);
  });
});
