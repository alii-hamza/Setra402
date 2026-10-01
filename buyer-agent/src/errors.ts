export type ErrorDisposition =
  | "retry"
  | "stop"
  | "refund"
  | "verification_fail"
  | "operator";

export class SetraError extends Error {
  constructor(
    message: string,
    readonly disposition: ErrorDisposition,
    readonly details?: unknown
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class PaymentRequired extends SetraError {
  constructor(readonly quote: unknown, details?: unknown) {
    super("payment required", "stop", details);
  }
}
export class InvalidQuote extends SetraError {
  constructor(message: string, details?: unknown) {
    super(message, "operator", details);
  }
}
export class InvalidRequest extends SetraError {
  constructor(message: string, details?: unknown) {
    super(message, "stop", details);
  }
}
export class TaskConflict extends SetraError {
  constructor(message: string, details?: unknown) {
    super(message, "stop", details);
  }
}
export class TaskExpired extends SetraError {
  constructor(message: string, details?: unknown) {
    super(message, "refund", details);
  }
}
export class RetryableTransportError extends SetraError {
  constructor(message: string, details?: unknown) {
    super(message, "retry", details);
  }
}
export class SellerUnavailable extends RetryableTransportError {}
export class ResultUnavailable extends SetraError {
  constructor(message: string, details?: unknown) {
    super(message, "retry", details);
  }
}
export class VerifierIdentityMismatch extends SetraError {
  constructor(message: string, details?: unknown) {
    super(message, "operator", details);
  }
}
export class ManifestMismatch extends SetraError {
  constructor(message: string, details?: unknown) {
    super(message, "verification_fail", details);
  }
}
export class VerificationFailed extends SetraError {
  constructor(message: string, details?: unknown) {
    super(message, "verification_fail", details);
  }
}
export class SettlementTooCloseToDeadline extends SetraError {
  constructor(message: string, details?: unknown) {
    super(message, "refund", details);
  }
}
export class ReplayDetected extends SetraError {
  constructor(message: string, details?: unknown) {
    super(message, "stop", details);
  }
}

export class TransactionSubmissionError extends SetraError {
  constructor(message: string, readonly signature: string, details?: unknown) {
    super(message, "retry", details);
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return fallback;
}

export function mapHttpFailure(
  status: number,
  body: unknown,
  url: string
): SetraError {
  const message = errorMessage(
    body,
    `seller request failed with HTTP ${status}`
  );
  const details = { status, url, body };
  if (status === 402) return new PaymentRequired(body, details);
  if (status === 400) return new InvalidRequest(message, details);
  if (status === 409) return new TaskConflict(message, details);
  if (status === 410) return new TaskExpired(message, details);
  if (status === 404) return new ResultUnavailable(message, details);
  if (status >= 500) return new RetryableTransportError(message, details);
  return new InvalidRequest(message, details);
}
