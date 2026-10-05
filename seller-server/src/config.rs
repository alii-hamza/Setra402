use crate::rpc::RpcClient;
use serde::{Deserialize, Serialize};
use solana_pubkey::Pubkey;
use std::collections::HashMap;
use std::collections::HashSet;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

// Phase 3 Cryptographic imports
use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT;
use curve25519_dalek::ristretto::RistrettoPoint;
use curve25519_dalek::scalar::Scalar;
use rand::rngs::OsRng;
use redis::Client as RedisClient;

// Fee constants matching on-chain program
pub const PROTOCOL_FEE_BPS: u64 = 100; // 1%
pub const CANCEL_PENALTY_BPS: u64 = 500; // 5%
pub const BPS_DENOMINATOR: u64 = 10_000;

#[derive(Clone)]
pub struct AppState {
    pub rpc: RpcClient,
    pub program_id: Pubkey,
    pub mint: Pubkey,
    pub seller_token_account: Pubkey,
    pub verifier: Pubkey,
    pub protocol_treasury: Option<Pubkey>,
    pub price: u64,
    pub timeout_seconds: i64,
    /// Keyed by the TaskState PDA, which includes both buyer and task ID.
    pub results: Arc<Mutex<HashMap<String, TaskResult>>>,
    pub execution_store: Option<std::path::PathBuf>,
    pub registry_overlay: Option<std::path::PathBuf>,
    pub fixture_source_url: String,
    pub secret_resolver: Arc<dyn crate::secret::SecretResolver>,

