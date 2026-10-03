//! The whole 402 dance lives behind one route: `POST /tasks/:task_id`
//! (architecture doc, Section 3.2). Called once before payment (returns 402
//! + a quote) and once after (returns the task's output). No signatures to
//! verify at this layer — the proof is the on-chain state itself, and this
//! handler checks that directly instead of trusting anything the client
//! claims.

use crate::config::{AppState, PaymentQuote, TaskRequest, TaskResult, PROTOCOL_FEE_BPS};
use crate::execute::hash_canonical;
use crate::mint_store::{self, IssuanceIntent, IssuanceReceipt};
use crate::pda::{task_state_pda, vault_pda};
use crate::registry::{load_services, policy_hash, profile_recovery_capability, ServiceDefinition};
use crate::task_state::{try_from_account_data, TaskStatus};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use solana_pubkey::Pubkey;
use std::str::FromStr;

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

fn payment_required(
    state: &AppState,
    task_id: u64,
    task_state_addr: &Pubkey,
    is_private: bool,
    service: &ServiceDefinition,
) -> ApiError {
    let (vault, _bump) = vault_pda(&state.program_id, task_state_addr);
    let quote = PaymentQuote {
        task_id,
        program_id: state.program_id.to_string(),
        task_state_pda: task_state_addr.to_string(),
        vault_pda: vault.to_string(),
        mint: state.mint.to_string(),
        seller_token_account: state.seller_token_account.to_string(),
        verifier: state.verifier.to_string(),
        amount: service.price_base_units.parse().expect("validated price"),
        timeout_seconds: service.timeout_seconds,
        is_private,
        protocol_fee_bps: PROTOCOL_FEE_BPS,
        service_id: service.id.clone(),
        verification_policy: service.verification_policy.clone(),
        policy_hash: policy_hash(service),
    };
    (
        StatusCode::PAYMENT_REQUIRED,
        Json(serde_json::to_value(quote).expect("PaymentQuote always serializes")),
    )
}

pub async fn list_services(State(state): State<AppState>) -> Json<Vec<ServiceDefinition>> {
    Json(load_services(
        state.registry_overlay.as_deref(),
        state.price,
        state.timeout_seconds,
    ))
}

pub async fn get_service(
    State(state): State<AppState>,
    Path(service_id): Path<String>,
) -> Result<Json<ServiceDefinition>, StatusCode> {
    load_services(
        state.registry_overlay.as_deref(),
        state.price,
        state.timeout_seconds,
    )
    .into_iter()
    .find(|s| s.id == service_id)
    .map(Json)
    .ok_or(StatusCode::NOT_FOUND)
}

