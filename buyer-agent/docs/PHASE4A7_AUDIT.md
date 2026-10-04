# Phase 4A.7 durable refund scheduler audit

## Baseline and scope

- Branch: `agent-validator`.
- Accepted starting HEAD: `fb66ce4` (Phase 4A Batch 2; 647 unique tests passed).
- Phase 4A.7 implementation commit: `8f7d2af`.
- Ending implementation HEAD: `8f7d2af`; this audit is recorded in a separate follow-up commit.
- Authorized mutation: **eligible timeout refund only**. Phase 4A.6 remains read-only reconciliation and safe reverification. Phase 4B, 4C, and 4D were not started.

## Files changed

- Added: `src/core/refund-scheduler.ts`, `src/core/refund-scheduler-cli.ts`, `tests/unit/refund-scheduler.test.ts`, `tests/unit/refund-journal-retry.test.ts`, `tests/e2e/refund-scheduler-live.test.ts`, `tests/helpers/refund-scheduler-crash.mjs`, and this audit.
- Modified: `package.json`, `src/chain/client.ts`, `src/chain/financial-journal.ts`, `src/chain/settlement-coordinator.ts`, `src/core/runtime.ts`, `src/core/recovery-inventory.ts`, `src/core/operator-recovery.ts`, `tests/e2e/rest-flow.test.ts`, and `tests/unit/operator-recovery.test.ts`.

## Implemented architecture and authority

`RefundScheduler` is an explicit server-side entry point, with a gated `refund:schedule -- once|loop [limit]` CLI. The CLI requires `SETRA_REFUND_SCHEDULER_ENABLED=true`; importing the runtime does not start it. Candidate discovery uses `RecoveryInventoryV1`, then each candidate gets an operation-specific durable claim under `refund-claims`. The claim reuses the proven 4A.6 claim format and OS process-incarnation rule in a separate namespace. It cannot be taken over merely because its PID is absent or its lease has expired.

Under the claim, the scheduler validates the canonical quote, manifest, task identity, PDA, buyer, seller, verifier, mint, amount, privacy, policy commitment, and every existing financial intent. It requires authoritative confirmed funding; a settlement or cancellation intent must be proven not to have occurred. It refuses unknown, corrupt, orphaned, or conflicting evidence. It reads fresh Pending TaskState and Solana Clock and requires `Clock >= deadline`. Immediately before submission it rescans local evidence, reconciles financial intents again, and rereads chain state and Clock. Eligibility alone never authorizes a refund.

Submission uses the existing buyer signer, refund instruction, `SettlementCoordinator.refundExpired`, `ChainClient`, and Phase 3.5 financial journal. The journal publishes a refund intent and signed transaction evidence before sending. The initial refund path is limited to one prepared send attempt. An RPC error or lost acknowledgement retains the intent and prepared signature; the scheduler records `UNKNOWN_FINANCIAL_OUTCOME` and does not automatically resubmit it. A new signed attempt is possible only when the existing `FinancialReconciler` proves `SAFE_TO_RETRY` for **that refund operation**, with matching immutable fingerprint, expired finalized block-height fence, absent/finalized-failed signature history, and eligible fresh TaskState. The original signed preparation is checksummed and archived before preparing one replacement. A second automatic replacement is refused.

The retry archive is included in `RecoveryInventoryV1`. Corrupt, orphaned, or binding-conflicting archives fail closed. A new refund intent creates the archive family; a later missing family blocks retry. Pre-4A.7 state with no refund intent remains valid in the operator backup view. A legacy refund intent without this family is shown as a backup warning and is not automatically retried.

Scheduler attempts produce versioned, checksummed, task-bound records under `refund-records`. Fixed-field structured logs include the correlation ID, hashed task key, claim, outcome, classification, signature when available, duration, and error class. Aggregate metric output has no buyer, task, or pubkey labels. The scheduler's submitter interface exposes refund and refund retry only; it cannot fund, settle, cancel, dispatch a provider, issue a voucher, or override verification. A failed verification remains Pending until the chain deadline; the scheduler never calls `cancel_task`.

## Evidence, restart, and race behavior

- **IMPLEMENTED:** An active claim blocks a second scheduler. An expired claim is recovered only after the recorded OS process incarnation is demonstrably gone. Corrupt claims require review.
- **IMPLEMENTED:** A confirmed refund, including one with no local scheduler completion record, is reconciled to `PROVEN_OCCURRED` without a second send. An ambiguous prior refund remains unknown. The scheduler does not infer non-occurrence from elapsed time.
- **IMPLEMENTED:** A manual refund contends through the existing financial intent journal. Settlement and cancellation can only produce one final Anchor transition with refund; the scheduler rechecks fresh state and financial evidence, then reconciles the actual chain outcome.
- **TESTED LIVE:** Eligible refund and restart without another prepared transaction; manual refund racing the scheduler; already settled and already cancelled tasks; actual child-process exit after a confirmed refund submission but before its scheduler record, followed by stale-claim recovery without another send. The preserved Phase 3.5 live suite also races settlement against refund and cancellation on-chain.
- **SIMULATED:** Solana Clock at deadline minus one, exact deadline, and plus one; RPC/history/Clock/binding failures; corrupt journals and claims; two workers on one task; competing terminal-state interleavings; failpoints before and after claim, inventory, reconciliation, eligibility, submission, chain confirmation, and record persistence. These injected boundaries are not claimed as actual process kills.

