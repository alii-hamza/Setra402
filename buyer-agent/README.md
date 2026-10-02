# Setra402 Buyer Agent — Phase 2

This package implements Role C through Phase 2: strict configuration, REST/HTTP-402 transport, IDL-driven escrow funding, manifest commitment by Solana Memo, public/private settlement compatibility, timeout refunds, cancellation compatibility, and policy-driven Level-1 deterministic verification.

Level-1 includes `json_schema`, `record_count`, `required_fields`, `unique`, `freshness`, `artifact_integrity`, and `solana_state`. Settlement requires a passing `VerificationReport`; legacy `output_hash` is retained only for wire compatibility and cannot authorize payment.

The seller quote supplies a committed service policy and policy hash. The buyer independently validates both, commits them in the task manifest, verifies the result and evidence, then re-reads on-chain state before settlement.

Phase 3 work is deliberately absent: no Level-2 source sampling/test runner, MCP transport, frontend, AI advisory, TEE, or ZK implementation is included.

## Commands

```powershell
npm run build
npm run test:unit
npm run test:integration
npm run test:e2e       # requires the live ROLE_C_* test environment
npm run test:l1
npm run test:all       # same live environment requirement
```

Production startup configuration is documented in `.env.example`. Buyer and verifier key files are server-side Solana JSON keypair arrays and must never be served to browser code.
