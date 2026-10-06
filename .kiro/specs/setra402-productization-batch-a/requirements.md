# Requirements: Setra402 Productization Batch A

## Overview

Productionize Setra402 backend and developer experience while preserving all protocol semantics. This is a safe refactoring and improvement pass focused on making Setra402 easier to run, understand, discover, and use for developers and AI agents.

**Baseline:** Branch `agent-validator`, HEAD `72e665a`, 727 tests passing, 0 failures

**Critical Constraints:**
- Preserve all protocol semantics (settlement, refund, verification, provider ambiguity, financial journaling, recovery, security boundaries)
- DO NOT redesign frontend (separate visual pass later)
- DO NOT implement Phase 4C or Phase 4D
- DO NOT change protocol behavior

## NON-NEGOTIABLE INVARIANTS

The following protocol elements are **immutable** throughout this productization batch. ANY change to these elements constitutes a protocol break and is **strictly forbidden**:

### On-Chain Protocol Invariants
- **Anchor Account Model** - All PDA structures, account layouts, and account relationships remain unchanged
- **PDA Seeds** - All Program Derived Address seeds and derivation logic remain unchanged
- **Protocol Economics** - Escrow amounts, settlement logic, refund logic, and all financial calculations remain unchanged
- **SettlementCoordinator Authority** - Settlement authority model and permission structure remain unchanged
- **RefundScheduler Authority** - Refund authority model, scheduler logic, and permission structure remain unchanged
- **VerificationPolicy Semantics** - Verification logic, policies, and authoritative decision-making remain unchanged

### Off-Chain Protocol Invariants
- **UNKNOWN_EXTERNAL_EFFECT** - Recovery semantics for unknown provider effects remain unchanged
- **UNKNOWN_FINANCIAL_OUTCOME** - Handling of unknown financial outcomes remains unchanged
- **Financial Journal Safety** - Journal integrity, audit trail, and recovery guarantees remain unchanged
- **Private/Nullifier Behavior** - Private execution paths and nullifier semantics remain unchanged

### Provider Connector Safety
- Provider connector boundaries and safety mechanisms remain unchanged
- Provider ambiguity resolution semantics remain unchanged
- Provider idempotency guarantees remain unchanged

### Security Boundaries
- Browser/server security boundaries remain unchanged
- Secret handling and isolation remain unchanged
- Client authority restrictions remain unchanged

**Enforcement:** All 727 baseline tests must continue passing. Any test failure indicates a potential protocol break and must be investigated immediately before proceeding.

## R1: Protocol Behavior Baseline

**Priority:** Critical  
**Category:** Safety/Regression Prevention

### Description
Establish and maintain commit 72e665a as the certified protocol behavior baseline throughout all productization work.

### Acceptance Criteria
- [ ] Working tree is clean before starting any changes
- [ ] Git status shows branch `agent-validator` at HEAD `72e665a`
- [ ] All 727 baseline tests continue passing throughout refactoring
- [ ] Regression coverage exists for:
  - Settlement authority and flows
  - Refund authority and flows
  - Verification semantics
  - Provider recovery behavior
  - Provider idempotency
  - Financial journaling
  - Unknown-effect handling
  - Private/nullifier behavior
- [ ] No rewriting of historical commits
- [ ] Git history remains linear and clean

### Non-Goals
- Do not add new protocol features
- Do not modify settlement or refund semantics

---

## R2: Module Organization Refactoring

**Priority:** High  
**Category:** Code Quality

### Description
Improve code organization and eliminate duplication WITHOUT changing behavior. Create clean boundaries around major functional areas.

### Acceptance Criteria
- [ ] Clean module boundaries exist for:
  - `providers/` - Provider connectors and registry
  - `verification/` - Verification logic and policies
  - `payments/` - Payment flows and settlement
  - `recovery/` - Recovery and reconciliation
  - `mcp/` - MCP server and tools
  - `registry/` - Service registry
  - `runtime/` - Runtime and orchestration
  - `operator/` - Operator and health
  - `shared/` - Shared utilities
- [ ] Refactoring is **incremental** - no giant directory migrations
- [ ] Focused tests remain green after **each subsystem refactor**
- [ ] Duplicated code is consolidated:
  - Helper functions
  - Config parsing logic
  - Hashing/canonicalization code
  - Provider logic patterns
- [ ] Code cleanup completed:
  - Stale experimental names removed or renamed
  - Dead code removed
  - Unused imports removed
  - Inconsistent error handling standardized
  - Oversized modules split appropriately
- [ ] Scattered `process.env` reads centralized
- [ ] Focused tests run after each meaningful refactor
- [ ] All existing tests continue passing

### Non-Goals
- Do not perform giant rewrites
- Only refactor when behavior remains identical and tests exist

---

