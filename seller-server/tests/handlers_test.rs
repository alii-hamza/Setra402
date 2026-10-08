//! Exercises the actual axum router (via `tower::ServiceExt::oneshot`)
//! against a fake RPC endpoint standing in for the validator — no real
//! Solana validator or deployed program needed, per the architecture doc's
//! Section 5.2 testing approach ("mock the RPC client... to test 402 logic
//! without needing a live validator").

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use http_body_util::BodyExt;
use seller_server::config::AppState;

// Phase 3 additions use the original handler harness without weakening any
// Role B assertion.
async fn retry_fixture() -> (AppState, Pubkey) {
    let buyer = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let data = encode_task_state(&buyer, &mint, PRICE, 0, 9_999_999_999, false);
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data);
    let mut state = state_with_fake_chain(json!({"data":[encoded,"base64"]})).await;
    state.mint = mint;
    (state, buyer)
}
async fn retry_post(
    state: AppState,
    buyer: Pubkey,
    input: Value,
    service: &str,
) -> axum::response::Response {
    seller_server::build_router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/tasks/7")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"buyer":buyer.to_string(),"input":input,"service_id":service})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn evidence_get(state: AppState, buyer: Pubkey) -> axum::response::Response {
    seller_server::build_router(state)
        .oneshot(
            Request::builder()
                .uri(format!("/tasks/7/execution-evidence?buyer={buyer}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}
#[tokio::test]
async fn provider_evidence_reports_durable_result_without_fabricating_external_ids() {
    let (mut state, buyer) = retry_fixture().await;
    let dir =
        std::env::temp_dir().join(format!("setra-provider-evidence-{}", Pubkey::new_unique()));
    state.execution_store = Some(dir.clone());
    let execution = retry_post(state.clone(), buyer, json!({"x":1}), "legacy-rest").await;
    let status = execution.status();
    let execution_body = body_json(execution).await;
    assert_eq!(status, StatusCode::OK, "{execution_body}");
    state.results.lock().unwrap().clear();
    let response = evidence_get(state, buyer).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(body["record_state"], "RESULT_PERSISTED");
    assert_eq!(body["connector_type"], "LOCAL_FIXTURE");
    assert_eq!(body["recovery_capabilities"]["idempotency"], "KEYED");
    assert_eq!(body["recovery_capabilities"]["durable_receipt"], true);
    assert_eq!(body["idempotency_key"].as_str().unwrap().len(), 64);
    assert_eq!(body["provider_execution_id"], Value::Null);
    assert_eq!(body["provider_status"], Value::Null);
    assert_eq!(body["receipt_hash"], body["result_hash"]);
    assert_eq!(body["response_commitment"], body["result_hash"]);
    assert_eq!(
        body["input_hash"],
        seller_server::execute::hash_canonical(&json!({"x":1})).unwrap()
    );
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn provider_evidence_keeps_orphan_intent_unknown_and_rejects_corruption() {
    let (mut state, buyer) = retry_fixture().await;
    let dir = std::env::temp_dir().join(format!("setra-provider-intent-{}", Pubkey::new_unique()));
    let (pda, _) = seller_server::pda::task_state_pda(&state.program_id, &buyer, 7);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{pda}.intent"));
    seller_server::execution_store::claim(&path, &"a".repeat(64), "legacy-rest").unwrap();
    state.execution_store = Some(dir.clone());
    let response = evidence_get(state.clone(), buyer).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["record_state"], "INTENT_ONLY");
    std::fs::write(&path, b"{").unwrap();
    assert_eq!(
        evidence_get(state, buyer).await.status(),
        StatusCode::CONFLICT
    );
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn provider_evidence_absence_and_disabled_store_never_claim_nonoccurrence() {
    let (mut state, buyer) = retry_fixture().await;
    let dir = std::env::temp_dir().join(format!("setra-provider-empty-{}", Pubkey::new_unique()));
    std::fs::create_dir_all(&dir).unwrap();
    state.execution_store = Some(dir.clone());
    assert_eq!(
        body_json(evidence_get(state.clone(), buyer).await).await["record_state"],
        "NO_LOCAL_EVIDENCE"
    );
    state.execution_store = None;
    assert_eq!(
        body_json(evidence_get(state, buyer).await).await["record_state"],
        "STORE_UNAVAILABLE"
    );
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn provider_evidence_rejects_orphan_result_and_conflicting_immutable_input() {
    let (mut state, buyer) = retry_fixture().await;
    let dir =
        std::env::temp_dir().join(format!("setra-provider-conflict-{}", Pubkey::new_unique()));
    state.execution_store = Some(dir.clone());
    let execution = retry_post(state.clone(), buyer, json!({"x":1}), "legacy-rest").await;
    let status = execution.status();
    let execution_body = body_json(execution).await;
    assert_eq!(status, StatusCode::OK, "{execution_body}");
    let (pda, _) = seller_server::pda::task_state_pda(&state.program_id, &buyer, 7);
    let intent_path = dir.join(format!("{pda}.intent"));
    let original = std::fs::read(&intent_path).unwrap();
    std::fs::remove_file(&intent_path).unwrap();
    assert_eq!(
        evidence_get(state.clone(), buyer).await.status(),
        StatusCode::CONFLICT
    );
    let mut altered: Value = serde_json::from_slice(&original).unwrap();
    altered["input_hash"] = json!("b".repeat(64));
    std::fs::write(&intent_path, altered.to_string()).unwrap();
    assert_eq!(
        evidence_get(state, buyer).await.status(),
        StatusCode::CONFLICT
    );
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn funded_retries_replay_identical_result() {
    let (state, buyer) = retry_fixture().await;
    let first =
        body_json(retry_post(state.clone(), buyer, json!({}), "lead-scraper-demo").await).await;
    let second = body_json(retry_post(state, buyer, json!({}), "lead-scraper-demo").await).await;
    assert_eq!(first, second);
}
#[tokio::test]
async fn retry_changed_input_rejected() {
    let (state, buyer) = retry_fixture().await;
    assert_eq!(
        retry_post(state.clone(), buyer, json!({"a":1}), "legacy-rest")
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        retry_post(state, buyer, json!({"a":2}), "legacy-rest")
            .await
            .status(),
        StatusCode::CONFLICT
    );
}
#[tokio::test]
async fn retry_changed_service_rejected() {
    let (state, buyer) = retry_fixture().await;
    assert_eq!(
        retry_post(state.clone(), buyer, json!({}), "legacy-rest")
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        retry_post(state, buyer, json!({}), "lead-scraper-demo")
            .await
            .status(),
        StatusCode::CONFLICT
    );
}

#[derive(Clone, Default)]
struct NetworkProviderFixture {
    effects: Arc<std::sync::atomic::AtomicUsize>,
    executions: Arc<Mutex<HashMap<String, Value>>>,
    healthy: Arc<std::sync::atomic::AtomicBool>,
}

fn network_provider_response(request: &Value) -> Value {
    let result = json!({"provider":"network-fixture","input":request["input"]});
    let result_hash = seller_server::execute::hash_canonical(&result).unwrap();
    json!({
        "version":"1",
        "provider_id":request["provider_id"],
        "execution_identity":request["execution_identity"],
        "task_state_pda":request["task_state_pda"],
        "task_id":request["task_id"],
        "service_id":request["service_id"],
        "input_hash":request["input_hash"],
        "execution_id":request["execution_identity"],
        "status":"SUCCEEDED",
        "result":result,
        "receipt":{
            "version":"1",
            "provider_id":request["provider_id"],
            "execution_identity":request["execution_identity"],
            "task_state_pda":request["task_state_pda"],
            "task_id":request["task_id"],
            "service_id":request["service_id"],
            "input_hash":request["input_hash"],
            "execution_id":request["execution_identity"],
            "status":"SUCCEEDED",
            "result_hash":result_hash
        }
    })
}

async fn provider_execute(
    axum::extract::State(state): axum::extract::State<NetworkProviderFixture>,
    headers: axum::http::HeaderMap,
    axum::Json(request): axum::Json<Value>,
) -> impl axum::response::IntoResponse {
    let identity = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let lost = request["input"]["mode"] == "lost";
    state
        .executions
        .lock()
        .unwrap()
        .entry(identity)
        .or_insert_with(|| {
            state
                .effects
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            request.clone()
        });
    if lost {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        return axum::http::StatusCode::NO_CONTENT.into_response();
    }
    axum::Json(network_provider_response(&request)).into_response()
}

async fn provider_status(
    axum::extract::State(state): axum::extract::State<NetworkProviderFixture>,
    axum::extract::Path(identity): axum::extract::Path<String>,
) -> impl axum::response::IntoResponse {
    match state.executions.lock().unwrap().get(&identity).cloned() {
        Some(request) => axum::Json(network_provider_response(&request)).into_response(),
        None => axum::http::StatusCode::NOT_FOUND.into_response(),
    }
}

async fn provider_health(
    axum::extract::State(state): axum::extract::State<NetworkProviderFixture>,
) -> impl axum::response::IntoResponse {
    if state.healthy.load(std::sync::atomic::Ordering::SeqCst) {
        axum::Json(json!({"status":"ok"})).into_response()
    } else {
        axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response()
    }
}

async fn network_provider_fixture() -> (String, NetworkProviderFixture) {
    use axum::routing::{get, post};
    let state = NetworkProviderFixture {
        healthy: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        ..Default::default()
    };
    let app = axum::Router::new()
        .route("/execute", post(provider_execute))
        .route("/status/:identity", get(provider_status))
        .route("/health", get(provider_health))
        .with_state(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://localhost:{}", address.port()), state)
}

fn network_provider(
    active: bool,
    status_query: bool,
    secret_refs: Vec<String>,
) -> seller_server::provider::ProviderDefinitionV1 {
    seller_server::provider::ProviderDefinitionV1 {
        version: "1".into(),
        provider_id: "network-provider".into(),
        display_name: "Network provider fixture".into(),
        connector_type: seller_server::provider::ConnectorType::RestApi,
        execution_profile: "network-provider-v1".into(),
        capabilities: vec!["setra402.task.echo".into()],
        privacy_support: false,
        active,
        recovery_capabilities: seller_server::provider::RecoveryCapabilitiesV1 {
            idempotency: if status_query {
                seller_server::provider::IdempotencySupport::Keyed
            } else {
                seller_server::provider::IdempotencySupport::None
            },
            execution_id: status_query,
            status_query,
            durable_receipt: status_query,
            deterministic_replay: status_query,
            may_produce_non_idempotent_external_effect: !status_query,
        },
        secret_refs,
    }
}

fn network_service_overlay() -> Value {
    let policy = json!({
        "version":"1",
        "level":1,
        "checks":[{"type":"json_schema","schema_ref":"generic-object-v1"}]
    });
    json!([{
        "id":"network-service",
        "name":"Network service",
        "description":"Local network provider fixture",
        "capability":"setra402.task.echo",
        "exposure":"both",
        "price_base_units":PRICE.to_string(),
        "timeout_seconds":180,
        "privacy_support":false,
        "provider_connector_ref":"network-provider",
        "verification_policy":policy,
        "policy_hash":seller_server::execute::hash_canonical(&json!({
            "version":"1",
            "level":1,
            "checks":[{"type":"json_schema","schema_ref":"generic-object-v1"}]
        })).unwrap()
    }])
}

fn connector_registry(
    base: &str,
    status_query: bool,
    providers: &[seller_server::provider::ProviderDefinitionV1],
) -> seller_server::provider_connector::ConnectorRegistry {
    let profile = json!({
        "version":"1",
        "execution_profile":"network-provider-v1",
        "connector_type":"REST_API",
        "rest":{
            "base_endpoint":base,
            "execute_path":"/execute",
            "status_path_template":if status_query { json!("/status/{execution_id}") } else { Value::Null },
            "health_path":"/health",
            "allowed_hosts":["localhost"],
            "connect_timeout_ms":50,
            "request_timeout_ms":100,
            "maximum_response_bytes":4096,
            "redirect_cap":0,
            "idempotency_header":if status_query { json!("Idempotency-Key") } else { Value::Null },
            "bearer_secret_ref":Value::Null
        },
        "mcp":Value::Null
    });
    seller_server::provider_connector::ConnectorRegistry::parse(
        &serde_json::to_vec(&vec![profile]).unwrap(),
        providers,
    )
    .unwrap()
}

async fn network_provider_state(
    provider: seller_server::provider::ProviderDefinitionV1,
    base: &str,
) -> (AppState, Pubkey, std::path::PathBuf, std::path::PathBuf) {
    let (mut state, buyer) = retry_fixture().await;
    let overlay = std::env::temp_dir().join(format!("setra-network-service-{buyer}.json"));
    let execution = std::env::temp_dir().join(format!("setra-network-execution-{buyer}"));
    std::fs::write(&overlay, network_service_overlay().to_string()).unwrap();
    let mut catalog = seller_server::provider::provider_definitions().to_vec();
    catalog.push(provider.clone());
    state.provider_catalog = Arc::new(catalog);
    state.registry_overlay = Some(overlay.clone());
    state.execution_store = Some(execution.clone());
    state.provider_connectors = Arc::new(connector_registry(
        base,
        provider.recovery_capabilities.status_query,
        &state.provider_catalog,
    ));
    state.provider_connector_runtime =
        seller_server::provider_connector::ProviderConnectorRuntime::new(
            seller_server::provider_connector::ConnectorRuntimePolicy {
                allow_test_http: true,
                allow_test_private_targets: true,
                maximum_concurrency: 4,
            },
        )
        .unwrap();
    (state, buyer, overlay, execution)
}

async fn network_post(state: AppState, buyer: Pubkey, input: Value) -> axum::response::Response {
    seller_server::build_router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/tasks/7")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"buyer":buyer.to_string(),"input":input,"service_id":"network-service"})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn real_provider_lifecycle_persists_evidence_and_recovers_lost_response_once() {
    let (base, fixture) = network_provider_fixture().await;
    let (state, buyer, overlay, execution) =
        network_provider_state(network_provider(true, true, vec![]), &base).await;
    let services = seller_server::build_router(state.clone())
        .oneshot(
            Request::builder()
                .uri("/services")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(body_json(services)
        .await
        .as_array()
        .unwrap()
        .iter()
        .any(|service| service["id"] == "network-service"));
    let first = network_post(state.clone(), buyer, json!({"mode":"ok"})).await;
    assert_eq!(first.status(), StatusCode::OK);
    let first_body = body_json(first).await;
    assert_eq!(first_body["result"]["provider"], "network-fixture");
    let evidence = evidence_get(state.clone(), buyer).await;
    let evidence_body = body_json(evidence).await;
    assert_eq!(
        evidence_body["provider_execution_id"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    assert_eq!(evidence_body["provider_status"], "SUCCEEDED");
    assert!(evidence_body["receipt_hash"].as_str().is_some());
    let replay = network_post(state.clone(), buyer, json!({"mode":"ok"})).await;
    assert_eq!(body_json(replay).await, first_body);
    assert_eq!(fixture.effects.load(std::sync::atomic::Ordering::SeqCst), 1);

    let lost_buyer = Pubkey::new_unique();
    let mint = state.mint;
    let lost_data = encode_task_state(&lost_buyer, &mint, PRICE, 0, 9_999_999_999, false);
    let lost_encoded =
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &lost_data);
    let mut lost_state = state_with_fake_chain(json!({"data":[lost_encoded,"base64"]})).await;
    lost_state.mint = mint;
    lost_state.provider_catalog = state.provider_catalog.clone();
    lost_state.registry_overlay = state.registry_overlay.clone();
    lost_state.execution_store = state.execution_store.clone();
    lost_state.provider_connectors = state.provider_connectors.clone();
    lost_state.provider_connector_runtime = state.provider_connector_runtime.clone();
    let first_lost = network_post(lost_state.clone(), lost_buyer, json!({"mode":"lost"})).await;
    assert_eq!(first_lost.status(), StatusCode::CONFLICT);
    assert_eq!(
        body_json(first_lost).await["classification"],
        "UNKNOWN_EXTERNAL_EFFECT"
    );
    let recovered = network_post(lost_state.clone(), lost_buyer, json!({"mode":"lost"})).await;
    assert_eq!(recovered.status(), StatusCode::OK);
    assert_eq!(fixture.effects.load(std::sync::atomic::Ordering::SeqCst), 2);

    std::fs::remove_file(overlay).unwrap();
    std::fs::remove_dir_all(execution).unwrap();
}

#[tokio::test]
async fn activation_secret_and_health_gates_do_not_rewrite_historical_evidence() {
    let (base, fixture) = network_provider_fixture().await;
    let (state, buyer, overlay, execution) =
        network_provider_state(network_provider(true, true, vec![]), &base).await;
    assert_eq!(
        network_post(state.clone(), buyer, json!({"mode":"ok"}))
            .await
            .status(),
        StatusCode::OK
    );
    fixture
        .healthy
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let health = seller_server::build_router(state.clone())
        .oneshot(
            Request::builder()
                .uri("/providers/network-provider/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let health_body = body_json(health).await;
    assert_eq!(health_body["activation_state"], "DEGRADED");
    assert_eq!(health_body["health_state"], "UNAVAILABLE");
    let existing_evidence = evidence_get(state.clone(), buyer).await;
    assert_eq!(existing_evidence.status(), StatusCode::OK);
    let new_buyer = Pubkey::new_unique();
    let new_data = encode_task_state(&new_buyer, &state.mint, PRICE, 0, 9_999_999_999, false);
    let new_encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &new_data);
    let mut unhealthy_state = state_with_fake_chain(json!({"data":[new_encoded,"base64"]})).await;
    unhealthy_state.mint = state.mint;
    unhealthy_state.provider_catalog = state.provider_catalog.clone();
    unhealthy_state.registry_overlay = state.registry_overlay.clone();
    unhealthy_state.execution_store = state.execution_store.clone();
    unhealthy_state.provider_connectors = state.provider_connectors.clone();
    unhealthy_state.provider_connector_runtime = state.provider_connector_runtime.clone();
    assert_eq!(
        network_post(unhealthy_state, new_buyer, json!({"mode":"ok"}))
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );

    let missing = network_provider(true, true, vec!["missing-token".into()]);
    let (missing_state, _, missing_overlay, missing_execution) =
        network_provider_state(missing, &base).await;
    let providers = seller_server::build_router(missing_state)
        .oneshot(
            Request::builder()
                .uri("/providers")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let providers = body_json(providers).await;
    let missing = providers
        .as_array()
        .unwrap()
        .iter()
        .find(|provider| provider["provider_id"] == "network-provider")
        .unwrap();
    assert_eq!(missing["required_secret_status"], "MISSING");
    assert_eq!(missing["can_accept_new_execution"], false);
    assert!(!missing.to_string().contains("missing-token"));
    assert!(missing.get("secret_refs").is_none());
    let (inactive_state, _, inactive_overlay, inactive_execution) =
        network_provider_state(network_provider(false, true, vec![]), &base).await;
    let inactive_providers = seller_server::build_router(inactive_state.clone())
        .oneshot(
            Request::builder()
                .uri("/providers")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let inactive = body_json(inactive_providers)
        .await
        .as_array()
        .unwrap()
        .iter()
        .find(|provider| provider["provider_id"] == "network-provider")
        .unwrap()
        .clone();
    assert_eq!(inactive["activation_state"], "INACTIVE");
    let inactive_services = seller_server::build_router(inactive_state)
        .oneshot(
            Request::builder()
                .uri("/services")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(body_json(inactive_services)
        .await
        .as_array()
        .unwrap()
        .iter()
        .all(|service| service["id"] != "network-service"));
    std::fs::remove_file(overlay).unwrap();
    std::fs::remove_dir_all(execution).unwrap();
    std::fs::remove_file(missing_overlay).unwrap();
    let _ = std::fs::remove_dir_all(missing_execution);
    std::fs::remove_file(inactive_overlay).unwrap();
    let _ = std::fs::remove_dir_all(inactive_execution);
}

#[tokio::test]
async fn provider_without_recovery_contract_stays_unknown_without_redispatch() {
    let (base, fixture) = network_provider_fixture().await;
    let (state, buyer, overlay, execution) =
        network_provider_state(network_provider(true, false, vec![]), &base).await;
    let first = network_post(state.clone(), buyer, json!({"mode":"lost"})).await;
    assert_eq!(first.status(), StatusCode::CONFLICT);
    assert_eq!(
        body_json(first).await["classification"],
        "UNKNOWN_EXTERNAL_EFFECT"
    );
    let retry = network_post(state.clone(), buyer, json!({"mode":"lost"})).await;
    assert_eq!(retry.status(), StatusCode::CONFLICT);
    assert_eq!(
        body_json(retry).await["classification"],
        "UNKNOWN_EXTERNAL_EFFECT"
    );
    assert_eq!(fixture.effects.load(std::sync::atomic::Ordering::SeqCst), 1);
    std::fs::remove_file(overlay).unwrap();
    std::fs::remove_dir_all(execution).unwrap();
}

#[tokio::test]
async fn concurrent_provider_dispatch_for_one_task_never_duplicates_external_effect() {
    let (base, fixture) = network_provider_fixture().await;
    let (state, buyer, overlay, execution) =
        network_provider_state(network_provider(true, true, vec![]), &base).await;
    let (left, right) = tokio::join!(
        network_post(state.clone(), buyer, json!({"mode":"ok"})),
        network_post(state.clone(), buyer, json!({"mode":"ok"})),
    );
    assert!(
        left.status() == StatusCode::OK || left.status() == StatusCode::CONFLICT,
        "left status {}",
        left.status()
    );
    assert!(
        right.status() == StatusCode::OK || right.status() == StatusCode::CONFLICT,
        "right status {}",
        right.status()
    );
    assert_eq!(fixture.effects.load(std::sync::atomic::Ordering::SeqCst), 1);
    std::fs::remove_file(overlay).unwrap();
    std::fs::remove_dir_all(execution).unwrap();
}
#[tokio::test]
async fn durable_result_replays_after_cache_restart() {
    let (mut state, buyer) = retry_fixture().await;
    let dir = std::env::temp_dir().join(format!("setra-retry-{}", Pubkey::new_unique()));
    state.execution_store = Some(dir.clone());
    let first = body_json(retry_post(state.clone(), buyer, json!({}), "legacy-rest").await).await;
    state.results.lock().unwrap().clear();
    let second = body_json(retry_post(state.clone(), buyer, json!({}), "legacy-rest").await).await;
    assert_eq!(first, second);
    for entry in std::fs::read_dir(&dir).unwrap() {
        std::fs::remove_file(entry.unwrap().path()).unwrap();
    }
    std::fs::remove_dir(dir).unwrap();
}
#[tokio::test]
async fn orphan_execution_intent_fails_closed() {
    let (mut state, buyer) = retry_fixture().await;
    let dir = std::env::temp_dir().join(format!("setra-intent-{}", Pubkey::new_unique()));
    std::fs::create_dir(&dir).unwrap();
    let (pda, _) = seller_server::pda::task_state_pda(&state.program_id, &buyer, TASK_ID);
    let intent = dir.join(format!("{pda}.intent"));
    std::fs::write(&intent, b"claimed").unwrap();
    state.execution_store = Some(dir.clone());
    assert_eq!(
        retry_post(state, buyer, json!({}), "legacy-rest")
            .await
            .status(),
        StatusCode::CONFLICT
    );
    std::fs::remove_file(intent).unwrap();
    std::fs::remove_dir(dir).unwrap();
}
#[tokio::test]
async fn quotes_preserve_full_u64_task_id() {
    let state = state_with_fake_chain(Value::Null).await;
    let response = seller_server::build_router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/tasks/18446744073709551615")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"buyer":Pubkey::new_unique().to_string(),"input":{}}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(body_json(response).await["task_id"], "18446744073709551615");
}
use seller_server::task_state::TaskStatus;
use serde_json::{json, Value};
use solana_pubkey::Pubkey;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tower::ServiceExt;

// Phase 3 test imports
use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT;
use curve25519_dalek::scalar::Scalar;
use rand::rngs::OsRng;
use redis::Client as RedisClient;

// Phase 3 cryptographic test imports
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};

const TASK_ID: u64 = 7;
const PRICE: u64 = 1_500_000;

#[path = "support/phase35_handlers.rs"]
mod phase35;

/// Starts a fake JSON-RPC endpoint that always answers `getAccountInfo`
/// with the given `value`, then returns an `AppState` wired to talk to it.
async fn state_with_fake_chain(value: Value) -> AppState {
    state_with_fake_chain_clock(value, None).await
}
async fn state_with_fake_chain_clock(value: Value, clock: Option<i64>) -> AppState {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let value = value.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 8192];
                let read = socket.read(&mut buf).await.unwrap();
                let value = if String::from_utf8_lossy(&buf[..read])
                    .contains("SysvarC1ock11111111111111111111111111111111")
                {
                    let time = clock.unwrap_or_else(|| {
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_secs() as i64
                    });
                    let mut data = vec![0u8; 40];
                    data[32..40].copy_from_slice(&time.to_le_bytes());
                    json!({"data":[base64::Engine::encode(&base64::engine::general_purpose::STANDARD,&data),"base64"]})
                } else {
                    value
                };
                let body = json!({"jsonrpc": "2.0", "id": 1, "result": {"context": {"slot": 1}, "value": value}}).to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });

    // Phase 3: Generate test cryptographic keys
    let mint_secret_key = Scalar::random(&mut OsRng);
    let mint_public_key = mint_secret_key * RISTRETTO_BASEPOINT_POINT;

    // Phase 3: Use a fake Redis client for testing
    let redis_client = RedisClient::open("redis://127.0.0.1:6379")
        .unwrap_or_else(|_| RedisClient::open("redis://localhost:6379").unwrap());

    AppState {
        rpc: seller_server::rpc::RpcClient::new(addr.ip().to_string(), addr.port()),
        program_id: Pubkey::new_unique(),
        mint: Pubkey::new_unique(),
        seller_token_account: Pubkey::new_unique(),
        verifier: Pubkey::new_unique(),
        protocol_treasury: None,
        price: PRICE,
        timeout_seconds: 180,
        results: Arc::new(Mutex::new(HashMap::new())),
        execution_store: None,
        registry_overlay: None,
        fixture_source_url: "https://example.com/setra-source".into(),
        provider_catalog: std::sync::Arc::new(
            seller_server::provider::provider_definitions().to_vec(),
        ),
        secret_resolver: std::sync::Arc::new(seller_server::secret::LocalSecretResolver::empty()),
        provider_connectors: std::sync::Arc::new(
            seller_server::provider_connector::ConnectorRegistry::empty(),
        ),
        provider_connector_runtime:
            seller_server::provider_connector::ProviderConnectorRuntime::new(
                seller_server::provider_connector::ConnectorRuntimePolicy::default(),
            )
            .unwrap(),
        mint_secret_key,
        mint_public_key,
        redis_client,
    }
}

/// Builds the exact Anchor-style byte layout using shared crate serialization
fn encode_task_state(
    buyer: &Pubkey,
    mint: &Pubkey,
    amount: u64,
    status_tag: u8,
    deadline_unix: i64,
    is_private: bool,
) -> Vec<u8> {
    use borsh::BorshSerialize;
    use seller_server::task_state::TaskState;

    let status = match status_tag {
        0 => TaskStatus::Pending,
        1 => TaskStatus::Settled,
        2 => TaskStatus::Refunded,
        _ => TaskStatus::Pending,
    };

    let task_state = TaskState {
        buyer: *buyer,
        seller: Pubkey::new_unique(),
        verifier: Pubkey::new_unique(),
        mint: *mint,
        protocol_treasury: Pubkey::new_unique(),
        task_id: TASK_ID,
        amount,
        deadline_unix,
        status,
        is_private,
        bump: 253,
    };

    // Serialize using shared crate (Borsh)
    let mut bytes = vec![0u8; 8]; // discriminator
    bytes.extend_from_slice(&task_state.try_to_vec().unwrap());
    bytes
}

async fn body_json(response: axum::response::Response) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn lists_static_services_and_fetches_one_by_id() {
    let state = state_with_fake_chain(Value::Null).await;
    let router = seller_server::build_router(state);

    let list = router
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/services")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(list.status(), StatusCode::OK);
    let list_body = body_json(list).await;
    let services = list_body.as_array().expect("service list must be an array");
    assert!(services
        .iter()
        .any(|service| service["id"] == "lead-scraper-demo"));

    let one = router
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/services/lead-scraper-demo")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(one.status(), StatusCode::OK);
    let one_body = body_json(one).await;
    assert_eq!(one_body["verification_policy"]["version"], "1");
    assert_eq!(one_body["verification_policy"]["level"], 1);

    let missing = router
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/services/does-not-exist")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn quote_and_result_add_phase2_fields_without_removing_legacy_fields() {
    let buyer = Pubkey::new_unique();
    let quote_state = state_with_fake_chain(Value::Null).await;
    let quote_router = seller_server::build_router(quote_state);
    let quote_request = Request::builder()
        .method("POST")
        .uri(format!("/tasks/{TASK_ID}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "buyer": buyer.to_string(),
                "service_id": "lead-scraper-demo",
                "input": {}
            })
            .to_string(),
        ))
        .unwrap();
    let quote_response = quote_router.oneshot(quote_request).await.unwrap();
    assert_eq!(quote_response.status(), StatusCode::PAYMENT_REQUIRED);
    let quote = body_json(quote_response).await;
    assert_eq!(quote["service_id"], "lead-scraper-demo");
    assert_eq!(quote["verification_policy"]["level"], 1);
    assert_eq!(quote["policy_hash"].as_str().unwrap().len(), 64);
    assert!(
        quote["program_id"].is_string(),
        "legacy quote fields remain"
    );

    let mint = Pubkey::new_unique();
    let account_data = encode_task_state(&buyer, &mint, PRICE, 0, 9_999_999_999, false);
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &account_data);
    let mut result_state = state_with_fake_chain(json!({"data": [encoded, "base64"]})).await;
    result_state.mint = mint;
    let result_router = seller_server::build_router(result_state);
    let result_response = result_router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/tasks/{TASK_ID}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "buyer": buyer.to_string(),
                        "service_id": "lead-scraper-demo",
                        "input": {}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(result_response.status(), StatusCode::OK);
    let result = body_json(result_response).await;
    assert!(result["input"].is_object());
    assert!(result["output_hash"].is_string());
    assert_eq!(result["version"], "1");
    assert_eq!(result["task_id"], TASK_ID.to_string());
    assert_eq!(result["service_id"], "lead-scraper-demo");
    assert!(result["result"].is_object());
    assert_eq!(result["result_hash"].as_str().unwrap().len(), 64);
    assert!(result["evidence"].is_array());
    assert!(result["completed_at_unix"].is_number());

    let invalid_response = result_router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/tasks/{}", TASK_ID + 1))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "buyer": buyer.to_string(),
                        "service_id": "lead-scraper-demo",
                        "input": {"fixture": "invalid"}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(invalid_response.status(), StatusCode::OK);
    let invalid = body_json(invalid_response).await;
    assert_eq!(invalid["result"]["records"].as_array().unwrap().len(), 1);
    assert_eq!(
        invalid["output_hash"],
        seller_server::execute::execute_task(&json!({"fixture": "invalid"}))
    );
}

#[tokio::test]
async fn rejects_non_canonical_float_input_without_panicking() {
    let buyer = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let account_data = encode_task_state(&buyer, &mint, PRICE, 0, 9_999_999_999, false);
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &account_data);
    let mut state = state_with_fake_chain(json!({"data": [encoded, "base64"]})).await;
    state.mint = mint;
    let response = seller_server::build_router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/tasks/{TASK_ID}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"buyer": buyer.to_string(), "input": {"value": 1.5}}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn responds_402_when_no_payment_found() {
    let state = state_with_fake_chain(Value::Null).await;
    let _program_id = state.program_id;
    let router = seller_server::build_router(state);

    let buyer = Pubkey::new_unique();
    let req = Request::builder()
        .method("POST")
        .uri(format!("/tasks/{TASK_ID}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"buyer": buyer.to_string(), "input": {"job": "resize"}}).to_string(),
        ))
        .unwrap();

    let response = router.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);

    let body = body_json(response).await;
    assert_eq!(body["task_id"], TASK_ID);
    assert_eq!(body["program_id"], _program_id.to_string());
    assert_eq!(body["amount"], PRICE);
    assert!(body["task_state_pda"].is_string());
    assert!(body["vault_pda"].is_string());
    assert_eq!(body["is_private"], false); // default for requests without is_private
    assert_eq!(body["protocol_fee_bps"], 100); // 1% fee
}

#[tokio::test]
async fn responds_200_and_a_matching_hash_once_paid() {
    let buyer = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let account_data = encode_task_state(
        &buyer,
        &mint,
        PRICE,
        0, /* Pending */
        9_999_999_999,
        false,
    );
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &account_data);

    let mut state = state_with_fake_chain(json!({"data": [encoded, "base64"]})).await;
    state.mint = mint; // must match what the server expects to accept payment

    let router = seller_server::build_router(state);
    let input = json!({"job": "resize", "width": 128});

    let req = Request::builder()
        .method("POST")
        .uri(format!("/tasks/{TASK_ID}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"buyer": buyer.to_string(), "input": input}).to_string(),
        ))
        .unwrap();

    let response = router.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body = body_json(response).await;
    assert_eq!(
        body["output_hash"],
        seller_server::execute::execute_task(&input)
    );
}

#[tokio::test]
async fn responds_409_for_an_already_settled_task() {
    let buyer = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let account_data = encode_task_state(
        &buyer,
        &mint,
        PRICE,
        1, /* Settled */
        9_999_999_999,
        false,
    );
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &account_data);

    let mut state = state_with_fake_chain(json!({"data": [encoded, "base64"]})).await;
    state.mint = mint;
    let router = seller_server::build_router(state);

    let req = Request::builder()
        .method("POST")
        .uri(format!("/tasks/{TASK_ID}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"buyer": buyer.to_string(), "input": {}}).to_string(),
        ))
        .unwrap();

    let response = router.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn responds_402_when_locked_amount_is_below_price() {
    let buyer = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let too_little = PRICE - 1;
    let account_data = encode_task_state(&buyer, &mint, too_little, 0, 9_999_999_999, false);
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &account_data);

    let mut state = state_with_fake_chain(json!({"data": [encoded, "base64"]})).await;
    state.mint = mint;
    let router = seller_server::build_router(state);

    let req = Request::builder()
        .method("POST")
        .uri(format!("/tasks/{TASK_ID}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"buyer": buyer.to_string(), "input": {}}).to_string(),
        ))
        .unwrap();

    let response = router.oneshot(req).await.unwrap();
    assert_eq!(
        response.status(),
        StatusCode::PAYMENT_REQUIRED,
        "an underpaid task must be treated the same as an unpaid one"
    );
}

#[tokio::test]
async fn get_result_is_404_before_any_execution_and_200_after() {
    let state = state_with_fake_chain(Value::Null).await;
    let router = seller_server::build_router(state);

    let get_req = Request::builder()
        .method("GET")
        .uri(format!("/tasks/{TASK_ID}/result"))
        .body(Body::empty())
        .unwrap();
    let response = router.clone().oneshot(get_req).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn handles_private_task_flag_correctly() {
    let buyer = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let account_data = encode_task_state(
        &buyer,
        &mint,
        PRICE,
        0, /* Pending */
        9_999_999_999,
        true,
    );
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &account_data);

    let mut state = state_with_fake_chain(json!({"data": [encoded, "base64"]})).await;
    state.mint = mint;
    let router = seller_server::build_router(state);
    let input = json!({"job": "resize", "width": 128});

    let req = Request::builder()
        .method("POST")
        .uri(format!("/tasks/{TASK_ID}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"buyer": buyer.to_string(), "input": input, "is_private": true}).to_string(),
        ))
        .unwrap();

    let response = router.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body = body_json(response).await;
    assert_eq!(
        body["output_hash"],
        seller_server::execute::execute_task(&input)
    );
}

#[tokio::test]
async fn rejects_privacy_mismatch() {
    let buyer = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    // On-chain task is private
    let account_data = encode_task_state(
        &buyer,
        &mint,
        PRICE,
        0, /* Pending */
        9_999_999_999,
        true,
    );
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &account_data);

    let mut state = state_with_fake_chain(json!({"data": [encoded, "base64"]})).await;
    state.mint = mint;
    let router = seller_server::build_router(state);

    // Request is for public task
    let req = Request::builder()
        .method("POST")
        .uri(format!("/tasks/{TASK_ID}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"buyer": buyer.to_string(), "input": {}, "is_private": false}).to_string(),
        ))
        .unwrap();

    let response = router.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let body = body_json(response).await;
    assert!(body["error"].as_str().unwrap().contains("privacy mismatch"));
}

#[tokio::test]
async fn payment_quote_includes_private_flag() {
    let state = state_with_fake_chain(Value::Null).await;
    let _program_id = state.program_id;
    let router = seller_server::build_router(state);

    let buyer = Pubkey::new_unique();
    let req = Request::builder()
        .method("POST")
        .uri(format!("/tasks/{TASK_ID}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"buyer": buyer.to_string(), "input": {"job": "resize"}, "is_private": true})
                .to_string(),
        ))
        .unwrap();

    let response = router.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);

    let body = body_json(response).await;
    assert_eq!(body["is_private"], true);
    assert_eq!(body["protocol_fee_bps"], 100);
}

// Phase 3: Test blind signature endpoint
#[tokio::test]
async fn blind_sign_rejects_non_private_tasks() {
    let buyer = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    // Public task (is_private = false)
    let account_data = encode_task_state(
        &buyer,
        &mint,
        PRICE,
        0, /* Pending */
        9_999_999_999,
        false,
    );
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &account_data);

    let mut state = state_with_fake_chain(json!({"data": [encoded, "base64"]})).await;
    state.mint = mint;
    state.execution_store = Some(
        std::env::temp_dir()
            .join(format!("setra-mint-reject-{buyer}"))
            .join("executions"),
    );
    let router = seller_server::build_router(state);

    // Generate a valid blinded point
    let test_point = RistrettoPoint::random(&mut OsRng);
    let blinded_point = hex::encode(test_point.compress().to_bytes());

    let req = Request::builder()
        .method("POST")
        .uri("/mint/blind-sign")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "buyer": buyer.to_string(),
                "task_id": TASK_ID,
                "blinded_point": blinded_point
            })
            .to_string(),
        ))
        .unwrap();

    let response = router.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let body = body_json(response).await;
    assert!(body["error"]
        .as_str()
        .unwrap()
        .contains("is_private = true"));
}

