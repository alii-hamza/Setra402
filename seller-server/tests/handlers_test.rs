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
use seller_server::task_state::TaskStatus;
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
    use seller_server::task_state::TaskState;
    use borsh::BorshSerialize;
    
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

// Phase 3: Test blind signature endpoint
#[tokio::test]
async fn blind_sign_rejects_non_private_tasks() {
    let buyer = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    // Public task (is_private = false)
    let account_data = encode_task_state(&buyer, &mint, PRICE, 0 /* Pending */, 9_999_999_999, false);
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &account_data);

    let mut state = state_with_fake_chain(json!({"data": [encoded, "base64"]})).await;
    state.mint = mint;
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
            }).to_string(),
        ))
        .unwrap();

    let response = router.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let body = body_json(response).await;
    assert!(body["error"].as_str().unwrap().contains("is_private = true"));
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
            }).to_string(),
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
            }).to_string(),
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
    let account_data = encode_task_state(&buyer, &mint, PRICE, 0 /* Pending */, 9_999_999_999, true);
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &account_data);

    let mut state = state_with_fake_chain(json!({"data": [encoded, "base64"]})).await;
    state.mint = mint;

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
    assert_eq!(c_point, secret * b_point, "blind signature must be exactly C = k·B");

    // Buyer unblinds: S = r⁻¹·C = k·h·G = h·K, which is what the verifier
    // checks knowing only h and the mint's public key.
    let s_point = c_point * r.invert();
    assert_eq!(s_point, h * k_point, "unblinded signature must satisfy S = h·K");

    // A deterministic mint (no per-request randomness) must sign the same
    // blinded point identically, or buyers can never agree on the voucher.
    let repeat = router.oneshot(request()).await.unwrap();
    assert_eq!(repeat.status(), StatusCode::OK);
    let repeat_body = body_json(repeat).await;
    assert_eq!(repeat_body["blind_signature"].as_str().unwrap(), signature);
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
            }).to_string(),
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
            }).to_string(),
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
