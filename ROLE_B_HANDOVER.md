# Role B Handover to Role C - Seller Server Integration Complete

## Overview
Role B (Seller Server Engineer) has completed the integration of the seller-server with the Setra402 on-chain program. The seller-server is now ready for Role C (Agent & Verifier Engineer) to build the buyer agent and verifier components.

## What Was Completed

### Seller Server Integration ✅
- **Location**: `/Setra402/seller-server/`
- **Status**: Fully integrated and tested via Docker
- **Branch**: `feature/seller-server-integration`

### Key Changes Made

#### 1. Task State Schema (`src/task_state.rs`)
- Added `is_private: bool` field to TaskState struct
- Added `NULLIFIER_SEED` constant
- Updated decoder to handle the new field
- Updated all tests for the new field

#### 2. Payment Quote Structure (`src/config.rs`)
- Added `is_private: bool` to PaymentQuote
- Added `protocol_fee_bps: u64` to PaymentQuote (100 = 1%)
- Added fee constants: `PROTOCOL_FEE_BPS`, `CANCEL_PENALTY_BPS`, `BPS_DENOMINATOR`
- Added `is_private` field to TaskRequest (default: false)
- Added optional `protocol_treasury` to AppState

#### 3. PDA Derivation (`src/pda.rs`)
- Added `nullifier_pda()` function for private settlement nullifier records
- Updated imports to include NULLIFIER_SEED
- Added tests for nullifier PDA derivation

#### 4. Handler Logic (`src/handlers.rs`)
- Updated `payment_required()` to include `is_private` parameter
- Updated payment quote generation to include fee structure
- Added privacy mismatch validation
- Updated all payment_required calls to pass is_private flag

#### 5. Configuration (`src/config.rs`)
- Added fee constants matching on-chain program
- Updated AppState to include optional protocol_treasury
- Added environment variable handling for PROTOCOL_TREASURY

#### 6. Environment Variables (`.env.example`)
- Added `PROTOCOL_TREASURY` variable with documentation

#### 7. Tests (`tests/handlers_test.rs`)
- Updated `encode_task_state()` to include is_private parameter
- Updated all existing test calls
- Added test for private task handling
- Added test for privacy mismatch validation
- Added test for payment quote with private flag

#### 8. Docker Setup
- Created `Dockerfile` for seller-server (multi-stage build)
- Created `Dockerfile.validator` for local Solana validator
- Created `docker-compose.dev.yml` for development environment
- Created `.dockerignore` for efficient builds

## HTTP Contract for Role C

### Endpoints

#### POST /tasks/:task_id
**Request:**
```json
{
  "buyer": "string (pubkey)",
  "input": "object (task input)",
  "is_private": "boolean (optional, default false)"
}
```

**Response 402 Payment Required:**
```json
{
  "task_id": "number",
  "program_id": "string",
  "task_state_pda": "string",
  "vault_pda": "string",
  "mint": "string",
  "seller_token_account": "string",
  "verifier": "string",
  "amount": "number",
  "timeout_seconds": "number",
  "is_private": "boolean",
  "protocol_fee_bps": "number"
}
```

**Response 200 OK:**
```json
{
  "input": "object",
  "output_hash": "string (SHA-256)"
}
```

#### GET /tasks/:task_id/result
**Response 200 OK:**
```json
{
  "input": "object",
  "output_hash": "string"
}
```

**Response 404 Not Found:** Task result not available

### Important Notes for Role C

1. **Privacy Flag**: The `is_private` flag must match between the request and the on-chain task state
2. **Fee Structure**: Protocol fee is 1% (100 BPS) - this is communicated in the payment quote
3. **Hash Calculation**: The seller-server uses SHA-256 of canonical JSON (sorted keys)
4. **Error Handling**: Privacy mismatch returns 400 BAD_REQUEST

## On-Chain Program Details

### Program ID
`FUjN9K7C5yHr5NhVrJ7WCgifgDiBJnSDDGQjnNkUDBMN`

