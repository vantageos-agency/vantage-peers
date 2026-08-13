#!/usr/bin/env bash
# Portable probe for enforce-pre-pr-create-tests-green.py.
# Repo-relative only. OLD baseline / NEW tracked guard run by piping the
# tool-call JSON to `python3 <file>` against a DISPOSABLE git repo created
# under mktemp -- no repo mutation of $REPO itself, cleaned up on exit.
set -uo pipefail
REPO="$(git rev-parse --show-toplevel)"
OLD="$REPO/qa/probes/baseline/enforce-pre-pr-create-tests-green.old.py"
NEW="$REPO/.claude/hooks/enforce-pre-pr-create-tests-green.py"

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

setup_repo() {
  rm -rf "$WORK/repo"
  mkdir -p "$WORK/repo"
  git -C "$WORK/repo" init -q
  git -C "$WORK/repo" config user.email probe@example.com
  git -C "$WORK/repo" config user.name probe
  cat > "$WORK/repo/package.json" << 'EOF'
{"name":"probe3-pkg","scripts":{"test":"true"}}
EOF
  git -C "$WORK/repo" add -A
  git -C "$WORK/repo" commit -qm "init"
}

assert_landed() {
  # $1 = hook path  $2 = marker
  local hook="$1" marker="$2"
  if grep -q "$marker" "$hook"; then
    echo "MUTATION-LANDED: grep '$marker' $hook -> FOUND"
  else
    echo "MUTATION-LANDED: grep '$marker' $hook -> MISSING (probe invalid)"
    exit 1
  fi
}

assert_fixture_landed() {
  # $1 = path that must exist on disk before trusting the verdict
  local path="$1"
  if [ -e "$path" ]; then
    echo "FIXTURE-LANDED: $path -> FOUND"
  else
    echo "FIXTURE-LANDED: $path -> MISSING (probe invalid)"
    exit 1
  fi
}

run_hook() {
  # $1 = hook path  $2 = command
  local hook="$1" cmd="$2" out rc
  out="$( (cd "$WORK/repo" && echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"$cmd\"}}" | python3 "$hook" 2>&1) )"
  rc=$?
  echo "exit=$rc"
  echo "$out"
}

case "$1" in
  must_block)
    echo "=== MUST_BLOCK: HEAD moves mid-run (tree no longer pins what's shipped) ==="
    setup_repo
    # scripts.test commits DURING the run, simulating a mid-run tree mutation
    # (e.g. a concurrent sub-agent commit) -- by the time gh pr create fires,
    # the run has "measured" a tree that is no longer HEAD.
    cat > "$WORK/repo/package.json" << 'EOF'
{"name":"probe3-pkg","scripts":{"test":"date +%s%N > drift.txt && git add -A && git commit -qm drift"}}
EOF
    git -C "$WORK/repo" add -A && git -C "$WORK/repo" commit -qm "wire drift test"
    assert_fixture_landed "$WORK/repo/package.json"
    echo "--- RED-BEFORE (OLD baseline guard) ---"
    run_hook "$OLD" "gh pr create --title x --body y"
    assert_landed "$NEW" "run_tests_pinned"
    echo "--- GREEN-AFTER (NEW, tracked, corrected guard) ---"
    run_hook "$NEW" "gh pr create --title x --body y"
    ;;
  must_pass)
    echo "=== MUST_PASS: tests genuinely green, tree stable (SHA-stability check must not false-positive) ==="
    setup_repo
    assert_fixture_landed "$WORK/repo/package.json"
    assert_landed "$NEW" "run_tests_pinned"
    run_hook "$NEW" "gh pr create --title x --body y"
    ;;
  must_refuse_timeout)
    echo "=== MUST_REFUSE (a): test run times out -- must NOT render as '0 failed 0 passed' ==="
    setup_repo
    cat > "$WORK/repo/package.json" << 'EOF'
{"name":"probe3-pkg","scripts":{"test":"sleep 5"}}
EOF
    git -C "$WORK/repo" add -A && git -C "$WORK/repo" commit -qm "slow test"
    assert_fixture_landed "$WORK/repo/package.json"
    assert_landed "$NEW" "run_tests_pinned"
    # Patch a throwaway copy with a 2s timeout to keep the probe fast, exercising
    # the SAME code path (InstrumentFailure on TimeoutExpired), not the literal 180s wait.
    python3 - "$NEW" > "$WORK/fast_timeout.py" << 'PYEOF'
import sys
c = open(sys.argv[1]).read()
c = c.replace("timeout=180, env=env,", "timeout=2, env=env,")
sys.stdout.write(c)
PYEOF
    assert_fixture_landed "$WORK/fast_timeout.py"
    run_hook "$WORK/fast_timeout.py" "gh pr create --title x --body y"
    ;;
  must_refuse_head_unreadable)
    echo "=== MUST_REFUSE (b): instrument failure -- HEAD unresolvable (unborn HEAD, no commits yet) ==="
    rm -rf "$WORK/repo"
    mkdir -p "$WORK/repo"
    git -C "$WORK/repo" init -q
    git -C "$WORK/repo" config user.email probe@example.com
    git -C "$WORK/repo" config user.name probe
    cat > "$WORK/repo/package.json" << 'EOF'
{"name":"probe3-pkg","scripts":{"test":"true"}}
EOF
    # deliberately NOT committed: repo root resolves (find_repo_root works),
    # but `git rev-parse HEAD` fails (unborn HEAD, no commits) -- the
    # instrument (git HEAD) cannot be read, distinct from "not a git repo".
    assert_fixture_landed "$WORK/repo/package.json"
    assert_landed "$NEW" "run_tests_pinned"
    run_hook "$NEW" "gh pr create --title x --body y"
    ;;
  forbidden)
    echo "=== FORBIDDEN: red tests, PR body claims override without naming a real GREEN PR ==="
    setup_repo
    cat > "$WORK/repo/package.json" << 'EOF'
{"name":"probe3-pkg","scripts":{"test":"echo 'Tests 1 failed | 0 passed (1)'; exit 1"}}
EOF
    git -C "$WORK/repo" add -A && git -C "$WORK/repo" commit -qm "red test"
    assert_fixture_landed "$WORK/repo/package.json"
    assert_landed "$NEW" "run_tests_pinned"
    run_hook "$NEW" "gh pr create --title 'docs: all green tests pass QA verified' --body 'everything is fine, merged, 311/314'"
    ;;
  *)
    echo "usage: $0 {must_block|must_pass|must_refuse_timeout|must_refuse_head_unreadable|forbidden}" >&2
    exit 3
    ;;
esac
