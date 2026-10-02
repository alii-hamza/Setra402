import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  deriveNullifierPda,
  deriveTaskPda,
  deriveVaultPda,
  deriveBuyerAta,
} from "../../src/chain/pda.js";
import { canonicalize } from "../../src/manifest/canonicalize.js";
import { hashCanonical } from "../../src/manifest/hash.js";
import {
  decodeManifestMemo,
  encodeManifestMemo,
} from "../../src/chain/memo.js";
import { validateQuote } from "../../src/quote.js";
import { canSettleBeforeDeadline } from "../../src/chain/settlement.js";
import type { LegacyTaskQuoteWire } from "../../src/types.js";

const programId = new PublicKey("FUjN9K7C5yHr5NhVrJ7WCgifgDiBJnSDDGQjnNkUDBMN");
const buyer = new PublicKey("6HQf3NpnZaaCS1FykEKDBb5kCGaAE2kKLRWiNbGyzBBm");
const verifier = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const sellerTokenAccount = Keypair.generate().publicKey;
const taskId = 402001n;
const [taskStatePda] = deriveTaskPda(programId, buyer, taskId);
const [vaultPda] = deriveVaultPda(programId, taskStatePda);
const policy = {
  version: "1",
  level: 1,
  checks: [{ type: "json_schema", schema_ref: "generic-object-v1" }],
} as const;

const validQuote = {
  task_id: taskId.toString(),
  program_id: programId.toBase58(),
  task_state_pda: taskStatePda.toBase58(),
  vault_pda: vaultPda.toBase58(),
  mint: mint.toBase58(),
  seller_token_account: sellerTokenAccount.toBase58(),
  verifier: verifier.toBase58(),
  amount: "1500000",
  timeout_seconds: 180,
  is_private: false,
  protocol_fee_bps: 100,
  service_id: "legacy-rest",
  verification_policy: policy,
  policy_hash: hashCanonical(policy),
};

describe("Phase 1 chain derivations", () => {
  it("matches the known live task and vault PDA vectors", () => {
    expect(taskStatePda.toBase58()).toBe(
      "GhSi7L8EyxSTxR7dNu1toZZuK5XWcqRGDLLDKAXxyopQ"
    );
    expect(vaultPda.toBase58()).toBe(
      "FyhjauJSdwrWVBomVcBhS2NBzU2VkP4EHXvjuDaiiyXN"
    );
  });

  it("derives nullifier PDA from the exact 32 bytes", () => {
    const [a] = deriveNullifierPda(programId, new Uint8Array(32).fill(7));
    const [b] = deriveNullifierPda(programId, new Uint8Array(32).fill(7));
    expect(a.equals(b)).toBe(true);
  });

  it("derives the buyer ATA rather than using the mint address", () => {
    expect(
      deriveBuyerAta(mint, buyer).equals(
        getAssociatedTokenAddressSync(mint, buyer)
      )
    ).toBe(true);
    expect(deriveBuyerAta(mint, buyer).equals(mint)).toBe(false);
  });
});

describe("Phase 1 quote validation", () => {
  const validate = (quote: LegacyTaskQuoteWire) =>
    validateQuote(quote, {
      programId,
      buyer,
      verifier,
      expectedMint: mint,
      taskId,
      isPrivate: false,
      serviceId: "legacy-rest",
    });

  it("accepts the backward-compatible Phase 2 quote", () => {
    expect(validate(validQuote).amount).toBe(1_500_000n);
  });

  it.each([
    ["wrong program", { program_id: Keypair.generate().publicKey.toBase58() }],
    [
      "wrong task PDA",
      { task_state_pda: Keypair.generate().publicKey.toBase58() },
    ],
    ["wrong vault PDA", { vault_pda: Keypair.generate().publicKey.toBase58() }],
    ["wrong verifier", { verifier: Keypair.generate().publicKey.toBase58() }],
    ["wrong mint", { mint: Keypair.generate().publicKey.toBase58() }],
    ["wrong privacy flag", { is_private: true }],
    ["zero amount", { amount: "0" }],
    ["invalid timeout", { timeout_seconds: 0 }],
    ["wrong service", { service_id: "lead-scraper-demo" }],
    ["wrong policy hash", { policy_hash: "ff".repeat(32) }],
    ["invalid policy", { verification_policy: { version: "2" } }],
  ])("rejects %s", (_name, change) => {
    expect(() => validate({ ...validQuote, ...change })).toThrow();
  });
});

describe("Phase 1 commitments", () => {
  it("canonicalizes recursively, preserves arrays, and rejects floats", () => {
    expect(canonicalize({ z: 1, a: { y: true, x: [3, 2, 1] } })).toBe(
      '{"a":{"x":[3,2,1],"y":true},"z":1}'
    );
    expect(() => canonicalize({ amount: 1.5 })).toThrow(/floating-point/);
  });

  it("matches the SHA-256 canonical vector", () => {
    expect(hashCanonical({ a: 1 })).toBe(
      "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862"
    );
  });

  it("encodes and decodes the manifest memo", () => {
    const hash = "ab".repeat(32);
    expect(decodeManifestMemo(encodeManifestMemo(hash))).toBe(hash);
    expect(() => decodeManifestMemo("setra402:v2:" + hash)).toThrow();
  });
});

describe("Phase 1 settlement safety", () => {
  it("allows settlement only outside the configured safety margin", () => {
    expect(canSettleBeforeDeadline(100, 106, 5)).toBe(true);
    expect(canSettleBeforeDeadline(100, 105, 5)).toBe(false);
    expect(canSettleBeforeDeadline(100, 104, 5)).toBe(false);
  });
});
