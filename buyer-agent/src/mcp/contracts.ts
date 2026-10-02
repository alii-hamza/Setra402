import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { canonicalize } from "../manifest/canonicalize.js";

export const protectedCallSchema = z
  .object({
    task_id: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,19})$/)
      .refine((v) => BigInt(v) <= 18446744073709551615n),
    buyer: z
      .string()
      .max(44)
      .refine((v) => {
        try {
          return new PublicKey(v).toBase58() === v;
        } catch {
          return false;
        }
      }),
    service_id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    is_private: z.boolean(),
    input: z.record(z.unknown()),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      if (Buffer.byteLength(canonicalize(value.input)) > 65_536)
        throw new Error("input too large");
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          error instanceof Error ? error.message : "invalid canonical input",
      });
    }
  });
export type ProtectedCall = z.infer<typeof protectedCallSchema>;
export function requestContext(value: ProtectedCall) {
  return {
    taskId: BigInt(value.task_id),
    buyer: value.buyer,
    serviceId: value.service_id,
    isPrivate: value.is_private,
    input: value.input,
  };
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export const protectedInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["task_id", "buyer", "service_id", "is_private", "input"],
  properties: {
    task_id: { type: "string", pattern: "^(0|[1-9][0-9]{0,19})$" },
    buyer: { type: "string" },
    service_id: { type: "string" },
    is_private: { type: "boolean" },
    input: { type: "object" },
  },
};
