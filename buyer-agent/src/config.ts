import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { z } from "zod";

const publicKeyString = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    try {
      return new PublicKey(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be a valid Solana public key",
      });
      return z.NEVER;
    }
  });

const configSchema = z.object({
  PROGRAM_ID: publicKeyString,
  RPC_URL: z.string().url(),
  SELLER_URL: z.string().url(),
  BUYER_KEYPAIR_PATH: z.string().min(1),
  VERIFIER_KEYPAIR_PATH: z.string().min(1),
  PROTOCOL_TREASURY_ADDRESS: publicKeyString,
  SETTLEMENT_SAFETY_MARGIN_SEC: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .refine(Number.isSafeInteger),
});

export interface BuyerAgentConfig {
  programId: PublicKey;
  rpcUrl: string;
  sellerUrl: string;
  buyer: Keypair;
  verifier: Keypair;
  protocolTreasuryAddress: PublicKey;
  settlementSafetyMarginSec: number;
}

export function loadKeypair(path: string): Keypair {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `could not read keypair at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    parsed.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    throw new Error(`keypair at ${path} must be a JSON array of 64 bytes`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env
): BuyerAgentConfig {
  const parsed = configSchema.parse(env);
  return {
    programId: parsed.PROGRAM_ID,
    rpcUrl: parsed.RPC_URL,
    sellerUrl: parsed.SELLER_URL.replace(/\/$/, ""),
    buyer: loadKeypair(parsed.BUYER_KEYPAIR_PATH),
    verifier: loadKeypair(parsed.VERIFIER_KEYPAIR_PATH),
    protocolTreasuryAddress: parsed.PROTOCOL_TREASURY_ADDRESS,
    settlementSafetyMarginSec: parsed.SETTLEMENT_SAFETY_MARGIN_SEC,
  };
}
