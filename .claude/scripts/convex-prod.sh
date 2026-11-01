#!/usr/bin/env bash
# convex-prod.sh — run an allow-listed Convex prod function or table read.
#
# Usage:
#   convex-prod.sh run <function> [<json-object>]
#   convex-prod.sh data <table> [--limit <digits>] [--format <format>]
#
# Verbs: run and data only. There is no deploy verb on purpose: a deploy goes
# through `npx convex deploy` and its own authorization guards.
# The allowed entries live in convex-prod.allow beside this script, one
# "run <function>" or "data <table>" per line. Anything unlisted is refused.
# The arguments after the target are a closed grammar, checked before the key
# is read: `run` takes at most one positional, which must be a JSON object;
# `data` takes only --limit <digits> and
# --format <jsonArray|json|jsonLines|jsonl|pretty>. Any other argument
# (--push, --prod, --identity, --component, a second positional...) is refused,
# so no flag can turn an allowed call into a push of local code to prod.
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

refuse_arg() { echo "REFUSED: $1" >&2; exit 2; }

if [[ "$verb" == "run" ]]; then
  if (( $# > 1 )); then refuse_arg "$2"; fi
  if (( $# == 1 )); then
    # Must open with "{" (so it can never read as a flag) and parse as an object.
    if [[ "$1" != "{"* ]] || ! node -e '
      const v = JSON.parse(process.argv[1]);
      process.exit(v !== null && typeof v === "object" && !Array.isArray(v) ? 0 : 1);
    ' "$1" >/dev/null 2>&1; then
      refuse_arg "$1"
    fi
  fi
else
  rest=("$@")
  i=0
  while (( i < ${#rest[@]} )); do
    flag="${rest[$i]}"; val="${rest[$((i + 1))]:-}"
    case "$flag" in
      --limit)
        [[ "$val" =~ ^[0-9]+$ ]] || refuse_arg "$flag ${val:-<missing>}" ;;
      --format)
        case "$val" in
          jsonArray|json|jsonLines|jsonl|pretty) ;;
          *) refuse_arg "$flag ${val:-<missing>}" ;;
        esac ;;
      *) refuse_arg "$flag" ;;
    esac
    i=$((i + 2))
  done
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