### Instructions Available
1. `initialize_task(task_id, amount, timeout_seconds, is_private)`
2. `settle_task(task_id)` - Standard settlement with 1% fee
3. `settle_task_private(task_id, nullifier)` - Private settlement with nullifier
4. `refund_task(task_id)` - Full refund after deadline
5. `cancel_task(task_id)` - Early cancellation with 5% penalty

### PDA Seeds
- **TaskState**: `[b"task", buyer_pubkey, task_id_le_bytes]`
- **Vault**: `[b"vault", task_state_pubkey]`
- **NullifierRecord**: `[b"nullifier", nullifier_32_bytes]`

### Fee Structure
- **Protocol Fee**: 100 BPS (1%) on settlements
- **Cancellation Penalty**: 500 BPS (5%) on early cancellations
- **Full Refund**: 100% after deadline

## Shared Types
**Location**: `Setra402/shared/task-anchor-types/src/lib.rs`

Role C can import these types to ensure consistency:
- `TaskStatus` enum (Pending, Settled, Refunded)
- `TaskState` struct
- `NullifierRecord` struct

## Current Environment Setup

### Docker Images Available
- `seller-server:latest` - Built and tested
- Local validator can be built via `Dockerfile.validator`

### Running the Seller Server
```bash
# Option 1: Direct Docker run
docker run -p 3000:3000 \
  -e PROGRAM_ID=FUjN9K7C5yHr5NhVrJ7WCgifgDiBJnSDDGQjnNkUDBMN \
  -e MINT=<your_mint> \
  -e SELLER_TOKEN_ACCOUNT=<seller_ata> \
  -e VERIFIER=<verifier_pubkey> \
  -e RPC_HOST=127.0.0.1 \
  -e RPC_PORT=8899 \
  seller-server

# Option 2: Docker Compose (includes validator)
cd /Setra402
docker compose -f docker-compose.dev.yml up --build
```

## What Role C Needs to Build

### 1. Buyer Agent (Node.js/TypeScript)
- HTTP client for seller-server endpoints
- Anchor TS client for on-chain program interaction
- Task ID generation (random u64)
- Payment flow orchestration:
  1. POST /tasks/:task_id (get 402 + quote)
  2. Call initialize_task on-chain
  3. POST /tasks/:task_id (retry with payment)
  4. Get result hash
  5. Wait for verification

