# Phase 4B completion audit — real provider infrastructure

## Certification record

- Branch: `agent-validator`.
- Accepted starting HEAD: `b221ac2` (Phase 4A complete; 684 unique passed).
- 4B.1 provider identity and recovery-capability contract: `3235e49`.
- 4B.2 opaque server-side secret references: `b4e7e0f`.
- 4B.3 bounded REST and MCP provider connectors: `459e35e`.
- 4B.4 activation, health, onboarding, and shared lifecycle: `4b54121`.
- Certification fixes before this audit: `5d31e12` (fresh seller build plus
  compatible local lead fixture capabilities), `029e39c` (Screen A profile
  capability selection), and `5548557` (format the complete-regression runner).
- Implementation HEAD before this audit: `5548557`.
- This audit is committed separately, so its commit is the final certification
  HEAD. No accepted Phase 1–4A commit was amended, rebased, squashed, or
  rewritten.

Phase 4B is complete at this point. Phase 4C and Phase 4D were not started.

## Provider model and authority boundary

`ProviderDefinitionV1` is the shared, versioned server-side provider contract.
It declares the provider ID and display name, connector type, supported service
capabilities, execution profile, activation state, opaque secret references, and
every recovery property: keyed/no idempotency, execution-ID support, status
query, durable receipt, deterministic replay, and non-idempotent external-effect
risk. Unknown definition versions, connector types, IDs, duplicate registry
records, missing declarations, and inconsistent capability combinations fail
closed. The existing local fixtures remain first-class provider profiles.

The provider catalog is authoritative for server service validation, REST/x402
discovery, buyer-facing MCP discovery, Screen A selection, seller dispatch, and
operator inspection. The provider connector owns no escrow, settlement, refund,
verification, or verifier authority. `SettlementCoordinator`, the financial
reconciler, and the refund scheduler retain their existing authority boundaries.

Provider declarations flow into existing provider evidence,
`RecoveryInventoryV1`, and `ReconciliationWorker`; no parallel reconciliation
engine was introduced. A lost acknowledgement, timeout, disconnected MCP
transport, missing execution ID, or missing receipt never proves non-execution.
Where a provider cannot establish an external outcome, the authoritative result
remains `UNKNOWN_EXTERNAL_EFFECT`; financial ambiguity remains
`UNKNOWN_FINANCIAL_OUTCOME` / `RECONCILIATION_REQUIRED` as applicable.

## Secret-reference architecture

Provider definitions contain opaque `secret_ref` values only. `SecretResolver`
resolves an allowlisted reference on the seller only, from the constrained local
environment/file backend. It rejects unknown references, invalid versions,
missing values, traversal, and arbitrary environment lookup; required-secret
absence makes the provider unavailable. Evidence binds credential identity and
version so rotation cannot reinterpret an in-flight receipt.

Raw provider credentials cannot be supplied by Screen A, REST/x402 tasks,
buyer-facing MCP, provider execution input, policies, manifests, evidence,
operator output, or browser bundles. The browser exposes only safe provider
metadata and `AVAILABLE`/`MISSING` secret state. The local resolver is explicitly
not a production KMS; production key custody, remote secret rotation workflow,
and administrative authentication remain out of scope.

## Provider connectors and network controls

`LOCAL_FIXTURE`, `REST_API`, and `MCP_TOOL` profiles coexist. REST configuration
is server owned: fixed endpoint/path/status template, explicit host allowlist,
timeouts, response cap, idempotency-header mapping, and server-side extraction
rules. HTTPS is the default; URL credentials, unapproved hosts, localhost/private
or link-local/metadata targets outside explicit test mode, unsafe DNS answers,
redirect abuse, oversized responses, and cross-host credential forwarding fail
closed. Redirects are capped and revalidated; requests and connector concurrency
are bounded.

