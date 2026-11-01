#!/usr/bin/env bash
# convex-prod-deploy.sh — deploy the Convex backend to prod under a Pi deploy token.
#
# Usage:
#   convex-prod-deploy.sh <token-task-id> <floor-commit>
#
# Refuses unless: the token id is a 32-char task id; the floor commit is an
# ancestor of origin/main; the checkout is clean and exactly at origin/main.
# Deploys from the repository root with the prod key read from .env.local
# (must start with "prod:", never printed), then prints the deployed commit.
# Owned by root, not writable by the station that runs it.
set -euo pipefail

token="${1:-}"; floor="${2:-}"
if [[ ! "$token" =~ ^k[a-z0-9]{31}$ ]] || [[ -z "$floor" ]]; then
  echo "REFUSED: usage: convex-prod-deploy.sh <token-task-id> <floor-commit>" >&2
  exit 2
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root"

git fetch -q origin main
if ! git merge-base --is-ancestor "$floor" origin/main; then
  echo "REFUSED: floor $floor is not an ancestor of origin/main" >&2
  exit 2
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "REFUSED: checkout has local changes" >&2
  exit 2
fi
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "REFUSED: HEAD is not origin/main; run git checkout main and git pull --ff-only first" >&2
  exit 2
fi

key="$(grep -m1 '^CONVEX_DEPLOY_KEY_PROD_VP=' .env.local 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
if [[ -z "$key" || "$key" != prod:* ]]; then
  echo "REFUSED: CONVEX_DEPLOY_KEY_PROD_VP missing or not a prod key in .env.local" >&2
  exit 2
fi

echo "token: $token" >&2
echo "deploying commit: $(git rev-parse HEAD)" >&2
CONVEX_DEPLOY_KEY="$key" npx convex deploy --yes
echo "deployed commit: $(git rev-parse HEAD)"
