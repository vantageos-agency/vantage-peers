#!/usr/bin/env python3
"""
PreToolUse hook : enforce tests-green BEFORE `gh pr create` to prevent
paired-teaching sub-agent branch confusion (failing/orphan tests shipped in PRs).

v1.0.0 — Day 92 doctrine, post-paired-teaching #7+ (2026-06-06)

Blocks Bash commands containing `gh pr create` (or `gh pr push -u + create`
chained patterns) unless `npm test` (or the subset declared in the branch's
PR body `tests:` field) passes with ratio 100% green.

Reason — paired-teaching #6 / #7 / #8 root fix:
  Day 92 mission k57a36y8 produced 8 occurrences of the same pattern: sub-agents
  spawned via Workflow tool produce branches that include RED test files cherry-
  picked from sibling tasks but MISS the GREEN+BUILD commits from those siblings.
  Net result: PR with failing tests on creation. Cost: 8 verdicts Eta consumed
  on noise, Pi merge cascade rallongée à chaque iter, risk a broken branch lands.

  This hook intercepts at the point of PR emission so the failure-class is caught
  at write-side rather than discovered at review-side.

  Examples this mission:
    - PR #668 C4 — branch had c0-1-admin-deploy-gate.test.ts RED but no GREEN; 2 tests failed
    - PR #677 C3 — branch had c0-3-bu-repo-gate.test.ts RED but no GREEN; 3 tests failed
    - PR #669 C2 — branch had c0-1 RED orphan; 2 tests failed (resolves on rebase)

  Eta proposal jn7d37fqzqk24nksc04dx240t58843ea — Pi APPROVED jn7att1mqm1smapw12pwega4hh885tz3
  Pi-dispatched task k174wr5x1x1z3dp6ge2k4d1qgh8842vx (urgent, fleet doctrine).

Override discipline:
  Legitimate stacked-PR cases where the RED phase belongs to a sibling PR
  carrying the GREEN+BUILD must use:

    `// allow-red-tests: #<PR-number-of-GREEN-pair>` in PR body
    OR
    `# allow-red-tests: #<PR#>` inline comment in the gh pr create command

  Example PR body:
    feat: B3 onboarding doc + c0-3 RED tests stacked
    // allow-red-tests: #672

  This documents the intentional stack relationship + escapes the test-green gate.
  The reviewer can verify the named GREEN PR actually contains the corresponding
  GREEN commits.

Fast-path (skip):
  - Repos without `package.json` at PR working tree root (no node test surface) → skip
  - Repos with `package.json` but no `test` script → skip with warning
  - User opts out via `# laurent-direct-pr` literal in command → bypass (rare)

Exit 0 = allow
Exit 2 = block (gh pr create aborted, user sees test output + fix guidance)
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

VERSION = "1.0.0"
AUDIT_LOG = "/tmp/enforce-pre-pr-create-tests-green.log"

# ─────────────────────────────────────────────────────────────────────────────
# Patterns
# ─────────────────────────────────────────────────────────────────────────────

# Detect `gh pr create` invocations (single line or chained with &&)
GH_PR_CREATE_RE = re.compile(r"\bgh\s+pr\s+create\b")

# Detect override comments — either in command text or in PR body
ALLOW_RED_TESTS_RE = re.compile(r"(?://|#)\s*allow-red-tests:\s*#?(\d+)", re.IGNORECASE)

# Detect human-direct opt-out (rare)
LAURENT_BYPASS_RE = re.compile(r"#\s*laurent-direct-pr\b", re.IGNORECASE)

# Detect explicit `tests:` field in PR body
PR_BODY_TESTS_FIELD_RE = re.compile(
    r"^tests:\s*(.+)$",
    re.IGNORECASE | re.MULTILINE,
)

# vitest summary line
VITEST_SUMMARY_RE = re.compile(
    r"Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?\s*\((\d+)\)",
)


def log(msg: str) -> None:
    """Append an audit line to /tmp/enforce-pre-pr-create-tests-green.log."""
    ts = datetime.now(timezone.utc).isoformat()
    try:
        with open(AUDIT_LOG, "a") as f:
            f.write(f"[{ts}] {msg}\n")
    except OSError:
        pass  # non-fatal


def get_head_sha(cwd: str | None = None) -> str | None:
    """Resolve `git rev-parse HEAD` in cwd. Returns None (never raises) on any
    failure -- callers treat None as an instrument failure, never as a pass."""
    try:
        r = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=5, cwd=cwd,
        )
        if r.returncode != 0:
            return None
        return r.stdout.strip() or None
    except Exception:
        return None


def find_repo_root() -> str | None:
    """Return git repo root for CWD, or None if not in a repo."""
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=True,
        )
        return r.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def has_node_test_surface(repo_root: str) -> tuple[bool, str | None]:
    """Return (has_tests, test_dir). Walk for package.json with a `test` script."""
    candidates = [
        os.path.join(repo_root, "package.json"),
        os.path.join(repo_root, "mcp-server", "package.json"),
    ]
    for pkg in candidates:
        if not os.path.isfile(pkg):
            continue
        try:
            with open(pkg) as f:
                data = json.load(f)
            if "scripts" in data and "test" in data["scripts"]:
                return True, os.path.dirname(pkg)
        except (OSError, json.JSONDecodeError):
            continue
    return False, None


def extract_pr_body(command: str) -> str:
    """Extract --body content from a `gh pr create` invocation."""
    # Match --body "..." or --body-file path or HEREDOC
    body_str_m = re.search(r'--body\s+(["\'])(.*?)\1', command, re.DOTALL)
    if body_str_m:
        return body_str_m.group(2)
    body_file_m = re.search(r"--body-file\s+(\S+)", command)
    if body_file_m:
        path = body_file_m.group(1).strip("'\"")
        if os.path.isfile(path):
            try:
                with open(path) as f:
                    return f.read()
            except OSError:
                return ""
    return ""


class InstrumentFailure(Exception):
    """Raised when the test-run instrument could not produce a verdict at
    all (timeout, exec failure, tree moved mid-run). NAMED, never collapsed
    into a 0-failed/0-passed green-looking or red-looking result."""


def run_tests_pinned(
    test_dir: str, repo_root: str, subset: str | None = None
) -> tuple[bool, int, int, int, str, str]:
    """
    Run `npm test` (or subset) in test_dir, and verify the tree did not move
    under the run (v1.1.0 -- replaces the 180s-expiry-as-measurement defect).
    Return (all_green, passed, failed, skipped, raw_output_tail, tree_sha).

    Raises InstrumentFailure(message) when the run measured NOTHING usable:
    HEAD unresolvable before/after, timeout, or exec error. A timeout is a
    "REFUSING TO JUDGE", never a "0 failed 0 passed" result.
    """
    pre_sha = get_head_sha(repo_root)
    if not pre_sha:
        raise InstrumentFailure(
            f"REFUSING TO JUDGE: git HEAD ({repo_root}) -- could not resolve the "
            "tree SHA before running tests"
        )

    env = os.environ.copy()
    env["VP_TEST_MODE"] = "1"  # opt-in CI hook env vars
    cmd = ["npm", "test"] if not subset else ["npx", "vitest", "run", subset]
    try:
        r = subprocess.run(
            cmd, cwd=test_dir, capture_output=True, text=True,
            timeout=180, env=env,
        )
    except subprocess.TimeoutExpired:
        raise InstrumentFailure(
            "REFUSING TO JUDGE: test run (npm test in "
            f"{test_dir}) -- timed out after 180s testing tree {pre_sha}; "
            "180 seconds of silence is not a measurement, it is the absence "
            "of one -- it must not be rendered as 0 failed 0 passed"
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        raise InstrumentFailure(
            f"REFUSING TO JUDGE: test run (npm test in {test_dir}) -- could not "
            f"execute: {e}"
        )

    post_sha = get_head_sha(repo_root)
    if not post_sha:
        raise InstrumentFailure(
            f"REFUSING TO JUDGE: git HEAD ({repo_root}) -- could not resolve the "
            "tree SHA after running tests"
        )
    if post_sha != pre_sha:
        raise InstrumentFailure(
            f"MISMATCH: tests ran against tree {pre_sha}, but HEAD moved to "
            f"{post_sha} during the run -- this result does not pin the commit "
            "being shipped by gh pr create"
        )

    output = (r.stdout + r.stderr)[-4000:]
    m = VITEST_SUMMARY_RE.search(output)
    if not m:
        # Fallback: parse exit code only
        all_green = (r.returncode == 0)
        return all_green, 0, 0, 0, output, post_sha
    failed = int(m.group(1) or 0)
    passed = int(m.group(2) or 0)
    skipped = int(m.group(3) or 0)
    all_green = (failed == 0 and r.returncode == 0)
    return all_green, passed, failed, skipped, output, post_sha


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0  # fail-open on malformed payload — don't block valid usage

    tool_name = payload.get("tool_name", "")
    if tool_name != "Bash":
        return 0

    command = payload.get("tool_input", {}).get("command", "")
    if not GH_PR_CREATE_RE.search(command):
        return 0

    log(f"INTERCEPT gh pr create — command(first 200): {command[:200]!r}")

    # Bypass: Laurent direct
    if LAURENT_BYPASS_RE.search(command):
        log("BYPASS laurent-direct-pr — allow")
        return 0

    # Locate repo + test surface
    repo_root = find_repo_root()
    if not repo_root:
        log("SKIP not in git repo — allow")
        return 0

    has_tests, test_dir = has_node_test_surface(repo_root)
    if not has_tests or test_dir is None:
        log(f"SKIP no node test surface at {repo_root} — allow")
        return 0

    # Inspect PR body for override + tests subset directive
    pr_body = extract_pr_body(command)
    override_match = ALLOW_RED_TESTS_RE.search(command) or ALLOW_RED_TESTS_RE.search(pr_body)
    subset_match = PR_BODY_TESTS_FIELD_RE.search(pr_body)
    subset = subset_match.group(1).strip() if subset_match else None

    # Run tests
    log(f"RUN tests in {test_dir} (subset={subset or 'full suite'})")
    try:
        all_green, passed, failed, skipped, output_tail, tree_sha = run_tests_pinned(
            test_dir, repo_root, subset
        )
    except InstrumentFailure as exc:
        log(f"REFUSE {exc}")
        print(
            f"[enforce-pre-pr-create-tests-green v{VERSION}] {exc}\n"
            "\n"
            "This is not a pass and not a red-tests block: the instrument that "
            "must measure test-green-ness for this tree could not do so. Fix the "
            "instrument (rerun, resolve git state, or investigate the timeout) -- "
            "do not reinterpret this as either a pass or a fixed number of "
            "failing tests.\n"
            f"Audit log: {AUDIT_LOG}",
            file=sys.stderr,
        )
        return 2

    if all_green:
        log(f"PASS {passed} passed, {skipped} skipped, tree={tree_sha} — allow")
        return 0

    # Tests red — check override
    if override_match:
        green_pair_pr = override_match.group(1)
        log(f"OVERRIDE allow-red-tests:#{green_pair_pr} — allow (red tests intentional stack)")
        print(
            f"[enforce-pre-pr-create-tests-green v{VERSION}] "
            f"OVERRIDE accepted: red tests acknowledged as stacked on PR #{green_pair_pr}. "
            f"Reviewer will verify #{green_pair_pr} carries the GREEN pair.",
            file=sys.stderr,
        )
        return 0

    # Block
    log(f"BLOCK {failed} tests failed, {passed} passed, {skipped} skipped")
    print(
        f"[enforce-pre-pr-create-tests-green v{VERSION}] BLOCKED.\n"
        f"\n"
        f"`gh pr create` requires tests-green at branch HEAD, but {failed} tests are failing.\n"
        f"\n"
        f"Test summary (working dir {test_dir}):\n"
        f"  {failed} failed | {passed} passed | {skipped} skipped\n"
        f"\n"
        f"Output tail (last 4kb):\n"
        f"{output_tail}\n"
        f"\n"
        f"Fix options:\n"
        f"  1. Fix the failing tests on this branch before `gh pr create`.\n"
        f"  2. If the red tests are intentionally stacked (RED phase awaiting a GREEN sibling PR),\n"
        f"     add to your PR body:\n"
        f"         // allow-red-tests: #<PR-number-of-GREEN-pair>\n"
        f"     The reviewer will verify the named PR actually contains the GREEN+BUILD commits.\n"
        f"  3. If you genuinely need to bypass (rare), append `# laurent-direct-pr` to the command.\n"
        f"\n"
        f"Doctrine: paired-teaching #6/#7/#8 root fix (Day 92 mission k57a36y8).\n"
        f"Audit log: {AUDIT_LOG}",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
