# Role C Phase 3 completion record

Completed on 2026-10-02 (Asia/Kathmandu), on `agent-validator`. **Phase 3 is complete. Phase 4 was not started.** The pasted Phase 3 request governed this work; the attached four-phase implementation guide was a reference, not authorization to implement later phases.

## Commit lineage

| Gate                                       | Commit                                     | Cumulative unique passing tests |
| ------------------------------------------ | ------------------------------------------ | ------------------------------: |
| Accepted Phase 2 starting baseline         | `7b15c483754c8aedd03c61c1ac2e9ff9fb664d16` |                             181 |
| Phase 3A: independent L2 verification      | `22b4858004848607647cea763ac27b0cbe2524a7` |                             274 |
| Phase 3B: registry-backed MCP and retries  | `f4879ae6b581d971d610de3f575489b235110d96` |                             326 |
| Phase 3C: onboarding and web control plane | `953e20b07deafa839a4d054521c833dfb9f09dc2` |                             396 |

The final implementation HEAD is `953e20b07deafa839a4d054521c833dfb9f09dc2`. The final repository HEAD is the documentation commit containing this completion record. Its exact hash is reported in the final delivery and can be resolved with `git log -1 --format=%H -- buyer-agent/docs/PHASE3_COMPLETE.md`. A commit cannot embed its own hash in its contents.

Each implementation phase passed its tests and exit gate, was audited, and was committed before the next phase began. No accepted Phase 1/2 commit was amended, squashed, or rewritten. No remote push was performed.

The pre-existing user edit in `buyer-agent/docs/PHASE1_COMPLETE.md` remains unstaged and excluded from all Phase 3 commits. Its SHA256 remains `9a510a322a585471857ce1c7e2e2edca914b6a80cc6efdaac40e682eb1261a16`. Baseline `seller-server/config/services.json` remains unchanged, SHA256 `5916af72392e00553137013a7049f7ef10ed8880c13033123c5031366a9d4533`.

## IMPLEMENTED: architecture and phase audits

One normalized service registry merges the read-only baseline with a gitignored runtime overlay. REST/x402, MCP discovery, Screen A registration, Screen B selection, and policy resolution consume this registry. Provider execution references server-owned profiles, separately from buyer-facing REST/MCP exposure.

Both transports feed the existing BuyerOrchestrator, TaskQuote, TaskManifestV1, ResultEnvelopeV1, VerificationPolicyV1, VerificationEngine and VerificationReport. The existing SettlementCoordinator alone authorizes/signs settlement, after a linked passing report, fresh Pending state and chain deadline safety check. L1 and L2 mandatory checks compose with logical AND. Failed verification never settles or cancels; refund eligibility follows the chain deadline, and a refund requires an explicit confirmed transaction.

The original Anchor account model, instructions, PDA seeds, economics, public/private settlement and NullifierRecord authority are unchanged. The seven L1 checks and policy-specific freshness skew retain their semantics. Private vouchers are issued only after successful verification. Application states are labeled separately from actual chain states.

- [Phase 3A audit](PHASE3A_AUDIT.md): exactly `source_sampling` and `test_suite`; post-result random challenges, independent bounded retrieval, trusted hashed bundles, isolated execution and aggregation. No MCP/web/onboarding code entered this phase.
- [Phase 3B audit](PHASE3B_AUDIT.md): registry-backed discovery, strict MCP contracts, payment challenge, explicit funding, idempotent retries, stdio terminal use and shared financial path. No web/onboarding code entered this phase.
- [Phase 3C audit](PHASE3C_AUDIT.md): server-only registration and overlay, all three screens, real lifecycle/report data, shared discovery and live onboarding flow.
- [Local runbook](PHASE3_RUNBOOK.md): prerequisites, configuration, launch instructions, terminal flow and regression commands.

Screen A validates and registers services server-side; write mode defaults to false. It accepts exact shared policy contracts and approved profile references, rejects unknown fields and secrets, computes policy hashes on the server, writes atomically and reads through seller discovery before showing success. Duplicate baseline/local IDs never override existing services. Malformed overlays preserve baseline discovery and block writes.

