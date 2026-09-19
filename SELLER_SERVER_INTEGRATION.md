# Seller Server Integration Guide

## Project Overview

Setra402 is a Solana-based crypto payment system with on-chain escrow and deterministic verification. The system consists of:

1. **On-chain program** (Anchor/Rust): Escrow logic, token locking, settlement, refunds
2. **Seller server** (Rust/Axum): HTTP 402 flow, on-chain state verification, task execution  
3. **Buyer agent + Verifier** (Node.js/TypeScript): Payment construction, output verification, settlement trigger

## Current Implementation Status

### On-Chain Program (Setra402/Role A)

**Location**: `/home/alihamza/Setra402/programs/setra402/`

**Implemented Features**:
- TaskState account with fields: buyer, seller, verifier, mint, task_id, amount, deadline_unix, status, is_private, bump
- NullifierRecord account for private settlement tracking
- TaskStatus enum: Pending, Settled, Refunded
- Instructions:
  - `initialize_task`: Creates task with optional private flag, escrows tokens to vault
  - `settle_task`: Standard settlement with 1% protocol fee
  - `settle_task_private`: Private settlement with nullifier record (double-spend prevention)
  - `refund_task`: Full refund after deadline
  - `cancel_task`: Early cancellation with 5% penalty before deadline
- Protocol fee system: 1% fee (100 BPS) on settlements
- Cancellation penalty: 5% penalty (500 BPS) on early cancellations
- PDA seeds: TASK_SEED, VAULT_SEED, NULLIFIER_SEED
- Shared types crate: `/home/alihamza/Setra402/shared/task-anchor-types/src/lib.rs`

**Program ID**: `FUjN9K7C5yHr5NhVrJ7WCgifgDiBJnSDDGQjnNkUDBMN`

### Seller Server (Current Implementation)

**Location**: `/home/alihamza/Downloads/seller-server/`

**Current Features**:
- Basic HTTP 402 payment flow on `/tasks/:task_id`
- Task result retrieval on `/tasks/:task_id/result`
- PDA derivation for task_state and vault
- Basic RPC client (getAccountInfo only)
- Task state decoding from on-chain accounts
- Simple hash-based task execution (SHA-256 of JSON input)
- Configuration via environment variables
- In-memory result storage

**Missing Integrations**:
1. No support for `is_private` flag in task initialization
2. No nullifier record handling for private settlements
3. No protocol fee awareness in payment quotes
4. No cancellation penalty handling
5. No integration with shared types crate from Setra402
6. Missing NULLIFIER_SEED constant
7. Task state decoder doesn't include `is_private` field
8. No support for protocol treasury account in PDA derivation
9. Payment quote doesn't include fee structure information

## Required Integration Work

### 1. Update Task State Schema

**File**: `src/task_state.rs`

**Changes needed**:
- Add `is_private: bool` field to TaskState struct
- Update decoder to handle the new field
- Update discriminator calculations for new struct size
- Add NULLIFIER_SEED constant

```rust
pub const NULLIFIER_SEED: &[u8] = b"nullifier";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskState {
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub verifier: Pubkey,
    pub mint: Pubkey,
    pub task_id: u64,
    pub amount: u64,
    pub deadline_unix: i64,
    pub status: TaskStatus,
    pub is_private: bool,  // ADD THIS
    pub bump: u8,
}
```

### 2. Update Payment Quote Structure

**File**: `src/config.rs`

**Changes needed**:
- Add fee structure to PaymentQuote
- Add is_private flag support
- Add protocol treasury information if needed

```rust
#[derive(Serialize, Debug)]
pub struct PaymentQuote {
    pub task_id: u64,
    pub program_id: String,
    pub task_state_pda: String,
    pub vault_pda: String,
    pub mint: String,
    pub seller_token_account: String,
    pub verifier: String,
    pub amount: u64,
    pub timeout_seconds: i64,
    pub is_private: bool,  // ADD THIS
    pub protocol_fee_bps: u64,  // ADD THIS (100 = 1%)
}
```

### 3. Update PDA Derivation

**File**: `src/pda.rs`

**Changes needed**:
- Add nullifier PDA derivation function
- Add protocol treasury PDA if needed
- Update imports to include NULLIFIER_SEED

```rust
pub fn nullifier_pda(program_id: &Pubkey, nullifier: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[NULLIFIER_SEED, nullifier],
        program_id,
    )
}
```

### 4. Update Handler Logic

**File**: `src/handlers.rs`

**Changes needed**:
- Handle is_private flag in task state validation
- Adjust payment quote generation to include fee structure
- Update task request handling to support private flag
- Add nullifier record validation for private tasks

### 5. Integrate Shared Types (Optional but Recommended)

**Option A**: Replace local task_state.rs with dependency on Setra402 shared types

