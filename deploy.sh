#!/usr/bin/env bash
#
# One-command deploy: build the image and recreate the bot container.
#
# The bot must be run MERGED into the any-sync compose project, because
# `network_mode: service:anytype-cli` only resolves when anytype-cli is a
# service in the SAME project — so every compose call needs both -f files.
# This script encapsulates that (and tags the image with the git SHA so you can
# tell which commit is live: `docker inspect anytype-ai-bot:latest`).
#
# Usage:  ./deploy.sh
# Override paths via env if your layout differs:
#   BOT_REPO=/path/to/anytype-ai-bot ANYTYPE_DIR=/path/to/anytype ./deploy.sh
set -euo pipefail

REPO="${BOT_REPO:-/home/landspace/anytype-ai-bot}"
ANYTYPE_DIR="${ANYTYPE_DIR:-/home/landspace/anytype}"
BOT_URL="${BOT_URL:-http://127.0.0.1:31012}"   # informational only

cd "$REPO"
sha="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"

echo "==> building  anytype-ai-bot:latest  (commit $sha)"
docker build -t anytype-ai-bot:latest -t "anytype-ai-bot:$sha" "$REPO"

echo "==> recreating ai-bot"
cd "$ANYTYPE_DIR"
docker compose \
  -f docker-compose.yml \
  -f "$REPO/docker-compose.bot.yml" \
  up -d --force-recreate --no-deps ai-bot

echo "==> deployed $sha"
echo "    logs:  docker logs -f anytype-ai-bot-1"
echo "    image: anytype-ai-bot:$sha  (also :latest)"
