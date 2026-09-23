#!/usr/bin/env bash
# Bipolar probe: enforce-mcp-tool-coverage-schema-mirror.py and
# enforce-rag-namespace-deny-test.py must judge the commit being made in
# THE CALLER'S OWN cwd (a git worktree, resolved via `git rev-parse
# --show-toplevel`) — never the hardcoded main-checkout WORKSPACE, whose
# index is empty for a commit staged in a worktree.
#
# Runs against a REAL temporary git repository with a REAL `git worktree
# add` checkout, created and torn down by this script. Never touches the
# live repo's index.
#
# Usage:
#   .claude/hooks/probe-hooks-read-the-commit-being-made.sh
#
# Exit code: 0 if every pole matches its expected verdict, 1 otherwise.
# Each pole's actual exit code is printed so a failing run is diagnosable
# without re-deriving the fixture.
set -uo pipefail

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_HOOK="$HOOKS_DIR/enforce-mcp-tool-coverage-schema-mirror.py"
RAG_HOOK="$HOOKS_DIR/enforce-rag-namespace-deny-test.py"

TMP_ROOT="$(mktemp -d /tmp/probe-hooks-cwd.XXXXXX)"
MAIN_REPO="$TMP_ROOT/main"
WORKTREE="$TMP_ROOT/worktree"

FAILURES=0
PASSES=0

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }
pass() { echo "  pass: $1"; PASSES=$((PASSES + 1)); }

check_exit() {
  # check_exit <label> <expected> <actual> <captured-output-file>
  local label="$1" expected="$2" actual="$3" outfile="$4"
  echo "--- $label ---"
  echo "expected exit=$expected  actual exit=$actual"
  sed 's/^/    /' "$outfile"
  if [ "$actual" -eq "$expected" ]; then
    pass "$label"
  else
    fail "$label (expected $expected, got $actual)"
  fi
}

run_hook() {
  # run_hook <hook.py> <payload-json-file>  -> writes stdout+stderr to $2.out, exit code to $2.rc
  local hook="$1" payload_file="$2"
  local out_file="${payload_file}.out"
  python3 "$hook" < "$payload_file" > "$out_file" 2>&1
  echo $? > "${payload_file}.rc"
}

# ---------------------------------------------------------------------
# Build the real temporary repo + worktree
# ---------------------------------------------------------------------
mkdir -p "$MAIN_REPO"
git -C "$MAIN_REPO" init -q -b main
git -C "$MAIN_REPO" config user.email "probe@example.com"
git -C "$MAIN_REPO" config user.name "Probe"
mkdir -p "$MAIN_REPO/convex" "$MAIN_REPO/mcp-server/src/tools" "$MAIN_REPO/convex/__tests__"
echo "// seed schema" > "$MAIN_REPO/convex/schema.ts"
echo "// seed tools index" > "$MAIN_REPO/mcp-server/src/tools/index.ts"
echo "// seed auth" > "$MAIN_REPO/convex/auth.ts"
git -C "$MAIN_REPO" add -A
git -C "$MAIN_REPO" commit -q -m "seed"

git -C "$MAIN_REPO" worktree add -q -b probe-branch "$WORKTREE" main

echo "================================================================"
echo "Fixture: main repo    = $MAIN_REPO"
echo "Fixture: worktree     = $WORKTREE"
echo "================================================================"

# =======================================================================
# POLE SET A — enforce-mcp-tool-coverage-schema-mirror.py
# =======================================================================
echo
echo "### Pole 1 — worktree commit VIOLATES (schema.ts staged, no mcp-server/src/tools/ file, no override) -> exit 2"
echo "// schema change $(date +%s)" >> "$WORKTREE/convex/schema.ts"
git -C "$WORKTREE" add convex/schema.ts
P1="$TMP_ROOT/p1.json"
python3 - "$WORKTREE" > "$P1" <<'PYEOF'
import json, sys
cwd = sys.argv[1]
print(json.dumps({
    "tool_name": "Bash",
    "tool_input": {"command": 'git commit -m "feat: add table"'},
    "cwd": cwd,
}))
PYEOF
run_hook "$SCHEMA_HOOK" "$P1"
check_exit "Pole 1 (schema-mirror, VIOLATES)" 2 "$(cat "$P1.rc")" "$P1.out"

echo
echo "### Pole 2 — worktree commit CONFORMS (mirror file staged too) -> exit 0"
echo "// mirror tool $(date +%s)" >> "$WORKTREE/mcp-server/src/tools/newentity.ts"
git -C "$WORKTREE" add mcp-server/src/tools/newentity.ts
P2="$TMP_ROOT/p2.json"
python3 - "$WORKTREE" > "$P2" <<'PYEOF'
import json, sys
cwd = sys.argv[1]
print(json.dumps({
    "tool_name": "Bash",
    "tool_input": {"command": 'git commit -m "feat: add table with tool"'},
    "cwd": cwd,
}))
PYEOF
run_hook "$SCHEMA_HOOK" "$P2"
check_exit "Pole 2 (schema-mirror, CONFORMS)" 0 "$(cat "$P2.rc")" "$P2.out"

