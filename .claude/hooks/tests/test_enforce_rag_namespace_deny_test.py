#!/usr/bin/env python3
"""
Tests for enforce-rag-namespace-deny-test.py

Covers:
  1. block_on_violation  — commit touches convex/auth.ts, no deny test → exit 2
  2. pass_on_valid       — commit touches convex/rag.ts, deny test exists → exit 0
  3. pass_on_override    — commit with override marker → exit 0

Every payload's `cwd` points at a THROWAWAY git repository this suite
creates and destroys — never at the real checkout. This hook reads and
WRITES/scans `<repo>/convex/__tests__/` on disk (see
`_test_file_has_denial` / the "existing test files" scan in the hook's
`main()`): pointing `cwd` at the real checkout means a fixture that
creates/removes a deny-test file there operates on the REAL tracked
tree. That was measured to delete `convex/__tests__/auth-namespace-deny.test.ts`
from the real checkout on every run of this suite before this fix.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(
    os.path.dirname(__file__), "..", "enforce-rag-namespace-deny-test.py"
)
HOOK = os.path.abspath(HOOK)


def _new_temp_repo() -> str:
    """A THROWAWAY git repository, never the real checkout — see module
    docstring. Caller is responsible for `rm -rf` cleanup."""
    tmpdir = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q"], cwd=tmpdir, check=True)
    subprocess.run(["git", "config", "user.email", "t@t.t"], cwd=tmpdir, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=tmpdir, check=True)
    return tmpdir


def _run_hook(command: str, repo: str) -> tuple[int, str]:
    payload = json.dumps(
        {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": repo}
    )
    result = subprocess.run(
        [sys.executable, HOOK],
        input=payload,
        capture_output=True,
        text=True,
    )
    return result.returncode, result.stderr


def _run_hook_with_mock_git(
    command: str, staged_files: list[str], repo: str
) -> tuple[int, str]:
    """Run hook with a mock git binary that returns specified staged files,
    resolved against `repo` (a throwaway repo the CALLER created via
    `_new_temp_repo()` — so a test that needs a file present on disk can
    write it into the SAME repo the hook will scan)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        mock_git = os.path.join(tmpdir, "git")
        # Build a script that returns our staged files for diff --cached --name-only
        staged_output = "\n".join(staged_files)
        mock_script = f"""#!/bin/sh
if echo "$*" | grep -q "diff --cached --name-only"; then
    printf '{staged_output}\\n'
    exit 0
fi
# For all other git calls, delegate to real git
exec /usr/bin/git "$@"
"""
        with open(mock_git, "w") as f:
            f.write(mock_script)
        os.chmod(mock_git, 0o755)

        env = os.environ.copy()
        env["PATH"] = tmpdir + ":" + env.get("PATH", "")

        # `cwd` is a TOP-LEVEL key on the real PreToolUse envelope (verified
        # against every other hook in this repo that resolves it — e.g.
        # block-deploy-without-qa.py, enforce-brief-grep-verify.py,
        # enforce-eta-approval-before-npm-publish.py — all read
        # `data.get("cwd")` off the payload itself, never nested under
        # `tool_input`). `_resolve_repo` in the hook under test reads it the
        # same way and has NO fallback by design: an absent `cwd` is an
        # unreadable subject, refused rather than defaulted. It MUST be a
        # throwaway repo — see module docstring.
        payload = json.dumps(
            {
                "tool_name": "Bash",
                "tool_input": {"command": command},
                "cwd": repo,
            }
        )
        result = subprocess.run(
            [sys.executable, HOOK],
            input=payload,
            capture_output=True,
            text=True,
            env=env,
        )
        return result.returncode, result.stderr


