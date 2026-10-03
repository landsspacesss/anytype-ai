#!/usr/bin/env bash
#
# Deploy the bot: build the image (or pull it from GHCR) and recreate the
# container.
#
# The bot must be run MERGED into the any-sync compose project, because
# `network_mode: service:anytype-cli` only resolves when anytype-cli is a
# service in the SAME project — so every compose call needs both -f files.
# This script encapsulates that (and tags the image with the git SHA so you can
# tell which commit is live).
#
# Usage:
#   ./deploy.sh            # build locally from this repo (uses local source)
#   ./deploy.sh --pull     # pull the published image from GHCR instead
#   ./deploy.sh --pull v1.2.3   # pull a specific tag
#
# Override paths via env if your layout differs:
#   BOT_REPO=/path/to/anytype-ai-bot ANYTYPE_DIR=/path/to/anytype ./deploy.sh
set -euo pipefail

REPO="${BOT_REPO:-/home/landspace/anytype-ai-bot}"
ANYTYPE_DIR="${ANYTYPE_DIR:-/home/landspace/anytype}"
GHCR_IMAGE="${GHCR_IMAGE:-ghcr.io/landsspacesss/anytype-ai}"

mode="build"
tag=""
for arg in "$@"; do
  case "$arg" in
    --pull) mode="pull" ;;
    *) tag="$arg" ;;
  esac
done

local_image="anytype-ai-bot:latest"

if [ "$mode" = "pull" ]; then
  ref="$GHCR_IMAGE:${tag:-latest}"
  echo "==> pulling $ref"
  docker pull "$ref"
  # Retag as the compose service's image name so `up --no-build` uses it.
  docker tag "$ref" "$local_image"
  compose_flags="--no-build"
  sha="$tag"
else
  sha="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo nogit)"
  echo "==> building $local_image (commit $sha)"
  docker build -t "$local_image" -t "anytype-ai-bot:$sha" "$REPO"
  compose_flags=""
  echo "    image: anytype-ai-bot:$sha"
fi

echo "==> recreating ai-bot"
cd "$ANYTYPE_DIR"
# shellcheck disable=SC2086
docker compose \
  -f docker-compose.yml \
  -f "$REPO/docker-compose.bot.yml" \
  up -d --force-recreate --no-deps $compose_flags ai-bot

echo "==> deployed (${mode}${sha:+, $sha})"
echo "    logs:  docker logs -f anytype-ai-bot-1"