REST dispatch derives a stable identity from immutable Setra task/provider/service
bindings. A changed input, service, privacy mode, or provider binding cannot
reuse it. Where declared, execution IDs, provider status, receipt commitments,
response commitments, and timestamps are persisted in the existing evidence
store; status recovery is used only when the declared provider contract permits
it.

The provider-facing MCP connector is separately configured from the buyer-facing
Setra MCP transport. It permits only configured remote profiles and exact tool
names/request schema, with bounded initialization/calls/results and server-side
secret resolution. Browser-provided stdio commands, executables, arguments,
environment variables, paths, and arbitrary provider connector configuration are
rejected. MCP disconnects retain ambiguity until declared provider evidence or a
safe status query resolves it.

## Activation, health, onboarding, and recovery

Only a provider that is active, has compatible configuration, and has all
required secret references available accepts a new dispatch. Health is bounded
server-side operational evidence (credential availability, configuration and
capability compatibility, endpoint/MCP/status availability where applicable).
`ACTIVE`, `INACTIVE`, and `DEGRADED` observations do not rewrite historical
evidence or decide whether a previous external effect occurred.

Screen A displays the server-owned profile, connector type, safe capability
summary, secret availability, activation state, and health state. The profile
selector now preserves a compatible capability selection or chooses that
profile's first allowlisted capability. It therefore cannot retain the default
echo capability when the lead profile is selected. The server remains the
fail-closed capability authority; this is a UI correctness repair, not an
allowlist expansion.

New provider-backed services are normalized once and visible through Screen B,
REST/x402, buyer MCP discovery, seller execution, operator inspection, provider
evidence, `RecoveryInventoryV1`, and `ReconciliationWorker`.

## Verification evidence

### Focused gates

Focused checks are intentionally overlapping and are not added to the unique
full-regression count:

| Focused check                                            |    Result |
| -------------------------------------------------------- | --------: |
| Buyer onboarding/MCP/secret-boundary checks              | 62 passed |
| Browser control-plane, including the Screen A regression | 15 passed |
| Seller lifecycle/activation/evidence checks              | 44 passed |
| REST/MCP connector checks                                |  7 passed |
| Provider evidence-store restart/binding checks           |  2 passed |
| Server secret resolver checks                            |  5 passed |
| Focused live buyer E2E (REST/x402 and buyer MCP)         | 46 passed |
| Exact formerly timing-sensitive REST live suite          |  6 passed |

`npm run build`, `npm run build:runtime`, `npm run format:check`, and
`git diff --check` also passed before final certification.

### Local-network/live coverage

The live gate uses a fresh local Solana validator, Redis, copied seller process,
and a warmed pinned Docker runner; it does not require a paid third-party API.
The deterministic REST and MCP provider fixtures exercise the real connector
networking code. Live coverage includes REST and buyer-facing MCP task flows,
provider execution evidence/status recovery, lost acknowledgements, replay,
restart, concurrent dispatch, on-chain settlement/refund, and operator evidence.
These are local provider fixtures, not external-provider certification.

### Simulated coverage

Unit/integration tests cover malformed or corrupt records, unknown provider
versions, invalid capability combinations, secret rotation mismatch, SSRF and
redirect rejection, oversized/invalid connector responses, missing recovery
support, receipt/status binding mismatch, and provider activation/health
transitions. Simulated failure boundaries do not claim an external provider
effect occurred.

### Final non-overlapping regression

The final-tree `npm run test:all` exited `0` and passed `build`,
`build:runtime`, `format:check`, and `git diff --check`. It reports **727
unique passed, 0 failed**:

| Disjoint suite                                    | Passed |
| ------------------------------------------------- | -----: |
| Buyer unit                                        |    439 |
| Buyer integration                                 |    116 |
| Buyer live E2E                                    |     46 |
| Docker sandbox                                    |     15 |
| Browser/web, including browser/client secret scan |     15 |
| Seller Rust                                       |     91 |
| Anchor                                            |      5 |

