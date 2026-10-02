import type { FreshnessCheckV1, VerificationCheckResult } from "../../types.js";
import { resolveJsonPointer } from "../pointer.js";
import { fail, pass } from "./common.js";

export function checkFreshness(
  policy: FreshnessCheckV1,
  result: unknown,
  nowUnix: number
): VerificationCheckResult {
  const selected = resolveJsonPointer(result, policy.timestamp_pointer);
  if (!selected.found)
    return fail(policy.type, "freshness timestamp is missing");
  if (!Number.isSafeInteger(selected.value) || !Number.isSafeInteger(nowUnix))
    return fail(
      policy.type,
      "freshness timestamps must be safe integer Unix seconds"
    );
  const timestamp = selected.value as number;
  const futureSkew = policy.max_future_skew_seconds ?? 0;
  if (timestamp > nowUnix + futureSkew)
    return fail(policy.type, "result timestamp is too far in the future");
  const ageSeconds = nowUnix - timestamp;
  if (ageSeconds > policy.max_age_seconds)
    return fail(policy.type, "result timestamp is expired", { ageSeconds });
  return pass(policy.type, "result timestamp is fresh", { ageSeconds });
}
