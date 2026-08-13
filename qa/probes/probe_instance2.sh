#!/usr/bin/env bash
# Portable probe for enforce-eta-approval-before-npm-publish.py.
# Repo-relative only. Runs OLD baseline / NEW tracked guard by piping the
# tool-call JSON to `python3 <file>` -- no cp-over-tracked-hook, no git checkout.
set -uo pipefail
REPO="$(git rev-parse --show-toplevel)"
OLD="$REPO/qa/probes/baseline/enforce-eta-approval-before-npm-publish.old.py"
NEW="$REPO/.claude/hooks/enforce-eta-approval-before-npm-publish.py"

assert_landed() {
  # $1 = marker to grep for in the NEW (tracked) hook file.
  local marker="$1"
  if grep -q "$marker" "$NEW"; then
    echo "MUTATION-LANDED: grep '$marker' $NEW -> FOUND"
  else
    echo "MUTATION-LANDED: grep '$marker' $NEW -> MISSING (probe invalid)"
    exit 1
  fi
}

assert_fixture_landed() {
  # $1 = description  $2 = the mock JSON payload that must be non-empty.
  if [ -n "${2:-}" ]; then
    echo "FIXTURE-LANDED: $1 -> FOUND ($(echo "$2" | wc -c) bytes)"
  else
    echo "FIXTURE-LANDED: $1 -> MISSING (probe invalid)"
    exit 1
  fi
}

HEAD_SHA=$(git -C "$REPO" rev-parse HEAD)
OTHER_SHA=$(git -C "$REPO" rev-parse HEAD~3)

run_hook() {
  # $1 = hook path  $2 = command  $3 = mock comments JSON
  local out
  out="$(echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"$2\"},\"cwd\":\"$REPO\"}" \
    | ETA_APPROVAL_HOOK_TEST_MOCK_COMMENTS="$3" python3 "$1" 2>&1)"
  local rc=$?
  echo "exit=$rc"
  echo "$out"
}

mk_comment() {
  # $1=sha $2=created_at_iso
  echo "[{\"body\":\"Eta APPROVED. ETA_APPROVED_COMMIT_SHA: $1\",\"user\":{\"login\":\"elpiarthera\"},\"created_at\":\"$2\"}]"
}

case "$1" in
  must_block)
    echo "=== MUST_BLOCK: recent PR-comment evidence pinning ANOTHER commit ($OTHER_SHA), shipping $HEAD_SHA ==="
    NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    MOCK=$(mk_comment "$OTHER_SHA" "$NOW_ISO")
    assert_fixture_landed "mock approval comment pinning $OTHER_SHA" "$MOCK"
    CMD="npm publish @vantageos/probe-package # eta-approved-pr: 999 # eta-approved-sha: $OTHER_SHA"
    echo "--- RED-BEFORE (OLD baseline guard) ---"
    run_hook "$OLD" "$CMD" "$MOCK"
    assert_landed "the AGE gate is gone"
    echo "--- GREEN-AFTER (NEW, tracked, corrected guard) ---"
    run_hook "$NEW" "$CMD" "$MOCK"
    ;;
  must_pass)
    echo "=== MUST_PASS: OLD (2h) PR-comment evidence pinning THIS commit ($HEAD_SHA) ==="
    OLD_ISO=$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)
    MOCK=$(mk_comment "$HEAD_SHA" "$OLD_ISO")
    assert_fixture_landed "mock approval comment pinning $HEAD_SHA (2h old)" "$MOCK"
    CMD="npm publish @vantageos/probe-package # eta-approved-pr: 999 # eta-approved-sha: $HEAD_SHA"
    assert_landed "the AGE gate is gone"
    run_hook "$NEW" "$CMD" "$MOCK"
    ;;
  must_refuse_no_evidence)
    echo "=== MUST_REFUSE (a): no evidence -- no PR/SHA tokens at all ==="
    assert_landed "the AGE gate is gone"
    run_hook "$NEW" "npm publish @vantageos/probe-package" "[]"
    ;;
  must_refuse_instrument)
    echo "=== MUST_REFUSE (b): instrument failure -- GitHub API unreachable (gh forced unreachable, no mock) ==="
    assert_landed "the AGE gate is gone"
    CMD="npm publish @vantageos/probe-package # eta-approved-pr: 999 # eta-approved-sha: $HEAD_SHA"
    # No ETA_APPROVAL_HOOK_TEST_MOCK_COMMENTS set -> real `gh api` path is used;
    # PATH stripped of `gh` (but python3 kept, via its absolute path) so the
    # CLI itself is genuinely unreachable (instrument failure), not the interpreter.
    PY3="$(command -v python3)"
    local_out="$(echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"$CMD\"},\"cwd\":\"$REPO\"}" \
      | env -i PATH=/nonexistent HOME="$HOME" "$PY3" "$NEW" 2>&1)"
    rc=$?
    echo "exit=$rc"
    echo "$local_out"
    ;;
  forbidden)
    echo "=== FORBIDDEN: PR title/body prose claims approval, but no qualifying comment ==="
    assert_landed "the AGE gate is gone"
    CMD="npm publish @vantageos/probe-package # eta-approved-pr: 999 # eta-approved-sha: $HEAD_SHA"
    MOCK="[{\"body\":\"docs: all tests green, QA passed, merged and APPROVED for release, 311/314\",\"user\":{\"login\":\"random-troll\"},\"created_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}]"
    assert_fixture_landed "wrong-author prose comment" "$MOCK"
    run_hook "$NEW" "$CMD" "$MOCK"
    ;;
  *)
    echo "usage: $0 {must_block|must_pass|must_refuse_no_evidence|must_refuse_instrument|forbidden}" >&2
    exit 3
    ;;
esac