# Unstage the mirror file, leaving schema.ts staged alone, to test the override marker cleanly.
git -C "$WORKTREE" reset -q mcp-server/src/tools/newentity.ts

echo
echo "### Pole 3 — worktree commit carries override marker in message -> exit 0"
P3="$TMP_ROOT/p3.json"
python3 - "$WORKTREE" > "$P3" <<'PYEOF'
import json, sys
cwd = sys.argv[1]
print(json.dumps({
    "tool_name": "Bash",
    "tool_input": {"command": 'git commit -m "refactor: rename field // allow-schema-mirror-skip: no-new-entity"'},
    "cwd": cwd,
}))
PYEOF
run_hook "$SCHEMA_HOOK" "$P3"
check_exit "Pole 3 (schema-mirror, OVERRIDE)" 0 "$(cat "$P3.rc")" "$P3.out"

echo
echo "### Pole 4 — cwd outside any repository -> exit 2, naming the path"
OUTSIDE_DIR="$TMP_ROOT/not-a-repo"
mkdir -p "$OUTSIDE_DIR"
P4="$TMP_ROOT/p4.json"
python3 - "$OUTSIDE_DIR" > "$P4" <<'PYEOF'
import json, sys
cwd = sys.argv[1]
print(json.dumps({
    "tool_name": "Bash",
    "tool_input": {"command": 'git commit -m "feat: add table"'},
    "cwd": cwd,
}))
PYEOF
run_hook "$SCHEMA_HOOK" "$P4"
check_exit "Pole 4 (schema-mirror, cwd outside repo)" 2 "$(cat "$P4.rc")" "$P4.out"
if ! grep -q "$OUTSIDE_DIR" "$P4.out"; then
  fail "Pole 4 output does not name the offending path $OUTSIDE_DIR"
else
  pass "Pole 4 output names the offending path"
fi

# =======================================================================
# POLE SET B — enforce-rag-namespace-deny-test.py (same shape, its own trigger/override)
# =======================================================================
echo
echo "### Pole 5a — worktree commit VIOLATES rag-deny-test (auth.ts staged, no deny test, no override) -> exit 2"
echo "// auth change $(date +%s)" >> "$WORKTREE/convex/auth.ts"
git -C "$WORKTREE" add convex/auth.ts
P5A="$TMP_ROOT/p5a.json"
python3 - "$WORKTREE" > "$P5A" <<'PYEOF'
import json, sys
cwd = sys.argv[1]
print(json.dumps({
    "tool_name": "Bash",
    "tool_input": {"command": 'git commit -m "fix: auth org scoping"'},
    "cwd": cwd,
}))
PYEOF
run_hook "$RAG_HOOK" "$P5A"
check_exit "Pole 5a (rag-deny-test, VIOLATES)" 2 "$(cat "$P5A.rc")" "$P5A.out"

echo
echo "### Pole 5b — worktree commit CONFORMS (deny test staged) -> exit 0"
mkdir -p "$WORKTREE/convex/__tests__"
cat > "$WORKTREE/convex/__tests__/rag-namespace-deny.test.ts" <<'EOF'
it("AUTH_NAMESPACE_DENIED — rejects cross-tenant deny query", async () => {});
EOF
git -C "$WORKTREE" add convex/__tests__/rag-namespace-deny.test.ts
P5B="$TMP_ROOT/p5b.json"
python3 - "$WORKTREE" > "$P5B" <<'PYEOF'
import json, sys
cwd = sys.argv[1]
print(json.dumps({
    "tool_name": "Bash",
    "tool_input": {"command": 'git commit -m "fix: auth org scoping with deny test"'},
    "cwd": cwd,
}))
PYEOF
run_hook "$RAG_HOOK" "$P5B"
check_exit "Pole 5b (rag-deny-test, CONFORMS)" 0 "$(cat "$P5B.rc")" "$P5B.out"

git -C "$WORKTREE" reset -q convex/__tests__/rag-namespace-deny.test.ts

echo
echo "### Pole 5c — worktree commit carries override marker -> exit 0"
P5C="$TMP_ROOT/p5c.json"
python3 - "$WORKTREE" > "$P5C" <<'PYEOF'
import json, sys
cwd = sys.argv[1]
print(json.dumps({
    "tool_name": "Bash",
    "tool_input": {"command": 'git commit -m "fix: auth org scoping # // allow-no-rag-deny-test: no-auth-surface-changed"'},
    "cwd": cwd,
}))
PYEOF
run_hook "$RAG_HOOK" "$P5C"
check_exit "Pole 5c (rag-deny-test, OVERRIDE)" 0 "$(cat "$P5C.rc")" "$P5C.out"

