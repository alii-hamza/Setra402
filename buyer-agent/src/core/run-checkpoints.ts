import { join } from "node:path";
import { DurableJournal } from "./journal.js";
import { hashCanonical } from "../manifest/hash.js";
import { parseResultEnvelope } from "../verification/contracts.js";
import type {
  RequestContext,
  ResultEnvelopeV1,
  TaskQuote,
  VerificationReport,
} from "../types.js";
import type { StoredManifest } from "../manifest/store.js";

// Checkpoints are internal server evidence, never browser-provided verdicts.
// A result is immutable; a restart can re-run verification without dispatching
// the seller. A persisted report alone never authorizes settlement.
export class RunCheckpoints {
  constructor(
    private readonly directory: string,
    private readonly journal = new DurableJournal()
  ) {}
  private path(input: RequestContext, suffix: string) {
    return join(
      this.directory,
      `${hashCanonical({
        buyer: input.buyer,
        taskId: input.taskId.toString(),
      })}.${suffix}.json`
    );
  }
  private result(
    value: unknown,
    input: RequestContext,
    quote: TaskQuote
  ): ResultEnvelopeV1 {
    const result = parseResultEnvelope(value);
    if (
      result.taskId !== input.taskId.toString() ||
      result.serviceId !== quote.serviceId ||
      hashCanonical(result.input) !== hashCanonical(input.input) ||
      result.output_hash !== hashCanonical(input.input) ||
      result.resultHash !== hashCanonical(result.result)
    )
      throw new Error(
        "result checkpoint commitment conflict; reconciliation required"
      );
    return result;
  }
  loadResult(input: RequestContext, quote: TaskQuote): ResultEnvelopeV1 | null {
    const raw = this.journal.read(this.path(input, "result"));
    return raw === null ? null : this.result(raw, input, quote);
  }
  saveResult(
    input: RequestContext,
    quote: TaskQuote,
    value: unknown
  ): ResultEnvelopeV1 {
    const result = this.result(value, input, quote);
    const path = this.path(input, "result");
    this.journal.publish(path, result);
    const saved = this.result(this.journal.read(path), input, quote);
    if (hashCanonical(saved) !== hashCanonical(result))
      throw new Error(
        "immutable result checkpoint changed; reconciliation required"
      );
    return saved;
  }
  saveReport(
    input: RequestContext,
    quote: TaskQuote,
    record: StoredManifest,
    report: VerificationReport
  ): void {
    const result = this.loadResult(input, quote);
    if (
      !result ||
      report.taskId !== result.taskId ||
      report.serviceId !== quote.serviceId ||
      report.resultHash !== result.resultHash ||
      report.manifestHash !== record.manifestHash ||
      report.policyHash !== quote.policyHash ||
      report.verifierPubkey !== quote.verifier ||
      report.level !== quote.verificationPolicy.level ||
      !Array.isArray(report.checks) ||
      report.checks.length === 0 ||
      report.passed !== report.checks.every((check) => check.passed === true)
    )
      throw new Error("verification report checkpoint linkage conflict");
    this.journal.write(this.path(input, "report"), report);
  }
  outcome(input: RequestContext, quote: TaskQuote): unknown | null {
    const result = this.loadResult(input, quote);
    if (!result) return null;
    const report = this.journal.read(
      this.path(input, "report")
    ) as VerificationReport | null;
    if (
      report &&
      (report.resultHash !== result.resultHash ||
        report.policyHash !== quote.policyHash ||
        report.taskId !== result.taskId ||
        report.serviceId !== result.serviceId ||
        report.verifierPubkey !== quote.verifier ||
        report.passed !== report.checks.every((c) => c.passed))
    )
      throw new Error("corrupt report checkpoint; reconciliation required");
    return {
      status: report
        ? report.passed
          ? "verification_passed"
          : "verification_failed"
        : "submitted",
      quote,
      result,
      ...(report ? { report } : {}),
    };
  }
}
