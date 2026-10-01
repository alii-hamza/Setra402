# Role C Phase 1 Completion Record

Completed on 2026-10-01. Phase 2 was not started.

## Commit and baseline

- Phase 1 implementation commit: `97db09fc5dfe2845a5c7fd74aa0cb87d51460a98`
- Baseline Role B commit: `0c5e2f9e3e2b487f5c833df7859112344b409721`
- Working branch: `codex/role-c-phase1`, created from `origin/feature/seller-server-integration`
- Initial checked-out branch: `feature/seller-server-integration`; it was clean but behind its remote, so the Phase 1 branch was created from the remote Role B head before testing or editing.
- Baseline Git status at the Role B head: clean
- Rust: `rustc 1.89.0 (29483883e 2025-08-04)`, `cargo 1.89.0`
- Node: `v22.19.0`
- Baseline Role B suite: 38 passed, 0 failed (16 unit and 22 integration)
- Existing on-chain suite after local infrastructure was available: 5 passed, 0 failed

## Files added

- `buyer-agent/.env.example`
- `buyer-agent/.gitignore`
- `buyer-agent/README.md`
- `buyer-agent/package.json`
- `buyer-agent/package-lock.json`
- `buyer-agent/tsconfig.json`
- `buyer-agent/docs/live-contract.md`
- `buyer-agent/docs/PHASE1_COMPLETE.md`
- `buyer-agent/src/config.ts`
- `buyer-agent/src/errors.ts`
- `buyer-agent/src/orchestrator.ts`
- `buyer-agent/src/quote.ts`
- `buyer-agent/src/types.ts`
- `buyer-agent/src/chain/client.ts`
- `buyer-agent/src/chain/escrow.ts`
- `buyer-agent/src/chain/memo.ts`
- `buyer-agent/src/chain/pda.ts`
- `buyer-agent/src/chain/settlement-coordinator.ts`
- `buyer-agent/src/chain/settlement.ts`
- `buyer-agent/src/manifest/canonicalize.ts`
- `buyer-agent/src/manifest/hash.ts`
- `buyer-agent/src/manifest/store.ts`
- `buyer-agent/src/privacy/legacy-chaumian.ts`
- `buyer-agent/src/transport/rest-x402.ts`
- `buyer-agent/src/transport/types.ts`
- `buyer-agent/tests/unit/config.test.ts`
- `buyer-agent/tests/unit/http-errors.test.ts`
- `buyer-agent/tests/unit/phase1-core.test.ts`
- `buyer-agent/tests/unit/privacy.test.ts`
- `buyer-agent/tests/integration/escrow.test.ts`
- `buyer-agent/tests/integration/orchestrator.test.ts`
- `buyer-agent/tests/integration/rest-x402.test.ts`
- `buyer-agent/tests/integration/settlement.test.ts`
- `buyer-agent/tests/e2e/rest-flow.test.ts`

## Files modified

- `seller-server/src/rpc.rs`: the seller's raw `getAccountInfo` call now requests `confirmed` commitment. This removes a live race in which a newly confirmed escrow was still read at the RPC default (`finalized`) and incorrectly returned another 402. A Rust regression test was added in the same file.

No Anchor program, PDA seed, program economic, shared protocol, or existing Role B test file was changed.

## Architecture delivered

- Strict environment/config validation, including file-backed buyer and verifier keypairs and a required protocol treasury.
- IDL-driven Anchor chain client with fresh transaction construction on retry and explicit confirmation-error checking.
- Task/vault/nullifier PDA and SPL associated-token-account derivation.
- Seller authority resolution from the quoted seller token account's on-chain owner.
- Quote validation for program, task/vault PDAs, verifier, mint, privacy flag, amount, timeout, and fee.
- REST/x402 transport with typed HTTP mapping, bounded network/5xx retries, bounded post-funding 402 retry, and terminal 410 handling.
- Idempotent escrow initialization followed by a `TaskState` re-read and verification of all funded state fields.
- Canonical manifest generation, SHA-256 commitment, local manifest store, memo encoding, and memo verification before settlement.
- Settlement coordinator covering public settlement, existing Chaumian/private settlement, timeout refund, voluntary cancellation, duplicate-nullifier pre-check, and deadline safety margin.
- The existing legacy private endpoints are isolated behind `privacy/legacy-chaumian.ts`; no private protocol or `NullifierRecord` semantics were rewritten.
- Redis remains a best-effort post-settlement cache mirror; on-chain state is the financial/nullifier source of truth.

