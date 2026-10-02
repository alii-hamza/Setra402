import { PublicKey } from "@solana/web3.js";
import { InvalidQuote } from "./errors.js";
import { deriveTaskPda, deriveVaultPda } from "./chain/pda.js";
import type { LegacyTaskQuoteWire, TaskQuote } from "./types.js";
import { hashCanonical } from "./manifest/hash.js";
import { parseVerificationPolicy } from "./verification/policy.js";

export interface QuoteExpectations {
  programId: PublicKey;
  buyer: PublicKey;
  verifier: PublicKey;
  expectedMint: PublicKey;
  taskId: bigint;
  isPrivate: boolean;
  protocolFeeBps?: number;
  serviceId?: string;
}

function pubkey(field: string, value: unknown): PublicKey {
  try {
    if (typeof value !== "string") throw new Error("not a string");
    return new PublicKey(value);
  } catch {
    throw new InvalidQuote(`${field} is not a valid public key`);
  }
}

function unsignedBigint(field: string, value: unknown): bigint {
  if (
    typeof value === "number" &&
    (!Number.isSafeInteger(value) || value < 0)
  ) {
    throw new InvalidQuote(
      `${field} must be an unsigned safe integer or decimal string`
    );
  }
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^\d+$/.test(value))
  ) {
    throw new InvalidQuote(`${field} must be an unsigned integer`);
  }
  return BigInt(value);
}

export function validateQuote(
  wire: LegacyTaskQuoteWire,
  expected: QuoteExpectations
): TaskQuote {
  if (!wire || typeof wire !== "object")
    throw new InvalidQuote("quote is not an object");
  const taskId = unsignedBigint("task_id", wire.task_id);
  const amount = unsignedBigint("amount", wire.amount);
  const programId = pubkey("program_id", wire.program_id);
  const taskStatePda = pubkey("task_state_pda", wire.task_state_pda);
  const vaultPda = pubkey("vault_pda", wire.vault_pda);
  const mint = pubkey("mint", wire.mint);
  const sellerTokenAccount = pubkey(
    "seller_token_account",
    wire.seller_token_account
  );
  const verifier = pubkey("verifier", wire.verifier);
  const [derivedTask] = deriveTaskPda(
    expected.programId,
    expected.buyer,
    expected.taskId
  );
  const [derivedVault] = deriveVaultPda(expected.programId, derivedTask);

  if (!programId.equals(expected.programId))
    throw new InvalidQuote("program_id does not match configuration");
  if (taskId !== expected.taskId)
    throw new InvalidQuote("task_id does not match request");
  if (!taskStatePda.equals(derivedTask))
    throw new InvalidQuote("task_state_pda does not match local derivation");
  if (!vaultPda.equals(derivedVault))
    throw new InvalidQuote("vault_pda does not match local derivation");
  if (!verifier.equals(expected.verifier))
    throw new InvalidQuote("verifier does not match configured keypair");
  if (!mint.equals(expected.expectedMint))
    throw new InvalidQuote("mint does not match expected mint");
  if (wire.is_private !== expected.isPrivate)
    throw new InvalidQuote("privacy flag does not match request");
  if (amount <= 0n) throw new InvalidQuote("amount must be greater than zero");
  if (
    !Number.isSafeInteger(wire.timeout_seconds) ||
    wire.timeout_seconds <= 0
  ) {
    throw new InvalidQuote("timeout_seconds must be a positive safe integer");
  }
  const fee = expected.protocolFeeBps ?? 100;
  if (wire.protocol_fee_bps !== fee)
    throw new InvalidQuote(`protocol_fee_bps must equal ${fee}`);
  if (typeof wire.service_id !== "string" || wire.service_id.length === 0)
    throw new InvalidQuote("service_id is required");
  if (expected.serviceId && wire.service_id !== expected.serviceId)
    throw new InvalidQuote("service_id does not match request");
  let verificationPolicy;
  try {
    verificationPolicy = parseVerificationPolicy(wire.verification_policy);
  } catch {
    throw new InvalidQuote("verification_policy is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(wire.policy_hash))
    throw new InvalidQuote("policy_hash must be 32-byte lowercase hex");
  if (hashCanonical(verificationPolicy) !== wire.policy_hash)
    throw new InvalidQuote("policy_hash does not match verification_policy");

  return {
    taskId,
    serviceId: wire.service_id,
    programId: programId.toBase58(),
    taskStatePda: taskStatePda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    mint: mint.toBase58(),
    sellerTokenAccount: sellerTokenAccount.toBase58(),
    verifier: verifier.toBase58(),
    amount,
    timeoutSeconds: wire.timeout_seconds,
    isPrivate: wire.is_private,
    protocolFeeBps: wire.protocol_fee_bps,
    verificationPolicy,
    policyHash: wire.policy_hash,
    raw: wire,
  };
}
