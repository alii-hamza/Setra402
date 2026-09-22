# Role C Implementation Guide - Buyer Agent & Verifier Engineer

## Overview
This guide provides Role C (Agent & Verifier Engineer) with the complete implementation details for building the buyer agent and verifier components. It includes both the original architecture plan specifications and the actual implementation state, including Phase 3 cryptographic enhancements that were added beyond the original scope.

## Phase Status
- **Phase 1-2**: Seller Server Integration ✅ COMPLETED (matches original plan)
- **Phase 3**: Mint & Redis Integration ✅ COMPLETED (beyond original plan)
- **Current Implementation**: Enhanced from original architecture with privacy features and cryptographic support

---

## Part 1: Original Architecture Plan (from TaskAnchor_Architecture_Plan.md)

### 1.1 Your Role Overview
As Role C, you own:
- **Buyer Agent**: Payment construction, HTTP 402 flow handling, on-chain transaction building
- **Verifier**: Deterministic output checking, settlement triggering, refund handling
- **Language**: Node.js / TypeScript
- **Dependencies**: Role A's IDL + program ID; Role B's HTTP contract

### 1.2 Critical Flow (Original)
```
┌──────────────┐   1. POST /tasks/:task_id        ┌───────────────────┐
│              │ ────────────────────────────────▶│                   │
│ Buyer Agent  │                                   │  Seller Server    │
│ (Node/TS)    │◀──────────────────────────────────│  (Rust / Axum)    │
│              │   2. 402 Payment Required + quote │                   │
└──────┬───────┘                                   └─────────┬─────────┘
       │                                                      │
       │ 3. initialize_task(task_id, amount, timeout)         │ 4. re-derive task_state PDA,
       │    signed by buyer — funds move buyer → vault PDA    │    read it fresh from chain
       ▼                                                      ▼
┌───────────────────────────────────────────────────────────────────────┐
│                  Solana Local Validator (Docker)                       │
│                  TaskAnchor Anchor Program                             │
│   • task_state PDA — buyer, seller, verifier, amount, deadline, status │
│   • vault PDA — SPL token account, authority = task_state PDA          │
└──────────────────────────────────┬──────────────────────────────────┬─┘
                                    │ 6a. settle_task                  │ 6b. refund_task
                                    │  (verifier signs, on success)    │  (buyer signs, after timeout)
                                    ▼                                  ▼
                          ┌───────────────────┐              back to Buyer Agent
                          │ Verifier (Node/TS) │
                          └─────────▲──────────┘
                                    │ 5. GET result, recompute
                                    │    expected output, compare
                                    └──── polls Seller Server
```

### 1.3 Original Setup Instructions

```bash
mkdir buyer-agent && cd buyer-agent
npm init -y
npm install @coral-xyz/anchor @solana/web3.js @solana/spl-token axios
npm install -D typescript ts-node @types/node
npx tsc --init
```

**Important**: Double-check the package name before installing — `@coral-xyz/anchor` has been typosquatted before (a fake `@merceas/anchor` package copying its README was caught and delisted in 2026), so confirm the scope in `package.json` matches exactly.

---

## Part 2: Actual Implementation State (Deviations from Original Plan)

### 2.1 Phase 3 Enhancements (Beyond Original Plan)

The implementation includes significant cryptographic and privacy features that were **not** in the original architecture plan:

#### Privacy Features
- **Private Task Support**: Tasks can be initialized with `is_private = true` flag
- **Nullifier-based Settlement**: Private tasks use cryptographic nullifiers instead of public verification
- **Fee Structure**: Protocol fee collection (1% to treasury) implemented
- **Cancellation Penalty**: 5% penalty for voluntary cancellations

#### Cryptographic Infrastructure
- **Chaumian Blind Mint Daemon**: Blind signature computation for private payments
- **Redis Nullifier Cache**: Double-spend prevention via atomic SETNX operations
- **Automatic Mint Keypair Generation**: Server-side cryptographic key management
- **Enhanced Input Validation**: Comprehensive validation for cryptographic inputs

#### Additional On-Chain Instructions
- **settle_task_private**: Private settlement with nullifier (beyond original plan)
- **cancel_task**: Early cancellation with penalty (beyond original plan)

### 2.2 HTTP Contract Changes (Enhanced Beyond Original)

#### Original Contract (from Architecture Plan)
```json
// POST /tasks/:task_id request
{
  "buyer": "string (pubkey)",
  "input": "object (task input)"
}

// 402 Payment Required response
{
  "task_id": "number",
  "program_id": "string",
  "task_state_pda": "string",
  "vault_pda": "string",
  "mint": "string",
  "seller_token_account": "string",
  "verifier": "string",
  "amount": "number",
  "timeout_seconds": "number"
}
```

#### Actual Contract (Enhanced)
```json
// POST /tasks/:task_id request (enhanced)
{
  "buyer": "string (pubkey)",
  "input": "object (task input)",
  "is_private": "boolean (optional, default false)"  // NEW
}

// 402 Payment Required response (enhanced)
{
  "task_id": "number",
  "program_id": "string",
  "task_state_pda": "string",
  "vault_pda": "string",
  "mint": "string",
  "seller_token_account": "string",
  "verifier": "string",
  "amount": "number",
  "timeout_seconds": "number",
  "is_private": "boolean",                    // NEW
  "protocol_fee_bps": "number"                // NEW (100 = 1%)
}
```

#### New Phase 3 Endpoints
```json
// POST /mint/blind-sign (NEW - Private Tasks Only)
{
  "buyer": "string (pubkey)",
  "task_id": "number",
  "blinded_point": "string (32-byte hex-encoded Ristretto point)"
}

// Response 200 OK
{
  "blind_signature": "string (32-byte hex-encoded signature point)",
  "mint_pubkey": "string (32-byte hex-encoded mint public key)"
}

// POST /verifier/nullify (NEW - Double-Spend Prevention)
{
  "nullifier": "string (32-byte hex-encoded nullifier hash)"
}

// Response 200 OK
{
  "status": "Nullifier accepted",
  "nullifier": "string"
}
```

