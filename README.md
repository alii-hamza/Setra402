# Setra402
### Autonomous AI Agent Treasury & Privacy Protocol

**Non-custodial micro-escrows, deterministic output verification, and privacy-oriented settlement infrastructure for machine-to-machine HTTP 402 commerce on Solana.**

**Project Status:** Devnet-tested prototype  
**Network:** Solana Devnet  
**Framework:** Anchor / Rust  
**Program ID:** `DHyQV6Khe42Papqad63dqkMHxqiKAUMcE4bugiHpZYtb`

> **Development notice:** Setra402 is a prototype. Core escrow scenarios have been tested on Devnet, but the full application has not been independently verified end-to-end. A treasury authorization issue remains unresolved in the deployed program. Do not use the current deployment for real-value payments.

---

## 1. Overview

Setra402 is a Solana-based settlement protocol designed for autonomous AI agents purchasing API services, computational tasks, and other machine-readable resources.

The protocol combines:

- **Conditional escrow:** Buyer funds are locked before task execution and released after authorized verification.
- **HTTP 402 integration:** Seller gateways can request payment before executing protected services.
- **Deterministic verification:** Off-chain verifier components can validate canonicalized outputs and cryptographic hashes.
- **Privacy-oriented settlement:** Blind-voucher components and on-chain nullifier records support a design intended to reduce identity linkage and prevent voucher reuse.
- **Timeout protection:** Buyers can recover escrowed funds after a task deadline.
- **Replay protection:** On-chain nullifier records prevent the same nullifier from being used for multiple private settlements.

The architecture separates task execution, verification, and payment settlement.

## 2. The Problem

Autonomous agents increasingly interact with paid APIs, external data providers, and computational services.

Two problems arise:

**Counterparty risk:** Paying an API provider upfront does not guarantee that the provider will complete the requested task or return a valid result.

**Financial privacy:** Direct on-chain payments can expose wallet activity, payment timing, counterparties, and operational patterns.

Setra402 addresses these problems through conditional escrow and a privacy-oriented verification architecture.

The current implementation demonstrates the escrow mechanics and replay protection. Complete transaction unlinkability has not yet been independently established.

## 3. How Setra402 Works

### Standard settlement flow

1. A buyer agent requests a protected resource from the seller gateway.
2. The seller returns an HTTP `402 Payment Required` response with task/payment terms.
3. The buyer initializes a Solana escrow and transfers SPL tokens into a program-controlled vault.
4. The seller confirms that the escrow exists and is funded.
5. The seller executes the requested task.
6. An authorized verifier checks the output according to the task's verification rules.
7. The designated verifier invokes the settlement instruction.
8. The program releases the escrowed funds according to the protocol's fee structure.

### Private settlement flow

Private settlement extends the standard flow with a 32-byte nullifier.

The designated verifier submits the nullifier when settling a private task.

The Solana program creates a nullifier record using a PDA derived from that value.

A subsequent attempt to reuse the same nullifier fails because the account already exists.

**Security boundary:** The current on-chain program enforces designated-verifier authorization and nullifier uniqueness. It does not independently validate the complete blind-signature proof; that responsibility belongs to the off-chain verification architecture.

### Architecture

```text
                    SETRA402
                        |
             Frontend / Operator UI
                        |
          +-------------+-------------+
          |                           |
      Buyer Agent                 Seller Gateway
          |                        (Rust/Axum)
          |                           |
          |                      Redis Cache
          |                           |
          +-------- Verifier ---------+
                       |
                       v
                 Solana Devnet
                       |
                Anchor Program
                       |
              Task State PDA
                       |
                 Vault PDA
                       |
           +-----------+-----------+
           |                       |
     Seller Payment          Protocol Fee
                       |
              Nullifier Record PDA
              (Private Settlement)
```

## 4. Repository Structure

The repository contains three Node.js package manifests:

```text
Setra402-agent-validator/
|
├── package.json
├── buyer-agent/
│   └── package.json
├── frontend/
│   └── package.json
├── programs/
│   └── setra402/
│       └── src/
│           ├── lib.rs
│           ├── state.rs
│           ├── constants.rs
│           ├── errors.rs
│           └── instructions/
│               ├── initialize_task.rs
│               ├── settle_task.rs
│               ├── settle_task_private.rs
│               ├── cancel_task.rs
│               └── refund_task.rs
├── tests/
│   └── private-devnet.ts
└── target/
    ├── idl/
    └── types/
```

Other backend directories, scripts, and configuration files may exist in the repository. Their exact startup commands should be checked against the checked-in source before deployment.

### Component responsibilities

| Component | Responsibility |
|---|---|
| Anchor program | Escrow custody, settlement, cancellation, refunds, nullifier records |
| Buyer agent | Payment initiation and client-side task orchestration |
| Seller gateway | HTTP 402 responses and task execution |
| Verifier | Task-output verification and authorized settlement |
| Redis | Fast off-chain nullifier/replay handling |
| Frontend | Operator-facing interface for interacting with the system |

## 5. Prerequisites

Recommended development environment:

- Node.js and a compatible package manager
- Rust and Cargo
- Solana CLI
- Anchor CLI
- Git
- Access to a Solana Devnet RPC endpoint
- A Devnet-funded Solana keypair
- Redis for backend components that require it

The previous verification environment used Node.js v24.10.0 and Rust v1.89.0. These are tested-environment references, not a guarantee that every dependency requires those exact versions.

### Clone and enter the repository

```bash
git clone <REPOSITORY_URL>
cd Setra402-agent-validator
```

Replace `<REPOSITORY_URL>` with the actual repository URL.

### Install Node.js dependencies

From the repository root:

```bash
npm install
```

For the buyer agent:

```bash
cd buyer-agent
npm install
cd ..
```

For the frontend:

```bash
cd frontend
npm install
cd ..
```

Use `npm ci` instead where a compatible `package-lock.json` is committed and reproducible installation is desired.

If the project uses Yarn as its authoritative package manager, follow the committed lockfile instead. Avoid mixing package managers unnecessarily.

**Do not commit or transfer `node_modules` as the primary dependency installation method.** Reinstall from the dependency manifests and lockfiles on the target machine.

## 6. Solana Configuration

### Devnet program

The tested program ID is:

```text
DHyQV6Khe42Papqad63dqkMHxqiKAUMcE4bugiHpZYtb
```

Explorer:

https://explorer.solana.com/address/DHyQV6Khe42Papqad63dqkMHxqiKAUMcE4bugiHpZYtb?cluster=devnet

### Configure the Solana CLI

```bash
solana config set --url devnet
```

To inspect the current configuration:

```bash
solana config get
```

To inspect a wallet's balance:

```bash
solana balance \
  --url devnet \
  --keypair "$HOME/.config/solana/id.json"
```

Use a dedicated Devnet wallet for testing.

Never commit private keys, wallet seed phrases, or production credentials.

### Build the Anchor program

```bash
anchor build
```

The treasury-authorization patch was compiled successfully in the latest local build.

**Important:** The locally compiled patch has not been deployed to the existing Devnet program.

A successful local build does not update the deployed program.

## 7. Environment Configuration

The deployment operator should inspect the actual environment variables used by the frontend, buyer agent, seller gateway, and verifier before configuring hosting.

The following are configuration categories, not a verified `.env` schema:

| Configuration | Purpose |
|---|---|
| Solana RPC URL | Network access |
| Solana network | Devnet |
| Program ID | Deployed Anchor program |
| Wallet configuration | Transaction signing |
| Seller API URL | HTTP 402 gateway |
| Verifier API URL | Verification service, if exposed |
| Redis connection URL | Replay/cache storage |
| Treasury configuration | Protocol fee destination |

**Do not assume these are the exact environment variable names used in the source code.** The deployment operator must match the names expected by each component.

Keep signing credentials server-side. Never expose private keys through frontend environment variables.

## 8. Running the Application

### Frontend

The frontend has its own `package.json`:

```bash
cd frontend
npm install
npm run
```

The final command lists available package scripts.

Run the appropriate development or build script defined in that manifest.

For a typical Next.js application, these may be `npm run dev` and `npm run build`, but the actual scripts should be confirmed before use.