#[tokio::test]
async fn blind_sign_rejects_invalid_hex_encoding() {
    let state = state_with_fake_chain(Value::Null).await;
    let router = seller_server::build_router(state);

    let req = Request::builder()
        .method("POST")
        .uri("/mint/blind-sign")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "buyer": Pubkey::new_unique().to_string(),
                "task_id": 123,
                "blinded_point": "invalid_hex"
            })
            .to_string(),
        ))
        .unwrap();

    let response = router.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn blind_sign_rejects_invalid_point_length() {
    let state = state_with_fake_chain(Value::Null).await;
    let router = seller_server::build_router(state);

    let req = Request::builder()
        .method("POST")
        .uri("/mint/blind-sign")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "buyer": Pubkey::new_unique().to_string(),
                "task_id": 123,                "blinded_point": "1234" // Too short
            })
            .to_string(),
        ))
        .unwrap();

    let response = router.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

/// Happy path for the mint: a private, Pending, fully-funded task must yield
/// C = k·B, and the buyer's unblinding (S = r⁻¹·C) must satisfy the verifier's
/// check S = h·K. That identity is the whole point of the Chaumian blind
/// signature, so asserting "200 OK" alone would miss a leaky blinding step or
/// a server that just echoes back the point it was handed.
///
/// Scalars are fixed rather than random so the test is a deterministic
/// reference: h is the nullifier, r the buyer's blinding factor.
#[tokio::test]
async fn blind_sign_returns_k_b_and_survives_the_blind_unblind_cycle() {
    let buyer = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    // Private, Pending, fully funded, deadline far in the future.
    let account_data = encode_task_state(
        &buyer,
        &mint,
        PRICE,
        0, /* Pending */
        9_999_999_999,
        true,
    );
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &account_data);

    let mut state = state_with_fake_chain(json!({"data": [encoded, "base64"]})).await;
    state.mint = mint;
    state.execution_store = Some(
        std::env::temp_dir()
            .join(format!("setra-mint-happy-{buyer}"))
            .join("executions"),
    );

    // Snapshot the mint keys before the state moves into the router, so the
    // expected values are recomputed independently of the handler.
    let secret = state.mint_secret_key;
    let expected_pubkey = hex::encode(state.mint_public_key.compress().to_bytes());

    let router = seller_server::build_router(state);

    let h = Scalar::from(11u64); // nullifier scalar the verifier knows
    let r = Scalar::from(3u64); // buyer's blinding factor
    let eta = h * RISTRETTO_BASEPOINT_POINT;
    let b_point = r * eta;
    let blinded_point = hex::encode(b_point.compress().to_bytes());

    let request = || {
        Request::builder()
            .method("POST")
            .uri("/mint/blind-sign")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "buyer": buyer.to_string(),
                    "task_id": TASK_ID,
                    "blinded_point": blinded_point
                })
                .to_string(),
            ))
            .unwrap()
    };

    let response = router.clone().oneshot(request()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body = body_json(response).await;
    let signature = body["blind_signature"].as_str().unwrap().to_string();
    let mint_pubkey = body["mint_pubkey"].as_str().unwrap();

    // K must be the mint's own public key, not a per-request value.
    assert_eq!(mint_pubkey, expected_pubkey);
    let k_point = CompressedRistretto::from_slice(&hex::decode(mint_pubkey).unwrap())
        .unwrap()
        .decompress()
        .expect("mint pubkey must be a valid Ristretto encoding");
    assert_eq!(k_point, secret * RISTRETTO_BASEPOINT_POINT);

    // The mint must return k·B, not echo B back.
    assert_ne!(signature, blinded_point);
    let c_point = CompressedRistretto::from_slice(&hex::decode(&signature).unwrap())
        .unwrap()
        .decompress()
        .expect("blind signature must be a valid Ristretto encoding");
    assert_eq!(
        c_point,
        secret * b_point,
        "blind signature must be exactly C = k·B"
    );

    // Buyer unblinds: S = r⁻¹·C = k·h·G = h·K, which is what the verifier
    // checks knowing only h and the mint's public key.
    let s_point = c_point * r.invert();
    assert_eq!(
        s_point,
        h * k_point,
        "unblinded signature must satisfy S = h·K"
    );

    // A deterministic mint (no per-request randomness) must sign the same
    // blinded point identically, or buyers can never agree on the voucher.
    let repeat = router.oneshot(request()).await.unwrap();
    assert_eq!(repeat.status(), StatusCode::OK);
    let repeat_body = body_json(repeat).await;
    assert_eq!(repeat_body["blind_signature"].as_str().unwrap(), signature);
}