## Tests and environment

Focused `npm run test:refund` passed **37/37**: 27 refund scheduler unit, 5 financial journal retry unit, and 5 actual-validator E2E. These tests overlap the disjoint full gate and are **not** added to its total. Focused legacy recovery/operator compatibility checks also passed.

The final-tree `npm run test:all` exited **0** with **684 unique passed, 0 failed**:

| Disjoint suite                            | Passed |
| ----------------------------------------- | -----: |
| Buyer unit                                |    419 |
| Buyer integration                         |    115 |
| Buyer live E2E                            |     46 |
| Docker sandbox                            |     15 |
| Browser/web, including bundle secret scan |     14 |
| Seller Rust                               |     70 |
| Anchor                                    |      5 |

The same gate passed `build`, `build:runtime`, `format:check`, and `git diff --check`. No dependency, Anchor program, PDA, economics, provider, voucher, verification, or browser financial-authority change was made.

The live gate used the existing local validator, seller, Redis, Docker, and fixture runbook. The previous validator's Solana Clock was more than two hours behind host time. After verifying the exact task-owned disposable ledger path, owner, genesis file, and absence of a running validator, the ledger was reset in place and fixture mint/accounts were regenerated; no application state was deleted. Docker's first cold start took about eight seconds, while a warm start took about two. The old REST 410 E2E fixture incorrectly waited on host time; it now waits for Solana Clock, with the same refund and on-chain assertions. A pre-existing 4A.8 Windows process-start probe may take up to ten seconds, so its test allowance was raised from five to fifteen seconds without changing its fail-closed assertion. The final full gate passed after those narrow fixture corrections.

## Bugs discovered and fixed

1. New live tests requested a quote after funding, receiving a result instead of a payment challenge. They now request the quote before funding.
2. A missing retry-archive family after partial restore could be mistaken for no prior replacement. New refund intents create the family, and missing/corrupt family evidence blocks retry.
3. Adding the optional archive family initially marked clean pre-4A.7 backups as incomplete. Inventory and operator validation now preserve legacy classifications while warning when a refund intent lacks the family.
4. The prior REST timeout fixture used host wall time even though refund eligibility is governed by Solana Clock. It now waits on the chain clock.
5. Parallel unit load could exceed the existing process-probe test's five-second allowance. Its assertion is unchanged and the allowance is now fifteen seconds.

## Known limitations and unresolved states

- The CLI is an explicit local process. Deployment supervision and automatic restart of that process are operational concerns; no OS service was installed.
- Claims are proven for processes sharing the same durable local filesystem. Multi-host distributed filesystem semantics were not tested.
- Scheduler metrics are process-local aggregates; durable attempt history is in checksummed records and the financial journal.
- A second automatic replacement after an already replaced refund is deliberately refused, even if a later read-only reconciliation reports another `SAFE_TO_RETRY`; operator review is required.
- Unavailable chain history, Clock, RPC, corrupted or partial local state, and any still-live prior financial signature remain unresolved. No missing acknowledgement is converted to failure or non-occurrence.
- Complete deletion or selective restoration of both canonical financial history and its archive cannot be repaired by guessing; restore provenance remains an operator responsibility.
- The nine injected crash-boundary tests are simulations. The actual process-kill test covers the high-risk post-submit/pre-record boundary; live restart coverage does not claim every injected boundary was separately killed on an OS process.

## Phase 4A.7 exit gate

**PASS:** Durable claim and record; refund-only authority; fresh TaskState and Solana Clock; operation-specific financial reconciliation; intent and prepared transaction persistence; ambiguous-outcome hold; safe refund-only retry; concurrent and manual race safety; restart after submission and confirmation; failed-verification timeout semantics; secret-free logs and aggregate metrics; Phase 1 through Phase 4A Batch 2 regression green. Phase 4B/4C/4D untouched.

**DEFERRED:** External process supervision, distributed claim storage, a second automatic refund replacement, and automation for any non-refund financial or provider effect.

With 4A.1, 4A.2–4A.5, 4A.6, 4A.8, and this 4A.7 complete, Phase 4A is complete. No Phase 4B work was begun.
