# Design: Setra402 Productization Batch A

## Overview

This design document specifies HOW each productization requirement will be implemented against the current Setra402 repository. All changes preserve the NON-NEGOTIABLE INVARIANTS and maintain the certified protocol behavior baseline (commit 72e665a, 727 tests passing).

## Design Principles

1. **Incremental Refactoring** - Make small, testable changes. Run focused tests after each subsystem refactor.
2. **Reuse Over Rewrite** - Leverage existing abstractions (`config.ts`, `runtime-config.ts`, health infrastructure) rather than creating parallel systems.
3. **Backward Compatibility** - All API changes must be backward-compatible additions, never breaking changes.
4. **Test Gates** - No change proceeds without green tests. Rollback immediately on test failure.
5. **Explicit Deferrals** - Document what is intentionally deferred rather than forcing incomplete implementations.

---

## D1: Protocol Behavior Baseline Verification

### Implementation Strategy

**Files Affected:**
- None (verification only)
- New: `.kiro/specs/setra402-productization-batch-a/.baseline-verification.json`

### Approach

1. **Pre-Flight Verification**
   - Run `git status --short` and verify working tree is clean
   - Run `git branch --show-current` and verify branch is `agent-validator`
   - Run `git rev-parse --short HEAD` and verify commit is `72e665a`
   - Run `git log --oneline --decorate -20` to confirm commit history
   - Run `npm run test:all` and verify 727 tests pass, 0 failures

2. **Baseline Snapshot**
   - Capture test output and commit hash in `.baseline-verification.json`:
     ```json
     {
       "baselineCommit": "72e665a",
       "baselineBranch": "agent-validator",
       "baselineTests": {
         "total": 727,
         "passed": 727,
         "failed": 0
       },
       "verifiedAt": "<ISO timestamp>",
       "invariants": [
         "Anchor account model",
         "PDA seeds",
         "Protocol economics",
         "SettlementCoordinator authority",
         "RefundScheduler authority",
         "VerificationPolicy semantics",
         "UNKNOWN_EXTERNAL_EFFECT",
         "UNKNOWN_FINANCIAL_OUTCOME",
         "Financial journal safety",
         "Private/nullifier behavior"
       ]
     }
     ```

3. **Continuous Verification**
   - After each meaningful change, run focused tests for affected subsystem
   - If any test fails:
     - STOP immediately
     - Investigate whether failure indicates protocol break
     - Rollback change if protocol break confirmed
     - Fix and re-test if test defect confirmed

### Test Gates
- Pre-flight: All 727 tests must pass before starting
- Mid-flight: Focused tests must pass after each subsystem refactor
- Post-flight: All 727 tests must pass at completion

### Rollback Strategy
- Git working tree stays clean (commit after each successful refactor)
- Use `git revert <commit>` if a merged change causes regression
- Never force-push or rewrite history

---

## D2: Safe Module Refactoring

### Current State Analysis

**Existing Structure** (buyer-agent/src/):
```
chain/           - Solana on-chain interactions
core/            - Core business logic
dev/             - Development tooling
manifest/        - Task manifest management
mcp/             - MCP server implementation
privacy/         - Private task handling
provider/        - Provider connectors
registry/        - Service registry
transport/       - Transport layer
verification/    - Verification engine
web/             - Web server
config.ts        - Environment configuration
runtime-config.ts - Runtime settings
orchestrator.ts  - Main orchestration logic
```

### Target Organization

**Desired Boundaries:**
```
src/
  providers/     - Provider connectors + registry (merge provider/ + registry/)
  verification/  - Verification logic (keep as-is, consolidate helpers)
  payments/      - Payment flows (new: extract from core/ + chain/)
  recovery/      - Recovery + reconciliation (new: extract from core/)
  mcp/           - MCP server + tools (keep as-is, improve descriptions)
  runtime/       - Runtime orchestration (new: orchestrator.ts + dev/)
  operator/      - Operator + health (extract from core/)
  shared/        - Shared utilities (new: common helpers)
  config/        - Configuration (merge config.ts + runtime-config.ts)
```

### Incremental Refactoring Sequence

**Phase 1: Consolidate Configuration**
- Files: `config.ts`, `runtime-config.ts`
- Action: Create `src/config/index.ts` that re-exports from both
- Preserve existing exports for backward compatibility
- Add new `src/config/validator.ts` with centralized validation logic
- Test: `npm run test:unit -- tests/unit/config`
- Risk: Low (pure consolidation, no behavior change)

**Phase 2: Extract Shared Utilities**
- Scan for duplicated helpers in:
  - `src/core/*.ts`
  - `src/verification/*.ts`
  - `src/provider/*.ts`
  - `src/chain/*.ts`
- Examples: hashing utilities, canonicalization, error builders
- Create `src/shared/` with:
  - `hash.ts` - Hashing functions
  - `canonical.ts` - Canonicalization logic
  - `errors.ts` - Common error builders
- Update imports incrementally (one module at a time)
- Test: Run focused tests after each module update

**Phase 3: Merge Provider + Registry**
- Files: `src/provider/`, `src/registry/`
- Action: Create `src/providers/` with subdirectories:
  - `connectors/` - Provider connector implementations
  - `registry/` - Service registry logic
  - `discovery/` - Service discovery (for R7)
- Move files incrementally, updating imports
- Test: `npm run test:unit -- tests/unit/provider tests/unit/registry`

**Phase 4: Extract Payments Module**
- Files: Extract from `src/chain/escrow.ts`, `src/chain/settlement-coordinator.ts`, `src/core/` payment logic
- Action: Create `src/payments/` with:
  - `escrow.ts` - Escrow management
  - `settlement.ts` - Settlement flows
  - `refund.ts` - Refund logic
- Re-export from original locations for backward compatibility
- Test: `npm run test:unit -- tests/unit/escrow tests/integration/settlement`

**Phase 5: Extract Recovery Module**
- Files: Extract from `src/core/operator.ts`, reconciliation logic
- Action: Create `src/recovery/` with:
  - `operator.ts` - Operator recovery logic
  - `reconciliation.ts` - Reconciliation engine
  - `scheduler.ts` - Refund scheduler
- Test: `npm run test:recovery`

**Phase 6: Extract Runtime + Operator**
- Files: `src/orchestrator.ts`, `src/dev/`, `src/core/operator-cli.ts`
- Action: Create `src/runtime/` and `src/operator/`
- Test: `npm run test:integration`

**Phase 7: Cleanup**
- Remove unused imports across all modified files
- Remove dead code identified during refactoring
- Rename stale experimental names (document renames)
- Standardize error handling patterns
- Test: `npm run test:all`

### Test Strategy
- **After Each Phase:** Run focused tests for affected modules
- **After Phase 7:** Run complete `npm run test:all`
- **Rollback Trigger:** Any test failure stops progress

### Deferred Items
- No giant directory migrations (keep incremental)
- No module splitting requiring API changes (maintain backward compatibility)

---

## D3: Central Configuration Validation

### Current State

**Existing Configuration:**
- `src/config.ts` - Core buyer agent config (RPC, program ID, keypairs)
- `src/runtime-config.ts` - Runtime settings (ports, state dir, flags)

**Scattered `process.env` Reads:**
- Throughout `src/core/`, `src/mcp/`, `src/web/`
- Provider profiles read from filesystem
- No centralized validation
- No fail-fast on startup

### Target Design

**New: `src/config/validator.ts`**
```typescript
export interface SetraConfiguration {
  // Solana
  solana: {
    rpcUrl: string;
    programId: PublicKey;
    mint: PublicKey;
    treasury: PublicKey;
  };
  // Authentication
  auth: {
    buyerKeypairPath: string;
    verifierKeypairPath: string;
  };
  // Infrastructure
  infra: {
    redisUrl?: string;
    redisHost?: string;
    redisPort?: number;
    redisTls?: boolean;
    dockerAvailable: boolean;
  };
  // Services
  services: {
    sellerUrl: string;
    mcpPort: number;
    webPort: number;
  };
  // State
  state: {
    stateDirectory: string;
    sellerExecutionDirectory?: string;
    sellerMintDirectory?: string;
  };
  // Providers
  providers: {
    profilesPath: string;
    secretRefs: Record<string, string>; // provider_id -> env var name
  };
  // Scheduler
  scheduler: {
    refundSchedulerEnabled: boolean;
    settlementSafetyMarginSec: number;
  };
  // Timeouts
  timeouts: {
    providerTimeoutMs: number;
    verificationTimeoutMs: number;
  };
}

export function validateConfiguration(env: NodeJS.ProcessEnv): SetraConfiguration;
```

