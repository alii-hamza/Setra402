# Phase 4A.1 recovery inventory audit

## Baseline and commits

- Branch: `agent-validator`
- Starting implementation HEAD: `2bbb58077a9eb0f110e5687c5bf3cb6adb75569b`
- Ending implementation commit: `73565a9` (`feat: add read-only Phase 4A.1 recovery inventory`)
- Audit record: the commit containing this document; its hash is reported with the final task result.
- Accepted starting regression: 517 unique passed, 0 failed.
- Scope: Phase 4A.1 only. No Phase 4A.2–4A.8 action worker was added.

## Implemented inventory

`scanRecoveryInventory` in `src/core/recovery-inventory.ts` is a synchronous, read-only scan of an existing state root. It does not construct `ProtectedTaskController`, `FinancialJournal`, a chain client, a provider transport, a signer, or a Docker runner. It never creates or clears a journal directory, removes a stale temporary file, submits a transaction, dispatches a provider, reissues a voucher, or runs verification.

The strict `RecoveryInventoryV1` view has `version: "1"`, per-family scan status (`PRESENT`, `MISSING`, `UNREADABLE`, or `NOT_CONFIGURED`), task identities, evidence records with path/source/role and `VALID` or `CORRUPT` status, unattached records, conflicts, stale temporary files, classifications, and a recommendation. `authoritativeExternalEvidence` and each task's TaskState/nullifier fields explicitly say `NOT_QUERIED`. The view is application state, not an Anchor account or chain status. A missing record is absent evidence; it is never `PROVEN_NOT_OCCURRED`.

The scan covers these existing journal families:

| Family                 | Evidence inventoried                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `tasks`                | Immutable identity hash, canonical quote, funding intent and completion, execution intent, cached outcome                    |
| `manifests`            | Versioned/checksummed manifest, manifest commitment, initialize signature; validated legacy manifest format remains readable |
| `transactions`         | Funding, settlement, refund, and cancellation intents, prepared signed transaction fingerprints, local confirmation records  |
| `checkpoints`          | Raw `ResultEnvelopeV1` and `VerificationReport`                                                                              |
| `vouchers`             | Private blind-voucher intent material and saved response                                                                     |
| `challenges`           | Persisted Level-2 source-sampling seeds keyed by immutable result/policy context                                             |
| `sandbox-leases`       | Local container lease records; their current format has no task identity, so they remain unattached                          |
| Seller execution store | Provider execution intents and checksummed durable results, when its directory is supplied                                   |

The seller execution store can be on a separate host and is an optional scan input. When it is unavailable, the inventory reports `NOT_CONFIGURED` or `MISSING`; it does not infer that provider execution failed. The on-chain `NullifierRecord` and TaskState are authoritative but are not local journal families and are not queried by Phase 4A.1.

## Validation and classification rules

The scan uses existing `DurableJournal` and `ManifestStore` readers to validate committed envelope versions, keys, and canonical checksums. It validates quote/policy hashes, quote PDA derivation, manifest/quote bindings, raw result hashes and task input, report result/manifest/policy/verifier linkage, financial operation keys and prepared/completion linkage, seller result checksums and task/input bindings, voucher payload shape, challenge context, and lease shape. Unknown future envelope versions fail closed. No lossy migration or repair is attempted.

Corrupt evidence, orphan records, duplicate canonical records, or conflicting immutable bindings produce `RECONCILIATION_REQUIRED` or an inventory-level `OPERATOR_REVIEW_REQUIRED`. Local prepared or completed financial records still yield `UNKNOWN_FINANCIAL_OUTCOME`; a saved "settled" or "refunded" outcome does not establish chain finality. An execution intent without a valid buyer result checkpoint remains `UNKNOWN_EXTERNAL_EFFECT`, even when a seller-side saved result is present. An unacknowledged voucher issuance intent is also `UNKNOWN_EXTERNAL_EFFECT`. A valid immutable buyer result checkpoint can be reported as `SAFE_TO_REVERIFY`; this is a recommendation only and does not invoke verification. The inventory never emits `SAFE_TO_RETRY`, `PROVEN_OCCURRED`, or `PROVEN_NOT_OCCURRED` from local evidence alone.

