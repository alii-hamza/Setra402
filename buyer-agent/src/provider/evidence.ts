import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { hashCanonical } from "../manifest/hash.js";
import { deriveTaskPda } from "../chain/pda.js";
import { PROVIDER_PROFILES } from "../registry/services.js";
import {
  providerExecutionIdentity,
  providerRecoveryCapabilitiesV1Schema,
} from "../registry/providers.js";

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
    connector_type: z
      .enum(["LOCAL_FIXTURE", "REST_API", "MCP_TOOL"])
      .nullable(),
    recovery_capabilities: providerRecoveryCapabilitiesV1Schema.nullable(),
    profile_binding: z.literal("CURRENT_REGISTRY_ONLY"),
    idempotency_key: hash.nullable(),
    provider_execution_id: z.string().min(1).max(256).nullable(),
    provider_status: z.string().min(1).max(64).nullable(),
    receipt_hash: hash.nullable(),
    response_commitment: hash.nullable(),
    observed_at_unix: z.number().int().nonnegative().nullable(),
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
      value.connector_type,
      value.recovery_capabilities,
      value.idempotency_key,
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
    if (
      !hasIntent &&
      [
        value.provider_execution_id,
        value.provider_status,
        value.receipt_hash,
        value.response_commitment,
        value.observed_at_unix,
      ].some((field) => field !== null)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "absent evidence cannot claim provider observations",
      });
    if (
      value.provider_execution_id !== null &&
      !value.recovery_capabilities?.execution_id
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provider execution ID is not declared",
      });
    if (
      value.provider_status !== null &&
      !value.recovery_capabilities?.status_query
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provider status is not declared",
      });
    if (
      value.receipt_hash !== null &&
      !value.recovery_capabilities?.durable_receipt
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provider receipt is not declared",
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
    const serviceId = evidence.service_id;
    const inputHash = evidence.input_hash;
    const providerId = evidence.provider_connector_ref;
    if (!serviceId || !inputHash || !providerId)
      throw new Error("provider evidence identity fields are missing");
    if (serviceId !== expected.serviceId || inputHash !== expectedInputHash)
      throw new Error("provider evidence service/input binding conflict");
    if (
      !PROVIDER_PROFILES.some(
        (profile) =>
          profile.provider_id === providerId &&
          profile.connector_type === evidence.connector_type &&
          hashCanonical(profile.recovery_capabilities) ===
            hashCanonical(evidence.recovery_capabilities)
      )
    )
      throw new Error("provider evidence profile is not allowlisted");
    if (
      evidence.idempotency_key !==
      providerExecutionIdentity({
        taskStatePda: evidence.task_state_pda,
        serviceId,
        inputHash,
        providerId,
      })
    )
      throw new Error("provider evidence idempotency binding conflict");
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