pub async fn handle_task(
    State(state): State<AppState>,
    Path(task_id): Path<u64>,
    headers: HeaderMap,
    Json(req): Json<TaskRequest>,
) -> Result<Json<TaskResult>, ApiError> {
    let registry = load_services(
        state.registry_overlay.as_deref(),
        state.price,
        state.timeout_seconds,
    );
    let service = registry
        .iter()
        .find(|s| s.id == req.service_id)
        .ok_or_else(|| bad_request("unknown service_id"))?;
    let transport = headers
        .get("setra-transport")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("rest");
    if !["rest", "mcp"].contains(&transport)
        || (service.exposure != "both" && service.exposure != transport)
    {
        return Err(bad_request("service is not exposed over this transport"));
    }
    if req.is_private && !service.privacy_support {
        return Err(bad_request("service does not support privacy"));
    }
    let buyer =
        Pubkey::from_str(&req.buyer).map_err(|_| bad_request("buyer is not a valid pubkey"))?;

    let (task_state_addr, _bump) = task_state_pda(&state.program_id, &buyer, task_id);

    let account_data = state
        .rpc
        .get_account_data(&task_state_addr)
        .await
        .map_err(|e| internal_error(&format!("RPC error: {e}")))?;

    let task_state = match account_data {
        None => {
            return Err(payment_required(
                &state,
                task_id,
                &task_state_addr,
                req.is_private,
                service,
            ))
        }
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

    if task_state.amount
        < service
            .price_base_units
            .parse::<u64>()
            .expect("validated price")
        || task_state.mint != state.mint
    {
        return Err(payment_required(
            &state,
            task_id,
            &task_state_addr,
            task_state.is_private,
            service,
        ));
    }

    // Mirrors the on-chain refund boundary exactly (`refund_task` succeeds
    // when clock.unix_timestamp >= deadline_unix): a Pending-but-expired task
    // must not be executed, or the buyer could walk away with both the
    // output and a full refund of the escrowed amount.
    let now = state
        .rpc
        .get_chain_unix_time()
        .await
        .map_err(|e| internal_error(&format!("chain clock unavailable: {e}")))?;
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

    let output_hash = hash_canonical(&req.input).map_err(|message| bad_request(message))?;
    let key = task_state_addr.to_string();
    // One lock covers checking, claiming and executing the synchronous fixture.
    // The durable exclusive intent also prevents a second process/restart from
    // repeating an execution whose outcome is unknown.
    let mut results = state
        .results
        .lock()
        .map_err(|_| internal_error("result store unavailable"))?;
    let saved_path = state
        .execution_store
        .as_ref()
        .map(|dir| dir.join(format!("{key}.json")));
    if let Some(path) = &saved_path {
        match crate::execution_store::load(path) {
            Ok(Some(saved)) => {
                results.insert(key.clone(), saved);
            }
            Ok(None) => {}
            Err(_) => {
                return Err(internal_error(
                    "corrupt result journal; reconciliation required",
                ))
            }
        }
    }
    if let Some(saved) = results.get(&key) {
        if saved.output_hash != output_hash
            || saved.service_id != service.id
            || saved.task_id != task_id.to_string()
        {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({"error":"task identity reused with different input or service"})),
            ));
        }
        return Ok(Json(saved.clone()));
    }
    if let Some(dir) = &state.execution_store {
        std::fs::create_dir_all(dir).map_err(|_| internal_error("execution store unavailable"))?;
        crate::execution_store::claim(&dir.join(format!("{key}.intent")), &output_hash, &service.id)
            .map_err(|_| (StatusCode::CONFLICT, Json(json!({"error":"execution already claimed or persistence failed; unresolved outcome requires reconciliation", "classification":"UNKNOWN_EXTERNAL_EFFECT", "reconciliationRequired":true}))))?;
    }
    let completed_at_unix = now;
    let mut evidence = Vec::new();
    let result_value = if service.provider_connector_ref == "fixture-lead" {
        let records: Vec<Value> =
            if req.input.get("fixture").and_then(Value::as_str) == Some("invalid") {
                vec![json!({"name": "Incomplete Lead"})]
            } else {
                (1..=20)
                    .map(|index| {
                        json!({
                            "name": format!("Lead {index}"),
                            "company": format!("Company {index}"),
                            "email": format!("lead{index}@fixture.local")
                        })
                    })
                    .collect()
            };
        json!({
            "records": records,
            "generated_at_unix": completed_at_unix
        })
    } else if service.provider_connector_ref == "fixture-source" {
        json!({"records":(0..3).map(|_|json!({"company":if req.input["fixture"]=="invalid" {"Wrong"}else{"Acme"},"source_url":state.fixture_source_url})).collect::<Vec<_>>()})
    } else if service.provider_connector_ref == "fixture-code" {
        use sha2::{Digest, Sha256};
        let artifact = fixture_artifact(&req.input);
        let hash = hex::encode(Sha256::digest(artifact.as_bytes()));
        evidence.push(json!({"type":"artifact","id":"code-module","content_hash":hash,"size_bytes":artifact.len(),"mime_type":"text/javascript"}));
        json!({"artifact":{"id":"code-module","content_hash":hash,"size_bytes":artifact.len()}})
    } else if service.provider_connector_ref == "fixture-echo" {
        req.input.clone()
    } else {
        return Err(bad_request("unsupported execution profile"));
    };
    let result_hash = hash_canonical(&result_value).map_err(|message| bad_request(message))?;
    let result = TaskResult {
        input: req.input,
        output_hash,
        version: "1".to_string(),
        task_id: task_id.to_string(),
        service_id: service.id.clone(),
        result: result_value,
        result_hash,
        evidence,
        completed_at_unix,
    };
    if let Some(path) = saved_path {
        crate::execution_store::save(&path, &result).map_err(|_| {
            internal_error("cannot persist completed execution; reconciliation required")
        })?;
    }
    results.insert(key, result.clone());

    Ok(Json(result))
}

