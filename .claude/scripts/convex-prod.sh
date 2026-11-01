#!/usr/bin/env bash
# convex-prod.sh — run an allow-listed Convex prod function or table read.
#
# Usage:
#   convex-prod.sh run <function> [json-args]
#   convex-prod.sh data <table> [extra convex data flags...]
#
# Verbs: run and data only. There is no deploy verb on purpose: a deploy goes
# through `npx convex deploy` and its own authorization guards.
# The allowed entries live in convex-prod.allow beside this script, one
# "run <function>" or "data <table>" per line. Anything unlisted is refused.
# The prod key is read from the checkout's .env.local, must start with "prod:",
# and is never printed. The deployment name is printed on stderr every call.
# This file and its allow list are owned by root and not writable by the
# station that executes them.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
allow="$here/convex-prod.allow"

verb="${1:-}"; target="${2:-}"
if [[ "$verb" != "run" && "$verb" != "data" ]] || [[ -z "$target" ]]; then
  echo "REFUSED: usage: convex-prod.sh run <function> [json] | data <table>" >&2
  exit 2
fi
shift 2

if [[ ! -f "$allow" ]]; then
  echo "REFUSED: allow list missing: $allow" >&2
  exit 2
fi
if ! grep -qxF "$verb $target" "$allow"; then
  echo "REFUSED: '$verb $target' is not in $allow" >&2
  exit 2
fi

envfile="$root/.env.local"
key="$(grep -m1 '^CONVEX_DEPLOY_KEY_PROD_VP=' "$envfile" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
if [[ -z "$key" ]]; then
  echo "REFUSED: CONVEX_DEPLOY_KEY_PROD_VP not found in $envfile" >&2
  exit 2
fi
if [[ "$key" != prod:* ]]; then
  echo "REFUSED: CONVEX_DEPLOY_KEY_PROD_VP is not a prod key" >&2
  exit 2
fi
deployment="${key#prod:}"; deployment="${deployment%%|*}"
echo "deployment: $deployment" >&2

cd "$root"
if [[ "$verb" == "run" ]]; then
  CONVEX_DEPLOY_KEY="$key" npx convex run "$target" "$@"
else
  CONVEX_DEPLOY_KEY="$key" npx convex data "$target" "$@"
fi
