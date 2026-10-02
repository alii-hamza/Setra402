import { hashCanonical } from "../manifest/hash.js";
import type {
  ResultEnvelopeV1,
  TaskManifestV1,
  VerificationCheckResult,
  VerificationPolicyV1,
  VerificationReport,
} from "../types.js";
import {
  checkArtifactIntegrity,
  type ArtifactContext,
} from "./level1/artifact-integrity.js";
import { fail, pass } from "./level1/common.js";
import { checkFreshness } from "./level1/freshness.js";
import {
  checkJsonSchema,
  type JsonSchemaContext,
} from "./level1/json-schema.js";
import { checkRecordCount } from "./level1/record-count.js";
import { checkRequiredFields } from "./level1/required-fields.js";
import {
  checkSolanaState,
  type SolanaStateReader,
} from "./level1/solana-state.js";
import { checkUnique } from "./level1/unique.js";
import { parseVerificationPolicy } from "./policy.js";
import { parseResultEnvelope, parseTaskManifest } from "./contracts.js";

export interface VerificationContext
  extends JsonSchemaContext,
    ArtifactContext {
  committedManifestHash: string;
  verifierPubkey: string;
  nowUnix: number;
  verifyManifestCommitment(manifestHash: string): Promise<void>;
  solana: SolanaStateReader;
}

function safeHash(value: unknown): string | null {
  try {
    return hashCanonical(value);
  } catch {
    return null;
  }
}

function validEnvelope(
  manifest: TaskManifestV1,
  result: ResultEnvelopeV1
): VerificationCheckResult {
  try {
    parseResultEnvelope(result);
  } catch {
    return fail(
      "result_envelope",
      "result envelope identity or shape is invalid"
    );
  }
  if (
    result.taskId !== manifest.taskId ||
    result.serviceId !== manifest.serviceId
  )
    return fail(
      "result_envelope",
      "result envelope identity or shape is invalid"
    );
  return pass("result_envelope", "result envelope identity is valid");
}

export class VerificationEngine {
  async verify(
    manifest: TaskManifestV1,
    policyInput: VerificationPolicyV1,
    result: ResultEnvelopeV1,
    context: VerificationContext
  ): Promise<VerificationReport> {
    const startedAtUnix = context.nowUnix;
    const checks: VerificationCheckResult[] = [];
    const manifestHash = safeHash(manifest) ?? "";
    const policyHash = safeHash(policyInput) ?? "";
    const resultHash = safeHash(result?.result) ?? "";

    let policy: VerificationPolicyV1 | null = null;
    let manifestValid = false;
    try {
      parseTaskManifest(manifest);
      manifestValid = true;
      checks.push(pass("manifest_schema", "task manifest schema is valid"));
    } catch {
      checks.push(fail("manifest_schema", "task manifest schema is invalid"));
    }
    try {
      policy = parseVerificationPolicy(policyInput);
      checks.push(pass("policy_schema", "verification policy schema is valid"));
    } catch {
      checks.push(
        fail("policy_schema", "verification policy schema is invalid")
      );
    }

    let memoVerified = false;
    if (
      !manifestValid ||
      !manifestHash ||
      manifestHash !== context.committedManifestHash
    ) {
      checks.push(
        fail("manifest_commitment", "manifest hash does not match commitment")
      );
    } else {
      try {
        await context.verifyManifestCommitment(manifestHash);
        memoVerified = true;
        checks.push(
          pass("manifest_commitment", "manifest memo commitment verified")
        );
      } catch {
        checks.push(
          fail("manifest_commitment", "manifest memo commitment is invalid")
        );
      }
    }

    const verifierMatches =
      manifest.verifier === context.verifierPubkey &&
      context.verifierPubkey.length > 0;
    checks.push(
      verifierMatches
        ? pass("verifier_identity", "configured verifier matches manifest")
        : fail(
            "verifier_identity",
            "configured verifier does not match manifest"
          )
    );

    const policyMatches = Boolean(
      policy && policyHash && policyHash === manifest.policyHash
    );
    checks.push(
      policyMatches
        ? pass("policy_hash", "policy hash matches manifest")
        : fail("policy_hash", "policy hash does not match manifest")
    );

    const envelopeCheck = validEnvelope(manifest, result);
    checks.push(envelopeCheck);
    const resultMatches =
      envelopeCheck.passed &&
      /^[0-9a-f]{64}$/.test(result.resultHash) &&
      resultHash === result.resultHash;
    checks.push(
      resultMatches
        ? pass("result_hash", "result hash matches canonical result")
        : fail("result_hash", "result hash does not match canonical result")
    );

    const integrityPassed =
      Boolean(policy) &&
      manifestValid &&
      memoVerified &&
      verifierMatches &&
      policyMatches &&
      envelopeCheck.passed &&
      resultMatches;
    if (integrityPassed && policy) {
      for (const check of policy.checks) {
        switch (check.type) {
          case "json_schema":
            checks.push(await checkJsonSchema(check, result.result, context));
            break;
          case "record_count":
            checks.push(checkRecordCount(check, result.result));
            break;
          case "required_fields":
            checks.push(checkRequiredFields(check, result.result));
            break;
          case "unique":
            checks.push(checkUnique(check, result.result));
            break;
          case "freshness":
            checks.push(checkFreshness(check, result.result, context.nowUnix));
            break;
          case "artifact_integrity":
            checks.push(
              await checkArtifactIntegrity(check, result.evidence, context)
            );
            break;
          case "solana_state":
            checks.push(await checkSolanaState(check, context.solana));
            break;
        }
      }
    }

    return {
      taskId: manifest.taskId,
      serviceId: manifest.serviceId,
      level: 1,
      manifestHash,
      policyHash,
      resultHash,
      checks,
      passed: integrityPassed && checks.every((check) => check.passed),
      verifierPubkey: context.verifierPubkey,
      startedAtUnix,
      completedAtUnix: context.nowUnix,
    };
  }
}
