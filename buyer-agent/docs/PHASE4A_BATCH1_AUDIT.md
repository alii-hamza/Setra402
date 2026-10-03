# Phase 4A Batch 1 recovery-evidence audit

## Baseline, scope, and commits

- Branch: `agent-validator`.
- Accepted starting HEAD: `d7dbdb8` (Phase 4A.1); accepted regression: **555 unique passed, 0 failed**.
- 4A.2: `708c2b1` — read-only financial reconciliation.
- 4A.3: `89c5fae` — provider recovery-capability declaration and read-only evidence contract.
- 4A.4: `8371ba9` — durable private issuance evidence and read-only voucher recovery.
- 4A.5: `305277b` — read-only verification and sandbox recovery assessment.
- Documentation correction: `d8eedb9` — show the optional configured mint secret as a commented example.
- Implementation HEAD before this audit document: `d8eedb9`. The audit-only commit is reported in the task result.
- Scope: **4A.2–4A.5 only**. No 4A.6 reconciliation worker, 4A.7 refund scheduler, 4A.8 operator tooling, or Phase 4B/4C/4D work was added. Accepted Phase 1–4A.1 commits were not amended or rewritten.

## Architecture and evidence boundaries

These slices add callable recovery/evidence readers around existing journals and current chain/seller state. They do not run automatically at startup. Their recommendations are application-level classifications, never Anchor states or authorization to settle. The existing `SettlementCoordinator`, escrow, verification engine, REST/MCP normalization, provider profiles, and on-chain program remain the authorities they were before this batch.

| Slice                     | Implemented                                                                                                                                                                  | Evidence and safe outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4A.2 financial            | `FinancialReconciler` plus a read-only `ChainClient.reconcileFinancial` adapter                                                                                              | Validates manifest/quote/PDA/operation and journal links, then reads TaskState, vault, private nullifier, signature history, finalized block-height fence, chain Clock and funding memo. It separates **chain outcome** from **confirmed receipt**. An intent without prepared signature, lagging/unavailable history, or unavailable finalized fence stays `UNKNOWN_FINANCIAL_OUTCOME`. Only a proven not-landed eligible funding/refund/cancel operation can be labeled `SAFE_TO_RETRY`; settlement is never labeled retry-safe here. Nothing signs or submits.                                                                                   |
| 4A.3 provider             | Versioned seller `GET /tasks/:task_id/execution-evidence` and strict buyer assessment                                                                                        | Exposes the existing execution intent/durable result with service/input/PDA/profile bindings. All four active `LOCAL_FIXTURE` profiles declare `DURABLE_RESULT_REPLAY_ONLY`. A saved result is `RESULT_PERSISTED_UNVERIFIED`; an intent-only or absent store remains `UNKNOWN_EXTERNAL_EFFECT`. No provider ID, status-query API, durable third-party receipt, or retry guarantee is claimed. No provider dispatch occurs.                                                                                                                                                                                                                          |
| 4A.4 private voucher      | Checksummed seller issuance intent/receipt, exact-request replay, read-only `GET /mint/issuance/:task_id`, buyer `inspectVoucherRecovery`, inventory scan of `mint-issuance` | Seller claims buyer/task/blinded-point/current-key before signing and publishes the exact response before returning it. The same request replays only a saved receipt; an intent without receipt is blocked. Buyer can verify a matching saved seller response without POST or local write. A missing record does not prove non-issuance; changed key, request, response or corrupt record requires reconciliation. Optional `SETRA_MINT_SECRET_HEX` can pin a server-side mint key across restarts; absence preserves the legacy ephemeral-key behavior and is reported by key mismatch, not silently repaired.                                    |
| 4A.5 verification/sandbox | Strict `VerificationRecoveryV1` view over the inventory                                                                                                                      | Reports committed manifest/quote/raw result/report, source challenge and unassigned leases. `SAFE_TO_REVERIFY` requires a valid immutable raw result, valid quote/manifest, no report, all required source seeds, and no conflicting/stale/lease evidence. A saved PASS/FAIL is recorded local report evidence only, not a current verdict or settlement authority. Lease PID probing is read-only; a present PID is unverified and an absent PID does not prove the container stopped. Docker state remains `NOT_QUERIED`; any lease blocks safe advice. No Docker, source fetch, report execution, settlement or cleanup is invoked by this view. |

Phase 4A.4 adds `mint-issuance` as an optional seller-local journal family in `RecoveryInventoryV1`. It detects orphan, corrupt, wrong-task and conflicting receipt records; a seller intent without receipt remains unknown. Existing Phase 3.5 buyer voucher material and seller execution/result families remain intact. All new evidence contracts use version `"1"`; unknown versions fail closed. Checksums detect corruption but do not authenticate a state directory against a writer who can rewrite both contents and checksum.

## Validation

Focused gates ran after each isolated slice and before its commit:

| Slice                  |                                          Focused new tests | Result                  | Evidence type                                                                                                 |
| ---------------------- | ---------------------------------------------------------: | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| 4A.2                   |                                              17 buyer unit | 17 passed               | Real journal files, simulated chain reader and signature/history/fence responses                              |
| 4A.3                   |                         13 buyer unit + 4 seller Rust HTTP | 17 passed               | Strict buyer contract; real Axum route and seller store with simulated RPC                                    |
| 4A.4                   | 6 buyer voucher + 1 inventory + 3 Rust store + 1 Rust HTTP | 11 passed               | Real buyer/seller files and route, simulated mint/network in buyer tests; exact replay and key-rotation cases |
| 4A.5                   |                                6 inventory/assessment unit | 6 passed                | Real journal snapshots and read-only simulated PID observations                                               |
| **New disjoint tests** |                                                     **51** | **51 passed, 0 failed** | These are included in the full regression below, not added twice.                                             |

