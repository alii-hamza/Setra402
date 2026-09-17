# STATE.md - Active Invariants & System State

## Current Execution
- **Phase**: Phase 3 (LiteSVM In-Process Test Suite)
- **Active Task**: Implement tests for all 4 scenarios in `tests/setra402.ts` using LiteSVM / SBF runtime.

## On-Chain Invariants
- **TaskState PDA**: `[b"task", buyer.key().as_ref(), &task_id.to_le_bytes()]`
- **Vault PDA**: `[b"vault", task_state.key().as_ref()]`
- **Nullifier PDA**: `[b"nullifier", eta.as_ref()]`
- **TaskStatus Enum**: `0 = Pending`, `1 = Settled`, `2 = Refunded`

## Economic Invariants
- **Settlement Platform Fee**: 100 BPS (1.0% to protocol_treasury; 99.0% to seller)
- **Voluntary Cancel Penalty**: 500 BPS (5.0% to protocol_treasury; 95.0% to buyer)
- **Timeout SLA Refund**: 100% principal to buyer; 0% fee

## Compilation Baseline
- `programs/setra402`: Compiled cleanly to `target/deploy/setra402.so`.
- `shared/task-anchor-types`: Verified with zero errors.
- `target/idl/setra402.json`: Emits 5 instructions (initialize, settle, settle_private, refund, cancel).