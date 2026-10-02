import { z } from "zod";
import type { VerificationPolicyV1 } from "../types.js";

const nonNegative = z.number().int().safe().nonnegative();
const positive = z.number().int().safe().positive();
const pointer = z
  .string()
  .refine((value) => value === "" || value.startsWith("/"), {
    message: "must be an RFC 6901 JSON Pointer",
  });
const hash = z.string().regex(/^[0-9a-f]{64}$/);

const checkSchema = z.union([
  z
    .object({ type: z.literal("json_schema"), schema_ref: z.string().min(1) })
    .strict(),
  z
    .object({
      type: z.literal("record_count"),
      pointer,
      min: nonNegative.optional(),
      max: nonNegative.optional(),
      exact: nonNegative.optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.min !== undefined ||
        value.max !== undefined ||
        value.exact !== undefined,
      {
        message: "record_count requires min, max, or exact",
      }
    )
    .refine(
      (value) =>
        value.exact === undefined ||
        (value.min === undefined && value.max === undefined),
      {
        message: "record_count exact cannot be combined with min/max",
      }
    )
    .refine(
      (value) =>
        value.min === undefined ||
        value.max === undefined ||
        value.min <= value.max,
      {
        message: "record_count min cannot exceed max",
      }
    ),
  z
    .object({
      type: z.literal("required_fields"),
      pointer,
      fields: z.array(z.string().min(1)).min(1),
      minimum_valid_ratio_bps: nonNegative.max(10_000).optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("unique"), pointer, field: z.string().min(1) })
    .strict(),
  z
    .object({
      type: z.literal("freshness"),
      timestamp_pointer: pointer,
      max_age_seconds: nonNegative,
      max_future_skew_seconds: nonNegative.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("artifact_integrity"),
      evidence_id: z.string().min(1),
      max_size_bytes: positive,
      expected_sha256: hash.optional(),
      allowed_mime_types: z.array(z.string().min(1)).min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("solana_state"),
      target: z.literal("transaction"),
      signature: z.string().min(1),
      commitment: z.enum(["confirmed", "finalized"]),
      expected_recipient: z.string().min(1).optional(),
      expected_mint: z.string().min(1).optional(),
      expected_amount_base_units: z
        .string()
        .regex(/^(0|[1-9]\d*)$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("solana_state"),
      target: z.literal("account"),
      account: z.string().min(1),
      commitment: z.enum(["confirmed", "finalized"]),
      expected_owner: z.string().min(1).optional(),
    })
    .strict(),
]);

const policySchema = z
  .object({
    version: z.literal("1"),
    level: z.literal(1),
    checks: z.array(checkSchema).min(1),
  })
  .strict();

export function parseVerificationPolicy(value: unknown): VerificationPolicyV1 {
  return policySchema.parse(value) as VerificationPolicyV1;
}
