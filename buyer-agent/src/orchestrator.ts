import { ManifestMismatch, TaskExpired, VerificationFailed } from "./errors.js";
import type { EnsureFundedInput, FundedEscrow } from "./chain/escrow.js";
import type { SettlementResult } from "./chain/settlement-coordinator.js";
import type { StoredManifest } from "./manifest/store.js";
import type { SetraTransport } from "./transport/types.js";
import type {
  LegacyTaskResult,
  RequestContext,
  ResultEnvelopeV1,
  TaskManifestV1,
  TaskQuote,
  VerificationPolicyV1,
  VerificationReport,
} from "./types.js";

interface FundingCoordinator {
  ensureFunded(input: EnsureFundedInput): Promise<FundedEscrow>;
}

interface SettlementService {
  settle(
    quote: TaskQuote,
    record: StoredManifest,
    options: { report: VerificationReport; nullifier?: Uint8Array }
  ): Promise<SettlementResult>;
  refundExpired(quote: TaskQuote): Promise<string>;
}

interface PrivateTaskService {
  createVoucher(input: {
    buyer: string;
    taskId: bigint;
  }): Promise<{ nullifier: Uint8Array }>;
}

export interface RunInput extends RequestContext {
  serviceId: string;
  policyHash?: string;
}

export type LegacyRunInput = RunInput;

interface VerificationService {
  verify(
    manifest: TaskManifestV1,
    policy: VerificationPolicyV1,
    result: ResultEnvelopeV1,
    record: StoredManifest
  ): Promise<VerificationReport>;
}

function isResultEnvelope(
  result: LegacyTaskResult
): result is ResultEnvelopeV1 {
  return (
    "version" in result &&
    result.version === "1" &&
    "taskId" in result &&
    typeof result.taskId === "string" &&
    "serviceId" in result &&
    typeof result.serviceId === "string" &&
    "resultHash" in result &&
    typeof result.resultHash === "string" &&
    "evidence" in result &&
    Array.isArray(result.evidence) &&
    "completedAtUnix" in result &&
    Number.isSafeInteger(result.completedAtUnix) &&
    "result" in result
  );
}

export class BuyerOrchestrator {
  constructor(
    private readonly transport: SetraTransport,
    private readonly funding: FundingCoordinator,
    private readonly settlement: SettlementService,
    private readonly verification: VerificationService,
    private readonly privateTasks?: PrivateTaskService
  ) {}

  async run(input: RunInput) {
    const quote = await this.transport.requestQuote(input);
    if (quote.serviceId !== input.serviceId)
      throw new VerificationFailed(
        "seller quote service does not match request"
      );
    if (input.policyHash && quote.policyHash !== input.policyHash)
      throw new VerificationFailed(
        "seller quote policy does not match requested policy"
      );
    const funded = await this.funding.ensureFunded({
      quote,
      serviceId: quote.serviceId,
      input: input.input,
      policyHash: quote.policyHash,
    });
    if (!funded.initializeSignature) {
      throw new ManifestMismatch(
        "cannot execute seller task until the initialization memo signature is recoverable"
      );
    }
    let result;
    try {
      result = await this.transport.executeFundedTask(input);
    } catch (error) {
      if (!(error instanceof TaskExpired)) throw error;
      const refundSignature = await this.settlement.refundExpired(quote);
      return {
        status: "refunded" as const,
        quote,
        funded,
        result: null,
        settlement: null,
        refundSignature,
      };
    }
    if (!result || typeof result !== "object" || !("output_hash" in result))
      throw new VerificationFailed("seller returned an invalid task result");
    if (!isResultEnvelope(result))
      throw new VerificationFailed(
        "seller result lacks the Phase 2 verification envelope"
      );
    const report = await this.verification.verify(
      funded.record.manifest,
      quote.verificationPolicy,
      result,
      funded.record
    );
    if (!report.passed) {
      return {
        status: "verification_failed" as const,
        quote,
        funded,
        result,
        report,
        settlement: null,
        refundAvailableAtUnix: funded.state.deadlineUnix,
      };
    }
    let nullifier: Uint8Array | undefined;
    if (quote.isPrivate) {
      if (!this.privateTasks)
        throw new VerificationFailed(
          "private task requires the legacy Chaumian voucher flow"
        );
      nullifier = (
        await this.privateTasks.createVoucher({
          buyer: input.buyer,
          taskId: input.taskId,
        })
      ).nullifier;
    }
    const settlement = await this.settlement.settle(
      quote,
      funded.record,
      nullifier ? { report, nullifier } : { report }
    );
    return {
      status: "settled" as const,
      quote,
      funded,
      result,
      report,
      settlement,
    };
  }

  async runLegacy(input: LegacyRunInput) {
    return this.run(input);
  }
}
