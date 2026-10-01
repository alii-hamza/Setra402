import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { loadConfig } from "../../src/config.js";

describe("strict configuration", () => {
  it("loads persisted buyer and verifier keypairs without generating identities", () => {
    const dir = mkdtempSync(join(tmpdir(), "setra402-config-"));
    const buyer = Keypair.generate();
    const verifier = Keypair.generate();
    const buyerPath = join(dir, "buyer.json");
    const verifierPath = join(dir, "verifier.json");
    writeFileSync(buyerPath, JSON.stringify(Array.from(buyer.secretKey)));
    writeFileSync(verifierPath, JSON.stringify(Array.from(verifier.secretKey)));

    const config = loadConfig({
      PROGRAM_ID: "FUjN9K7C5yHr5NhVrJ7WCgifgDiBJnSDDGQjnNkUDBMN",
      RPC_URL: "http://127.0.0.1:8899",
      SELLER_URL: "http://127.0.0.1:3000",
      BUYER_KEYPAIR_PATH: buyerPath,
      VERIFIER_KEYPAIR_PATH: verifierPath,
      PROTOCOL_TREASURY_ADDRESS: Keypair.generate().publicKey.toBase58(),
      SETTLEMENT_SAFETY_MARGIN_SEC: "5",
    });

    expect(config.buyer.publicKey.equals(buyer.publicKey)).toBe(true);
    expect(config.verifier.publicKey.equals(verifier.publicKey)).toBe(true);
  });

  it("fails fast when the required treasury account is absent", () => {
    expect(() => loadConfig({})).toThrow(
      /PROGRAM_ID|PROTOCOL_TREASURY_ADDRESS/
    );
  });
});
