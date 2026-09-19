# Lightweight Dockerfile for Seller Server
# Handles dependency isolation and provides consistent build environment

FROM rust:1.75-slim as builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy Cargo files first for better caching
COPY Cargo.toml Cargo.lock ./

# Create a dummy main.rs to build dependencies
RUN mkdir src && \
    echo "fn main() {}" > src/main.rs && \
    cargo build --release && \
    rm -rf src

# Copy actual source code
COPY src ./src

# Build the application
RUN cargo build --release

# Runtime stage - minimal image
FROM debian:bookworm-slim

# Install runtime dependencies only
RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -u 1000 seller

# Set working directory
WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/target/release/seller-server /app/seller-server

# Copy .env.example for reference
COPY .env.example /app/.env.example

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