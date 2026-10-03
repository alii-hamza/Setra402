import { describe, expect, it } from "vitest";
import { Connection, Keypair, SystemProgram } from "@solana/web3.js";
import { ChainClient, sendRebuiltTransaction } from "../../src/chain/client.js";

describe("confirmed financial receipt evidence", () => {
  it.each([
    [null, false],
    [{ err: null, confirmationStatus: "processed" }, false],
    [
      {
        err: { InstructionError: [0, "failure"] },
        confirmationStatus: "confirmed",
      },
      false,
    ],
    [{ err: null, confirmationStatus: "confirmed" }, true],
    [{ err: null, confirmationStatus: "finalized" }, true],
  ])("signature evidence %j returns %s", async (value, expected) => {
    const connection = {
      async getSignatureStatus(_sig: string, options: unknown) {
        expect(options).toEqual({ searchTransactionHistory: true });
        return { value };
      },
    };
    expect(
      await ChainClient.prototype.confirmSignature.call(
        { options: { connection } } as unknown as ChainClient,
        "sig"
      )
    ).toBe(expected);
  });
  it("unavailable signature history stays unresolved", async () => {
    const connection = {
      async getSignatureStatus() {
        throw new Error("RPC offline");
      },
    };
    expect(
      await ChainClient.prototype.confirmSignature.call(
        { options: { connection } } as unknown as ChainClient,
        "sig"
      )
    ).toBe(false);
  });
});

// SIMULATED RPC: these tests deliberately distinguish acceptance from confirmation.
function fixture(status: unknown, message = "RPC timeout") {
  const payer = Keypair.generate();
  let sends = 0;
  const connection = {
    async getLatestBlockhash() {
      return {
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 100,
      };
    },
    async sendRawTransaction() {
      sends++;
      throw new Error(message);
    },
    async getSignatureStatus() {
      return { context: { slot: 2 }, value: status };
    },
    async getBlockHeight() {
      return 50;
    },
  } as unknown as Connection;
  return {
    sends: () => sends,
    send: () =>
      sendRebuiltTransaction({
        connection,
        payer,
        signers: [payer],
        maxAttempts: 2,
        async buildInstructions() {
          return [
            SystemProgram.transfer({
              fromPubkey: payer.publicKey,
              toPubkey: Keypair.generate().publicKey,
              lamports: 1,
            }),
          ];
        },
      }),
  };
}
describe("Phase 3.5 unknown transaction outcomes (SIMULATED)", () => {
  it("does not report processed acceptance as confirmed payment", async () => {
    const f = fixture({
      err: null,
      confirmationStatus: "processed",
      confirmations: 0,
    });
    await expect(f.send()).rejects.toThrow(/ambiguous|unknown/i);
    expect(f.sends()).toBe(1);
  });
  it.each(["confirmed", "finalized"])(
    "recovers a %s successful signature without resubmission",
    async (confirmationStatus) => {
      const f = fixture({ err: null, confirmationStatus });
      await expect(f.send()).resolves.toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
      expect(f.sends()).toBe(1);
    }
  );
  it("does not rebuild from an RPC blockhash message while the signature can still land", async () => {
    const f = fixture(null, "blockhash not found");
    await expect(f.send()).rejects.toThrow(/ambiguous|unknown/i);
    expect(f.sends()).toBe(1);
  });
  it("keeps a timeout with unavailable signature evidence unknown", async () => {
    const f = fixture(null);
    await expect(f.send()).rejects.toThrow(/ambiguous|unknown/i);
    expect(f.sends()).toBe(1);
  });
});
