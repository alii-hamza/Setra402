# Role C Implementation Guide — Buyer Agent, Verifier & 2-Screen Frontend

## Overview & Verified System Baseline
This document provides Role C (Agent, Verifier & Frontend Engineer) with the complete implementation details for building the autonomous buyer agent, deterministic verifier, and the 2-screen hackathon presentation UI.

- **Role A (On-Chain Solana Escrow)**: ✅ COMPLETED & DEPLOYED
  - Program ID: `FUjN9K7C5yHr5NhVrJ7WCgifgDiBJnSDDGQjnNkUDBMN`
  - Deployed Transaction: `4zpPbJZgwRVe98gb2KncWnaCeoqEE7pAEWAW5WS6emHRzu4y9D7YYLtimdXr2NxGQpXuj7TVUB7JsAQPLG8MFtbX`
  - IDL Path: `target/idl/setra402.json` (compiled and published)
  - Anchor Test Status: 6/6 tests passing (Public settlement, 99/1 fee split, 95/5 cancellation penalty, private settlement with NullifierRecord PDA, timeout refund, double-spend collision)
- **Role B (Axum Seller Server & Mint Daemon)**: ✅ COMPLETED & VERIFIED
  - Server URL: `http://localhost:3000`[cite: 1, 2]
  - Endpoints: `POST /tasks/:id`, `GET /tasks/:id/result`, `POST /mint/blind-sign`, `POST /verifier/nullify`[cite: 1, 2, 3]
  - Test Suite: 38/38 passing (16 unit + 22 integration)
  - Data Guard: Floating-point numbers strictly rejected in JSON inputs to ensure cross-language deterministic SHA-256 hashing

---

## 1. Shared Protocol Invariants & PDA Derivation

### PDA Seed Derivation Rules
```typescript
import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("FUjN9K7C5yHr5NhVrJ7WCgifgDiBJnSDDGQjnNkUDBMN");

// 1. TaskState PDA: [b"task", buyer_pubkey, task_id_u64_le]
export function deriveTaskStatePda(buyer: PublicKey, taskId: bigint): [PublicKey, number] {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(taskId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("task"), buyer.toBuffer(), idBuf],
    PROGRAM_ID
  );
}

// 2. Vault PDA: [b"vault", task_state_pubkey]
export function deriveVaultPda(taskStatePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), taskStatePda.toBuffer()],
    PROGRAM_ID
  );
}

// 3. Nullifier Record PDA: [b"nullifier", eta_32_bytes]
export function deriveNullifierPda(eta: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), eta],
    PROGRAM_ID
  );
}

//Fee InvariantsProtocol Settlement Fee:
//100 BPS (1.0% to protocol treasury; 99.0% to seller)   Voluntary Cancellation Penalty: 500 BPS (5.0% to protocol treasury; 95.0% refund to buyer)   
//SLA Timeout Refund: 100% of principal back to buyer after deadline_unix expiration   