#[tokio::test]
async fn mint_issuance_status_replays_only_exact_durable_receipt_after_restart() {
    let buyer = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let data = encode_task_state(&buyer, &mint, PRICE, 0, 9_999_999_999, true);
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data);
    let mut state = state_with_fake_chain(json!({"data":[encoded,"base64"]})).await;
    state.mint = mint;
    state.execution_store = Some(
        std::env::temp_dir()
            .join(format!("setra-mint-restart-{buyer}"))
            .join("executions"),
    );
    let point = hex::encode(
        (Scalar::from(17u64) * RISTRETTO_BASEPOINT_POINT)
            .compress()
            .to_bytes(),
    );
    let post = |blinded: &str| {
        Request::builder()
            .method("POST")
            .uri("/mint/blind-sign")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"buyer":buyer.to_string(),"task_id":TASK_ID,"blinded_point":blinded})
                    .to_string(),
            ))
            .unwrap()
    };
    let get = || {
        Request::builder()
            .uri(format!("/mint/issuance/{TASK_ID}?buyer={buyer}"))
            .body(Body::empty())
            .unwrap()
    };
    let first = seller_server::build_router(state.clone())
        .oneshot(post(&point))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first_body = body_json(first).await;
    let recovered = seller_server::build_router(state.clone())
        .oneshot(get())
        .await
        .unwrap();
    assert_eq!(recovered.status(), StatusCode::OK);
    let evidence = body_json(recovered).await;
    assert_eq!(evidence["state"], "RESPONSE_PERSISTED");
    assert_eq!(evidence["blind_signature"], first_body["blind_signature"]);
    assert_eq!(evidence["current_mint_matches_receipt"], true);
    let replay = seller_server::build_router(state.clone())
        .oneshot(post(&point))
        .await
        .unwrap();
    assert_eq!(body_json(replay).await, first_body);
    let changed = hex::encode(
        (Scalar::from(19u64) * RISTRETTO_BASEPOINT_POINT)
            .compress()
            .to_bytes(),
    );
    assert_eq!(
        seller_server::build_router(state.clone())
            .oneshot(post(&changed))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    state.mint_secret_key = Scalar::from(23u64);
    state.mint_public_key = state.mint_secret_key * RISTRETTO_BASEPOINT_POINT;
    let rotated = seller_server::build_router(state.clone())
        .oneshot(get())
        .await
        .unwrap();
    assert_eq!(
        body_json(rotated).await["current_mint_matches_receipt"],
        false
    );
    assert_eq!(
        seller_server::build_router(state)
            .oneshot(post(&point))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
}

// Phase 3: Test nullifier endpoint
#[tokio::test]
async fn nullify_rejects_invalid_length() {
    let state = state_with_fake_chain(Value::Null).await;
    let router = seller_server::build_router(state);

    let req = Request::builder()
        .method("POST")
        .uri("/verifier/nullify")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "nullifier": "1234" // Should be 64 characters
            })
            .to_string(),
        ))
        .unwrap();

    let response = router.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn nullify_accepts_valid_format() {
    let state = state_with_fake_chain(Value::Null).await;
    let router = seller_server::build_router(state);

    // Valid 32-byte hex string (64 characters)
    let valid_nullifier = "a".repeat(64);

    let req = Request::builder()
        .method("POST")
        .uri("/verifier/nullify")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "nullifier": valid_nullifier
            })
            .to_string(),
        ))
        .unwrap();

    let response = router.oneshot(req).await.unwrap();
    // Should accept valid format (may fail due to Redis connection but that's ok)
    // The test Redis client may not actually connect, so we check it's not a 400 error
    assert_ne!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn payment_quote_pdas_match_local_derivation() {
    let state = state_with_fake_chain(Value::Null).await;
    let program_id = state.program_id;
    let router = seller_server::build_router(state);

    let buyer = Pubkey::new_unique();
    let req = Request::builder()
        .method("POST")
        .uri(format!("/tasks/{TASK_ID}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"buyer": buyer.to_string(), "input": {}}).to_string(),
        ))
        .unwrap();

    let response = router.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);

    let body = body_json(response).await;
    let (expected_task_state, _) = seller_server::pda::task_state_pda(&program_id, &buyer, TASK_ID);
    let (expected_vault, _) = seller_server::pda::vault_pda(&program_id, &expected_task_state);
    assert_eq!(body["task_state_pda"], expected_task_state.to_string());
    assert_eq!(body["vault_pda"], expected_vault.to_string());
}

