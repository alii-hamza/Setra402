import { ManifestMismatch, VerificationFailed } from "./errors.js";
import type { EnsureFundedInput, FundedEscrow } from "./chain/escrow.js";
import type { SettlementResult } from "./chain/settlement-coordinator.js";
import { hashCanonical } from "./manifest/hash.js";
import type { StoredManifest } from "./manifest/store.js";
import type { SetraTransport } from "./transport/types.js";
import type { LegacyTaskResult, RequestContext, TaskQuote } from "./types.js";

interface FundingCoordinator {
  ensureFunded(input: EnsureFundedInput): Promise<FundedEscrow>;
}

interface SettlementService {
  settle(quote: TaskQuote, record: StoredManifest): Promise<SettlementResult>;
}

export interface LegacyRunInput extends RequestContext {
  serviceId: string;
  policyHash: string;
}

export class BuyerOrchestrator {
  constructor(
    private readonly transport: SetraTransport,
    private readonly funding: FundingCoordinator,
    private readonly settlement: SettlementService
  ) {}

  async runLegacy(input: LegacyRunInput) {
    const quote = await this.transport.requestQuote(input);
    const funded = await this.funding.ensureFunded({
      quote,
      serviceId: input.serviceId,
      input: input.input,
      policyHash: input.policyHash,
    });
    if (!funded.initializeSignature) {
      throw new ManifestMismatch(
        "cannot execute seller task until the initialization memo signature is recoverable"
      );
    }
    const result = await this.transport.executeFundedTask(input);
    if (!("output_hash" in result))
      throw new VerificationFailed(
        "legacy flow received a non-legacy result envelope"
      );
    this.verifyLegacyResult(input.input, result);
    const settlement = await this.settlement.settle(quote, funded.record);
    return { quote, funded, result, settlement };
  }

  private verifyLegacyResult(
    requestedInput: unknown,
    result: LegacyTaskResult
  ): void {
    const expected = hashCanonical(requestedInput);
    if (!/^[0-9a-f]{64}$/.test(result.output_hash))
      throw new VerificationFailed(
        "seller output_hash is not 32-byte lowercase hex"
      );
    if (hashCanonical(result.input) !== expected)
      throw new VerificationFailed(
        "seller returned input differs from committed task input"
      );
    if (result.output_hash !== expected)
      throw new VerificationFailed(
        "legacy output hash does not match committed task input"
      );
  }
}