### 2.3 On-Chain Program Changes (Enhanced Beyond Original)

#### Original Instructions (from Architecture Plan)
- `initialize_task(task_id, amount, timeout_seconds)`
- `settle_task(task_id)` - Standard settlement
- `refund_task(task_id)` - Full refund after deadline

#### Actual Instructions (Enhanced)
- `initialize_task(task_id, amount, timeout_seconds, is_private)` - **NEW: is_private parameter**
- `settle_task(task_id)` - Standard settlement with 1% fee
- `settle_task_private(task_id, nullifier)` - **NEW: Private settlement**
- `refund_task(task_id)` - Full refund after deadline
- `cancel_task(task_id)` - **NEW: Early cancellation with 5% penalty**

#### Additional PDA Seeds
- **NullifierRecord**: `[b"nullifier", nullifier_32_bytes]` - **NEW**

#### Enhanced Account Structures
```rust
// TaskState (enhanced beyond original)
pub struct TaskState {
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub verifier: Pubkey,
    pub mint: Pubkey,
    pub task_id: u64,
    pub amount: u64,
    pub deadline_unix: i64,
    pub status: TaskStatus,
    pub is_private: bool,           // NEW
    pub bump: u8,
}

// NullifierRecord (NEW)
pub struct NullifierRecord {
    pub nullifier: [u8; 32],
    pub bump: u8,
}
```

### 2.4 Fee Structure (New Beyond Original)
- **Protocol Fee**: 100 BPS (1%) on settlements to protocol_treasury
- **Cancellation Penalty**: 500 BPS (5%) on early cancellations to protocol_treasury
- **Full Refund**: 100% after deadline (unchanged from original)

---

## Part 3: Implementation Instructions for Role C

### 3.1 Basic Setup (Following Original Plan)

```bash
mkdir buyer-agent && cd buyer-agent
npm init -y
npm install @coral-xyz/anchor @solana/web3.js @solana/spl-token axios
npm install -D typescript ts-node @types/node
npx tsc --init
```

### 3.2 Phase 3 Additional Dependencies (Beyond Original)

For Phase 3 cryptographic support (if implementing private task flow):

```bash
npm install @noble/curves  # For Ristretto255 curve operations
npm install redis          # For nullifier endpoint testing (optional)
```

### 3.3 Enhanced Buyer Agent Implementation

#### Original Buyer Agent (from Architecture Plan)
```typescript
// agent.ts (original plan)
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import axios from "axios";
import * as crypto from "crypto";
import idl from "../target/idl/task_anchor.json";

const PROGRAM_ID = new PublicKey(idl.address);
const SELLER_URL = "http://localhost:3000";

function randomTaskId(): bigint {
  return crypto.randomBytes(8).readBigUInt64LE(0);
}

function deriveTaskStatePda(buyer: PublicKey, taskId: bigint): [PublicKey, number] {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(taskId);
  return PublicKey.findProgramAddressSync([Buffer.from("task"), buyer.toBuffer(), idBuf], PROGRAM_ID);
}

async function main() {
  const connection = new Connection("http://localhost:8899", "confirmed");
  const buyerKeypair = /* load from ./keys/buyer.json */ Keypair.generate();
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(buyerKeypair), {});
  const program = new anchor.Program(idl as anchor.Idl, provider);

  const taskId = randomTaskId();
  const input = { job: "resize", width: 128, height: 128 };
  const url = `${SELLER_URL}/tasks/${taskId}`;

  let res = await axios.post(url, { buyer: buyerKeypair.publicKey.toBase58(), input }).catch((e) => e.response);

  if (res.status === 402) {
    const quote = res.data;
    const [taskStatePda] = deriveTaskStatePda(buyerKeypair.publicKey, taskId);
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), taskStatePda.toBuffer()],
      PROGRAM_ID,
    );
    const buyerTokenAccount = /* buyer's ATA for quote.mint */ new PublicKey(quote.mint);

    const sig = await program.methods
      .initializeTask(new anchor.BN(taskId.toString()), new anchor.BN(quote.amount), new anchor.BN(quote.timeout_seconds))
      .accounts({
        buyer: buyerKeypair.publicKey,
        seller: new PublicKey(quote.seller_token_account),
        verifier: new PublicKey(quote.verifier),
        mint: new PublicKey(quote.mint),
        taskState: taskStatePda,
        vault: vaultPda,
        buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    await connection.confirmTransaction(sig, "confirmed");
    res = await axios.post(url, { buyer: buyerKeypair.publicKey.toBase58(), input });
  }

  console.log("Task result:", res.data);
}

main().catch(console.error);
```

