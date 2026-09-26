#!/usr/bin/env python3
"""
The `.claude/hooks` test suite must leave the repository it runs in
byte-for-byte untouched. This is a standing property, not a nicety: this
suite exercises hooks whose whole job is reading and (for
enforce-rag-namespace-deny-test.py) scanning `convex/__tests__/` on disk —
if a fixture ever points a hook's `cwd` at the REAL repository instead of a
throwaway one it creates and destroys, that hook's own subprocess `git`
calls, file reads and file writes/removes land on the REAL tracked tree.

Measured before this test existed: `_run_hook_with_mock_git` in both
`test_enforce_mcp_tool_coverage_schema_mirror.py` and
`test_enforce_rag_namespace_deny_test.py` pointed `cwd` at the real
checkout (`WORKSPACE = "/root/coding/vantage-memory"`), and two fixtures in
the latter wrote/removed `convex/__tests__/*.test.ts` files there —
including `convex/__tests__/auth-namespace-deny.test.ts`, a real
cross-tenant deny test, deleted by every run of that suite. A push gate
that runs this suite on every push would have propagated that deletion to
every push, silently, behind a green suite.

This test runs the REST of the suite as a subprocess (never itself — that
would recurse) against the repository IT is running in, and asserts
`git status --porcelain` is identical before and after. It intentionally
does NOT reach into any other worktree/checkout — it only ever inspects
the repository the test process's own cwd resolves to, which is exactly
the repository any real invocation of this suite (including the new
`enforce-hooks-suite-green-before-push.py` push gate) would be pointed at.
"""
import os
import subprocess
import sys
import unittest

THIS_FILE = os.path.abspath(__file__)
HOOKS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _repo_root() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        timeout=10,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"could not resolve the repository this test runs in: {result.stderr!r}"
        )
    return result.stdout.strip()


def _porcelain(repo: str) -> str:
    result = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=10,
    )
    if result.returncode != 0:
        raise RuntimeError(f"git status --porcelain failed: {result.stderr!r}")
    return result.stdout


class TestSuiteLeavesRealRepoUntouched(unittest.TestCase):
    def test_full_hooks_suite_has_no_side_effect_on_the_repo(self):
        repo = _repo_root()
        before = _porcelain(repo)

        result = subprocess.run(
            [
                sys.executable, "-m", "pytest",
                HOOKS_DIR,
                "--ignore", THIS_FILE,
                "-q",
            ],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=300,
        )

        after = _porcelain(repo)

        self.assertEqual(
            before, after,
            "The .claude/hooks suite modified the repository it ran in.\n"
            f"Before:\n{before!r}\n"
            f"After:\n{after!r}\n"
            f"pytest exit={result.returncode}\n"
            f"pytest stdout tail:\n{result.stdout[-3000:]}\n"
            f"pytest stderr tail:\n{result.stderr[-1000:]}\n",
        )
        # The suite itself must also have been green — a side-effect check
        # that passes over a red run proves nothing.
        self.assertEqual(
            result.returncode, 0,
            f"The suite under inspection was not green: {result.stdout[-2000:]}",
        )


if __name__ == "__main__":
    unittest.main()
