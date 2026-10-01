import { describe, expect, it } from "vitest";
import { ristretto255 } from "@noble/curves/ed25519.js";
import {
  createBlindMaterial,
  LegacyChaumianClient,
  verifyBlindSignature,
} from "../../src/privacy/legacy-chaumian.js";

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

  it("unblinds and verifies the seller signature against its mint key", () => {
    const material = createBlindMaterial({
      nullifierScalar: 11n,
      blindingScalar: 3n,
    });
    const mintSecret = 7n;
    const blinded = ristretto255.Point.fromHex(material.blindedPointHex);
    const response = {
      blind_signature: Buffer.from(
        blinded.multiply(mintSecret).toBytes()
      ).toString("hex"),
      mint_pubkey: Buffer.from(
        ristretto255.Point.BASE.multiply(mintSecret).toBytes()
      ).toString("hex"),
    };

    const voucher = verifyBlindSignature(material, response);
    expect(voucher.nullifier).toEqual(material.nullifier);
  });

  it("rejects a blind signature that does not match the returned mint key", () => {
    const material = createBlindMaterial({
      nullifierScalar: 11n,
      blindingScalar: 3n,
    });
    expect(() =>
      verifyBlindSignature(material, {
        blind_signature: Buffer.from(
          ristretto255.Point.BASE.multiply(5n).toBytes()
        ).toString("hex"),
        mint_pubkey: Buffer.from(
          ristretto255.Point.BASE.multiply(7n).toBytes()
        ).toString("hex"),
      })
    ).toThrow(/verification/);
  });
});