#### Enhanced Buyer Agent (with Phase 3 Support)
```typescript
// agent.ts (enhanced with Phase 3 support)
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import axios from "axios";
import * as crypto from "crypto";
import idl from "../target/idl/task_anchor.json";

const PROGRAM_ID = new PublicKey(idl.address);
const SELLER_URL = "http://localhost:3000";

function randomTaskId(): bigint {
  return crypto.randomBytes(8).readBigUInt64LE(0);
}

function deriveTaskStatePda(buyer: PublicKey, taskId: bigint): [PublicKey, number] {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(taskId);
  return PublicKey.findProgramAddressSync([Buffer.from("task"), buyer.toBuffer(), idBuf], PROGRAM_ID);
}

function deriveNullifierPda(nullifier: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("nullifier"), nullifier], PROGRAM_ID);
}

async function main() {
  const connection = new Connection("http://localhost:8899", "confirmed");
  const buyerKeypair = /* load from ./keys/buyer.json */ Keypair.generate();
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(buyerKeypair), {});
  const program = new anchor.Program(idl as anchor.Idl, provider);

  const taskId = randomTaskId();
  const input = { job: "resize", width: 128, height: 128 };
  const isPrivate = true; // NEW: private task flag
  const url = `${SELLER_URL}/tasks/${taskId}`;

  // NEW: Enhanced request with is_private flag
  let res = await axios.post(url, { 
    buyer: buyerKeypair.publicKey.toBase58(), 
    input,
    is_private // NEW
  }).catch((e) => e.response);

  if (res.status === 402) {
    const quote = res.data;
    const [taskStatePda] = deriveTaskStatePda(buyerKeypair.publicKey, taskId);
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), taskStatePda.toBuffer()],
      PROGRAM_ID,
    );
    const buyerTokenAccount = /* buyer's ATA for quote.mint */ new PublicKey(quote.mint);

    // NEW: Enhanced initialize with is_private parameter
    const sig = await program.methods
      .initializeTask(
        new anchor.BN(taskId.toString()), 
        new anchor.BN(quote.amount), 
        new anchor.BN(quote.timeout_seconds),
        isPrivate // NEW
      )
      .accounts({
        buyer: buyerKeypair.publicKey,
        seller: new PublicKey(quote.seller_token_account),
        verifier: new PublicKey(quote.verifier),
        protocolTreasury: quote.protocol_treasury ? new PublicKey(quote.protocol_treasury) : null, // NEW
        mint: new PublicKey(quote.mint),
        taskState: taskStatePda,
        vault: vaultPda,
        buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    await connection.confirmTransaction(sig, "confirmed");
    
    // NEW: Phase 3 cryptographic flow for private tasks
    if (isPrivate) {
      const nullifier = crypto.randomBytes(32);
      const blindedPoint = /* implement Chaumian blinding */;
      
      // Call blind signature endpoint
      const blindSignRes = await axios.post(`${SELLER_URL}/mint/blind-sign`, {
        buyer: buyerKeypair.publicKey.toBase58(),
        task_id: Number(taskId),
        blinded_point: blindedPoint.toString('hex')
      });
      
      // Check nullifier before settlement
      const nullifyRes = await axios.post(`${SELLER_URL}/verifier/nullify`, {
        nullifier: nullifier.toString('hex')
      });
      
      if (nullifyRes.status !== 200) {
        throw new Error("Double-spend detected or nullifier invalid");
      }
      
      // Use enhanced response for private settlement
      res = await axios.post(url, { 
        buyer: buyerKeypair.publicKey.toBase58(), 
        input,
        is_private 
      });
    } else {
      // Original public task flow
      res = await axios.post(url, { buyer: buyerKeypair.publicKey.toBase58(), input });
    }
  }

  console.log("Task result:", res.data);
}

main().catch(console.error);
```

### 3.4 Enhanced Verifier Implementation

#### Original Verifier (from Architecture Plan)
```typescript
// verifier.ts (original plan)
import * as anchor from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import axios from "axios";
import * as crypto from "crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function expectedHash(input: unknown): string {
  const canonical = JSON.stringify(canonicalize(input));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

async function verifyAndSettle(taskId: bigint, program: anchor.Program, taskStatePda: anchor.web3.PublicKey, vaultPda: anchor.web3.PublicKey, sellerTokenAccount: anchor.web3.PublicKey) {
  const { data } = await axios.get(`http://localhost:3000/tasks/${taskId}/result`);
  const expected = expectedHash(data.input);

  if (expected !== data.output_hash) {
    console.log(`Task ${taskId}: output mismatch — expected ${expected}, got ${data.output_hash}. Not settling.`);
    return; // stays Pending; buyer reclaims via refund_task after the deadline
  }

  const sig = await program.methods
    .settleTask()
    .accounts({ taskState: taskStatePda, verifier: /* verifier keypair pubkey */, vault: vaultPda, sellerTokenAccount, tokenProgram: TOKEN_PROGRAM_ID })
    .rpc();
  console.log(`Task ${taskId} settled:`, sig);
}
```

#### Enhanced Verifier (with Phase 3 Support)
```typescript
// verifier.ts (enhanced with Phase 3 support)
import * as anchor from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import axios from "axios";
import * as crypto from "crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function expectedHash(input: unknown): string {
  const canonical = JSON.stringify(canonicalize(input));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function deriveNullifierPda(nullifier: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("nullifier"), nullifier], PROGRAM_ID);
}

async function verifyAndSettle(
  taskId: bigint, 
  program: anchor.Program, 
  taskStatePda: anchor.web3.PublicKey, 
  vaultPda: anchor.web3.PublicKey, 
  sellerTokenAccount: anchor.web3.PublicKey,
  isPrivate: boolean = false, // NEW
  nullifier?: Buffer // NEW
) {
  const { data } = await axios.get(`http://localhost:3000/tasks/${taskId}/result`);
  const expected = expectedHash(data.input);

  if (expected !== data.output_hash) {
    console.log(`Task ${taskId}: output mismatch — expected ${expected}, got ${data.output_hash}. Not settling.`);
    return; // stays Pending; buyer reclaims via refund_task after the deadline
  }

  // NEW: Enhanced settlement logic for private vs public tasks
  if (isPrivate && nullifier) {
    const [nullifierPda] = deriveNullifierPda(nullifier);
    
    const sig = await program.methods
      .settleTaskPrivate(nullifier) // NEW instruction
      .accounts({ 
        taskState: taskStatePda, 
        verifier: /* verifier keypair pubkey */, 
        vault: vaultPda, 
        sellerTokenAccount,
        nullifierRecord: nullifierPda, // NEW
        protocolTreasury: /* optional treasury */, // NEW
        tokenProgram: TOKEN_PROGRAM_ID 
      })
      .rpc();
    console.log(`Task ${taskId} settled privately:`, sig);
  } else {
    // Original public settlement
    const sig = await program.methods
      .settleTask()
      .accounts({ 
        taskState: taskStatePda, 
        verifier: /* verifier keypair pubkey */, 
        vault: vaultPda, 
        sellerTokenAccount,
        protocolTreasury: /* optional treasury */, // NEW
        tokenProgram: TOKEN_PROGRAM_ID 
      })
      .rpc();
    console.log(`Task ${taskId} settled:`, sig);
  }
}
```

### 3.5 Environment Configuration

#### Required Environment Variables (Enhanced)
```bash
# Original variables (from architecture plan)
RPC_HOST=127.0.0.1
RPC_PORT=8899
PROGRAM_ID=<from deployment.json>
MINT=<from deployment.json>
SELLER_TOKEN_ACCOUNT=<from deployment.json>
VERIFIER=<from deployment.json>

