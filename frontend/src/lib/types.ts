export type Exposure = "both" | "rest" | "mcp";
export type Transport = "REST" | "MCP";
export type TaskAction = "quote" | "fund" | "run" | "refund";

export interface ProviderProfile {
  version: string;
  provider_id: string;
  display_name: string;
  connector_type: string;
  capabilities: string[];
  privacy_support: boolean;
  active: boolean;
  recovery_capabilities: { idempotency: string; execution_id: boolean };
  requires_secret: boolean;
}

export interface RunnerProfile {
  id: string;
  test_bundle_hash: string;
}

export interface AppConfig {
  buyer: string;
  writeEnabled: boolean;
  csrfToken: string;
  providerProfiles: ProviderProfile[];
  runners: RunnerProfile[];
}

export type HealthState =
  | "HEALTHY"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "NOT_CONFIGURED";

export interface OperatorHealth {
  version: "1";
  status: "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
  resources: Record<string, HealthState>;
  diskFreeBytes: number | null;
}

export interface VerificationPolicy {
  version: string;
  level: number;
  checks: Array<Record<string, unknown> & { type: string }>;
}

export interface Service {
  id: string;
  name: string;
  description: string;
  capability: string;
  exposure: Exposure;
  price_base_units: string;
  timeout_seconds: number;
  privacy_support: boolean;
  provider_connector_ref: string;
  verification_policy: VerificationPolicy;
  policy_hash: string;
  provider_type: string;
}

export interface TaskCall {
  task_id: string;
  buyer: string;
  service_id: string;
  is_private: boolean;
  input: unknown;
  transport: Transport;
}

export interface TaskQuote {
  amount?: string | number;
  timeoutSeconds?: number;
  verificationPolicy?: VerificationPolicy;
  [key: string]: unknown;
}

export interface VerificationCheck {
  type: string;
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface VerificationReport {
  taskId: string;
  serviceId: string;
  level: number;
  manifestHash: string;
  policyHash: string;
  resultHash: string;
  verifierPubkey: string;
  passed: boolean;
  checks: VerificationCheck[];
}

export interface TaskOutcome {
  status: string;
  quote?: TaskQuote;
  funded?: {
    record?: { manifestHash?: string };
    initializeSignature?: string;
  };
  result?: { resultHash?: string };
  report?: VerificationReport;
}

export interface TaskStatus {
  chainAction?: string;
  chainState?: { status?: string; deadlineUnix?: number };
  quote?: TaskQuote;
}
