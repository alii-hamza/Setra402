import { describe, expect, it } from "vitest";
import {
  InvalidRequest,
  PaymentRequired,
  RetryableTransportError,
  TaskConflict,
  TaskExpired,
  mapHttpFailure,
} from "../../src/errors.js";

describe("HTTP status mapping", () => {
  it.each([
    [402, PaymentRequired],
    [400, InvalidRequest],
    [409, TaskConflict],
    [410, TaskExpired],
    [500, RetryableTransportError],
    [503, RetryableTransportError],
  ])("maps %i to %s", (status, errorType) => {
    expect(
      mapHttpFailure(status, { error: "test" }, "http://seller.test")
    ).toBeInstanceOf(errorType);
  });
});