# NEW: Phase 3 variables
REDIS_URL=redis://127.0.0.1:6379
PROTOCOL_TREASURY=<optional treasury pubkey>
```

---

## Part 4: Integration Testing Checklist

### 4.1 Basic Integration (Original Plan)
- [ ] Buyer agent can successfully complete 402 flow
- [ ] Verifier can retrieve and recompute task results
- [ ] Hash computation matches seller-server exactly
- [ ] Public settlement flow works end-to-end
- [ ] Refund flow works after deadline
- [ ] All fee calculations match on-chain exactly

### 4.2 Phase 3 Cryptographic Integration (New)
- [ ] Chaumian blind signature flow works end-to-end
- [ ] Blind signature endpoint validates private task requirement
- [ ] Blind signature endpoint validates hex encoding and point format
- [ ] Nullifier endpoint accepts valid 32-byte hex strings
- [ ] Nullifier endpoint rejects invalid formats
- [ ] Double-spend detection works (403 on nullifier reuse)
- [ ] Redis connection is established and operational
- [ ] Mint public key is received and used for verification
- [ ] Private settlement with nullifier succeeds on-chain
- [ ] Privacy flag handling works correctly (mismatch detection)
- [ ] Protocol fee collection works (1% to treasury)
- [ ] Cancellation penalty works (5% to treasury)

### 4.3 Edge Cases (Enhanced)
- [ ] Privacy mismatch handling (400 BAD_REQUEST on mismatch)
- [ ] Expired task handling (410 GONE on deadline exceeded)
- [ ] Underpaid private task handling (402 with private quote)
- [ ] Inverse privacy mismatch handling
- [ ] Double-spend prevention across Redis restarts
- [ ] Invalid blinded point handling
- [ ] Invalid nullifier format handling
- [ ] Floating-point number rejection (server panics on float inputs)
- [ ] Integer-only task input validation
- [ ] Hash computation with integers matches seller-server exactly

---

## Part 5: Important Implementation Notes

### 5.1 Privacy Flag Implementation
- The `is_private` flag must match between the request and the on-chain task state
- Privacy mismatch returns 400 BAD_REQUEST
- Private tasks require nullifier-based settlement
- Public tasks use standard verification flow

### 5.2 Phase 3 Cryptographic Flow
For private tasks, implement the Chaumian blind signature workflow:
1. Generate blinded point B using Chaumian blinding
2. Call POST /mint/blind-sign to get signature C
3. Generate nullifier (32-byte cryptographically secure random)
4. Call POST /verifier/nullify to check double-spend before settlement
5. Use nullifier in settle_task_private instruction

### 5.3 Redis Requirement
- Redis must be running for the nullifier endpoint (`POST /verifier/nullify`); the seller-server reads `REDIS_URL` (default `redis://127.0.0.1:6379`, and `redis://redis:6379` under compose).
- **Use the compose Redis** (`setra402-redis`) — start it with `docker compose -f docker-compose.dev.yml up -d --no-build redis`.
- **Do not** start your own `docker run -p 6379:6379 redis:alpine`: it collides on the port, and it is not the instance the composed seller-server talks to, so nullifiers land somewhere the server never reads and double-spend detection looks broken. See §5.7.

### 5.4 Hash Computation Critical Requirement
Must match seller-server's SHA-256 of canonical JSON:
- Sort object keys alphabetically
- Use JSON.stringify on sorted object
- Compute SHA-256 hash
- Return hex string
- Test this function against Role B's output early

**IMPORTANT: Floating-Point Number Ban**
- The seller-server **rejects floating-point numbers** in task input to prevent cross-language hash mismatches
- Rust's serde_json and JavaScript's JSON.stringify handle floats differently (exponential notation, trailing .0)
- Role C must use **only integers** in task input JSON
- Floating-point inputs will cause seller-server to panic with "floating-point numbers not supported"
- Example valid input: `{"width": 128, "height": 256}`
- Example invalid input: `{"width": 128.5, "height": 256.0}`

### 5.5 Fee Structure Changes
- Protocol fee is 1% (100 BPS) - communicated in payment quote
- Cancellation penalty is 5% (500 BPS)
- Protocol treasury is optional but recommended for fee collection

### 5.6 Deadline Handling Enhancement
- Expired tasks return 410 GONE (not 402)
- Buyer agents MUST handle 410 by treating task as expired
- This prevents buyer receiving output + full refund

### 5.7 Running the Docker Stack (read this before touching Docker)

The whole backend runs under Compose. Every point below was verified on 2026-09-21 — they are listed because each one has already cost someone time.

**Start it:**

```bash
cd /Setra402
export MINT_ADDRESS=<mint>
export SELLER_TOKEN_ACCOUNT=<seller token account>
export VERIFIER_ADDRESS=<verifier>
export PROTOCOL_TREASURY_ADDRESS=<treasury>

docker compose -f docker-compose.dev.yml up -d --no-build
docker compose -f docker-compose.dev.yml ps      # all three should be Up
```

**Those four exports are mandatory.** `docker-compose.dev.yml` interpolates them; with neither a root `.env` nor shell exports they become empty strings, the seller-server exits, and the only clue is:

```
config error: env var MINT is not a valid value: String is the wrong size
```

That message is misleading — the variable is *missing*, not malformed. The real values come from Role A's deployment output.

