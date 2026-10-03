import { join } from "node:path";
import type { Connection } from "@solana/web3.js";
import { z } from "zod";
import { DurableJournal } from "../core/journal.js";
import { hashCanonical } from "../manifest/hash.js";
import { ReconciliationRequired } from "../errors.js";

export interface PreparedTransaction {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  fingerprint: string;
  signedAtUnix: number;
}
const preparedSchema = z
  .object({
    signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/),
    blockhash: z.string().min(32).max(44),
    lastValidBlockHeight: z.number().int().safe().nonnegative(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    signedAtUnix: z.number().int().safe().nonnegative(),
  })
  .strict();
export type FinancialClassification =
  | "PROVEN_OCCURRED"
  | "PROVEN_NOT_OCCURRED"
  | "SAFE_TO_RETRY"
  | "UNKNOWN_FINANCIAL_OUTCOME";
export interface FinancialAccountEvidence {
  completed: boolean;
  permits: boolean;
  state: unknown;
  slot?: number;
}
export interface FinancialOperation {
  programId?: string;
  taskState: string;
  kind: string;
  binding?: string;
}

// Persistent exclusive intents have no automatic stale-lock deletion. Inspection
// is read-only; an expired unknown operation still requires an explicit recovery
// decision. This is not a reconciliation worker or a new settlement authority.
export class FinancialJournal {
  constructor(
    private readonly directory: string,
    private readonly journal = new DurableJournal()
  ) {}
  private paths(operation: FinancialOperation) {
    const id = hashCanonical({
      programId: operation.programId ?? "test",
      taskState: operation.taskState,
      kind: operation.kind,
    });
    return {
      intent: join(this.directory, `${id}.intent`),
      prepared: join(this.directory, `${id}.transaction.json`),
      completed: join(this.directory, `${id}.confirmed.json`),
    };
  }
  async inspect(
    operation: FinancialOperation,
    connection: Connection,
    account: (minimumSlot?: number) => Promise<FinancialAccountEvidence>
  ) {
    const paths = this.paths(operation);
    const intent = this.journal.read(paths.intent);
    const raw = this.journal.read(paths.prepared);
    const completedRecord = this.journal.read(paths.completed);
    if (!intent && (raw || completedRecord))
      throw new ReconciliationRequired(
        "orphan financial journal requires reconciliation",
        "UNKNOWN_FINANCIAL_OUTCOME"
      );
    const state = await account();
    if (!intent)
      return {
        classification: state.completed
          ? ("PROVEN_OCCURRED" as const)
          : ("PROVEN_NOT_OCCURRED" as const),
        state: state.state,
        prepared: null,
      };
    if (
      hashCanonical((intent as { operation: unknown }).operation) !==
      hashCanonical(operation)
    )
      throw new ReconciliationRequired(
        "financial operation binding conflict",
        "RECONCILIATION_REQUIRED"
      );
    if (!raw && completedRecord)
      throw new ReconciliationRequired(
        "completion without signed evidence requires reconciliation",
        "UNKNOWN_FINANCIAL_OUTCOME"
      );
    if (!raw)
      return {
        classification: state.completed
          ? ("PROVEN_OCCURRED" as const)
          : ("UNKNOWN_FINANCIAL_OUTCOME" as const),
        state: state.state,
        prepared: null,
      };
    const prepared = preparedSchema.parse(raw);
    if (operation.binding && operation.binding !== prepared.fingerprint)
      throw new ReconciliationRequired(
        "financial fingerprint conflict",
        "RECONCILIATION_REQUIRED"
      );
    const status = await connection.getSignatureStatus(prepared.signature, {
      searchTransactionHistory: true,
    });
    const confirmed =
      status.value?.confirmationStatus === "confirmed" ||
      status.value?.confirmationStatus === "finalized";
    if (confirmed && status.value?.err === null && state.completed)
      return {
        classification: "PROVEN_OCCURRED" as const,
        state: state.state,
        prepared,
      };
    if (state.completed)
      return {
        classification: "PROVEN_OCCURRED" as const,
        state: state.state,
        prepared,
        signatureUnconfirmed: true,
      };
    const fence = await connection.getSlot("finalized");
    const block = await connection.getParsedBlock(fence, {
      commitment: "finalized",
      transactionDetails: "none",
      rewards: false,
      maxSupportedTransactionVersion: 0,
    });
    const height = block?.blockHeight;
    if (height === null || height === undefined)
      return {
        classification: "UNKNOWN_FINANCIAL_OUTCOME" as const,
        state: state.state,
        prepared,
      };
    if (
      height > prepared.lastValidBlockHeight ||
      (status.value?.confirmationStatus === "finalized" &&
        status.value.err !== null)
    ) {
      const fencedStatus = await connection.getSignatureStatus(
        prepared.signature,
        { searchTransactionHistory: true }
      );
      const fencedState = await account(fence);
      if (fencedState.completed)
        return {
          classification: "PROVEN_OCCURRED" as const,
          state: fencedState.state,
          prepared,
          signatureUnconfirmed: true,
        };
      const cannotLand =
        (height > prepared.lastValidBlockHeight &&
          fencedStatus.value === null) ||
        (fencedStatus.value?.confirmationStatus === "finalized" &&
          fencedStatus.value.err !== null);
      if (
        cannotLand &&
        fencedStatus.context.slot >= fence &&
        (fencedState.slot ?? -1) >= fence
      )
        return {
          classification: fencedState.permits
            ? ("SAFE_TO_RETRY" as const)
            : ("PROVEN_NOT_OCCURRED" as const),
          state: fencedState.state,
          prepared,
        };
    }
    return {
      classification: "UNKNOWN_FINANCIAL_OUTCOME" as const,
      state: state.state,
      prepared,
    };
  }
  async run(
    operation: FinancialOperation,
    connection: Connection,
    account: (minimumSlot?: number) => Promise<FinancialAccountEvidence>,
    send: (persist: (value: PreparedTransaction) => void) => Promise<string>
  ): Promise<string> {
    const paths = this.paths(operation);
    if (
      !this.journal.read(paths.intent) &&
      (this.journal.read(paths.prepared) || this.journal.read(paths.completed))
    )
      throw new ReconciliationRequired(
        "orphan financial journal requires reconciliation",
        "UNKNOWN_FINANCIAL_OUTCOME"
      );
    if (
      !this.journal.publish(paths.intent, {
        operation,
        state: "UNKNOWN_FINANCIAL_OUTCOME",
      })
    ) {
      const evidence = await this.inspect(operation, connection, account);
      if (
        evidence.classification === "PROVEN_OCCURRED" &&
        evidence.prepared &&
        !("signatureUnconfirmed" in evidence)
      )
        return evidence.prepared.signature;
      throw new ReconciliationRequired(
        "financial outcome requires reconciliation before any resubmission",
        evidence.classification,
        evidence
      );
    }
    try {
      const state = await account();
      if (state.completed || !state.permits)
        throw new ReconciliationRequired(
          "fresh chain state does not permit financial submission",
          state.completed ? "PROVEN_OCCURRED" : "RECONCILIATION_REQUIRED",
          state
        );
      const signature = await send((value) => {
        preparedSchema.parse(value);
        this.journal.write(paths.prepared, value);
      });
      this.journal.write(paths.completed, {
        signature,
        confirmedAtUnix: Math.floor(Date.now() / 1000),
      });
      return signature;
    } catch (error) {
      // Keep every intent and signed fingerprint even if acknowledgement or
      // completion persistence fails. Never turn this into an automatic retry.
      throw error;
    }
  }
}
