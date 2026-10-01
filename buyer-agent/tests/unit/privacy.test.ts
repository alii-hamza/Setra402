import { describe, expect, it } from "vitest";
import { LegacyChaumianClient } from "../../src/privacy/legacy-chaumian.js";

describe("legacy private transport isolation", () => {
  it("fails closed when a u64 task id cannot be represented by the legacy JSON-number endpoint", async () => {
    const client = new LegacyChaumianClient("http://127.0.0.1:3000");
    await expect(
      client.requestBlindSignature({
        buyer: "11111111111111111111111111111111",
        taskId: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        blindedPointHex: "00".repeat(32),
      })
    ).rejects.toThrow(/safe-integer/);
  });
});