class TestRagNamespaceDenyTest(unittest.TestCase):

    # ── Case 1: block when trigger file staged, no deny test ─────────────────
    def test_block_on_violation_auth_ts_no_deny_test(self):
        """git commit touching convex/auth.ts with no deny test → block."""
        repo = _new_temp_repo()
        try:
            # A fresh throwaway repo has no convex/__tests__/ at all, so the
            # "existing test files on disk" scan is guaranteed empty — this
            # is a hard exit=2 now, not an "either outcome" tolerance.
            code, stderr = _run_hook_with_mock_git(
                "git commit -m 'fix: update auth'",
                staged_files=["convex/auth.ts"],
                repo=repo,
            )
            self.assertEqual(code, 2, f"got {code}. stderr={stderr}")
            self.assertIn("AUTH_NAMESPACE_DENIED", stderr)
            self.assertIn("allow-no-rag-deny-test", stderr)
        finally:
            subprocess.run(["rm", "-rf", repo])

    def test_block_on_violation_ragbundle_no_deny_test(self):
        """git commit touching convex/ragBundle.ts with no deny test → block."""
        repo = _new_temp_repo()
        try:
            code, stderr = _run_hook_with_mock_git(
                "git commit -m 'feat: add rag bundle'",
                staged_files=["convex/ragBundle.ts"],
                repo=repo,
            )
            self.assertEqual(code, 2, f"got {code}. stderr={stderr}")
            self.assertIn("BLOCKED", stderr)
            self.assertIn("AUTH_NAMESPACE_DENIED", stderr)
        finally:
            subprocess.run(["rm", "-rf", repo])

    def test_block_non_trigger_files_not_blocked(self):
        """git commit touching only convex/schema.ts → NOT blocked by this hook."""
        repo = _new_temp_repo()
        try:
            code, _ = _run_hook_with_mock_git(
                "git commit -m 'feat: add table'",
                staged_files=["convex/schema.ts"],
                repo=repo,
            )
            self.assertEqual(code, 0, "Non-trigger files should not be blocked by this hook")
        finally:
            subprocess.run(["rm", "-rf", repo])

    # ── Case 2: pass when deny test is staged alongside trigger file ──────────
    def test_pass_on_valid_deny_test_staged(self):
        """Commit touches convex/auth.ts AND stages a deny test file → pass."""
        repo = _new_temp_repo()
        try:
            tests_dir = os.path.join(repo, "convex", "__tests__")
            os.makedirs(tests_dir, exist_ok=True)

            test_file_rel = "convex/__tests__/auth-namespace-deny.test.ts"
            test_file_abs = os.path.join(repo, test_file_rel)
            test_content = """
import { describe, it, expect } from 'vitest';
describe('auth namespace isolation', () => {
  it('AUTH_NAMESPACE_DENIED — rejects cross-tenant query', async () => {
    await expect(ragQuery({ namespace: 'tenant-B', token: tenantAToken }))
      .rejects.toThrow('AUTH_NAMESPACE_DENIED');
  });
});
"""
            with open(test_file_abs, "w") as f:
                f.write(test_content)

            # Stage the trigger file AND the test file
            code, stderr = _run_hook_with_mock_git(
                "git commit -m 'fix: auth namespace guard'",
                staged_files=["convex/auth.ts", test_file_rel],
                repo=repo,
            )
            self.assertEqual(
                code, 0,
                f"Expected pass when deny test is staged. got {code}. stderr={stderr}",
            )
        finally:
            subprocess.run(["rm", "-rf", repo])

    def test_pass_on_valid_existing_deny_test_on_disk(self):
        """Deny test already exists in convex/__tests__/ (not staged) → pass."""
        repo = _new_temp_repo()
        try:
            tests_dir = os.path.join(repo, "convex", "__tests__")
            os.makedirs(tests_dir, exist_ok=True)

            test_file_abs = os.path.join(tests_dir, "_deny_smoke.test.ts")
            with open(test_file_abs, "w") as f:
                f.write("// cross-tenant deny assertion exists\n")

            # Only trigger file is staged — test is on disk but not staged
            code, stderr = _run_hook_with_mock_git(
                "git commit -m 'fix: rag query'",
                staged_files=["convex/rag.ts"],
                repo=repo,
            )
            self.assertEqual(
                code, 0,
                f"Expected pass: existing deny test on disk. got {code}. stderr={stderr}",
            )
        finally:
            subprocess.run(["rm", "-rf", repo])

    # ── Case 3: pass when override marker is present ──────────────────────────
    def test_pass_on_override_marker(self):
        """git commit with override marker → pass even without deny test."""
        repo = _new_temp_repo()
        try:
            code, stderr = _run_hook_with_mock_git(
                "git commit -m 'refactor: rag internals' # // allow-no-rag-deny-test: refactor-no-new-surface",
                staged_files=["convex/ragBundle.ts"],
                repo=repo,
            )
            self.assertEqual(
                code, 0,
                f"Expected exit 0 (override), got {code}. stderr={stderr}",
            )
        finally:
            subprocess.run(["rm", "-rf", repo])

    def test_pass_on_override_marker_auth(self):
        """Override on auth.ts commit → pass."""
        repo = _new_temp_repo()
        try:
            code, _ = _run_hook_with_mock_git(
                "git commit -m 'chore: update comment // allow-no-rag-deny-test: comment-only'",
                staged_files=["convex/auth.ts"],
                repo=repo,
            )
            self.assertEqual(code, 0)
        finally:
            subprocess.run(["rm", "-rf", repo])

    # ── Non-commit commands always pass ──────────────────────────────────────
    def test_pass_on_non_commit_command(self):
        """Non-git-commit command is not blocked."""
        repo = _new_temp_repo()
        try:
            code, _ = _run_hook("git push origin main", repo=repo)
            self.assertEqual(code, 0)
        finally:
            subprocess.run(["rm", "-rf", repo])

    def test_pass_on_non_bash_tool(self):
        """Non-Bash tool calls are not affected."""
        payload = json.dumps(
            {"tool_name": "Read", "tool_input": {"file_path": "/tmp/x.ts"}}
        )
        result = subprocess.run(
            [sys.executable, HOOK],
            input=payload,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0)

    def test_pass_on_malformed_json(self):
        """Malformed JSON → fail-open."""
        result = subprocess.run(
            [sys.executable, HOOK],
            input="{{bad json",
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
