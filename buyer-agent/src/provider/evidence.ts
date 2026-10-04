import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { hashCanonical } from "../manifest/hash.js";
import { deriveTaskPda } from "../chain/pda.js";
import { PROVIDER_PROFILES } from "../registry/services.js";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const pubkey = z.string().refine((value) => {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
});
const recordState = z.enum([
  "STORE_UNAVAILABLE",
  "NO_LOCAL_EVIDENCE",
  "INTENT_ONLY",
  "RESULT_PERSISTED",
]);
export const providerEvidenceV1Schema = z
  .object({
    version: z.literal("1"),
    buyer: pubkey,
    task_id: z.string().regex(/^(0|[1-9]\d*)$/),
    task_state_pda: pubkey,
    record_state: recordState,
    service_id: z.string().min(1).nullable(),
    input_hash: hash.nullable(),
    result_hash: hash.nullable(),
    provider_connector_ref: z.string().min(1).nullable(),
    recovery_capability: z.enum(["NONE", "DURABLE_RESULT_REPLAY_ONLY"]),
    profile_binding: z.literal("CURRENT_REGISTRY_ONLY"),
    idempotency_key: z.null(),
    provider_execution_id: z.null(),
    status_query_supported: z.literal(false),
    durable_receipt_supported: z.literal(false),
  })
  .strict()
  .superRefine((value, context) => {
    const hasIntent =
      value.record_state === "INTENT_ONLY" ||
      value.record_state === "RESULT_PERSISTED";
    const fields = [
      value.service_id,
      value.input_hash,
      value.provider_connector_ref,
    ];
    if (
      hasIntent
        ? fields.some((field) => field === null)
        : fields.some((field) => field !== null)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provider evidence fields do not match record state",
      });
    if (
      (value.record_state === "RESULT_PERSISTED") !==
      (value.result_hash !== null)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "result hash does not match record state",
      });
    if (hasIntent && value.recovery_capability !== "DURABLE_RESULT_REPLAY_ONLY")
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fixture evidence lacks declared profile capability",
      });
    if (!hasIntent && value.recovery_capability !== "NONE")
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "absent evidence cannot claim capability",
      });
  });
export type ProviderEvidenceV1 = z.infer<typeof providerEvidenceV1Schema>;
export interface ProviderEvidenceExpectation {
  programId: string;
  buyer: string;
  taskId: string;
  taskStatePda: string;
  serviceId: string;
  input?: unknown;
  /** Use the committed manifest hash when raw input was lost with the response. */
  inputHash?: string;
}
export type ProviderEvidenceAssessment =
  | { status: "UNKNOWN_EXTERNAL_EFFECT"; evidence: ProviderEvidenceV1 }
  | { status: "RESULT_PERSISTED_UNVERIFIED"; evidence: ProviderEvidenceV1 };

/** A seller GET is evidence discovery, never a provider retry or receipt. */
export function assessProviderEvidence(
  raw: unknown,
  expected: ProviderEvidenceExpectation
): ProviderEvidenceAssessment {
  const evidence = providerEvidenceV1Schema.parse(raw);
  const expectedInputHash =
    expected.inputHash ??
    (expected.input === undefined ? null : hashCanonical(expected.input));
  if (
    !expectedInputHash ||
    !hash.safeParse(expectedInputHash).success ||
    (expected.input !== undefined &&
      hashCanonical(expected.input) !== expectedInputHash)
  )
    throw new Error("provider evidence expected input commitment is invalid");
  const [derived] = deriveTaskPda(
    new PublicKey(expected.programId),
    new PublicKey(expected.buyer),
    BigInt(expected.taskId)
  );
  if (
    evidence.buyer !== expected.buyer ||
    evidence.task_id !== expected.taskId ||
    evidence.task_state_pda !== expected.taskStatePda ||
    evidence.task_state_pda !== derived.toBase58()
  )
    throw new Error("provider evidence task binding conflict");
  if (
    evidence.record_state === "INTENT_ONLY" ||
    evidence.record_state === "RESULT_PERSISTED"
  ) {
    if (
      evidence.service_id !== expected.serviceId ||
      evidence.input_hash !== expectedInputHash
    )
      throw new Error("provider evidence service/input binding conflict");
    if (
      !PROVIDER_PROFILES.some(
        (profile) =>
          profile.id === evidence.provider_connector_ref &&
          profile.recovery_capability === evidence.recovery_capability
      )
    )
      throw new Error("provider evidence profile is not allowlisted");
  }
  return evidence.record_state === "RESULT_PERSISTED"
    ? { status: "RESULT_PERSISTED_UNVERIFIED", evidence }
    : { status: "UNKNOWN_EXTERNAL_EFFECT", evidence };
}

export async function queryProviderEvidence(
  sellerUrl: string,
  expected: ProviderEvidenceExpectation,
  timeoutMs = 10_000,
  fetcher: typeof fetch = fetch
): Promise<ProviderEvidenceAssessment> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)
    throw new RangeError("invalid provider evidence timeout");
  const url = `${sellerUrl.replace(/\/$/, "")}/tasks/${encodeURIComponent(
    expected.taskId
  )}/execution-evidence?buyer=${encodeURIComponent(expected.buyer)}`;
  const response = await fetcher(url, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new Error(`provider evidence HTTP ${response.status}`);
  if (!response.body) throw new Error("provider evidence response is empty");
  let bytes = Buffer.alloc(0);
  for await (const chunk of response.body) {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length > 16_384)
      throw new Error("provider evidence response exceeds byte limit");
  }
  return assessProviderEvidence(JSON.parse(bytes.toString("utf8")), expected);
}
