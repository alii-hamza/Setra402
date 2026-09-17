import * as crypto from "crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { SetraClient } from "../../sdk/src/client";

export class FacilitatorAgent {
  constructor(
    private client: SetraClient,
    private verifierKeypair: Keypair,
    private treasuryTokenAccount: PublicKey
  ) {}

  /**
   * Sorts object keys recursively to guarantee byte-identical canonical JSON serialization
   * matching Rust serde_json's default BTreeMap output.
   */
  public canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((x) => this.canonicalize(x));
    if (value !== null && typeof value === "object") {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value as object).sort()) {
        sorted[key] = this.canonicalize((value as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return value;
  }

  public computeHash(input: unknown): string {
    const canonicalStr = JSON.stringify(this.canonicalize(input));
    return crypto.createHash("sha256").update(canonicalStr).digest("hex");
  }

  public async verifyAndSettle(
    taskState: PublicKey,
    vault: PublicKey,
    sellerTokenAccount: PublicKey,
    taskInput: unknown,
    reportedOutputHash: string
  ): Promise<string | null> {
    const expected = this.computeHash(taskInput);

    if (expected !== reportedOutputHash) {
      console.error(
        `[Facilitator] Task verification failed! Expected: ${expected}, Reported: ${reportedOutputHash}. Refusing to settle.`
      );
      return null;
    }

    console.log(`[Facilitator] Verification passed. Settling escrow...`);
    const tx = await this.client.settleTask(
      this.verifierKeypair,
      taskState,
      vault,
      sellerTokenAccount,
      this.treasuryTokenAccount
    );
    console.log(`[Facilitator] On-chain settlement confirmed. Tx: ${tx}`);
    return tx;
  }
}