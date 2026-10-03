import { randomBytes } from "node:crypto";
import { ristretto255 } from "@noble/curves/ed25519.js";
import { VerificationFailed } from "../errors.js";
import { ReconciliationRequired } from "../errors.js";
import { DurableJournal } from "../core/journal.js";
import { hashCanonical } from "../manifest/hash.js";
import { resolve, join } from "node:path";

export interface BlindSignatureResponse {
  blind_signature: string;
  mint_pubkey: string;
}

export interface BlindMaterial {
  nullifier: Uint8Array;
  nullifierScalar: bigint;
  blindingScalar: bigint;
  blindedPointHex: string;
}

export interface LegacyBlindVoucher {
  nullifier: Uint8Array;
  blindSignature: string;
  mintPubkey: string;
  unblindedSignature: string;
}

function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1)
    value = (value << 8n) | BigInt(bytes[index]!);
  return value;
}

function randomNonzeroScalar(): bigint {
  let scalar = 0n;
  while (scalar === 0n) {
    scalar = ristretto255.Point.Fn.create(bytesToBigIntLE(randomBytes(64)));
  }
  return scalar;
}

function checkedScalar(name: string, value: bigint | undefined): bigint {
  const scalar =
    value === undefined
      ? randomNonzeroScalar()
      : ristretto255.Point.Fn.create(value);
  if (scalar === 0n)
    throw new RangeError(`${name} must be non-zero modulo the group order`);
  return scalar;
}

export function createBlindMaterial(
  fixed: {
    nullifierScalar?: bigint;
    blindingScalar?: bigint;
  } = {}
): BlindMaterial {
  const nullifierScalar = checkedScalar(
    "nullifierScalar",
    fixed.nullifierScalar
  );
  const blindingScalar = checkedScalar("blindingScalar", fixed.blindingScalar);
  const eta = ristretto255.Point.BASE.multiply(nullifierScalar);
  const blinded = eta.multiply(blindingScalar);
  return {
    nullifier: eta.toBytes(),
    nullifierScalar,
    blindingScalar,
    blindedPointHex: Buffer.from(blinded.toBytes()).toString("hex"),
  };
}

function pointFromHex(name: string, value: string) {
  if (!/^[0-9a-fA-F]{64}$/.test(value))
    throw new VerificationFailed(`${name} is not a 32-byte hex point`);
  try {
    return ristretto255.Point.fromHex(value);
  } catch {
    throw new VerificationFailed(`${name} is not a valid Ristretto point`);
  }
}

export function verifyBlindSignature(
  material: BlindMaterial,
  response: BlindSignatureResponse
): LegacyBlindVoucher {
  const blindSignature = pointFromHex(
    "blind_signature",
    response.blind_signature
  );
  const mintPubkey = pointFromHex("mint_pubkey", response.mint_pubkey);
  const unblinded = blindSignature.multiply(
    ristretto255.Point.Fn.inv(material.blindingScalar)
  );
  const expected = mintPubkey.multiply(material.nullifierScalar);
  if (!unblinded.equals(expected))
    throw new VerificationFailed("blind signature verification failed");
  return {
    nullifier: material.nullifier,
    blindSignature: response.blind_signature.toLowerCase(),
    mintPubkey: response.mint_pubkey.toLowerCase(),
    unblindedSignature: Buffer.from(unblinded.toBytes()).toString("hex"),
  };
}

export class LegacyChaumianClient {
  private readonly journal = new DurableJournal();
  constructor(
    private readonly sellerUrl: string,
    private readonly directory = resolve(
      process.env.SETRA_STATE_DIR ?? ".setra-state",
      "vouchers"
    )
  ) {}

  generateNullifier(): Uint8Array {
    return createBlindMaterial().nullifier;
  }

  async createVoucher(input: {
    buyer: string;
    taskId: bigint;
  }): Promise<LegacyBlindVoucher> {
    const id = hashCanonical({
      seller: this.sellerUrl,
      buyer: input.buyer,
      taskId: input.taskId.toString(),
    });
    const intentPath = join(this.directory, `${id}.intent`);
    const resultPath = join(this.directory, `${id}.voucher.json`);
    const prior = this.journal.read(intentPath) as {
      nullifierScalar: string;
      blindingScalar: string;
      blindedPointHex: string;
    } | null;
    const saved = this.journal.read(
      resultPath
    ) as BlindSignatureResponse | null;
    if (!prior && saved)
      throw new ReconciliationRequired(
        "orphan voucher requires reconciliation",
        "UNKNOWN_EXTERNAL_EFFECT"
      );
    if (prior) {
      if (!saved)
        throw new ReconciliationRequired(
          "voucher issuance outcome unknown; no replacement permitted",
          "UNKNOWN_EXTERNAL_EFFECT"
        );
      const original = createBlindMaterial({
        nullifierScalar: BigInt(prior.nullifierScalar),
        blindingScalar: BigInt(prior.blindingScalar),
      });
      if (original.blindedPointHex !== prior.blindedPointHex)
        throw new ReconciliationRequired(
          "voucher intent corrupted",
          "RECONCILIATION_REQUIRED"
        );
      return verifyBlindSignature(original, saved);
    }
    const material = createBlindMaterial();
    if (
      !this.journal.publish(intentPath, {
        nullifierScalar: material.nullifierScalar.toString(),
        blindingScalar: material.blindingScalar.toString(),
        blindedPointHex: material.blindedPointHex,
      })
    )
      throw new ReconciliationRequired(
        "voucher issuance already claimed; reconciliation required",
        "UNKNOWN_EXTERNAL_EFFECT"
      );
    const response = await this.requestBlindSignature({
      ...input,
      blindedPointHex: material.blindedPointHex,
    });
    const voucher = verifyBlindSignature(material, response);
    this.journal.publish(resultPath, response);
    return voucher;
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
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!response.ok)
      throw new Error(`blind-sign endpoint returned HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("blind_signature" in body) ||
      typeof body.blind_signature !== "string" ||
      !("mint_pubkey" in body) ||
      typeof body.mint_pubkey !== "string"
    ) {
      throw new VerificationFailed("blind-sign endpoint returned invalid JSON");
    }
    return {
      blind_signature: body.blind_signature,
      mint_pubkey: body.mint_pubkey,
    };
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
