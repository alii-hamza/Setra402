import { z } from "zod";

/** Only fixed fields enter logs. Error messages and evidence payloads never do. */
export const reconciliationLogV1Schema = z
  .object({
    version: z.literal("1"),
    correlationId: z.string().regex(/^[0-9a-f]{64}$/),
    taskKey: z.string().regex(/^[0-9a-f]{64}$/),
    classificationBefore: z.array(z.string().max(48)).max(12),
    classificationAfter: z.array(z.string().max(48)).max(12),
    evidenceSource: z.enum([
      "INVENTORY",
      "FINANCIAL",
      "PROVIDER",
      "VOUCHER",
      "VERIFICATION",
      "REVERIFICATION",
    ]),
    operation: z.enum(["RECONCILE", "REVERIFY"]),
    result: z.enum(["OBSERVED", "UNAVAILABLE", "CONFLICT", "NOT_APPLICABLE"]),
    durationMs: z.number().int().nonnegative(),
    errorClass: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/)
      .nullable(),
  })
  .strict();
export type ReconciliationLogV1 = z.infer<typeof reconciliationLogV1Schema>;
export function structuredReconciliationLog(
  value: ReconciliationLogV1
): string {
  return JSON.stringify(reconciliationLogV1Schema.parse(value));
}
export interface OperatorMetricsV1 {
  version: "1";
  tasksScanned: number;
  reconciliationCompleted: number;
  unknownExternalEffect: number;
  unknownFinancialOutcome: number;
  reconciliationRequired: number;
  safeToReverify: number;
  safeToRetry: number;
  refundEligible: number;
  staleClaims: number;
  failedEvidenceQueries: number;
  sandboxUnresolvedLeases: number;
  voucherUnresolvedIntents: number;
}
/** Aggregate-only export: no buyer, task, correlation, or service labels. */
export function metricsText(metrics: OperatorMetricsV1): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(metrics)) {
    if (key === "version") continue;
    const name = `setra_recovery_${key.replace(
      /[A-Z]/g,
      (letter) => `_${letter.toLowerCase()}`
    )}`;
    lines.push(`${name} ${value}`);
  }
  return `${lines.join("\n")}\n`;
}
