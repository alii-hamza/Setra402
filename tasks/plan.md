# Implementation Plan: Setra402 Productization

## Overview

Productize the accepted Phase 4B backend without changing protocol, financial,
verification, provider-ambiguity, or frontend visual semantics. Existing
recovery and operator components remain authoritative; new tooling composes
them.

## Architecture Decisions

- Keep signer-bearing buyer configuration separate from browser-safe server
  settings and launcher metadata.
- Reuse `OperatorHealthV1`, seller `/providers`, and the existing loopback MCP
  transport for readiness instead of introducing parallel health systems.
- The local launcher may start only seller and buyer processes it owns. Solana,
  Redis, and Docker are prerequisite probes; no ledger reset or process killing
  is implicit.
- Preserve the five MCP tools and stdio protocol. Remote MCP remains loopback
  development support until production authentication and a maintained MCP SDK
  are deliberately adopted.
- Defer AI advisory unless P1-P7 finish green and a narrow addition remains
  clearly isolated from verification and financial authority.

## Task List

### Foundation

- Task 1: Centralize and validate buyer runtime, server, and operator settings.
- Task 2: Extend read-only health/readiness using existing provider evidence.

### Developer Product

- Task 3: Add a cross-platform preflight and owned-process local launcher.
- Task 4: Productize MCP descriptions, metadata, and launch documentation.

### Release Evidence

- Task 5: Consolidate current architecture, development, MCP, and operations docs.
- Task 6: Run security, performance/resource, diff, and full regression reviews.
- Task 7: Record `PRODUCTIZATION_AUDIT.md` and reviewable commits.

## Verification Checkpoints

- Foundation: focused config, operator-health, and web/API tests; build clean.
- Developer product: focused launcher and MCP tests; runtime build clean.
- Release: `npm run test:all`, productization-only tests if not included,
  dependency audit, secret scan, format check, and `git diff --check`.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Existing dirty frontend files | Accidental overwrite or commit | Do not edit or stage them |
| Launcher stops unrelated services | Developer data/process loss | Track and stop only spawned child PIDs |
| Health becomes execution truth | Unsafe recovery decisions | Keep health read-only and explicitly operational |
| MCP expansion increases authority | Protocol or payment regression | Keep the five-tool surface and existing controller |
| AI advisory leaks into settlement | Financial authority regression | Defer unless independently isolated and proven |

## Open Questions

- None blocking. The user-provided scope and accepted Phase 4B audit are the
  approved specification.
