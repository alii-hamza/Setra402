import {
  Connection,
  PublicKey,
  type ParsedInstruction,
  type PartiallyDecodedInstruction,
} from "@solana/web3.js";
import type {
  SolanaAccountView,
  SolanaStateReader,
  SolanaTransferView,
  SolanaTransactionView,
} from "./level1/solana-state.js";

function isParsed(
  instruction: ParsedInstruction | PartiallyDecodedInstruction
): instruction is ParsedInstruction {
  return "parsed" in instruction;
}

export class SolanaRpcStateReader implements SolanaStateReader {
  constructor(private readonly connection: Connection) {}

  async getTransaction(
    signature: string,
    commitment: "confirmed" | "finalized"
  ): Promise<SolanaTransactionView | null> {
    const transaction = await this.connection.getParsedTransaction(signature, {
      commitment,
      maxSupportedTransactionVersion: 0,
    });
    if (!transaction) return null;
    const instructions = [
      ...transaction.transaction.message.instructions,
      ...(transaction.meta?.innerInstructions ?? []).flatMap(
        (group) => group.instructions
      ),
    ];
    const transfers: SolanaTransferView[] = [];
    for (const instruction of instructions) {
      if (!isParsed(instruction) || instruction.program !== "spl-token")
        continue;
      const parsed = instruction.parsed as {
        type?: string;
        info?: Record<string, unknown>;
      };
      if (parsed.type !== "transfer" && parsed.type !== "transferChecked")
        continue;
      const info = parsed.info ?? {};
      const tokenAmount = info.tokenAmount as { amount?: unknown } | undefined;
      const amount = tokenAmount?.amount ?? info.amount;
      transfers.push({
        ...(typeof info.destination === "string"
          ? { recipient: info.destination }
          : {}),
        ...(typeof info.mint === "string" ? { mint: info.mint } : {}),
        ...(typeof amount === "string" ? { amountBaseUnits: amount } : {}),
      });
    }
    return { transfers };
  }

  async getAccount(
    address: string,
    commitment: "confirmed" | "finalized"
  ): Promise<SolanaAccountView | null> {
    const account = await this.connection.getParsedAccountInfo(
      new PublicKey(address),
      commitment
    );
    if (!account.value) return null;
    const data = account.value.data;
    if (!Buffer.isBuffer(data) && "parsed" in data) {
      const info = data.parsed.info as { owner?: unknown };
      if (typeof info.owner === "string") return { owner: info.owner };
    }
    return { owner: account.value.owner.toBase58() };
  }
}
