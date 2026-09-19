# STATE.md - Active Invariants & System State

## Current Execution
- **Phase**: Seller Server Integration (Role B)
- **Active Task**: Integrating seller-server with Setra402 on-chain program
- **Branch**: feature/seller-server-integration

## On-Chain Invariants
- **TaskState PDA**: `[b"task", buyer.key().as_ref(), &task_id.to_le_bytes()]`
- **Vault PDA**: `[b"vault", task_state.key().as_ref()]`
- **Nullifier PDA**: `[b"nullifier", eta.as_ref()]`
- **TaskStatus Enum**: `0 = Pending`, `1 = Settled`, `2 = Refunded`

## Economic Invariants
- **Settlement Platform Fee**: 100 BPS (1.0% to protocol_treasury; 99.0% to seller)
- **Voluntary Cancel Penalty**: 500 BPS (5.0% to protocol_treasury; 95.0% to buyer)
- **Timeout SLA Refund**: 100% principal to buyer; 0% fee

## Seller Server Integration Progress

### Task 1: Update Task State Schema - ✅ COMPLETED
- Added `is_private: bool` field to TaskState struct
- Added `NULLIFIER_SEED` constant
- Updated decoder to handle is_private field
- Updated test encoder/decoder for new field
- Added test for is_private field decoding
- **Status**: State verified

### Task 2: Update Payment Quote Structure - ✅ COMPLETED
- Added `is_private: bool` to PaymentQuote struct
- Added `protocol_fee_bps: u64` to PaymentQuote struct
- Added fee constants (PROTOCOL_FEE_BPS, CANCEL_PENALTY_BPS, BPS_DENOMINATOR)
- Added `is_private` field to TaskRequest with default false
- Added optional `protocol_treasury` to AppState
- **Status**: State verified

### Task 3: Update PDA Derivation - ✅ COMPLETED
- Added `nullifier_pda` function for nullifier record PDA derivation
- Updated imports to include NULLIFIER_SEED
- Added tests for nullifier PDA derivation
- **Status**: State verified

### Task 4: Update Handler Logic - ✅ COMPLETED
- Updated payment_required function to include is_private parameter
- Updated payment quote generation to include is_private and protocol_fee_bps
- Added privacy mismatch validation in handler
- Updated all payment_required calls to pass is_private flag
- **Status**: State verified

### Task 5: Update Configuration - ✅ COMPLETED
- Added fee constants to config.rs
- Updated AppState to include optional protocol_treasury
- **Status**: State verified

### Task 6: Update .env.example - ✅ COMPLETED
- Added PROTOCOL_TREASURY variable with documentation
- **Status**: State verified

### Task 7: Update Tests - ✅ COMPLETED
- Updated encode_task_state to include is_private parameter
- Updated all existing test calls to include is_private=false
- Updated AppState initialization to include protocol_treasury field
- Updated 402 response test to check for is_private and protocol_fee_bps
- Added test for private task handling
- Added test for privacy mismatch validation
- Added test for payment quote with private flag
- **Status**: State verified

### Task 8: Verify Integration - ✅ COMPLETED
- Added seller-server to workspace members in root Cargo.toml
- Encountered dependency lock issues with local cargo check
- Created Docker setup to handle dependency isolation:
  - Added Dockerfile for seller-server (multi-stage build)
  - Added Dockerfile.validator for local Solana validator
  - Added docker-compose.dev.yml for development environment
  - Added .dockerignore for seller-server
- Successfully built seller-server Docker image (completed in ~4 minutes)
- Docker build compiled all dependencies successfully
- Image size optimized with multi-stage build
- **Status**: State verified - Docker build successful

### Task 9: Post-Integration Verification & Fixes - ✅ COMPLETED
- Fixed deadline gap in handlers.rs: expired Pending tasks now rejected with 410 GONE (mirrors on-chain refund boundary `now >= deadline_unix`); prevents buyer receiving output + full refund
- Fixed rpc.rs: removed premature TCP half-close (`stream.shutdown()`) that real Agave validators treat as an aborted request (empty body → 500 parse error); mocked tests never caught it
- Added 8 integration tests: PDA cross-check, per-task PDA divergence, underpaid-private quote, inverse privacy mismatch, result isolation + 404, fixed SHA-256 reference vector, expired-410 + future-deadline boundary pair
- Live-verified 402 flow against real validator (Docker, Agave 4.2.2): unpaid POST → 402 + correct quote/PDAs, private flag honored, GET result → 404
- Docker env note: Agave 4.x needs `--security-opt seccomp=unconfined` (io_uring) and compose env placeholders must be non-empty pubkeys
- **Status**: State verified - all fixes tested, live flow green

## Compilation Baseline
- `programs/setra402`: Compiled cleanly to `target/deploy/setra402.so`.
- `shared/task-anchor-types`: Verified with zero errors.
- `target/idl/setra402.json`: Emits 5 instructions (initialize, settle, settle_private, refund, cancel).
- `seller-server`: ✅ Integration completed successfully
  - All code changes implemented
  - Docker build successful
  - Container runs correctly
  - Server listening on port 3000

## Integration Summary
- **Phase**: Seller Server Integration (Role B) - ✅ COMPLETED
- **Branch**: feature/seller-server-integration
- **Total Changes**: 9 files modified, 4 new Docker files created
- **Build Status**: Docker build successful, container tested
- **Test Status**: ✅ All 34 tests passed (18 unit + 16 integration), verified on host (Rust 1.89) AND in Docker builder stage (Rust 1.75)
- **Code Quality**: Some Cosmetic Clippy lints (Warnings)
- **Docker Status**: Container running successfully on port 3000; live 402 flow verified against real validator
- **Next Steps**: Ready for Role C handover - buyer agent and verifier development