### Implementation Approach

1. **Create Validator**
   - New file: `src/config/validator.ts`
   - Use Zod schemas (extend existing schemas in `config.ts` and `runtime-config.ts`)
   - Validate all required config at startup
   - Provide clear, actionable error messages:
     ```
     Configuration Error: Missing required environment variable PROGRAM_ID
     
     Expected: A valid Solana program public key
     Example: PROGRAM_ID=GZX8... (base58-encoded public key)
     
     See .env.example for all required configuration.
     ```

2. **Centralize `process.env` Reads**
   - Audit all `process.env` reads:
     ```bash
     grep -r "process\.env" buyer-agent/src/
     ```
   - Replace scattered reads with config imports:
     ```typescript
     // Before
     const rpcUrl = process.env.RPC_URL;
     
     // After
     import { config } from './config/index.js';
     const rpcUrl = config.solana.rpcUrl;
     ```

3. **Secret Handling**
   - Config validator checks presence of secret refs (env var names)
   - Never log secret values
   - Error messages reference secret key names, not values:
     ```
     Configuration Error: Provider "openai" requires secret OPENAI_API_KEY
     ```

4. **Update `.env.example`**
   - Document all required and optional env vars
   - Use placeholder values only (no real secrets):
     ```env
     # Solana Configuration
     RPC_URL=http://127.0.0.1:8899
     PROGRAM_ID=YOUR_PROGRAM_ID_HERE
     EXPECTED_MINT=YOUR_MINT_ADDRESS_HERE
     PROTOCOL_TREASURY_ADDRESS=YOUR_TREASURY_ADDRESS_HERE
     
     # Authentication
     BUYER_KEYPAIR_PATH=./keypairs/buyer.json
     VERIFIER_KEYPAIR_PATH=./keypairs/verifier.json
     
     # Services
     SELLER_URL=http://127.0.0.1:3000
     MCP_PORT=3002
     WEB_PORT=3003
     
     # Infrastructure
     REDIS_URL=redis://127.0.0.1:6379
     
     # Provider Secrets (example)
     # OPENAI_API_KEY=sk-...
     # ANTHROPIC_API_KEY=sk-...
     ```

5. **Integration Points**
   - `src/mcp/server.ts` - Call validator on startup
   - `src/web/start.ts` - Call validator on startup
   - `src/dev/launcher.js` - Call validator before starting services
   - All CLI tools - Call validator early

### Browser Config Safety

**Critical:** Server secrets MUST NOT be exposed to browser:
- Web API responses use public service metadata only (no API keys)
- Provider secret refs checked server-side only
- Browser receives sanitized config (ports, URLs, public keys)

### Test Strategy
- Unit tests for validator logic
- Integration tests for missing/invalid config scenarios
- Test that secrets are not leaked in error messages
- Test `.env.example` is valid (with placeholder values)

