#!/usr/bin/env bash
# Portable probe for block-deploy-without-qa.py.
# Repo-relative only (REPO derived from `git rev-parse --show-toplevel`).
# Runs the OLD baseline and the NEW (tracked) guard by PIPING the tool-call
# JSON into `python3 <hook>` -- no tracked file is ever overwritten, no
# `git checkout` is ever required to restore. Proof: `git diff --stat` stays
# empty across the whole run.
#
# BREADCRUMB PATH NOTE: block-deploy-without-qa.py hardcodes
# BREADCRUMB = "/tmp/.qa-passed" with no env/arg override (read the file --
# it is a bare module constant). Per the brief's own escape clause ("if you
# must use a witness path the corrected guard reads ... document why the
# fixed path is unavoidable"): this probe uses that exact fixed path, but
# SAVES any pre-existing content before each case and RESTORES it in a trap
# on exit, so a peer's real /tmp/.qa-passed is never permanently clobbered by
# a probe run.
set -uo pipefail
REPO="$(git rev-parse --show-toplevel)"
OLD="$REPO/qa/probes/baseline/block-deploy-without-qa.old.py"
NEW="$REPO/.claude/hooks/block-deploy-without-qa.py"

BREADCRUMB="/tmp/.qa-passed"
BREADCRUMB_SAVE="$(mktemp -u)"
CMD='cd '"$REPO"' && npx convex deploy --prod'

save_breadcrumb() {
  if [ -e "$BREADCRUMB" ]; then
    cp -p "$BREADCRUMB" "$BREADCRUMB_SAVE"
  fi
}
restore_breadcrumb() {
  chmod 644 "$BREADCRUMB" 2>/dev/null || true
  rm -f "$BREADCRUMB"
  if [ -e "$BREADCRUMB_SAVE" ]; then
    cp -p "$BREADCRUMB_SAVE" "$BREADCRUMB"
    rm -f "$BREADCRUMB_SAVE"
  fi
}
trap restore_breadcrumb EXIT

run_hook() {
  # $1 = hook path to run (OLD or NEW). Both OLD and NEW import the shared
  # `_lib.command_predicate` module (fleet-wide dedup, unrelated to the
  # age->commit-pin substitution under test); it lives only next to the
  # tracked NEW file (.claude/hooks/_lib/), so PYTHONPATH points there for
  # BOTH runs -- this does not touch the substitution being probed.
  local out
  out="$(echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"$CMD\"}}" \
    | PYTHONPATH="$REPO/.claude/hooks:${PYTHONPATH:-}" python3 "$1" 2>&1)"
  local rc=$?
  echo "exit=$rc"
  echo "$out"
}

assert_landed() {
  # $1 = marker to grep for in the NEW (tracked) hook file -- proves the
  # substitution actually landed before we trust its verdict.
  local marker="$1"
  if grep -q "$marker" "$NEW"; then
    echo "MUTATION-LANDED: grep '$marker' $NEW -> FOUND"
  else
    echo "MUTATION-LANDED: grep '$marker' $NEW -> MISSING (probe invalid)"
    exit 1
  fi
}

assert_fixture_landed() {
  # $1 = path the fixture was written to; proves the injected breadcrumb
  # actually exists on disk before trusting the verdict that reads it.
  local path="$1"
  if [ -e "$path" ]; then
    echo "FIXTURE-LANDED: $path -> FOUND"
  else
    echo "FIXTURE-LANDED: $path -> MISSING (probe invalid)"
    exit 1
  fi
}

HEAD_SHA=$(git -C "$REPO" rev-parse HEAD)
OTHER_SHA=$(git -C "$REPO" rev-parse HEAD~3)

save_breadcrumb

case "$1" in
  must_block)
    echo "=== MUST_BLOCK: recent evidence pinning ANOTHER commit ($OTHER_SHA), shipping $HEAD_SHA ==="
    python3 -c "import json; json.dump({'sha':'$OTHER_SHA','writer':'probe'}, open('$BREADCRUMB','w'))"
    assert_fixture_landed "$BREADCRUMB"
    echo "--- RED-BEFORE (OLD baseline guard, today's pre-fix behavior) ---"
    run_hook "$OLD"
    assert_landed "qa_pins_shipped_commit"
    echo "--- GREEN-AFTER (NEW, tracked, corrected guard) ---"
    run_hook "$NEW"
    ;;
  must_pass)
    echo "=== MUST_PASS: OLD evidence pinning THIS commit ($HEAD_SHA) ==="
    assert_landed "qa_pins_shipped_commit"
    python3 -c "import json; json.dump({'sha':'$HEAD_SHA','writer':'probe'}, open('$BREADCRUMB','w'))"
    assert_fixture_landed "$BREADCRUMB"
    old=$(( $(date +%s) - 18000 ))
    touch -d "@$old" "$BREADCRUMB" 2>/dev/null || touch -t "$(date -d "@$old" +%Y%m%d%H%M.%S)" "$BREADCRUMB"
    run_hook "$NEW"
    ;;
  must_refuse_no_evidence)
    echo "=== MUST_REFUSE (a): no evidence at all ==="
    assert_landed "qa_pins_shipped_commit"
    rm -f "$BREADCRUMB"
    run_hook "$NEW"
    ;;
  must_refuse_unreadable)
    echo "=== MUST_REFUSE (b): instrument failure -- breadcrumb unreadable ==="
    assert_landed "qa_pins_shipped_commit"
    echo '{"sha":"'"$HEAD_SHA"'","writer":"probe"}' > "$BREADCRUMB"
    assert_fixture_landed "$BREADCRUMB"
    chmod 000 "$BREADCRUMB"
    run_hook "$NEW"
    chmod 644 "$BREADCRUMB"
    ;;
  forbidden)
    echo "=== FORBIDDEN: no evidence, but a title/commit-phrase in the command ==="
    assert_landed "qa_pins_shipped_commit"
    rm -f "$BREADCRUMB"
    CMD='cd '"$REPO"' && npx convex deploy --prod # docs: QA passed, all good, tests 311/314 green'
    run_hook "$NEW"
    ;;
  *)
    echo "usage: $0 {must_block|must_pass|must_refuse_no_evidence|must_refuse_unreadable|forbidden}" >&2
    exit 3
    ;;
esac