Screen B selects newly registered services over REST or MCP and invokes the real server-side core. Screen C renders only actual VerificationReport checks and observed chain actions. Failed verification displays Pending/awaiting eligibility, then refund available after the deadline, and refunded only after confirmation. No browser signing logic, private keys, environment secrets or provider credentials are bundled.

## TESTED: final non-overlapping regression

The final `npm run test:all` exited **0**. Its disjoint suites produced **396 passed, 0 failed**:

| Suite                                   |  Passed |
| --------------------------------------- | ------: |
| Seller: 24 Rust unit + 31 handler tests |      55 |
| Anchor/on-chain                         |       5 |
| Buyer unit                              |     191 |
| Buyer integration                       |      84 |
| Buyer live E2E                          |      33 |
| Real Docker sandbox                     |      14 |
| Browser/control plane                   |      14 |
| **Unique total**                        | **396** |

Build/typecheck, runtime emission, Prettier and `git diff --check` also passed. Original Role B assertions remain green. One seller test fixture uses an independent task ID for its changed-input submission under the new idempotency contract; its original assertions remain intact.

The aggregate gate runs the following commands, from `buyer-agent` unless noted. It stops and returns non-zero if any command fails; command failure propagation was encountered and verified during development.

```text
npm run build
npm run build:runtime
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:sandbox
npm run test:web
npm run format:check
cargo test --manifest-path seller-server/Cargo.toml                 (repository root)
node node_modules/ts-mocha/bin/ts-mocha -p tsconfig.json -t 1000000 tests/setra402.ts (repository root)
git diff --check                                                 (repository root)
```

On Windows the runner resolves Cargo under the configured user directory, preserves Windows Path, and adds the existing MinGW runtime directory when present. `test:e2e` builds the emitted runtime for actual stdio child-process tests. Live fixtures require the validator, Redis, seller, test keypair paths and pinned Docker image. Exact environment settings are documented in the runbook; no key material is recorded here.

All requested command equivalents are available:

```text
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:rest
npm run test:mcp
npm run test:l1
npm run test:l2
npm run test:privacy
npm run test:onboarding
npm run test:web
npm run test:all
```

Focused commands select overlapping tests and are not added to 396. The final focused L1 rerun passed 66 tests. The Phase 3A/3B focused L2 gate passed 89 tests; the Phase 3B MCP gate passed 46 tests. The final aggregate reran all their underlying tests, including subsequent additions. Phase cumulative totals (274, 326, 396) also overlap and must not be summed.

## TESTED: live matrix, parity and onboarding evidence

The final live suites exercise real local Solana transactions and the production transport/core/report/coordinator path. Source retrieval uses explicitly allowed deterministic local fixtures in test mode, and code verification uses actual Docker. No external provider is required.

| Scenario                            | Evidence/result                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| REST + public + L1 PASS             | Settled through SettlementCoordinator                                                                                          |
| REST + public + L1 FAIL             | Pending; explicit timeout refund after chain eligibility                                                                       |
| REST + public + L2 source PASS/FAIL | PASS settled; FAIL remained Pending                                                                                            |
| REST + public + L2 test PASS/FAIL   | PASS settled; FAIL remained Pending                                                                                            |
| MCP + public + L1 PASS/FAIL         | PASS settled; FAIL remained Pending                                                                                            |
| MCP + public + L2 source PASS/FAIL  | PASS settled; FAIL remained Pending                                                                                            |
| MCP + public + L2 test PASS/FAIL    | PASS settled; FAIL remained Pending                                                                                            |
| Onboarding                          | Actual Screen A registration, shared REST/MCP hash, Screen B invocation, escrow, verification, shared coordinator and Screen C |
| Terminal                            | Real stdio child process completed a protected task without a browser                                                          |
| Expired task                        | Existing HTTP 410 and deadline/refund behavior preserved                                                                       |
| Private compatibility               | Existing voucher/private settlement flow passed                                                                                |
| Duplicate nullifier                 | Actual on-chain rejection passed                                                                                               |
| Cancellation                        | Existing authorized cancellation/economics test passed                                                                         |