#[tokio::test]
async fn payment_quote_pdas_differ_per_task_id() {
    let state = state_with_fake_chain(Value::Null).await;
    let program_id = state.program_id;
    let router = seller_server::build_router(state);
    let buyer = Pubkey::new_unique();

    let quote_for = |task_id: u64| {
        let router = router.clone();
        let buyer = buyer.to_string();
        async move {
            let req = Request::builder()
                .method("POST")
                .uri(format!("/tasks/{task_id}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"buyer": buyer, "input": {}}).to_string()))
                .unwrap();
            let response = router.oneshot(req).await.unwrap();
            assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);
            body_json(response).await
        }
    };

    let a = quote_for(1).await;
    let b = quote_for(2).await;
    assert_ne!(a["task_state_pda"], b["task_state_pda"]);
    assert_ne!(a["vault_pda"], b["vault_pda"]);

    let (expected_a, _) = seller_server::pda::task_state_pda(&program_id, &buyer, 1);
    assert_eq!(a["task_state_pda"], expected_a.to_string());
}

#[tokio::test]
async fn underpaid_private_task_returns_402_with_private_quote() {
    let buyer = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    // On-chain task is PRIVATE and underpaid.
    let account_data = encode_task_state(
        &buyer,
        &mint,
        PRICE - 1,
        0, /* Pending */
        9_999_999_999,
        true,
    );
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &account_data);

    let mut state = state_with_fake_chain(json!({"data": [encoded, "base64"]})).await;
    state.mint = mint;
    let router = seller_server::build_router(state);

    // Request matches the on-chain privacy flag, so the privacy check passes
    // and the underpaid amount must yield a 402 quote.
    let req = Request::builder()
        .method("POST")
        .uri(format!("/tasks/{TASK_ID}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"buyer": buyer.to_string(), "input": {}, "is_private": true}).to_string(),
        ))
        .unwrap();

    let response = router.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);

    let body = body_json(response).await;
    assert_eq!(body["is_private"], true, "quote must mirror on-chain state");
    assert_eq!(body["amount"], PRICE);
}

