import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import {
  parseDevelopmentArgs,
  prepareDevelopmentEnvironment,
  runDevelopmentPreflight,
} from "../../src/dev/launcher.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "setra-dev-"));
  const buyer = Keypair.generate();
  const verifier = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const treasury = Keypair.generate().publicKey.toBase58();
  const sellerTokenAccount = Keypair.generate().publicKey.toBase58();
  const keyDirectory = join(root, "keys");
  mkdirSync(keyDirectory);
  const buyerPath = join(keyDirectory, "buyer.json");
  const verifierPath = join(keyDirectory, "verifier.json");
  writeFileSync(buyerPath, JSON.stringify(Array.from(buyer.secretKey)));
  writeFileSync(verifierPath, JSON.stringify(Array.from(verifier.secretKey)));
  const fixtureFile = join(root, "fixture.json");
  writeFileSync(
    fixtureFile,
    JSON.stringify({
      buyer: buyer.publicKey.toBase58(),
      verifier: verifier.publicKey.toBase58(),
      mint,
      treasuryTokenAccount: treasury,
      sellerTokenAccount,
    })
  );
  return {
    root,
    buyer,
    verifier,
    mint,
    treasury,
    sellerTokenAccount,
    buyerPath,
    verifierPath,
    fixtureFile,
  };
}

describe("local development launcher", () => {
  it("normalizes the accepted Role C environment into buyer and seller settings", () => {
    const f = fixture();
    const prepared = prepareDevelopmentEnvironment(
      {
        ROLE_C_PROGRAM_ID: "FUjN9K7C5yHr5NhVrJ7WCgifgDiBJnSDDGQjnNkUDBMN",
        ROLE_C_RPC_URL: "http://127.0.0.1:8899",
        ROLE_C_SELLER_URL: "http://127.0.0.1:3001",
        ROLE_C_EXPECTED_MINT: f.mint,
        ROLE_C_PROTOCOL_TREASURY: f.treasury,
        ROLE_C_BUYER_KEYPAIR_PATH: f.buyerPath,
        ROLE_C_VERIFIER_KEYPAIR_PATH: f.verifierPath,
        SETRA_FIXTURE_FILE: f.fixtureFile,
      },
      f.root
    );

    expect(prepared.runtime.expectedMint.toBase58()).toBe(f.mint);
    expect(prepared.buyer.buyer.publicKey.equals(f.buyer.publicKey)).toBe(true);
    expect(prepared.sellerEnvironment).toMatchObject({
      MINT: f.mint,
      SELLER_TOKEN_ACCOUNT: f.sellerTokenAccount,
      VERIFIER: f.verifier.publicKey.toBase58(),
      PROTOCOL_TREASURY: f.treasury,
      BIND_ADDR: "127.0.0.1:3001",
    });
    expect(JSON.stringify(prepared.summary)).not.toContain(
      Array.from(f.buyer.secretKey).join(",")
    );
  });

  it("refuses destructive reset flags", () => {
    expect(() => parseDevelopmentArgs(["--reset-test-ledger"])).toThrow(
      /ledger reset is not implemented/i
    );
    expect(parseDevelopmentArgs(["--check"])).toEqual({ checkOnly: true });
  });

  it("fails preflight on an occupied unowned port without changing processes", async () => {
    const f = fixture();
    const prepared = prepareDevelopmentEnvironment(
      {
        PROGRAM_ID: "FUjN9K7C5yHr5NhVrJ7WCgifgDiBJnSDDGQjnNkUDBMN",
        RPC_URL: "http://127.0.0.1:8899",
        SELLER_URL: "http://127.0.0.1:3001",
        EXPECTED_MINT: f.mint,
        PROTOCOL_TREASURY_ADDRESS: f.treasury,
        BUYER_KEYPAIR_PATH: f.buyerPath,
        VERIFIER_KEYPAIR_PATH: f.verifierPath,
        SETRA_FIXTURE_FILE: f.fixtureFile,
      },
      f.root
    );
    const portAvailable = vi.fn(async (port: number) => port !== 3003);
    const result = await runDevelopmentPreflight(prepared, {
      fileExists: () => true,
      rpc: async () => true,
      redis: async () => true,
      docker: async () => true,
      seller: async () => false,
      portAvailable,
    });

    expect(result.ready).toBe(false);
    expect(result.checks).toContainEqual({
      name: "Control",
      state: "UNAVAILABLE",
      detail: "port 3003 is already in use",
    });
    expect(result.checks).toContainEqual({
      name: "Seller",
      state: "START_REQUIRED",
      detail: "http://127.0.0.1:3001",
    });
    expect(portAvailable).toHaveBeenCalledWith(3003, "127.0.0.1");
  });
});
