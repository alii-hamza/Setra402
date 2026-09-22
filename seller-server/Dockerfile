# NOTE: deliberately no `# syntax=` directive. Pointing at an external frontend
# (e.g. docker/dockerfile:1.7) makes every build require pulling that image,
# which defeats building on a slow/offline link. The frontend bundled with
# current Docker already supports `RUN --mount` (verified against a local base).
#
# Build context is the repository root (see docker-compose.dev.yml): the
# seller-server crate depends on ../shared/task-anchor-types, which a
# seller-server/ context cannot reach.
#
# Build with:
#   docker build -f seller-server/Dockerfile -t setra402-seller-server .
#
# The build is laid out so that the *dependency* compile is cached and only
# re-runs when Cargo.toml/Cargo.lock change, and so downloaded crates live in a
# BuildKit cache mount that survives across builds. Without both of those, every
# source edit re-downloads and recompiles the whole graph.

# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------
# Must match rust-toolchain.toml (channel = "1.89.0"): that file is inside the
# build context, so a base image with a different toolchain makes rustup try to
# download 1.89.0 mid-build. Same Debian release as the runtime stage below, so
# glibc versions line up.
FROM rust:1.89-slim AS builder

RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Layer 1: manifests + the workspace members cargo needs to resolve ---------
# Cargo resolves the whole workspace, so every member's manifest *and* sources
# must be present for the manifest layer to be valid. `programs/*` is copied in
# full but never compiled: it is not in seller-server's dependency graph.
COPY Cargo.toml Cargo.lock ./
COPY seller-server/Cargo.toml ./seller-server/Cargo.toml
COPY shared ./shared
COPY programs ./programs

# --- Layer 2: warm the dependency cache ---------------------------------------
# Stub out the crate we actually build so this layer compiles *only*
# dependencies. It is keyed on the manifests above, so it is reused until
# Cargo.lock/Cargo.toml change — the expensive part happens once, not per build.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    mkdir -p seller-server/src \
    && : > seller-server/src/lib.rs \
    && : > seller-server/src/main.rs \
    && cargo build --release --package seller-server

# --- Layer 3: real sources, incremental build ---------------------------------
# Only the workspace crates recompile here; dependencies come straight from the
# cached target dir. The binary is copied out of the cache mount because mounted
# directories are not part of the image filesystem.
COPY . .

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release --package seller-server \
    && mkdir -p /app/bin \
    && cp target/release/seller-server /app/bin/seller-server

# ---------------------------------------------------------------------------
# Runtime stage - minimal image
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -u 1000 seller

# Set working directory
WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/bin/seller-server /app/seller-server

# Copy .env.example for reference
COPY seller-server/.env.example /app/.env.example

# Change ownership
RUN chown -R seller:seller /app

# Switch to non-root user
USER seller

# Expose default port
EXPOSE 3000

# Set environment variables
ENV RUST_LOG=info
ENV BIND_ADDR=0.0.0.0:3000

# Run the server
CMD ["/app/seller-server"]