    // Phase 3 Extensions
    pub mint_secret_key: Scalar,
    pub mint_public_key: RistrettoPoint,
    pub redis_client: RedisClient,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct TaskResult {
    pub input: serde_json::Value,
    pub output_hash: String,
    pub version: String,
    pub task_id: String,
    pub service_id: String,
    pub result: serde_json::Value,
    pub result_hash: String,
    pub evidence: Vec<serde_json::Value>,
    pub completed_at_unix: i64,
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct TaskRequest {
    pub buyer: String,
    pub input: serde_json::Value,
    #[serde(default)]
    pub is_private: bool,
    #[serde(default = "default_service_id")]
    pub service_id: String,
}

fn default_service_id() -> String {
    "legacy-rest".to_string()
}

#[derive(Serialize, Debug)]
pub struct PaymentQuote {
    #[serde(serialize_with = "serialize_u64")]
    pub task_id: u64,
    pub program_id: String,
    pub task_state_pda: String,
    pub vault_pda: String,
    pub mint: String,
    pub seller_token_account: String,
    pub verifier: String,
    #[serde(serialize_with = "serialize_u64")]
    pub amount: u64,
    pub timeout_seconds: i64,
    pub is_private: bool,
    pub protocol_fee_bps: u64,
    pub service_id: String,
    pub verification_policy: serde_json::Value,
    pub policy_hash: String,
}

fn serialize_u64<S: serde::Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
    if *value > 9_007_199_254_740_991 {
        serializer.serialize_str(&value.to_string())
    } else {
        serializer.serialize_u64(*value)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("missing required env var {0}")]
    Missing(&'static str),
    #[error("env var {0} is not a valid value: {1}")]
    Invalid(&'static str, String),
}

fn env_var(name: &'static str) -> Result<String, ConfigError> {
    std::env::var(name).map_err(|_| ConfigError::Missing(name))
}

fn env_pubkey(name: &'static str) -> Result<Pubkey, ConfigError> {
    let raw = env_var(name)?;
    Pubkey::from_str(&raw).map_err(|e| ConfigError::Invalid(name, e.to_string()))
}

impl AppState {
    /// Loads configuration from environment variables — see `.env.example`
    /// for the full list and what Role A's deployment step (architecture
    /// doc, Section 3.1) needs to hand this server.
    pub fn from_env() -> Result<Self, ConfigError> {
        let rpc_host = std::env::var("RPC_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let rpc_port: u16 = std::env::var("RPC_PORT")
            .unwrap_or_else(|_| "8899".to_string())
            .parse()
            .map_err(|_| ConfigError::Invalid("RPC_PORT", "not a valid port number".into()))?;
        let price: u64 = std::env::var("TASK_PRICE")
            .unwrap_or_else(|_| "1500000".to_string())
            .parse()
            .map_err(|_| ConfigError::Invalid("TASK_PRICE", "not a valid u64".into()))?;
        let timeout_seconds: i64 = std::env::var("TASK_TIMEOUT_SECONDS")
            .unwrap_or_else(|_| "180".to_string())
            .parse()
            .map_err(|_| ConfigError::Invalid("TASK_TIMEOUT_SECONDS", "not a valid i64".into()))?;

        // Protocol treasury is optional for basic operation
        let protocol_treasury = std::env::var("PROTOCOL_TREASURY")
            .ok()
            .and_then(|raw| Pubkey::from_str(&raw).ok());

        // Phase 3: Redis connection
        let redis_url =
            std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());
        let redis_client = RedisClient::open(redis_url.as_str())
            .map_err(|e| ConfigError::Invalid("REDIS_URL", e.to_string()))?;

        // A deployment that needs cross-restart mint identity pins this secret
        // server-side. The legacy ephemeral fallback remains explicit: an
        // issuance under that key cannot be assumed current after restart.
        let mint_secret_key = match std::env::var("SETRA_MINT_SECRET_HEX") {
            Ok(raw) => {
                let bytes = hex::decode(&raw).map_err(|_| {
                    ConfigError::Invalid(
                        "SETRA_MINT_SECRET_HEX",
                        "expected canonical 32-byte hex scalar".into(),
                    )
                })?;
                let array: [u8; 32] = bytes.try_into().map_err(|_| {
                    ConfigError::Invalid(
                        "SETRA_MINT_SECRET_HEX",
                        "expected canonical 32-byte hex scalar".into(),
                    )
                })?;
                let scalar: Option<Scalar> = Scalar::from_canonical_bytes(array).into();
                let scalar = scalar.ok_or_else(|| {
                    ConfigError::Invalid("SETRA_MINT_SECRET_HEX", "non-canonical scalar".into())
                })?;
                if scalar == Scalar::ZERO {
                    return Err(ConfigError::Invalid(
                        "SETRA_MINT_SECRET_HEX",
                        "zero scalar".into(),
                    ));
                }
                scalar
            }
            Err(std::env::VarError::NotPresent) => Scalar::random(&mut OsRng),
            Err(_) => {
                return Err(ConfigError::Invalid(
                    "SETRA_MINT_SECRET_HEX",
                    "invalid unicode".into(),
                ))
            }
        };
        let mint_public_key = mint_secret_key * RISTRETTO_BASEPOINT_POINT;

        let allowed_secret_refs = crate::provider::provider_definitions()
            .iter()
            .flat_map(|definition| definition.secret_refs.iter().cloned())
            .collect::<HashSet<_>>();
        let secret_file = std::env::var("SETRA_PROVIDER_SECRET_FILE")
            .ok()
            .map(std::path::PathBuf::from);
        let secret_resolver = crate::secret::LocalSecretResolver::from_env_and_file(
            allowed_secret_refs,
            secret_file.as_deref(),
        )
        .map_err(|error| ConfigError::Invalid("SETRA_PROVIDER_SECRET_FILE", error.to_string()))?;

        Ok(AppState {
            rpc: RpcClient::new(rpc_host, rpc_port),
            program_id: env_pubkey("PROGRAM_ID")?,
            mint: env_pubkey("MINT")?,
            seller_token_account: env_pubkey("SELLER_TOKEN_ACCOUNT")?,
            verifier: env_pubkey("VERIFIER")?,
            protocol_treasury,
            price,
            timeout_seconds,
            results: Arc::new(Mutex::new(HashMap::new())),
            execution_store: Some(
                std::env::var("SETRA_EXECUTION_STORE")
                    .unwrap_or_else(|_| ".setra-state/executions".into())
                    .into(),
            ),
            registry_overlay: Some(
                std::env::var("SETRA_SERVICE_OVERLAY")
                    .unwrap_or_else(|_| {
                        concat!(env!("CARGO_MANIFEST_DIR"), "/config/services.local.json").into()
                    })
                    .into(),
            ),
            fixture_source_url: std::env::var("SETRA_FIXTURE_SOURCE_URL")
                .unwrap_or_else(|_| "https://example.com/setra-source".into()),
            secret_resolver: Arc::new(secret_resolver),
            mint_secret_key,
            mint_public_key,
            redis_client,
        })
    }
}