**Option B**: Keep local implementation but ensure it matches on-chain exactly

If using shared types:
- Add dependency to Cargo.toml: `task-anchor-types = { path = "/home/alihamza/Setra402/shared/task-anchor-types" }`
- Remove local task_state.rs
- Update imports across codebase

### 6. Update Configuration

**File**: `src/config.rs`

**Changes needed**:
- Add PROTOCOL_FEE_BPS constant (100)
- Add CANCEL_PENALTY_BPS constant (500)
- Add BPS_DENOMINATOR constant (10000)
- Add protocol treasury pubkey to AppState if needed

### 7. Update Task Execution (if needed)

**File**: `src/execute.rs`

**Current implementation is basic hash - may need updates based on actual task requirements**

## Environment Variables Required

Current required env vars (from .env.example):
- `PROGRAM_ID`: On-chain program ID
- `MINT`: Token mint address
- `SELLER_TOKEN_ACCOUNT`: Seller's token account
- `VERIFIER`: Verifier pubkey
- `RPC_HOST`: RPC endpoint host (default: 127.0.0.1)
- `RPC_PORT`: RPC endpoint port (default: 8899)
- `TASK_PRICE`: Default task price (default: 1500000)
- `TASK_TIMEOUT_SECONDS`: Default timeout (default: 180)

Additional vars that may be needed:
- `PROTOCOL_TREASURY`: Protocol treasury token account
- `PROTOCOL_FEE_BPS`: Protocol fee basis points (default: 100)

## Constants Reference

From on-chain program (`/home/alihamza/Setra402/programs/setra402/src/constants.rs`):
- `TASK_SEED`: b"task"
- `VAULT_SEED`: b"vault"  
- `NULLIFIER_SEED`: b"nullifier"
- `PROTOCOL_FEE_BPS`: 100 (1%)
- `CANCEL_PENALTY_BPS`: 500 (5%)
- `BPS_DENOMINATOR`: 10000

## PDA Derivation Seeds

**Task State**: `[TASK_SEED, buyer_pubkey, task_id_le_bytes]`
**Vault**: `[VAULT_SEED, task_state_pubkey]`
**Nullifier Record**: `[NULLIFIER_SEED, nullifier_32_bytes]`

## Integration Testing Checklist

- [ ] Task state decoder handles is_private field correctly
- [ ] Payment quote includes fee structure
- [ ] PDA derivation matches on-chain exactly
- [ ] Private task flag is handled in 402 flow
- [ ] Nullifier PDA derivation works correctly
- [ ] Protocol fee calculations are accurate
- [ ] Cancellation penalty logic is understood
- [ ] Shared types integration (if chosen) builds without errors
- [ ] End-to-end test with local validator passes

## Key Integration Points

1. **Task Initialization**: Buyer agent needs to pass is_private flag when calling initialize_task
2. **Payment Quote**: Server must communicate fee structure to buyer agent
3. **Settlement Flow**: Verifier needs to handle both standard and private settlement
4. **Nullifier Records**: Server should be aware of nullifier existence for private tasks
5. **Fee Calculations**: Both seller server and buyer agent must agree on fee structure

## File Structure After Integration

```
seller-server/
├── src/
│   ├── main.rs
│   ├── lib.rs
│   ├── config.rs          # Add fee constants, update PaymentQuote
│   ├── handlers.rs        # Update for is_private, fee handling
│   ├── pda.rs             # Add nullifier_pda function
│   ├── task_state.rs      # Add is_private field, NULLIFIER_SEED
│   ├── execute.rs         # May need updates based on task requirements
│   └── rpc.rs             # Current implementation should work
├── tests/
│   └── handlers_test.rs   # Update tests for new fields
├── Cargo.toml             # Add shared types dependency if using
└── .env.example           # Add new environment variables
```

## Testing Strategy

1. **Unit Tests**: Update existing tests to handle new fields
2. **Integration Tests**: Test against local Setra402 validator
3. **End-to-End**: Full flow from task creation to settlement
4. **Private Flow**: Test nullifier-based private settlement
5. **Fee Calculations**: Verify fee math matches on-chain exactly

## Dependencies

Current Cargo.toml dependencies (likely need updates):
- axum
- tokio
- serde/serde_json
- solana-pubkey
- sha2
- hex
- base64
- thiserror

Potential additions:
- task-anchor-types (if using shared types)
- Additional crypto libraries for nullifier handling

## Next Steps for AI Agent

1. Read current seller-server implementation completely
2. Read Setra402 on-chain program implementation
3. Identify exact integration points
4. Update task_state.rs to match on-chain TaskState
5. Update PDA derivation with nullifier support
6. Update payment quote structure
7. Update handler logic for new fields
8. Add/update tests
9. Test against local validator
10. Document any additional changes needed