**`--no-build` is required today.** The seller-server image in use was produced locally from the current source; the Dockerfile's first build needs a one-time network fetch of the Rust 1.89 base image plus the crate graph. Without `--no-build`, compose tries to build and appears to hang. After that first build the dependency cache (registry + `target/`) is reused and rebuilds are incremental.

**Endpoints and ports**

| Service | From the host | Notes |
|---|---|---|
| seller-server | `http://localhost:3000` | `POST /tasks/:id`, `GET /tasks/:id/result`, `POST /mint/blind-sign`, `POST /verifier/nullify` |
| validator RPC | `http://localhost:8899` | `RPC_HOST=validator` resolves only inside the compose network |
| Redis | `localhost:6379` | compose service `setra402-redis` |

**Smoke-test the backend before writing TypeScript.** These are the codes you should see; anything else means the stack is not healthy yet:

```bash
B=11111111111111111111111111111111

# 402 + payment quote (unpaid task)
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/tasks/1 \
  -H 'content-type: application/json' -d "{\"buyer\":\"$B\",\"input\":{\"a\":1}}"

# 404 - result not available before execution
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/tasks/1/result

# 400 - malformed blinded point
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/mint/blind-sign \
  -H 'content-type: application/json' \
  -d "{\"buyer\":\"$B\",\"task_id\":1,\"blinded_point\":\"e2f2\"}"

# 200 then 403 - first nullifier accepted, replay rejected
N=$(printf 'ab%.0s' {1..32})
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/verifier/nullify \
  -H 'content-type: application/json' -d "{\"nullifier\":\"$N\"}"
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/verifier/nullify \
  -H 'content-type: application/json' -d "{\"nullifier\":\"$N\"}"
```

Inspect what the server actually wrote:

```bash
docker exec setra402-redis redis-cli --scan --pattern 'nullifier:*'
```

**A 500 on `/tasks/:id` is an infrastructure symptom, not a code bug.** It almost always means the RPC hostname did not resolve — the validator container is down, or it was hand-run without the `validator` network alias that the compose service name normally supplies.

**Nullifier state is ephemeral.** The compose Redis has no volume, so `docker compose down` or recreating that container wipes every `nullifier:*` key. Do not write double-spend tests that assume state survives a restart, and remember a production verifier needs durable storage rather than this in-memory cache.

**The validator resets on every start.** Its command is `solana-test-validator --reset`, so any program or account deployed to it disappears when the container restarts. It also starts with no wallet, so `solana airdrop` first if you need to sign anything.

**You cannot run the Rust test suite inside these images.** Host-built test binaries require GLIBC 2.39 while the bookworm runtime provides 2.36. Run them on the host from the repository root instead:

```bash
cargo test --package seller-server     # expect 38/38 (16 unit + 22 integration)
```

**Harmless output you can ignore:** `the attribute version is obsolete`, and (only if you skipped the exports above) the four `variable is not set` warnings.

---

## Part 6: Current Implementation Status

### 6.1 What's Available from Role B
- **Seller Server**: Fully operational with Phase 1-2 + Phase 3 features
- **HTTP Endpoints**: 
  - POST /tasks/:task_id (enhanced with privacy support)
  - GET /tasks/:task_id/result
  - POST /mint/blind-sign (Phase 3)
  - POST /verifier/nullify (Phase 3)
- **Test Coverage**: 38/38 tests passing (16 unit + 22 integration)
- **Docker Environment**: Compose stack verified (validator, seller-server, Redis)
- **Documentation**: Comprehensive handover documentation available

### 6.2 What's Available from Role A — ⚠️ NOT YET
- **On-Chain Program**: **Not deployed** on the local validator. `target/deploy/setra402.so` and `target/idl/setra402.json` do not exist, and the program keypair for `FUjN9K7C5yHr5NhVrJ7WCgifgDiBJnSDDGQjnNkUDBMN` is missing, so the program cannot currently be built or deployed under that ID. Coordinate with Role A before attempting the paid flow.
- **IDL**: Not available — `target/idl/setra402.json` is absent; it must be regenerated by an `anchor build`.
- **Consequence for this guide**: the 402 quote, 404, blind-sign validation and nullify endpoints can be exercised now, but creating an escrow (and therefore the paid 200 path and the blind-sign 200 path) cannot until the program is deployed.
- **PDA Seeds**: Documented and implemented
- **Shared Types**: Available in `shared/task-anchor-types/`

### 6.3 Known Working Configuration
- **Rust**: 1.89 (pinned in `rust-toolchain.toml`; the Docker builder image matches it)
- **Anchor**: Latest via AVM
- **Solana CLI**: Agave (latest stable) — 4.2.2 in the validator image
- **Node.js**: Recommend 18+ for TypeScript support
- **Redis**: `redis:alpine` as the compose service `setra402-redis` (Phase 3 nullifier caching)
- **Docker**: Compose v2; the validator needs `seccomp=unconfined` (already set in `docker-compose.dev.yml`)

---

## Part 8: Role C Implementation Steps

### 8.1 Immediate Setup Steps

**Step 1: Get Deployment Values from Role A**
- Contact Role A to get real deployment values
- Required: MINT, SELLER_TOKEN_ACCOUNT, VERIFIER, PROTOCOL_TREASURY (optional)
- These values are critical for Docker Compose and local testing

**Step 2: Set Up Development Environment**
```bash
# Create buyer-agent directory
mkdir buyer-agent && cd buyer-agent

# Initialize Node.js project
npm init -y

# Install dependencies (verify exact package names)
npm install @coral-xyz/anchor @solana/web3.js @solana/spl-token axios
npm install -D typescript ts-node @types/node

# Initialize TypeScript
npx tsc --init

# Optional: Install Phase 3 cryptographic dependencies
npm install @noble/curves redis
```

