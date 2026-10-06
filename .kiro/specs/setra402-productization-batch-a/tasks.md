# Implementation Plan: Setra402 Productization Batch A

## Overview

This implementation plan transforms Setra402 into a production-ready system with improved developer experience, comprehensive documentation, and AI agent integration. The work is organized into 14 phases following the design specification, with all changes preserving the NON-NEGOTIABLE INVARIANTS and maintaining the certified protocol behavior baseline (commit 72e665a, 727 tests passing).

**Critical Constraints:**
- All 727 baseline tests must continue passing throughout implementation
- Incremental changes only - no giant migrations
- Test after each subsystem refactor
- Protocol semantics are immutable
- No frontend visual redesign (API compatibility changes only)

**Implementation Language:** TypeScript

**Implementation Order:**
1. Baseline verification (D1)
2. Safe module refactoring (D2) - 7 incremental phases
3. Central config validation (D3)
4. One-command launcher (D4)
5. Health/readiness endpoints (D5)
6. MCP productization (D6, D7)
7. Remote MCP preparation (D8)
8. MCP registry metadata (D9)
9. Demo services (D10)
10. Developer documentation (D11)
11. Frontend compatibility check (D12)
12. Testing (D13)
13. Audit document (D14)

## Tasks

- [ ] 1. Establish Protocol Behavior Baseline (D1)
  - [x] 1.1 Create baseline verification script
    - Write `buyer-agent/scripts/verify-baseline.ts` that checks git status, branch, commit hash, and runs full test suite
    - Script should verify: working tree clean, branch is `agent-validator`, HEAD is `72e665a`, all 727 tests pass
    - _Requirements: R1_
  
  - [x] 1.2 Capture baseline snapshot
    - Run baseline verification script and create `.kiro/specs/setra402-productization-batch-a/.baseline-verification.json` with commit hash, branch, test counts, verified timestamp, and list of NON-NEGOTIABLE INVARIANTS
    - _Requirements: R1_
  
  - [~] 1.3 Checkpoint - Verify baseline established
    - Ensure baseline verification script passes and snapshot file exists. Ask user if questions arise.

- [ ] 2. Phase 2.1: Consolidate Configuration (D2-Phase1)
  - [~] 2.1 Create central config module
    - Create `buyer-agent/src/config/index.ts` that re-exports from both `config.ts` and `runtime-config.ts`
    - Preserve all existing exports for backward compatibility
    - _Requirements: R2, R3_
  
  - [~] 2.2 Create config validator
    - Create `buyer-agent/src/config/validator.ts` with Zod schemas for all configuration sections (Solana, auth, infra, services, state, providers, scheduler, timeouts)
    - Implement `validateConfiguration(env: NodeJS.ProcessEnv): SetraConfiguration` function with clear, actionable error messages
    - _Requirements: R3_
  
  - [ ]* 2.3 Write unit tests for config validator
    - Test missing required env vars, invalid env var values, secret handling (no leaks in errors), valid config passes
    - _Requirements: R3_
  
  - [~] 2.4 Run focused config tests
    - Run `npm run test:unit -- tests/unit/config` to verify config changes don't break existing behavior
    - _Requirements: R2, R13_

- [ ] 3. Phase 2.2: Extract Shared Utilities (D2-Phase2)
  - [~] 3.1 Scan for duplicated helpers
    - Audit `src/core/`, `src/verification/`, `src/provider/`, `src/chain/` for duplicated utility functions (hashing, canonicalization, error builders)
    - _Requirements: R2_
  
  - [~] 3.2 Create shared utilities module
    - Create `buyer-agent/src/shared/` directory with `hash.ts`, `canonical.ts`, `errors.ts` containing consolidated utility functions
    - _Requirements: R2_
  
  - [~] 3.3 Update imports incrementally
    - Update imports in affected modules one file at a time to use shared utilities
    - _Requirements: R2_
  
  - [ ]* 3.4 Run focused tests after shared utils refactor
    - Run focused tests for affected modules to verify behavior unchanged
    - _Requirements: R2, R13_

