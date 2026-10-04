import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { loadKeypair } from "../../dist/config.js";
import { createRuntime } from "../../dist/core/runtime.js";
import { RefundScheduler } from "../../dist/core/refund-scheduler.js";
import { ReconciliationClaims } from "../../dist/core/reconciliation-claims.js";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} required`);
  return value;
};
if (required("SETRA_REFUND_CRASH_STAGE") !== "after_submit")
  throw new Error("unsupported refund crash stage");
process.env.NODE_ENV = "test";
const directory = required("SETRA_REFUND_CRASH_DIRECTORY");
const runtime = createRuntime({
  directory,
  expectedMint: new PublicKey(required("ROLE_C_EXPECTED_MINT")),
  config: {
    programId: new PublicKey(required("ROLE_C_PROGRAM_ID")),
    rpcUrl: required("ROLE_C_RPC_URL"),
    sellerUrl: required("ROLE_C_SELLER_URL"),
    buyer: loadKeypair(required("ROLE_C_BUYER_KEYPAIR_PATH")),
    verifier: loadKeypair(required("ROLE_C_VERIFIER_KEYPAIR_PATH")),
    protocolTreasuryAddress: new PublicKey(
      required("ROLE_C_PROTOCOL_TREASURY")
    ),
    settlementSafetyMarginSec: 1,
  },
});
const scheduler = new RefundScheduler({
  stateDirectory: directory,
  sellerUrl: runtime.config.sellerUrl,
  programId: runtime.config.programId,
  expectedMint: new PublicKey(required("ROLE_C_EXPECTED_MINT")),
  buyer: runtime.config.buyer.publicKey,
  verifier: runtime.config.verifier.publicKey,
  reader: runtime.chain,
  submitter: {
    refundExpired: (quote) => runtime.settlement.refundExpired(quote),
  },
  claims: new ReconciliationClaims(join(directory, "refund-claims"), {
    leaseMs: 1_000,
  }),
  fault: (stage) => {
    if (stage === "after_submit") process.exit(83);
  },
});
await scheduler.runTask(required("SETRA_REFUND_CRASH_TASK_KEY"));
process.exit(84);