### Buyer agent

```bash
cd buyer-agent
npm install
npm run
```

Use the listed scripts to identify the supported execution commands.

### Seller gateway

The seller gateway is implemented using Rust/Axum according to the project architecture.

The teammate responsible for hosting should identify its Cargo manifest, configure Redis and RPC connectivity, and start the server using its supported executable or Cargo command.

### Verifier

The verifier must be configured with the correct task-verification rules and authorized signing identity.

For the current on-chain program, only the verifier recorded in the task state can successfully settle the task.

**Do not treat a successful frontend build as proof that the entire buyer–seller–verifier flow works.**

## 9. Core Escrow Economics

| Action | Authorization | Behavior |
|---|---|---|
| Initialize escrow | Buyer | Locks SPL tokens in a PDA-controlled vault |
| Public settlement | Designated verifier | 99% seller / 1% treasury |
| Private settlement | Designated verifier | 99% seller / 1% treasury, plus nullifier record |
| Voluntary cancellation | Buyer | 95% buyer refund / 5% treasury penalty |
| Expired refund | Buyer | 100% buyer refund after timeout |
| Duplicate private settlement | Nullifier PDA constraint | Repeated nullifier is rejected |

The settlement and cancellation percentages were exercised in the targeted Devnet test suite.

**Known limitation:** The currently deployed program does not enforce that the treasury token account is owned by the authorized Setra402 protocol authority at task initialization.

## 10. Devnet Testing and Verification

### Tested environment

- Network: Solana Devnet
- Program ID: `DHyQV6Khe42Papqad63dqkMHxqiKAUMcE4bugiHpZYtb`
- Test runner: `ts-mocha`
- Test file: `tests/private-devnet.ts`
- Anchor provider: Devnet RPC and funded test wallet

### Verified functional scenarios

| Scenario | Description | Result |
|---|---|---|
| 1 | Public settlement, 99% seller / 1% treasury | PASS |
| 2 | Voluntary cancellation, 95% refund / 5% penalty | PASS |
| 3 | Private settlement and nullifier record | PASS |
| 4 | Expired task, 100% refund | PASS |
| 5 | Duplicate nullifier rejection | PASS |

**Result: 5/5 targeted live Devnet escrow scenarios passed.**

These tests were executed individually, using the program deployed before the treasury authorization patch.

### Security-negative testing

**Scenario 6: Unauthorized verifier rejection — PASS**

A separate attacker wallet attempted to settle a private escrow.

The Devnet execution simulation returned:

```text
Error Code: InvalidVerifier
Error Number: 6007
Signer is not the designated verifier
```

The test also confirmed:

- Task remained pending.
- Vault balance remained unchanged.
- Seller balance remained unchanged.
- Treasury balance remained unchanged.
- No nullifier record was created.

The malicious settlement was simulated against Devnet state; it was not submitted as a finalized malicious transaction.

### Additional test results

| Suite | Result |
|---|---|
| Rust blind-signature unit tests | 4/4 passed |
| Backend validation/replay tests | 6/6 passed |
| Redis nullifier replay check | Initial request HTTP 200, duplicate HTTP 403 |

These tests provide evidence for individual components. They do not establish full end-to-end privacy guarantees.

### Running targeted Devnet tests

