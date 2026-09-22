# Setra402: Autonomous AI Agent Treasury & Privacy Protocol

> Non-custodial micro-escrows, deterministic output verification, and unlinkable settlements for machine-to-machine HTTP 402 commerce on Solana[cite: 4].

---

## ⚡ The Problem

As autonomous AI agents scale, they purchase compute, data scraping, and API tool calls over HTTP 402 paywalls[cite: 4]. However, current Web3 machine payment rails suffer from two structural failures:
1. **Exposed Master Treasuries**: Standard on-chain payments permanently tie an enterprise's master wallet to every external API call, leaking capital reserves, operational cadence, and trading strategies[cite: 4].
2. **Pay-and-Pray Counterparty Risk**: Vanilla HTTP 402 lacks conditional custody. If a third-party worker server crashes or delivers corrupted data after receiving payment, the agent has zero financial recourse[cite: 4].

---

## 🛠️ The Solution

Setra402 introduces trustless, confidential micro-commerce to Solana[cite: 4]:
* **Program-Derived Vault Custody**: SPL tokens lock into program-owned vault PDAs before compute begins[cite: 5].
* **Autonomous Deterministic Verification**: Independent verifier agents re-evaluate deterministic task output hashes byte-for-byte before triggering on-chain release[cite: 5].
* **Unlinkable Settlements**: Blind vouchers decouple wallet identity from task execution, preventing observers from linking funding sources to API consumers[cite: 1, 4].

```
 BUYER AGENT                           SELLER GATEWAY                       SOLANA ESCROW (Anchor)
      │                                       │                                        │
      │── 1. POST /tasks/:id ────────────────>│                                        │
      │<─ 2. 402 Payment Required + Quote ────│                                        │
      │                                       │                                        │
      │── 3. initialize_task(task_id, amount, timeout, is_private) ───────────────────>│
      │      [Funds transfer Buyer ATA ──> Vault PDA]                                  │
      │                                       │                                        │
      │── 4. POST /tasks/:id (Funded) ───────>│                                        │
      │                                       │── 5. Query task_state PDA (Pending) ──>│
      │                                       │<─ 6. Live Account Confirmed ───────────│
      │                                       │                                        │
      │                                  [Compute Task]                                │
      │<─ 7. 200 OK + Output Hash ────────────│                                        │
      │                                       │                                        │
                         INDEPENDENT VERIFIER AGENT                                    │
                                              │                                        │
                                              │── 8. verify & settle_task() ──────────>│
                                              │      [99% Seller ATA / 1% Treasury]    │
                                              │      [Init 32-byte Nullifier PDA]      │
```
[cite: 1, 2, 5]

---

## 🔬 Core On-Chain Economics & Invariants

| Action | Authority / Signer | Mechanism & Fee Split |
| :--- | :--- | :--- |
| **Escrow Lock** | Buyer | Locks principal into `[b"vault", task_state]` PDA[cite: 5]. |
| **Settlement** | Designated Verifier | 99% payout to Seller ATA, 1% protocol fee to Treasury[cite: 1, 2, 4]. |
| **Voluntary Cancel** | Buyer | 95% refund to Buyer, 5% friction fee to Treasury (before deadline)[cite: 1, 2, 4]. |
| **SLA Timeout** | Buyer | 100% full principal refund to Buyer (after deadline expiry)[cite: 1, 2, 4]. |
| **Private Double-Spend** | Verifier / Nullifier | Replaying spent voucher reverts via on-chain `NullifierRecord` PDA collision[cite: 1, 2, 4]. |

---

## 🚦 System Status

| Component | Status | Details |
| :--- | :--- | :--- |
| **Anchor Program** | ✅ Built & Tested | 6/6 integration test scenarios passing on localnet[cite: 1, 2]. |
| **TypeScript Client SDK** | ✅ Built & Tested | End-to-end PDA buffer derivation and CPI transaction builder[cite: 2]. |
| **Facilitator Agent** | ✅ Built & Tested | Recursive canonical JSON sorting with SHA-256 deterministic verification[cite: 2, 5]. |
| **Seller Execution Engine**| 🟡 In Integration | HTTP 402 Axum gateway, raw RPC client, and blind-mint handler. |
| **Operator Console** | 🟡 In Development | Next.js / TailwindCSS dual-panel dashboard[cite: 4]. |

---

## 🧪 Local Testing & Verification

```bash
# 1. Install dependencies
yarn install

# 2. Run the 6/6 on-chain integration test suite
anchor test --skip-build
```
