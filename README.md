# Setra402

Solana-based conditional settlement and escrow prototype for autonomous-agent commerce.

## Quick Start

The easiest way to run Setra402 locally is to use the provided startup script:

```bash
./run.sh
```

This will:
1. Start a local Solana validator
2. Start Redis (via Docker)
3. Build and deploy the Anchor program
4. Start the seller server
5. Start the buyer agent (which serves the frontend)

Then open http://127.0.0.1:3003 in your browser.

## Manual Setup

If you prefer to run services manually:

### Prerequisites

- Node.js 18+
- Rust and Cargo
- Docker (for Redis)
- Solana CLI
- Anchor

### 1. Start Redis

```bash
docker compose -f docker-compose.dev.yml up -d redis
```

### 2. Start Solana Validator

```bash
mkdir -p .localnet/ledger
solana-test-validator --ledger .localnet/ledger --reset
```

### 3. Build and Deploy Program

```bash
anchor build
anchor deploy
anchor keys sync
```

### 4. Start Seller Server

```bash
cd seller-server
cargo run
```

### 5. Start Buyer Agent

```bash
cd buyer-agent
npm run web
```

The frontend will be available at http://127.0.0.1:3003

## Environment Configuration

The repository includes default `.env` files for local development:

- `buyer-agent/.env` - Buyer agent configuration
- `seller-server/.env` - Seller server configuration
- `frontend/.env` - Frontend configuration

For production or different environments, create `.env.local` files to override defaults.

## Architecture

- **Frontend**: React/Vite SPA served by the buyer agent
- **Buyer Agent**: Node.js control plane with web server and MCP server
- **Seller Server**: Rust/Axum HTTP API for task execution
- **Solana Program**: Anchor program for on-chain escrow and settlement
- **Redis**: Used for nullifier caching (Phase 3)

## Documentation

- `LOCAL_SETUP.md` - Detailed local development setup guide
- `AGENT.md` - On-chain implementation guidelines
- `idl/setra402.json` - Program IDL

## License

MIT
