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
use crate::provider::{ConnectorType, IdempotencySupport, ProviderDefinitionV1};
use crate::provider_connector::{
    provider_execution_identity, ProviderExecutionRequestV1, ProviderObservationV1,
};
use crate::registry::{load_services_for, policy_hash, profile_definition_from, ServiceDefinition};
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

#[derive(Serialize)]
pub struct ProviderHealthSummary {
    pub provider_id: String,
    pub display_name: String,
    pub connector_type: String,
    pub activation_state: String,
    pub health_state: String,
    pub required_secret_status: String,
    pub recovery_capabilities: crate::provider::RecoveryCapabilitiesV1,
    pub can_accept_new_execution: bool,
}

fn provider_can_accept(state: &AppState, provider: &ProviderDefinitionV1) -> bool {
    provider.active
        && crate::secret::required_secrets_available(
            state.secret_resolver.as_ref(),
            &provider.secret_refs,
        )
        && (provider.connector_type == ConnectorType::LocalFixture
            || state
                .provider_connectors
                .get(&provider.execution_profile)
                .is_some())
}

fn provider_summary(state: &AppState, provider: &ProviderDefinitionV1) -> ProviderHealthSummary {
    let secrets_available = crate::secret::required_secrets_available(
        state.secret_resolver.as_ref(),
        &provider.secret_refs,
    );
    let connector_available = provider.connector_type == ConnectorType::LocalFixture
        || state
            .provider_connectors
            .get(&provider.execution_profile)
            .is_some();
    let can_accept_new_execution = provider.active && secrets_available && connector_available;
    ProviderHealthSummary {
        provider_id: provider.provider_id.clone(),
        display_name: provider.display_name.clone(),
        connector_type: provider.connector_type.as_str().into(),
        activation_state: if provider.active {
            if can_accept_new_execution {
                "ACTIVE"
            } else {
                "DEGRADED"
            }
        } else {
            "INACTIVE"
        }
        .into(),
        health_state: if !provider.active {
            "INACTIVE"
        } else if !secrets_available {
            "MISSING_SECRET"
        } else if !connector_available {
            "UNCONFIGURED"
        } else {
            "CONFIGURED"
        }
        .into(),
        required_secret_status: if secrets_available {
            "AVAILABLE"
        } else {
            "MISSING"
        }
        .into(),
        recovery_capabilities: provider.recovery_capabilities.clone(),
        can_accept_new_execution,
    }
}

fn services_for_state(state: &AppState) -> Vec<ServiceDefinition> {
    load_services_for(
        state.registry_overlay.as_deref(),
        state.price,
        state.timeout_seconds,
        &state.provider_catalog,
    )
    .into_iter()
    .filter(|service| {
        profile_definition_from(&state.provider_catalog, &service.provider_connector_ref)
            .is_some_and(|provider| provider_can_accept(state, provider))
    })
    .collect()
}

pub async fn list_services(State(state): State<AppState>) -> Json<Vec<ServiceDefinition>> {
    Json(services_for_state(&state))
}

pub async fn get_service(
    State(state): State<AppState>,
    Path(service_id): Path<String>,
) -> Result<Json<ServiceDefinition>, StatusCode> {
    services_for_state(&state)
        .into_iter()
        .find(|s| s.id == service_id)
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

/// Provider state is operational evidence only. It does not modify, retry, or
/// reinterpret the durable outcome of any historical task.
pub async fn list_provider_health(
    State(state): State<AppState>,
) -> Json<Vec<ProviderHealthSummary>> {
    Json(
        state
            .provider_catalog
            .iter()
            .map(|provider| provider_summary(&state, provider))
            .collect(),
    )
}

pub async fn get_provider_health(
    State(state): State<AppState>,
    Path(provider_id): Path<String>,
) -> Result<Json<ProviderHealthSummary>, StatusCode> {
    let provider = profile_definition_from(&state.provider_catalog, &provider_id)
        .ok_or(StatusCode::NOT_FOUND)?;
    let mut summary = provider_summary(&state, provider);
    if summary.can_accept_new_execution && provider.connector_type != ConnectorType::LocalFixture {
        let connector = state
            .provider_connectors
            .get(&provider.execution_profile)
            .ok_or(StatusCode::CONFLICT)?;
        if state
            .provider_connector_runtime
            .health(connector, provider, state.secret_resolver.as_ref())
            .await
            .is_err()
        {
            summary.activation_state = "DEGRADED".into();
            summary.health_state = "UNAVAILABLE".into();
            summary.can_accept_new_execution = false;
        } else {
            summary.health_state = "HEALTHY".into();
        }
    } else if summary.can_accept_new_execution {
        summary.health_state = "HEALTHY".into();
    }
    Ok(Json(summary))
}

async fn ensure_provider_accepting(
    state: &AppState,
    provider: &ProviderDefinitionV1,
) -> Result<(), ApiError> {
    if !provider_can_accept(state, provider) {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"provider unavailable"})),
        ));
    }
    if provider.connector_type == ConnectorType::LocalFixture {
        return Ok(());
    }
    let connector = state
        .provider_connectors
        .get(&provider.execution_profile)
        .ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error":"provider unavailable"})),
            )
        })?;
    state
        .provider_connector_runtime
        .health(connector, provider, state.secret_resolver.as_ref())
        .await
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error":"provider health unavailable"})),
            )
        })
}

