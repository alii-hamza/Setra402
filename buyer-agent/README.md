# Setra402 Buyer Agent — Phase 1

This package implements Role C Phase 1 only: strict configuration, current REST/HTTP-402 transport, IDL-driven escrow funding, manifest commitment by Solana Memo, legacy public/private settlement compatibility, timeout refunds, and cancellation compatibility.

It deliberately contains no Level-1/Level-2 verification modules, MCP transport, frontend, AI advisory, TEE, or ZK implementation.

The caller supplies the expected mint and the compatibility-policy hash when constructing the quote normalizer/orchestrator. They are not invented from fields absent from the current Role B quote.

## Commands

```powershell
npm run build
npm run test:unit
npm run test:integration
npm run test:e2e       # requires the live ROLE_C_* test environment
npm run test:all       # same live environment requirement
```

Production startup configuration is documented in `.env.example`. Buyer and verifier key files are server-side Solana JSON keypair arrays and must never be served to browser code.
