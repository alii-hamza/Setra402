import {
  PaymentRequired,
  ResultUnavailable,
  RetryableTransportError,
  SellerUnavailable,
  TaskConflict,
  mapHttpFailure,
} from "../errors.js";
import type {
  FundedTaskContext,
  LegacyTaskQuoteWire,
  LegacyTaskResult,
  RequestContext,
  ResultEnvelopeV1,
  ResultEnvelopeWireV1,
} from "../types.js";
import type { QuoteNormalizer, SetraTransport } from "./types.js";

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  requestTimeoutMs?: number;
}

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 100,
  requestTimeoutMs: 10_000,
};

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return {
      error: `seller returned non-JSON response (${text.slice(0, 160)})`,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeResult(
  body: unknown
): ResultEnvelopeV1 | LegacyTaskResult {
  if (!body || typeof body !== "object")
    throw new ResultUnavailable("seller returned a non-object result");
  if (!("version" in body)) return body as LegacyTaskResult;
  const wire = body as Partial<ResultEnvelopeWireV1>;
  if (
    wire.version !== "1" ||
    typeof wire.task_id !== "string" ||
    typeof wire.service_id !== "string" ||
    typeof wire.result_hash !== "string" ||
    !Array.isArray(wire.evidence) ||
    !Number.isSafeInteger(wire.completed_at_unix) ||
    typeof wire.output_hash !== "string" ||
    !("input" in wire) ||
    !("result" in wire)
  )
    throw new ResultUnavailable(
      "seller returned a malformed Phase 2 result envelope"
    );
  return {
    version: "1",
    taskId: wire.task_id,
    serviceId: wire.service_id,
    result: wire.result,
    resultHash: wire.result_hash,
    evidence: wire.evidence,
    completedAtUnix: wire.completed_at_unix as number,
    input: wire.input,
    output_hash: wire.output_hash,
  };
}

export class RestX402Transport implements SetraTransport {
  private readonly retry: Required<RetryOptions>;

  constructor(
    private readonly sellerUrl: string,
    private readonly normalizeQuote: QuoteNormalizer,
    retry: RetryOptions = DEFAULT_RETRY
  ) {
    if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1)
      throw new RangeError("maxAttempts must be positive");
    this.retry = { ...DEFAULT_RETRY, ...retry };
  }

  async requestQuote(context: RequestContext) {
    const { response, body, url } = await this.requestWithRetry(context);
    if (response.status === 402) {
      return this.normalizeQuote(body as LegacyTaskQuoteWire, context);
    }
    if (response.ok)
      throw new TaskConflict(
        "seller returned a result before quote negotiation",
        { url, body }
      );
    throw mapHttpFailure(response.status, body, url);
  }

  async executeFundedTask(
    context: FundedTaskContext
  ): Promise<ResultEnvelopeV1 | LegacyTaskResult> {
    const { response, body, url } = await this.requestWithRetry(context, true);
    if (response.ok) return normalizeResult(body);
    throw mapHttpFailure(response.status, body, url);
  }

  private async requestWithRetry(
    context: RequestContext,
    retryPaymentRequired = false
  ) {
    const url = `${this.sellerUrl.replace(
      /\/$/,
      ""
    )}/tasks/${context.taskId.toString()}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            buyer: context.buyer,
            input: context.input,
            is_private: context.isPrivate,
            service_id: context.serviceId ?? "legacy-rest",
          }),
          signal: AbortSignal.timeout(this.retry.requestTimeoutMs),
        });
        const body = await responseJson(response);
        if (
          response.status < 500 &&
          !(retryPaymentRequired && response.status === 402)
        ) {
          return { response, body, url };
        }
        lastError = mapHttpFailure(response.status, body, url);
      } catch (error) {
        lastError =
          error instanceof RetryableTransportError
            ? error
            : new SellerUnavailable(`could not reach seller at ${url}`, error);
      }
      if (attempt < this.retry.maxAttempts)
        await delay(this.retry.baseDelayMs * 2 ** (attempt - 1));
    }
    if (lastError instanceof PaymentRequired) throw lastError;
    throw lastError instanceof Error
      ? lastError
      : new SellerUnavailable(`could not reach seller at ${url}`, lastError);
  }
}