echo
echo "### Pole 5d — cwd outside any repository -> exit 2, naming the path"
P5D="$TMP_ROOT/p5d.json"
python3 - "$OUTSIDE_DIR" > "$P5D" <<'PYEOF'
import json, sys
cwd = sys.argv[1]
print(json.dumps({
    "tool_name": "Bash",
    "tool_input": {"command": 'git commit -m "fix: auth org scoping"'},
    "cwd": cwd,
}))
PYEOF
run_hook "$RAG_HOOK" "$P5D"
check_exit "Pole 5d (rag-deny-test, cwd outside repo)" 2 "$(cat "$P5D.rc")" "$P5D.out"
if ! grep -q "$OUTSIDE_DIR" "$P5D.out"; then
  fail "Pole 5d output does not name the offending path $OUTSIDE_DIR"
else
  pass "Pole 5d output names the offending path"
fi

# =======================================================================
# Poles 6 and 7 — the payload carries NO `cwd` KEY AT ALL.
#
# Found by the reviewer, not by the author of the fix. The first version of
# this repair fell back to a hardcoded repository path in exactly this case,
# which is the ORIGINAL defect through a second door: a real repository is
# judged, just not the one being committed to. Every one of the eight payload
# builders above writes the key, so nothing here watched this path — the
# omission could not be seen by a probe that never omits it.
#
# The objection that the runtime always sends `cwd` is precisely the
# assumption that left the first door open for months. An absent key is an
# unreadable subject, and an unreadable subject is a refusal.
#
# The SUBJECT is a real violating tree, so a pass here would be a pass on a
# genuine violation and not on an empty diff.
# =======================================================================
echo
echo "### Poles 6 and 7 — payload with NO cwd key -> exit 2 on both hooks"
P6="$TMP_ROOT/p6.json"
python3 - > "$P6" <<'PYEOF'
import json
# Deliberately NO "cwd" key. Not empty — absent.
print(json.dumps({
    "tool_name": "Bash",
    "tool_input": {"command": 'git commit -m "feat: add table"'},
}))
PYEOF

run_hook "$SCHEMA_HOOK" "$P6"
check_exit "Pole 6 (schema-mirror, payload has no cwd key)" 2 "$(cat "$P6.rc")" "$P6.out"

run_hook "$RAG_HOOK" "$P6"
check_exit "Pole 7 (rag-deny-test, payload has no cwd key)" 2 "$(cat "$P6.rc")" "$P6.out"

# =======================================================================
# Poles 8-13 — the TRIGGER itself, not the body.
#
# Every payload above (Poles 1-7) carries a BARE `git commit -m "…"` —
# the only shape the pre-fix anchored regex (`^\s*git\s+commit\b`) ever
# matched. That means Poles 1-7 prove the hooks' BODY (what they decide
# once they fire) and say NOTHING about whether they RUN on the ordinary
# shape a subagent commits from inside a git worktree: `cd <repo> &&
# git commit ...` or `git -C <repo> commit ...`. Measured against the
# unmodified hooks at this branch's merge-base: both shapes returned
# exit 0 — a SILENT PASS — on a genuinely staged RULE #24 / rag-deny-test
# violation, in the same breath as a bare `git commit -m x` on the SAME
# violating tree returning exit 2 (BLOCKED). The gate was alive and the
# tree really violated; it simply never looked. Poles 8-11 pin the fix:
# fail-closed REFUSAL (exit 2, distinct message) whenever a command both
# invokes `git commit` and names a repository the hook did not resolve
# from the payload's own `cwd`. Poles 12-13 pin the false-positive guard:
# a commit MESSAGE that merely mentions "cd" or "git commit" in quotes
# must still be judged NORMALLY, never refused.
#
# The WORKTREE fixture, at this point in the script, already carries a
# real unresolved violation on BOTH hooks simultaneously: convex/schema.ts
# is staged with no mcp-server/src/tools/ file staged (Poles 1-4's state,
# untouched since), and convex/auth.ts is staged with no deny test staged
# (Poles 5a-5d's state, untouched since). Reused as-is — no restaging.
# =======================================================================
echo
echo "### Pole 8 — schema-mirror, 'cd <repo> && git commit' on a REAL violation -> must NOT be exit 0"
P8="$TMP_ROOT/p8.json"
python3 - "$WORKTREE" > "$P8" <<'PYEOF'
import json, sys
cwd = sys.argv[1]
print(json.dumps({
    "tool_name": "Bash",
    "tool_input": {"command": f'cd {cwd} && git commit -m x'},
    "cwd": cwd,
}))
PYEOF
run_hook "$SCHEMA_HOOK" "$P8"
check_exit "Pole 8 (schema-mirror, cd-chained commit, REFUSED not silently passed)" 2 "$(cat "$P8.rc")" "$P8.out"