### Rollback Strategy
- Config validation is additive (doesn't change existing logic)
- Can be disabled with `SETRA_SKIP_CONFIG_VALIDATION=true` for rollback

---

## D4: One-Command Local Launcher

### Current State

**Existing Launcher:**
- `buyer-agent/src/dev/launcher.js` exists (referenced in package.json `dev:setra`)
- Current behavior unknown (need to inspect file)

### Target Design

**Enhanced Launcher** (`buyer-agent/src/dev/launcher.ts`):

```typescript
interface LauncherState {
  solana: 'checking' | 'ok' | 'unavailable';
  redis: 'checking' | 'ok' | 'unavailable';
  docker: 'checking' | 'ok' | 'unavailable';
  seller: 'starting' | 'ok' | 'failed';
  mcp: 'starting' | 'ok' | 'failed';
  web: 'starting' | 'ok' | 'failed';
}

interface ProcessHandle {
  name: string;
  process: ChildProcess;
  port?: number;
  pidFile?: string; // Mark ownership
}
```

### Launcher Behavior

**1. Prerequisites Check (expect running)**
- Solana validator: HTTP GET to `${RPC_URL}/health` or JSON-RPC `getHealth`
- Redis: TCP connect to `${REDIS_HOST}:${REDIS_PORT}`
- Docker: Run `docker info` (non-blocking)
- Required fixtures: Check keypair files exist
- Port availability: Check MCP_PORT, WEB_PORT not in use

**2. Start Owned Processes**
- Seller server: `cd seller-server && npm run dev` (or equivalent)
- MCP server: `node dist/mcp/server.js`
- Web runtime: `node dist/web/start.js`

**3. Process Ownership Tracking**
- Create PID files in `.setra-state/launcher/`:
  - `.setra-state/launcher/seller.pid`
  - `.setra-state/launcher/mcp.pid`
  - `.setra-state/launcher/web.pid`
- Each PID file contains:
  ```json
  {
    "pid": 12345,
    "name": "seller",
    "startedAt": "<ISO timestamp>",
    "port": 3000,
    "launcherVersion": "productization-batch-a"
  }
  ```

**4. Status Dashboard**
```
Setra402 local environment

Prerequisites:
  Solana     ✓ OK   http://127.0.0.1:8899
  Redis      ✓ OK   127.0.0.1:6379
  Docker     ✓ OK

Owned Services:
  Seller     ✓ OK   http://127.0.0.1:3000  [PID 12345]
  MCP        ✓ OK   http://127.0.0.1:3002/mcp  [PID 12346]
  Control    ✓ OK   http://127.0.0.1:3003  [PID 12347]

Ready.
Press Ctrl+C to stop owned services.
```

**5. Clean Shutdown (Ctrl+C)**
```typescript
process.on('SIGINT', async () => {
  console.log('\nShutting down owned services...');
  for (const handle of ownedProcesses) {
    console.log(`  Stopping ${handle.name}...`);
    handle.process.kill('SIGTERM');
    await waitForExit(handle.process, 5000);
    if (!handle.process.killed) {
      console.log(`  Force-killing ${handle.name}...`);
      handle.process.kill('SIGKILL');
    }
    // Remove PID file
    if (handle.pidFile && existsSync(handle.pidFile)) {
      unlinkSync(handle.pidFile);
    }
  }
  console.log('Shutdown complete.');
  process.exit(0);
});
```

### Destructive Reset Flag

**Command:** `npm run dev:setra -- --reset-test-ledger`

**Safety Checks:**
```typescript
async function safeResetTestLedger() {
  const ledgerPath = resolve('./test-ledger');
  
  // 1. Verify exact path
  if (!ledgerPath.includes('test-ledger')) {
    throw new Error('Ledger path does not contain "test-ledger" - refusing to delete');
  }
  
  // 2. Verify ownership marker
  const ownershipMarker = join(ledgerPath, '.setra-test-marker');
  if (!existsSync(ownershipMarker)) {
    throw new Error('Ledger ownership marker not found - refusing to delete');
  }
  
  // 3. Verify disposable/test marker
  const markerContent = readFileSync(ownershipMarker, 'utf8');
  const marker = JSON.parse(markerContent);
  if (marker.type !== 'test' || marker.disposable !== true) {
    throw new Error('Ledger is not marked as test/disposable - refusing to delete');
  }
  
  // 4. Confirm with user (interactive mode only)
  if (process.stdin.isTTY) {
    const answer = await prompt('Delete test ledger? This cannot be undone. [y/N] ');
    if (answer.toLowerCase() !== 'y') {
      console.log('Reset cancelled.');
      return;
    }
  }
  
  // 5. Perform deletion
  console.log(`Deleting test ledger at ${ledgerPath}...`);
  rmSync(ledgerPath, { recursive: true, force: true });
  console.log('Test ledger deleted.');
}
```

**Ownership Marker Creation:**
- Launcher creates `.setra-test-marker` on first run if not exists:
  ```json
  {
    "type": "test",
    "disposable": true,
    "createdBy": "setra402-launcher",
    "createdAt": "<ISO timestamp>"
  }
  ```

### Test Strategy
- Unit tests for launcher logic (mocked child processes)
- Integration test: start launcher, verify services start, send SIGINT, verify clean shutdown
- Integration test: verify reset safety checks prevent deletion of non-test paths
- Manual test: verify Ctrl+C shutdown is clean

### Files Affected
- `buyer-agent/src/dev/launcher.ts` (rewrite if existing is minimal, or enhance)
- `buyer-agent/package.json` (update `dev:setra` script)
- `.setra-state/launcher/` (new directory for PID files)
- `test-ledger/.setra-test-marker` (ownership marker)

### Deferred
- Solana validator lifecycle management (expect running)
- Redis lifecycle management (expect running)
- Production deployment support

---

## D5: Health and Readiness Endpoints

### Current State

**Existing Health Infrastructure:**
- `src/core/operator.ts` likely has health check logic
- `src/web/` exposes HTTP endpoints

### Target Design

**Health Endpoint:** `GET /health`

**Response Structure:**
```typescript
interface HealthResponse {
  status: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
  timestamp: string; // ISO 8601
  checks: {
    solana: ComponentHealth;
    redis: ComponentHealth;
    docker: ComponentHealth;
    seller: ComponentHealth;
    mcp: ComponentHealth;
    providerCatalog: ComponentHealth;
    providerSecrets: ComponentHealth;
    stateRoot: ComponentHealth;
    reconciliation: ComponentHealth;
    refundScheduler: ComponentHealth;
  };
  warnings: string[]; // Operational warnings (not errors)
}

interface ComponentHealth {
  status: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
  message?: string; // Human-readable status
  lastCheckAt?: string; // ISO 8601
}
```

**Example Response:**
```json
{
  "status": "HEALTHY",
  "timestamp": "2026-10-06T12:34:56.789Z",
  "checks": {
    "solana": {
      "status": "HEALTHY",
      "message": "Connected to http://127.0.0.1:8899",
      "lastCheckAt": "2026-10-06T12:34:56.789Z"
    },
    "redis": {
      "status": "HEALTHY",
      "message": "Connected to 127.0.0.1:6379"
    },
    "docker": {
      "status": "HEALTHY",
      "message": "Docker daemon available"
    },
    "seller": {
      "status": "HEALTHY",
      "message": "Seller reachable at http://127.0.0.1:3000"
    },
    "mcp": {
      "status": "HEALTHY",
      "message": "MCP server running on port 3002"
    },
    "providerCatalog": {
      "status": "HEALTHY",
      "message": "5 providers configured"
    },
    "providerSecrets": {
      "status": "DEGRADED",
      "message": "2 of 5 providers missing required secrets"
    },
    "stateRoot": {
      "status": "HEALTHY",
      "message": "State directory accessible at .setra-state"
    },
    "reconciliation": {
      "status": "HEALTHY",
      "message": "Reconciliation subsystem operational"
    },
    "refundScheduler": {
      "status": "UNAVAILABLE",
      "message": "Refund scheduler disabled (SETRA_REFUND_SCHEDULER_ENABLED=false)"
    }
  },
  "warnings": [
    "Provider 'openai' missing secret OPENAI_API_KEY",
    "Provider 'anthropic' missing secret ANTHROPIC_API_KEY"
  ]
}
```

### Health Check Implementation

**Reuse Existing Operator Infrastructure:**
- `src/core/operator.ts` likely has connection checking logic
- Wrap existing checks in health endpoint

**New: `src/operator/health.ts`**
```typescript
export async function checkSolanaHealth(rpcUrl: string): Promise<ComponentHealth>;
export async function checkRedisHealth(redisConfig): Promise<ComponentHealth>;
export async function checkDockerHealth(): Promise<ComponentHealth>;
export async function checkSellerHealth(sellerUrl: string): Promise<ComponentHealth>;
export async function checkMcpHealth(mcpPort: number): Promise<ComponentHealth>;
export async function checkProviderCatalog(providersPath: string): Promise<ComponentHealth>;
export async function checkProviderSecrets(providers, env): Promise<ComponentHealth>;
export async function checkStateRoot(stateDir: string): Promise<ComponentHealth>;
export async function checkReconciliation(): Promise<ComponentHealth>;
export async function checkRefundScheduler(enabled: boolean): Promise<ComponentHealth>;

export async function aggregateHealth(): Promise<HealthResponse>;
```

### Critical Constraints

**Health is Operational Information Only:**
- Health status indicates current system availability
- Health status DOES NOT prove historical provider effects occurred
- Health status DOES NOT prove historical financial outcomes succeeded
- Health status DOES NOT resolve ambiguity (UNKNOWN_EXTERNAL_EFFECT, UNKNOWN_FINANCIAL_OUTCOME)

**Example Warning in Response:**
```json
{
  "status": "HEALTHY",
  "warnings": [
    "Health checks are operational status only. They do not verify historical task outcomes or financial settlements. Consult financial journals and verification reports for authoritative records."
  ]
}
```

### Secret Safety
- Provider secrets check: only verify env vars are present, never log values
- Error messages: reference secret key names, not values
- Health response: no secrets in any field

### Performance
- Health checks must complete in < 5s
- Use connection pools (don't create new connections per health check)
- Cache non-critical checks (e.g., Docker availability) for 30s

### Integration
- Web server: `GET /health` endpoint
- MCP server: Optional `mcp_health` tool (low priority)
- Launcher: Call health checks before declaring "Ready"

### Test Strategy
- Unit tests for each health check function
- Integration tests for aggregate health endpoint
- Test that secrets are not leaked
- Test that health response completes in < 5s

### Files Affected
- New: `src/operator/health.ts`
- Update: `src/web/start.ts` (add `/health` endpoint)
- Reuse: `src/core/operator.ts` (connection checking logic)

---

## D6: MCP Tool Surface Productization

### Current State

**Existing MCP Tools** (likely in `src/mcp/`):
- `discover_services`
- `protected_call`
- `fund_task`
- `task_status`
- `refund_task`

### Target Design

**Preserve Core, Improve Descriptions:**
- Do NOT rewrite MCP implementation
- Update tool schemas with rich descriptions and examples
- Add server-level metadata explaining Setra402

**Enhanced Tool Descriptions:**

**1. MCP Server Metadata**
```typescript
{
  "name": "Setra402 MCP Server",
  "version": "productization-batch-a",
  "description": "Trust and conditional-settlement layer for autonomous agent payments. Setra402 provides escrow, verification, and protected execution for external service calls.",
  "capabilities": {
    "tools": true,
    "resources": false,
    "prompts": false
  }
}
```

**2. Tool: `discover_services`**
```typescript
{
  "name": "discover_services",
  "description": "Discover available protected services that can be called with payment protection. Returns services with pricing, verification policies, and capability metadata.",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  },
  "examples": [
    {
      "description": "List all available services",
      "input": {}
    }
  ]
}
```

**3. Tool: `protected_call`**
```typescript
{
  "name": "protected_call",
  "description": "Execute a service with payment protection via escrow and verification. Payment is held in escrow until verification passes. If verification fails, payment is refunded. Use this when you need guarantees that a service will deliver as promised or your payment will be returned.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "serviceId": {
        "type": "string",
        "description": "Service identifier from discover_services"
      },
      "input": {
        "type": "object",
        "description": "Service-specific input parameters"
      },
      "policyHash": {
        "type": "string",
        "description": "Optional verification policy hash. If omitted, uses service default."
      }
    },
    "required": ["serviceId", "input"]
  },
  "notes": [
    "Payment is escrowed before service execution",
    "Verification determines settlement (PASS) or refund (FAIL)",
    "Unknown outcomes (UNKNOWN_EXTERNAL_EFFECT) require manual investigation - do NOT blindly retry",
    "Check task_status for outcome before retrying"
  ],
  "examples": [
    {
      "description": "Call a lead generation service",
      "input": {
        "serviceId": "lead-gen-v1",
        "input": {
          "industry": "SaaS",
          "location": "San Francisco",
          "count": 10
        }
      }
    }
  ]
}
```

**4. Tool: `fund_task`**
```typescript
{
  "name": "fund_task",
  "description": "Add additional funds to an existing task. Use when a service requires more payment than initially escrowed.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "taskId": {
        "type": "string",
        "description": "Task identifier from protected_call response"
      },
      "additionalLamports": {
        "type": "number",
        "description": "Additional payment in lamports"
      }
    },
    "required": ["taskId", "additionalLamports"]
  },
  "notes": [
    "Funding is explicit - services cannot automatically debit more funds",
    "Funding must occur before task execution completes"
  ]
}
```

**5. Tool: `task_status`**
```typescript
{
  "name": "task_status",
  "description": "Check the status and outcome of a task. Returns execution state, verification result, and settlement status.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "taskId": {
        "type": "string",
        "description": "Task identifier from protected_call response"
      }
    },
    "required": ["taskId"]
  },
  "notes": [
    "Task outcomes: 'settled' (payment released), 'verification_failed' (refund available), 'unknown' (requires investigation)",
    "Unknown outcomes indicate provider ambiguity - consult operator before retrying"
  ]
}
```

**6. Tool: `refund_task`**
```typescript
{
  "name": "refund_task",
  "description": "Request refund for a failed or expired task. Refunds are only available when verification fails or the task expires without completion.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "taskId": {
        "type": "string",
        "description": "Task identifier from protected_call response"
      }
    },
    "required": ["taskId"]
  },
  "notes": [
    "Refunds are automatic for verification failures after deadline",
    "Manual refund requests are rejected if task is still active or already settled"
  ]
}
```

### Implementation Approach

1. **Update Tool Schemas**
   - Locate existing tool definitions in `src/mcp/`
   - Enhance `description` fields with clear explanations
   - Add `notes` arrays with critical warnings
   - Add `examples` arrays with realistic use cases

2. **Server Metadata**
   - Update MCP server info response with Setra402 description
   - Include keywords: `x402`, `Solana`, `agent payments`, `conditional settlement`, `escrow`, `verification`

3. **Documentation Integration**
   - Tool descriptions should match MCP_USAGE.md documentation
   - Keep descriptions concise (AI-friendly)
   - Emphasize critical concepts:
     - Payment is escrowed before execution
     - Verification controls settlement
     - Unknown outcomes must not be blindly retried

### Files Affected
- `src/mcp/server.ts` (or equivalent) - Update tool schemas
- `src/mcp/tools/*.ts` - Update individual tool definitions

### Test Strategy
- Unit tests verify tool schemas are valid
- Integration tests verify MCP protocol compliance
- Manual test: Connect MCP client and verify descriptions are clear

### Deferred
- Do NOT rewrite MCP core implementation
- Do NOT expose internal operator/reconciliation actions as tools

---

## D7: Enhanced Service Discovery

### Current State

**Existing `discover_services`:**
- Returns basic service list
- Limited metadata (likely service ID, name, description)

### Target Design

**Enriched Service Metadata:**
```typescript
interface ServiceDiscoveryResult {
  services: EnrichedServiceMetadata[];
}

interface EnrichedServiceMetadata {
  // Identity
  service_id: string;
  name: string;
  description: string;
  
  // Provider
  provider: string; // Provider type/identifier
  transport: 'REST' | 'MCP' | 'DOCKER' | 'UNKNOWN';
  provider_status: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE';
  
  // Economics
  price: number; // Lamports
  pricing_model?: 'FIXED' | 'VARIABLE' | 'USAGE_BASED';
  
  // I/O Contracts
  expected_input: InputSchema | string; // JSON schema or description
  expected_output: OutputSchema | string; // JSON schema or description
  
  // Protection
  verification_level: 'LEVEL_1' | 'LEVEL_2' | 'MANUAL' | 'NONE';
  protection_policy: 'ESCROW' | 'NULLIFIER' | 'HYBRID';
  private_supported: boolean;
  
  // Capabilities
  capabilities?: string[]; // e.g., ['streaming', 'batch', 'async']
  
  // Metadata
  version?: string;
  documentation_url?: string;
}
```

### Implementation Approach

**1. Enrich Existing Registry**
- Do NOT create second service catalog
- Enhance existing registry in `src/registry/` (or `src/providers/registry/` after refactor)
- Add metadata fields to service configuration

**2. Provider Profile Enhancement**
- Update provider profile schema (likely in `config/` or `seller-server/config/provider-profiles.json`)
- Add new fields:
  ```json
  {
    "serviceId": "lead-gen-v1",
    "name": "Lead Generation Service",
    "description": "Generate qualified B2B leads based on industry and location",
    "provider": "rest-openai-leads",
    "transport": "REST",
    "price": 1000000,
    "pricingModel": "FIXED",
    "expectedInput": {
      "type": "object",
      "properties": {
        "industry": { "type": "string" },
        "location": { "type": "string" },
        "count": { "type": "number" }
      },
      "required": ["industry", "location", "count"]
    },
    "expectedOutput": {
      "type": "object",
      "properties": {
        "leads": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "company": { "type": "string" },
              "contact": { "type": "string" },
              "email": { "type": "string" }
            }
          }
        }
      }
    },
    "verificationLevel": "LEVEL_1",
    "protectionPolicy": "ESCROW",
    "privateSupported": false,
    "capabilities": ["batch"],
    "version": "1.0.0"
  }
  ```

**3. Update `discover_services` Implementation**
- Locate existing `discover_services` tool in `src/mcp/`
- Enhance to return enriched metadata
- Derive `provider_status` from health checks:
  ```typescript
  async function getProviderStatus(providerId: string): Promise<'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE'> {
    // Check if provider secrets are present
    // Check if provider endpoint is reachable (for REST providers)
    // Return status
  }
  ```

**4. Backward Compatibility**
- Existing services without enriched metadata return minimal fields
- New `expected_input`/`expected_output` fields are optional
- Clients can gracefully handle missing fields

### Provider Status Derivation

**Logic:**
```typescript
function deriveProviderStatus(provider: ProviderConfig, health: HealthResponse): string {
  // Check secrets
  const secretsPresent = provider.requiredSecrets.every(secret => process.env[secret]);
  if (!secretsPresent) return 'UNAVAILABLE';
  
  // Check provider-specific health
  if (provider.transport === 'REST') {
    // Check if REST endpoint is reachable
    const reachable = await checkRestEndpoint(provider.endpoint);
    return reachable ? 'AVAILABLE' : 'DEGRADED';
  }
  
  if (provider.transport === 'MCP') {
    // Check if MCP server is running
    return health.checks.mcp.status === 'HEALTHY' ? 'AVAILABLE' : 'DEGRADED';
  }
  
  if (provider.transport === 'DOCKER') {
    // Check if Docker is available
    return health.checks.docker.status === 'HEALTHY' ? 'AVAILABLE' : 'UNAVAILABLE';
  }
  
  return 'AVAILABLE'; // Default
}
```

### Files Affected
- `src/registry/` (or `src/providers/registry/` after refactor) - Enhance registry logic
- `src/mcp/tools/discover-services.ts` (or equivalent) - Update implementation
- `config/provider-profiles.json` (or `seller-server/config/provider-profiles.json`) - Add metadata

### Test Strategy
- Unit tests for enriched metadata structure
- Integration test: call `discover_services`, verify all fields present
- Test backward compatibility with minimal metadata

### Deferred
- Do NOT create second service catalog
- Do NOT duplicate registry authority

---

## D8: Remote MCP Preparation

### Current State

**Existing MCP Stack:**
- `src/mcp/server.ts` - MCP server implementation
- `src/mcp/stdio.ts` - stdio transport
- Likely uses standard MCP library

### Target Design

**Decision Tree:**
1. **Inspect current MCP library dependencies**
   - Check `package.json` for MCP libraries
   - Check if library supports HTTP/SSE transport

2. **If library safely supports remote:**
   - Add bounded remote MCP entry point
   - Use standard MCP protocol (no custom invention)
   - Preserve stdio support

3. **If library requires major upgrade:**
   - Document requirements
   - Defer implementation

### Safe Remote MCP Requirements

**If Implementing:**
```typescript
// New: src/mcp/http-server.ts
import express from 'express';
import { McpServer } from './server.js'; // Reuse core

const app = express();

// Request body size limit (10 MB max)
app.use(express.json({ limit: '10mb' }));

// Timeout middleware (30s max)
app.use((req, res, next) => {
  req.setTimeout(30000);
  res.setTimeout(30000);
  next();
});

// MCP HTTP endpoint
app.post('/mcp', async (req, res) => {
  // Validate request
  if (!isValidMcpRequest(req.body)) {
    return res.status(400).json({ error: 'Invalid MCP request' });
  }
  
  // No secrets in request/response
  if (containsSecrets(req.body)) {
    return res.status(400).json({ error: 'Request contains forbidden data' });
  }
  
  // Execute via core MCP server
  const result = await mcpServer.handle(req.body);
  
  // No secrets in response
  const sanitized = sanitizeResponse(result);
  
  res.json(sanitized);
});

app.listen(config.mcpPort);
```

**Critical Constraints:**
- Bounded request bodies (10 MB max)
- Timeouts (30s max)
- No secrets exposed
- No financial authority in browser/client (server-side only)
- Existing provider/verification behavior preserved

### Implementation Approach

**Step 1: Library Assessment**
- Read `package.json` and identify MCP library
- Check library documentation for HTTP/SSE support
- Assess whether safe remote support is native or requires work

**Step 2A: If Native Support Exists**
- Create `src/mcp/http-server.ts` with bounded entry point
- Reuse `src/mcp/server.ts` core logic
- Add security middleware (body size limit, timeouts, secret filtering)
- Add new npm script: `"mcp:http": "npm run build:runtime && node dist/mcp/http-server.js"`
- Test: Integration test for HTTP MCP calls
- Document in MCP_USAGE.md

**Step 2B: If Major Upgrade Required**
- Create `buyer-agent/docs/REMOTE_MCP_REQUIREMENTS.md`:
  ```markdown
  # Remote MCP Requirements
  
  ## Current State
  - MCP library: <name> <version>
  - Transport: stdio only
  
  ## Requirements for Safe Remote MCP
  1. Library upgrade to <target version> required
  2. HTTP/SSE transport support
  3. Security considerations:
     - Request body size limits
     - Timeout enforcement
     - Secret filtering
     - Client authority restrictions
  
  ## Implementation Estimate
  - Effort: <estimate>
  - Dependencies: <list>
  - Risks: <list>
  
  ## Decision
  Deferred to future phase. Requires significant library upgrade and protocol testing.
  ```

### Files Affected
- **If implementing:** New `src/mcp/http-server.ts`, update package.json, update docs
- **If deferring:** New `buyer-agent/docs/REMOTE_MCP_REQUIREMENTS.md`

### Test Strategy
- **If implementing:** Integration tests for HTTP MCP calls, security tests (body size, timeouts, secrets)
- **If deferring:** Document test requirements in REMOTE_MCP_REQUIREMENTS.md

### Deferred
- Do NOT invent custom MCP protocol
- Do NOT break stdio support
- Do NOT force implementation if library doesn't support it safely

---

## D9: MCP Registry Metadata Preparation

### Target Design

**Metadata Files:**

**1. `buyer-agent/mcp-server.json`** (MCP Server metadata)
```json
{
  "name": "Setra402",
  "version": "0.1.0-batch-a",
  "description": "Trust and conditional-settlement layer for autonomous agent payments",
  "homepage": "https://github.com/setra402/setra402",
  "repository": {
    "type": "git",
    "url": "https://github.com/setra402/setra402.git"
  },
  "keywords": [
    "x402",
    "Solana",
    "MCP",
    "agent-payments",
    "conditional-settlement",
    "escrow",
    "verification",
    "protected-services"
  ],
  "author": "Setra402 Team",
  "license": "MIT",
  "transport": {
    "stdio": {
      "command": "node",
      "args": ["dist/mcp/stdio.js"]
    }
  },
  "capabilities": {
    "tools": [
      "discover_services",
      "protected_call",
      "fund_task",
      "task_status",
      "refund_task"
    ],
    "resources": false,
    "prompts": false
  }
}
```

**2. `buyer-agent/README.md`** (update to include MCP section)
```markdown
# Setra402 Buyer Agent

Trust and conditional-settlement layer for autonomous agent payments.

## What is Setra402?

Setra402 provides payment protection for AI agents calling external services. Payments are held in escrow until verification passes. If a service fails to deliver, payments are automatically refunded.

## MCP Integration

Setra402 exposes a Model Context Protocol (MCP) server for AI agent integration.

### Available Tools
- `discover_services` - Find protected services
- `protected_call` - Execute service with payment protection
- `fund_task` - Add funds to existing task
- `task_status` - Check task outcome
- `refund_task` - Request refund

### Connecting

**stdio transport:**
```json
{
  "mcpServers": {
    "setra402": {
      "command": "node",
      "args": ["path/to/buyer-agent/dist/mcp/stdio.js"],
      "env": {
        "RPC_URL": "http://127.0.0.1:8899",
        "PROGRAM_ID": "...",
        "..."
      }
    }
  }
}
```

See `docs/MCP_USAGE.md` for complete setup instructions.
```

**3. Icon/Logo** (if exists)
- Check for existing icon in repo
- If exists, reference in metadata
- If not, defer to future phase (not critical for this batch)

### Implementation Approach

1. **Create Metadata Files**
   - New: `buyer-agent/mcp-server.json`
   - Update: `buyer-agent/README.md` (add MCP section)

2. **Do NOT Publish**
   - Files are prepared for future publication
   - No npm publish, no registry submission
   - No internet publication

3. **Validation**
   - Validate `mcp-server.json` against MCP registry schema (if schema exists)
   - Ensure all URLs are placeholders or valid local paths

### Files Affected
- New: `buyer-agent/mcp-server.json`
- Update: `buyer-agent/README.md`

### Test Strategy
- Validate JSON syntax
- Validate schema compliance (if MCP registry schema exists)

### Deferred
- Actual publication to MCP registry
- Public-facing documentation site
- Marketing materials

---

## D10: Deterministic Demo Services

### Target Design

**Three Demo Services:**

1. **Structured Lead/Data Generation** (`demo-lead-gen`)
   - Input: `{ industry: string, location: string, count: number }`
   - Output: `{ leads: Array<{ company, contact, email }> }`
   - Verification: Check lead count matches requested count
   - Demo outcomes: PASS (correct count), FAIL (wrong count)

2. **Web Scraping/Source Retrieval** (`demo-web-scrape`)
   - Input: `{ url: string, selector: string }`
   - Output: `{ content: string, timestamp: number }`
   - Verification: Check content is non-empty and matches selector
   - Demo outcomes: PASS (valid content), FAIL (empty or invalid)

3. **Compute/Tool Execution** (`demo-compute-sha256`)
   - Input: `{ data: string }`
   - Output: `{ hash: string }`
   - Verification: Re-compute SHA256 and compare
   - Demo outcomes: PASS (hash matches), FAIL (hash mismatch)

### Implementation Approach

**1. Create Demo Providers**
- Location: `buyer-agent/src/demo/` (new directory)
- Files:
  - `demo-lead-gen.ts`
  - `demo-web-scrape.ts`
  - `demo-compute.ts`
  - `demo-registry.ts` (register demo services)

**2. Demo Provider Template**
```typescript
// demo-lead-gen.ts
export class DemoLeadGenProvider {
  async execute(input: { industry: string; location: string; count: number }) {
    // Deterministic lead generation (no external API calls)
    const leads = generateDeterministicLeads(input.industry, input.location, input.count);
    
    // Randomly fail 20% of the time to demonstrate refund path
    const shouldFail = Math.random() < 0.2;
    if (shouldFail) {
      // Return wrong count to trigger verification failure
      return { leads: leads.slice(0, input.count - 1) };
    }
    
    return { leads };
  }
  
  verify(input: any, output: any): boolean {
    return output.leads.length === input.count;
  }
}

function generateDeterministicLeads(industry: string, location: string, count: number) {
  // Use seeded random generator for deterministic output
  const seed = hashString(`${industry}-${location}-${count}`);
  const rng = seededRandom(seed);
  
  const leads = [];
  for (let i = 0; i < count; i++) {
    leads.push({
      company: `${industry} Corp ${i + 1}`,
      contact: `Contact ${i + 1}`,
      email: `contact${i + 1}@${industry.toLowerCase()}.example.com`,
    });
  }
  return leads;
}
```

**3. Register Demo Services**
```typescript
// demo-registry.ts
export function registerDemoServices(registry: ServiceRegistry) {
  registry.register({
    serviceId: 'demo-lead-gen',
    name: 'Demo: Lead Generation',
    description: 'Generate structured B2B leads (deterministic demo)',
    provider: 'demo-lead-gen',
    transport: 'INTERNAL',
    price: 1_000_000, // 0.001 SOL
    verificationLevel: 'LEVEL_1',
    protectionPolicy: 'ESCROW',
    privateSupported: false,
    expectedInput: {
      type: 'object',
      properties: {
        industry: { type: 'string' },
        location: { type: 'string' },
        count: { type: 'number' },
      },
      required: ['industry', 'location', 'count'],
    },
    expectedOutput: {
      type: 'object',
      properties: {
        leads: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              company: { type: 'string' },
              contact: { type: 'string' },
              email: { type: 'string' },
            },
          },
        },
      },
    },
  });
  
  // Register other demo services...
}
```

**4. Integration with Orchestrator**
- Demo providers use SAME execution/verification/settlement/refund path
- No fake financial behavior (real escrow, real settlement, real refund)
- Demo flag in config enables demo services: `SETRA_DEMO_MODE=true`

**5. Demo Mode Configuration**
```env
# Enable demo services
SETRA_DEMO_MODE=true

# Demo services are registered alongside real providers
# They appear in discover_services with 'demo-' prefix
```

### Test Strategy
- Unit tests for each demo provider
- Integration tests for demo service execution through full flow
- E2E test: discover demo services, call, verify settlement/refund
- Test that demo mode can be disabled

### Files Affected
- New: `buyer-agent/src/demo/` directory
- Update: `src/registry/` to support demo service registration
- Update: `.env.example` with `SETRA_DEMO_MODE` flag

### Deferred
- Frontend UI for demo services (separate pass)
- Demo service documentation site
- Advanced demo scenarios (streaming, async, etc.)

---

## D11: Developer Documentation

### Target Documentation Structure

**Files to Create/Update:**

1. **`buyer-agent/docs/CURRENT_ARCHITECTURE.md`**
   - System architecture overview
   - Component diagram
   - Data flow diagrams
   - Module boundaries
   - Key abstractions

2. **`buyer-agent/docs/LOCAL_DEVELOPMENT.md`**
   - Prerequisites (Solana, Redis, Docker)
   - Environment setup
   - Running `npm run dev:setra`
   - Running tests
   - Debugging guide
   - Common issues and solutions

3. **`buyer-agent/docs/MCP_USAGE.md`**
   - What is MCP
   - Connecting MCP client
   - Tool reference (discover_services, protected_call, etc.)
   - Examples
   - Troubleshooting

4. **`buyer-agent/docs/OPERATIONS.md`**
   - Health monitoring
   - Operator CLI usage
   - Refund scheduler
   - Reconciliation
   - Recovery procedures
   - Understanding UNKNOWN_EXTERNAL_EFFECT

### Documentation Content Outline

**CURRENT_ARCHITECTURE.md:**
```markdown
# Setra402 Architecture

## Overview
Setra402 is a trust and conditional-settlement layer for autonomous agent payments.

## High-Level Design
[Diagram: Buyer Agent <-> Seller Server <-> Provider]
[Diagram: Escrow -> Execution -> Verification -> Settlement/Refund]

## Components

### Core Components
- **Orchestrator** - Coordinates execution flow
- **Funding Coordinator** - Manages escrow
- **Settlement Service** - Handles settlement and refunds
- **Verification Service** - Verifies task outcomes
- **Provider Connectors** - Interface with external providers

### On-Chain Components
- **Setra402 Program** - Anchor program on Solana
- **Escrow PDAs** - Hold escrowed funds
- **Settlement Coordinator** - Authorizes settlements
- **Refund Scheduler** - Manages refunds

### Infrastructure
- **Redis** - Task state and locking
- **MCP Server** - AI agent interface
- **Web Server** - HTTP API and control plane

## Data Flow
1. Agent calls `protected_call` via MCP
2. Orchestrator requests quote from seller
3. Funding coordinator creates escrow PDA
4. Seller executes task
5. Verification service validates outcome
6. Settlement service settles (PASS) or schedules refund (FAIL)

## Module Organization
[After refactoring per D2]

## Security Boundaries
- Server-side: All financial operations, provider secrets
- Browser-side: Read-only UI, no secrets
- On-chain: Settlement authority, refund authority

## Key Invariants
[Reference NON-NEGOTIABLE INVARIANTS from requirements]
```

**LOCAL_DEVELOPMENT.md:**
```markdown
# Local Development Guide

## Prerequisites
- Node.js 18+
- Solana CLI
- Redis
- Docker (optional, for sandbox providers)
- Rust + Anchor (for program development)

## Environment Setup

1. Clone repository
2. Install dependencies: `npm install` (root), `cd buyer-agent && npm install`
3. Copy `.env.example` to `.env` and configure
4. Generate keypairs: `solana-keygen new -o keypairs/buyer.json`
5. Start Solana validator: `solana-test-validator`
6. Start Redis: `redis-server`

## Running Setra402

**One-Command Launcher:**
```bash
cd buyer-agent
npm run dev:setra
```

This starts:
- Seller server (port 3000)
- MCP server (port 3002)
- Web control plane (port 3003)

**Manual Start:**
```bash
# Terminal 1: Seller
cd seller-server
npm run dev

# Terminal 2: MCP
cd buyer-agent
npm run mcp:server

# Terminal 3: Web
cd buyer-agent
npm run web
```

## Running Tests

**All tests:**
```bash
npm run test:all
```

**Focused tests:**
```bash
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:mcp
```

## Debugging

**Enable verbose logging:**
```env
SETRA_LOG_LEVEL=debug
```

**Inspect operator state:**
```bash
npm run operator:inspect
```

**Common Issues:**

1. **"Connection refused to Solana RPC"**
   - Ensure `solana-test-validator` is running
   - Check `RPC_URL` in `.env`

2. **"Redis connection failed"**
   - Ensure `redis-server` is running
   - Check `REDIS_URL` in `.env`

3. **"Provider secret missing"**
   - Check `.env` for required provider secrets (e.g., OPENAI_API_KEY)
   - Use `SETRA_DEMO_MODE=true` to bypass provider secrets

## Development Workflow

1. Make code changes
2. Run `npm run build` (or `npm run build:runtime`)
3. Run focused tests
4. Restart services if needed
5. Test manually via MCP client or web UI
```

**MCP_USAGE.md:**
```markdown
# MCP Integration Guide

## What is MCP?

Model Context Protocol (MCP) is a standard protocol for AI agents to interact with external tools and services. Setra402 exposes an MCP server for protected service execution.

## Connecting an MCP Client

**Claude Desktop** (example):
```json
{
  "mcpServers": {
    "setra402": {
      "command": "node",
      "args": ["/path/to/buyer-agent/dist/mcp/stdio.js"],
      "env": {
        "RPC_URL": "http://127.0.0.1:8899",
        "PROGRAM_ID": "YOUR_PROGRAM_ID",
        "EXPECTED_MINT": "YOUR_MINT_ADDRESS",
        "PROTOCOL_TREASURY_ADDRESS": "YOUR_TREASURY_ADDRESS",
        "BUYER_KEYPAIR_PATH": "/path/to/buyer.json",
        "VERIFIER_KEYPAIR_PATH": "/path/to/verifier.json",
        "SELLER_URL": "http://127.0.0.1:3000",
        "SETRA_STATE_DIR": "/path/to/.setra-state",
        "SETTLEMENT_SAFETY_MARGIN_SEC": "300"
      }
    }
  }
}
```

## Available Tools

### `discover_services`
Find available protected services.

**Input:** None

**Output:**
```json
{
  "services": [
    {
      "service_id": "demo-lead-gen",
      "name": "Demo: Lead Generation",
      "description": "Generate structured B2B leads",
      "price": 1000000,
      "verification_level": "LEVEL_1",
      "..."
    }
  ]
}
```

### `protected_call`
Execute a service with payment protection.

**Input:**
```json
{
  "serviceId": "demo-lead-gen",
  "input": {
    "industry": "SaaS",
    "location": "San Francisco",
    "count": 10
  }
}
```

**Output:**
```json
{
  "status": "settled",
  "taskId": "123...",
  "result": {
    "leads": [...]
  },
  "settlement": {
    "signature": "..."
  }
}
```

### `fund_task`
Add funds to an existing task.

**Input:**
```json
{
  "taskId": "123...",
  "additionalLamports": 1000000
}
```

### `task_status`
Check task status and outcome.

**Input:**
```json
{
  "taskId": "123..."
}
```

**Output:**
```json
{
  "status": "settled",
  "verification": {
    "passed": true
  },
  "settlement": {
    "signature": "..."
  }
}
```

### `refund_task`
Request refund for failed task.

**Input:**
```json
{
  "taskId": "123..."
}
```

## Usage Examples

[Examples for each tool...]

## Understanding Outcomes

- **Settled**: Verification passed, payment released to provider
- **Verification Failed**: Verification failed, refund available
- **Unknown**: Provider outcome ambiguous, requires investigation

**Critical**: Do NOT blindly retry unknown outcomes. Use `task_status` to investigate first.

## Troubleshooting

[Common MCP issues and solutions...]
```

**OPERATIONS.md:**
```markdown
# Operations Guide

## Health Monitoring

**Check system health:**
```bash
curl http://localhost:3003/health
```

**Interpret health status:**
- `HEALTHY`: All systems operational
- `DEGRADED`: Partial functionality (e.g., some providers unavailable)
- `UNAVAILABLE`: Critical system failure

**Important**: Health status is operational information only. It does NOT prove historical task outcomes or financial settlements.

## Operator CLI

**Inspect operator state:**
```bash
npm run operator:inspect
```

**Output includes:**
- Pending reconciliations
- Unknown-effect tasks
- Refund queue status
- Provider health

## Refund Scheduler

**Start refund scheduler:**
```env
SETRA_REFUND_SCHEDULER_ENABLED=true
```

**Manual refund scheduling:**
```bash
npm run refund:schedule -- --task-id 123...
```

## Reconciliation

**What is reconciliation?**

Reconciliation resolves ambiguous task outcomes (UNKNOWN_EXTERNAL_EFFECT, UNKNOWN_FINANCIAL_OUTCOME) by querying provider state and comparing with local state.

**Trigger reconciliation:**
```bash
npm run operator:inspect -- --reconcile
```

## Understanding UNKNOWN_EXTERNAL_EFFECT

**What it means:**

Provider execution completed but outcome is ambiguous (network error, provider timeout, inconsistent state).

**Recovery procedure:**

1. Check operator state: `npm run operator:inspect`
2. Query provider directly (if API available)
3. Compare provider state with local financial journal
4. Make authoritative decision: settlement or refund
5. Execute decision via operator CLI

**Critical**: Do NOT blindly retry UNKNOWN_EXTERNAL_EFFECT tasks. This can lead to double-spending or duplicate payments.

## Provider Configuration

**REST Provider:**
[Example configuration and registration]

**MCP Provider:**
[Example configuration and registration]

## Common Operations

[Step-by-step guides for common operational tasks...]
```

### Implementation Approach

1. **Create Documentation Files**
   - New: All four documentation files in `buyer-agent/docs/`
   - Use markdown with clear structure
   - Include diagrams (mermaid or ASCII art)
   - Include code examples

2. **Historical Audit Preservation**
   - Do NOT modify existing `PHASE*_COMPLETE.md` or `PHASE*_AUDIT.md` files
   - New documentation is separate and current

3. **Cross-Reference**
   - Documentation should reference each other
   - README.md should link to all docs

### Files Affected
- New: `buyer-agent/docs/CURRENT_ARCHITECTURE.md`
- New: `buyer-agent/docs/LOCAL_DEVELOPMENT.md`
- New: `buyer-agent/docs/MCP_USAGE.md`
- New: `buyer-agent/docs/OPERATIONS.md`
- Update: `buyer-agent/README.md` (add links to docs)

### Test Strategy
- Manual review of documentation for accuracy
- Test all code examples in documentation
- Verify links and cross-references

### Deferred
- Marketing materials
- Public-facing documentation site
- Video tutorials

---

## D12: Frontend Compatibility

### Constraint

**NO FRONTEND REDESIGN.**

### Allowed Changes

**Only if required by Batch A backend changes:**

1. **Discovery Metadata API Changes (R7)**
   - If `discover_services` returns enriched metadata, frontend may need to consume new fields
   - Change type: API response shape extension (backward-compatible)
   - Allowed: Update TypeScript types to include new fields
   - Allowed: Display new fields if already rendered generically
   - NOT allowed: Redesign service cards or layout

2. **Health Endpoint Integration (R5)**
   - If frontend displays health status, update to use new `/health` endpoint
   - Change type: API endpoint change
   - Allowed: Update fetch call to new endpoint
   - Allowed: Parse new response structure
   - NOT allowed: Redesign health status UI

3. **Security Regression Fixes**
   - If Batch A identifies security issue requiring frontend fix
   - Change type: Security fix
   - Allowed: Minimal fix to close vulnerability
   - NOT allowed: Redesign affected component

### Implementation Approach

1. **Audit Frontend Touchpoints**
   - Scan frontend code for API calls to buyer-agent:
     ```bash
     grep -r "discover_services\|/health\|/api" frontend/src/
     ```
   - Identify calls that need API compatibility updates

2. **Make Minimal Changes**
   - Update TypeScript types for API responses
   - Update fetch calls if endpoints change
   - Do NOT change JSX structure, styles, or layouts

3. **Document Every Change**
   - Create `frontend/BATCH_A_CHANGES.md`:
     ```markdown
     # Frontend Changes for Batch A
     
     ## API Compatibility Changes
     
     ### 1. Discovery Metadata (R7)
     - **File**: `src/components/ServiceList.tsx`
     - **Change**: Updated `ServiceMetadata` type to include `expected_input`, `expected_output`, `provider_status`
     - **Justification**: Required to consume enriched discovery metadata from backend
     - **Visual Impact**: None (new fields not displayed yet)
     
     ### 2. Health Endpoint (R5)
     - **File**: `src/api/health.ts`
     - **Change**: Updated health check to use `/health` endpoint instead of `/status`
     - **Justification**: Backend consolidated health checks to single endpoint
     - **Visual Impact**: None (same data, different endpoint)
     ```

### Test Strategy
- Frontend build must succeed
- Existing frontend tests must pass
- Manual test: Verify frontend still renders correctly
- Screenshot comparison: Verify no visual changes

### Files Affected
- Minimal frontend files (document in `frontend/BATCH_A_CHANGES.md`)
- Update: Frontend TypeScript types only if required

### Deferred
- All visual redesign
- Component refactoring
- Style changes
- Layout changes

---

## D13: Testing Strategy

### Baseline

**Starting:** 727 unique tests, 0 failures  
**Target:** 727+ tests, 0 failures

### Testing Approach

**During Implementation (Focused Tests):**

1. **After Each Subsystem Refactor (D2):**
   ```bash
   # Example: After refactoring config module
   npm run test:unit -- tests/unit/config
   
   # After refactoring provider module
   npm run test:unit -- tests/unit/provider
   npm run test:integration -- tests/integration/rest-x402
   ```

2. **After Each Feature Implementation:**
   ```bash
   # After implementing launcher (D4)
   npm run test:unit -- tests/unit/launcher
   npm run test:integration -- tests/integration/launcher
   
   # After implementing health endpoint (D5)
   npm run test:unit -- tests/unit/health
   npm run test:integration -- tests/integration/health
   ```

3. **Test Isolation:**
   - Use `--no-file-parallelism` for tests with shared state
   - Use vitest's `describe.sequential()` for ordered tests
   - Clean up test state after each test

**At Completion (Full Suite):**

```bash
npm run test:all
```

This runs (from `scripts/test-all.mjs`):
- Buyer unit tests
- Buyer integration tests
- Live E2E tests
- Docker sandbox tests
- Browser/security tests
- Seller Rust tests
- Anchor tests
- Build checks (`build`, `build:runtime`)
- Format check (`format:check`)
- Git diff check
- Secret scan (if exists)

### Test Coverage Requirements

**Must maintain coverage for:**
- Settlement authority and flows
- Refund authority and flows
- Verification semantics
- Provider recovery behavior
- Provider idempotency
- Financial journaling
- Unknown-effect handling
- Private/nullifier behavior

### New Tests Required

**D1: Baseline Verification**
- Test: Verify baseline verification script works

**D2: Module Refactoring**
- Tests: Ensure refactored modules have same behavior as originals

**D3: Configuration Validation**
- Tests: Missing config fails fast
- Tests: Invalid config fails with clear errors
- Tests: Secrets not leaked in errors
- Tests: `.env.example` is valid

**D4: Launcher**
- Tests: Launcher starts owned processes
- Tests: Launcher stops owned processes cleanly
- Tests: Reset safety checks prevent deletion of non-test paths
- Tests: Ownership tracking works

**D5: Health Endpoint**
- Tests: Health endpoint returns correct status
- Tests: Health checks complete in < 5s
- Tests: Secrets not leaked in health response

**D6: MCP Tool Descriptions**
- Tests: Tool schemas are valid MCP
- Tests: Tool descriptions are non-empty

**D7: Enhanced Discovery**
- Tests: `discover_services` returns enriched metadata
- Tests: Backward compatibility with minimal metadata

**D8: Remote MCP** (if implemented)
- Tests: HTTP MCP calls work
- Tests: Body size limit enforced
- Tests: Timeouts enforced
- Tests: Secrets not exposed

**D10: Demo Services**
- Tests: Each demo service executes successfully
- Tests: Demo services trigger verification pass/fail correctly
- Tests: Demo services use real settlement/refund path

**D11: Documentation**
- Tests: All code examples in docs are valid
- Tests: All links in docs are valid

### Test Execution Order

1. **Focused tests during implementation** (as changes are made)
2. **One complete `npm run test:all` at completion**
3. **No double-counting** (focused test results are not included in final count)

### Test Failure Protocol

**If any test fails:**
1. STOP immediately
2. Investigate failure cause:
   - Protocol break? (Check NON-NEGOTIABLE INVARIANTS)
   - Test defect? (Test is wrong, not code)
   - New bug introduced by refactor?
3. If protocol break:
   - Rollback change immediately
   - Re-run tests to confirm rollback fixes issue
   - Investigate why change broke protocol
4. If test defect:
   - Fix test
   - Re-run tests to confirm fix
5. If new bug:
   - Fix bug
   - Add regression test
   - Re-run tests to confirm fix

### Rollback Strategy

- Each meaningful change is committed separately
- Green tests before commit
- Use `git revert <commit>` if merged change causes regression
- Never force-push or rewrite history

---

## D14: Productization Audit

### Audit Document Structure

**File:** `buyer-agent/docs/PRODUCTIZATION_BATCH_A.md`

```markdown
# Productization Batch A Audit

## Overview
Comprehensive audit of productization work completed in Batch A.

## Baseline
- **Starting HEAD:** 72e665a
- **Starting Branch:** agent-validator
- **Starting Tests:** 727 unique, 0 failures

## Ending State
- **Ending HEAD:** [commit hash]
- **Ending Branch:** agent-validator
- **Ending Tests:** [count] unique, 0 failures

## Commits
[List all commits made during Batch A]

## Refactors Completed

### R2: Module Organization
[List of module refactors with before/after structure]

### [Other refactors...]

## Configuration Changes

### R3: Central Configuration
- Created `src/config/validator.ts`
- Centralized all `process.env` reads
- Updated `.env.example`
- [Details...]

## Launcher Implementation

### R4: One-Command Launcher
- Created/enhanced `src/dev/launcher.ts`
- Implements `npm run dev:setra`
- Process ownership tracking
- Clean shutdown on Ctrl+C
- Reset safety checks
- [Details...]

## Health/Readiness Implementation

### R5: Health Endpoint
- Created `src/operator/health.ts`
- Exposed `GET /health` endpoint
- [Details...]

## MCP Changes

### R6: Tool Surface Productization
- Updated tool descriptions
- Added examples and notes
- [Details...]

### R7: Enhanced Discovery
- Enriched `discover_services` metadata
- [Details...]

### R8: Remote MCP
- **Status:** [Implemented / Documented and Deferred]
- [Details...]

### R9: Registry Metadata
- Created `mcp-server.json`
- Updated README with MCP section
- [Details...]

## Demo Services

### R10: Deterministic Demos
- Created `demo-lead-gen`
- Created `demo-web-scrape`
- Created `demo-compute-sha256`
- [Details...]

## Documentation

### R11: Developer Docs
- Created `CURRENT_ARCHITECTURE.md`
- Created `LOCAL_DEVELOPMENT.md`
- Created `MCP_USAGE.md`
- Created `OPERATIONS.md`
- [Details...]

## Frontend Changes

### R12: Compatibility Only
- [List minimal frontend changes if any]
- [Justification for each change]

## Bugs Found and Fixed
[List any bugs discovered and fixed during productization]

## Test Results

### Focused Tests During Implementation
[Summary of focused test runs, not detailed counts]

### Final Regression Test
```
npm run test:all

Results:
- Buyer unit: [count] passed
- Buyer integration: [count] passed
- Live E2E: [count] passed
- Docker sandbox: [count] passed
- Browser/security: [count] passed
- Seller Rust: [count] passed
- Anchor: [count] passed
- Build: ✓ passed
- Build runtime: ✓ passed
- Format check: ✓ passed
- Git diff check: ✓ passed
- Secret scan: ✓ passed

Total: [count] unique tests, 0 failures
```

## Remaining Limitations
[List known limitations and future work]

## Confirmations

### Protocol Semantics Unchanged
✓ Confirmed: All NON-NEGOTIABLE INVARIANTS preserved
- Anchor account model: Unchanged
- PDA seeds: Unchanged
- Protocol economics: Unchanged
- SettlementCoordinator authority: Unchanged
- RefundScheduler authority: Unchanged
- VerificationPolicy semantics: Unchanged
- UNKNOWN_EXTERNAL_EFFECT: Unchanged
- UNKNOWN_FINANCIAL_OUTCOME: Unchanged
- Financial journal safety: Unchanged
- Private/nullifier behavior: Unchanged

### Frontend Redesign NOT Performed
✓ Confirmed: No visual redesign, only API-compatible changes

### Phase 4C NOT Started
✓ Confirmed: Phase 4C work not initiated

### Phase 4D NOT Started
✓ Confirmed: Phase 4D work not initiated

## Final Deliverables

1. **Final HEAD:** [commit hash]
2. **Commit List:** [X commits] (see above)
3. **Refactors Completed:** Module organization, config centralization, cleanup
4. **dev:setra Launcher:** Implemented with safety checks
5. **MCP Productization:** Tool descriptions improved, discovery enhanced
6. **Demo Services:** 3 deterministic demos created
7. **Remote MCP Status:** [Implemented / Documented and deferred]
8. **Test Totals:** [count] tests passing, 0 failures
9. **Remaining Issues:** [See limitations section]
10. **UI Redesign Confirmation:** ✓ NOT started

## Sign-Off

This audit confirms that Productization Batch A is complete and ready for the next phase (visual redesign).

**Audited by:** [Name]  
**Date:** [Date]
```

### Implementation Approach

1. **Create Template Early**
   - Create `PRODUCTIZATION_BATCH_A.md` template at start of Batch A
   - Fill in baseline information immediately

2. **Update Throughout Implementation**
   - Add commits as they are made
   - Add test results as focused tests are run
   - Document bugs found and fixed

3. **Complete at End**
   - Fill in final HEAD commit
   - Add final regression test results
   - Complete remaining limitations section
   - Confirm all checkboxes

### Files Affected
- New: `buyer-agent/docs/PRODUCTIZATION_BATCH_A.md`

### Test Strategy
- Manual review of audit document for completeness
- Verify all sections are filled
- Verify all confirmations are checked

---

## Migration and Rollback Strategy

### General Migration Approach

1. **Small, Testable Changes**
   - Each refactor is a single focused change
   - Commit after each successful refactor
   - Green tests before commit

2. **Backward Compatibility**
   - All API changes are additive (new fields, new endpoints)
   - Existing exports preserved during refactoring
   - Deprecate old exports only after migration complete

3. **Feature Flags**
   - Use feature flags for new features:
     ```env
     SETRA_DEMO_MODE=true
     SETRA_REFUND_SCHEDULER_ENABLED=true
     ```
   - Allows disabling features for rollback

4. **Test Gates**
   - No change proceeds without green tests
   - Rollback immediately on test failure

### Rollback Procedures

**Scenario 1: Test Failure During Implementation**
- Use `git revert <commit>` to undo change
- Re-run tests to confirm rollback fixes issue
- Investigate failure before retrying

**Scenario 2: Post-Deployment Issue**
- Disable feature flag if applicable
- Deploy previous commit if necessary
- Use `git revert` for surgical rollback

**Scenario 3: Configuration Validation Breaks Startup**
- Bypass validation with: `SETRA_SKIP_CONFIG_VALIDATION=true`
- Fix configuration issue
- Re-enable validation

### Risk Mitigation

**High-Risk Changes:**
- Module refactoring (D2): Incremental, tested at each step
- Configuration validation (D3): Bypassable with flag
- Launcher (D4): Only affects dev environment, not production

**Low-Risk Changes:**
- Documentation (D11): No code changes
- MCP registry metadata (D9): No publication, no risk
- Health endpoint (D5): Read-only, no financial impact

---

## Explicitly Deferred

The following items are intentionally NOT implemented in Batch A:

1. **Frontend Visual Redesign** - Deferred to Batch B
2. **Phase 4C** - Not started
3. **Phase 4D** - Not started
4. **Remote MCP Implementation** - Implemented if safe, documented if not
5. **MCP Registry Publication** - Metadata prepared, not published
6. **Production Deployment** - Launcher is dev-only
7. **Provider Ecosystem Expansion** - Demo services only
8. **Performance Optimization** - Focus on correctness and usability
9. **Advanced Verification Levels** - Existing levels preserved
10. **Multi-Chain Support** - Solana only

---

## Summary

This design document specifies a safe, incremental productization approach that:

1. **Preserves Protocol Semantics** - All NON-NEGOTIABLE INVARIANTS maintained
2. **Improves Developer Experience** - Launcher, docs, centralized config
3. **Improves AI Agent Experience** - Enhanced MCP tool descriptions and service discovery
4. **Maintains Quality** - 727+ tests passing throughout
5. **Enables Future Work** - Metadata prepared for remote MCP and registry publication
6. **Documents Everything** - Comprehensive audit at completion

Each requirement (R1-R14) has a corresponding design section (D1-D14) explaining HOW it will be implemented, WHAT files are affected, and WHAT is explicitly deferred.

Implementation proceeds in the order specified, with test gates after each subsystem refactor.