The 13 new onboarding live cases cover one complete browser registration-to-audit flow plus L1/source/test profiles over both transports with passing/failing results. Every failing live result remains Pending without settlement or cancellation. Registration read-back, REST discovery, MCP discovery and UI policy hashes agree. Seller discovery/invocation reload the merged registry, so new registrations require no adapter source change or seller restart.

REST and MCP share quote/envelope normalization and immutable policy/manifest semantics. Policy hash, normalized reports and coordinator calls are compared in integration tests, including all six quality pass/fail combinations. Live tests separately prove actual financial outcomes, public/private compatibility and terminal usability. Durable seller execution intents/result files and buyer quote/funding/result journals bind buyer/task/input/service/privacy and replay completed results rather than executing again.

Manual visual inspection covered the actual live verification audit screenshot. Automated headless browser checks cover 320/768/1024/1440 widths, keyboard focus, no browser console errors, all three screens, available policy types, registry/hash display, actual report rows and refund presentation.

## SIMULATED: explicit boundaries

- Browser presentation/refund tests substitute chain/controller state to exercise exact deadline and confirmed-refund rendering. The separate onboarding browser E2E uses actual transactions.
- REST/MCP report parity and settlement-composition integration tests substitute the chain signer/sandbox/source boundaries while using production engine/report/coordinator code. Real-chain E2E independently proves settlement and failed Pending outcomes.
- Unit sandbox/runner tests substitute execution to prove malformed artifact, unknown profile and bundle/hash mismatch prevent execution. The 14 Docker security tests independently run actual isolation, resource exhaustion and cleanup cases.

No simulated assertion is presented as external provider certification, hardware attestation, production authentication or a durable refund scheduler.

## TESTED/IMPLEMENTED: security controls

Source challenges use cryptographically secure 32-byte randomness after the immutable result hash and other commitments validate. Exclusive atomic persistence occurs before retrieval. Persisted seed plus immutable result context reproduces bounded unique sample indices. Tests cover ordering unpredictability, seed variation/replay and malformed/duplicate indices.

Production retrieval is deny-by-default: HTTPS, exact committed domain allowlist, no credentials, public DNS/IP only and pinned connection lookup. Original URL, each redirect, DNS answers and resolved addresses are checked. Localhost, alternate IPv4 encodings, private/link-local/metadata addresses, IPv6 local/mapped addresses, unsafe schemes, private redirects and rebinding opportunities fail closed. Limits are separate from policy freshness: DNS/connect 3 seconds, read 5 seconds, response 262144 bytes, redirects 3 and concurrency 4. Explicit fixture origins cannot be enabled in production. Comparison is exact, missing fields fail, and thresholds use integer BPS.

Policies select only `runner_profile`, `test_bundle_hash` and `timeout_seconds`. The trusted registry owns command/image/bundle selection. The artifact descriptor is result-committed; actual artifact bytes and actual trusted bundle SHA256 are checked before execution. Unknown profile, bad evidence, hash mismatch or unavailable isolation fails closed without execution or settlement.

The pinned `node22-test-v1` container runs UID/GID 65534, with `--network none`, read-only root and input, no capabilities, no-new-privileges, private namespaces, 128MiB memory/swap, 0.5 CPU, 64 PIDs, bounded file descriptors/Node heap, 16MiB ephemeral work tmpfs, wall-clock timeout and 65536-byte output limit. No host repository, Docker socket, SSH agent, credentials, keys or verifier environment is mounted/passed. Forced container removal and fixed input cleanup run after success, failure, crash and timeout. Real tests cover memory/PID exhaustion, network denial, secret/socket attempts and cleanup. Containers are non-root; the tested WSL daemon is not rootless.

The local web/MCP HTTP boundaries validate Host/Origin and bound bodies/time. Web mutation requires a process-local CSRF token; client assets use a strict CSP. Automated scanning covers production-served browser assets/configuration and rejects financial/provider/admin secrets. Browser inputs cannot define shell, stdio, Docker, host executable/path or entrypoint configuration. The four approved deterministic provider profiles are server-owned and require no new credential provisioning.

## Failures encountered and fixes