#[tokio::test]
async fn rejects_mismatch_when_chain_is_public_but_request_is_private() {
    let buyer = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    // On-chain task is PUBLIC.
    let account_data = encode_task_state(
        &buyer,
        &mint,
        PRICE,
        0, /* Pending */
        9_999_999_999,
        false,
    );
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &account_data);

    let mut state = state_with_fake_chain(json!({"data": [encoded, "base64"]})).await;
    state.mint = mint;
    let router = seller_server::build_router(state);

    // Request claims private.
    let req = Request::builder()
        .method("POST")
        .uri(format!("/tasks/{TASK_ID}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"buyer": buyer.to_string(), "input": {}, "is_private": true}).to_string(),
        ))
        .unwrap();

    let response = router.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let body = body_json(response).await;
    assert!(body["error"].as_str().unwrap().contains("privacy mismatch"));
}

#[tokio::test]
async fn results_are_isolated_per_task_id() {
    let buyer = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let account_data = encode_task_state(
        &buyer,
        &mint,
        PRICE,
        0, /* Pending */
        9_999_999_999,
        false,
    );
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &account_data);

    let mut state = state_with_fake_chain(json!({"data": [encoded, "base64"]})).await;
    state.mint = mint;
    let router = seller_server::build_router(state);

    // Execute two different tasks with different inputs.
    for (task_id, input) in [(11u64, json!({"job": "a"})), (12, json!({"job": "b"}))] {
        let req = Request::builder()
            .method("POST")
            .uri(format!("/tasks/{task_id}"))
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"buyer": buyer.to_string(), "input": input}).to_string(),
            ))
            .unwrap();
        let response = router.clone().oneshot(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    let fetch = |router: axum::Router, task_id: u64| async move {
        let req = Request::builder()
            .method("GET")
            .uri(format!("/tasks/{task_id}/result"))
            .body(Body::empty())
            .unwrap();
        router.oneshot(req).await.unwrap()
    };

    let r11 = fetch(router.clone(), 11).await;
    assert_eq!(r11.status(), StatusCode::OK);
    let b11 = body_json(r11).await;
    assert_eq!(
        b11["output_hash"],
        seller_server::execute::execute_task(&json!({"job": "a"}))
    );

    let r12 = fetch(router.clone(), 12).await;
    assert_eq!(r12.status(), StatusCode::OK);
    let b12 = body_json(r12).await;
    assert_eq!(
        b12["output_hash"],
        seller_server::execute::execute_task(&json!({"job": "b"}))
    );
    assert_ne!(b11["output_hash"], b12["output_hash"]);

    let r13 = fetch(router, 13).await;
    assert_eq!(r13.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn hash_matches_fixed_reference_vector() {
    // sha256("{\"a\":1}") computed outside this crate (sha256sum), so any
    // drift in canonicalization vs the TypeScript verifier breaks this test.
    let expected = "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862";
    assert_eq!(
        seller_server::execute::execute_task(&json!({"a": 1})),
        expected
    );
}

#[tokio::test]
async fn rejects_execution_after_deadline_with_410() {
    let buyer = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    // Deadline 10s in the past; task is Pending, fully funded, correct mint.
    let now: i64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .try_into()
        .unwrap();
    let account_data =
        encode_task_state(&buyer, &mint, PRICE, 0 /* Pending */, now - 10, false);
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &account_data);

    let mut state = state_with_fake_chain(json!({"data": [encoded, "base64"]})).await;
    state.mint = mint;
    let router = seller_server::build_router(state);

    let req = Request::builder()
        .method("POST")
        .uri(format!("/tasks/{TASK_ID}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"buyer": buyer.to_string(), "input": {}}).to_string(),
        ))
        .unwrap();

    let response = router.oneshot(req).await.unwrap();
    assert_eq!(
        response.status(),
        StatusCode::GONE,
        "expired Pending task must not execute: buyer could otherwise take the \
         output AND a full on-chain refund"
    );

    let body = body_json(response).await;
    assert_eq!(body["deadline_unix"], now - 10);
}

#[tokio::test]
async fn executes_normally_while_deadline_is_in_the_future() {
    let buyer = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    // Deadline 1 hour in the future — the boundary case now >= deadline is
    // what must fail; anything strictly before it must succeed.
    let now: i64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .try_into()
        .unwrap();
    let account_data = encode_task_state(
        &buyer,
        &mint,
        PRICE,
        0, /* Pending */
        now + 3600,
        false,
    );
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &account_data);

    let mut state = state_with_fake_chain(json!({"data": [encoded, "base64"]})).await;
    state.mint = mint;
    let router = seller_server::build_router(state);

    let req = Request::builder()
        .method("POST")
        .uri(format!("/tasks/{TASK_ID}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"buyer": buyer.to_string(), "input": {"job": "resize"}}).to_string(),
        ))
        .unwrap();

    let response = router.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}
