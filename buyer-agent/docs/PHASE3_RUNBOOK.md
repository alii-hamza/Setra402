# Phase 3 local runbook

Phase 3 runs one seller registry, two buyer transports and the existing buyer core. A local provider registration is configuration; it grants no signing authority. Signing remains in the server-side SettlementCoordinator.

## Prerequisites

Install repository dependencies as for Phase 2. Supply a running validator with the existing program, funded buyer token account, Redis, seller server, Docker with the pinned runner image and Chrome/Playwright for browser tests. Node 22.19.0 was tested. No dependency downgrade or program change is required.

The Docker runner image is pinned in `src/verification/level2/default-runners.ts`. Pull that exact image before starting verification; execution uses `--pull never` and fails closed if unavailable. A non-root container UID, read-only root/input, isolated tmpfs, disabled network/capabilities, CPU/memory/PID/output/time limits and cleanup are enforced. The test host uses the existing WSL Docker daemon; this does not claim a rootless daemon or hardware isolation.

For browser tests install Playwright locally, or set `SETRA_BROWSER_PACKAGE_DIR` to the desktop dependency bundle's `node/node_modules` directory returned by the workspace dependency tool. Tests use an isolated headless Chrome profile, never your authenticated browser profile.

## Server configuration

The seller retains the Phase 2 variables `RPC_HOST`, `RPC_PORT`, `PROGRAM_ID`, `MINT`, `SELLER_TOKEN_ACCOUNT`, `VERIFIER`, `PROTOCOL_TREASURY`, `REDIS_URL`, and its optional global legacy price/timeout. Set `SETRA_EXECUTION_STORE` to a durable local directory. Baseline service definitions remain unchanged. `GET /services` publishes their effective legacy runtime price/timeout; local services use their own validated price/timeout.

The web/buyer runtime uses:

```text
PROGRAM_ID
RPC_URL
SELLER_URL
EXPECTED_MINT
BUYER_KEYPAIR_PATH
VERIFIER_KEYPAIR_PATH
PROTOCOL_TREASURY_ADDRESS
SETTLEMENT_SAFETY_MARGIN_SEC
SETRA_STATE_DIR                 optional; defaults to .setra-state
SETRA_SERVICE_OVERLAY           optional absolute local JSON path
SETRA_ONBOARDING_WRITE_ENABLED  optional; defaults to false
MCP_PORT                       optional; defaults to 3002
WEB_PORT                       optional; defaults to 3003
```

Seller and control plane must use the same `SETRA_SERVICE_OVERLAY`. Both default to `seller-server/config/services.local.json`. It and write locks/temporary files are gitignored. Registration validates the shared policy, checks the server profile and trusted bundle, computes the canonical hash, locks and atomically replaces the overlay, then reads back through seller discovery. Malformed overlays leave baseline discovery intact and block onboarding writes. Duplicate IDs are rejected.

Run from `buyer-agent`:

```text
npm run web
```

Open `http://127.0.0.1:3003`. This starts the seller MCP adapter on loopback port 3002 and the three-screen control plane. Writes are disabled by default. For local/hackathon onboarding, explicitly set `SETRA_ONBOARDING_WRITE_ENABLED=true` before starting. This is not a production authenticated admin system. The runtime rejects cross-origin/foreign-Host requests and requires a per-process CSRF token for mutations; that token is not an admin credential. Financial secrets never enter client assets or the browser configuration response.

Only the four server-owned fixture profiles are supported in this MVP. No connector credentials are provisioned. Source fixture URL configuration is server-side (`SETRA_FIXTURE_SOURCE_URL`); production independent retrieval still requires HTTPS and the committed domain allowlist, with public pinned DNS/IP and redirect checks. Local HTTP/source allowlists exist only in tests under `NODE_ENV=test`; the production launcher offers no bypass.

## Terminal MCP flow

For a standalone seller adapter:

```text
npm run mcp:server
```

Build the buyer runtime with `npm run build:runtime`. Configure an MCP client to run `node` with the absolute `dist/mcp/stdio.js` path. Supply the buyer configuration above plus `MCP_URL=http://127.0.0.1:3002/mcp`. Do not use an npm command that prints a banner on protocol stdout.

Call `discover_services`, then `protected_call` with strict `task_id` (u64 decimal string), `buyer` (configured public key), `service_id`, `is_private`, and object `input`. The first response contains `payment_required` and the validated quote. Explicitly call `fund_task`, then retry the same `protected_call`. The shared orchestrator executes, verifies, and calls SettlementCoordinator only for a passing report. `task_status` reads chain state/time; `refund_task` works only at the chain deadline. No browser is needed.

Retries retain the original quote, input and result. Changed service/input/privacy under the same buyer/task ID is rejected. Seller exclusive execution intents and buyer journals persist across restart. Orphan intents represent unknown effects and require operator reconciliation; never clear them simply to repeat a task. The MVP has no automated reconciliation or durable refund scheduler.

## Regression commands

Supply `ROLE_C_RPC_URL`, `ROLE_C_SELLER_URL`, `ROLE_C_PROGRAM_ID`, `ROLE_C_EXPECTED_MINT`, `ROLE_C_PROTOCOL_TREASURY`, `ROLE_C_BUYER_KEYPAIR_PATH`, and `ROLE_C_VERIFIER_KEYPAIR_PATH`. On the tested Windows/WSL host set `ROLE_C_DOCKER_WSL=1`; otherwise use local Docker. These are test environment settings, not browser inputs.

```text
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:rest
npm run test:mcp
npm run test:l1
npm run test:l2
npm run test:privacy
npm run test:onboarding
npm run test:web
npm run test:all
```

`test:all` builds/typechecks, runs disjoint buyer unit/integration/live E2E/sandbox/browser suites, format checks, seller tests, Anchor tests and `git diff --check`. Any failed command exits non-zero. Focused commands overlap the disjoint suites and must not be added to unique totals. Original Role A instructions/economics/PDA seeds and original Role B assertions are preserved.

The focused MCP/onboarding commands need an up-to-date runtime build for their stdio/live fixtures. `test:e2e` and `test:all` build it automatically.

Phase 4 is deferred. No TEE, ZK, multi-attestor, AI integration, marketplace, billing or account platform is implemented.
