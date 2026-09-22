//! The whole 402 dance lives behind one route: `POST /tasks/:task_id`
//! (architecture doc, Section 3.2). Called once before payment (returns 402
//! + a quote) and once after (returns the task's output). No signatures to
//! verify at this layer — the proof is the on-chain state itself, and this
//! handler checks that directly instead of trusting anything the client
//! claims.

use crate::config::{AppState, PaymentQuote, TaskRequest, TaskResult, PROTOCOL_FEE_BPS};
use crate::execute::execute_task;
use crate::pda::{task_state_pda, vault_pda};
use crate::task_state::{TaskStatus, try_from_account_data};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use solana_pubkey::Pubkey;
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

// Phase 3 Cryptographic imports
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};

type ApiError = (StatusCode, Json<Value>);

fn bad_request(msg: &str) -> ApiError {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg })))
}

fn internal_error(msg: &str) -> ApiError {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": msg })),
    )
}

fn payment_required(state: &AppState, task_id: u64, task_state_addr: &Pubkey, is_private: bool) -> ApiError {
    let (vault, _bump) = vault_pda(&state.program_id, task_state_addr);
    let quote = PaymentQuote {
        task_id,
        program_id: state.program_id.to_string(),
        task_state_pda: task_state_addr.to_string(),
        vault_pda: vault.to_string(),
        mint: state.mint.to_string(),
        seller_token_account: state.seller_token_account.to_string(),
        verifier: state.verifier.to_string(),
        amount: state.price,
        timeout_seconds: state.timeout_seconds,
        is_private,
        protocol_fee_bps: PROTOCOL_FEE_BPS,
    };
    (
        StatusCode::PAYMENT_REQUIRED,
        Json(serde_json::to_value(quote).expect("PaymentQuote always serializes")),
    )
}

pub async fn handle_task(
    State(state): State<AppState>,
    Path(task_id): Path<u64>,
    Json(req): Json<TaskRequest>,
) -> Result<Json<TaskResult>, ApiError> {
    let buyer =
        Pubkey::from_str(&req.buyer).map_err(|_| bad_request("buyer is not a valid pubkey"))?;

    let (task_state_addr, _bump) = task_state_pda(&state.program_id, &buyer, task_id);

    let account_data = state
        .rpc
        .get_account_data(&task_state_addr)
        .await
        .map_err(|e| internal_error(&format!("RPC error: {e}")))?;

    let task_state = match account_data {
        None => return Err(payment_required(&state, task_id, &task_state_addr, req.is_private)),
        Some(data) => try_from_account_data(&data)
            .map_err(|e| internal_error(&format!("corrupt task account: {e}")))?,
    };

    // Validate that requested privacy matches on-chain state
    if req.is_private != task_state.is_private {
        return Err(bad_request(&format!(
            "privacy mismatch: request is_private={}, on-chain is_private={}",
            req.is_private, task_state.is_private
        )));
    }

    if task_state.status != TaskStatus::Pending {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({
                "error": "task already settled or refunded",
                "status": format!("{:?}", task_state.status),
            })),
        ));
    }

    if task_state.amount < state.price || task_state.mint != state.mint {
        return Err(payment_required(&state, task_id, &task_state_addr, task_state.is_private));
    }

    // Mirrors the on-chain refund boundary exactly (`refund_task` succeeds
    // when clock.unix_timestamp >= deadline_unix): a Pending-but-expired task
    // must not be executed, or the buyer could walk away with both the
    // output and a full refund of the escrowed amount.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before 1970")
        .as_secs() as i64;
    if now >= task_state.deadline_unix {
        return Err((
            StatusCode::GONE,
            Json(json!({
                "error": "task deadline has passed; on-chain refund is available",
                "deadline_unix": task_state.deadline_unix,
                "now": now,
            })),
        ));
    }

    let output_hash = execute_task(&req.input);
    let result = TaskResult {
        input: req.input,
        output_hash,
    };
    state
        .results
        .lock()
        .expect("results mutex should not be poisoned")
        .insert(task_id, result.clone());

    Ok(Json(result))
}

