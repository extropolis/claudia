# Claudia - Multi-stage Docker build
# Runs the full Claudia stack (backend + frontend) in a single container

# ---- Stage 1: Build ----
FROM node:20-bookworm AS builder

WORKDIR /app

# Install build dependencies for node-pty native module
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests first (better layer caching)
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/

# Install all dependencies (including devDependencies for building)
RUN npm ci

# Copy source code
COPY shared/ shared/
COPY backend/ backend/
COPY frontend/ frontend/

# Build shared → backend → frontend (order matters: shared is a dep of both)
RUN npm run build -w shared
RUN npm run build -w frontend

# ---- Stage 2: Runtime ----
FROM node:20-bookworm-slim

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    curl \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Copy package manifests
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/

# Install production dependencies only (plus rebuild native modules for this platform)
RUN npm ci --omit=dev

# tsx is needed at runtime to execute TypeScript backend directly
RUN npm install -g tsx

# Copy built shared library
COPY --from=builder /app/shared/dist/ shared/dist/
COPY shared/src/ shared/src/

# Copy backend source (runs with tsx, not pre-compiled)
COPY backend/src/ backend/src/
COPY backend/tsconfig.json backend/

# Copy built frontend
COPY --from=builder /app/frontend/dist/ frontend/dist/

# Copy entrypoint
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Create default workspace directory and set up coder user
# node:20-bookworm-slim already has 'node' user at UID 1000
# which matches ec2-user on Amazon Linux - rename it and set up home
RUN usermod -l coder -d /home/coder -m node && \
    groupmod -n coder node && \
    mkdir -p /home/coder/workspaces /home/coder/.claude && \
    chown -R coder:coder /home/coder && \
    chown -R coder:coder /app

# Backend port
EXPOSE 4001

# Environment defaults
ENV NODE_ENV=production
ENV CLAUDIA_BACKEND_PORT=4001
ENV CLAUDIA_FRONTEND_DIR=/app/frontend/dist

# Run as coder user (UID 1000, matches ec2-user on Amazon Linux devVM)
USER coder

ENTRYPOINT ["/docker-entrypoint.sh"]
