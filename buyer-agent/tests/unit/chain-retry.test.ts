import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { sendRebuiltTransaction } from "../../src/chain/client.js";

describe("Solana transaction retry safety", () => {
  it("rebuilds and re-signs with a fresh blockhash after stale-blockhash failure", async () => {
    const payer = Keypair.generate();
    const recipient = Keypair.generate().publicKey;
    const blockhashes = [
      Keypair.generate().publicKey.toBase58(),
      Keypair.generate().publicKey.toBase58(),
    ];
    const serialized: string[] = [];
    const signed: string[] = [];
    let blockhashRead = 0;
    let builds = 0;

    const connection = {
      async getLatestBlockhash() {
        const blockhash = blockhashes[blockhashRead++];
        return { blockhash, lastValidBlockHeight: 100 + blockhashRead };
      },
      async sendRawTransaction(raw: Buffer) {
        serialized.push(raw.toString("base64"));
        if (serialized.length === 1) throw new Error("blockhash not found");
        const signature = Transaction.from(raw).signature;
        if (!signature) throw new Error("test transaction is unsigned");
        return bs58.encode(signature);
      },
      async confirmTransaction() {
        return { context: { slot: 1 }, value: { err: null } };
      },
      async getSignatureStatus() {
        return { context: { slot: 1 }, value: null };
      },
      async getBlockHeight(commitment: string) {
        expect(commitment).toBe("finalized");
        return 200; // Authoritative expiry evidence, beyond lastValidBlockHeight.
      },
      async getSlot() {
        return 1;
      },
      async getParsedBlock() {
        return { blockHeight: 200 };
      },
    } as unknown as Connection;

    await sendRebuiltTransaction({
      connection,
      payer,
      signers: [payer],
      maxAttempts: 2,
      async canRebuild() {
        return true;
      }, // SIMULATED account remains eligible.
      onSigned(signature) {
        signed.push(signature);
      },
      async buildInstructions() {
        builds += 1;
        return [
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: recipient,
            lamports: 1,
          }),
        ];
      },
    });

    expect(builds).toBe(2);
    expect(serialized).toHaveLength(2);
    expect(serialized[0]).not.toBe(serialized[1]);
    expect(signed).toHaveLength(2);
    expect(signed[0]).not.toBe(signed[1]);
  });
});
