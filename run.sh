#!/usr/bin/env bash
#
# run.sh - start the Setra402 local development environment.
#
# This script starts:
# 1. Solana local validator
# 2. Redis (via Docker)
# 3. Seller server (Rust)
# 4. Buyer agent (Node.js) with frontend
#
# Usage:
#   ./run.sh              # start all services
#
# Press Ctrl+C to stop all services.
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-3003}"
URL="http://localhost:${PORT}"

echo "Setra402 Local Development"
echo "  repo:   $ROOT_DIR"
echo "  port:   $PORT"
echo

# --- Sanity checks -------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed or not on PATH." >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "ERROR: Cargo is not installed or not on PATH." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is not installed or not on PATH." >&2
  exit 1
fi

if ! command -v solana >/dev/null 2>&1; then
  echo "ERROR: Solana CLI is not installed or not on PATH." >&2
  exit 1
fi

if ! command -v anchor >/dev/null 2>&1; then
  echo "ERROR: Anchor is not installed or not on PATH." >&2
  exit 1
fi

# --- Cleanup function ----------------------------------------------------
cleanup() {
  echo
  echo "Stopping services..."
  if [ -n "${SELLER_PID:-}" ]; then
    kill "$SELLER_PID" 2>/dev/null || true
  fi
  if [ -n "${BUYER_PID:-}" ]; then
    kill "$BUYER_PID" 2>/dev/null || true
  fi
  if [ -n "${VALIDATOR_PID:-}" ]; then
    kill "$VALIDATOR_PID" 2>/dev/null || true
  fi
  docker compose -f "$ROOT_DIR/docker-compose.dev.yml" down 2>/dev/null || true
  echo "All services stopped."
}

trap cleanup EXIT INT TERM

# --- Start Redis ---------------------------------------------------------
echo "Starting Redis..."
docker compose -f "$ROOT_DIR/docker-compose.dev.yml" up -d redis
sleep 2

# --- Start Solana Validator -----------------------------------------------
echo "Starting Solana validator..."
mkdir -p "$ROOT_DIR/.localnet/ledger"
solana-test-validator --ledger "$ROOT_DIR/.localnet/ledger" --reset > /dev/null 2>&1 &
VALIDATOR_PID=$!
sleep 5

# --- Build and Deploy Anchor Program --------------------------------------
echo "Building and deploying Anchor program..."
cd "$ROOT_DIR"
anchor build > /dev/null 2>&1
anchor deploy > /dev/null 2>&1

# --- Copy IDL to repo ----------------------------------------------------
echo "Copying IDL to repo..."
mkdir -p "$ROOT_DIR/idl"
cp "$ROOT_DIR/target/idl/setra402.json" "$ROOT_DIR/idl/setra402.json" 2>/dev/null || true

# --- Sync program IDs ----------------------------------------------------
echo "Syncing program IDs..."
anchor keys sync > /dev/null 2>&1

# --- Update .env files with local program ID -----------------------------
LOCAL_PROGRAM_ID=$(solana program show "$ROOT_DIR/target/deploy/setra402.so" 2>/dev/null | grep "Program Id" | awk '{print $3}' || echo "")
if [ -z "$LOCAL_PROGRAM_ID" ]; then
  LOCAL_PROGRAM_ID=$(grep "programs.localnet" "$ROOT_DIR/Anchor.toml" | awk -F'[=" ]' '{print $3}')
fi

if [ -n "$LOCAL_PROGRAM_ID" ]; then
  sed -i "s/^PROGRAM_ID=.*/PROGRAM_ID=$LOCAL_PROGRAM_ID/" "$ROOT_DIR/buyer-agent/.env" 2>/dev/null || true
  sed -i "s/^PROGRAM_ID=.*/PROGRAM_ID=$LOCAL_PROGRAM_ID/" "$ROOT_DIR/seller-server/.env" 2>/dev/null || true
fi

# --- Start Seller Server --------------------------------------------------
echo "Starting seller server..."
cd "$ROOT_DIR/seller-server"
cargo run > /dev/null 2>&1 &
SELLER_PID=$!
sleep 5

# --- Start Buyer Agent ----------------------------------------------------
echo "Starting buyer agent (frontend + API)..."
cd "$ROOT_DIR/buyer-agent"
npm run web > /dev/null 2>&1 &
BUYER_PID=$!
sleep 5

# --- Check if services are running -----------------------------------------
echo
echo "Checking services..."
if ! curl -fsS -o /dev/null "http://127.0.0.1:3000/services" 2>/dev/null; then
  echo "WARNING: Seller server may not be responding correctly"
fi

if ! curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/config" 2>/dev/null; then
  echo "WARNING: Buyer agent may not be responding correctly"
fi

# --- Done -----------------------------------------------------------------
echo
echo "=========================================="
echo "Setra402 is running!"
echo "=========================================="
echo "Frontend: $URL"
echo "API:      $URL/api"
echo "Services: http://127.0.0.1:3000/services"
echo "RPC:      http://127.0.0.1:8899"
echo "=========================================="
echo
echo "Press Ctrl+C to stop all services."

# --- Wait for background processes ----------------------------------------
wait