//! SIMULATED chain; actual router and independent file journals.
use super::*;

fn directory() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "setra35-seller-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        Pubkey::new_unique()
    ));
    std::fs::create_dir(&dir).unwrap();
    dir
}

#[tokio::test]
async fn deadline_boundaries_follow_chain_clock_over_both_transports() {
    for transport in ["rest", "mcp"] {
        for (clock, expected) in [
            (99, StatusCode::OK),
            (100, StatusCode::GONE),
            (101, StatusCode::GONE),
        ] {
            let buyer = Pubkey::new_unique();
            let mint = Pubkey::new_unique();
            let encoded = base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                encode_task_state(&buyer, &mint, PRICE, 0, 100, false),
            );
            let mut state =
                state_with_fake_chain_clock(json!({"data":[encoded,"base64"]}), Some(clock)).await;
            state.mint = mint;
            let response=seller_server::build_router(state).oneshot(Request::builder().method("POST").uri("/tasks/7").header("content-type","application/json").header("setra-transport",transport).body(Body::from(json!({"buyer":buyer.to_string(),"input":{},"service_id":"legacy-rest"}).to_string())).unwrap()).await.unwrap();
            assert_eq!(
                response.status(),
                expected,
                "{transport} at chain time {clock}"
            );
            if expected == StatusCode::GONE {
                assert_eq!(body_json(response).await["now"], clock);
            }
        }
    }
}

#[tokio::test]
async fn corrupted_but_valid_json_result_is_not_replayed() {
    let (mut state, buyer) = retry_fixture().await;
    let dir = directory();
    state.execution_store = Some(dir.clone());
    let first = retry_post(state.clone(), buyer, json!({}), "legacy-rest").await;
    assert_eq!(first.status(), StatusCode::OK);
    let _ = body_json(first).await;
    let file = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "json"))
        .unwrap();
    let mut stored: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    if stored
        .get("result")
        .and_then(|v| v.get("result_hash"))
        .is_some()
    {
        stored["result"]["result"] = json!({"tampered":true});
    } else {
        stored["result"] = json!({"tampered":true});
    }
    std::fs::write(&file, serde_json::to_vec(&stored).unwrap()).unwrap();
    state.results.lock().unwrap().clear();
    let response = retry_post(state, buyer, json!({}), "legacy-rest").await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn simultaneous_independent_seller_instances_converge_or_require_reconciliation() {
    let (mut state, buyer) = retry_fixture().await;
    state.execution_store = Some(directory());
    let mut other = state.clone();
    other.results = Arc::new(Mutex::new(HashMap::new()));
    let (first, second) = tokio::join!(
        retry_post(state.clone(), buyer, json!({}), "legacy-rest"),
        retry_post(other, buyer, json!({}), "legacy-rest")
    );
    let codes = [first.status(), second.status()];
    assert!(codes
        .iter()
        .all(|s| *s == StatusCode::OK || *s == StatusCode::CONFLICT));
    assert!(codes.contains(&StatusCode::OK));
    let canonical =
        body_json(retry_post(state.clone(), buyer, json!({}), "legacy-rest").await).await;
    let replay = body_json(retry_post(state, buyer, json!({}), "legacy-rest").await).await;
    assert_eq!(canonical, replay);
}

#[tokio::test]
async fn truncated_result_preserves_execution_intent_and_fails_closed() {
    let (mut state, buyer) = retry_fixture().await;
    let dir = directory();
    state.execution_store = Some(dir.clone());
    assert_eq!(
        retry_post(state.clone(), buyer, json!({}), "legacy-rest")
            .await
            .status(),
        StatusCode::OK
    );
    let file = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "json"))
        .unwrap();
    std::fs::write(file, b"{").unwrap();
    state.results.lock().unwrap().clear();
    assert_eq!(
        retry_post(state, buyer, json!({}), "legacy-rest")
            .await
            .status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert!(std::fs::read_dir(dir).unwrap().any(|e| e
        .unwrap()
        .path()
        .extension()
        .is_some_and(|s| s == "intent")));
}
