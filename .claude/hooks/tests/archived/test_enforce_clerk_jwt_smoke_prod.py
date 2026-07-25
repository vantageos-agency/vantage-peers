#!/usr/bin/env python3
"""
Tests for enforce-clerk-jwt-smoke-prod.py

Covers:
  1. block_on_violation  — PROD command issued, no smoke report → exit 2
  2. pass_on_valid       — PROD command issued, smoke report exists → exit 0
  3. pass_on_override    — PROD command with override marker → exit 0
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(
    os.path.dirname(__file__), "..", "enforce-clerk-jwt-smoke-prod.py"
)
HOOK = os.path.abspath(HOOK)


def _run_hook(command: str, env_override: dict | None = None) -> tuple[int, str]:
    payload = json.dumps(
        {"tool_name": "Bash", "tool_input": {"command": command}}
    )
    env = os.environ.copy()
    if env_override:
        env.update(env_override)
    result = subprocess.run(
        [sys.executable, HOOK],
        input=payload,
        capture_output=True,
        text=True,
        env=env,
    )
    return result.returncode, result.stderr


class TestClerkJwtSmokeProd(unittest.TestCase):

    # ── Case 1: block when PROD command is issued and no smoke report exists ──
    def test_block_on_violation_git_push_main(self):
        """git push origin main with no qa/clerk-jwt-smoke-<sha>.json → block."""
        # We deliberately do NOT create the smoke report, so this should block
        # (the hook looks for qa/clerk-jwt-smoke-<sha>.json in WORKSPACE).
        # Since we're running from the real workspace where no such file exists
        # for the current SHA (in CI/test), this should return exit 2.
        # We use a temp dir as workspace substitute by patching via env not
        # needed — the hook uses the hardcoded WORKSPACE path, so we test via
        # a command that won't have a matching smoke file.
        code, stderr = _run_hook("git push origin main")
        # Should block (exit 2) because no smoke report exists
        self.assertEqual(code, 2, f"Expected exit 2 (block), got {code}. stderr={stderr}")
        self.assertIn("Clerk JWT smoke gate", stderr)
        self.assertIn("allow-no-clerk-jwt-smoke", stderr)

    def test_block_on_violation_npm_publish(self):
        """npm publish with no smoke report → block."""
        code, stderr = _run_hook("npm publish")
        self.assertEqual(code, 2, f"Expected exit 2 (block), got {code}. stderr={stderr}")
        self.assertIn("BLOCKED", stderr)

    def test_block_on_violation_convex_deploy_prod(self):
        """npx convex deploy --prod with no smoke report → block."""
        code, stderr = _run_hook("npx convex deploy --prod")
        self.assertEqual(code, 2, f"Expected exit 2 (block), got {code}. stderr={stderr}")
        self.assertIn("BLOCKED", stderr)

    # ── Case 2: pass when a valid smoke report exists ─────────────────────────
    def test_pass_on_valid_smoke_report_exists(self):
        """PROD command with existing qa/clerk-jwt-smoke-<sha>.json → pass."""
        import hashlib

        workspace = "/root/coding/vantage-memory"
        qa_dir = os.path.join(workspace, "qa")
        os.makedirs(qa_dir, exist_ok=True)

        # Determine current HEAD SHA
        try:
            result = subprocess.run(
                ["git", "rev-parse", "--short", "HEAD"],
                capture_output=True,
                text=True,
                cwd=workspace,
                timeout=5,
            )
            sha = result.stdout.strip() if result.returncode == 0 else "abc1234"
        except Exception:
            sha = "abc1234"

        smoke_file = os.path.join(qa_dir, f"clerk-jwt-smoke-{sha}.json")
        try:
            with open(smoke_file, "w") as f:
                json.dump({"issuerMatch": True, "audienceMatch": True, "sha": sha}, f)

            code, stderr = _run_hook("git push origin main")
            self.assertEqual(
                code, 0,
                f"Expected exit 0 (pass) with smoke report present, got {code}. stderr={stderr}",
            )
        finally:
            if os.path.exists(smoke_file):
                os.remove(smoke_file)

    # ── Case 3: pass when override marker is present ──────────────────────────
    def test_pass_on_override_marker(self):
        """PROD command with override marker → pass without smoke report."""
        code, stderr = _run_hook(
            "git push origin main  # // allow-no-clerk-jwt-smoke: hotfix-cert-rotation-only"
        )
        self.assertEqual(
            code, 0,
            f"Expected exit 0 (override), got {code}. stderr={stderr}",
        )

    def test_pass_on_override_marker_npm(self):
        """npm publish with override marker → pass."""
        code, stderr = _run_hook(
            "npm publish # // allow-no-clerk-jwt-smoke: pre-auth-feature-flag-off"
        )
        self.assertEqual(code, 0, f"Expected exit 0 (override), got {code}")

    # ── Non-PROD commands always pass ─────────────────────────────────────────
    def test_pass_on_non_prod_command(self):
        """Non-PROD bash commands are not affected by this hook."""
        code, _ = _run_hook("git push origin feat/my-branch")
        self.assertEqual(code, 0)

    def test_pass_on_empty_command(self):
        """Empty command → pass (fail-open)."""
        code, _ = _run_hook("")
        self.assertEqual(code, 0)

    def test_pass_on_non_bash_tool(self):
        """Non-Bash tool calls are not affected."""
        payload = json.dumps(
            {"tool_name": "Read", "tool_input": {"file_path": "/tmp/x.txt"}}
        )
        result = subprocess.run(
            [sys.executable, HOOK],
            input=payload,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0)

    def test_pass_on_malformed_json(self):
        """Malformed JSON → fail-open (exit 0)."""
        result = subprocess.run(
            [sys.executable, HOOK],
            input="not-json",
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