## R3: Central Configuration Management

**Priority:** Critical  
**Category:** Infrastructure

### Description
Create a single, validated server-side configuration layer that fails fast with clear error messages.

### Acceptance Criteria
- [ ] One central configuration module validates all required config at startup
- [ ] Configuration validation covers:
  - Solana RPC endpoint
  - Program ID
  - Mint address
  - Treasury address
  - Seller URL
  - Buyer/verifier paths
  - State roots
  - Redis connection
  - Docker configuration
  - MCP ports
  - Web server ports
  - Provider profiles
  - Secret references
  - Scheduler flags
  - Timeouts
- [ ] Validation provides clear, actionable error messages
- [ ] No secrets leaked in error messages or logs
- [ ] No arbitrary `process.env` lookups scattered throughout codebase
- [ ] Server secrets are NOT exposed to browser config
- [ ] `.env.example` file exists with placeholder values only
- [ ] Configuration fails fast on startup if invalid

### Non-Goals
- Do not expose internal secrets to frontend
- Do not create multiple configuration systems

---

## R4: One-Command Local Development

**Priority:** High  
**Category:** Developer Experience

### Description
Create a single command (`npm run dev:setra`) that checks all dependencies, starts required services, and provides clear status feedback.

### Acceptance Criteria
- [ ] `npm run dev:setra` command exists and works
- [ ] Launcher checks prerequisites:
  - Solana validator (expects running)
  - Redis (expects running)
  - Docker availability
  - Required fixtures/accounts
  - Port availability
- [ ] Launcher coordinates owned processes:
  - Seller server
  - MCP server
  - Web runtime
  - Provider configuration
- [ ] Status dashboard prints clearly:
  ```
  Setra402 local environment
  Solana     OK  http://127.0.0.1:8899
  Redis      OK  127.0.0.1:6379
  Docker     OK
  Seller     OK  http://127.0.0.1:3000
  MCP        OK  http://127.0.0.1:3002/mcp
  Control    OK  http://127.0.0.1:3003
  Ready.
  ```
- [ ] Launcher starts only owned processes
- [ ] Clean shutdown on Ctrl+C (SIGINT)
- [ ] Child processes terminate cleanly
- [ ] Never kills unrelated processes
- [ ] Never deletes arbitrary ledger/state data
- [ ] Destructive reset requires explicit flag: `npm run dev:setra -- --reset-test-ledger`
- [ ] Reset flag behavior:
  - Verifies exact path before deletion (must match expected test ledger location)
  - Verifies ownership markers (created by Setra402 launcher)
  - Verifies disposable/test markers (not production data)
  - Never silently deletes production data
  - Fails safely if any verification check fails
- [ ] Launcher **never kills processes it did not start**
- [ ] Launcher only manages processes it owns (seller, MCP, web runtime)

### Non-Goals
- Do not manage Solana validator lifecycle
- Do not manage Redis lifecycle
- Do not support production deployment in this command

---

## R5: Health and Readiness Endpoints

**Priority:** High  
**Category:** Observability

### Description
Expose clear health status (HEALTHY/DEGRADED/UNAVAILABLE) for all system components, reusing existing health/operator infrastructure.

### Acceptance Criteria
- [ ] Health endpoint reuses existing health/operator infrastructure
- [ ] Health status exposed for:
  - Solana RPC connection
  - Redis connection
  - Docker availability
  - Seller server
  - MCP server
  - Provider catalog
  - Required provider secrets (presence check only)
  - State root availability
  - Reconciliation subsystem
  - Refund scheduler configuration
- [ ] Status values are clear:
  - `HEALTHY` - operating normally
  - `DEGRADED` - partial functionality
  - `UNAVAILABLE` - not operational
- [ ] Health checks are **operational information only**
- [ ] Health status **does NOT resolve historical provider or financial ambiguity**
- [ ] Health status does NOT imply proof of whether historical provider effects occurred
- [ ] Health status does NOT imply proof of whether historical financial outcomes succeeded
- [ ] No secrets leaked in health responses
- [ ] Health endpoint responds quickly (< 5s)

### Non-Goals
- Do not expose internal implementation details
- Do not leak configuration secrets
- Do not treat health as financial audit trail

---

## R6: MCP Tool Surface Productization

**Priority:** High  
**Category:** AI Agent Experience

### Description
Improve MCP tool descriptions and schemas so AI agents clearly understand what Setra402 is, how to use it, and when to use each tool.

### Acceptance Criteria
- [ ] Current MCP core is preserved (do NOT rewrite)
- [ ] Tool surface remains small and focused:
  - `discover_services` - Find available protected services
  - `protected_call` - Execute service with payment protection
  - `fund_task` - Add funds to existing task
  - `task_status` - Check task state and outcome
  - `refund_task` - Request refund for failed task
