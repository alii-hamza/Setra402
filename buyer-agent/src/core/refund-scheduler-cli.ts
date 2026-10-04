import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { createRuntime } from "./runtime.js";
import {
  RefundScheduler,
  refundSchedulerMetricsText,
  structuredRefundSchedulerLog,
} from "./refund-scheduler.js";

const mode = process.argv[2];
const limit = Number(process.argv[3] ?? "100");
if (
  (mode !== "once" && mode !== "loop") ||
  !Number.isSafeInteger(limit) ||
  limit < 1 ||
  limit > 1_000
)
  throw new Error("usage: refund:schedule -- once|loop [limit 1..1000]");
if (process.env.SETRA_REFUND_SCHEDULER_ENABLED !== "true")
  throw new Error("set SETRA_REFUND_SCHEDULER_ENABLED=true on the server");

const runtime = createRuntime();
const scheduler = new RefundScheduler({
  stateDirectory: resolve(process.env.SETRA_STATE_DIR ?? ".setra-state"),
  sellerUrl: runtime.config.sellerUrl,
  programId: runtime.config.programId,
  expectedMint: new PublicKey(process.env.EXPECTED_MINT ?? ""),
  buyer: runtime.config.buyer.publicKey,
  verifier: runtime.config.verifier.publicKey,
  reader: runtime.chain,
  submitter: {
    refundExpired: (quote) => runtime.settlement.refundExpired(quote),
    retryRefundExpired: (request, proof) =>
      runtime.settlement.retryRefundExpired(request.quote, proof),
  },
  observe: (event) =>
    process.stdout.write(structuredRefundSchedulerLog(event) + "\n"),
});
async function cycle() {
  await scheduler.runCandidates(limit);
  process.stdout.write(refundSchedulerMetricsText(scheduler.metricsSnapshot()));
}
try {
  if (mode === "once") await cycle();
  else {
    for (;;) {
      await cycle();
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      operation: "refund_scheduler",
      result: "ERROR",
      errorClass: error instanceof Error ? error.name : "UnknownError",
    }) + "\n"
  );
  process.exitCode = 1;
}
