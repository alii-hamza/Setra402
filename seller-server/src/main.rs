use seller_server::{build_router, config::AppState};

#[tokio::main]
async fn main() {
    let state = match AppState::from_env() {
        Ok(state) => state,
        Err(e) => {
            eprintln!("config error: {e}");
            eprintln!("see .env.example for the required environment variables");
            std::process::exit(1);
        }
    };

    let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:3000".to_string());
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .unwrap_or_else(|e| panic!("could not bind to {bind_addr}: {e}"));

    println!("seller-server listening on {bind_addr}");
    println!("RPC endpoint: {}:{}", std::env::var("RPC_HOST").unwrap_or_else(|_| "127.0.0.1".into()), std::env::var("RPC_PORT").unwrap_or_else(|_| "8899".into()));

    axum::serve(listener, build_router(state))
        .await
        .expect("server error");
}