## Tests and results

Focused command from `buyer-agent`:

```powershell
npx vitest run tests/unit/recovery-inventory.test.ts --reporter=dot
```

Focused result: **38 passed, 0 failed**. These 38 are included in the buyer unit total below, not added again.

The focused cases cover complete, funded/in-progress, failed-verification, locally settled/refunded, and private tasks; unresolved financial/provider/voucher intents; truncated and checksum-altered journals; wrong envelope key and future version; wrong buyer/task/service/privacy/manifest commitments; mismatched result/report links; duplicate quote and conflicting result copies; orphan prepared/completion/voucher/checkpoint records; stale temporary files; missing families; malformed lease, seller, voucher, and state-root records; cross-task contamination; restored, moved, and partially restored state directories; and a before/after byte snapshot proving the scan does not modify evidence.

Complete regression command from `buyer-agent` after starting a fresh local validator, fixture accounts, Redis, and seller:

```powershell
. '..\target\phase35-test-env.ps1'; npm run test:all
```

| Disjoint suite                            |  Passed | Failed |
| ----------------------------------------- | ------: | -----: |
| Buyer unit, including 38 Phase 4A.1 tests |     303 |      0 |
| Buyer integration                         |     115 |      0 |
| Buyer live E2E                            |      41 |      0 |
| Docker sandbox                            |      15 |      0 |
| Browser/web                               |      14 |      0 |
| Seller Rust                               |      62 |      0 |
| Anchor                                    |       5 |      0 |
| **Unique total**                          | **555** |  **0** |

`test:all` also passed TypeScript build and runtime build, Prettier, and `git diff --check`. The live E2E/Anchor runs used the compatible local WSL Solana validator and deterministic local seller fixture.

## Failures encountered and fixes

- The first focused fixture used the Windows sandbox temporary directory, where journal rename returned `EPERM`; the fixture was moved under the repository's ignored `target` directory. No production journal behavior changed.
- The first inventory pass read alphabetically sorted financial confirmations before prepared transactions and falsely marked a complete local journal orphaned. The scan now processes prepared records before confirmations.
- Adversarial tests exposed checksum-valid malformed voucher values and a manifest with an invalid buyer key. Both now fail closed instead of allowing a malformed view or scan exception.
- Review found two classification mistakes in the new inventory: unacknowledged voucher issuance was grouped with financial chain uncertainty, and a cached terminal response lacked an explicit unknown financial classification. Both were corrected before the final full regression.
- One intermediate full gate stopped at Prettier after a newly added test; formatting was fixed and the final full gate passed.

## Known limitations and exit gate

- This is local inventory, not chain or provider reconciliation. It cannot prove that an ambiguous transaction landed or failed, that a provider effect did or did not happen, or that a private nullifier is on-chain. Those remain unresolved until authoritative evidence is obtained by later slices.
- Checksums detect accidental corruption but do not authenticate copied state against an adversary who can rewrite both value and checksum. Immutable cross-record bindings and chain reconciliation remain necessary.
- A seller store must be supplied by path to inspect its records. Missing seller files are not assumed to mean non-execution.
- Sandbox leases lack task identity in the accepted Phase 3.5 format; the inventory reports them unattached rather than guessing.
- A restored partial directory can lack an entire journal family. The scan reports the missing family and retains unresolved classifications. It does not silently merge incompatible copies.
- No automatic provider retry, financial resubmission, refund, voucher reissue, Docker verification, journal deletion, or repair exists in this slice. No Phase 4B/4C/4D functionality was added.

Phase 4A.1 exit gate: all implemented journal families are inventoried; the view is versioned and read-only; missing, corrupt, orphan, duplicate, and conflicting evidence are distinguished; unresolved intents remain; moved/restored/partial state is tested; unknown provider and financial outcomes remain unknown; the final 555-test regression is green; and Phase 4A.2+ was not started.
