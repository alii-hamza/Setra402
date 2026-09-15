# STATE.md - Active Invariants & System State

## Current Execution
- **Phase**: Phase 1 (State Accounts & IDL Build)
- **Active Task**: Define on-chain account models and compile IDL[cite: 1].

## On-Chain Invariants
- **TaskState PDA**: `[b"task", buyer.key().as_ref(), &task_id.to_le_bytes()]`[cite: 1]
- **Vault PDA**: `[b"vault", task_state.key().as_ref()]`[cite: 1]
- **Nullifier PDA**: `[b"nullifier", eta.as_ref()]`[cite: 3]
- **TaskStatus Enum**: `0 = Pending`, `1 = Settled`, `2 = Refunded`[cite: 1]

## Core Data Schemas
- `TaskState`: `buyer`, `seller`, `verifier`, `mint`, `task_id`, `amount`, `deadline_unix`, `status`, `is_private`, `bump`[cite: 1].
- `NullifierRecord`: `nullifier` ([u8; 32]), `task_id` (u64), `settled_at` (i64), `bump` (u8)[cite: 3].