use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use seller_server::execute::hash_canonical;
use seller_server::provider::{
    ConnectorType, IdempotencySupport, ProviderDefinitionV1, RecoveryCapabilitiesV1,
};
use seller_server::provider_connector::{
    provider_execution_identity, ConnectorErrorKind, ConnectorProfileV1, ConnectorRegistry,
    ConnectorRuntimePolicy, McpConnectorConfigV1, ProviderConnectorRuntime,
    ProviderExecutionRequestV1, RestConnectorConfigV1,
};
use seller_server::secret::{LocalSecretResolver, SecretSourceRecord};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Default)]
struct FixtureState {
    effects: Arc<AtomicUsize>,
    port: Arc<AtomicUsize>,
    requests: Arc<Mutex<HashMap<String, Value>>>,
    redirected_authorization: Arc<Mutex<Option<String>>>,
}

fn response(request: &Value) -> Value {
    let result = json!({"provider":"ok","input":request["input"]});
    let result_hash = hash_canonical(&result).unwrap();
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

async fn rest_execute(
    State(state): State<FixtureState>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> impl IntoResponse {
    let identity = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let mut requests = state.requests.lock().unwrap();
    let saved = requests.entry(identity).or_insert_with(|| {
        state.effects.fetch_add(1, Ordering::SeqCst);
        request
    });
    Json(response(saved))
}

async fn rest_lost(
    State(state): State<FixtureState>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> impl IntoResponse {
    let identity = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    state
        .requests
        .lock()
        .unwrap()
        .entry(identity)
        .or_insert_with(|| {
            state.effects.fetch_add(1, Ordering::SeqCst);
            request
        });
    tokio::time::sleep(Duration::from_millis(750)).await;
    StatusCode::NO_CONTENT
}

async fn rest_status(
    State(state): State<FixtureState>,
    Path(identity): Path<String>,
) -> impl IntoResponse {
    match state.requests.lock().unwrap().get(&identity).cloned() {
        Some(request) => (StatusCode::OK, Json(response(&request))).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({"error":"missing"}))).into_response(),
    }
}

async fn oversized() -> impl IntoResponse {
    "x".repeat(2048)
}

async fn bad_receipt(Json(request): Json<Value>) -> impl IntoResponse {
    let mut value = response(&request);
    value["receipt"]["task_id"] = json!("other-task");
    Json(value)
}

async fn status_mismatch(
    State(state): State<FixtureState>,
    Path(identity): Path<String>,
) -> impl IntoResponse {
    let saved = state
        .requests
        .lock()
        .unwrap()
        .get(&identity)
        .cloned()
        .unwrap();
    let mut value = response(&saved);
    value["execution_id"] = json!("wrong-execution-id");
    value["receipt"]["execution_id"] = json!("wrong-execution-id");
    Json(value)
}

async fn redirect_private(
    headers: HeaderMap,
    State(state): State<FixtureState>,
) -> impl IntoResponse {
    let _ = headers;
    (
        StatusCode::TEMPORARY_REDIRECT,
        [(
            "location",
            format!(
                "http://127.0.0.1:{}/redirect-target",
                state.port.load(Ordering::SeqCst)
            ),
        )],
    )
        .into_response()
}

async fn redirect_target(
    State(state): State<FixtureState>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> impl IntoResponse {
    *state.redirected_authorization.lock().unwrap() = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    Json(response(&request))
}

async fn mcp(State(state): State<FixtureState>, Json(request): Json<Value>) -> impl IntoResponse {
    if request["method"] == "initialize" {
        return Json(json!({
            "jsonrpc":"2.0","id":1,
            "result":{"protocolVersion":"2025-03-26"}
        }));
    }
    let tool = request["params"]["name"].as_str().unwrap_or_default();
    let arguments = &request["params"]["arguments"];
    if tool == "orders.status" {
        let identity = arguments["execution_identity"].as_str().unwrap_or_default();
        let saved = state
            .requests
            .lock()
            .unwrap()
            .get(identity)
            .cloned()
            .unwrap();
        return Json(json!({
            "jsonrpc":"2.0","id":3,
            "result":{"tool":tool,"structuredContent":response(&saved)}
        }));
    }
    let identity = arguments["execution_identity"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let mut requests = state.requests.lock().unwrap();
    let saved = requests.entry(identity).or_insert_with(|| {
        state.effects.fetch_add(1, Ordering::SeqCst);
        arguments.clone()
    });
    Json(json!({
        "jsonrpc":"2.0","id":2,
        "result":{"tool":tool,"structuredContent":response(saved)}
    }))
}

async fn mcp_unexpected(Json(request): Json<Value>) -> impl IntoResponse {
    if request["method"] == "initialize" {
        return Json(json!({
            "jsonrpc":"2.0","id":1,
            "result":{"protocolVersion":"2025-03-26"}
        }));
    }
    let arguments = &request["params"]["arguments"];
    Json(json!({
        "jsonrpc":"2.0","id":2,
        "result":{"tool":"wrong.tool","structuredContent":response(arguments)}
    }))
}

async fn mcp_malformed(Json(request): Json<Value>) -> impl IntoResponse {
    if request["method"] == "initialize" {
        return Json(json!({
            "jsonrpc":"2.0","id":1,
            "result":{"protocolVersion":"2025-03-26"}
        }));
    }
    Json(json!({
        "jsonrpc":"2.0","id":2,
        "result":{"tool":"orders.execute","structuredContent":{"bad":true}}
    }))
}

async fn mcp_lost(
    State(state): State<FixtureState>,
    Json(request): Json<Value>,
) -> impl IntoResponse {
    if request["method"] == "initialize" {
        return Json(json!({
            "jsonrpc":"2.0","id":1,
            "result":{"protocolVersion":"2025-03-26"}
        }));
    }
    let tool = request["params"]["name"].as_str().unwrap_or_default();
    let arguments = &request["params"]["arguments"];
    if tool == "orders.status" {
        let identity = arguments["execution_identity"].as_str().unwrap_or_default();
        let saved = state
            .requests
            .lock()
            .unwrap()
            .get(identity)
            .cloned()
            .unwrap();
        return Json(json!({
            "jsonrpc":"2.0","id":3,
            "result":{"tool":tool,"structuredContent":response(&saved)}
        }));
    }
    let identity = arguments["execution_identity"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    state
        .requests
        .lock()
        .unwrap()
        .entry(identity)
        .or_insert_with(|| {
            state.effects.fetch_add(1, Ordering::SeqCst);
            arguments.clone()
        });
    tokio::time::sleep(Duration::from_millis(750)).await;
    Json(json!({"unreachable":true}))
}

async fn fixture() -> (String, FixtureState) {
    let state = FixtureState::default();
    let app = Router::new()
        .route("/execute", post(rest_execute))
        .route("/lost", post(rest_lost))
        .route("/status/:identity", get(rest_status))
        .route("/oversized", post(oversized))
        .route("/bad-receipt", post(bad_receipt))
        .route("/status-mismatch/:identity", get(status_mismatch))
        .route("/redirect", post(redirect_private))
        .route("/redirect-target", post(redirect_target))
        .route("/mcp", post(mcp))
        .route("/mcp-unexpected", post(mcp_unexpected))
        .route("/mcp-malformed", post(mcp_malformed))
        .route("/mcp-lost", post(mcp_lost))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    state.port.store(address.port() as usize, Ordering::SeqCst);
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://localhost:{}", address.port()), state)
}

fn provider(connector_type: ConnectorType) -> ProviderDefinitionV1 {
    ProviderDefinitionV1 {
        version: "1".into(),
        provider_id: match connector_type {
            ConnectorType::RestApi => "rest-orders",
            ConnectorType::McpTool => "mcp-orders",
            ConnectorType::LocalFixture => "fixture-orders",
        }
        .into(),
        display_name: "Orders".into(),
        connector_type: connector_type.clone(),
        execution_profile: match connector_type {
            ConnectorType::RestApi => "rest-orders-v1",
            ConnectorType::McpTool => "mcp-orders-v1",
            ConnectorType::LocalFixture => "fixture-orders-v1",
        }
        .into(),
        capabilities: vec!["orders.create".into()],
        privacy_support: false,
        active: true,
        recovery_capabilities: RecoveryCapabilitiesV1 {
            idempotency: IdempotencySupport::Keyed,
            execution_id: true,
            status_query: true,
            durable_receipt: true,
            deterministic_replay: true,
            may_produce_non_idempotent_external_effect: false,
        },
        secret_refs: vec![],
    }
}

fn rest_profile(base: &str, execute_path: &str) -> ConnectorProfileV1 {
    ConnectorProfileV1 {
        version: "1".into(),
        execution_profile: "rest-orders-v1".into(),
        connector_type: ConnectorType::RestApi,
        rest: Some(RestConnectorConfigV1 {
            base_endpoint: base.into(),
            execute_path: execute_path.into(),
            status_path_template: Some("/status/{execution_id}".into()),
            health_path: None,
            allowed_hosts: vec!["localhost".into()],
            connect_timeout_ms: 100,
            request_timeout_ms: 100,
            maximum_response_bytes: 1024,
            redirect_cap: 1,
            idempotency_header: Some("Idempotency-Key".into()),
            bearer_secret_ref: None,
        }),
        mcp: None,
    }
}

fn mcp_profile(base: &str) -> ConnectorProfileV1 {
    ConnectorProfileV1 {
        version: "1".into(),
        execution_profile: "mcp-orders-v1".into(),
        connector_type: ConnectorType::McpTool,
        rest: None,
        mcp: Some(McpConnectorConfigV1 {
            endpoint: format!("{base}/mcp"),
            tool: "orders.execute".into(),
            status_tool: Some("orders.status".into()),
            allowed_hosts: vec!["localhost".into()],
            connect_timeout_ms: 100,
            request_timeout_ms: 500,
            maximum_response_bytes: 1024,
            redirect_cap: 0,
            bearer_secret_ref: None,
        }),
    }
}

fn mcp_profile_at(base: &str, path: &str) -> ConnectorProfileV1 {
    let mut profile = mcp_profile(base);
    profile.mcp.as_mut().unwrap().endpoint = format!("{base}{path}");
    profile
}

fn request(provider: &ProviderDefinitionV1) -> ProviderExecutionRequestV1 {
    let input = json!({"order":7});
    let input_hash = hash_canonical(&input).unwrap();
    let execution_identity =
        provider_execution_identity("task-pda", "orders", &input_hash, &provider.provider_id)
            .unwrap();
    ProviderExecutionRequestV1 {
        version: "1".into(),
        provider_id: provider.provider_id.clone(),
        execution_identity,
        task_state_pda: "task-pda".into(),
        task_id: "7".into(),
        service_id: "orders".into(),
        input_hash,
        input,
    }
}

fn runtime() -> ProviderConnectorRuntime {
    ProviderConnectorRuntime::new(ConnectorRuntimePolicy {
        allow_test_http: true,
        allow_test_private_targets: true,
        maximum_concurrency: 4,
    })
    .unwrap()
}

#[tokio::test]
async fn rest_execution_is_idempotent_and_status_recovers_a_lost_acknowledgement() {
    let (base, state) = fixture().await;
    let provider = provider(ConnectorType::RestApi);
    let request = request(&provider);
    let resolver = LocalSecretResolver::empty();
    let profile = rest_profile(&base, "/execute");
    let first = runtime()
        .execute(&profile, &provider, &request, &resolver)
        .await
        .unwrap();
    let second = runtime()
        .execute(&profile, &provider, &request, &resolver)
        .await
        .unwrap();
    assert_eq!(first.result, second.result);
    assert_eq!(state.effects.load(Ordering::SeqCst), 1);

    let lost_profile = rest_profile(&base, "/lost");
    let error = runtime()
        .execute(&lost_profile, &provider, &request, &resolver)
        .await
        .unwrap_err();
    assert_eq!(error.kind, ConnectorErrorKind::UnknownExternalEffect);
    let recovered = runtime()
        .status(
            &lost_profile,
            &provider,
            &request,
            &request.execution_identity,
            &resolver,
        )
        .await
        .unwrap();
    assert_eq!(recovered.status, "SUCCEEDED");
    assert_eq!(state.effects.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn rest_rejects_private_targets_oversized_responses_and_credential_forwarding() {
    let (base, state) = fixture().await;
    let mut provider = provider(ConnectorType::RestApi);
    provider.secret_refs = vec!["orders-token".into()];
    let resolver = LocalSecretResolver::from_records(
        HashSet::from(["orders-token".into()]),
        HashMap::from([(
            "orders-token".into(),
            SecretSourceRecord {
                value: "private-token".into(),
                version: "v1".into(),
            },
        )]),
    )
    .unwrap();
    let mut profile = rest_profile(&base, "/oversized");
    profile.rest.as_mut().unwrap().maximum_response_bytes = 256;
    profile.rest.as_mut().unwrap().bearer_secret_ref = Some("orders-token".into());
    assert_eq!(
        runtime()
            .execute(&profile, &provider, &request(&provider), &resolver)
            .await
            .unwrap_err()
            .kind,
        ConnectorErrorKind::MalformedResponse
    );

    let production = ProviderConnectorRuntime::new(ConnectorRuntimePolicy {
        allow_test_http: true,
        allow_test_private_targets: false,
        maximum_concurrency: 1,
    })
    .unwrap();
    assert_eq!(
        production
            .execute(
                &rest_profile(&base, "/execute"),
                &provider,
                &request(&provider),
                &resolver
            )
            .await
            .unwrap_err()
            .kind,
        ConnectorErrorKind::RejectedTarget
    );

    let mut redirect = rest_profile(&base, "/redirect");
    let config = redirect.rest.as_mut().unwrap();
    config.allowed_hosts.push("127.0.0.1".into());
    config.bearer_secret_ref = Some("orders-token".into());
    runtime()
        .execute(&redirect, &provider, &request(&provider), &resolver)
        .await
        .unwrap();
    assert_eq!(*state.redirected_authorization.lock().unwrap(), None);
}

#[tokio::test]
async fn mcp_executes_exact_tools_and_deduplicates_the_same_identity() {
    let (base, state) = fixture().await;
    let provider = provider(ConnectorType::McpTool);
    let profile = mcp_profile(&base);
    let request = request(&provider);
    let resolver = LocalSecretResolver::empty();
    let first = runtime()
        .execute(&profile, &provider, &request, &resolver)
        .await
        .unwrap();
    let second = runtime()
        .execute(&profile, &provider, &request, &resolver)
        .await
        .unwrap();
    assert_eq!(first.result, second.result);
    assert_eq!(state.effects.load(Ordering::SeqCst), 1);
    let recovered = runtime()
        .status(
            &profile,
            &provider,
            &request,
            &request.execution_identity,
            &resolver,
        )
        .await
        .unwrap();
    assert_eq!(recovered.status, "SUCCEEDED");
}

#[tokio::test]
async fn mcp_disconnect_recovers_by_status_and_malformed_or_wrong_tools_fail_closed() {
    let (base, state) = fixture().await;
    let provider = provider(ConnectorType::McpTool);
    let request = request(&provider);
    let resolver = LocalSecretResolver::empty();
    let lost = mcp_profile_at(&base, "/mcp-lost");
    assert_eq!(
        runtime()
            .execute(&lost, &provider, &request, &resolver)
            .await
            .unwrap_err()
            .kind,
        ConnectorErrorKind::UnknownExternalEffect
    );
    let recovered = runtime()
        .status(
            &lost,
            &provider,
            &request,
            &request.execution_identity,
            &resolver,
        )
        .await
        .unwrap();
    assert_eq!(recovered.status, "SUCCEEDED");
    assert_eq!(state.effects.load(Ordering::SeqCst), 1);

    assert_eq!(
        runtime()
            .execute(
                &mcp_profile_at(&base, "/mcp-unexpected"),
                &provider,
                &request,
                &resolver,
            )
            .await
            .unwrap_err()
            .kind,
        ConnectorErrorKind::BindingMismatch
    );
    assert_eq!(
        runtime()
            .execute(
                &mcp_profile_at(&base, "/mcp-malformed"),
                &provider,
                &request,
                &resolver,
            )
            .await
            .unwrap_err()
            .kind,
        ConnectorErrorKind::MalformedResponse
    );
}

#[tokio::test]
async fn changed_immutable_request_binding_and_no_recovery_contract_fail_closed() {
    let (base, _) = fixture().await;
    let provider = provider(ConnectorType::RestApi);
    let profile = rest_profile(&base, "/execute");
    let resolver = LocalSecretResolver::empty();
    let mut changed_input = request(&provider);
    changed_input.input = json!({"order":8});
    let mut changed_service = request(&provider);
    changed_service.service_id = "other-service".into();
    let mut changed_provider = request(&provider);
    changed_provider.provider_id = "other-provider".into();
    for changed in [changed_input, changed_service, changed_provider] {
        assert_eq!(
            runtime()
                .execute(&profile, &provider, &changed, &resolver)
                .await
                .unwrap_err()
                .kind,
            ConnectorErrorKind::BindingMismatch
        );
    }

    let mut unsupported_provider = provider.clone();
    unsupported_provider.recovery_capabilities.idempotency = IdempotencySupport::None;
    unsupported_provider.recovery_capabilities.execution_id = false;
    unsupported_provider.recovery_capabilities.status_query = false;
    unsupported_provider.recovery_capabilities.durable_receipt = false;
    unsupported_provider
        .recovery_capabilities
        .deterministic_replay = false;
    unsupported_provider
        .recovery_capabilities
        .may_produce_non_idempotent_external_effect = true;
    let mut unsupported_profile = rest_profile(&base, "/lost");
    let rest = unsupported_profile.rest.as_mut().unwrap();
    rest.status_path_template = None;
    rest.idempotency_header = None;
    let unsupported_request = request(&unsupported_provider);
    assert_eq!(
        runtime()
            .execute(
                &unsupported_profile,
                &unsupported_provider,
                &unsupported_request,
                &resolver,
            )
            .await
            .unwrap_err()
            .kind,
        ConnectorErrorKind::UnknownExternalEffect
    );
    assert_eq!(
        runtime()
            .status(
                &unsupported_profile,
                &unsupported_provider,
                &unsupported_request,
                &unsupported_request.execution_identity,
                &resolver,
            )
            .await
            .unwrap_err()
            .kind,
        ConnectorErrorKind::Configuration
    );
}

#[tokio::test]
async fn receipt_and_status_execution_bindings_are_enforced() {
    let (base, _) = fixture().await;
    let provider = provider(ConnectorType::RestApi);
    let resolver = LocalSecretResolver::empty();
    let request = request(&provider);
    assert_eq!(
        runtime()
            .execute(
                &rest_profile(&base, "/bad-receipt"),
                &provider,
                &request,
                &resolver,
            )
            .await
            .unwrap_err()
            .kind,
        ConnectorErrorKind::BindingMismatch
    );

    let execute_profile = rest_profile(&base, "/execute");
    runtime()
        .execute(&execute_profile, &provider, &request, &resolver)
        .await
        .unwrap();
    let mut mismatched_status = execute_profile;
    mismatched_status
        .rest
        .as_mut()
        .unwrap()
        .status_path_template = Some("/status-mismatch/{execution_id}".into());
    assert_eq!(
        runtime()
            .status(
                &mismatched_status,
                &provider,
                &request,
                &request.execution_identity,
                &resolver,
            )
            .await
            .unwrap_err()
            .kind,
        ConnectorErrorKind::BindingMismatch
    );
}

#[test]
fn registry_rejects_browser_or_stdio_command_configuration() {
    let provider = provider(ConnectorType::McpTool);
    let raw = json!([{
        "version":"1",
        "execution_profile":"mcp-orders-v1",
        "connector_type":"MCP_TOOL",
        "rest":null,
        "mcp":{
            "endpoint":"https://provider.example/mcp",
            "tool":"orders.execute",
            "status_tool":"orders.status",
            "allowed_hosts":["provider.example"],
            "connect_timeout_ms":100,
            "request_timeout_ms":500,
            "maximum_response_bytes":1024,
            "redirect_cap":0,
            "bearer_secret_ref":null,
            "stdio_command":"powershell.exe"
        }
    }]);
    assert!(ConnectorRegistry::parse(&serde_json::to_vec(&raw).unwrap(), &[provider]).is_err());
}
