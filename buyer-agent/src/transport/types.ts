import type {
  FundedTaskContext,
  LegacyTaskQuoteWire,
  LegacyTaskResult,
  RequestContext,
  ResultEnvelopeV1,
  TaskQuote,
} from "../types.js";

export type QuoteNormalizer = (
  quote: LegacyTaskQuoteWire,
  context: RequestContext
) => TaskQuote;

export interface SetraTransport {
  requestQuote(context: RequestContext): Promise<TaskQuote>;
  executeFundedTask(
    context: FundedTaskContext
  ): Promise<ResultEnvelopeV1 | LegacyTaskResult>;
}
