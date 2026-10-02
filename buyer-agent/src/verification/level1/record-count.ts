import type {
  RecordCountCheckV1,
  VerificationCheckResult,
} from "../../types.js";
import { fail, pass, selectedArray } from "./common.js";

export function checkRecordCount(
  policy: RecordCountCheckV1,
  result: unknown
): VerificationCheckResult {
  const selected = selectedArray(policy.type, result, policy.pointer);
  if (!Array.isArray(selected)) return selected;
  const count = selected.length;
  if (policy.exact !== undefined && count !== policy.exact)
    return fail(
      policy.type,
      `record count ${count} does not equal ${policy.exact}`
    );
  if (policy.min !== undefined && count < policy.min)
    return fail(policy.type, `record count ${count} is below ${policy.min}`);
  if (policy.max !== undefined && count > policy.max)
    return fail(policy.type, `record count ${count} exceeds ${policy.max}`);
  return pass(policy.type, "record count is within committed bounds", {
    count,
  });
}
