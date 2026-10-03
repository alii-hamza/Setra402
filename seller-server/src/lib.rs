pub mod config;
pub mod execute;
pub mod execution_store;
pub mod handlers;
pub mod mint_store;
pub mod pda;
pub mod registry;
pub mod rpc;
pub mod task_state;

use axum::routing::{get, post};
use axum::Router;
use config::AppState;

/// Builds the app's routes against a given `AppState`. Split out from
/// `main` so integration tests (see `tests/`) can build the same router
/// against a state pointed at a fake RPC endpoint, instead of duplicating
/// the route table.
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/services", get(handlers::list_services))
        .route("/services/:service_id", get(handlers::get_service))
        .route("/tasks/:task_id", post(handlers::handle_task))
        .route("/tasks/:task_id/result", get(handlers::get_result))
        .route(
            "/tasks/:task_id/execution-evidence",
            get(handlers::get_execution_evidence),
        )
        .route("/tasks/:task_id/artifacts/:id", get(handlers::get_artifact))
        .route("/fixtures/company", get(handlers::fixture_source))
        // Phase 3 Cryptographic Endpoints
        .route("/mint/blind-sign", post(handlers::handle_blind_sign))
        .route("/mint/issuance/:task_id", get(handlers::get_mint_issuance))
        .route("/verifier/nullify", post(handlers::handle_nullify))
        .with_state(state)
}