- [ ] 4. Phase 2.3: Merge Provider + Registry (D2-Phase3)
  - [~] 4.1 Create providers directory structure
    - Create `buyer-agent/src/providers/` with subdirectories: `connectors/`, `registry/`, `discovery/`
    - _Requirements: R2_
  
  - [~] 4.2 Move provider files incrementally
    - Move files from `src/provider/` to `src/providers/connectors/` one at a time, updating imports
    - _Requirements: R2_
  
  - [~] 4.3 Move registry files incrementally
    - Move files from `src/registry/` to `src/providers/registry/` one at a time, updating imports
    - _Requirements: R2_
  
  - [ ]* 4.4 Run provider and registry tests
    - Run `npm run test:unit -- tests/unit/provider tests/unit/registry` to verify no behavior changes
    - _Requirements: R2, R13_

- [ ] 5. Phase 2.4: Extract Payments Module (D2-Phase4)
  - [~] 5.1 Create payments module
    - Create `buyer-agent/src/payments/` with `escrow.ts`, `settlement.ts`, `refund.ts` extracted from `src/chain/escrow.ts`, `src/chain/settlement-coordinator.ts`, and payment logic in `src/core/`
    - Re-export from original locations for backward compatibility
    - _Requirements: R2_
  
  - [ ]* 5.2 Run payment flow tests
    - Run `npm run test:unit -- tests/unit/escrow` and `npm run test:integration -- tests/integration/settlement` to verify payment flows unchanged
    - _Requirements: R2, R13_

- [ ] 6. Phase 2.5: Extract Recovery Module (D2-Phase5)
  - [~] 6.1 Create recovery module
    - Create `buyer-agent/src/recovery/` with `operator.ts`, `reconciliation.ts`, `scheduler.ts` extracted from `src/core/operator.ts` and reconciliation logic
    - _Requirements: R2_
  
  - [ ]* 6.2 Run recovery tests
    - Run `npm run test:recovery` to verify recovery behavior unchanged
    - _Requirements: R2, R13_

- [ ] 7. Phase 2.6: Extract Runtime + Operator (D2-Phase6)
  - [~] 7.1 Create runtime and operator modules
    - Create `buyer-agent/src/runtime/` and `buyer-agent/src/operator/` directories
    - Move `src/orchestrator.ts`, `src/dev/` to `src/runtime/`, and operator CLI logic to `src/operator/`
    - _Requirements: R2_
  
  - [ ]* 7.2 Run integration tests
    - Run `npm run test:integration` to verify orchestration and operator behavior unchanged
    - _Requirements: R2, R13_

- [ ] 8. Phase 2.7: Cleanup (D2-Phase7)
  - [~] 8.1 Remove dead code and unused imports
    - Scan all modified files for unused imports, dead code, stale experimental names
    - Remove identified issues and standardize error handling patterns
    - _Requirements: R2_
  
  - [ ]* 8.2 Run complete test suite after refactoring
    - Run `npm run test:all` to verify all 727+ tests still pass after module refactoring
    - _Requirements: R2, R13_
  
  - [~] 8.3 Checkpoint - Module refactoring complete
    - Ensure all module refactoring phases completed and tests pass. Ask user if questions arise.

- [ ] 9. Centralize Environment Variable Access (D3)
  - [~] 9.1 Audit scattered process.env reads
    - Run `grep -r "process\.env" buyer-agent/src/` to identify all direct environment variable accesses
    - _Requirements: R3_
  
  - [~] 9.2 Replace with centralized config
    - Update all scattered `process.env` reads to use centralized config imports from `src/config/`
    - _Requirements: R3_
  
  - [~] 9.3 Update .env.example
    - Create/update `buyer-agent/.env.example` with all required and optional environment variables with placeholder values
    - Include sections: Solana, Auth, Services, Infrastructure, Provider Secrets
    - _Requirements: R3_
  
  - [~] 9.4 Integrate validator in startup paths
    - Add `validateConfiguration()` call in `src/mcp/server.ts`, `src/web/start.ts`, `src/dev/launcher.ts`, and CLI tools
    - _Requirements: R3_
  
  - [ ]* 9.5 Test configuration validation
    - Test missing required config fails fast, invalid config fails with clear messages, secrets not leaked in errors
    - _Requirements: R3, R13_