echo
echo "### Pole 9 — schema-mirror, 'git -C <repo> commit' on a REAL violation -> must NOT be exit 0"
P9="$TMP_ROOT/p9.json"
python3 - "$WORKTREE" > "$P9" <<'PYEOF'
import json, sys
cwd = sys.argv[1]
print(json.dumps({
    "tool_name": "Bash",
    "tool_input": {"command": f'git -C {cwd} commit -m x'},
    "cwd": cwd,
}))
PYEOF
run_hook "$SCHEMA_HOOK" "$P9"
check_exit "Pole 9 (schema-mirror, -C flagged commit, REFUSED not silently passed)" 2 "$(cat "$P9.rc")" "$P9.out"

echo
echo "### Pole 10 — rag-deny-test, 'cd <repo> && git commit' on a REAL violation -> must NOT be exit 0"
P10="$TMP_ROOT/p10.json"
python3 - "$WORKTREE" > "$P10" <<'PYEOF'
import json, sys
cwd = sys.argv[1]
print(json.dumps({
    "tool_name": "Bash",
    "tool_input": {"command": f'cd {cwd} && git commit -m x'},
    "cwd": cwd,
}))
PYEOF
run_hook "$RAG_HOOK" "$P10"
check_exit "Pole 10 (rag-deny-test, cd-chained commit, REFUSED not silently passed)" 2 "$(cat "$P10.rc")" "$P10.out"

echo
echo "### Pole 11 — rag-deny-test, 'git -C <repo> commit' on a REAL violation -> must NOT be exit 0"
P11="$TMP_ROOT/p11.json"
python3 - "$WORKTREE" > "$P11" <<'PYEOF'
import json, sys
cwd = sys.argv[1]
print(json.dumps({
    "tool_name": "Bash",
    "tool_input": {"command": f'git -C {cwd} commit -m x'},
    "cwd": cwd,
}))
PYEOF
run_hook "$RAG_HOOK" "$P11"
check_exit "Pole 11 (rag-deny-test, -C flagged commit, REFUSED not silently passed)" 2 "$(cat "$P11.rc")" "$P11.out"

echo
echo "### Pole 12 — schema-mirror, message MENTIONS 'cd'/'git commit' in quotes on a CONFORMING tree -> exit 0"
echo "// mirror tool re-add $(date +%s)" >> "$WORKTREE/mcp-server/src/tools/newentity.ts"
git -C "$WORKTREE" add mcp-server/src/tools/newentity.ts
P12="$TMP_ROOT/p12.json"
python3 - "$WORKTREE" > "$P12" <<'PYEOF'
import json, sys
cwd = sys.argv[1]
print(json.dumps({
    "tool_name": "Bash",
    "tool_input": {"command": 'git commit -m "fix: cd into the dir and git commit"'},
    "cwd": cwd,
}))
PYEOF
run_hook "$SCHEMA_HOOK" "$P12"
check_exit "Pole 12 (schema-mirror, quoted mention is NOT mistaken for a real cd/second commit)" 0 "$(cat "$P12.rc")" "$P12.out"
git -C "$WORKTREE" reset -q mcp-server/src/tools/newentity.ts

echo
echo "### Pole 13 — rag-deny-test, message MENTIONS 'cd'/'git commit' in quotes on a CONFORMING tree -> exit 0"
cat > "$WORKTREE/convex/__tests__/rag-namespace-deny.test.ts" <<'EOF'
it("AUTH_NAMESPACE_DENIED — rejects cross-tenant deny query", async () => {});
EOF
git -C "$WORKTREE" add convex/__tests__/rag-namespace-deny.test.ts
P13="$TMP_ROOT/p13.json"
python3 - "$WORKTREE" > "$P13" <<'PYEOF'
import json, sys
cwd = sys.argv[1]
print(json.dumps({
    "tool_name": "Bash",
    "tool_input": {"command": 'git commit -m "fix: cd into the dir and git commit"'},
    "cwd": cwd,
}))
PYEOF
run_hook "$RAG_HOOK" "$P13"
check_exit "Pole 13 (rag-deny-test, quoted mention is NOT mistaken for a real cd/second commit)" 0 "$(cat "$P13.rc")" "$P13.out"
git -C "$WORKTREE" reset -q convex/__tests__/rag-namespace-deny.test.ts

echo
echo "================================================================"
echo "RESULT: $PASSES pass, $FAILURES fail"
echo "================================================================"

if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
exit 0
