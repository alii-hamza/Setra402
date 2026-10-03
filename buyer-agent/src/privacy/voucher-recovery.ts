import { join, resolve } from "node:path";
import { DurableJournal } from "../core/journal.js";
import { hashCanonical } from "../manifest/hash.js";
import {
  createBlindMaterial,
  verifyBlindSignature,
  type BlindSignatureResponse,
  type LegacyBlindVoucher,
} from "./legacy-chaumian.js";

export type VoucherRecoveryClassification =
  | "PROVEN_OCCURRED"
  | "UNKNOWN_EXTERNAL_EFFECT"
  | "RECONCILIATION_REQUIRED";

export interface VoucherRecoveryView {
  version: "1";
  classification: VoucherRecoveryClassification;
  localIntent: "ABSENT" | "VALID" | "CORRUPT";
  localResponse: "ABSENT" | "VALID" | "CORRUPT";
  sellerEvidence:
    | "UNAVAILABLE"
    | "NO_LOCAL_EVIDENCE"
    | "INTENT_ONLY"
    | "RESPONSE_PERSISTED"
    | "CONFLICT";
  mintIdentity: "MATCHES" | "CHANGED" | "UNKNOWN";
  voucher?: LegacyBlindVoucher;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid voucher evidence");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join(",") !== keys.sort().join(","))
    throw new Error("unexpected voucher evidence fields");
}
function hexPoint(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    throw new Error("invalid point encoding");
  return value;
}

/** Read-only. No blind-sign POST, local write, or voucher reissuance. */
export async function inspectVoucherRecovery(input: {
  sellerUrl: string;
  buyer: string;
  taskId: bigint;
  directory?: string;
  fetcher?: typeof fetch;
}): Promise<VoucherRecoveryView> {
  const directory =
    input.directory ??
    resolve(process.env.SETRA_STATE_DIR ?? ".setra-state", "vouchers");
  const id = hashCanonical({
    seller: input.sellerUrl,
    buyer: input.buyer,
    taskId: input.taskId.toString(),
  });
  const journal = new DurableJournal();
  const view: VoucherRecoveryView = {
    version: "1",
    classification: "UNKNOWN_EXTERNAL_EFFECT",
    localIntent: "ABSENT",
    localResponse: "ABSENT",
    sellerEvidence: "UNAVAILABLE",
    mintIdentity: "UNKNOWN",
  };
  let material: ReturnType<typeof createBlindMaterial> | undefined;
  let localResponse: BlindSignatureResponse | undefined;
  try {
    const raw = journal.read(join(directory, `${id}.intent`));
    if (raw !== null) {
      const prior = object(raw);
      exact(prior, ["nullifierScalar", "blindingScalar", "blindedPointHex"]);
      if (
        typeof prior.nullifierScalar !== "string" ||
        !/^[0-9]+$/.test(prior.nullifierScalar) ||
        typeof prior.blindingScalar !== "string" ||
        !/^[0-9]+$/.test(prior.blindingScalar)
      )
        throw new Error("invalid voucher scalars");
      material = createBlindMaterial({
        nullifierScalar: BigInt(prior.nullifierScalar),
        blindingScalar: BigInt(prior.blindingScalar),
      });
      if (material.blindedPointHex !== hexPoint(prior.blindedPointHex))
        throw new Error("voucher intent mismatch");
      view.localIntent = "VALID";
    }
  } catch {
    view.localIntent = "CORRUPT";
    view.classification = "RECONCILIATION_REQUIRED";
  }
  try {
    const raw = journal.read(join(directory, `${id}.voucher.json`));
    if (raw !== null) {
      const saved = object(raw);
      exact(saved, ["blind_signature", "mint_pubkey"]);
      localResponse = {
        blind_signature: hexPoint(saved.blind_signature),
        mint_pubkey: hexPoint(saved.mint_pubkey),
      };
      if (!material) throw new Error("orphan voucher response");
      view.voucher = verifyBlindSignature(material, localResponse);
      view.localResponse = "VALID";
      view.classification = "PROVEN_OCCURRED";
    }
  } catch {
    view.localResponse = "CORRUPT";
    view.classification = "RECONCILIATION_REQUIRED";
  }
  if (view.localIntent === "CORRUPT" || view.localResponse === "CORRUPT") {
    delete view.voucher;
    return view;
  }
  if (!material) return view;

  let response: Response;
  try {
    response = await (input.fetcher ?? fetch)(
      `${input.sellerUrl.replace(/\/$/, "")}/mint/issuance/${
        input.taskId
      }?buyer=${encodeURIComponent(input.buyer)}`,
      { method: "GET", signal: AbortSignal.timeout(10_000) }
    );
  } catch {
    return view;
  }
  if (response.status === 409) {
    view.sellerEvidence = "CONFLICT";
    view.classification = "RECONCILIATION_REQUIRED";
    delete view.voucher;
    return view;
  }
  if (!response.ok) return view;
  try {
    const evidence = object(await response.json());
    exact(evidence, [
      "version",
      "buyer",
      "task_id",
      "task_state_pda",
      "state",
      "blinded_point",
      "mint_pubkey",
      "blind_signature",
      "current_mint_matches_receipt",
    ]);
    if (
      evidence.version !== "1" ||
      evidence.buyer !== input.buyer ||
      evidence.task_id !== input.taskId.toString() ||
      typeof evidence.task_state_pda !== "string"
    )
      throw new Error("wrong task evidence");
    if (
      evidence.state !== "NO_LOCAL_EVIDENCE" &&
      evidence.state !== "INTENT_ONLY" &&
      evidence.state !== "RESPONSE_PERSISTED"
    )
      throw new Error("unknown issuance state");
    view.sellerEvidence = evidence.state;
    if (evidence.state === "NO_LOCAL_EVIDENCE") {
      if (
        evidence.blinded_point !== null ||
        evidence.mint_pubkey !== null ||
        evidence.blind_signature !== null ||
        evidence.current_mint_matches_receipt !== null
      )
        throw new Error("inconsistent absent evidence");
      return view;
    }
    if (hexPoint(evidence.blinded_point) !== material.blindedPointHex)
      throw new Error("blinded request mismatch");
    const sellerKey = hexPoint(evidence.mint_pubkey);
    if (
      evidence.current_mint_matches_receipt !== true &&
      evidence.current_mint_matches_receipt !== false
    )
      throw new Error("unknown mint identity");
    view.mintIdentity = evidence.current_mint_matches_receipt
      ? "MATCHES"
      : "CHANGED";
    if (!evidence.current_mint_matches_receipt)
      throw new Error("mint identity changed");
    if (evidence.state === "INTENT_ONLY") {
      if (evidence.blind_signature !== null)
        throw new Error("unexpected signature");
      if (localResponse)
        throw new Error("local response conflicts with seller intent");
      return view;
    }
    const serverResponse = {
      blind_signature: hexPoint(evidence.blind_signature),
      mint_pubkey: sellerKey,
    };
    const voucher = verifyBlindSignature(material, serverResponse);
    if (
      localResponse &&
      (localResponse.blind_signature !== serverResponse.blind_signature ||
        localResponse.mint_pubkey !== serverResponse.mint_pubkey)
    )
      throw new Error("response conflict");
    view.voucher = voucher;
    view.classification = "PROVEN_OCCURRED";
    return view;
  } catch {
    view.sellerEvidence = "CONFLICT";
    view.classification = "RECONCILIATION_REQUIRED";
    delete view.voucher;
    return view;
  }
}
