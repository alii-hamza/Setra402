import { z } from "zod";
import type { ResultEnvelopeV1, TaskManifestV1 } from "../types.js";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const decimal = z.string().regex(/^(0|[1-9]\d*)$/);

const manifestSchema = z
  .object({
    version: z.literal("1"),
    taskId: decimal,
    serviceId: z.string().min(1),
    buyer: z.string().min(1),
    sellerTokenAccount: z.string().min(1),
    sellerOwner: z.string().min(1),
    verifier: z.string().min(1),
    mint: z.string().min(1),
    amountBaseUnits: decimal.refine((value) => BigInt(value) > 0n),
    timeoutSeconds: z.number().int().safe().positive(),
    isPrivate: z.boolean(),
    taskSpecHash: hash,
    policyHash: hash,
    quoteHash: hash,
  })
  .strict();

const resultEnvelopeSchema = z
  .object({
    version: z.literal("1"),
    taskId: decimal,
    serviceId: z.string().min(1),
    result: z.unknown(),
    resultHash: hash,
    evidence: z.array(z.record(z.unknown())),
    completedAtUnix: z.number().int().safe().nonnegative(),
    input: z.unknown(),
    output_hash: hash,
  })
  .strict();

export function parseTaskManifest(value: unknown): TaskManifestV1 {
  return manifestSchema.parse(value);
}

export function parseResultEnvelope(value: unknown): ResultEnvelopeV1 {
  return resultEnvelopeSchema.parse(value) as ResultEnvelopeV1;
}