pub async fn get_result(
    State(state): State<AppState>,
    Path(task_id): Path<u64>,
) -> Result<Json<TaskResult>, StatusCode> {
    state
        .results
        .lock()
        .expect("results mutex should not be poisoned")
        .get(&task_id)
        .cloned()
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

// Phase 3: Blind signature endpoint
#[derive(Deserialize, Debug)]
pub struct BlindSignRequest {
    pub buyer: String,
    pub task_id: u64,
    pub blinded_point: String, // 32-byte hex-encoded point B
}

#[derive(Serialize, Debug)]
pub struct BlindSignResponse {
    pub blind_signature: String, // 32-byte hex-encoded point C
    pub mint_pubkey: String,      // 32-byte hex-encoded point K
}

pub async fn handle_blind_sign(
    State(state): State<AppState>,
    Json(req): Json<BlindSignRequest>,
) -> Result<Json<BlindSignResponse>, ApiError> {
    let buyer = Pubkey::from_str(&req.buyer).map_err(|_| bad_request("Invalid buyer pubkey"))?;

    // Validate input format before making RPC calls
    let point_bytes = hex::decode(&req.blinded_point)
        .map_err(|_| bad_request("Invalid hex encoding for blinded_point"))?;
    let compressed = CompressedRistretto::from_slice(&point_bytes)
        .map_err(|_| bad_request("Invalid slice length for Ristretto point"))?;
    let b_point: RistrettoPoint = compressed
        .decompress()
        .ok_or_else(|| bad_request("Curve point decompression failed: not on Ristretto255"))?;

    let (task_state_addr, _bump) = task_state_pda(&state.program_id, &buyer, req.task_id);

    // Verify on-chain escrow state
    let account_data = state
        .rpc
        .get_account_data(&task_state_addr)
        .await
        .map_err(|e| internal_error(&format!("RPC error: {e}")))?;

    let task_state = match account_data {
        None => return Err((StatusCode::PAYMENT_REQUIRED, Json(json!({"error": "Escrow account not found"})))),
        Some(data) => try_from_account_data(&data)
            .map_err(|e| internal_error(&format!("Corrupt task state: {e}")))?,
    };

    if task_state.status != TaskStatus::Pending {
        return Err((StatusCode::CONFLICT, Json(json!({"error": "Task is not pending"}))));
    }

    if !task_state.is_private {
        return Err(bad_request("Task was not initialized with is_private = true"));
    }

    // Compute blind signature: C = k * B
    let c_point: RistrettoPoint = state.mint_secret_key * b_point;

    Ok(Json(BlindSignResponse {
        blind_signature: hex::encode(c_point.compress().to_bytes()),
        mint_pubkey: hex::encode(state.mint_public_key.compress().to_bytes()),
    }))
}

// Phase 3: Nullifier endpoint
#[derive(Deserialize, Debug)]
pub struct NullifyRequest {
    pub nullifier: String, // 32-byte hex-encoded nullifier hash eta
}

pub async fn handle_nullify(
    State(state): State<AppState>,
    Json(req): Json<NullifyRequest>,
) -> Result<Json<Value>, ApiError> {
    if req.nullifier.len() != 64 {
        return Err(bad_request("Nullifier must be a 32-byte hex string (64 characters)"));
    }

    let mut conn = state
        .redis_client
        .get_multiplexed_tokio_connection()
        .await
        .map_err(|e| internal_error(&format!("Redis connection failed: {e}")))?;

    let key = format!("nullifier:{}", req.nullifier);

    // Atomic SETNX check
    let was_set: bool = redis::cmd("SET")
        .arg(&key)
        .arg("spent")
        .arg("NX")
        .query_async(&mut conn)
        .await
        .unwrap_or(false);

    if !was_set {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "Double-spend detected: nullifier already spent",
                "nullifier": req.nullifier
            })),
        ));
    }

    Ok(Json(json!({
        "status": "Nullifier accepted",
        "nullifier": req.nullifier
    })))
}
