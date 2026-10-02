import { createHash } from "node:crypto";
import { canonicalize } from "../../manifest/canonicalize.js";
import { hashCanonical } from "../../manifest/hash.js";
import type {
  SourceSamplingCheckV1,
  VerificationCheckResult,
} from "../../types.js";
import { fail, isPlainObject, pass, selectedArray } from "../level1/common.js";
import type { ChallengeStore } from "./challenge-store.js";
import type { SourceClient } from "./source-client.js";

export interface SourceContext {
  sourceClient: Pick<SourceClient, "retrieve">;
  challenges: ChallengeStore;
}

export function deriveSampleIndices(
  seed: string,
  contextHash: string,
  total: number,
  count: number
): number[] {
  if (
    !/^[0-9a-f]{64}$/.test(seed) ||
    !/^[0-9a-f]{64}$/.test(contextHash) ||
    !Number.isSafeInteger(total) ||
    total < 1 ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > total
  )
    throw new Error("invalid sampling inputs");
  // Hash-rank each immutable record position. Tie-break by position; never
  // modulo random bytes, which can introduce bias or duplicate indices.
  return Array.from({ length: total }, (_, index) => ({
    index,
    rank: createHash("sha256")
      .update(Buffer.from(seed, "hex"))
      .update(Buffer.from(contextHash, "hex"))
      .update(String(index))
      .digest("hex"),
  }))
    .sort((a, b) => a.rank.localeCompare(b.rank) || a.index - b.index)
    .slice(0, count)
    .map((v) => v.index);
}

export async function checkSourceSampling(
  policy: SourceSamplingCheckV1,
  result: unknown,
  immutableContext: string,
  context?: SourceContext
): Promise<VerificationCheckResult> {
  if (!context) return fail(policy.type, "source verifier is not configured");
  const records = selectedArray(policy.type, result, policy.pointer);
  if (!Array.isArray(records)) return records;
  if (records.length < policy.sample_count || records.length > 100_000)
    return fail(policy.type, "source sampling record count is outside bounds");
  let seed: string;
  const contextHash = hashCanonical({ immutableContext, policy });
  try {
    seed = await context.challenges.getOrCreate(contextHash);
  } catch {
    return fail(policy.type, "challenge persistence failed");
  }
  const indices = deriveSampleIndices(
    seed,
    contextHash,
    records.length,
    policy.sample_count
  );
  const samples = await Promise.all(
    indices.map(async (index) => {
      const record = records[index];
      if (
        !isPlainObject(record) ||
        !Object.hasOwn(record, policy.source_url_field) ||
        typeof record[policy.source_url_field] !== "string"
      )
        return { index, matched: false, message: "source URL is missing" };
      try {
        const source = await context.sourceClient.retrieve(
          record[policy.source_url_field] as string,
          policy.allowed_domains
        );
        const comparisons = policy.fields.map((field) => ({
          field,
          matched:
            isPlainObject(source) &&
            Object.hasOwn(source, field) &&
            Object.hasOwn(record, field) &&
            canonicalize(source[field]) === canonicalize(record[field]),
        }));
        return {
          index,
          matched: comparisons.every((c) => c.matched),
          comparisons,
        };
      } catch (error) {
        return {
          index,
          matched: false,
          message:
            error instanceof Error ? error.message : "source retrieval failed",
        };
      }
    })
  );
  const matched = samples.filter((s) => s.matched).length;
  const actualBps = Math.floor((matched * 10_000) / samples.length);
  const details = {
    challenge_seed: seed,
    context_hash: contextHash,
    sample_indices: indices,
    samples,
    matched,
    sampled: samples.length,
    actual_bps: actualBps,
    minimum_match_bps: policy.minimum_match_bps,
  };
  return (actualBps >= policy.minimum_match_bps ? pass : fail)(
    policy.type,
    actualBps >= policy.minimum_match_bps
      ? "independent sources match"
      : "source matches below committed threshold",
    details
  );
}