- [ ] Tool descriptions clearly explain:
  - What Setra402 is (trust/conditional-settlement layer)
  - Why `protected_call` exists (escrow + verification)
  - Payment may be required
  - Funding is explicit via `fund_task`
  - Verification controls settlement
  - Unknown outcomes must NOT be blindly retried
- [ ] Schemas include examples and clear parameter descriptions
- [ ] Internal operator/reconciliation actions NOT exposed as MCP tools

### Non-Goals
- Do not rewrite MCP core implementation
- Do not expose dangerous internal operations

---

## R7: Enhanced Service Discovery

**Priority:** High  
**Category:** AI Agent Experience

### Description
Make `discover_services` return rich semantic metadata enabling AI agents to select the right service without understanding internal Setra architecture.

### Acceptance Criteria
- [ ] `discover_services` returns concise metadata for each service:
  - `service_id` - Unique identifier
  - `name` - Human-readable name
  - `description` - What the service does
  - `provider` - Provider type/identifier
  - `transport` - Transport mechanism (REST, MCP, etc.)
  - `price` - Cost in lamports (or pricing model)
  - `expected_input` - Input schema/description
  - `expected_output` - Output schema/description
  - `verification_level` - Verification policy (AUTO, MANUAL, NONE)
  - `protection_policy` - Protection type (ESCROW, NULLIFIER, etc.)
  - `provider_status` - Provider availability status
  - `private_supported` - Whether private execution is available
- [ ] AI agent can select appropriate service based on metadata alone
- [ ] **Enriches existing shared registry only** - no second service catalog created
- [ ] Current registry authority is preserved
- [ ] Registry modifications are backward-compatible additions only

### Non-Goals
- Do not expose internal PDA structures
- Do not duplicate service registry

---

## R8: Remote MCP Preparation

**Priority:** Medium  
**Category:** Future-Readiness

### Description
Prepare for remote MCP access while preserving current local stdio support. Document requirements if full implementation needs significant work.

### Acceptance Criteria
- [ ] Current local stdio MCP support is preserved
- [ ] **Implementation only if current MCP stack supports it safely:**
  - [ ] Bounded remote MCP entry point added using SAME Setra core
  - [ ] Standard MCP protocol used (no custom protocol)
  - [ ] stdio functionality not broken
  - [ ] Remote MCP preserves:
    - Bounded request/response bodies
    - Timeouts
    - No secrets exposed
    - No financial authority in browser/client
    - Existing provider/verification behavior
- [ ] **If safe remote MCP requires large dependency/protocol upgrade:**
  - [ ] Requirements documented in detail
  - [ ] Implementation deferred (not forced in this batch)
  - [ ] Do NOT invent custom MCP protocol
- [ ] Decision documented with rationale

### Non-Goals
- Do not invent custom MCP transport protocol
- Do not break existing stdio MCP
- Do not expose financial authority to untrusted clients

---

## R9: MCP Registry Metadata

**Priority:** Low  
**Category:** Future-Readiness

### Description
Prepare metadata for eventual external MCP registry publication without actually publishing.

### Acceptance Criteria
- [ ] Metadata prepared for future publication:
  - Name: `Setra402`
  - Description: `Trust and conditional-settlement layer for autonomous agent payments`
  - Keywords: `x402`, `Solana`, `MCP`, `agent payments`, `conditional settlement`, `escrow`, `verification`, `protected services`
- [ ] Server metadata includes:
  - Homepage URL placeholder
  - Repository metadata
  - Package/transport information
  - Icon reference (if already present)
- [ ] NO actual publication to internet/registry during this batch
- [ ] Metadata stored in appropriate local files

### Non-Goals
- Do not publish to external registries
- Do not create public-facing documentation yet

---

## R10: Deterministic Demo Services

**Priority:** High  
**Category:** Product Demonstration

### Description
Create three strong, deterministic demo services using the existing provider framework to demonstrate Setra402's value with realistic business use cases.

### Acceptance Criteria
- [ ] Three demo services created:
  1. **Structured Lead/Data Generation** - Generate business leads or structured data
  2. **Web Scraping/Source Retrieval** - Fetch and extract data from web sources
  3. **Compute/Tool Execution** - Execute computation or call external API
- [ ] Each demo service:
  - Uses existing provider framework
  - Supports deterministic success case
  - **Exercises real execution/verification/settlement/refund path**
  - Does NOT create fake financial behavior
  - Does NOT mock protocol flows
- [ ] At least some demos demonstrate:
  - `PASS` outcome (successful verification and settlement)
  - `FAIL` outcome (failed verification and refund)
  - Refund path execution
- [ ] Backend services and data support only
- [ ] NO frontend presentation design (separate pass)

### Non-Goals
- Do not design frontend UI for demos
- Do not create fake/mock financial flows