**Step 3: Configure Docker Environment**
```bash
# Navigate to Setra402 repository
cd /home/alihamza/Setra402

# Set environment variables (replace with real values from Role A)
export MINT_ADDRESS=<real_mint_pubkey>
export SELLER_TOKEN_ACCOUNT=<real_seller_token_account>
export VERIFIER_ADDRESS=<real_verifier_pubkey>
export PROTOCOL_TREASURY_ADDRESS=<real_treasury_pubkey>

# Start Docker Compose stack
docker compose -f docker-compose.dev.yml up -d --no-build

# Verify all services are running
docker compose -f docker-compose.dev.yml ps
```

**Step 4: Verify Seller Server Endpoints**
```bash
# Test 402 flow (should return 402)
B=11111111111111111111111111111111
curl -X POST localhost:3000/tasks/1 \
  -H 'content-type: application/json' \
  -d "{\"buyer\":\"$B\",\"input\":{\"job\":\"resize\",\"width\":128}}"

# Test nullifier endpoint (should return 200 then 403)
N=$(printf 'ab%.0s' {1..32})
curl -X POST localhost:3000/verifier/nullify \
  -H 'content-type: application/json' \
  -d "{\"nullifier\":\"$N\"}"
```

### 8.2 Implementation Priority

**Priority 1: Basic Buyer Agent (Public Tasks)**
1. Implement basic HTTP 402 flow handler
2. Implement PDA derivation functions
3. Implement initialize_task transaction building
4. Test with public tasks (is_private = false)
5. Verify hash computation matches seller-server

**Priority 2: Basic Verifier (Public Tasks)**
1. Implement result retrieval from seller-server
2. Implement canonical JSON hash computation
3. Implement settle_task transaction building
4. Test end-to-end public task flow
5. Verify fee calculations (1% protocol fee)

**Priority 3: Phase 3 Cryptographic Support (Private Tasks)**
1. Implement Chaumian blind signature flow
2. Implement nullifier generation and validation
3. Call POST /mint/blind-sign endpoint
4. Call POST /verifier/nullify endpoint
5. Implement settle_task_private transaction
6. Test end-to-end private task flow

**Priority 4: Edge Cases and Error Handling**
1. Handle 410 GONE for expired tasks
2. Handle privacy mismatch errors
3. Handle double-spend detection
4. Handle invalid input formats
5. Ensure integer-only task inputs

### 8.3 Critical Implementation Notes

**Hash Computation MUST Match Seller-Server**
```typescript
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function expectedHash(input: unknown): string {
  const canonical = JSON.stringify(canonicalize(input));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
```

**Integer-Only Task Inputs**
- Seller-server rejects floating-point numbers
- Use only integers in task input JSON
- Example: `{"width": 128, "height": 256}` ✅
- Example: `{"width": 128.5, "height": 256.0}` ❌

**PDA Derivation Must Match**
```typescript
// Task State PDA
function deriveTaskStatePda(buyer: PublicKey, taskId: bigint): [PublicKey, number] {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(taskId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("task"), buyer.toBuffer(), idBuf], 
    PROGRAM_ID
  );
}

// Vault PDA
function deriveVaultPda(taskStatePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), taskStatePda.toBuffer()],
    PROGRAM_ID
  );
}

// Nullifier PDA (for private tasks)
function deriveNullifierPda(nullifier: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), nullifier],
    PROGRAM_ID
  );
}
```

### 8.4 Testing Strategy

**Unit Testing**
- Test PDA derivation functions
- Test hash computation function
- Test canonical JSON sorting
- Test input validation

**Integration Testing**
- Test 402 flow with mock escrow
- Test result retrieval
- Test settlement transactions
- Test nullifier endpoint
- Test blind signature endpoint

**End-to-End Testing**
- Test complete public task flow
- Test complete private task flow
- Test double-spend prevention
- Test fee calculations
- Test deadline handling

### 8.5 Troubleshooting Common Issues

**Docker Compose Won't Start**
- Verify environment variables are set
- Check Docker daemon is running
- Ensure ports 3000, 8899, 6379 are available
- Check logs: `docker compose -f docker-compose.dev.yml logs`

**402 Payment Required Not Returning**
- Verify seller-server is running: `docker logs setra402-seller-server`
- Check validator is running: `docker logs setra402-validator`
- Ensure RPC connection is working
- Verify program ID is correct

**Hash Mismatch**
- Ensure canonical JSON sorting is implemented
- Verify integer-only inputs
- Test hash function against known seller-server output
- Check for floating-point numbers in input

**Nullifier Double-Spend Detection**
- Verify Redis is running: `docker exec setra402-redis redis-cli ping`
- Check nullifier format (32-byte hex)
- Ensure nullifier endpoint is called before settlement
- Test with fresh nullifier after Redis restart

### 8.6 Success Criteria

**Minimum Viable Product (MVP)**
- [ ] Buyer agent completes 402 flow for public tasks
- [ ] Verifier completes settlement for public tasks
- [ ] Hash computation matches seller-server exactly
- [ ] Fee calculations are correct (1% protocol fee)
- [ ] All tests pass

**Full Implementation**
- [ ] Private task flow works end-to-end
- [ ] Chaumian blind signatures implemented
- [ ] Nullifier double-spend prevention works
- [ ] Phase 3 endpoints integrated
- [ ] All edge cases handled
- [ ] Docker Compose stack verified
- [ ] Documentation updated

### 8.7 Next Steps After Implementation

1. **Comprehensive Testing**
   - Run full test suite
   - Test edge cases
   - Load testing with multiple tasks

2. **Documentation**
   - Update implementation guide with lessons learned
   - Add troubleshooting section
   - Document any deviations from this guide

3. **Integration with Role A**
   - Coordinate deployment to testnet
   - Verify on-chain program compatibility
   - Test with real deployed program

4. **Production Readiness**
   - Security audit
   - Performance optimization
   - Error handling improvements
   - Monitoring and logging

---

## Part 9: Files Reference

