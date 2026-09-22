use crate::rpc::RpcClient;
use serde::{Deserialize, Serialize};
use solana_pubkey::Pubkey;
use std::collections::HashMap;
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
    /// Keyed by `task_id` alone, which is enough for this single-buyer demo.
    /// On-chain uniqueness is really `(buyer, task_id)` — key by that pair
    /// instead if more than one buyer will ever run concurrently against
    /// this server (architecture doc, Section 3.2).
    pub results: Arc<Mutex<HashMap<u64, TaskResult>>>,

    // Phase 3 Extensions
    pub mint_secret_key: Scalar,
    pub mint_public_key: RistrettoPoint,
    pub redis_client: RedisClient,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct TaskResult {
    pub input: serde_json::Value,
    pub output_hash: String,
}

#[derive(Deserialize, Debug)]
pub struct TaskRequest {
    pub buyer: String,
    pub input: serde_json::Value,
    #[serde(default)]
    pub is_private: bool,
}

#[derive(Serialize, Debug)]
pub struct PaymentQuote {
    pub task_id: u64,
    pub program_id: String,
    pub task_state_pda: String,
    pub vault_pda: String,
    pub mint: String,
    pub seller_token_account: String,
    pub verifier: String,
    pub amount: u64,
    pub timeout_seconds: i64,
    pub is_private: bool,
    pub protocol_fee_bps: u64,
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
        let redis_url = std::env::var("REDIS_URL")
            .unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());
        let redis_client = RedisClient::open(redis_url.as_str())
            .map_err(|e| ConfigError::Invalid("REDIS_URL", e.to_string()))?;

        // Phase 3: Generate mint keypair
        let mint_secret_key = Scalar::random(&mut OsRng);
        let mint_public_key = mint_secret_key * RISTRETTO_BASEPOINT_POINT;

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
            mint_secret_key,
            mint_public_key,
            redis_client,
        })
    }
}