- [ ] 10. One-Command Local Launcher (D4)
  - [~] 10.1 Inspect existing launcher
    - Read `buyer-agent/src/dev/launcher.js` to understand current implementation
    - _Requirements: R4_
  
  - [~] 10.2 Implement/enhance launcher logic
    - Create/enhance `buyer-agent/src/dev/launcher.ts` with prerequisites checking (Solana, Redis, Docker, fixtures, ports), process ownership tracking, status dashboard, clean shutdown handler
    - _Requirements: R4_
  
  - [~] 10.3 Implement PID file management
    - Create `.setra-state/launcher/` directory and implement PID file tracking for seller, MCP, and web processes
    - _Requirements: R4_
  
  - [~] 10.4 Implement safe reset functionality
    - Add `--reset-test-ledger` flag with safety checks: verify exact path, ownership marker, disposable marker, user confirmation
    - Create ownership marker creation logic in launcher
    - _Requirements: R4_
  
  - [~] 10.5 Update package.json script
    - Update `dev:setra` script in `buyer-agent/package.json` to use new launcher
    - _Requirements: R4_
  
  - [ ]* 10.6 Test launcher functionality
    - Test launcher starts services, status dashboard displays correctly, Ctrl+C shutdown is clean, reset safety checks prevent deletion of non-test paths
    - _Requirements: R4, R13_

- [ ] 11. Health and Readiness Endpoints (D5)
  - [~] 11.1 Create health check utilities
    - Create `buyer-agent/src/operator/health.ts` with functions for checking Solana, Redis, Docker, Seller, MCP, provider catalog, provider secrets, state root, reconciliation, refund scheduler health
    - _Requirements: R5_
  
  - [~] 11.2 Implement aggregate health function
    - Implement `aggregateHealth(): Promise<HealthResponse>` that collects all component health checks and determines overall status (HEALTHY/DEGRADED/UNAVAILABLE)
    - _Requirements: R5_
  
  - [~] 11.3 Add health endpoint to web server
    - Add `GET /health` endpoint in `src/web/start.ts` that calls `aggregateHealth()` and returns JSON response
    - _Requirements: R5_
  
  - [~] 11.4 Integrate health checks in launcher
    - Update launcher to call health checks before declaring "Ready" status
    - _Requirements: R5_
  
  - [ ]* 11.5 Test health endpoint
    - Test health endpoint returns correct status for all components, completes in < 5s, does not leak secrets
    - _Requirements: R5, R13_

- [ ] 12. MCP Tool Surface Productization (D6)
  - [~] 12.1 Update MCP server metadata
    - Update MCP server info response in `src/mcp/server.ts` with comprehensive description of Setra402, keywords (x402, Solana, agent payments, etc.)
    - _Requirements: R6_
  
  - [~] 12.2 Enhance discover_services tool description
    - Update `discover_services` tool schema with rich description, examples, and notes about service discovery
    - _Requirements: R6_
  
  - [~] 12.3 Enhance protected_call tool description
    - Update `protected_call` tool schema with comprehensive description of escrow + verification, input schema with examples, critical notes about unknown outcomes
    - _Requirements: R6_
  
  - [~] 12.4 Enhance fund_task tool description
    - Update `fund_task` tool schema with clear description and notes about explicit funding model
    - _Requirements: R6_
  
  - [~] 12.5 Enhance task_status tool description
    - Update `task_status` tool schema with description of outcomes (settled, verification_failed, unknown) and investigation guidance
    - _Requirements: R6_
  
  - [~] 12.6 Enhance refund_task tool description
    - Update `refund_task` tool schema with description and notes about refund eligibility
    - _Requirements: R6_
  
  - [ ]* 12.7 Test MCP tool schemas
    - Verify tool schemas are valid MCP protocol, descriptions are comprehensive, examples are present
    - _Requirements: R6, R13_

