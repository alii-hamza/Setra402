pub mod config;
pub mod execute;
pub mod handlers;
pub mod pda;
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
        .route("/tasks/:task_id", post(handlers::handle_task))
        .route("/tasks/:task_id/result", get(handlers::get_result))
        // Phase 3 Cryptographic Endpoints
        .route("/mint/blind-sign", post(handlers::handle_blind_sign))
        .route("/verifier/nullify", post(handlers::handle_nullify))
        .with_state(state)
}