The 4A.4 focused command also reran the 2 existing Phase 3.5 voucher integration tests. The 4A.5 focused command reran existing verification and sandbox-failure tests. The complete gate below is the disjoint count.

Final command from `buyer-agent`, after starting a fresh local Solana validator, fixture accounts, Redis, rebuilt seller, and the existing Docker/browser test environment:

```powershell
. '..\target\phase35-test-env.ps1'; npm run test:all
```

| Disjoint suite    |  Passed | Failed |
| ----------------- | ------: | -----: |
| Buyer unit        |     346 |      0 |
| Buyer integration |     115 |      0 |
| Buyer live E2E    |      41 |      0 |
| Docker sandbox    |      15 |      0 |
| Browser/web       |      14 |      0 |
| Seller Rust       |      70 |      0 |
| Anchor            |       5 |      0 |
| **Unique total**  | **606** |  **0** |

`test:all` also passed buyer TypeScript and runtime builds, Prettier, seller compilation, and `git diff --check`. The gate log is the ignored local file `target/phase4a-batch1-gate.log`. The live suites exercised the unchanged REST/MCP, private settlement/nullifier, failure/refund and Docker paths. They do **not** establish external-provider exactly-once behavior, real host power-loss durability, or a live chain transaction automatically recovered by the new 4A.2 reader; those reader edge cases use injected chain evidence in focused tests.

## Files changed and review findings

From `d7dbdb8` through the implementation HEAD: **20 files**, approximately **2,992 insertions and 15 deletions**. Added: the financial reconciler, provider evidence client, voucher recovery view, verification recovery view, seller mint store, and four new focused buyer test files. Modified: chain read adapter, recovery inventory/tests, service/profile metadata, seller config/routes/execution store/tests, and the seller environment example. No Anchor/program file changed.

- The initial broad buyer run in the restricted Windows sandbox hit a disappearing Vitest SSR temp file; a focused voucher run there also hit `EPERM` on the existing journal's hard-link publication. The identical tests passed in the permitted host environment. No journal safety behavior was relaxed.
- After 4A.3, process-boundary unit tests loaded stale ignored `buyer-agent/dist` output. Rebuilding with `npm run build:runtime` before the unit gate restored the tested current registry code; the final `test:all` performs that build itself.
- 4A.5 review found the Phase 4A.1 inventory could suggest `SAFE_TO_REVERIFY` for a task while a V1 lease without task identity remained. It now changes such task advice to `READ_ONLY_RECONCILIATION`; the new view blocks safe advice as well.
- The optional mint-secret example initially looked like an empty enabled variable. The documentation-only correction comments it out; an explicitly empty configured secret remains an error rather than silently selecting a new key.
- The final full gate passed without a code/test failure.

## Remaining unresolved states

- `UNKNOWN_EXTERNAL_EFFECT` remains for provider intent without a durable result or authoritative provider receipt. The four current fixture profiles do not provide third-party execution IDs, status queries or exactly-once guarantees. The evidence GET is seller-local, not an external-provider proof.
- `UNKNOWN_FINANCIAL_OUTCOME` remains for missing prepared signature, live/lagging/unavailable history, or insufficient finalized fence. A terminal account can prove an outcome while the original transaction receipt remains unresolved. The new reader never submits a retry.
- Voucher intent without seller receipt remains unknown. A saved response under an old mint key is not assumed current. Key backup, rotation, access control and real power-loss durability require deployment procedures; the optional environment key is a pinning mechanism, not a full lifecycle service.
- V1 sandbox leases lack task identity and PID incarnation. A dead PID alone cannot prove container state. Daemon reconciliation/permission failures and actual daemon-restart tests remain open; the preexisting Phase 3.5 cleanup on an explicit sandbox execution still fails closed.
- A previously recorded verification PASS is local historical evidence. Source/artifact freshness and current chain deadline require fresh authoritative checks before any later settlement. The new view does not execute a verification or a financial action.
- No durable reconciliation loop, refund scheduler, operator approval tool, database, generic provider connector, or Phase 4B/4C/4D capability exists.

## Batch 1 exit gate

**IMPLEMENTED:** four separately committed evidence slices; strict versioned views/contracts; immutable binding checks; read-only chain/provider/voucher/verification queries; durable exact-request issuance receipt; fail-closed corrupt/orphan/mismatch behavior; unassigned lease caution.

**TESTED:** each focused gate before the next slice; 51 new disjoint tests; full **606/606** regression; live existing settlement/private/nullifier/sandbox/browser paths; `git diff --check`.

**SIMULATED:** ambiguous chain history/fence, external provider capability limits, buyer-side mint HTTP, and PID observation branches. Simulation is not a production guarantee.

**DEFERRED:** 4A.6 reconciliation worker, 4A.7 refund scheduler, 4A.8 operator tooling, and all Phase 4B/4C/4D work. Batch 1 stops at authoritative evidence and classification.
