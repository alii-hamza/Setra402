import { createHash } from "node:crypto";
import type {
  ArtifactEvidenceV1,
  ArtifactIntegrityCheckV1,
  Evidence,
  VerificationCheckResult,
} from "../../types.js";
import { fail, pass } from "./common.js";

export interface LoadedArtifact {
  bytes: Uint8Array;
  mimeType?: string;
}

export interface ArtifactContext {
  loadArtifact(id: string): Promise<LoadedArtifact | null>;
}

function artifactEvidence(
  evidence: Evidence[],
  id: string
): ArtifactEvidenceV1 | null {
  const item = evidence.find(
    (entry) => entry.type === "artifact" && entry.id === id
  );
  if (!item || item.type !== "artifact") return null;
  return item as ArtifactEvidenceV1;
}

export async function checkArtifactIntegrity(
  policy: ArtifactIntegrityCheckV1,
  evidence: Evidence[],
  context: ArtifactContext
): Promise<VerificationCheckResult> {
  const claimed = artifactEvidence(evidence, policy.evidence_id);
  if (!claimed) return fail(policy.type, "artifact evidence is missing");
  if (!/^[0-9a-f]{64}$/.test(claimed.content_hash))
    return fail(policy.type, "artifact evidence hash is malformed");
  const artifact = await context.loadArtifact(policy.evidence_id);
  if (!artifact) return fail(policy.type, "artifact does not exist");
  if (artifact.bytes.byteLength > policy.max_size_bytes)
    return fail(policy.type, "artifact exceeds committed size limit");
  if (claimed.size_bytes !== artifact.bytes.byteLength)
    return fail(policy.type, "artifact evidence size does not match content");
  const actualHash = createHash("sha256").update(artifact.bytes).digest("hex");
  if (actualHash !== claimed.content_hash)
    return fail(policy.type, "artifact content hash does not match evidence");
  if (policy.expected_sha256 && actualHash !== policy.expected_sha256)
    return fail(policy.type, "artifact content hash does not match policy");
  if (
    policy.allowed_mime_types &&
    (!artifact.mimeType ||
      !policy.allowed_mime_types.includes(artifact.mimeType))
  )
    return fail(policy.type, "artifact MIME type is not allowed");
  if (claimed.mime_type && claimed.mime_type !== artifact.mimeType)
    return fail(
      policy.type,
      "artifact evidence MIME type does not match content"
    );
  return pass(policy.type, "artifact integrity verified", {
    sizeBytes: artifact.bytes.byteLength,
    sha256: actualHash,
  });
}
