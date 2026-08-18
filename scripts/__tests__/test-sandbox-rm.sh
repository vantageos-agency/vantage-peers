#!/usr/bin/env bash
# Regression + three-state probe for sandbox-rm.sh.
#
# Founding bug: removing a directory that IS the shell's cwd let rm delete the
# cwd out from under the shell, which then emitted
# "getcwd: cannot access parent directories" and read as exit 1 — a false
# failure on a successful removal. Case 1 pins that closed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
HELPER="$SCRIPT_DIR/../sandbox-rm.sh"

pass=0
total=0

report() { # name expected_pass
  total=$((total + 1))
  if [[ "$2" == "ok" ]]; then
    pass=$((pass + 1))
    echo "PASS: $1"
  else
    echo "FAIL: $1"
  fi
}

# --- Case 1: REGRESSION — target IS the cwd -------------------------------
# Run in a subshell so this test's own cwd survives the rm.
sandbox="$(mktemp -d "${TMPDIR:-/tmp}/sandbox-rm-cwd.XXXXXX")"
out="$(
  cd "$sandbox" || exit 99
  bash "$HELPER" "$sandbox" 2>/tmp/sandbox-rm-cwd.stderr
)"
code=$?
err="$(cat /tmp/sandbox-rm-cwd.stderr)"
rm -f /tmp/sandbox-rm-cwd.stderr
if [[ $code -eq 0 ]] \
   && [[ "$out" == *"REMOVED:"* ]] \
   && [[ "$err" != *"getcwd"* ]] \
   && [[ "$err" != *"cannot access parent directories"* ]] \
   && [[ ! -d "$sandbox" ]]; then
  report "cwd-removal exits 0, REMOVED, no getcwd noise, dir gone" ok
else
  report "cwd-removal exits 0, REMOVED, no getcwd noise, dir gone (code=$code out='$out' err='$err')" fail
fi

# --- Case 2a: normal /tmp sandbox, not the cwd → exit 0 + REMOVED ---------
sandbox2="$(mktemp -d "${TMPDIR:-/tmp}/sandbox-rm-normal.XXXXXX")"
out="$(bash "$HELPER" "$sandbox2" 2>/dev/null)"
code=$?
if [[ $code -eq 0 ]] && [[ "$out" == *"REMOVED:"* ]] && [[ ! -d "$sandbox2" ]]; then
  report "normal sandbox removal exits 0 + REMOVED" ok
else
  report "normal sandbox removal exits 0 + REMOVED (code=$code out='$out')" fail
  rm -rf "$sandbox2"
fi

# --- Case 2b: path OUTSIDE allowed roots → exit 1 + REFUSED, untouched ----
outside="/root/sandbox-rm-should-never-exist-$$"
err="$(bash "$HELPER" "$outside" 2>&1 >/dev/null)"
code=$?
if [[ $code -eq 1 ]] && [[ "$err" == *"REFUSED:"* ]] && [[ ! -e "$outside" ]]; then
  report "outside-root path refused exit 1, nothing touched" ok
else
  report "outside-root path refused exit 1, nothing touched (code=$code err='$err')" fail
fi

# --- Case 2c: no argument → exit 2 ---------------------------------------
err="$(bash "$HELPER" 2>&1 >/dev/null)"
code=$?
if [[ $code -eq 2 ]] && [[ "$err" == *"REFUSING TO JUDGE"* ]]; then
  report "no argument refuses to judge exit 2" ok
else
  report "no argument refuses to judge exit 2 (code=$code err='$err')" fail
fi

echo "----"
echo "$pass/$total passed"
[[ $pass -eq $total ]] || exit 1
exit 0
