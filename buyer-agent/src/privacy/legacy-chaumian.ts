import { randomBytes } from "node:crypto";

export interface BlindSignatureResponse {
  blind_signature: string;
  mint_pubkey: string;
}

export class LegacyChaumianClient {
  constructor(private readonly sellerUrl: string) {}

  generateNullifier(): Uint8Array {
    return randomBytes(32);
  }

  async requestBlindSignature(input: {
    buyer: string;
    taskId: bigint;
    blindedPointHex: string;
  }): Promise<BlindSignatureResponse> {
    if (input.taskId < 0n || input.taskId > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(
        "legacy blind-sign endpoint requires taskId within the JSON safe-integer range"
      );
    }
    const response = await fetch(
      `${this.sellerUrl.replace(/\/$/, "")}/mint/blind-sign`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          buyer: input.buyer,
          task_id: Number(input.taskId),
          blinded_point: input.blindedPointHex,
        }),
      }
    );
    if (!response.ok)
      throw new Error(`blind-sign endpoint returned HTTP ${response.status}`);
    return (await response.json()) as BlindSignatureResponse;
  }

  /** Cache warming only. A false result never overrides confirmed on-chain settlement. */
  async mirrorNullifierAfterSettlement(
    nullifier: Uint8Array
  ): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.sellerUrl.replace(/\/$/, "")}/verifier/nullify`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            nullifier: Buffer.from(nullifier).toString("hex"),
          }),
        }
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}
