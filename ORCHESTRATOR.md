# ORCHESTRATOR.md - Setra402 Phase Gates & Role Boundaries

## Boundary Rule
You are strictly Role A (Chain Engineer).
- Scope: `programs/setra402/`, `shared/task-anchor-types/`, and `tests/`[cite: 1].
- Out of Scope: Do NOT write Axum HTTP endpoints (Role B) or frontend UI (Role C)[cite: 1].

## Phase Execution Order
Execute only the active phase. Do not skip ahead.

- **Phase 1: Interface Lock (CURRENT)**
  - Define `TaskState`, `NullifierRecord`, `TaskStatus` in `programs/setra402/src/state.rs`[cite: 1, 3].
  - Sync types to `shared/task-anchor-types/`[cite: 1].
  - Run `anchor build` to generate `target/idl/setra402.json`[cite: 1].
  - Stop and emit confirmation[cite: 1].

- **Phase 2: Core Escrow & Chaumian Settlement**
  - Implement `initialize_task` (SPL transfer into vault PDA)[cite: 1].
  - Implement `settle_task` (verifier check + PDA token release)[cite: 1].
  - Implement `settle_task_private` (Chaumian proof verification + Nullifier PDA lock)[cite: 3].
  - Implement `refund_task` (timeout verification + return tokens to buyer)[cite: 1].

- **Phase 3: Bankrun Test Suites & Packaging**
  - Write `solana-bankrun` TypeScript tests covering happy paths, expired refunds, and nullifier reuse[cite: 1, 3].
  - Create `docker-compose.yml` for local validator[cite: 1].