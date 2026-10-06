export const pretty = (value: unknown): string =>
  JSON.stringify(value, null, 2);

export const verificationLabels: Record<string, string> = {
  manifest_schema: "Manifest schema",
  policy_schema: "Policy schema",
  verifier_identity: "Verifier identity",
  policy_hash: "Policy commitment",
  result_envelope: "Result envelope",
  result_hash: "Result integrity",
  manifest_commitment: "Task commitment",
  policy_commitment: "Policy commitment",
  result_integrity: "Result integrity",
  json_schema: "JSON schema",
  record_count: "Record count",
  required_fields: "Required fields",
  unique: "Uniqueness",
  freshness: "Freshness",
  artifact_integrity: "Artifact integrity",
  solana_state: "Solana state",
  source_sampling: "Independent source samples",
  test_suite: "Trusted test suite",
};

export const chainLabels: Record<string, string> = {
  settled: "Settled",
  awaiting_refund_deadline: "Awaiting refund eligibility",
  refund_available: "Refund available",
  refunded: "Refunded",
  funding_required: "Funding required",
};

export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return pretty(value);
  return String(value);
}
