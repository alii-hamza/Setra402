# Phase 4A Batch 2 recovery operations audit

## Status and commits

**Implementation complete; final regression certification pending WSL recovery.** Do not treat this document as acceptance of the Batch 2 final exit gate.

- Branch: `agent-validator`
- Starting accepted commit: `9276e8f` (606 unique passing tests)
- 4A.6 worker: `7ba58a4`
- 4A.8 operator inspection: `f7069be`
- Windows process-probe hardening: `eb2bbb6`
- Concrete immutable-result reverification test: `0197067`
- Ending implementation commit: `0197067`
- This audit is a separate documentation commit; its hash is reported with the final handoff.

## IMPLEMENTED — 4A.6

`ReconciliationWorker.runTask(taskKey)` and bounded `runPending(limit)` explicitly scan unresolved tasks. The worker uses the read-only `RecoveryInventoryV1`, the committed quote/manifest, `FinancialReconciler`, seller execution evidence, voucher recovery, and `VerificationRecoveryV1`. It receives narrow read-only source interfaces. It has no provider dispatch, escrow funding, settlement, refund, cancellation, or voucher-issuance method. `SAFE_TO_RETRY` is recorded as advice only.

Each task has an exclusive durable claim. The claim binds task key, random claim and process-instance IDs, PID, OS-observed process-start identity, creation time, and lease timestamps. A task-key directory gate serializes claim changes. Reclaim requires lease expiry and proof that the recorded process incarnation is no longer present; probe unavailability and an abandoned gate require operator review. The worker does not rewrite the claim while scanning. A completed or stale claim is republished with a checksum under its history filename before the active claim is removed. A crash between these writes leaves duplicate evidence for review rather than guessing.

Reconciliation records are strict V1, checksummed journal envelopes, task-bound, sequential, and hash-linked. They include a stable task-derived correlation ID, inventory revision, evidence revision, findings, classifications, bounded recommendation, and evidence provenance. Identical observations do not append duplicate records. Unknown versions and corrupt history fail closed. Read-only sources retry at most three times with bounded backoff; unavailable evidence remains unknown. A later authoritative financial result can replace `UNKNOWN_FINANCIAL_OUTCOME` with `PROVEN_OCCURRED` or `SAFE_TO_RETRY`; passage of time cannot prove a provider effect did not occur.

The worker can call the existing `VerificationCoordinator` and `VerificationEngine` once for an immutable saved result only after `VerificationRecoveryV1` reports `SAFE_TO_REVERIFY`, manifest/quote/result and required challenges are valid, no report or unattributed sandbox lease exists, and no unresolved/conflicting evidence remains. It saves a linked report through `RunCheckpoints`. A PASS report does not call `SettlementCoordinator` and does not settle.

## IMPLEMENTED — 4A.8

The read-only operator CLI provides `task`, `list`, `validate`, `metrics`, and `health` commands (`npm run operator:inspect -- <command>`). The V1 task projection separates local files, authoritative chain findings, seller evidence, and derived classifications. It shows the current claim, latest reconciliation attempt, correlation ID, unresolved reasons, and a bounded recommendation. A record whose inventory revision no longer matches current durable evidence is flagged as stale. Lists are filtered and paginated (at most 100 results per page). No recovery browser route or action button was added.

An optional narrow chain reader can show a matching TaskState and fresh chain-clock refund eligibility. Its result is advice only; it cannot submit a refund. The default CLI reports chain state as `NOT_QUERIED`. A chain mismatch or unavailable query fails closed. An optional read-only `listRefundEligible` is bounded to 1,000 tasks and queries at most eight concurrently.

Structured reconciliation event records use fixed fields: correlation/task hashes, classifications before/after, evidence source, operation, result, duration, and a fixed error class. Raw error messages, credentials, voucher material, and provider payloads are excluded. The worker accepts an observer callback for these events; callers can serialize them with `structuredReconciliationLog`. Aggregate metrics have no labels or buyer/task identifiers. Backup validation checks baseline journal families, stale temporary files, conflicts/orphans, reconciliation records, active and historical claims, unknown versions, and abandoned worker gates without writing or repairing. Health probes are read-only for Solana RPC, seller discovery, Redis PING, Docker availability, state-root access, disk capacity, and the claim subsystem. Failed health checks do not relax verification or sandbox rules.

## TESTED and SIMULATED

