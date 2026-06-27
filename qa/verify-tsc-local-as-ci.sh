#!/usr/bin/env bash
# Day-111 friction fix — local tsc baseline noise vs CI ground truth.
#
# Symptom: `npx tsc --noEmit` locally shows TS2345 cascading through
# convex/__tests__/*.ts (convexTest(schema, modules) SchemaDefinition variance),
# while CI on the same commit reports 0 errors. Root cause: convex/_generated/*
# is stale post-pull; CI runs fresh checkout + bun install + convex codegen.
#
# This script mirrors the CI environment locally so `tsc --noEmit` verdict
# matches CI exactly.
#
# Usage:
#   bash qa/verify-tsc-local-as-ci.sh           # full refresh + tsc
#   bash qa/verify-tsc-local-as-ci.sh --quick   # skip node_modules refresh, regenerate codegen only
#   bash qa/verify-tsc-local-as-ci.sh --no-tsc  # refresh only, skip the tsc step (smoke for codegen)
#
# Exit codes:
#   0 — tsc clean (matches CI green)
#   1 — tsc has errors (matches CI red)
#   2 — environment / step failure before tsc could run
#
# Idempotent: safe to run repeatedly. Each invocation regenerates _generated/.
#
# Ref: friction task k17bb9571a2q8bem63r5g0stcn895sjm + Eta msg k974phk040c27jfq9yzbsq34gn894s45.

set -euo pipefail

MODE=full
RUN_TSC=1
for arg in "$@"; do
  case "$arg" in
    --quick) MODE=quick ;;
    --no-tsc) RUN_TSC=0 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "verify-tsc-local-as-ci: unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "verify-tsc-local-as-ci: mode=$MODE run_tsc=$RUN_TSC repo=$REPO_ROOT"

if [[ "$MODE" == "full" ]]; then
  echo "verify-tsc-local-as-ci: STEP 1/3 — rm -rf node_modules convex/_generated"
  rm -rf node_modules convex/_generated
  echo "verify-tsc-local-as-ci: STEP 2/3 — bun install --frozen-lockfile"
  if ! command -v bun >/dev/null 2>&1; then
    echo "verify-tsc-local-as-ci: bun not found in PATH — aborting" >&2
    exit 2
  fi
  bun install --frozen-lockfile
else
  echo "verify-tsc-local-as-ci: STEP 1/3 — skip node_modules refresh (quick mode)"
  echo "verify-tsc-local-as-ci: STEP 2/3 — rm -rf convex/_generated only"
  rm -rf convex/_generated
fi

echo "verify-tsc-local-as-ci: STEP 3a — regenerate convex/_generated via convex codegen"
if ! npx convex codegen >/tmp/verify-tsc-codegen.log 2>&1; then
  echo "verify-tsc-local-as-ci: convex codegen FAILED — see /tmp/verify-tsc-codegen.log" >&2
  tail -20 /tmp/verify-tsc-codegen.log >&2
  exit 2
fi

if [[ "$RUN_TSC" -eq 0 ]]; then
  echo "verify-tsc-local-as-ci: --no-tsc requested — environment refreshed, exiting clean"
  exit 0
fi

echo "verify-tsc-local-as-ci: STEP 3b — npx tsc --noEmit"
if npx tsc --noEmit; then
  echo "verify-tsc-local-as-ci: tsc CLEAN — matches CI green"
  exit 0
else
  status=$?
  echo "verify-tsc-local-as-ci: tsc has errors — matches CI red verdict (exit $status)"
  exit 1
fi
