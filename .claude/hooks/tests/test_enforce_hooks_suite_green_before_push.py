#!/usr/bin/env python3
"""
Tests for enforce-hooks-suite-green-before-push.py

Two poles, proven independently of the real repo's current state (a
throwaway git repo with a synthetic `.claude/hooks/` is built per test, so
this suite never depends on — or drifts with — the actual failure count of
the real fleet suite):

  1. RED  — a deliberately failing test under a temp repo's `.claude/hooks/`
     blocks `git push` and names the failing file in the refusal.
  2. GREEN — a temp repo whose `.claude/hooks/` suite is fully passing
     allows `git push`.

Also covers the repo-resolution refusal (no `cwd` in the payload) and the
non-push / non-Bash pass-through paths.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(
    os.path.dirname(__file__), "..", "enforce-hooks-suite-green-before-push.py"
)
HOOK = os.path.abspath(HOOK)


def _init_temp_repo(hooks_test_body: str) -> str:
    """Build a throwaway git repo with a `.claude/hooks/` directory
    containing exactly one test file with the given body. Returns the repo
    root (caller is responsible for cleanup)."""
    tmpdir = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q"], cwd=tmpdir, check=True)
    subprocess.run(["git", "config", "user.email", "t@t.t"], cwd=tmpdir, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=tmpdir, check=True)
    hooks_dir = os.path.join(tmpdir, ".claude", "hooks")
    os.makedirs(hooks_dir, exist_ok=True)
    with open(os.path.join(hooks_dir, "test_synthetic.py"), "w") as f:
        f.write(hooks_test_body)
    with open(os.path.join(tmpdir, "README.md"), "w") as f:
        f.write("synthetic repo for enforce-hooks-suite-green-before-push tests\n")
    subprocess.run(["git", "add", "-A"], cwd=tmpdir, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=tmpdir, check=True)
    return tmpdir


def _run_hook(command: str, cwd: str | None) -> tuple[int, str]:
    payload = {"tool_name": "Bash", "tool_input": {"command": command}}
    if cwd is not None:
        payload["cwd"] = cwd
    result = subprocess.run(
        [sys.executable, HOOK],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )
    return result.returncode, result.stdout + result.stderr


class TestHooksSuiteGreenBeforePush(unittest.TestCase):

    # ── Pole 1: RED suite blocks push and names the failing file ─────────
    def test_red_suite_blocks_push_and_names_failure(self):
        repo = _init_temp_repo(
            "def test_deliberately_failing():\n    assert False, 'synthetic'\n"
        )
        try:
            code, out = _run_hook("git push origin main", cwd=repo)
            self.assertEqual(
                code, 2, f"Expected block on red suite. got {code}. out={out}"
            )
            self.assertIn("BLOCKED", out)
            self.assertIn("1 failed", out)
            self.assertIn("test_synthetic.py", out)
        finally:
            subprocess.run(["rm", "-rf", repo])

    # ── Pole 2: GREEN suite allows push ───────────────────────────────────
    def test_green_suite_allows_push(self):
        repo = _init_temp_repo(
            "def test_trivially_passing():\n    assert True\n"
        )
        try:
            code, out = _run_hook("git push origin main", cwd=repo)
            self.assertEqual(
                code, 0, f"Expected pass on green suite. got {code}. out={out}"
            )
        finally:
            subprocess.run(["rm", "-rf", repo])

    # ── Repo resolution: no cwd -> refuse, never a silent pass ────────────
    def test_no_cwd_refuses(self):
        code, out = _run_hook("git push origin main", cwd=None)
        self.assertEqual(code, 2)
        self.assertIn("carried no 'cwd'", out)

    # ── -C / cd chaining -> refuse rather than guess the target repo ─────
    def test_names_unresolved_repo_via_dash_c(self):
        code, out = _run_hook(
            "git -C /some/other/repo push origin main", cwd="/tmp"
        )
        self.assertEqual(code, 2)
        self.assertIn("BLOCKED", out)

    def test_names_unresolved_repo_via_cd_chain(self):
        code, out = _run_hook(
            "cd /some/other/repo && git push origin main", cwd="/tmp"
        )
        self.assertEqual(code, 2)
        self.assertIn("BLOCKED", out)

    # ── Non-push / non-Bash pass-through ───────────────────────────────────
    def test_non_push_command_passes(self):
        code, out = _run_hook("git commit -m 'x'", cwd="/tmp")
        self.assertEqual(code, 0)

    def test_non_bash_tool_passes(self):
        payload = json.dumps(
            {"tool_name": "Read", "tool_input": {"file_path": "/tmp/x"}}
        )
        result = subprocess.run(
            [sys.executable, HOOK], input=payload, capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0)

    def test_malformed_json_fails_open(self):
        result = subprocess.run(
            [sys.executable, HOOK], input="not json", capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
