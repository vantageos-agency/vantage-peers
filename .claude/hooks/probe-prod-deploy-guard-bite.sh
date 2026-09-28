#!/usr/bin/env bash
# probe-prod-deploy-guard-bite.sh — does the prod-deploy guard BITE, here, now?
#
# Identity, name and location never prove a guard bites. Only executing it
# against a known bypass does (`hook-vitality-bite-probe` doctrine). A hash
# comparison against the catalogue proves the BYTES arrived; this proves the
# body RUNS on this station and reaches three distinguishable answers.
#
# The three states this probe pins (task k1781ttkpcy2mhhmp3qwz3zjcd8f9kd5):
#   A. the store was READ and the token does not authorize  -> reason task-invalid
#   B. the store was READ and names no such task            -> reason token-absent
#   C. the store could NOT be read                          -> verdict refuse-to-judge
#
# B and C must never be spelled the same way. The Day-158 fleet outage was
# exactly that collapse: the guard read `tasks:get` ANONYMOUSLY, so every
# token -- valid, forged or absent -- came back `task-unreadable-or-absent`
# with `caller: null`, and every authorized production deploy on every station
# was refused. A probe that only checks "does it refuse" would have passed
# throughout the outage. This one fails, because it asserts WHICH refusal.
#
# All three states exit 2: only 2 stops the tool call under the hook protocol,
# so a refusal exiting anything else would be an ALLOW wearing another name.
# They are separated where the operator READS them -- the audit log's `reason`
# and `verdict`, and the stderr prefix ("BLOCKED:" vs "COULD NOT CHECK:").
#
# This probe deliberately does NOT assert the ALLOW pole. ALLOW requires a
# genuine, unexpired, Pi-issued [PROD-DEPLOY-AUTHORIZED] task, and minting one
# to satisfy a test would forge a production-deploy authorization. Pole A --
# a real task that is NOT a token -- is the honest substitute: reaching
# `task-invalid` proves the read SUCCEEDED as an identified caller, which is
# the precise thing the outage broke.
#
# Nothing is deployed. The guard is a decision function over stdin; the probe
# feeds it text and reads its verdict. No convex command is ever executed.
#
# Usage:
#   probe-prod-deploy-guard-bite.sh <guard.py> <a-real-task-id> [credentialed-dotenv]
# Exit: 0 all poles distinguishable, 1 a pole is wrong or indistinguishable.

set -uo pipefail

GUARD="${1:?usage: $0 <guard.py> <real-task-id> [credentialed-dotenv]}"
REAL_TASK="${2:?a task id that EXISTS but is not an authorization token}"
CRED_ENV="${3:-}"

[[ -f "$GUARD" ]] || { echo "[error] no guard at $GUARD" >&2; exit 1; }

LOG="$(mktemp -t pi-auth-probe-XXXXXX.log)"
# A dotenv that is real but holds no credential: forces the unreadable-store
# pole deterministically, without unsetting anything the operator relies on.
EMPTY_ENV="$(mktemp -t probe-no-cred-XXXXXX.env)"
trap 'rm -f "$LOG" "$EMPTY_ENV"' EXIT

failures=0

# Run one pole and report the verdict+reason the guard actually recorded.
# The audit log is read rather than stderr parsed: the log is the guard's own
# structured answer, and it is what an operator reviews after the fact.
probe() {
  local label="$1" task="$2" envfile="$3" want_verdict="$4" want_reason="$5"
  : > "$LOG"
  local payload
  printf -v payload '{"tool_name":"Bash","tool_input":{"command":"npx convex deploy --yes # pi-authorized: %s"}}' "$task"
  local stderr_file
  stderr_file="$(mktemp)"
  VP_GUARD_AUDIT_LOG="$LOG" VP_GUARD_ENV_FILE="$envfile" \
    timeout 120 python3 "$GUARD" <<<"$payload" >/dev/null 2>"$stderr_file"
  local rc=$?
  local got_verdict got_reason
  got_verdict="$(python3 -c 'import json,sys;print(json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])["verdict"])' "$LOG" 2>/dev/null || echo "<no-audit-line>")"
  got_reason="$(python3 -c 'import json,sys;print(json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])["reason"])' "$LOG" 2>/dev/null || echo "<no-audit-line>")"

  local ok=1
  # Every state must stop the call. A refusal that does not exit 2 is an ALLOW.
  [[ "$rc" == "2" ]] || ok=0
  [[ "$got_verdict" == "$want_verdict" ]] || ok=0
  [[ "$got_reason" == "$want_reason" ]] || ok=0

  if [[ "$ok" == "1" ]]; then
    echo "PASS  $label  exit=$rc verdict=$got_verdict reason=$got_reason"
  else
    echo "FAIL  $label  exit=$rc (want 2) verdict=$got_verdict (want $want_verdict) reason=$got_reason (want $want_reason)" >&2
    echo "      stderr: $(head -1 "$stderr_file")" >&2
    failures=$((failures + 1))
  fi
  rm -f "$stderr_file"
}

echo "guard:  $GUARD"
echo "sha256: $(sha256sum "$GUARD" | cut -d' ' -f1)"
echo

if [[ -n "$CRED_ENV" && -f "$CRED_ENV" ]]; then
  probe "A read-succeeded/not-a-token " "$REAL_TASK"                          "$CRED_ENV"  "block"          "task-invalid"
  probe "B read-succeeded/no-such-task" "k00000000000000000000000000000000"   "$CRED_ENV"  "block"          "token-absent"
else
  echo "SKIP  A,B — no credentialed dotenv given; the store cannot be read from here," >&2
  echo "      so 'read succeeded' cannot be observed. Not-looked-at is reported, never" >&2
  echo "      printed as a pass. Pass the dotenv holding CLERK_SERVICE_ACCOUNT_USER_ID." >&2
  failures=$((failures + 1))
fi

probe   "C store-unreadable          " "$REAL_TASK"                          "$EMPTY_ENV" "refuse-to-judge" "token-read-could-not-be-completed"

echo
if [[ "$failures" == "0" ]]; then
  echo "BITE CONFIRMED — three states, all distinguishable at the output."
  exit 0
fi
echo "BITE NOT CONFIRMED — $failures pole(s) wrong or unobserved." >&2
exit 1