- Source IPv6 parsing and artifact-evidence replacement weaknesses found during implementation were fixed with regression tests; artifact/process/stdout spoof attempts fail.
- Read-only Docker staging was corrected to isolated read-only inputs; PID exhaustion tests were corrected to reach the actual cgroup PID limit rather than a file-descriptor limit. Trusted tests retain authority over the verdict.
- Seller fixture task-ID reuse was corrected for the durable retry contract. Host rejection tests use native HTTP because fetch ignored the custom Host header. Browser option waits and mobile hash wrapping were corrected.
- Windows Path handling was corrected in the fail-fast runner. WSL/validator fixture interruptions were recovered without weakening tests.
- C: became full during local validator work. An obsolete task-created disposable ledger was deleted only after path/ownership verification. Automatic approval review rejected pruning an existing persistent ledger; a separately verified new bounded ledger was used instead, preserving existing history. The recovered full regression passed.

These fixes are detailed in the individual phase audits. No unresolved test failure remains.

## All exit gates

- [x] **3A:** exactly two L2 adapters, post-result secure challenge, reproducible audit seed, strict policy fields, exact comparisons and integer BPS.
- [x] **3A:** original/redirect URL and DNS/IP SSRF denial; connect/read/size/redirect/concurrency limits; explicit test-only fixtures.
- [x] **3A:** trusted runner registry, actual bundle hash and committed artifact enforcement; seller cannot select executable commands.
- [x] **3A:** networkless/read-only/non-root/resource-limited sandbox; no host secrets; success/crash/timeout cleanup proven.
- [x] **3A:** L1 AND L2 aggregation; only shared coordinator settles PASS; FAIL never settles/cancels; refund follows chain deadline.
- [x] **3A:** original Phase 1/2, Role B and Anchor green before 3B; no MCP/web/onboarding/Phase 4 code at this gate.
- [x] **3B:** shared-registry discovery, payment challenge, funded retry, durable idempotency and terminal flow without browser.
- [x] **3B:** strict bounded hostile inputs; no secrets/command/policy override; L1/L2 PASS/FAIL, expiration and public/private compatibility.
- [x] **3B:** REST/MCP policy/report/settlement parity; same SettlementCoordinator; no duplicate MCP financial implementation.
- [x] **3B:** Phase 1/2/3A, Role B and Anchor green before 3C; no web/onboarding/Phase 4 code at this gate.
- [x] **3C onboarding:** server-only writes, disabled by default; unchanged baseline, isolated gitignored overlay, duplicate rejection and atomic read-back.
- [x] **3C onboarding:** exact shared policy validator and server-authoritative hash; L1/L2 supported; L3/AI rejected/inactive.
- [x] **3C onboarding:** server-allowlisted profiles; no arbitrary shell/MCP configuration or raw provider secrets.
- [x] **3C onboarding:** registered service visible through REST, MCP and Screen B; identical hashes; real registration-to-settlement/audit E2E.
- [x] **3C web:** all three screens, REST/MCP selection, real orchestrator/VerificationReport data; no browser signing authority or secrets.
- [x] **3C web:** failed verification never appears settled; precise Pending/refund lifecycle; app states distinct from Anchor states; actual-only audit checks.
- [x] **Final regression:** Phase 1/2/3A/3B, Role B, Anchor, private settlement, duplicate nullifier, HTTP 410, cancellation, build/typecheck/format/diff all green.
- [x] **Scope/history:** separate reviewed commits, user Phase 1 edit excluded, no Role A/economic/PDA change, no Phase 4 implementation.

## Files added

