//! A deliberately minimal Solana JSON-RPC client: one method
//! (`getAccountInfo`), sent as a raw HTTP/1.1 POST over a `tokio::net::TcpStream`.
//!
//! This exists instead of pulling in `reqwest` or `solana-client` because,
//! in this environment's constrained toolchain, both drag in transitive
//! dependencies (`idna`/`icu_*` for the former, most of `solana-sdk` for
//! the latter) that require a newer Rust edition than is available here —
//! see the README's "Why raw TCP instead of a HTTP client crate" section.
//! For the one JSON-RPC call this server ever makes, hand-rolling the
//! request is a reasonable trade, not a shortcut on correctness: the wire
//! format (JSON-RPC 2.0 over HTTP/1.1) is simple and well-specified.
//!
//! This is not a general-purpose HTTP client — no redirects, no keep-alive,
//! no TLS. It shouldn't become one; if this server ever needs more than
//! `getAccountInfo`, that's the point to reconsider pulling in a real
//! client crate instead of growing this file.

use base64::Engine as _;
use serde_json::{json, Value};
use solana_pubkey::Pubkey;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[derive(Debug, thiserror::Error)]
pub enum RpcError {
    #[error("could not reach RPC endpoint at {0}: {1}")]
    Connect(String, std::io::Error),
    #[error("network error talking to RPC endpoint: {0}")]
    Io(#[from] std::io::Error),
    #[error("RPC endpoint returned a response this client couldn't parse")]
    MalformedResponse,
    #[error("RPC endpoint returned invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("RPC endpoint returned an error: {0}")]
    RpcError(String),
}

#[derive(Clone)]
pub struct RpcClient {
    host: String,
    port: u16,
}

impl RpcClient {
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
        }
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let request_body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        })
        .to_string();

        let http_request = format!(
            "POST / HTTP/1.1\r\n\
             Host: {}:{}\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\
             \r\n\
             {}",
            self.host,
            self.port,
            request_body.len(),
            request_body,
        );

        let mut stream = TcpStream::connect((self.host.as_str(), self.port))
            .await
            .map_err(|e| RpcError::Connect(format!("{}:{}", self.host, self.port), e))?;
        stream.write_all(http_request.as_bytes()).await?;
        stream.shutdown().await.ok();

        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await?;

        let text = String::from_utf8_lossy(&raw);
        let body_start = text.find("\r\n\r\n").ok_or(RpcError::MalformedResponse)? + 4;
        let body = &text[body_start..];

        let parsed: Value = serde_json::from_str(body)?;
        if let Some(err) = parsed.get("error") {
            return Err(RpcError::RpcError(err.to_string()));
        }
        parsed
            .get("result")
            .cloned()
            .ok_or(RpcError::MalformedResponse)
    }

    /// `Ok(None)` means the account doesn't exist yet — on this server,
    /// that's a normal "not paid yet" outcome, not an error (Section 4 of
    /// the architecture doc: never treat a missing PDA as a crash).
    pub async fn get_account_data(&self, pubkey: &Pubkey) -> Result<Option<Vec<u8>>, RpcError> {
        let result = self
            .call(
                "getAccountInfo",
                json!([pubkey.to_string(), {"encoding": "base64"}]),
            )
            .await?;

        let value = &result["value"];
        if value.is_null() {
            return Ok(None);
        }
        let data_b64 = value["data"][0]
            .as_str()
            .ok_or(RpcError::MalformedResponse)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_b64)
            .map_err(|_| RpcError::MalformedResponse)?;
        Ok(Some(bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    /// Spins up a fake RPC endpoint on localhost that reads one HTTP
    /// request and replies with a canned JSON-RPC response, so the parsing
    /// logic above can be exercised without a real validator.
    async fn fake_rpc_server(response_result: Value) -> (String, u16) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf).await; // drain the request, ignore its content

            let body = json!({"jsonrpc": "2.0", "id": 1, "result": response_result}).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        });

        (addr.ip().to_string(), addr.port())
    }

    #[tokio::test]
    async fn returns_none_when_account_does_not_exist() {
        let (host, port) = fake_rpc_server(json!({"context": {"slot": 1}, "value": null})).await;
        let client = RpcClient::new(host, port);
        let result = client.get_account_data(&Pubkey::new_unique()).await.unwrap();
        assert_eq!(result, None);
    }

    #[tokio::test]
    async fn decodes_base64_account_data_when_present() {
        let raw_bytes = vec![1u8, 2, 3, 4, 5];
        let encoded = base64::engine::general_purpose::STANDARD.encode(&raw_bytes);
        let (host, port) = fake_rpc_server(json!({
            "context": {"slot": 1},
            "value": {"data": [encoded, "base64"], "lamports": 1000, "owner": "11111111111111111111111111111111"}
        }))
        .await;
        let client = RpcClient::new(host, port);
        let result = client.get_account_data(&Pubkey::new_unique()).await.unwrap();
        assert_eq!(result, Some(raw_bytes));
    }

    #[tokio::test]
    async fn surfaces_rpc_errors_instead_of_panicking() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf).await;
            let body = json!({"jsonrpc": "2.0", "id": 1, "error": {"code": -32602, "message": "invalid params"}}).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(), body
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        });

        let client = RpcClient::new(addr.ip().to_string(), addr.port());
        let result = client.get_account_data(&Pubkey::new_unique()).await;
        assert!(matches!(result, Err(RpcError::RpcError(_))));
    }
}