From the repository root:

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET="$HOME/.config/solana/id.json" \
./node_modules/.bin/ts-mocha \
-p ./tsconfig.json \
-t 180000 \
--grep "Scenario 1:|Scenario 2:|Scenario 3:|Scenario 4:|Scenario 5:" \
--bail \
tests/private-devnet.ts
```

**Warning:** The local test source has been modified to expect a protocol-controlled treasury PDA, while the deployed program is still the older version. The above command is provided as a reference to the test workflow, not as a guarantee that the current working tree will pass unchanged.

Tests submit transactions and consume Devnet SOL for account rent and transaction fees.

Do not treat a dry run or a test compilation as equivalent to successful on-chain execution.

## 11. Security Findings and Known Limitations

### SEC-01 — Protocol treasury fee redirection

**Status: Unresolved on deployed Devnet program**

**Severity: High, assuming fees must be paid to the protocol-controlled treasury**

The deployed initialization logic checks that the supplied treasury token account uses the correct mint, but does not enforce an authorized treasury owner.

As a result, a buyer can select a token account under their own control as the treasury destination.

This can redirect the intended 1% settlement fee and potentially the 5% cancellation penalty.

**Remediation progress:**

- Root cause identified through source review.
- Protocol-controlled treasury PDA constraint added locally.
- `InvalidTreasury` error added.
- Patched Rust program compiled successfully.
- Devnet test treasury setup updated.

**Remaining work:**

- Finalize treasury custody and withdrawal authorization.
- Review how existing pending escrows are handled.
- Deploy the corrected program.
- Run treasury-redirection rejection and regression tests.

The deployed contract must not be described as fixed until these steps are completed.

### SEC-02 — Off-chain verifier trust boundary

The program enforces the designated verifier's signature.

However, the on-chain settlement instruction does not independently verify a blind-voucher cryptographic proof.

The verifier therefore carries responsibility for checking voucher validity and task-output correctness.

**Recommended verification:** Test the full voucher issuance, verification, nullifier submission, and settlement flow, including invalid or forged vouchers.

### SEC-03 — Additional adversarial testing

The following cases have not been established as fully tested:

- Concurrent nullifier reuse attempts.
- Incorrect settlement destination accounts.
- Repeated settlement of an already-settled task.
- Cancellation or refund after settlement.
- Unauthorized withdrawal attempts.
- Broader input and account-substitution attacks.

These should be addressed before production deployment.

### SEC-04 — Frontend and full-stack integration

The frontend has not been verified through a complete browser-based demonstration in the evidence collected during this testing session.

The deployment operator should validate wallet connection, API connectivity, transaction initiation, task status display, and error handling.

## 12. Hosting and Deployment

Setra402 uses multiple components that do not all need to run on the same host.

### Suggested hosting arrangement

| Component | Suggested environment |
|---|---|
| Frontend | Vercel or equivalent web hosting |
| Solana program | Solana Devnet |
| Rust/Axum seller gateway | Persistent backend host |
| Redis | Managed Redis or secured Redis instance |
| Verifier | Backend service or worker |
| Buyer agent | Client process or backend worker, depending on implementation |

Hosting and deployment are assigned to the teammate responsible for infrastructure.

### Deployment checklist

- [ ] Install dependencies from committed manifests and lockfiles.
- [ ] Confirm the frontend builds successfully.
- [ ] Configure the correct Solana network and program ID.
- [ ] Configure public HTTPS backend URLs.
- [ ] Ensure production-facing frontend code does not call `localhost`.
- [ ] Configure CORS for the deployed frontend origin.
- [ ] Configure Redis connectivity.
- [ ] Keep wallet signing keys and backend secrets out of the frontend.
- [ ] Verify browser wallet connection.
- [ ] Verify frontend-to-backend requests.
- [ ] Demonstrate a complete task lifecycle.
- [ ] Resolve treasury authorization before any real-value deployment.

**Vercel deployment alone does not host the Rust seller gateway, Redis, or verifier service.**

## 13. Troubleshooting

### Wallet connects to the wrong network

Verify that the wallet and RPC endpoint are both configured for Solana Devnet.

### Transaction fails with insufficient funds

Ensure the relevant signing wallet has enough Devnet SOL to cover fees and account rent.

The verifier may need SOL to initialize a nullifier record.

### Duplicate nullifier rejected

This is expected when a previously used nullifier is submitted again.

Use a fresh nullifier for each legitimate private settlement.

### `InvalidVerifier` error

The signing wallet does not match the designated verifier stored in the task state.

### Treasury authorization failure

The locally patched program requires a treasury token account owned by the protocol treasury authority PDA.

The existing deployed program does not yet enforce that constraint.

Ensure the test configuration and deployed program version are compatible.

### Frontend loads but API calls fail

Check the backend URL, server availability, HTTPS configuration, CORS policy, and environment variables.

### Build succeeds but transactions fail

A successful build does not prove that the deployed program ID, generated IDL, test configuration, and live contract version are aligned.

Verify all four.

## 14. Audit Documentation

The repository references the following audit materials:

- `AUDIT_README.md` — Verification methodology and audit navigation.
- `LIVE_CHAIN_FINANCIAL_AND_PRIVACY_AUDIT.md` — Financial and privacy audit report.
- `AUDIT_EXECUTION_GUIDE.md` — Audit execution instructions.
- `RPC_INSPECTION_REFERENCE.md` — RPC inspection commands.

These files should be included in the handoff only after confirming they exist and accurately reflect the latest program version and test evidence.

Any previous audit claims must be reconciled with the current Devnet results and the unresolved treasury authorization finding.

## 15. Teammate Handoff Checklist

### Protocol implementation

- [x] Anchor escrow program implemented.
- [x] Devnet program deployed.
- [x] Five targeted functional Devnet scenarios passed.
- [x] Unauthorized verifier rejection tested.
- [x] Blind-signature unit tests passed.
- [x] Backend validation/replay tests passed.
- [x] Redis replay protection tested.

### Remaining engineering work

- [ ] Resolve and deploy treasury authorization remediation.
- [ ] Add treasury-redirection regression test.
- [ ] Verify the full blind-voucher pipeline.
- [ ] Validate full frontend/backend integration.
- [ ] Confirm the deployed UI build and wallet workflow.
- [ ] Collect transaction signatures and independently inspect token movements.
- [ ] Clean up or account for pending test escrows.
- [ ] Complete additional adversarial security testing.
- [ ] Review deployment secrets, RPC configuration, and infrastructure access.

## 16. Final Project Status

**Setra402 is a functional, Devnet-tested escrow protocol prototype.**

The five principal escrow scenarios have passed against the deployed Solana program. Additional unit and backend tests support the implementation's cryptographic and replay-protection components.

The project is ready for technical demonstration preparation and teammate handoff, subject to integration checks.

It is **not yet verified as a production-ready, fully audited, or end-to-end privacy-preserving payment system**.

The most important outstanding security issue is protocol treasury authorization in the deployed contract.

---

### Built for autonomous machine-to-machine commerce on Solana

**Setra402 — Conditional Payments. Deterministic Verification. Privacy-Oriented Agent Infrastructure.**

## Environment Configuration

Setra402 uses separate environment files for its protocol configuration, buyer agent, and seller gateway.

**Important:** Localnet and Devnet configurations must not be mixed.

### Tested Devnet program

```text
Network: Solana Devnet
Program ID: DHyQV6Khe42Papqad63dqkMHxqiKAUMcE4bugiHpZYtb
RPC URL: https://api.devnet.solana.com
```

### Configuration responsibilities

**Root configuration**

Defines the program ID, token mint, seller token account, verifier identity, treasury account, Redis endpoint, and RPC settings.

**Buyer agent configuration**

Defines the program ID, Solana RPC endpoint, seller gateway URL, wallet keypair paths, protocol treasury account, and settlement safety margin.

**Seller gateway configuration**

Defines the RPC connection, program ID, mint, seller token account, verifier address, optional treasury, Redis connection, task price, timeout, and server binding address.

The seller gateway also supports optional server-owned provider-secret and connector-registry configuration.

These provider secrets must remain on the backend and must never be exposed through the browser or buyer-facing API inputs.

### Setup instructions

1. Copy each component's `.env.example` to its corresponding `.env` file.
2. Select Localnet or Devnet and use matching program and account addresses.
3. Provide valid SPL token mint and token-account addresses.
4. Configure the seller gateway and Redis.
5. Configure buyer/verifier keypairs.
6. Start the required backend services.
7. Start the frontend using the script defined in `frontend/package.json`.
8. Verify wallet connectivity, backend availability, escrow initialization, settlement, and refund behavior.

### Deployment warnings

- `127.0.0.1` refers to the machine or container running that component, not a shared address across hosted services.
- The SPL Token Program ID is not a valid substitute for a token mint.
- Never commit populated `.env` files containing credentials.
- Never expose signing keypairs or mint secrets to the frontend.
- The existing Devnet contract has an unresolved treasury authorization issue.
- Full frontend/backend integration has not yet been verified.