pub async fn handle_task(
    State(state): State<AppState>,
    Path(task_id): Path<u64>,
    headers: HeaderMap,
    Json(req): Json<TaskRequest>,
) -> Result<Json<TaskResult>, ApiError> {
    let registry = services_for_state(&state);
    let service = registry
        .iter()
        .find(|s| s.id == req.service_id)
        .ok_or_else(|| bad_request("unknown service_id"))?;
    let provider =
        profile_definition_from(&state.provider_catalog, &service.provider_connector_ref)
            .ok_or_else(|| internal_error("provider unavailable"))?;
    ensure_provider_accepting(&state, provider).await?;
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
    let saved_path = state
        .execution_store
        .as_ref()
        .map(|dir| dir.join(format!("{key}.json")));
    let mut durable_result = None;
    if let Some(path) = &saved_path {
        match crate::execution_store::load(path) {
            Ok(Some(saved)) => durable_result = Some(saved),
            Ok(None) => {}
            Err(_) => {
                return Err(internal_error(
                    "corrupt result journal; reconciliation required",
                ))
            }
        }
    }
    let in_memory_result = state
        .results
        .lock()
        .map_err(|_| internal_error("result store unavailable"))?
        .get(&key)
        .cloned();
    if let Some(saved) = durable_result.or(in_memory_result) {
        if saved.output_hash != output_hash
            || saved.service_id != service.id
            || saved.task_id != task_id.to_string()
        {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({"error":"task identity reused with different input or service"})),
            ));
        }
        state
            .results
            .lock()
            .map_err(|_| internal_error("result store unavailable"))?
            .insert(key.clone(), saved.clone());
        return Ok(Json(saved));
    }
    let mut claimed_now = state.execution_store.is_none();
    if let Some(dir) = &state.execution_store {
        std::fs::create_dir_all(dir).map_err(|_| internal_error("execution store unavailable"))?;
        let intent_path = dir.join(format!("{key}.intent"));
        match crate::execution_store::claim(&intent_path, &output_hash, &service.id) {
            Ok(()) => claimed_now = true,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing = crate::execution_store::load_intent(&intent_path)
                    .map_err(|_| unknown_external_effect("execution intent is corrupt"))?
                    .ok_or_else(|| unknown_external_effect("execution intent disappeared"))?;
                if existing.input_hash != output_hash || existing.service_id != service.id {
                    return Err((
                        StatusCode::CONFLICT,
                        Json(
                            json!({"error":"task identity reused with different input or service"}),
                        ),
                    ));
                }
            }
            Err(_) => return Err(internal_error("execution intent persistence failed")),
        }
    }
    let completed_at_unix = now;
    let mut evidence = Vec::new();
    let result_value = if provider.connector_type != ConnectorType::LocalFixture {
        let observation = execute_provider(
            &state,
            provider,
            service,
            &req,
            task_id,
            &task_state_addr,
            &output_hash,
            claimed_now,
        )
        .await?;
        evidence.push(crate::provider_store::bounded_evidence(&observation));
        observation
            .result
            .ok_or_else(|| unknown_external_effect("provider result is not complete"))?
    } else if !claimed_now {
        return Err(unknown_external_effect(
            "execution already claimed; fixture outcome remains unresolved",
        ));
    } else if service.provider_connector_ref == "fixture-lead" {
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
        input: req.input.clone(),
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
    state
        .results
        .lock()
        .map_err(|_| internal_error("result store unavailable"))?
        .insert(key, result.clone());

    Ok(Json(result))
}

