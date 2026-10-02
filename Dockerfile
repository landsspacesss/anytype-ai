# syntax=docker/dockerfile:1

# NOTE: the embedded pi SDK (@earendil-works/pi-coding-agent, via undici 8) and
# pi's own `engines` field both require Node >= 22.19.0; it throws on Node 20
# ("webidl.util.markAsUncloneable is not a function"). The images below are
# therefore node:22, not node:20.

# ---------------------------------------------------------------------------
# Stage 1 — deps: production node_modules only (pi SDK + its transitive deps).
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Stage 2 — build: compile TypeScript to dist/.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build

# ---------------------------------------------------------------------------
# Stage 3 — runtime: Node 22 + the compiled bot + the pi SDK node_modules.
# No omp subprocess anymore: the agent runs in-process via the pi SDK.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates bash git \
    && rm -rf /var/lib/apt/lists/*

# The model provider key is supplied at runtime via `env_file: .env` and is
# NEVER baked into the image.

WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# Custom model registry (adds DeepSeek V4.1 / `deepseek-flash`, which pi's
# built-in table predates). Copied into the agent dir at startup, because the
# agent dir is a volume mount that would otherwise shadow a baked-in file.
COPY docker/models.json /app/pi/models.json

# Writable dirs: /workspace holds the per-space agent workspace volume;
# /root/.pi/agent is pi's global config/auth dir (never baked credentials in).
RUN mkdir -p /workspace /root/.pi/agent
ENV AGENT_WORKSPACE_ROOT=/workspace

CMD ["node", "dist/main.js"]
