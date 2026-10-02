import type {
  RequiredFieldsCheckV1,
  VerificationCheckResult,
} from "../../types.js";
import { fail, isPlainObject, pass, selectedArray } from "./common.js";

export function checkRequiredFields(
  policy: RequiredFieldsCheckV1,
  result: unknown
): VerificationCheckResult {
  const selected = selectedArray(policy.type, result, policy.pointer);
  if (!Array.isArray(selected)) return selected;
  let valid = 0;
  for (const record of selected) {
    if (
      isPlainObject(record) &&
      policy.fields.every((field) =>
        Object.prototype.hasOwnProperty.call(record, field)
      )
    )
      valid += 1;
  }
  const requiredBps = policy.minimum_valid_ratio_bps ?? 10_000;
  const actualBps =
    selected.length === 0
      ? 10_000
      : Math.floor((valid * 10_000) / selected.length);
  if (actualBps < requiredBps)
    return fail(
      policy.type,
      "required-field ratio is below the committed threshold",
      {
        valid,
        total: selected.length,
        actualBps,
        requiredBps,
      }
    );
  return pass(policy.type, "required fields are present", {
    valid,
    total: selected.length,
    actualBps,
  });
}
