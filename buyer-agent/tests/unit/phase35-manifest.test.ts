import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManifestStore } from "../../src/manifest/store.js";
import { verificationHarness } from "../fixtures/verification-harness.js";
describe("Phase 3.5 manifest journal integrity (ACTUAL filesystem)", () => {
  it.each([
    "null",
    "{}",
    '{"manifestHash":"' +
      "0".repeat(64) +
      '","manifest":{},"initializeSignature":"sig"}',
  ])("does not load incomplete stored manifest %s", (bytes) => {
    const store = new ManifestStore(
      mkdtempSync(join(tmpdir(), "setra35-manifest-"))
    );
    writeFileSync(store.pathFor("test-pda"), bytes);
    expect(() => store.load("test-pda")).toThrow(/manifest|journal|corrupt/i);
  });
  it("loads a valid legacy Phase 3 manifest without altering it", () => {
    const h = verificationHarness(
      {
        version: "1",
        level: 1,
        checks: [{ type: "record_count", pointer: "/records", exact: 1 }],
      },
      { records: [{}] }
    );
    const store = new ManifestStore(
      mkdtempSync(join(tmpdir(), "setra35-manifest-"))
    );
    writeFileSync(
      store.pathFor(h.quote.taskStatePda),
      JSON.stringify(h.record)
    );
    expect(store.load(h.quote.taskStatePda)).toEqual(h.record);
  });
});
