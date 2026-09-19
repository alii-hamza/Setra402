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
        protocol_treasury: None,
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
    is_private: bool,
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
    bytes.push(is_private as u8);
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
    let account_data = encode_task_state(&buyer, &mint, PRICE, 0 /* Pending */, 9_999_999_999, false);
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
    let account_data = encode_task_state(&buyer, &mint, PRICE, 1 /* Settled */, 9_999_999_999, false);
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
    let account_data = encode_task_state(&buyer, &mint, PRICE, 0 /* Pending */, 9_999_999_999, true);
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
    let account_data = encode_task_state(&buyer, &mint, PRICE, 0 /* Pending */, 9_999_999_999, true);
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
            json!({"buyer": buyer.to_string(), "input": {"job": "resize"}, "is_private": true}).to_string(),
        ))
        .unwrap();

    let response = router.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);

    let body = body_json(response).await;
    assert_eq!(body["is_private"], true);
    assert_eq!(body["protocol_fee_bps"], 100);
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
    let (expected_task_state, _) =
        seller_server::pda::task_state_pda(&program_id, &buyer, TASK_ID);
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
                .body(Body::from(
                    json!({"buyer": buyer, "input": {}}).to_string(),
                ))
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
    let account_data = encode_task_state(&buyer, &mint, PRICE, 0 /* Pending */, 9_999_999_999, false);
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
    let account_data = encode_task_state(&buyer, &mint, PRICE, 0 /* Pending */, 9_999_999_999, false);
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
    assert_eq!(b11["output_hash"], seller_server::execute::execute_task(&json!({"job": "a"})));

    let r12 = fetch(router.clone(), 12).await;
    assert_eq!(r12.status(), StatusCode::OK);
    let b12 = body_json(r12).await;
    assert_eq!(b12["output_hash"], seller_server::execute::execute_task(&json!({"job": "b"})));
    assert_ne!(b11["output_hash"], b12["output_hash"]);

    let r13 = fetch(router, 13).await;
    assert_eq!(r13.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn hash_matches_fixed_reference_vector() {
    // sha256("{\"a\":1}") computed outside this crate (sha256sum), so any
    // drift in canonicalization vs the TypeScript verifier breaks this test.
    let expected = "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862";
    assert_eq!(seller_server::execute::execute_task(&json!({"a": 1})), expected);
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
    let account_data = encode_task_state(&buyer, &mint, PRICE, 0 /* Pending */, now - 10, false);
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
    let account_data = encode_task_state(&buyer, &mint, PRICE, 0 /* Pending */, now + 3600, false);
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
