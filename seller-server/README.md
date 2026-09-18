# seller-server

Role B's deliverable from `TaskAnchor_Architecture_Plan.md`, Section 3.2 — the Axum HTTP
server implementing the 402-payment-required flow and on-chain escrow verification. This
is real, working code, not the abbreviated scaffolding shown in the architecture doc.

## What's here vs. what isn't

This is **only** Role B's piece. Role A's Anchor program and Role C's buyer agent /
verifier aren't part of this delivery, which affects two things here:

1. **`src/task_state.rs`** defines `TaskState`/`TaskStatus`/the seed constants locally,
   instead of importing them from Role A's `task-anchor-types` crate as the architecture
   doc designs it (Section 3.2). That crate doesn't exist yet because Role A's work
   wasn't part of this request. The byte layout in `task_state.rs` matches what the doc
   specifies exactly, so once that crate exists, delete `task_state.rs` and change the
   handful of `use crate::task_state::...` imports to `use task_anchor_types::...` — the
   rest of the server doesn't need to change.
2. **There's no deployed program to run this against.** `cargo test` covers everything
   that doesn't need one (see below). To actually run the server end-to-end you need
   Role A's program deployed to a local validator and its `PROGRAM_ID`/`MINT`/etc — see
   `.env.example`.

## Why raw TCP instead of a HTTP client crate

The architecture doc's scaffolding assumed a full Rust/Anchor toolchain. This
environment's Rust toolchain is capped at **1.75** (no `rustup` access — only what's
installable via `apt`), and the natural choices both fail to compile under it:

- `reqwest` pulls in `idna`/`icu_*` (for internationalized URL parsing), and recent
  releases of those require a newer Cargo edition than 1.75 supports.
- `anchor-lang` / `solana-client` pull in most of `solana-sdk`, which has the same
  problem several layers deep, plus its own MSRV has moved past 1.75.

Rather than fight transitive dependency versions, `src/rpc.rs` sends the one JSON-RPC
call this server ever needs (`getAccountInfo`) as a hand-built HTTP/1.1 POST over a
`tokio::net::TcpStream`. It's a deliberately narrow client — no redirects, no
keep-alive, no TLS — and it should stay that way; if this server ever needs more RPC
methods, that's the point to reconsider a real client crate instead of growing this file.

PDA derivation is **not** hand-rolled, though — that needs a correct check for whether a
point is on the ed25519 curve, which isn't something to reimplement from scratch. It uses
`solana-pubkey` (the official crate, now split out from the `solana-sdk` monolith),
pinned to `2.2.1` — the newest version whose own source still builds under Rust 1.75
(`2.3.0`+ uses a `std::hash::DefaultHasher` API that needs a newer stdlib). `zeroize` is
separately pinned to `1.8.2` for the same reason, one level down in the dependency tree.
All of this was verified by actually compiling it in this environment, not assumed.

## Building and testing

```bash
cargo build          # compiles cleanly, ~50s from a cold cache
cargo test           # 16 tests, all offline — no validator, no network access needed
```

The test suite covers three layers:

- `src/task_state.rs` — the account decoder round-trips against hand-encoded bytes in
  the same layout Anchor would produce, including rejecting truncated data and unknown
  status tags.
- `src/pda.rs` — derivation is deterministic and collision-free across different
  buyers/task_ids (can't check it against a real deployed program without Role A's
  work, but determinism and non-collision are the properties this server actually
  depends on).
- `src/rpc.rs` and `tests/handlers_test.rs` — a fake TCP server stands in for the
  validator's RPC endpoint, so the full request-handling logic (402 on no payment, 200
  on valid payment, 409 on an already-settled task, 402 again on an underpaid task, 404
  on an unexecuted task's result) is tested against the real `axum::Router` via
  `tower::ServiceExt::oneshot` — no live validator required.

## Running it standalone

```bash
cp .env.example .env
# fill in PROGRAM_ID, MINT, SELLER_TOKEN_ACCOUNT, VERIFIER from Role A's deployment
export $(cat .env | grep -v '^#' | xargs)
cargo run
```

Without a real validator behind `RPC_HOST`/`RPC_PORT`, every request will fail at the
RPC call with a 500 (connection refused) rather than a meaningful 402/200 — that's
expected and matches what "Role A hasn't deployed yet" looks like in practice. Point it
at a real `solana-test-validator` (architecture doc, Section 3.1) with Role A's program
deployed to see the actual 402 → pay → 200 flow.

## API

`POST /tasks/:task_id`
```jsonc
// request
{ "buyer": "<base58 pubkey>", "input": { /* task-specific JSON */ } }

// 402 response (no valid payment found yet)
{
  "task_id": 7, "program_id": "...", "task_state_pda": "...", "vault_pda": "...",
  "mint": "...", "seller_token_account": "...", "verifier": "...",
  "amount": 1500000, "timeout_seconds": 180
}

// 200 response (payment confirmed on-chain)
{ "input": { /* echoed back */ }, "output_hash": "<sha256 hex>" }

// 409 response (task already settled or refunded)
{ "error": "task already settled or refunded", "status": "Settled" }
```

`GET /tasks/:task_id/result` → the same 200 body as above, or 404 if the task hasn't
been executed yet.
