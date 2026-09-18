//! The whole 402 dance lives behind one route: `POST /tasks/:task_id`
//! (architecture doc, Section 3.2). Called once before payment (returns 402
//! + a quote) and once after (returns the task's output). No signatures to
//! verify at this layer — the proof is the on-chain state itself, and this
//! handler checks that directly instead of trusting anything the client
//! claims.

use crate::config::{AppState, PaymentQuote, TaskRequest, TaskResult, PROTOCOL_FEE_BPS};
use crate::execute::execute_task;
use crate::pda::{task_state_pda, vault_pda};
use crate::task_state::{TaskState, TaskStatus};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
use solana_pubkey::Pubkey;
use std::str::FromStr;

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
        Some(data) => TaskState::try_from_account_data(&data)
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
