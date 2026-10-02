import type { UniqueCheckV1, VerificationCheckResult } from "../../types.js";
import { canonicalize } from "../../manifest/canonicalize.js";
import { fail, isPlainObject, pass, selectedArray } from "./common.js";

export function checkUnique(
  policy: UniqueCheckV1,
  result: unknown
): VerificationCheckResult {
  const selected = selectedArray(policy.type, result, policy.pointer);
  if (!Array.isArray(selected)) return selected;
  const values = new Set<string>();
  for (const record of selected) {
    if (
      !isPlainObject(record) ||
      !Object.prototype.hasOwnProperty.call(record, policy.field)
    )
      return fail(
        policy.type,
        `record is missing unique field ${policy.field}`
      );
    let key: string;
    try {
      key = canonicalize(record[policy.field]);
    } catch {
      return fail(
        policy.type,
        `unique field ${policy.field} is not canonicalizable`
      );
    }
    if (values.has(key))
      return fail(policy.type, `duplicate value for ${policy.field}`);
    values.add(key);
  }
  return pass(policy.type, `${policy.field} values are unique`, {
    count: values.size,
  });
}