fn unknown_external_effect(message: &str) -> ApiError {
    (
        StatusCode::CONFLICT,
        Json(json!({
            "error":message,
            "classification":"UNKNOWN_EXTERNAL_EFFECT",
            "reconciliationRequired":true
        })),
    )
}

#[allow(clippy::too_many_arguments)]
async fn execute_provider(
    state: &AppState,
    provider: &ProviderDefinitionV1,
    service: &ServiceDefinition,
    request: &TaskRequest,
    task_id: u64,
    task_state_addr: &Pubkey,
    input_hash: &str,
    claimed_now: bool,
) -> Result<ProviderObservationV1, ApiError> {
    let directory = state
        .execution_store
        .as_ref()
        .ok_or_else(|| internal_error("durable provider execution store unavailable"))?;
    let connector = state
        .provider_connectors
        .get(&provider.execution_profile)
        .ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error":"provider connector unavailable"})),
            )
        })?;
    let execution_identity = provider_execution_identity(
        &task_state_addr.to_string(),
        &service.id,
        input_hash,
        &provider.provider_id,
    )
    .map_err(|_| internal_error("provider execution identity unavailable"))?;
    let provider_request = ProviderExecutionRequestV1 {
        version: "1".into(),
        provider_id: provider.provider_id.clone(),
        execution_identity: execution_identity.clone(),
        task_state_pda: task_state_addr.to_string(),
        task_id: task_id.to_string(),
        service_id: service.id.clone(),
        input_hash: input_hash.to_string(),
        input: request.input.clone(),
    };
    let expected = crate::provider_store::ProviderDispatchIntentV1 {
        version: 1,
        provider_id: provider.provider_id.clone(),
        connector_type: provider.connector_type.as_str().into(),
        execution_profile: provider.execution_profile.clone(),
        execution_identity: execution_identity.clone(),
        task_state_pda: task_state_addr.to_string(),
        task_id: task_id.to_string(),
        service_id: service.id.clone(),
        input_hash: input_hash.to_string(),
        secret_versions: crate::secret::secret_version_bindings(
            state.secret_resolver.as_ref(),
            &provider.secret_refs,
        )
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error":"provider unavailable"})),
            )
        })?,
        state: "UNKNOWN_EXTERNAL_EFFECT".into(),
    };
    let (intent_path, observation_path) =
        crate::provider_store::paths(directory, &task_state_addr.to_string());
    let existing = crate::provider_store::load_intent(&intent_path)
        .map_err(|_| unknown_external_effect("provider dispatch intent is corrupt"))?;
    let provider_claimed_now = existing.is_none();
    let intent = if let Some(existing) = existing {
        if existing != expected {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({"error":"provider dispatch binding or credential version mismatch"})),
            ));
        }
        existing
    } else {
        if !claimed_now {
            return Err(unknown_external_effect(
                "execution was previously claimed without provider evidence",
            ));
        }
        crate::provider_store::claim(&intent_path, &expected)
            .map_err(|_| unknown_external_effect("provider dispatch claim failed"))?;
        expected
    };
    if let Some(observation) =
        crate::provider_store::load_observation(&observation_path, &intent)
            .map_err(|_| unknown_external_effect("provider observation is corrupt"))?
    {
        crate::secret::assert_secret_versions(
            state.secret_resolver.as_ref(),
            &intent.secret_versions,
        )
        .map_err(|_| unknown_external_effect("provider credential version changed"))?;
        return observation_result(observation);
    }
    let observation = if provider_claimed_now {
        state
            .provider_connector_runtime
            .execute(
                connector,
                provider,
                &provider_request,
                state.secret_resolver.as_ref(),
            )
            .await
            .map_err(|_| unknown_external_effect("provider acknowledgement unavailable"))?
    } else if provider.recovery_capabilities.status_query
        && provider.recovery_capabilities.idempotency == IdempotencySupport::Keyed
    {
        state
            .provider_connector_runtime
            .status(
                connector,
                provider,
                &provider_request,
                &execution_identity,
                state.secret_resolver.as_ref(),
            )
            .await
            .map_err(|_| unknown_external_effect("provider status evidence unavailable"))?
    } else {
        return Err(unknown_external_effect(
            "provider has no safe recovery contract",
        ));
    };
    crate::provider_store::complete(&observation_path, &intent, &observation)
        .map_err(|_| unknown_external_effect("provider observation persistence failed"))?;
    observation_result(observation)
}