---

## R11: Developer Documentation

**Priority:** High  
**Category:** Developer Experience

### Description
Create comprehensive, concise developer documentation enabling developers to quickly understand and use Setra402.

### Acceptance Criteria
- [ ] Documentation files created/updated:
  - `buyer-agent/docs/CURRENT_ARCHITECTURE.md` - System architecture overview
  - `buyer-agent/docs/LOCAL_DEVELOPMENT.md` - Local development setup
  - `buyer-agent/docs/MCP_USAGE.md` - MCP integration guide
  - `buyer-agent/docs/OPERATIONS.md` - Operational procedures
- [ ] Documentation covers:
  - What Setra402 does (high-level overview)
  - How to run locally (`dev:setra` launcher)
  - How to start simulation/testing
  - How to connect MCP client
  - How to discover services
  - How to use `protected_call`
  - How to use `fund_task`
  - How to retry failed tasks
  - How to inspect task status
  - How to observe settlement/refund flows
  - How to configure REST provider
  - How to configure MCP provider
  - Understanding `UNKNOWN_EXTERNAL_EFFECT` and recovery
- [ ] Historical phase audits remain immutable
- [ ] Documentation is concise and actionable

### Non-Goals
- Do not rewrite historical audit documents
- Do not create marketing materials

---

## R12: Frontend Compatibility Only

**Priority:** Critical  
**Category:** Constraint

### Description
Ensure NO frontend redesign occurs. Only make minimal frontend changes absolutely required by backend changes.

### Acceptance Criteria
- [ ] NO changes to:
  - Layout designs
  - Color schemes
  - Typography
  - Card designs
  - Navigation structure
  - Visual themes
  - Screen A/B/C presentation
- [ ] Minimal frontend changes **ONLY if required by Batch A backend changes:**
  - Discovery metadata API changes (to support R7 enriched metadata)
  - API compatibility requirements
  - Security regression fixes
- [ ] All frontend changes are **API-compatible only** - no visual redesign
- [ ] Every frontend-touching change is documented with justification

### Non-Goals
- Do not improve visual design
- Do not refactor React components unless required by API changes

---

## R13: Comprehensive Testing

**Priority:** Critical  
**Category:** Quality Assurance

### Description
Maintain and verify all 727 baseline tests pass, run focused tests throughout refactoring, and execute full test suite at completion.

### Acceptance Criteria
- [ ] Starting baseline verified: 727 unique tests, 0 failures
- [ ] **Focused tests used during implementation** for rapid feedback
- [ ] **One complete `npm run test:all` at completion** - do not double-count focused suites
- [ ] At completion, all tests pass:
  - Buyer unit tests
  - Buyer integration tests
  - Live E2E tests
  - Docker sandbox tests
  - Browser/security tests
  - Seller Rust tests
  - Anchor tests
- [ ] Build checks pass:
  - `build` succeeds
  - `build:runtime` succeeds
- [ ] Code quality checks pass:
  - `format:check` passes
  - `git diff --check` passes
  - Secret scan passes (no secrets committed)
- [ ] Test results documented (focused during implementation, final complete suite)
- [ ] No duplicate test counting in final report

### Non-Goals
- Do not reduce test coverage
- Do not skip tests to make progress

---

## R14: Productization Audit

**Priority:** High  
**Category:** Documentation

### Description
Create comprehensive audit document recording all productization work, changes, and confirmations.

### Acceptance Criteria
- [ ] Audit document created: `buyer-agent/docs/PRODUCTIZATION_BATCH_A.md`
- [ ] Audit records:
  - Starting HEAD commit (72e665a)
  - Ending HEAD commit
  - List of all commits made
  - Refactors completed
  - Configuration changes
  - Launcher implementation details
  - Health/readiness implementation
  - MCP changes made
  - `discover_services` enhancements
  - Remote MCP status (implemented or documented)
  - Registry metadata prepared
  - Demo services added
  - Documentation created/updated
  - Bugs found and fixed
  - Focused test results
  - Full regression test total
  - Remaining known limitations
- [ ] Audit explicitly confirms:
  - **Protocol semantics unchanged** (all NON-NEGOTIABLE INVARIANTS preserved)
  - **Frontend redesign NOT performed** (only API-compatible changes)
  - **Phase 4C NOT started**
  - **Phase 4D NOT started**
- [ ] Audit includes:
  - Final deliverables summary
  - Test totals
  - Remaining issues for future work

### Non-Goals
- Do not start Phase 4C or 4D
- Do not begin visual redesign

---

## Summary

This productization batch focuses on making Setra402 production-ready from a developer and AI agent perspective while maintaining absolute fidelity to the certified protocol behavior baseline. All changes are additive improvements to developer experience, documentation, tooling, and observability.