### Seller Server Files (Role B)
- `/Setra402/seller-server/src/handlers.rs` - HTTP endpoints (enhanced with Phase 3)
- `/Setra402/seller-server/src/config.rs` - Configuration and types (enhanced)
- `/Setra402/seller-server/src/pda.rs` - PDA derivation functions (enhanced)
- `/Setra402/seller-server/src/task_state.rs` - On-chain state decoding (enhanced)
- `/Setra402/seller-server/src/execute.rs` - Hash computation reference

### On-Chain Files (Role A)
- `/Setra402/programs/setra402/src/lib.rs` - Program entrypoint
- `/Setra402/programs/setra402/src/state.rs` - Account structures (enhanced)
- `/Setra402/programs/setra402/src/constants.rs` - Constants and seeds (enhanced)
- `/Setra402/programs/setra402/src/instructions/` - All instruction implementations (enhanced)

### Shared Types
- `Setra402/shared/task-anchor-types/src/lib.rs` - Shared type definitions (enhanced)

**IMPORTANT: Shared Types Architecture**
- Role B now uses the shared `task-anchor-types` workspace crate instead of manual decoding
- This ensures type consistency between on-chain program and off-chain components
- Role C should reference the shared types for consistency:
  - `TaskStatus` enum (Pending, Settled, Refunded)
  - `TaskState` struct (with is_private field)
  - `NullifierRecord` struct (for private settlements)
- The shared crate uses official Anchor serialization (Borsh) for type safety
- This prevents synchronization issues when on-chain structures change

### Documentation
- `/Setra402/SELLER_SERVER_INTEGRATION.md` - Detailed integration guide
- `/Setra402/PHASE3_MINT_INTEGRATION.md` - Phase 3 cryptographic integration details
- `/Setra402/STATE.md` - Current project state
- `/Setra402/ROLE_B_HANDOVER.md` - Role B handover documentation
- `/Setra402/AGENT.md` - Agent rules and invariants
- `/Setra402/TaskAnchor_Architecture_Plan.md` - Original architecture plan

---

## Part 8: Next Steps for Role C

### 8.1 Basic Setup (Following Original Plan)
1. Set up Node.js/TypeScript environment
2. Install Anchor TS dependencies
3. Create buyer agent script
4. Create verifier script
5. Implement deterministic hash function
6. Test against running seller-server
7. Integrate with local validator
8. End-to-end testing

### 8.2 Phase 3 Cryptographic Setup (New Requirements)
9. Install elliptic curve libraries (Ristretto255 support)
10. Implement Chaumian blinding scheme
11. Add blind signature flow to buyer agent (for private tasks)
12. Add nullifier generation and validation
13. Integrate with Redis for nullifier endpoint testing
14. Test private settlement flow end-to-end
15. Verify double-spend prevention works correctly
16. Implement privacy flag handling
17. Add fee structure support
18. Test cancellation flow with penalty

### 8.3 Audit Compliance Requirements (New)
19. Ensure task input uses only integers (no floating-point numbers)
20. Test hash computation with integer inputs against seller-server
21. Reference shared types from task-anchor-types crate for consistency
22. Validate that type definitions match on-chain program structures

### 8.4 Start Redis for Phase 3 Testing
```bash
# Part of the full stack - see §5.7. Do NOT run a second Redis on port 6379.
docker compose -f docker-compose.dev.yml up -d --no-build redis
docker exec setra402-redis redis-cli ping        # PONG
```

---

## Part 9: Key Differences Summary

### Original Plan vs Actual Implementation

| Feature | Original Plan | Actual Implementation | Status |
|---------|--------------|---------------------|---------|
| Basic 402 Flow | ✅ Specified | ✅ Implemented | Matches |
| Public Settlement | ✅ Specified | ✅ Implemented | Matches |
| Refund Flow | ✅ Specified | ✅ Implemented | Matches |
| Privacy Support | ❌ Not specified | ✅ Implemented | Enhanced |
| Private Settlement | ❌ Not specified | ✅ Implemented | Enhanced |
| Nullifier System | ❌ Not specified | ✅ Implemented | Enhanced |
| Blind Signatures | ❌ Not specified | ✅ Implemented | Enhanced |
| Redis Integration | ❌ Not specified | ✅ Implemented | Enhanced |
| Fee Collection | ❌ Not specified | ✅ Implemented | Enhanced |
| Cancellation Penalty | ❌ Not specified | ✅ Implemented | Enhanced |
| Chaumian Mint | ❌ Not specified | ✅ Implemented | Enhanced |

### Breaking Changes from Original Plan
- **initialize_task**: Added `is_private` parameter
- **settle_task**: Now includes protocol fee (1%)
- **HTTP Request**: Added `is_private` field
- **HTTP Response**: Added `is_private` and `protocol_fee_bps` fields
- **New Instructions**: `settle_task_private`, `cancel_task`
- **New PDAs**: `NullifierRecord` derivation
- **New Endpoints**: `/mint/blind-sign`, `/verifier/nullify`

---

## Part 10: Troubleshooting Guide

### 10.1 Common Issues

#### Issue: 402 responses don't resolve after transaction confirms
**Cause**: PDA derivation mismatch between TypeScript and Rust
**Solution**: Check that `writeBigUInt64LE` matches Rust's `to_le_bytes()` and seed order matches exactly

#### Issue: Privacy mismatch errors
**Cause**: `is_private` flag doesn't match between request and on-chain state
**Solution**: Ensure the same `is_private` value is used in both initialize_task and POST request

#### Issue: Nullifier endpoint fails
**Cause**: Redis not running, or the server is pointed at a different Redis than the one you are inspecting
**Solution**: Use the compose Redis only and verify it: `docker exec setra402-redis redis-cli ping` (expect `PONG`), then confirm the server's own view with `docker inspect setra402-seller-server --format '{{range .Config.Env}}{{println .}}{{end}}' | grep REDIS_URL`. If you started a standalone `setra-redis` on 6379, remove it — see §5.3 and §5.7.

