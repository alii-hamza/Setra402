import type {
  SolanaAccountCheckV1,
  SolanaTransactionCheckV1,
  VerificationCheckResult,
} from "../../types.js";
import { fail, pass } from "./common.js";

export interface SolanaTransactionView {
  recipient?: string;
  mint?: string;
  amountBaseUnits?: string;
  transfers?: readonly SolanaTransferView[];
}

export interface SolanaTransferView {
  recipient?: string;
  mint?: string;
  amountBaseUnits?: string;
}

export interface SolanaAccountView {
  owner: string;
}

export interface SolanaStateReader {
  getTransaction(
    signature: string,
    commitment: "confirmed" | "finalized"
  ): Promise<SolanaTransactionView | null>;
  getAccount(
    address: string,
    commitment: "confirmed" | "finalized"
  ): Promise<SolanaAccountView | null>;
}

export async function checkSolanaState(
  policy: SolanaTransactionCheckV1 | SolanaAccountCheckV1,
  reader: SolanaStateReader
): Promise<VerificationCheckResult> {
  try {
    if (policy.target === "account") {
      const account = await reader.getAccount(
        policy.account,
        policy.commitment
      );
      if (!account) return fail(policy.type, "Solana account does not exist");
      if (policy.expected_owner && account.owner !== policy.expected_owner)
        return fail(policy.type, "Solana account owner mismatch");
      return pass(policy.type, "Solana account state verified");
    }
    const transaction = await reader.getTransaction(
      policy.signature,
      policy.commitment
    );
    if (!transaction)
      return fail(policy.type, "Solana transaction does not exist");
    if (policy.expected_amount_base_units) {
      if (!/^(0|[1-9]\d*)$/.test(policy.expected_amount_base_units))
        return fail(policy.type, "expected Solana amount is malformed");
    }
    const transfers = transaction.transfers ?? [transaction];
    const matched = transfers.some(
      (transfer) =>
        (!policy.expected_recipient ||
          transfer.recipient === policy.expected_recipient) &&
        (!policy.expected_mint || transfer.mint === policy.expected_mint) &&
        (!policy.expected_amount_base_units ||
          transfer.amountBaseUnits === policy.expected_amount_base_units)
    );
    if (
      (policy.expected_recipient ||
        policy.expected_mint ||
        policy.expected_amount_base_units) &&
      !matched
    )
      return fail(
        policy.type,
        "no Solana token transfer matches committed state"
      );
    return pass(policy.type, "Solana transaction state verified");
  } catch {
    return fail(policy.type, "Solana state could not be read");
  }
}