fn fixture_artifact(input: &Value) -> &'static str {
    if input["fixture"] == "invalid" {
        "export const add = (a,b) => a-b;"
    } else {
        "export const add = (a,b) => a+b;"
    }
}
#[derive(Deserialize)]
pub struct ArtifactQuery {
    pub buyer: String,
}
pub async fn get_artifact(
    State(state): State<AppState>,
    Path((task_id, id)): Path<(u64, String)>,
    Query(query): Query<ArtifactQuery>,
) -> Result<([(&'static str, &'static str); 1], String), StatusCode> {
    if id != "code-module" {
        return Err(StatusCode::NOT_FOUND);
    }
    let buyer = Pubkey::from_str(&query.buyer).map_err(|_| StatusCode::BAD_REQUEST)?;
    let (pda, _) = task_state_pda(&state.program_id, &buyer, task_id);
    let key = pda.to_string();
    let mut result = state
        .results
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .get(&key)
        .cloned();
    if result.is_none() {
        if let Some(dir) = &state.execution_store {
            result = crate::execution_store::load(&dir.join(format!("{key}.json")))
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
    }
    let result = result.ok_or(StatusCode::NOT_FOUND)?;
    if result.result["artifact"]["id"] != "code-module" {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok((
        [("content-type", "text/javascript")],
        fixture_artifact(&result.input).into(),
    ))
}
pub async fn fixture_source() -> Json<Value> {
    Json(json!({"company":"Acme"}))
}

pub async fn get_result(
    State(state): State<AppState>,
    Path(task_id): Path<u64>,
    Query(query): Query<ResultQuery>,
) -> Result<Json<TaskResult>, StatusCode> {
    if let Some(buyer) = query.buyer {
        let buyer = Pubkey::from_str(&buyer).map_err(|_| StatusCode::BAD_REQUEST)?;
        let (pda, _) = task_state_pda(&state.program_id, &buyer, task_id);
        let key = pda.to_string();
        let mut result = state
            .results
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .get(&key)
            .cloned();
        if result.is_none() {
            if let Some(dir) = &state.execution_store {
                result = crate::execution_store::load(&dir.join(format!("{key}.json")))
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            }
        }
        let result = result.ok_or(StatusCode::NOT_FOUND)?;
        if result.task_id != task_id.to_string() {
            return Err(StatusCode::CONFLICT);
        }
        return Ok(Json(result));
    }
    let results = state
        .results
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut matches = results
        .values()
        .filter(|result| result.task_id == task_id.to_string());
    let result = matches.next().cloned().ok_or(StatusCode::NOT_FOUND)?;
    if matches.next().is_some() {
        return Err(StatusCode::CONFLICT);
    }
    Ok(Json(result))
}

/// Durable seller-side evidence only. It never queries or dispatches a provider.
/// An absent local record is not proof that an external effect did not occur.
pub async fn get_execution_evidence(
    State(state): State<AppState>,
    Path(task_id): Path<u64>,
    Query(query): Query<ResultQuery>,
) -> Result<Json<Value>, StatusCode> {
    let buyer_raw = query.buyer.ok_or(StatusCode::BAD_REQUEST)?;
    let buyer = Pubkey::from_str(&buyer_raw).map_err(|_| StatusCode::BAD_REQUEST)?;
    let (pda, _) = task_state_pda(&state.program_id, &buyer, task_id);
    let mut response = json!({
        "version": "1",
        "buyer": buyer.to_string(),
        "task_id": task_id.to_string(),
        "task_state_pda": pda.to_string(),
        "record_state": "STORE_UNAVAILABLE",
        "service_id": null,
        "input_hash": null,
        "result_hash": null,
        "provider_connector_ref": null,
        "recovery_capability": "NONE",
        "profile_binding": "CURRENT_REGISTRY_ONLY",
        "idempotency_key": null,
        "provider_execution_id": null,
        "status_query_supported": false,
        "durable_receipt_supported": false
    });
    let Some(directory) = &state.execution_store else {
        return Ok(Json(response));
    };
    let intent = crate::execution_store::load_intent(&directory.join(format!("{pda}.intent")))
        .map_err(|_| StatusCode::CONFLICT)?;
    let result = crate::execution_store::load(&directory.join(format!("{pda}.json")))
        .map_err(|_| StatusCode::CONFLICT)?;
    if intent.is_none() && result.is_some() {
        return Err(StatusCode::CONFLICT);
    }
    let Some(intent) = intent else {
        response["record_state"] = json!("NO_LOCAL_EVIDENCE");
        return Ok(Json(response));
    };
    if let Some(saved) = &result {
        if saved.task_id != task_id.to_string()
            || saved.service_id != intent.service_id
            || saved.output_hash != intent.input_hash
        {
            return Err(StatusCode::CONFLICT);
        }
    }
    let service = load_services(
        state.registry_overlay.as_deref(),
        state.price,
        state.timeout_seconds,
    )
    .into_iter()
    .find(|service| service.id == intent.service_id)
    .ok_or(StatusCode::CONFLICT)?;
    let capability =
        profile_recovery_capability(&service.provider_connector_ref).ok_or(StatusCode::CONFLICT)?;
    response["record_state"] = json!(if result.is_some() {
        "RESULT_PERSISTED"
    } else {
        "INTENT_ONLY"
    });
    response["service_id"] = json!(intent.service_id);
    response["input_hash"] = json!(intent.input_hash);
    response["result_hash"] = result
        .as_ref()
        .map(|saved| json!(saved.result_hash))
        .unwrap_or(Value::Null);
    response["provider_connector_ref"] = json!(service.provider_connector_ref);
    response["recovery_capability"] = json!(capability);
    Ok(Json(response))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResultQuery {
    pub buyer: Option<String>,
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
    pub mint_pubkey: String,     // 32-byte hex-encoded point K
}

fn mint_paths(
    state: &AppState,
    task_pda: &Pubkey,
) -> Result<(std::path::PathBuf, std::path::PathBuf), ApiError> {
    let execution = state
        .execution_store
        .as_ref()
        .ok_or_else(|| internal_error("Durable mint issuance store unavailable"))?;
    let state_root = execution
        .parent()
        .ok_or_else(|| internal_error("Invalid issuance state root"))?;
    Ok(mint_store::paths(state_root, &task_pda.to_string()))
}

pub async fn get_mint_issuance(
    State(state): State<AppState>,
    Path(task_id): Path<u64>,
    Query(query): Query<ResultQuery>,
) -> Result<Json<Value>, ApiError> {
    let buyer = Pubkey::from_str(query.buyer.as_deref().unwrap_or(""))
        .map_err(|_| bad_request("Valid buyer pubkey required"))?;
    let (pda, _) = task_state_pda(&state.program_id, &buyer, task_id);
    let (intent_path, receipt_path) = mint_paths(&state, &pda)?;
    let (intent, receipt) = mint_store::load(&intent_path, &receipt_path).map_err(|_| {
        (
            StatusCode::CONFLICT,
            Json(json!({"error":"Corrupt or conflicting issuance evidence"})),
        )
    })?;
    if intent
        .as_ref()
        .is_some_and(|i| i.buyer != buyer.to_string() || i.task_id != task_id)
    {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({"error":"Issuance task binding conflict"})),
        ));
    }
    let current_key = hex::encode(state.mint_public_key.compress().to_bytes());
    Ok(Json(json!({
        "version":"1",
        "buyer":buyer.to_string(),
        "task_id":task_id.to_string(),
        "task_state_pda":pda.to_string(),
        "state":if receipt.is_some() {"RESPONSE_PERSISTED"} else if intent.is_some() {"INTENT_ONLY"} else {"NO_LOCAL_EVIDENCE"},
        "blinded_point":intent.as_ref().map(|i| i.blinded_point.as_str()),
        "mint_pubkey":intent.as_ref().map(|i| i.mint_pubkey.as_str()),
        "blind_signature":receipt.as_ref().map(|r| r.blind_signature.as_str()),
        "current_mint_matches_receipt":intent.as_ref().map(|i| i.mint_pubkey == current_key),
    })))
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

    let (intent_path, receipt_path) = mint_paths(&state, &task_state_addr)?;
    let (intent, receipt) = mint_store::load(&intent_path, &receipt_path).map_err(|_| {
        (
            StatusCode::CONFLICT,
            Json(json!({"error":"Corrupt or conflicting issuance evidence"})),
        )
    })?;
    let current_key = hex::encode(state.mint_public_key.compress().to_bytes());
    let requested_point = hex::encode(b_point.compress().to_bytes());
    if let Some(intent) = intent {
        if intent.buyer != buyer.to_string()
            || intent.task_id != req.task_id
            || intent.blinded_point != requested_point
            || intent.mint_pubkey != current_key
        {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({"error":"Existing issuance binding or mint identity differs"})),
            ));
        }
        return match receipt {
            Some(saved) => Ok(Json(BlindSignResponse {
                blind_signature: saved.blind_signature,
                mint_pubkey: saved.mint_pubkey,
            })),
            None => Err((
                StatusCode::CONFLICT,
                Json(
                    json!({"error":"Issuance intent unresolved; read-only reconciliation required"}),
                ),
            )),
        };
    }

    // Verify on-chain escrow state
    let account_data = state
        .rpc
        .get_account_data(&task_state_addr)
        .await
        .map_err(|e| internal_error(&format!("RPC error: {e}")))?;

    let task_state = match account_data {
        None => {
            return Err((
                StatusCode::PAYMENT_REQUIRED,
                Json(json!({"error": "Escrow account not found"})),
            ))
        }
        Some(data) => try_from_account_data(&data)
            .map_err(|e| internal_error(&format!("Corrupt task state: {e}")))?,
    };

    if task_state.status != TaskStatus::Pending {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({"error": "Task is not pending"})),
        ));
    }

    if !task_state.is_private {
        return Err(bad_request(
            "Task was not initialized with is_private = true",
        ));
    }

    // Claim the exact buyer/task/request/key before any signing. A crash after
    // this point without a receipt remains unknown and cannot be reissued.
    let intent = IssuanceIntent {
        version: 1,
        buyer: buyer.to_string(),
        task_id: req.task_id,
        blinded_point: requested_point.clone(),
        mint_pubkey: current_key.clone(),
    };
    match mint_store::claim(&intent_path, &intent) {
        Ok(true) => {}
        Ok(false) => {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({"error":"Issuance already claimed; query evidence"})),
            ))
        }
        Err(_) => return Err(internal_error("Could not persist issuance intent")),
    }
    let c_point: RistrettoPoint = state.mint_secret_key * b_point;
    let signature = hex::encode(c_point.compress().to_bytes());
    let receipt = IssuanceReceipt {
        version: 1,
        buyer: buyer.to_string(),
        task_id: req.task_id,
        blinded_point: requested_point,
        mint_pubkey: current_key.clone(),
        blind_signature: signature.clone(),
    };
    match mint_store::complete(&receipt_path, &receipt) {
        Ok(true) => {}
        _ => return Err(internal_error("Issuance receipt not durably published")),
    }
    Ok(Json(BlindSignResponse {
        blind_signature: signature,
        mint_pubkey: current_key,
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
        return Err(bad_request(
            "Nullifier must be a 32-byte hex string (64 characters)",
        ));
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