The browser/client secret scan is part of the browser suite and passed. No raw
provider secret appeared in the reviewed diff, browser bundle checks, provider
evidence, or focused secret-boundary tests.

## Bugs discovered and corrections

1. **C — Screen A integration defect.** Selecting `fixture-lead` left the
   default `setra402.task.echo` capability in place, which the strict server
   registry correctly rejected. The lead service consequently never registered,
   making downstream REST/MCP discovery unavailable. `029e39c` keeps an already
   compatible user selection and otherwise selects the profile's first declared
   capability; the browser regression proves the lead/echo switch. No provider
   capability declaration was weakened.
2. **B — regression orchestration.** The complete runner could invoke live E2E
   against a stale seller binary with stale embedded profile data. `5d31e12`
   rebuilds the seller before that stage and preserves the correct local lead
   fixture capabilities.
3. **B — certification environment.** The first recovered local run omitted
   seller-specific configuration and hit a conflicting loopback listener. A
   fresh, fully configured seller on an isolated loopback port with JSON
   discovery readiness resolved it; no repository product code was changed for
   this environmental issue. One 5.023-second live test overrun was reproduced
   green under a short-lived higher-priority test process, again without
   relaxing an assertion or timeout.
4. **Certification formatting defect.** The rebuilt-runner line was not
   Prettier-formatted. `5548557` is formatting-only; it did not alter runner
   behavior.

## Security review and limitations

**IMPLEMENTED:** strict/versioned provider contracts; server-only opaque secrets;
secret-free client/evidence/log surfaces; separate buyer and provider MCP
domains; bounded, SSRF-hardened REST; exact-tool MCP; stable immutable execution
identities; persisted evidence; activation and health gates; shared discovery;
and fail-closed ambiguity/reconciliation behavior.

**TESTED:** all focused checks above plus the 727-test disjoint final regression,
including local-network connector fixtures, both buyer transports, Docker
sandboxing, browser secret scanning, seller evidence/recovery tests, and Anchor
settlement scenarios.

**SIMULATED:** malformed/hostile provider network responses, corrupt durable
records, secret source/rotation failures, connector disconnects, and many
failure-boundary interleavings. These do not assert real third-party execution.

**DEFERRED:** production KMS/HSM integration and remote admin authentication;
third-party provider certification; stdio provider connector profiles; dynamic
server-to-client catalog deployment coordination; cryptographic third-party
receipt attestation; multi-attestor/TEE trust expansion; AI/ZK/advanced
verification; and any claim that an opaque provider action did or did not occur.

Remaining provider ambiguity is intentional: a provider without keyed
idempotency, durable execution/status/receipt evidence, or another declared safe
recovery mechanism remains `UNKNOWN_EXTERNAL_EFFECT` and is not automatically
redispatched or paid. Health is never historical execution truth.

## Phase 4B exit gate

- [x] Strict, versioned provider definitions and explicit recovery capabilities.
- [x] Local fixture providers remain supported.
- [x] Opaque server-side secret references; browser/buyer task inputs cannot
      supply raw secrets.
- [x] Bounded REST and MCP provider connectors, separated from buyer MCP.
- [x] SSRF, redirect, private-IP, response-size, idempotency, execution-ID,
      status, receipt, and immutable-binding protections fail closed.
- [x] Missing acknowledgement/recovery evidence remains unknown; no timeout is
      interpreted as non-execution.
- [x] Activation/deactivation and health gates apply only to new work and do not
      rewrite historical provider evidence.
- [x] Provider-backed services resolve through one registry/discovery model and
      feed existing recovery/reconciliation components.
- [x] Provider connectors have no financial or verification authority; settlement
      and refund authority are unchanged.
- [x] No Phase 4C multi-attestor/TEE work and no Phase 4D AI/ZK/advanced
      verification work was implemented.
- [x] Full Phase 1–4A regression remains green, and the complete Phase 4B
      regression is green.

**PASS — Phase 4B is complete. Stop here.**
