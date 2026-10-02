# Phase 3C audit

Starting commit: `f4879ae6b581d971d610de3f575489b235110d96`.

## Implemented

Screen A registers validated services into a local, gitignored JSON overlay. The checked-in baseline remains read-only. The same normalized definitions feed seller REST/x402, generic MCP discovery and Screen B. Seller reconciliation is a fresh merged-registry read on each discovery/invocation; no restart is required after registration. Atomic writes are locked, fsynced and renamed, with canonical read-back before success. Duplicate IDs never override baseline or local services. A malformed overlay leaves baseline discovery available and blocks writes.

The browser sends the exact VerificationPolicyV1 contract. The server applies the shared Phase 2/3A validator, canonical hash and allowlisted profile/bundle validation. A supplied browser hash cannot override it. All seven L1 checks and only source_sampling/test_suite L2 checks are configurable. Deferred types cannot enter active policy.

The four server-side provider profiles come from `seller-server/config/provider-profiles.json`: echo, lead, source and code fixtures. They accept no executable, shell, Docker, host path, entrypoint or MCP stdio configuration. No credential provisioning is implemented, and raw provider secrets are rejected. Exposure controls discovery/invocation; private support is validated. Existing baseline runtime price/timeout compatibility remains intact, while new services use their own validated amounts/timeouts.

Screen B invokes the actual ProtectedTaskController → BuyerOrchestrator → VerificationEngine → SettlementCoordinator path with REST or MCP. The browser has no financial authority. Task ID/input/service/privacy are bound for retries. Chain TaskState is displayed separately from application state. Refund eligibility uses fresh chain time and deadline. A failed report remains Pending; no cancellation, settlement or automatic refund is claimed.

Screen C renders only actual report checks, contract integrity, L1/L2 evidence and the observed chain action. Refund confirmation retains the failed report. Nullifier/replay protection is shown separately from quality verification.

## Security controls

Writes are server-side and disabled by default (`SETRA_ONBOARDING_WRITE_ENABLED=true` explicitly enables local/hackathon mode). The loopback control plane validates Host/Origin, requires a process-local CSRF token for mutation, bounds JSON bodies/time and serves a strict CSP with no remote scripts. This is not a production authenticated admin platform. Static client assets contain no signer/keypair/environment/provider/admin secrets, signing implementation or localStorage persistence. Automated scanning and actual browser configuration checks pass.

MCP transport performs initialize/initialized before tool calls. Seller/backend connector configuration remains independent from the buyer-facing transport. All signing and verification authority stay server-side.

## Tested

Final `npm run test:all` exited **0** and ran disjoint suites:

| Suite                         |  Passed |
| ----------------------------- | ------: |
| Seller (24 unit + 31 handler) |      55 |
| Anchor/on-chain               |       5 |
| Buyer unit                    |     191 |
| Buyer integration             |      84 |
| Buyer live E2E                |      33 |
| Actual Docker sandbox         |      14 |
| Browser/control plane         |      14 |
| **Unique total**              | **396** |

Build/typecheck, runtime emit, Prettier and `git diff --check` pass. Focused commands overlap and are not added to totals. Exact commands/environment are in `PHASE3_RUNBOOK.md`; the fail-fast runner is `scripts/test-all.mjs`.

The 13 new live onboarding cases prove Screen A → registry → REST/MCP discovery with identical hash → Screen B → actual escrow → execution → report → shared coordinator → Screen C. Newly onboarded L1, L2 source and L2 code services pass/fail over both transports; every failed live result remains Pending without settlement. Local fixtures avoid external provider dependencies.

## Simulated checks and manual inspection

Browser state/refund presentation tests use a clearly simulated chain/controller, while the onboarding live browser test and full transport matrix use actual transactions. The actual audit screenshot was visually inspected. Browser tests cover 320/768/1024/1440 widths, keyboard focus, zero browser errors, registration, discovery, exact hash display, available check types, actual-row rendering and confirmed refund semantics. No hardware attestation or external production provider was claimed.

## Failures fixed

- Browser option waits required attached DOM state rather than visible option state.
- Long policy hash text caused 320px overflow; wrapping was corrected.
- Native HTTP was needed to test Host rejection because fetch ignored the test's custom Host.
- Windows Path case was preserved in the aggregate runner; failed commands remain non-zero.
- C: became full during local validator work, preventing WSL startup. An obsolete task-created disposable ledger was removed after path/ownership verification, freeing about 3.3 GB. Automatic review rejected pruning an existing persistent ledger; a separately verified new bounded ledger was used, preserving existing history. The recovered complete gate passed.

## Exit gate

- [x] All three screens; actual core/report data; REST and MCP selectable.
- [x] Server-only onboarding; disabled by default; read-only discovery available.
- [x] Baseline unchanged; isolated overlay; atomic write/read-back; duplicates rejected.
- [x] Shared policy validator; server-authoritative identical registry/REST/MCP/UI hashes.
- [x] L1 and both L2 onboarding; no L3/AI activation.
- [x] Server-allowlisted profiles; arbitrary commands and raw secrets impossible through onboarding.
- [x] New service reaches REST, MCP and Screen B; live onboarding execution/audit passes.
- [x] No browser signing authority or secrets; automated scan passes.
- [x] Failure/refund states accurate; application states separate from Anchor states.
- [x] Phase 1/2/3A/3B, Role B, Anchor, private/nullifier, 410 and cancellation regression green.
- [x] Phase 4 untouched.

## Known limitations

Local/hackathon control plane, preconfigured deterministic providers, trusted host configuration and file journals; no production accounts/auth, marketplace/database, secret provisioning, automatic ambiguous-effect reconciliation or durable refund scheduler. The pinned pure-module test runner is intentionally narrow; Docker availability is required and failure is closed. Containers are non-root; the tested WSL daemon is not claimed to be rootless. Node 22.19.0 and the accepted 11 existing Solana/Anchor transitive advisories remain. See the runbook for prerequisites and operational boundaries.