- [ ] 13. Enhanced Service Discovery (D7)
  - [~] 13.1 Enhance provider profile schema
    - Update provider profile schema (in config or seller-server) to include new metadata fields: transport, pricing_model, expected_input, expected_output, verification_level, protection_policy, private_supported, capabilities, version
    - _Requirements: R7_
  
  - [~] 13.2 Implement provider status derivation
    - Create `deriveProviderStatus()` function that checks provider secrets, endpoint reachability (REST), MCP server status, Docker availability based on provider transport type
    - _Requirements: R7_
  
  - [~] 13.3 Update discover_services implementation
    - Enhance `discover_services` tool in `src/mcp/tools/` to return enriched `EnrichedServiceMetadata` including all new fields with backward compatibility for minimal metadata
    - _Requirements: R7_
  
  - [ ]* 13.4 Test enhanced discovery
    - Test `discover_services` returns all enriched fields, provider status derivation works correctly, backward compatibility maintained
    - _Requirements: R7, R13_

- [ ] 14. Remote MCP Preparation (D8)
  - [~] 14.1 Assess MCP library capabilities
    - Inspect `package.json` and MCP library documentation to determine if HTTP/SSE transport is natively supported
    - _Requirements: R8_
  
  - [~] 14.2 Decision: Implement or defer remote MCP
    - If library supports HTTP/SSE: Create `src/mcp/http-server.ts` with bounded entry point (body size limit, timeouts, secret filtering), add `mcp:http` npm script, write integration tests
    - If major upgrade required: Create `buyer-agent/docs/REMOTE_MCP_REQUIREMENTS.md` documenting requirements, effort estimate, and deferral decision
    - _Requirements: R8_
  
  - [ ]* 14.3 Test remote MCP (if implemented)
    - Test HTTP MCP calls work, body size limits enforced, timeouts enforced, secrets not exposed
    - _Requirements: R8, R13_

- [ ] 15. MCP Registry Metadata Preparation (D9)
  - [~] 15.1 Create MCP server metadata file
    - Create `buyer-agent/mcp-server.json` with name, version, description, keywords, repository info, transport config, capabilities
    - _Requirements: R9_
  
  - [~] 15.2 Update README with MCP section
    - Update `buyer-agent/README.md` to include MCP integration section with tool list, connection instructions, link to MCP_USAGE.md
    - _Requirements: R9_
  
  - [~] 15.3 Check for existing icon/logo
    - Search repository for existing icon/logo files, reference in metadata if exists, defer if not
    - _Requirements: R9_
  
  - [ ]* 15.4 Validate metadata
    - Validate `mcp-server.json` JSON syntax and schema compliance (if MCP registry schema exists)
    - _Requirements: R9, R13_

- [ ] 16. Deterministic Demo Services (D10)
  - [~] 16.1 Create demo directory structure
    - Create `buyer-agent/src/demo/` directory for demo service implementations
    - _Requirements: R10_
  
  - [~] 16.2 Implement demo-lead-gen service
    - Create `src/demo/demo-lead-gen.ts` with deterministic lead generation logic, seeded random generator, 20% random failure rate to demonstrate refund path
    - Service should exercise real execution/verification/settlement/refund flow (no mocking)
    - _Requirements: R10_
  
  - [~] 16.3 Implement demo-web-scrape service
    - Create `src/demo/demo-web-scrape.ts` with deterministic web scraping simulation, verification that checks content non-empty
    - Service should exercise real execution/verification/settlement/refund flow (no mocking)
    - _Requirements: R10_
  
  - [~] 16.4 Implement demo-compute-sha256 service
    - Create `src/demo/demo-compute.ts` with SHA256 computation, verification that re-computes and compares hash
    - Service should exercise real execution/verification/settlement/refund flow (no mocking)
    - _Requirements: R10_
  
  - [~] 16.5 Create demo registry
    - Create `src/demo/demo-registry.ts` that registers all three demo services with enriched metadata
    - _Requirements: R10_
  
  - [~] 16.6 Integrate demo mode in config
    - Add `SETRA_DEMO_MODE` environment variable support in config, integrate demo service registration when enabled
    - Update `.env.example` with demo mode flag
    - _Requirements: R10_
  
  - [ ]* 16.7 Test demo services
    - Test each demo service executes successfully through full flow, verification pass/fail outcomes work correctly, real settlement/refund paths used (not mocked)
    - _Requirements: R10, R13_

