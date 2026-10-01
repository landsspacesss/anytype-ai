# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 — build: compile TypeScript to dist/.
# The runtime code has NO third-party production dependencies (only Node
# builtins + compiled local .js), so nothing is copied from here into the
# runtime image except the compiled output.
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build

# ---------------------------------------------------------------------------
# Stage 2 — runtime: Node 20 + omp + the compiled bot.
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl bash git \
    && rm -rf /var/lib/apt/lists/*

# Install omp (phase0 Task 0.3).
# Stock installer is preferred: github.com is reachable from this build env
# (controller re-test 2026-10-02: github.com -> 200, omp.sh -> 200). The
# installer drops the prebuilt binary at $HOME/.local/bin/omp and smoke-tests
# it with `--version`.
#
# FALLBACK (only if this layer fails downloading from github.com — the
# Task 0.3 transient timeout): replace the RUN below with the api.github.com
# release-asset download documented in
# docs/superpowers/plans/phase0-findings.md (Task 0.3, Step 1), which installs
# the same binary to /usr/local/bin/omp.
RUN curl -fsSL https://omp.sh/install | sh
ENV PATH="/root/.local/bin:/usr/local/bin:${PATH}"

# omp refuses to start without a model provider key ("No models available").
# The key is supplied at runtime via `env_file: .env` and is NEVER baked in.

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY docker/omp-config.yml /root/.omp/agent/config.yml

# Strict isolation: the only writable host-backed path is /workspace (the
# per-space omp workspace volume). omp state lives under /root/.omp/agent.
RUN mkdir -p /workspace
ENV OMP_WORKSPACE_ROOT=/workspace

CMD ["node", "dist/main.js"]
