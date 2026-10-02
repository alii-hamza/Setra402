export interface LegacyTaskQuoteWire {
  task_id: string | number;
  program_id: string;
  task_state_pda: string;
  vault_pda: string;
  mint: string;
  seller_token_account: string;
  verifier: string;
  amount: string | number;
  timeout_seconds: number;
  is_private: boolean;
  protocol_fee_bps: number;
  service_id: string;
  verification_policy: unknown;
  policy_hash: string;
}

export interface TaskQuote {
  taskId: bigint;
  serviceId: string;
  programId: string;
  taskStatePda: string;
  vaultPda: string;
  mint: string;
  sellerTokenAccount: string;
  verifier: string;
  amount: bigint;
  timeoutSeconds: number;
  isPrivate: boolean;
  protocolFeeBps: number;
  verificationPolicy: VerificationPolicyV1;
  policyHash: string;
  raw: LegacyTaskQuoteWire;
}

export interface LegacyTaskResult {
  input: unknown;
  output_hash: string;
}

export interface ArtifactEvidenceV1 {
  type: "artifact";
  id: string;
  content_hash: string;
  size_bytes: number;
  mime_type?: string;
}

export type Evidence = ArtifactEvidenceV1 | Record<string, unknown>;

export interface ResultEnvelopeWireV1 extends LegacyTaskResult {
  version: "1";
  task_id: string;
  service_id: string;
  result: unknown;
  result_hash: string;
  evidence: Evidence[];
  completed_at_unix: number;
}

export interface ResultEnvelopeV1 extends LegacyTaskResult {
  version: "1";
  taskId: string;
  serviceId: string;
  result: unknown;
  resultHash: string;
  evidence: Evidence[];
  completedAtUnix: number;
}

export interface RequestContext {
  taskId: bigint;
  buyer: string;
  input: unknown;
  isPrivate: boolean;
  serviceId?: string;
}

export interface FundedTaskContext extends RequestContext {}

export interface TaskManifestV1 {
  version: "1";
  taskId: string;
  serviceId: string;
  buyer: string;
  sellerTokenAccount: string;
  sellerOwner: string;
  verifier: string;
  mint: string;
  amountBaseUnits: string;
  timeoutSeconds: number;
  isPrivate: boolean;
  taskSpecHash: string;
  policyHash: string;
  quoteHash: string;
}

export interface JsonSchemaCheckV1 {
  type: "json_schema";
  schema_ref: string;
}

export interface RecordCountCheckV1 {
  type: "record_count";
  pointer: string;
  min?: number;
  max?: number;
  exact?: number;
}

export interface RequiredFieldsCheckV1 {
  type: "required_fields";
  pointer: string;
  fields: string[];
  minimum_valid_ratio_bps?: number;
}

export interface UniqueCheckV1 {
  type: "unique";
  pointer: string;
  field: string;
}

export interface FreshnessCheckV1 {
  type: "freshness";
  timestamp_pointer: string;
  max_age_seconds: number;
  max_future_skew_seconds?: number;
}

export interface ArtifactIntegrityCheckV1 {
  type: "artifact_integrity";
  evidence_id: string;
  max_size_bytes: number;
  expected_sha256?: string;
  allowed_mime_types?: string[];
}

export interface SolanaTransactionCheckV1 {
  type: "solana_state";
  target: "transaction";
  signature: string;
  commitment: "confirmed" | "finalized";
  expected_recipient?: string;
  expected_mint?: string;
  expected_amount_base_units?: string;
}

export interface SolanaAccountCheckV1 {
  type: "solana_state";
  target: "account";
  account: string;
  commitment: "confirmed" | "finalized";
  expected_owner?: string;
}

export interface SourceSamplingCheckV1 {
  type: "source_sampling";
  pointer: string;
  sample_count: number;
  source_url_field: string;
  fields: string[];
  allowed_domains: string[];
  minimum_match_bps: number;
}

export interface TestSuiteCheckV1 {
  type: "test_suite";
  runner_profile: string;
  test_bundle_hash: string;
  timeout_seconds: number;
}

export type VerificationCheckV1 =
  | JsonSchemaCheckV1
  | RecordCountCheckV1
  | RequiredFieldsCheckV1
  | UniqueCheckV1
  | FreshnessCheckV1
  | ArtifactIntegrityCheckV1
  | SolanaTransactionCheckV1
  | SolanaAccountCheckV1
  | SourceSamplingCheckV1
  | TestSuiteCheckV1;

export interface VerificationPolicyV1 {
  version: "1";
  level: 1 | 2;
  checks: readonly VerificationCheckV1[];
}

export interface VerificationCheckResult {
  type: string;
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface VerificationReport {
  taskId: string;
  serviceId: string;
  level: 1 | 2;
  manifestHash: string;
  policyHash: string;
  resultHash: string;
  checks: VerificationCheckResult[];
  passed: boolean;
  verifierPubkey: string;
  startedAtUnix: number;
  completedAtUnix: number;
}

export type TaskStatus = "pending" | "settled" | "refunded";

export interface TaskStateView {
  buyer: string;
  seller: string;
  verifier: string;
  mint: string;
  taskId: bigint;
  amount: bigint;
  deadlineUnix: number;
  status: TaskStatus;
  isPrivate: boolean;
  bump: number;
}
