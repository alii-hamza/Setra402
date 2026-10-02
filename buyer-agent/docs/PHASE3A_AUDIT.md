# Phase 3A audit

Starting baseline: `7b15c48` on `agent-validator`. The pre-existing edit in
`docs/PHASE1_COMPLETE.md` is preserved byte-for-byte and excluded from staging.
The pasted Phase 3 request is authoritative over the attached four-phase guide.
No Anchor program, PDA, economic, privacy, or nullifier behavior was changed.

## IMPLEMENTED

Exactly two Level-2 adapters extend the existing strict policy and engine:
`source_sampling` and `test_suite`. All mandatory L1 and L2 checks must pass.
Only the existing `SettlementCoordinator` can settle, after a linked passing
report, fresh Pending state, manifest memo, and chain deadline safety check.
Failure never invokes cancellation and never changes chain state before refund.

Source challenges are cryptographically random 32-byte seeds generated only
after manifest, policy, envelope and immutable result commitments pass. An
exclusive atomic file link persists each context's seed before source retrieval;
report details contain the seed, context, indices and actual comparisons.
Hash ranking selects unique bounded indices and reproduces the same selection.

Production source access requires HTTPS, exact committed domains, no URL
credentials, and public-unicast DNS answers. The connection uses the validated
IP without another lookup. Every redirect repeats URL/domain/DNS/IP validation.
Loopback, private, link-local, metadata, mapped IPv6, alternate IPv4 encodings,
unsupported schemes, unsafe redirects and mixed DNS answers fail closed.
Limits: connect/DNS 3 seconds, read 5 seconds, body 262144 bytes, redirects 3,
global active retrievals 4, URL 2048 characters, samples 100 maximum.
Explicit local fixture origins are accepted only in test mode.

The trusted `node22-test-v1` profile selects an immutable official Node image and
the checked-in `config/test-bundles/add-v1.mjs`. Policy supplies only profile ID,
SHA256 test-bundle hash and timeout. Artifact descriptor `{id, content_hash,
size_bytes}` must appear at `result.artifact`, bound by `result_hash`, and match
artifact evidence and actual bytes before execution. Bundle mismatch means no
execution. The trusted tests supervise a separate worker with an empty module
context, disabled imports/string/wasm generation, primitive inputs and synchronous
numeric outputs. Both supervisor and worker disable signal-triggered debugging.
VM limits reduce API access; Docker remains the security boundary. Artifact
`process.exit(0)` and stdout spoofing cannot skip the trusted assertions.

Docker executes as UID/GID 65534 with network none, read-only root, capabilities
dropped, no-new-privileges, 128MiB memory/swap cap, 0.5 CPU, 64 PIDs, 128 FDs,
64MiB Node heap, bounded wall time and 65536-byte output. Its only host mount is
an exclusive read-only input directory containing two fixed-name files. `/work`
is a 16MiB ephemeral tmpfs. No repository, keys, Docker socket, credentials,
host PID/network namespace or verifier environment is supplied. Force removal
terminates children on success, failure, output overflow or timeout, then fixed
input files and their directory are removed. Missing Docker/image fails closed.

## TESTED

- Seller: 43 passed (18 unit, 25 integration); every original Role B test passes.
- Anchor: 5 passed, including economics, cancellation, refund and on-chain
  duplicate-nullifier rejection.
- Buyer unit: 144 passed.
- Buyer integration: 58 passed.
- Buyer live E2E: 10 passed (original 6 plus 4 L2 cases).
- Real Docker security suite: 14 passed.
- Unique total: **274 passed, 0 failed**.
- Focused L2: 89 passed; overlaps the above and is not added again.

Commands (with the Phase 1 fixture environment and local validator/Redis/seller):

```powershell
$env:PATH = 'C:\msys64\mingw64\bin;' + $env:PATH
& 'C:\Users\sulov\.cargo\bin\cargo.exe' test --manifest-path seller-server/Cargo.toml
$env:ANCHOR_PROVIDER_URL = 'http://127.0.0.1:8899'
$env:ANCHOR_WALLET = (Resolve-Path target/localnet-buyer.json).Path
npx ts-mocha -p ./tsconfig.json -t 1000000 tests/setra402.ts
Set-Location buyer-agent
$env:ROLE_C_DOCKER_WSL = '1'
npm run test:all
npm run test:l2
```

Build/typecheck and `git diff --check` pass. Changed TS/MJS/JSON files are
formatted with the existing Prettier. The user's Phase 1 document is not formatted.

Real L2 E2E uses a deterministic HTTP seller/source fixture, production REST
transport/verification/orchestrator, real Solana escrow and settlement, and real
Docker execution. Source PASS and test PASS settle; both FAIL cases stay Pending.
Original private settlement, HTTP 410, cancellation and timeout refund are live.

## SIMULATED

The small settlement-composition integration harness substitutes a chain signer
and source-response boundary. Its reports, engine and SettlementCoordinator are
production code. It proves no settlement/cancellation on L2 failure and the refund
deadline boundary. The live tests independently exercise the actual chain.
Unit runner tests substitute the sandbox to prove no execution on bad commitments;
the Docker suite independently proves actual resource and isolation enforcement.

## Fixes found during verification

- IPv6 loopback parsing initially accepted an empty first group; regression fixed.
- Docker refuses copying inputs into a read-only container; isolated read-only
  input mounting fixes staging without weakening the root filesystem.
- PID exhaustion initially hit the lower FD limit; ignored child I/O now reaches
  the actual cgroup PID cap. CPU, memory and PID cgroup values are also asserted.
- Detached evidence replacement is blocked by the canonical result descriptor.
- The trusted worker now restricts process/import access and rejects stdout
  spoofing and attempts to terminate the worker in place of running the export.

## Limitations and deferred work

Sources are bounded JSON documents with exact field equality; no fuzzy matching
or HTML scraping is claimed. Profiles are server-controlled and deliberately
limited to a synchronous, numeric single-module addition fixture with a native
Node test bundle; importing dependencies is unavailable in this V1 profile.
The sandbox container runs non-root; the local WSL Docker daemon runs as root.
Docker is isolation with a shared kernel, not TEE/ZK or a VM security guarantee.
Daemon failure during cleanup fails verification and requires operator recovery.
No durable refund scheduler exists. Node 22 and the accepted transitive npm
advisories remain. Live tests need validator, Redis, seller and the pinned image.

## Exit gate

- [x] source_sampling, post-result randomness, persisted challenge replay
- [x] deny-by-default SSRF, redirect/DNS/private-address tests, all active limits
- [x] test_suite, trusted registry, immutable test-bundle hash, committed artifact
- [x] non-root/read-only/networkless sandbox, CPU/memory/PID/time/output bounds
- [x] secret isolation, crash/timeout cleanup and resource exhaustion tested
- [x] L1 + L2 PASS settles through existing coordinator; FAIL never settles/cancels
- [x] refund follows chain deadline
- [x] Phase 1, Phase 2, Role B and Anchor regression green
- [x] no MCP, frontend, onboarding or Phase 4 code added

3B may begin after this audit and its separate 3A commit are recorded.
