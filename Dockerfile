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

# Extraction tooling so the agent can read ANY loose file it downloads:
#   poppler-utils -> pdftotext (PDFs); unzip -> docx/xlsx (zip of XML);
#   file -> sniff; python3 -> stdlib zipfile/xml fallback. No pip needed.
# curl fetches the Lightpanda binary below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates bash git curl \
      poppler-utils unzip file python3 \
    && rm -rf /var/lib/apt/lists/*

# Lightpanda — the official JS-capable headless browser backing the `web_fetch`
# tool. We take the glibc Linux build (this image is Debian bookworm, NOT musl).
# Release assets are named lightpanda-<arch>-linux (x86_64|aarch64), e.g.
#   .../releases/download/<ver>/lightpanda-x86_64-linux
# The direct github.com URL is tried first; when github.com is unreachable from
# the build network we fall back to the equivalent GitHub API asset endpoint
# (reachable more broadly), which redirects to the same object.
ARG LIGHTPANDA_VERSION=0.4.1
RUN set -eux; \
    arch="$(dpkg --print-architecture | sed 's/amd64/x86_64/; s/arm64/aarch64/')"; \
    asset="lightpanda-${arch}-linux"; \
    url="https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/${asset}"; \
    if ! curl -fsSL --connect-timeout 20 --max-time 300 "$url" -o /usr/local/bin/lightpanda; then \
      api="https://api.github.com/repos/lightpanda-io/browser/releases/tags/${LIGHTPANDA_VERSION}"; \
      id="$(curl -fsSL --connect-timeout 20 --max-time 60 "$api" \
        | python3 -c "import sys,json;print([a['id'] for a in json.load(sys.stdin)['assets'] if a['name']=='${asset}'][0])")"; \
      curl -fsSL --max-time 300 -H 'Accept: application/octet-stream' \
        "https://api.github.com/repos/lightpanda-io/browser/releases/assets/${id}" \
        -o /usr/local/bin/lightpanda; \
    fi; \
    chmod +x /usr/local/bin/lightpanda; \
    lightpanda version

# The model provider key is supplied at runtime via `env_file: .env` and is
# NEVER baked into the image.

WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# gRPC proto for the anytype-heart bridge; process.cwd() is /app, so the client
# resolves it at /app/proto/anytype.proto.
COPY proto ./proto
# Custom model registry (adds DeepSeek V4.1 / `deepseek-flash`, which pi's
# built-in table predates). Copied into the agent dir at startup, because the
# agent dir is a volume mount that would otherwise shadow a baked-in file.
COPY docker/models.json /app/pi/models.json

# Writable dirs: /workspace holds the per-space agent workspace volume;
# /root/.pi/agent is pi's global config/auth dir (never baked credentials in).
RUN mkdir -p /workspace /root/.pi/agent
ENV AGENT_WORKSPACE_ROOT=/workspace

CMD ["node", "dist/main.js"]
