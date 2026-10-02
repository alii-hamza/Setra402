import type { VerificationCheckResult } from "../../types.js";
import { resolveJsonPointer } from "../pointer.js";

export function pass(
  type: string,
  message: string,
  details?: Record<string, unknown>
): VerificationCheckResult {
  return details
    ? { type, passed: true, message, details }
    : { type, passed: true, message };
}

export function fail(
  type: string,
  message: string,
  details?: Record<string, unknown>
): VerificationCheckResult {
  return details
    ? { type, passed: false, message, details }
    : { type, passed: false, message };
}

export function selectedArray(
  type: string,
  result: unknown,
  pointer: string
): unknown[] | VerificationCheckResult {
  const selected = resolveJsonPointer(result, pointer);
  if (!selected.found) return fail(type, `JSON Pointer ${pointer} is missing`);
  if (!Array.isArray(selected.value))
    return fail(type, `JSON Pointer ${pointer} does not select an array`);
  return selected.value;
}

export function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
