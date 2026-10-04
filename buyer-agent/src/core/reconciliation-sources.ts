import { dirname, join } from "node:path";
import { hashCanonical } from "../manifest/hash.js";
import { PublicKey } from "@solana/web3.js";
import type {
  FinancialRecoveryRequest,
  FinancialReconciliationResult,
} from "../chain/financial-reconciliation.js";
import { ManifestStore, type StoredManifest } from "../manifest/store.js";
import { queryProviderEvidence } from "../provider/evidence.js";
import { inspectVoucherRecovery } from "../privacy/voucher-recovery.js";
import { validateQuote } from "../quote.js";
import type {
  LegacyTaskQuoteWire,
  RequestContext,
  TaskQuote,
  ResultEnvelopeV1,
} from "../types.js";
import { VerificationCoordinator } from "../verification/coordinator.js";
import { parseResultEnvelope } from "../verification/contracts.js";
import { inspectVerificationRecovery } from "../verification/recovery.js";
import { DurableJournal } from "./journal.js";
import { RunCheckpoints } from "./run-checkpoints.js";
import type { RecoveryInventoryV1 } from "./recovery-inventory.js";
import type { ReconciliationSources } from "./reconciliation-worker.js";

type Task = RecoveryInventoryV1["tasks"][number];
export interface AuthoritativeRecoveryReaders {
  /** The chain client offers this read-only method; no send/sign methods are exposed. */
  reconcileFinancial(
    request: FinancialRecoveryRequest
  ): Promise<FinancialReconciliationResult>;
}
export interface RecoverySourceOptions {
  stateDirectory: string;
  sellerUrl: string;
  sellerExecutionDirectory?: string;
  programId: PublicKey;
  expectedMint: PublicKey;
  verifier: PublicKey;
  chain: AuthoritativeRecoveryReaders;
  verificationCoordinator?: VerificationCoordinator;
}

/** Binds the worker's narrow readers to the same committed contracts as runtime. */
export function createReconciliationSources(
  options: RecoverySourceOptions
): ReconciliationSources {
  const journal = new DurableJournal();
  const verificationCoordinator = options.verificationCoordinator;
  const inventoryOptions = {
    stateDirectory: options.stateDirectory,
    ...(options.sellerExecutionDirectory
      ? { sellerExecutionDirectory: options.sellerExecutionDirectory }
      : {}),
    sellerUrl: options.sellerUrl,
  };
  function bound(task: Task): { manifest: StoredManifest; quote: TaskQuote } {
    const id = task.taskIdentity;
    if (!id || task.conflicts.length)
      throw new Error("task identity or inventory conflicts");
    const manifestRecord = task.evidence.manifest?.find(
      (r) => r.status === "VALID"
    );
    const quoteRecord = task.evidence.tasks?.find(
      (r) => r.role === "quote.json" && r.status === "VALID"
    );
    if (!manifestRecord || !quoteRecord)
      throw new Error("manifest or quote missing");
    const manifest = new ManifestStore(dirname(manifestRecord.path)).load(
      manifestRecord.path.split(/[\\/]/).at(-1)!.slice(0, -5)
    );
    if (!manifest) throw new Error("manifest disappeared");
    const raw = journal.read(quoteRecord.path) as LegacyTaskQuoteWire;
    const quote = validateQuote(raw, {
      programId: options.programId,
      buyer: new PublicKey(id.buyer),
      verifier: options.verifier,
      expectedMint: options.expectedMint,
      taskId: BigInt(id.taskId),
      isPrivate: id.privacy,
      serviceId: id.serviceId,
    });
    if (
      manifest.manifest.quoteHash !== hashCanonical(raw) ||
      manifest.manifest.policyHash !== quote.policyHash ||
      manifest.manifest.taskId !== id.taskId ||
      manifest.manifest.buyer !== id.buyer
    )
      throw new Error("recovery manifest/quote task binding conflict");
    return { manifest, quote };
  }
  return {
    async financial(task) {
      const { manifest, quote } = bound(task);
      const intents =
        task.evidence.transactions?.filter(
          (r) => r.role === "intent" && r.status === "VALID"
        ) ?? [];
      let nullifier: Uint8Array | undefined;
      if (quote.isPrivate && intents.length) {
        const voucher = await inspectVoucherRecovery({
          sellerUrl: options.sellerUrl,
          buyer: manifest.manifest.buyer,
          taskId: quote.taskId,
          directory: join(options.stateDirectory, "vouchers"),
        });
        nullifier = voucher.voucher?.nullifier;
      }
      const results: FinancialReconciliationResult[] = [];
      for (const intent of intents) {
        const value = journal.read(intent.path) as {
          operation: FinancialRecoveryRequest["operation"];
        };
        results.push(
          await options.chain.reconcileFinancial({
            manifest,
            quote,
            operation: value.operation,
            ...(nullifier ? { nullifier } : {}),
          })
        );
      }
      return results;
    },
    async provider(task) {
      const { manifest, quote } = bound(task);
      return queryProviderEvidence(options.sellerUrl, {
        programId: quote.programId,
        buyer: manifest.manifest.buyer,
        taskId: quote.taskId.toString(),
        taskStatePda: quote.taskStatePda,
        serviceId: quote.serviceId,
        inputHash: manifest.manifest.taskSpecHash,
      });
    },
    async voucher(task) {
      const { manifest, quote } = bound(task);
      return inspectVoucherRecovery({
        sellerUrl: options.sellerUrl,
        buyer: manifest.manifest.buyer,
        taskId: quote.taskId,
        directory: join(options.stateDirectory, "vouchers"),
      });
    },
    async verification(task) {
      return inspectVerificationRecovery({
        ...inventoryOptions,
        taskKey: task.taskKey,
      });
    },
    ...(verificationCoordinator
      ? {
          async reverify(task: Task) {
            const before = inspectVerificationRecovery({
              ...inventoryOptions,
              taskKey: task.taskKey,
            });
            if (before.classification !== "SAFE_TO_REVERIFY")
              throw new Error("reverification is not safe");
            const { manifest, quote } = bound(task);
            const resultRecord = task.evidence.result?.find(
              (r) => r.status === "VALID"
            );
            if (!resultRecord) throw new Error("immutable result missing");
            const saved = parseResultEnvelope(
              journal.read(resultRecord.path)
            ) as ResultEnvelopeV1;
            const input: RequestContext = {
              buyer: manifest.manifest.buyer,
              taskId: quote.taskId,
              input: saved.input,
              isPrivate: quote.isPrivate,
              serviceId: quote.serviceId,
            };
            const checkpoints = new RunCheckpoints(
              join(options.stateDirectory, "checkpoints")
            );
            const result = checkpoints.loadResult(input, quote);
            if (!result || result.resultHash !== saved.resultHash)
              throw new Error("result checkpoint changed");
            const report = await verificationCoordinator.verify(
              manifest.manifest,
              quote.verificationPolicy,
              result,
              manifest
            );
            const stillSafe = inspectVerificationRecovery({
              ...inventoryOptions,
              taskKey: task.taskKey,
            });
            if (stillSafe.classification !== "SAFE_TO_REVERIFY")
              throw new Error("reverification evidence changed");
            checkpoints.saveReport(input, quote, manifest, report);
            return report;
          },
        }
      : {}),
  };
}
