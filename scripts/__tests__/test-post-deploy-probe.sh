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
printf 'bearer-a2\n' >"$tmp/a2.bearer"
printf 'bearer-b2\n' >"$tmp/b2.bearer"
: >"$tmp/empty.bearer"
chmod 600 "$tmp"/*.bearer
# The second-agent credential files. Absent unless a case switches them on, and always set
# explicitly so a developer's real ~/.config files can never leak into a run.
A2="$tmp/absent-a2.bearer"
B2="$tmp/absent-b2.bearer"
two_agents() { A2="$tmp/a2.bearer"; B2="$tmp/b2.bearer"; }
one_agent() { A2="$tmp/absent-a2.bearer"; B2="$tmp/absent-b2.bearer"; }

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

# run_case <name> <stub-mode|none> <expected-exit> <expected-summary-word> [bearer-a-path] [must-match-regex]
run_case() {
  local name="$1" mode="$2" want_exit="$3" want_word="$4" bearer_a="${5:-$tmp/a.bearer}" must="${6:-}"
  local url out rc last
  total=$((total + 1))
  if [[ "$mode" == "none" ]]; then
    url="http://127.0.0.1:1/mcp" # nothing listens on port 1
  else
    start_stub "$mode" || { echo "FAIL  $name (stub)"; return; }
    url="http://127.0.0.1:$(cat "$tmp/port")/mcp"
  fi
  out="$(VP_PROBE_MCP_URL="$url" VP_PROBE_BEARER_A="$bearer_a" VP_PROBE_BEARER_B="$tmp/b.bearer" \
    VP_PROBE_BEARER_A2="$A2" VP_PROBE_BEARER_B2="$B2" \
    node "$PROBE" 2>&1)"
  rc=$?
  last="$(printf '%s\n' "$out" | grep -E '^POST-DEPLOY-PROBE:' | tail -1)"
  [[ "$mode" != "none" ]] && stop_stub
  if [[ -n "$must" ]] && ! printf '%s\n' "$out" | grep -Eq "$must"; then
    echo "FAIL  $name: output does not match /$must/"
    printf '%s\n' "$out" | sed 's/^/      | /' | head -20
    return
  fi
  if [[ "$rc" == "$want_exit" && "$last" == "POST-DEPLOY-PROBE: $want_word"* ]]; then
    echo "ok    $name (exit $rc)"
    pass=$((pass + 1))
  else
    echo "FAIL  $name: want exit $want_exit / '$want_word', got exit $rc / '${last:-<no summary line>}'"
    printf '%s\n' "$out" | sed 's/^/      | /' | head -20
  fi
  # a bearer value must never reach the output
  if printf '%s' "$out" | grep -q 'bearer-[ab]2\?'; then
    total=$((total + 1))
    echo "FAIL  $name: a credential value appeared in the output"
  fi
}

# --- single-agent fallback (no second credential): announced, never silent ---
run_case "no second credential -> PASS, per-org NOTE line announces the fallback" ok 0 PASS "$tmp/a.bearer" 'NOTE +probe-tenant-a: SINGLE-AGENT FALLBACK, no second-agent credential'
run_case "no second credential -> PASS, summary line announces the fallback" ok 0 PASS "$tmp/a.bearer" '^POST-DEPLOY-PROBE: PASS .*SINGLE-AGENT FALLBACK for probe-tenant-a, probe-tenant-b: in-org send delivery NOT tested'
run_case "stub admits own, refuses other -> PASS" ok 0 PASS
run_case "stateless server (no session id), healthy -> PASS" stateless 0 PASS
run_case "stub admits other -> FAIL" admit-other 1 FAIL
run_case "stub refuses own -> FAIL" refuse-own 1 FAIL
run_case "stub leaks the other org's row on read -> FAIL" leak-read 1 FAIL
run_case "read-back returns the right id with WRONG content -> FAIL" wrong-readback 1 FAIL
run_case "read-back returns the right content under a WRONG id -> FAIL" wrong-id 1 FAIL
run_case "cross-org write refused with an untyped error -> FAIL" untyped-write 1 FAIL
run_case "cross-org send refused with an untyped error -> FAIL" untyped-send 1 FAIL
run_case "cross-org read refused with an untyped error -> FAIL" untyped-read 1 FAIL
run_case "own send refused with RBAC_DENIED -> FAIL" send-refused-own 1 FAIL
run_case "unreadable credential -> COULD-NOT-JUDGE" ok 2 COULD-NOT-JUDGE "$tmp/does-not-exist.bearer"
run_case "whoami fails -> COULD-NOT-JUDGE" whoami-fails 2 COULD-NOT-JUDGE
run_case "MCP unreachable -> COULD-NOT-JUDGE" none 2 COULD-NOT-JUDGE

# --- recurring tasks (fix #1673): own create/pause/resume/delete read back, foreign refused ---
run_case "recurring: healthy -> PASS, summary names the recurring poles" ok 0 PASS "$tmp/a.bearer" 'recurring tasks: own create/pause/resume/delete read back'
run_case "recurring: own pole prints ok lines for pause, resume, delete" ok 0 PASS "$tmp/a.bearer" 'ok +probe-tenant-a delete_recurring_task'
run_case "recurring: foreign pause/delete ACCEPTED -> FAIL" recurring-admit-foreign 1 FAIL "$tmp/a.bearer" 'FAIL +probe-tenant-b pause_recurring_task'
run_case "recurring: delete refused -> FAIL and a CLEANUP line with the id" recurring-delete-refused 1 FAIL "$tmp/a.bearer" 'CLEANUP probe-tenant-a recurring-task rec'
run_case "recurring: delete answers ok but the row stays -> FAIL, CLEANUP line" recurring-delete-noop 1 FAIL "$tmp/a.bearer" 'CLEANUP probe-tenant-a recurring-task rec'
run_case "recurring: row without an org stamp -> FAIL" recurring-no-org-stamp 1 FAIL
run_case "recurring: MCP unreachable -> COULD-NOT-JUDGE, never PASS" none 2 COULD-NOT-JUDGE

# --- two agents per org: in-org send DELIVERED and read back by the recipient ---
two_agents
run_case "two agents, healthy -> PASS, delivered and read back by recipient" ok 0 PASS "$tmp/a.bearer" 'delivered and read back by the recipient'
run_case "two agents: send accepted but never reaches the inbox -> FAIL" no-delivery 1 FAIL
run_case "two agents: inbox shows a different message -> FAIL" wrong-inbox 1 FAIL
run_case "two agents: right body but wrong sender id in the inbox -> FAIL" wrong-sender 1 FAIL
run_case "two agents: send to own second agent refused -> FAIL" send-second-refused 1 FAIL
run_case "two agents: second credential resolves to the primary's agent -> COULD-NOT-JUDGE" second-is-primary 2 COULD-NOT-JUDGE
run_case "two agents: admits cross-org -> FAIL" admit-other 1 FAIL
run_case "two agents: delete refused -> still PASS, message id listed for cleanup" delete-refused 0 PASS "$tmp/a.bearer" 'CLEANUP .*message msg'
A2="$tmp/empty.bearer"
run_case "second credential present but empty -> COULD-NOT-JUDGE (not a silent fallback)" ok 2 COULD-NOT-JUDGE
one_agent

echo "$pass/$total passed"
[[ "$pass" == "$total" ]]