- [ ] 17. Developer Documentation (D11)
  - [~] 17.1 Create CURRENT_ARCHITECTURE.md
    - Write `buyer-agent/docs/CURRENT_ARCHITECTURE.md` with system overview, high-level design diagrams, component descriptions, data flow diagrams, module organization (post-refactor), security boundaries, key invariants
    - _Requirements: R11_
  
  - [~] 17.2 Create LOCAL_DEVELOPMENT.md
    - Write `buyer-agent/docs/LOCAL_DEVELOPMENT.md` with prerequisites, environment setup steps, `dev:setra` launcher usage, test running instructions, debugging guide, common issues/solutions, development workflow
    - _Requirements: R11_
  
  - [~] 17.3 Create MCP_USAGE.md
    - Write `buyer-agent/docs/MCP_USAGE.md` with MCP introduction, client connection instructions, tool reference (discover_services, protected_call, fund_task, task_status, refund_task), usage examples, outcome interpretation, troubleshooting
    - _Requirements: R11_
  
  - [~] 17.4 Create OPERATIONS.md
    - Write `buyer-agent/docs/OPERATIONS.md` with health monitoring guide, operator CLI usage, refund scheduler operations, reconciliation procedures, UNKNOWN_EXTERNAL_EFFECT recovery guide, provider configuration examples, common operational tasks
    - _Requirements: R11_
  
  - [~] 17.5 Update main README
    - Update `buyer-agent/README.md` to link to all new documentation files
    - _Requirements: R11_
  
  - [ ]* 17.6 Validate documentation
    - Test all code examples in documentation are valid, verify all links work, review for clarity and completeness
    - _Requirements: R11, R13_

- [ ] 18. Frontend Compatibility Check (D12)
  - [~] 18.1 Audit frontend API touchpoints
    - Run `grep -r "discover_services\|/health\|/api" frontend/src/` (if frontend exists) to identify API calls that need compatibility updates
    - _Requirements: R12_
  
  - [~] 18.2 Make minimal API compatibility changes
    - Update TypeScript types for API responses (e.g., `ServiceMetadata`, health response), update fetch calls if endpoints changed
    - NO JSX structure, style, or layout changes allowed
    - _Requirements: R12_
  
  - [~] 18.3 Document frontend changes
    - Create `frontend/BATCH_A_CHANGES.md` documenting every frontend change with file, change description, justification, visual impact assessment
    - _Requirements: R12_
  
  - [ ]* 18.4 Test frontend compatibility
    - Run frontend build, run frontend tests, manual test to verify no visual changes, screenshot comparison if available
    - _Requirements: R12, R13_

- [ ] 19. Comprehensive Testing (D13)
  - [~] 19.1 Document focused test results
    - Compile summary of focused test runs performed during implementation (config tests, provider tests, payment tests, recovery tests, etc.) in a testing log
    - _Requirements: R13_
  
  - [~] 19.2 Run complete final test suite
    - Run `npm run test:all` once at completion and capture full output including all test counts by category
    - _Requirements: R13_
  
  - [~] 19.3 Run build checks
    - Run `npm run build`, `npm run build:runtime`, `npm run format:check`, verify all pass
    - _Requirements: R13_
  
  - [~] 19.4 Run git hygiene checks
    - Run `git diff --check` to verify no whitespace issues, run secret scan if available
    - _Requirements: R13_
  
  - [~] 19.5 Verify test baseline maintained
    - Confirm final test count is 727+ tests, 0 failures, documenting any new tests added
    - _Requirements: R13_

