#!/usr/bin/env bash
# Bipolar test for scripts/post-deploy-probe.mjs (task k179zpdjs4m7h7xfgn4yn84j8n8heqke).
#
# Founding defect: on 2026-11-02, 15 live seat tokens could not write their own
# namespace while every suite, both doctors and the review were green. Nothing looked
# at live connections. The probe is that instrument; this test pins its three outcomes:
#   PASS (0)  FAIL (1)  COULD-NOT-JUDGE (2)
# against a local stub MCP server (fixtures/post-deploy-probe-stub.mjs). No network
# beyond 127.0.0.1 and no real credential: the "bearers" are fake strings in a temp dir.
#
# Override the script under test with PROBE=<path>.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROBE="${PROBE:-$SCRIPT_DIR/../post-deploy-probe.mjs}"
STUB="$SCRIPT_DIR/fixtures/post-deploy-probe-stub.mjs"

pass=0
total=0
tmp="$(mktemp -d "${TMPDIR:-/tmp}/post-deploy-probe-test.XXXXXX")"
stub_pid=""
cleanup() {
  [[ -n "$stub_pid" ]] && kill "$stub_pid" 2>/dev/null
  rm -rf "$tmp"
}
trap cleanup EXIT

printf 'bearer-a\n' >"$tmp/a.bearer"
printf 'bearer-b\n' >"$tmp/b.bearer"
chmod 600 "$tmp/a.bearer" "$tmp/b.bearer"

start_stub() { # <mode>
  rm -f "$tmp/port"
  STUB_MODE="$1" node "$STUB" "$tmp/port" &
  stub_pid=$!
  local i
  for i in $(seq 1 50); do
    [[ -s "$tmp/port" ]] && return 0
    sleep 0.1
  done
  echo "stub did not start" >&2
  return 1
}
stop_stub() {
  [[ -n "$stub_pid" ]] && kill "$stub_pid" 2>/dev/null
  wait "$stub_pid" 2>/dev/null
  stub_pid=""
}

# run_case <name> <stub-mode|none> <expected-exit> <expected-summary-word> [bearer-a-path]
run_case() {
  local name="$1" mode="$2" want_exit="$3" want_word="$4" bearer_a="${5:-$tmp/a.bearer}"
  local url out rc last
  total=$((total + 1))
  if [[ "$mode" == "none" ]]; then
    url="http://127.0.0.1:1/mcp" # nothing listens on port 1
  else
    start_stub "$mode" || { echo "FAIL  $name (stub)"; return; }
    url="http://127.0.0.1:$(cat "$tmp/port")/mcp"
  fi
  out="$(VP_PROBE_MCP_URL="$url" VP_PROBE_BEARER_A="$bearer_a" VP_PROBE_BEARER_B="$tmp/b.bearer" \
    node "$PROBE" 2>&1)"
  rc=$?
  last="$(printf '%s\n' "$out" | grep -E '^POST-DEPLOY-PROBE:' | tail -1)"
  [[ "$mode" != "none" ]] && stop_stub
  if [[ "$rc" == "$want_exit" && "$last" == "POST-DEPLOY-PROBE: $want_word"* ]]; then
    echo "ok    $name (exit $rc)"
    pass=$((pass + 1))
  else
    echo "FAIL  $name: want exit $want_exit / '$want_word', got exit $rc / '${last:-<no summary line>}'"
    printf '%s\n' "$out" | sed 's/^/      | /' | head -20
  fi
  # a bearer value must never reach the output
  if printf '%s' "$out" | grep -q 'bearer-[ab]'; then
    total=$((total + 1))
    echo "FAIL  $name: a credential value appeared in the output"
  fi
}

run_case "stub admits own, refuses other -> PASS" ok 0 PASS
run_case "stateless server (no session id), healthy -> PASS" stateless 0 PASS
run_case "stub admits other -> FAIL" admit-other 1 FAIL
run_case "stub refuses own -> FAIL" refuse-own 1 FAIL
run_case "stub leaks the other org's row on read -> FAIL" leak-read 1 FAIL
run_case "own send refused with RBAC_DENIED -> FAIL" send-refused-own 1 FAIL
run_case "unreadable credential -> COULD-NOT-JUDGE" ok 2 COULD-NOT-JUDGE "$tmp/does-not-exist.bearer"
run_case "whoami fails -> COULD-NOT-JUDGE" whoami-fails 2 COULD-NOT-JUDGE
run_case "MCP unreachable -> COULD-NOT-JUDGE" none 2 COULD-NOT-JUDGE

echo "$pass/$total passed"
[[ "$pass" == "$total" ]]
