# Phase 3B audit

Starting commit: `22b4858004848607647cea763ac27b0cbe2524a7`.

## Implemented

REST and `McpTransport` normalize into the existing TaskQuote and ResultEnvelopeV1 contracts. The local Streamable HTTP seller adapter has generic `discover_services` and `protected_call` tools. Discovery reads `/services` from the authoritative seller registry; it has no service list of its own. The stdio buyer adapter exposes discovery, protected calls, explicit funding, real chain status and eligible refunds. Both transports invoke BuyerOrchestrator, VerificationEngine and the same SettlementCoordinator instance created by the runtime. The adapter has no financial implementation.

Seller results are keyed by TaskState PDA (buyer + task ID), claimed exclusively, persisted atomically and replayed. Changed input/service is rejected. Durable unresolved execution intents fail closed after a crash. Buyer quote/funding/result journals prevent repeated execution and funding after restart. Unknown outcomes require reconciliation; this MVP does not automatically clear orphan intents.

MCP accepts strict u64 decimal strings, canonical bounded object input, pubkeys, service slugs and boolean privacy. Privileged/unknown fields are rejected. Local HTTP binds loopback, rejects browser Origin and unexpected Host, limits request bytes and time, and offers POST JSON responses (GET returns 405). Signing keys are loaded from server configuration and never accepted through tools or returned.

Protocol reference: [MCP 2025-03-26 transports](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports).

## Tested and simulated

- Seller: **49 passed** (18 unit + 31 handler tests), including the original 43. One original fixture now uses a separate task ID for its invalid second submission; all assertions remain.
- Anchor: **5 passed**, including private settlement, on-chain duplicate nullifier, cancellation and timeout refund.
- Buyer unit: **161 passed**.
- Buyer integration: **77 passed**.
- Buyer live E2E: **20 passed**.
- Real Docker sandbox: **14 passed**.
- Unique cumulative total: **326 passed, 0 failed**. Focused suites overlap these totals.

Exact commands from repository/buyer-agent respectively:

```text
cargo test --manifest-path seller-server/Cargo.toml
npx ts-mocha -p ./tsconfig.json -t 1000000 tests/setra402.ts
npm run build
npm run build:runtime
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:l2
npm run test:mcp
```

The six REST/MCP report parity integration scenarios use a simulated chain/sandbox and the production engine/coordinator. Live L2 tests use deterministic local seller/source fixtures, actual chain transactions and actual Docker. Terminal tests exercise actual seller, Redis, core and chain through MCP tool dispatch, and one complete task passes through a real stdio child process. Source fixture HTTP allowlists are test-only. Production defaults remain HTTPS with domain/IP checks.

## Failures fixed

The old seller fixture reused an executed task ID with a changed input; independent task IDs preserve its intent under the new retry contract. WSL stopped the test validator and cleared ephemeral `/tmp` fixtures; restarting the validator and recreating local token fixtures restored live tests. No application check was bypassed. Rustfmt-only changes in unrelated seller files were removed.

## Exit gate

- [x] Registry discovery, payment challenge, funding, retry and idempotency.
- [x] L1 and both L2 adapters over MCP; failures never settle or cancel.
- [x] REST/MCP policy, envelope, report and settlement parity.
- [x] Same SettlementCoordinator; no duplicate financial logic.
- [x] Public/private, expiration, Phase 1/2/3A, Role B and Anchor regression.
- [x] Bounded hostile input; no keys exposed.
- [x] No frontend, onboarding or Phase 4 code in this commit.

## Terminal usage and limitations

Build with `npm run build:runtime`. Start the seller adapter with `SELLER_URL` and `npm run mcp:server`. Configure the buyer stdio client to execute `node` with the absolute `buyer-agent/dist/mcp/stdio.js` path. Supply the existing buyer configuration variables plus `EXPECTED_MINT` and `MCP_URL` server-side. Call `discover_services`, then `protected_call`; fund the returned quote with `fund_task`, retry `protected_call`, and inspect `task_status` or request `refund_task` after chain eligibility. No browser is required. Use direct `node` for stdio so npm banners do not enter protocol stdout.

The adapters are local, preconfigured and unauthenticated. No durable refund scheduler exists. The control plane does not automatically reconcile ambiguous effects. Current runner support and sandbox availability limits remain those recorded in Phase 3A. Phase 3C and Phase 4 are deferred at this gate.
