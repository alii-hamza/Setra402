import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { DurableJournal, ensureDurableDirectory } from "./journal.js";
import { hashCanonical } from "../manifest/hash.js";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const recoveryClassificationSchema = z.enum([
  "PROVEN_NOT_OCCURRED",
  "PROVEN_OCCURRED",
  "SAFE_TO_RETRY",
  "UNKNOWN_EXTERNAL_EFFECT",
  "UNKNOWN_FINANCIAL_OUTCOME",
  "RECONCILIATION_REQUIRED",
  "SAFE_TO_REVERIFY",
]);
export const reconciliationFindingV1Schema = z
  .object({
    source: z.enum([
      "INVENTORY",
      "FINANCIAL",
      "PROVIDER",
      "VOUCHER",
      "VERIFICATION",
      "REVERIFICATION",
    ]),
    authority: z.enum(["LOCAL", "CHAIN", "SELLER", "DERIVED"]),
    status: z.enum(["OBSERVED", "UNAVAILABLE", "CONFLICT", "NOT_APPLICABLE"]),
    classification: recoveryClassificationSchema.nullable(),
    evidenceHash: hash.nullable(),
    reason: z.string().min(1).max(512),
  })
  .strict();
export const reconciliationRecordV1Schema = z
  .object({
    version: z.literal("1"),
    taskKey: hash,
    correlationId: hash,
    attempt: z.number().int().positive(),
    startedAtUnixMs: z.number().int().safe().nonnegative(),
    completedAtUnixMs: z.number().int().safe().nonnegative(),
    inventoryRevision: hash,
    evidenceRevision: hash,
    previousRecordHash: hash.nullable(),
    findings: z.array(reconciliationFindingV1Schema).min(1).max(64),
    classifications: z.array(recoveryClassificationSchema).max(12),
    recommendedAction: z.enum([
      "NO_ACTION",
      "READ_ONLY_RECONCILIATION",
      "SAFE_TO_REVERIFY",
      "SAFE_TO_RETRY",
      "WAIT_FOR_EVIDENCE",
      "AWAIT_REFUND_ELIGIBILITY",
      "REFUND_ELIGIBLE",
      "OPERATOR_REVIEW_REQUIRED",
    ]),
    evidenceProvenance: z
      .array(
        z
          .object({
            source: z.string().min(1).max(64),
            authority: z.enum(["LOCAL", "CHAIN", "SELLER", "DERIVED"]),
            evidenceHash: hash.nullable(),
          })
          .strict()
      )
      .max(64),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.completedAtUnixMs < record.startedAtUnixMs)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "completion precedes start",
      });
    if (
      record.correlationId !==
      hashCanonical({ version: "1", taskKey: record.taskKey })
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "correlation identity conflict",
      });
    if (
      record.evidenceRevision !==
      hashCanonical({
        inventoryRevision: record.inventoryRevision,
        findings: record.findings,
        classifications: record.classifications,
        recommendedAction: record.recommendedAction,
        evidenceProvenance: record.evidenceProvenance,
      })
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "evidence revision conflict",
      });
  });
export type ReconciliationRecordV1 = z.infer<
  typeof reconciliationRecordV1Schema
>;
export type ReconciliationFindingV1 = z.infer<
  typeof reconciliationFindingV1Schema
>;

/** Append-only task history with a checksum envelope and linked record hashes. */
export class ReconciliationRecords {
  private readonly journal = new DurableJournal();
  readonly root: string;
  constructor(stateDirectory: string, create = true) {
    this.root = resolve(stateDirectory, "reconciliation", "records");
    if (create) ensureDurableDirectory(this.root);
  }
  private path(taskKey: string, attempt: number): string {
    hash.parse(taskKey);
    if (!Number.isSafeInteger(attempt) || attempt < 1)
      throw new Error("invalid reconciliation attempt");
    return join(this.root, `${taskKey}.${attempt}.record`);
  }
  history(taskKey: string): ReconciliationRecordV1[] {
    hash.parse(taskKey);
    if (!existsSync(this.root)) return [];
    const files = readdirSync(this.root).filter((name) =>
      name.startsWith(`${taskKey}.`)
    );
    const names = files
      .map((name) => {
        const match = /^([0-9a-f]{64})\.([1-9][0-9]*)\.record$/.exec(name);
        if (!match || match[1] !== taskKey)
          throw new Error("unexpected reconciliation record");
        return { name, attempt: Number(match[2]) };
      })
      .sort((a, b) => a.attempt - b.attempt);
    let previous: string | null = null;
    return names.map(({ name, attempt }, index) => {
      if (attempt !== index + 1)
        throw new Error("reconciliation history gap or duplicate");
      const raw = this.journal.read(join(this.root, name));
      const record = reconciliationRecordV1Schema.parse(raw);
      if (
        record.taskKey !== taskKey ||
        record.attempt !== attempt ||
        record.previousRecordHash !== previous
      )
        throw new Error("reconciliation history binding conflict");
      previous = hashCanonical(record);
      return record;
    });
  }
  latest(taskKey: string): ReconciliationRecordV1 | null {
    return this.history(taskKey).at(-1) ?? null;
  }
  publish(record: ReconciliationRecordV1): void {
    const checked = reconciliationRecordV1Schema.parse(record);
    const prior = this.latest(checked.taskKey);
    if (
      checked.attempt !== (prior?.attempt ?? 0) + 1 ||
      checked.previousRecordHash !== (prior ? hashCanonical(prior) : null)
    )
      throw new Error("reconciliation append sequence conflict");
    if (
      !this.journal.publish(
        this.path(checked.taskKey, checked.attempt),
        checked
      )
    )
      throw new Error("duplicate reconciliation attempt");
    if (hashCanonical(this.latest(checked.taskKey)) !== hashCanonical(checked))
      throw new Error("reconciliation record read-back conflict");
  }
}
