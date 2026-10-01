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
}

export interface TaskQuote {
  taskId: bigint;
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
  raw: LegacyTaskQuoteWire;
}

export interface LegacyTaskResult {
  input: unknown;
  output_hash: string;
}

export interface ResultEnvelopeV1 {
  version: "1";
  taskId: string;
  serviceId: string;
  result: unknown;
  resultHash: string;
  evidence: unknown[];
  completedAtUnix: number;
}

export interface RequestContext {
  taskId: bigint;
  buyer: string;
  input: unknown;
  isPrivate: boolean;
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