- [ ] 20. Productization Audit Document (D14)
  - [~] 20.1 Create audit document template
    - Create `buyer-agent/docs/PRODUCTIZATION_BATCH_A.md` with template structure: Overview, Baseline, Ending State, Commits, Refactors, Changes, Tests, Confirmations, Deliverables
    - _Requirements: R14_
  
  - [~] 20.2 Fill in baseline information
    - Document starting HEAD (72e665a), branch (agent-validator), starting test count (727)
    - _Requirements: R14_
  
  - [~] 20.3 Document all refactors completed
    - List all module refactors (R2) with before/after structure showing directory organization changes
    - _Requirements: R14_
  
  - [~] 20.4 Document configuration changes
    - Detail all R3 configuration work: validator creation, centralized config, .env.example updates
    - _Requirements: R14_
  
  - [~] 20.5 Document launcher implementation
    - Detail R4 launcher work: process management, PID tracking, reset safety, shutdown handling
    - _Requirements: R14_
  
  - [~] 20.6 Document health/MCP/discovery changes
    - Detail R5 health endpoints, R6 MCP tool updates, R7 enhanced discovery implementation
    - _Requirements: R14_
  
  - [~] 20.7 Document remote MCP and metadata
    - Detail R8 remote MCP decision (implemented or deferred with rationale), R9 metadata preparation
    - _Requirements: R14_
  
  - [~] 20.8 Document demo services and documentation
    - Detail R10 demo services created, R11 documentation files written
    - _Requirements: R14_
  
  - [~] 20.9 Document frontend changes
    - Detail R12 frontend compatibility changes (if any) with justifications
    - _Requirements: R14_
  
  - [~] 20.10 Document test results
    - Include focused test summary and final complete test suite results from R13
    - _Requirements: R14_
  
  - [~] 20.11 Document bugs found and fixed
    - List any bugs discovered during productization and how they were resolved
    - _Requirements: R14_
  
  - [~] 20.12 Fill in ending state
    - Record ending HEAD commit, branch, final test count
    - _Requirements: R14_
  
  - [~] 20.13 Complete confirmations section
    - Confirm all NON-NEGOTIABLE INVARIANTS preserved, frontend redesign NOT performed, Phase 4C NOT started, Phase 4D NOT started
    - _Requirements: R14_
  
  - [~] 20.14 List remaining limitations
    - Document known limitations and deferred work for future phases
    - _Requirements: R14_
  
  - [~] 20.15 Final audit review
    - Review complete audit document for accuracy and completeness
    - _Requirements: R14_

- [~] 21. Final Checkpoint - Productization Complete
  - Verify all tasks completed, all tests passing (727+ tests, 0 failures), audit document complete, baseline invariants preserved. Ask user if questions arise.

## Notes

