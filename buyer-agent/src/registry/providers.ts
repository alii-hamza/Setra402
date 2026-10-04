import { z } from "zod";
import { hashCanonical } from "../manifest/hash.js";

const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const capability = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);
const secretRef = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

export const providerRecoveryCapabilitiesV1Schema = z
  .object({
    idempotency: z.enum(["NONE", "KEYED"]),
    execution_id: z.boolean(),
    status_query: z.boolean(),
    durable_receipt: z.boolean(),
    deterministic_replay: z.boolean(),
    may_produce_non_idempotent_external_effect: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, message });
    if (value.status_query && !value.execution_id)
      issue("status query requires provider execution ID support");
    if (
      value.durable_receipt &&
      !value.execution_id &&
      !value.deterministic_replay
    )
      issue("durable receipt requires execution ID or deterministic replay");
    if (value.deterministic_replay && value.idempotency !== "KEYED")
      issue("deterministic replay requires keyed idempotency");
    if (
      value.deterministic_replay &&
      value.may_produce_non_idempotent_external_effect
    )
      issue(
        "non-idempotent external effects cannot claim deterministic replay"
      );
  });

export const providerDefinitionV1Schema = z
  .object({
    version: z.literal("1"),
    provider_id: identifier,
    display_name: z
      .string()
      .min(1)
      .max(120)
      .refine((v) => v.trim().length > 0),
    connector_type: z.enum(["LOCAL_FIXTURE", "REST_API", "MCP_TOOL"]),
    execution_profile: identifier,
    capabilities: z.array(capability).min(1).max(100),
    privacy_support: z.boolean(),
    active: z.boolean(),
    recovery_capabilities: providerRecoveryCapabilitiesV1Schema,
    secret_refs: z.array(secretRef).max(16),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.capabilities).size !== value.capabilities.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duplicate provider capability",
      });
    if (new Set(value.secret_refs).size !== value.secret_refs.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duplicate provider secret ref",
      });
  });

export type ProviderDefinitionV1 = z.infer<typeof providerDefinitionV1Schema>;

export function parseProviderDefinitions(
  value: unknown
): ProviderDefinitionV1[] {
  const definitions = z.array(providerDefinitionV1Schema).max(500).parse(value);
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.provider_id))
      throw new Error(`duplicate provider_id: ${definition.provider_id}`);
    ids.add(definition.provider_id);
  }
  return definitions;
}

export interface ProviderExecutionIdentityInput {
  taskStatePda: string;
  serviceId: string;
  inputHash: string;
  providerId: string;
}

/** Stable across retries of one immutable provider intent, different for changed bindings. */
export function providerExecutionIdentity(
  input: ProviderExecutionIdentityInput
): string {
  return hashCanonical({
    version: "1",
    task_state_pda: input.taskStatePda,
    service_id: input.serviceId,
    input_hash: input.inputHash,
    provider_id: input.providerId,
  });
}