```text
buyer-agent/config/test-bundles/add-v1.mjs
buyer-agent/docs/PHASE3A_AUDIT.md
buyer-agent/docs/PHASE3B_AUDIT.md
buyer-agent/docs/PHASE3C_AUDIT.md
buyer-agent/docs/PHASE3_COMPLETE.md
buyer-agent/docs/PHASE3_RUNBOOK.md
buyer-agent/scripts/test-all.mjs
buyer-agent/src/core/runtime.ts
buyer-agent/src/core/task-controller.ts
buyer-agent/src/mcp/contracts.ts
buyer-agent/src/mcp/core-tools.ts
buyer-agent/src/mcp/protocol.ts
buyer-agent/src/mcp/seller-adapter.ts
buyer-agent/src/mcp/server.ts
buyer-agent/src/mcp/stdio.ts
buyer-agent/src/registry/services.ts
buyer-agent/src/transport/mcp.ts
buyer-agent/src/verification/level2/challenge-store.ts
buyer-agent/src/verification/level2/default-runners.ts
buyer-agent/src/verification/level2/docker-sandbox.ts
buyer-agent/src/verification/level2/runner-registry.ts
buyer-agent/src/verification/level2/source-client.ts
buyer-agent/src/verification/level2/source-sampling.ts
buyer-agent/src/verification/level2/test-suite.ts
buyer-agent/src/web/server.ts
buyer-agent/src/web/start.ts
buyer-agent/tests/e2e/level2-flow.test.ts
buyer-agent/tests/e2e/mcp-flow.test.ts
buyer-agent/tests/e2e/mcp-terminal.test.ts
buyer-agent/tests/e2e/onboarding-flow.test.ts
buyer-agent/tests/fixtures/browser.ts
buyer-agent/tests/fixtures/verification-harness.ts
buyer-agent/tests/integration/level2-settlement.test.ts
buyer-agent/tests/integration/mcp-transport.test.ts
buyer-agent/tests/integration/mcp-verification-parity.test.ts
buyer-agent/tests/integration/onboarding-api.test.ts
buyer-agent/tests/integration/source-verification.test.ts
buyer-agent/tests/integration/task-controller.test.ts
buyer-agent/tests/sandbox/docker-sandbox.test.ts
buyer-agent/tests/unit/mcp-contracts.test.ts
buyer-agent/tests/unit/onboarding.test.ts
buyer-agent/tests/unit/source-sampling.test.ts
buyer-agent/tests/unit/test-suite.test.ts
buyer-agent/tests/web/control-plane.test.ts
buyer-agent/tsconfig.runtime.json
frontend/app.js
frontend/index.html
frontend/styles.css
seller-server/config/provider-profiles.json
```

## Files modified

```text
.gitignore
buyer-agent/package.json
buyer-agent/src/chain/settlement-coordinator.ts
buyer-agent/src/transport/rest-x402.ts
buyer-agent/src/types.ts
buyer-agent/src/verification/coordinator.ts
buyer-agent/src/verification/engine.ts
buyer-agent/src/verification/policy.ts
seller-server/src/config.rs
seller-server/src/handlers.rs
seller-server/src/lib.rs
seller-server/src/registry.rs
seller-server/tests/handlers_test.rs
```

The three implementation commits change 61 files: 48 added, 13 modified, 7808 insertions and 47 deletions. This completion record adds one documentation file, bringing Phase 3 to 62 files. The pre-existing unstaged Phase 1 edit is excluded from these counts. Dependency versions and lockfiles are unchanged.

## DEFERRED / remaining limitations

- Local/hackathon loopback control plane with trusted host configuration, no production provider/account/admin authentication, billing, organizations, database or marketplace.
- Four preconfigured deterministic provider profiles; no arbitrary connector definitions, external-provider certification or new credential provisioning.
- Source V1 retrieves bounded JSON and performs exact comparisons; no fuzzy matching or HTML extraction.
- The pinned pure-module test runner is deliberately narrow: synchronous numeric fixture functions without imported dependencies. Docker/image availability is required; failure is closed. Docker shares the host kernel and is not TEE/ZK or hardware isolation. Daemon cleanup failures require operator recovery.
- File-based journals fail closed on ambiguous execution/funding intents; operator reconciliation is required. No durable refund scheduler or automatic refund is claimed.
- Node 22.19.0 and the accepted 11 existing Anchor/Solana transitive npm advisories remain; dependencies were not downgraded to silence audit output.
- Live tests need a validator, Redis, seller, funded fixture accounts, pinned Docker image and headless browser. Local test keys remain outside browser assets and commits.
- Phase 4 TEE, ZK, multi-attestor, AI, staking/slashing, decentralized verifier mesh and production marketplace/account/billing systems remain deferred. No new Anchor instruction, PDA seed or economics was introduced.

**STOP: Phase 3 delivery ends here.**
