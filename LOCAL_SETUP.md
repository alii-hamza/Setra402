# Local Development Setup

## Quick Start

To run the Setra402 control plane locally with the Solana program:

```bash
# 1. Start the local Solana validator
solana-test-validator --ledger .localnet/ledger --reset

# 2. Build and deploy the Anchor program
anchor build
anchor deploy

# 3. Run the buyer-agent (which serves the frontend)
cd buyer-agent
npm run web
```

The frontend will be available at: http://127.0.0.1:3003

## What Was Fixed

The local setup was failing due to a program ID mismatch between:
- The program ID declared in `programs/setra402/src/lib.rs`
- The program ID in `Anchor.toml`
- The actual deployed program ID on the local validator

The fix involved:
1. Running `anchor keys sync` to sync the program IDs with the deployed program
2. Updating `buyer-agent/.env` to use the correct program ID: `5hMcAceh1ZJQxkHPsBExzFQq97Gie18S9kHFZh8Sk9Jq`
3. Rebuilding the program with `anchor build`
4. Deploying with `anchor deploy` (which now succeeds and creates the IDL)

## Program IDs

- **Localnet**: `5hMcAceh1ZJQxkHPsBExzFQq97Gie18S9kHFZh8Sk9Jq`
- **Devnet**: `DHyQV6Khe42Papqad63dqkMHxqiKAUMcE4bugiHpZYtb`

The current setup is configured for localnet.

## Architecture

The buyer-agent serves both:
- The React frontend (from `frontend/dist/`)
- The API endpoints (`/api/config`, `/api/tasks/*`, etc.)

This means you only need to run one process (`npm run web` in the buyer-agent directory) to get the full local experience.

## Seller Server

The seller server is not required for basic local testing. The buyer-agent includes local fixture providers that can execute tasks without a seller server. To run the seller server:

```bash
cd seller-server
cargo run
```

Then update `buyer-agent/.env`:
```
SELLER_URL=http://127.0.0.1:3000
```

## Troubleshooting

### "IDL address does not match PROGRAM_ID"
This means the program ID in your `.env` doesn't match the deployed program. Run:
```bash
anchor keys sync
# Update buyer-agent/.env with the new PROGRAM_ID
anchor build
anchor deploy
```

### "Program Id mismatch"
The `declare_id!` in `lib.rs` doesn't match the deployed program. Run `anchor keys sync` to fix this automatically.

### Solana validator not running
Make sure you started the validator before deploying:
```bash
solana-test-validator --ledger .localnet/ledger --reset
```