- Focused new tests: **25 worker + 16 operator = 41 distinct tests**. The existing 13 provider-evidence tests were also rerun in focused commands; they are not added to the unique count.
- Worker tests cover exclusive claims, multiple tasks, stale and corrupt claims, bounded read retries, financial/provider/voucher evidence convergence, unresolved outcomes, immutable-result reverification, unsafe lease blocking, no settlement from a saved PASS, checksum history, and restart boundaries.
- Operator tests cover provenance separation, unknowns, safe recommendations without execution, chain-clock refund advice, pagination, stale claims, sandbox/voucher visibility, backup corruption and incompatible restore, metrics without high-cardinality labels, structured-log redaction, CLI command bounds, and resource failures.
- A concrete test runs `VerificationEngine` through the recovery source adapter and saves a linked report from the immutable checkpoint. Its chain memo reader is a deterministic test double; no live chain authority is inferred from that test.
- Restart/crash boundaries and provider/voucher evidence arrival are **SIMULATED** with process-identity probes, failpoints, and deterministic readers. The pre-existing live E2E suite separately tests process exits and financial behavior, but this new worker was not run as a production daemon.

### Complete gate evidence

At implementation commit `eb2bbb6`, `npm run test:all` passed with **646 unique, 0 failed**:

| Disjoint suite | Passed |
| --- | ---: |
| Buyer unit | 386 |
| Buyer integration | 115 |
| Buyer live E2E | 41 |
| Docker sandbox | 15 |
| Browser/web | 14 |
| Seller Rust | 70 |
| Anchor | 5 |

Build, runtime build, format check, browser secret scan, and `git diff --check` also passed in that gate. The additional concrete reverification test at `0197067` raises the final-tree buyer unit count to **387**; it passed in the focused run and in the final-tree `test:all` unit stage. Final-tree integration passed **115**. Final-tree browser/web **14**, seller Rust **70**, build, runtime build, format check, and diff check passed separately.

The final-tree `npm run test:all` **did not complete successfully**: the WSL Solana validator disappeared before the live E2E stage, causing RPC connection refusals and cascading seller transport failures. WSL then reported `Wsl/Service/E_UNEXPECTED` and could not start Ubuntu after `wsl --shutdown`. The current account could not restart `WslService` (`Cannot open 'WslService' service`). Docker sandbox and Anchor could not be rerun on the final tree. **Do not report 647 as a fully passing final regression total.** The last fully green, non-overlapping total is 646 at `eb2bbb6`; the final-tree full gate remains pending an external WSL service repair/restart and rerun.

## Bugs found and fixed

1. Archived claims originally used `rename`, which changed the basename bound into the journal checksum. History now gets a fresh checksummed publication before the active claim is removed.
2. The worker initially could advertise `SAFE_TO_REVERIFY` even when it correctly refused to execute without an immutable result. Recommendation and execution now share the strict readiness gate.
3. A two-second Windows PowerShell process-start probe was unavailable under a parallel unit gate. The probe has a bounded ten-second limit; any failure disables claim ownership/reclaim rather than using PID alone. The test accepts explicit unavailability as a fail-closed result.
4. Provider evidence can use the manifest's committed input hash when a raw buyer input response was lost, while rejecting a mismatch if both are present.

## Remaining unknown states and 4A.7 prerequisites

`UNKNOWN_EXTERNAL_EFFECT`, `UNKNOWN_FINANCIAL_OUTCOME`, and `RECONCILIATION_REQUIRED` remain whenever authoritative provider/chain evidence is absent or conflicting. No timeout or missing acknowledgement converts them to failure/non-occurrence. An abandoned claim gate requires inspection. Unattributed sandbox leases still block reverification. There is no automatic provider retry, financial resubmission, voucher reissue, settlement, cancellation, or refund.

4A.7 needs an independently authorized, durable refund scheduler and fresh chain-state/deadline checks before any refund effect. It must preserve the present worker's inspection-only trust boundary. The operator CLI has no production account/auth system and is intended for server-side/local use. It has no browser operator route. Structured logs require the host application to provide an observer sink; metrics are snapshot aggregates. The explicit worker API is not a daemon or scheduled service. These are disclosed operational limits, not claims of hidden automation.

## Batch 2 exit gate

- [x] Durable, versioned, checksummed worker findings and exclusive claims exist.
- [x] Stale-claim recovery requires lease expiry and OS process-incarnation evidence.
- [x] Read-only financial/provider/voucher/verification evidence can improve classifications without guessing unknowns away.
- [x] Safe immutable-result reverification is gated; PASS never settles through this worker.
- [x] Worker has no provider, financial, voucher, or refund mutation path.
- [x] Operator projection, provenance, bounded listings, logs, metrics, backup validation, and resource health exist.
- [x] Focused tests pass; accepted baseline behavior passed a complete 646-test gate before the final test-only commit.
- [ ] Final-tree `npm run test:all` passes after WSL service recovery.
- [x] 4A.7 and Phase 4B/4C/4D were not implemented.

**Batch 2 is not marked complete until the final-tree full gate is rerun successfully.**