fn observation_result(
    observation: ProviderObservationV1,
) -> Result<ProviderObservationV1, ApiError> {
    match observation.status.as_str() {
        "SUCCEEDED" if observation.result.is_some() => Ok(observation),
        "PENDING" => Err(unknown_external_effect(
            "provider execution remains pending",
        )),
        "FAILED" => Err((
            StatusCode::BAD_GATEWAY,
            Json(json!({"error":"provider reported a durable failure"})),
        )),
        _ => Err(unknown_external_effect(
            "provider observation is incomplete",
        )),
    }
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
        "connector_type": null,
        "recovery_capabilities": null,
        "profile_binding": "CURRENT_REGISTRY_ONLY",
        "idempotency_key": null,
        "provider_execution_id": null,
        "provider_status": null,
        "receipt_hash": null,
        "response_commitment": null,
        "observed_at_unix": null
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
    let service = load_services_for(
        state.registry_overlay.as_deref(),
        state.price,
        state.timeout_seconds,
        &state.provider_catalog,
    )
    .into_iter()
    .find(|service| service.id == intent.service_id)
    .ok_or(StatusCode::CONFLICT)?;
    let profile = profile_definition_from(&state.provider_catalog, &service.provider_connector_ref)
        .ok_or(StatusCode::CONFLICT)?;
    if !profile.capabilities.contains(&service.capability) {
        return Err(StatusCode::CONFLICT);
    }
    let idempotency_key = provider_execution_identity(
        &pda.to_string(),
        &intent.service_id,
        &intent.input_hash,
        &service.provider_connector_ref,
    )
    .map_err(|_| StatusCode::CONFLICT)?;
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
    response["connector_type"] = json!(profile.connector_type);
    response["recovery_capabilities"] = json!(profile.recovery_capabilities);
    response["idempotency_key"] = json!(idempotency_key);
    let (provider_intent_path, provider_observation_path) =
        crate::provider_store::paths(directory, &pda.to_string());
    if let Some(provider_intent) = crate::provider_store::load_intent(&provider_intent_path)
        .map_err(|_| StatusCode::CONFLICT)?
    {
        if provider_intent.provider_id != service.provider_connector_ref
            || provider_intent.connector_type != profile.connector_type.as_str()
            || provider_intent.execution_profile != profile.execution_profile
            || provider_intent.execution_identity != response["idempotency_key"]
            || provider_intent.task_state_pda != pda.to_string()
            || provider_intent.task_id != task_id.to_string()
            || provider_intent.service_id != intent.service_id
            || provider_intent.input_hash != intent.input_hash
        {
            return Err(StatusCode::CONFLICT);
        }
        if let Some(observation) =
            crate::provider_store::load_observation(&provider_observation_path, &provider_intent)
                .map_err(|_| StatusCode::CONFLICT)?
        {
            response["provider_execution_id"] = json!(observation.execution_id);
            response["provider_status"] = json!(observation.status);
            response["receipt_hash"] = json!(observation.receipt_hash);
            response["response_commitment"] = json!(observation.response_commitment);
            response["observed_at_unix"] = json!(observation.observed_at_unix);
        }
    }
    if let Some(saved) = result {
        if profile.connector_type == ConnectorType::LocalFixture
            && profile.recovery_capabilities.durable_receipt
        {
            response["receipt_hash"] = json!(saved.result_hash);
        }
        if response["response_commitment"].is_null() {
            response["response_commitment"] = json!(saved.result_hash);
            response["observed_at_unix"] = json!(saved.completed_at_unix);
        }
    }
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
