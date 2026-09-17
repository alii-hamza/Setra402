# ORCHESTRATOR.md - Setra402 Phase Gates

## Active Phase: Phase 3 (LiteSVM Test Suites)
- **Engine**: LiteSVM in-process VM loading `target/deploy/setra402.so`.
- **Target**: `tests/setra402.ts`.

## Test Scenarios to Validate
1. **Scenario 1**: Settle task -> 99% to seller, 1% to protocol_treasury.
2. **Scenario 2**: Warp clock past `deadline_unix` -> 100% refund to buyer.
3. **Scenario 3**: Voluntary cancellation before deadline -> 95% to buyer, 5% penalty to protocol_treasury.
4. **Scenario 4**: Replay attack -> Duplicate nullifier on `settle_task_private` reverts with `NullifierAlreadySpent`.