### 2. Verifier (Node.js/TypeScript)
- GET /tasks/:task_id/result (retrieve input + output_hash)
- Recompute expected hash (must match seller-server's SHA-256 logic)
- Compare hashes
- Call appropriate settlement instruction:
  - `settle_task` for public tasks
  - `settle_task_private` for private tasks (with nullifier)
- Handle refund logic if verification fails

### 3. Deterministic Hash Function
**Critical**: Must match seller-server's SHA-256 of canonical JSON:
- Sort object keys alphabetically
- Use JSON.stringify on sorted object
- Compute SHA-256 hash
- Return hex string

### 4. Nullifier Generation (for private tasks)
- Generate cryptographically secure random 32-byte nullifier
- Use nullifier in `settle_task_private` instruction
- Ensure nullifier uniqueness (double-spend prevention)

## Integration Testing Checklist for Role C

- [ ] Buyer agent can successfully complete 402 flow
- [ ] Verifier can retrieve and recompute task results
- [ ] Hash computation matches seller-server exactly
- [ ] Public settlement flow works end-to-end
- [ ] Private settlement flow works with nullifiers
- [ ] Refund flow works after deadline
- [ ] Cancellation flow works with penalty
- [ ] All fee calculations match on-chain exactly

## Files Reference

### Seller Server Files
- `/Setra402/seller-server/src/handlers.rs` - HTTP endpoints
- `/Setra402/seller-server/src/config.rs` - Configuration and types
- `/Setra402/seller-server/src/pda.rs` - PDA derivation functions
- `/Setra402/seller-server/src/task_state.rs` - On-chain state decoding
- `/Setra402/seller-server/src/execute.rs` - Hash computation reference

### On-Chain Files
- `/Setra402/programs/setra402/src/lib.rs` - Program entrypoint
- `/Setra402/programs/setra402/src/state.rs` - Account structures
- `/Setra402/programs/setra402/src/constants.rs` - Constants and seeds
- `/Setra402/programs/setra402/src/instructions/` - All instruction implementations

### Shared Types
- `Setra402/shared/task-anchor-types/src/lib.rs` - Shared type definitions

### Documentation
- `/Setra402/SELLER_SERVER_INTEGRATION.md` - Detailed integration guide
- `/Setra402/STATE.md` - Current project state
- `/Setra402/AGENT.md` - Agent rules and invariants

## Role B Closeout Addendum

Two bugs were found and fixed during post-integration verification, and the live 402 flow was verified against a real validator:

#### Fix 1: Expired tasks no longer execute (`src/handlers.rs`)
- A Pending task past its `deadline_unix` used to execute and return 200, letting a buyer receive the output hash AND a full on-chain refund.
- The handler now rejects execution with **410 GONE** at the same boundary the on-chain `refund_task` uses (`now >= deadline_unix`).
- Buyer agents MUST handle `410` by treating the task as expired (stop retrying; refund path applies).

#### Fix 2: RPC client aborted by real Agave validators (`src/rpc.rs`)
- The client half-closed the TCP connection (`stream.shutdown()`) immediately after writing the request. Real Agave validators abort such requests and return an empty body, surfacing as `500 RPC error: couldn't parse`. Mocked tests never caught it because the fake RPC tolerated the early FIN.
- The premature shutdown was removed (`Connection: close` already handles termination). Verified live: unpaid POST returns 402 + full quote (correct PDAs, `protocol_fee_bps: 100`), private flag honored, GET result 404 before payment.

#### Docker environment notes
- Agave 4.x requires Linux `io_uring`; Docker's default seccomp profile blocks it, so the validator crashes instantly. Run with `--security-opt seccomp=unconfined` (add `security_opt: ["seccomp=unconfined"]` to the validator service in `docker-compose.dev.yml`).
- `docker-compose.dev.yml` env placeholders (`MINT_ADDRESS`, etc.) are empty by default — provide valid pubkeys or the seller-server exits at startup.

#### Test baseline
- 34 tests total (18 unit + 16 integration), passing on host Rust 1.89 AND inside the Docker builder stage (Rust 1.75).
- New tests: PDA cross-check vs `pda.rs`, per-task PDA divergence, underpaid-private 402 quote, inverse privacy mismatch, per-task result isolation + 404, fixed SHA-256 vector (`sha256("{\"a\":1}") = 015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862`), and the expired-410 / future-deadline-OK boundary pair.

## Git Status
- **Branch**: `feature/seller-server-integration`
- **Status**: Clean working tree, ready for Role C work
- **Commits**: Integration changes committed, not pushed to GitHub
- **Docker**: Images built locally, ready for use

## Key Dependencies for Role C
- `@coral-xyz/anchor` - Anchor TypeScript SDK
- `@solana/web3.js` - Solana web3 client
- Node.js crypto library for SHA-256
- HTTP client (axios or fetch) for seller-server communication

## Known Working Configuration
- **Rust**: 1.75
- **Anchor**: Latest via AVM
- **Solana CLI**: Agave (latest stable)
- **Node.js**: Recommend 18+ for TypeScript support

## Next Steps for Role C
1. Set up Node.js/TypeScript environment
2. Install Anchor TS dependencies
3. Create buyer agent script
4. Create verifier script
5. Implement deterministic hash function
6. Test against running seller-server
7. Integrate with local validator
8. End-to-end testing

## Contact & Coordination
- Seller server is running and ready for integration
- Docker environment is set up for local testing
- All integration points are documented above
- State tracking is current in STATE.md

---
**Handover Date**: 2026-09-18
**Role B Status**: ✅ Complete
**Role C Status**: Ready to begin