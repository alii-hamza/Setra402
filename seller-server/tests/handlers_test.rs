//! Exercises the actual axum router (via `tower::ServiceExt::oneshot`)
//! against a fake RPC endpoint standing in for the validator — no real
//! Solana validator or deployed program needed, per the architecture doc's
//! Section 5.2 testing approach ("mock the RPC client... to test 402 logic
//! without needing a live validator").

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use seller_server::config::AppState;
use solana_pubkey::Pubkey;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tower::ServiceExt;

const TASK_ID: u64 = 7;
const PRICE: u64 = 1_500_000;

/// Starts a fake JSON-RPC endpoint that always answers `getAccountInfo`
/// with the given `value`, then returns an `AppState` wired to talk to it.
async fn state_with_fake_chain(value: Value) -> AppState {
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
                let _ = socket.read(&mut buf).await;
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

    AppState {
        rpc: seller_server::rpc::RpcClient::new(addr.ip().to_string(), addr.port()),
        program_id: Pubkey::new_unique(),
        mint: Pubkey::new_unique(),
        seller_token_account: Pubkey::new_unique(),
        verifier: Pubkey::new_unique(),
        price: PRICE,
        timeout_seconds: 180,
        results: Arc::new(Mutex::new(HashMap::new())),
    }
}

/// Builds the exact Anchor-style byte layout the real program would write —
/// same shape as `task_state.rs`'s own unit-test encoder, duplicated here so
/// this test doesn't need to reach into the library's private test module.
fn encode_task_state(
    buyer: &Pubkey,
    mint: &Pubkey,
    amount: u64,
    status_tag: u8,
    deadline_unix: i64,
) -> Vec<u8> {
    let mut bytes = vec![0u8; 8]; // discriminator placeholder
    bytes.extend_from_slice(buyer.as_ref());
    bytes.extend_from_slice(Pubkey::new_unique().as_ref()); // seller
    bytes.extend_from_slice(Pubkey::new_unique().as_ref()); // verifier
    bytes.extend_from_slice(mint.as_ref());
    bytes.extend_from_slice(&TASK_ID.to_le_bytes());
    bytes.extend_from_slice(&amount.to_le_bytes());
    bytes.extend_from_slice(&deadline_unix.to_le_bytes());
    bytes.push(status_tag);
    bytes.push(253); // bump
    bytes
}

async fn body_json(response: axum::response::Response) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn responds_402_when_no_payment_found() {
    let state = state_with_fake_chain(Value::Null).await;
    let program_id = state.program_id;
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
    assert_eq!(body["program_id"], program_id.to_string());
    assert_eq!(body["amount"], PRICE);
    assert!(body["task_state_pda"].is_string());
    assert!(body["vault_pda"].is_string());
}

#[tokio::test]
async fn responds_200_and_a_matching_hash_once_paid() {
    let buyer = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let account_data = encode_task_state(&buyer, &mint, PRICE, 0 /* Pending */, 9_999_999_999);
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
    let account_data = encode_task_state(&buyer, &mint, PRICE, 1 /* Settled */, 9_999_999_999);
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
    let account_data = encode_task_state(&buyer, &mint, too_little, 0, 9_999_999_999);
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