- **Critical**: All 727 baseline tests must continue passing throughout implementation. Any test failure stops progress immediately.
- **Incremental Approach**: Each subsystem refactor (D2 phases) must be followed by focused tests before proceeding.
- **Test Execution**: Use focused tests during implementation for rapid feedback. Run complete `npm run test:all` once at completion (D13).
- **No Double Counting**: Focused test results during implementation are for verification only. Final test count comes from single complete suite run.
- **Rollback Strategy**: Each meaningful change should be committed separately with green tests. Use `git revert` if needed.
- **Protocol Preservation**: NON-NEGOTIABLE INVARIANTS are immutable. Any change to Anchor account model, PDA seeds, protocol economics, settlement/refund authority, verification semantics, unknown-effect handling, financial journal safety, or private/nullifier behavior is strictly forbidden.
- **Frontend Constraint**: NO visual redesign. Only API-compatible TypeScript type updates allowed.
- **Optional Tasks**: Tasks marked with `*` are optional test sub-tasks. They should be implemented but can be skipped for MVP.
- **Demo Services**: Must use real execution/verification/settlement/refund paths (no mocking of financial behavior).
- **Documentation**: All code examples in documentation must be valid and tested.
- **Remote MCP**: Implementation is conditional on library support. If not supported, document requirements and defer.
- **Configuration Safety**: Secrets must never appear in error messages, logs, or health responses. Only reference secret key names.
- **Launcher Safety**: Only manage processes launched by the launcher. Never kill unrelated processes. Reset functionality requires multiple safety checks.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "2.2"] },
    { "id": 3, "tasks": ["2.3", "2.4"] },
    { "id": 4, "tasks": ["3.1"] },
    { "id": 5, "tasks": ["3.2"] },
    { "id": 6, "tasks": ["3.3", "3.4"] },
    { "id": 7, "tasks": ["4.1"] },
    { "id": 8, "tasks": ["4.2", "4.3"] },
    { "id": 9, "tasks": ["4.4"] },
    { "id": 10, "tasks": ["5.1", "6.1"] },
    { "id": 11, "tasks": ["5.2", "6.2"] },
    { "id": 12, "tasks": ["7.1"] },
    { "id": 13, "tasks": ["7.2"] },
    { "id": 14, "tasks": ["8.1"] },
    { "id": 15, "tasks": ["8.2"] },
    { "id": 16, "tasks": ["9.1"] },
    { "id": 17, "tasks": ["9.2"] },
    { "id": 18, "tasks": ["9.3"] },
    { "id": 19, "tasks": ["9.4", "9.5"] },
    { "id": 20, "tasks": ["10.1"] },
    { "id": 21, "tasks": ["10.2", "10.3", "10.4"] },
    { "id": 22, "tasks": ["10.5", "10.6"] },
    { "id": 23, "tasks": ["11.1"] },
    { "id": 24, "tasks": ["11.2"] },
    { "id": 25, "tasks": ["11.3", "11.4"] },
    { "id": 26, "tasks": ["11.5"] },
    { "id": 27, "tasks": ["12.1", "12.2", "12.3", "12.4", "12.5", "12.6"] },
    { "id": 28, "tasks": ["12.7"] },
    { "id": 29, "tasks": ["13.1"] },
    { "id": 30, "tasks": ["13.2", "13.3"] },
    { "id": 31, "tasks": ["13.4"] },
    { "id": 32, "tasks": ["14.1"] },
    { "id": 33, "tasks": ["14.2"] },
    { "id": 34, "tasks": ["14.3"] },
    { "id": 35, "tasks": ["15.1", "15.2", "15.3"] },
    { "id": 36, "tasks": ["15.4"] },
    { "id": 37, "tasks": ["16.1"] },
    { "id": 38, "tasks": ["16.2", "16.3", "16.4"] },
    { "id": 39, "tasks": ["16.5"] },
    { "id": 40, "tasks": ["16.6"] },
    { "id": 41, "tasks": ["16.7"] },
    { "id": 42, "tasks": ["17.1", "17.2", "17.3", "17.4"] },
    { "id": 43, "tasks": ["17.5"] },
    { "id": 44, "tasks": ["17.6"] },
    { "id": 45, "tasks": ["18.1"] },
    { "id": 46, "tasks": ["18.2"] },
    { "id": 47, "tasks": ["18.3", "18.4"] },
    { "id": 48, "tasks": ["19.1", "19.2", "19.3", "19.4"] },
    { "id": 49, "tasks": ["19.5"] },
    { "id": 50, "tasks": ["20.1", "20.2"] },
    { "id": 51, "tasks": ["20.3", "20.4", "20.5", "20.6", "20.7", "20.8", "20.9", "20.10", "20.11"] },
    { "id": 52, "tasks": ["20.12", "20.13", "20.14"] },
    { "id": 53, "tasks": ["20.15"] }
  ]
}
```