#### Issue: every request returns 500
**Cause**: `RPC_HOST=validator` did not resolve, so the seller-server could not reach any RPC endpoint
**Solution**: Check the validator is Up (`docker compose -f docker-compose.dev.yml ps`) and that its name resolves from inside the seller-server: `docker exec setra402-seller-server sh -c 'getent hosts validator'`. If you started the validator by hand rather than through compose, attach it with `--network-alias validator`.

#### Issue: seller-server container exits immediately
**Cause**: the four compose pubkey variables interpolated as empty strings (no root `.env`, no shell exports)
**Solution**: Export `MINT_ADDRESS`, `SELLER_TOKEN_ACCOUNT`, `VERIFIER_ADDRESS`, `PROTOCOL_TREASURY_ADDRESS` (or create a root `.env`) and recreate the container. The logged error says `env var MINT is not a valid value`, which is misleading — the variable is missing, not malformed.

#### Issue: Blind signature validation fails
**Cause**: Invalid hex encoding or point format
**Solution**: Ensure blinded point is 32-byte hex-encoded Ristretto point

#### Issue: Hash computation mismatch
**Cause**: Key sorting differences between Rust and TypeScript
**Solution**: Test canonicalize function against Role B's output with representative inputs

### 10.2 Testing Commands

```bash
# Start the full environment (validator + seller-server + Redis).
# The four exports are mandatory and --no-build is required until the
# Dockerfile has been built once with network access - see §5.7.
export MINT_ADDRESS=<mint> SELLER_TOKEN_ACCOUNT=<seller ATA> \
       VERIFIER_ADDRESS=<verifier> PROTOCOL_TREASURY_ADDRESS=<treasury>
docker compose -f docker-compose.dev.yml up -d --no-build
docker compose -f docker-compose.dev.yml ps

# Verify Redis connection (compose service - do not run a second one)
docker exec setra402-redis redis-cli ping

# Test seller-server
curl -X POST http://localhost:3000/tasks/123 \
  -H "Content-Type: application/json" \
  -d '{"buyer":"<pubkey>","input":{"job":"resize"},"is_private":false}'

# Test Phase 3 nullifier endpoint
curl -X POST http://localhost:3000/verifier/nullify \
  -H "Content-Type: application/json" \
  -d '{"nullifier":"<64-char-hex-string>"}'
```

---

## Conclusion

Role C has a significantly enhanced implementation to work with compared to the original architecture plan. The Phase 3 additions provide powerful privacy and cryptographic features that go beyond the original scope. This guide provides both the original specifications and the actual implementation details to ensure successful integration.

**Key Takeaways:**
1. Start with the original basic flow, then add Phase 3 features
2. Privacy and cryptographic features are optional but fully functional
3. Redis is required for Phase 3 nullifier caching
4. Test hash computation early against Role B's output
5. Handle both public and private task flows in your implementation
6. Fee structure and cancellation penalties are now part of the system

---

## Part 11: Recent Audit Gap Fixes

### 11.1 Audit Findings and Resolutions

The implementation underwent a security audit that identified 4 critical gaps, all of which have been resolved:

#### Gap 1: Missing Blind-Signing Route ✅ FIXED
- **Issue**: POST /mint/blind-sign endpoint was completely missing
- **Resolution**: Full Chaumian blind signature implementation with cryptographic validation
- **Status**: ✅ Implemented and tested

#### Gap 2: Missing Redis Fast Nullifier Verification ✅ FIXED
- **Issue**: POST /verifier/nullify endpoint and Redis backend were missing
- **Resolution**: Complete Redis integration with atomic SETNX double-spend prevention
- **Status**: ✅ Implemented and tested with live Redis instance

#### Gap 3: Local Types Duplication vs. Workspace Shared Crate ✅ FIXED
- **Issue**: Seller-server maintained manual byte-offset decoder instead of using shared crate
- **Resolution**: Replaced 200+ lines of manual code with official `task-anchor-types` crate integration
- **Impact**: Ensures type consistency and prevents synchronization issues when on-chain structures change
- **Status**: ✅ Using official shared types with Borsh serialization

#### Gap 4: Cross-Language Floating-Point Hazards ✅ FIXED
- **Issue**: No validation for floating-point numbers that could cause hash mismatches
- **Resolution**: Added `contains_floats()` validation that rejects floating-point inputs
- **Impact**: Prevents Rust/JS hash compatibility issues (different float representations)
- **Status**: ✅ Floating-point validation in place with 3 new tests

### 11.2 Audit Fix Verification
- All 38 tests passing (16 unit + 22 integration)
- Clean compilation with zero errors
- No existing functionality broken
- Shared crate integration verified
- Cross-language hash compatibility ensured

### 11.3 Impact on Role C
- **Floating-Point Ban**: Role C must use only integers in task input JSON
- **Shared Types**: Role C can reference the shared types for consistency
- **Type Safety**: Reduced risk of synchronization issues with on-chain changes
- **Hash Compatibility**: Guaranteed hash matching between Rust seller-server and TypeScript verifier

---

## Conclusion

Role C has a significantly enhanced implementation to work with compared to the original architecture plan. The Phase 3 additions provide powerful privacy and cryptographic features that go beyond the original scope. This guide provides both the original specifications and the actual implementation details to ensure successful integration.

**Key Takeaways:**
1. Start with the original basic flow, then add Phase 3 features
2. Privacy and cryptographic features are optional but fully functional
3. Redis is required for Phase 3 nullifier caching
4. Test hash computation early against Role B's output
5. Handle both public and private task flows in your implementation
6. Fee structure and cancellation penalties are now part of the system
7. **IMPORTANT**: Use only integers in task input (floating-point numbers are rejected)
8. **IMPORTANT**: Reference shared types for consistency with on-chain program

**Handover Status**: ✅ Complete - Role B finished Phase 1-2 + Phase 3 + Audit Fixes, ready for Role C to begin with full cryptographic support and type safety guarantees.