## Commands used

Baseline Role B tests:

```powershell
$env:PATH="C:\msys64\mingw64\bin;$env:PATH"
& "$env:USERPROFILE\.cargo\bin\cargo.exe" test --manifest-path seller-server/Cargo.toml
```

Local chain build and infrastructure (inside the repository's WSL environment):

```bash
cargo-build-sbf --manifest-path programs/setra402/Cargo.toml
redis-cli ping
solana-test-validator --reset --bpf-program FUjN9K7C5yHr5NhVrJ7WCgifgDiBJnSDDGQjnNkUDBMN target/deploy/setra402.so
```

Local fixture and seller-server:

```powershell
node target/e2e-setup.mjs
$env:RPC_HOST='127.0.0.1'
$env:RPC_PORT='8899'
$env:PROGRAM_ID='FUjN9K7C5yHr5NhVrJ7WCgifgDiBJnSDDGQjnNkUDBMN'
$env:MINT='2sJWCuH6WudSk5PrBQrEx6YiPKxZSEiBXJgL91KpME9U'
$env:SELLER_TOKEN_ACCOUNT='BhZG93Tqic7EEkUvwG3MrsVSwyqK3qrpwXmpyGtERRh8'
$env:VERIFIER='2mNGgw8WwLDv8vb1UbSXPGzLXv1YfTEbVSoudmVosoky'
$env:PROTOCOL_TREASURY='FfD3jAiMbk9zL3Tj2Zs4n99eW9xmMinqbDHZ48rxXJ9T'
$env:TASK_PRICE='1500000'
$env:TASK_TIMEOUT_SECONDS='180'
$env:REDIS_URL='redis://127.0.0.1:6379'
cargo run --manifest-path seller-server/Cargo.toml
```

Existing on-chain tests:

```powershell
$env:ANCHOR_PROVIDER_URL='http://127.0.0.1:8899'
$env:ANCHOR_WALLET=(Resolve-Path 'target/localnet-buyer.json').Path
npx ts-mocha -p ./tsconfig.json -t 1000000 tests/setra402.ts
```

Buyer-agent tests (with the live local validator, Redis, and seller-server running):

```powershell
Set-Location buyer-agent
$env:ROLE_C_RPC_URL='http://127.0.0.1:8899'
$env:ROLE_C_SELLER_URL='http://127.0.0.1:3000'
$env:ROLE_C_PROGRAM_ID='FUjN9K7C5yHr5NhVrJ7WCgifgDiBJnSDDGQjnNkUDBMN'
$env:ROLE_C_EXPECTED_MINT='2sJWCuH6WudSk5PrBQrEx6YiPKxZSEiBXJgL91KpME9U'
$env:ROLE_C_PROTOCOL_TREASURY='FfD3jAiMbk9zL3Tj2Zs4n99eW9xmMinqbDHZ48rxXJ9T'
$env:ROLE_C_BUYER_KEYPAIR_PATH=(Resolve-Path '..\target\localnet-buyer.json').Path
$env:ROLE_C_VERIFIER_KEYPAIR_PATH=(Resolve-Path '..\target\e2e-verifier.json').Path
npm run test:all
```

Final focused verification and hygiene:

```powershell
npx prettier --check "**/*.{ts,json,md}"
npm run build
npm run test:unit
npm run test:integration
npm audit --json
git diff --check
```

## Final test results

| Suite                                           | Passed | Failed |
| ----------------------------------------------- | -----: | -----: |
| Role B seller-server (17 unit + 22 integration) |     39 |      0 |
| Existing Anchor/on-chain suite                  |      5 |      0 |
| Role C unit                                     |     25 |      0 |
| Role C integration                              |     14 |      0 |
| Role C live E2E                                 |      4 |      0 |
| **Total executed**                              | **87** |  **0** |

The Role C aggregate was 43 passed and 0 failed. The Role B suite increased from 38 to 39 because of the new confirmed-commitment regression test; all pre-existing tests remained green.

The live E2E cases exercised:

- unpaid request -> real 402 -> `initialize_task` -> funded `TaskState` re-read -> seller retry -> public settlement;
- private settlement through the existing Chaumian flow and duplicate on-chain nullifier rejection;
- real 410 expiry -> timeout refund;
- voluntary cancellation compatibility.

## Manual live checks

- Built the checked-in Anchor program and loaded it into Agave `solana-test-validator 4.3.0` at the declared program ID.
- Started Redis `8.0.5` and verified `PONG`.
- Started the real seller-server against the validator and Redis.
- Confirmed the exact unpaid HTTP 402 quote and independently derived its task/vault PDAs.
- Confirmed a real funded request returned HTTP 200 after the on-chain `TaskState` became Pending.
- Confirmed a genuinely expired Pending task returned HTTP 410 with the expected deadline payload.
- Recorded the observed wire contract in `buyer-agent/docs/live-contract.md`.

## Documentation/source discrepancies

- `PHASE3_MINT_INTEGRATION.md`, referenced by the handoff and requested reading list, does not exist in the checked-out repository or its visible history. Mint/account behavior was taken from the IDL, program, seller source, and tests.
- The guide describes future `serviceId` and verification-policy fields that the current seller quote does not emit. Phase 1 does not invent them; the caller supplies the service ID and expected policy hash used in the manifest.
- The seller configuration treats the treasury as optional, but the IDL requires `protocol_treasury` for settlement/cancellation. Role C therefore requires it in validated configuration and never supplies `null`.
- `initialize_task` expects the seller authority, while the quote supplies a seller token account. Role C reads that token account and uses its owner as the seller authority.
- The old handoff's Rust 1.75 assumption is obsolete; the repository pins and successfully uses Rust 1.89.0.
- Public settlement currently has no on-chain deadline guard, whereas private settlement does. Role C applies the same pre-settlement safety margin to both paths.

## Known limitations and residual risks

- The guide prefers Node 20; the repository does not pin Node 20, and Phase 1 was built/tested on the available Node `v22.19.0`.
- `npm audit` reports 11 unresolved transitive advisories (5 high, 6 moderate) in the Anchor/Solana v1 dependency chain. Anchor has no fix for its transitive `toml` advisory; the runtime does not parse untrusted TOML. The suggested SPL/web3 fixes are incompatible downgrades. The chain client uses the repository-compatible Anchor/web3 v1 stack, and all account inputs are fixed-format/validated, but dependency updates should be tracked upstream.
- Manifest storage is local filesystem storage. It is suitable for this Phase 1 single-agent process, not a future distributed marketplace.
- E2E tests require an externally running local validator, Redis, seller-server, and funded fixture accounts; generated fixture keys remain ignored under `target/` and are not committed.
- `cargo fmt --all --check` reports pre-existing formatting differences across unrelated Rust files. Phase 1 did not reformat Role A/B wholesale.

## Intentionally deferred to Phase 2 and later

- Level-1 verification modules and verification reports
- Level-2 source sampling and test runner
- Policy fields in the seller quote/API unless added compatibly by a later phase
- MCP transport
- Frontend/browser code
- AI advisory, TEE, ZK, verifier mesh, marketplace, and database work

## Phase 1 exit gates

- [x] Correct strict TypeScript setup and validated configuration
- [x] Existing Role B suite remains green
- [x] Public REST/x402 live flow completes from 402 through settlement
- [x] Private legacy flow settles without changing its cryptographic/on-chain semantics
- [x] Expired HTTP 410 flow reaches timeout refund and never calls cancellation
- [x] Buyer ATA, verifier, mint, privacy flag, amount, timeout, program, and PDAs are verified
- [x] Seller authority is resolved from the seller token account owner
- [x] Required treasury is enforced
- [x] Funded `TaskState` is re-read and verified
- [x] Retry/idempotency and stale-transaction rebuilding are covered
- [x] Manifest hash is committed in a memo and verified before settlement
- [x] Settlement safety margin is enforced
- [x] Public settlement, timeout refund, cancellation, private settlement, and duplicate nullifier rejection are covered by live tests
- [x] Buyer/verifier private keys are server-side only; no frontend was added
- [x] Phase 2 work was not started

Every Phase 1 exit gate is satisfied.
