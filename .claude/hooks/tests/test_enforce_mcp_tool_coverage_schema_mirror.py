#!/usr/bin/env python3
"""
Tests for enforce-mcp-tool-coverage-schema-mirror.py

Covers:
  1. block_on_violation  — commit touches convex/schema.ts, no MCP tool staged → exit 2
  2. pass_on_valid       — commit touches convex/schema.ts AND mcp-server/src/tools/ → exit 0
  3. pass_on_override    — commit message contains override marker → exit 0
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(
    os.path.dirname(__file__), "..", "enforce-mcp-tool-coverage-schema-mirror.py"
)
HOOK = os.path.abspath(HOOK)

WORKSPACE = "/root/coding/vantage-memory"


def _run_hook_with_mock_git(command: str, staged_files: list[str]) -> tuple[int, str]:
    """Run hook with a mock git binary returning specified staged files."""
    with tempfile.TemporaryDirectory() as tmpdir:
        mock_git = os.path.join(tmpdir, "git")
        staged_output = "\n".join(staged_files)
        mock_script = f"""#!/bin/sh
if echo "$*" | grep -q "diff --cached --name-only"; then
    printf '{staged_output}\\n'
    exit 0
fi
exec /usr/bin/git "$@"
"""
        with open(mock_git, "w") as f:
            f.write(mock_script)
        os.chmod(mock_git, 0o755)

        env = os.environ.copy()
        env["PATH"] = tmpdir + ":" + env.get("PATH", "")

        payload = json.dumps(
            {"tool_name": "Bash", "tool_input": {"command": command}}
        )
        result = subprocess.run(
            [sys.executable, HOOK],
            input=payload,
            capture_output=True,
            text=True,
            env=env,
        )
        return result.returncode, result.stderr


def _run_hook(command: str) -> tuple[int, str]:
    payload = json.dumps(
        {"tool_name": "Bash", "tool_input": {"command": command}}
    )
    result = subprocess.run(
        [sys.executable, HOOK],
        input=payload,
        capture_output=True,
        text=True,
    )
    return result.returncode, result.stderr


class TestMcpToolCoverageSchemaMirror(unittest.TestCase):

    # ── Case 1: block when schema.ts staged, no MCP tool staged ──────────────
    def test_block_on_violation_schema_no_mcp_tool(self):
        """git commit touching convex/schema.ts without MCP tool → exit 2."""
        code, stderr = _run_hook_with_mock_git(
            "git commit -m 'feat: add memories table'",
            staged_files=["convex/schema.ts", "convex/memories.ts"],
        )
        self.assertEqual(
            code, 2,
            f"Expected exit 2 (block): schema staged, no MCP tool. got {code}. stderr={stderr}",
        )
        self.assertIn("RULE #24", stderr)
        self.assertIn("mcp-server/src/tools/", stderr)
        self.assertIn("allow-schema-mirror-skip", stderr)

    def test_block_on_violation_schema_only(self):
        """git commit with only convex/schema.ts staged → exit 2."""
        code, stderr = _run_hook_with_mock_git(
            "git commit -m 'feat: add new entity'",
            staged_files=["convex/schema.ts"],
        )
        self.assertEqual(code, 2, f"Expected block. got {code}. stderr={stderr}")
        self.assertIn("BLOCKED", stderr)
        self.assertIn("MCP tool coverage", stderr)

    def test_block_message_cites_postmortem_reference(self):
        """Block message references the eta-approval postmortem."""
        code, stderr = _run_hook_with_mock_git(
            "git commit -m 'feat: new table'",
            staged_files=["convex/schema.ts"],
        )
        self.assertEqual(code, 2)
        self.assertIn("eta-approval-hook-postmortem-2026-05-26.md", stderr)

    # ── Case 2: pass when schema.ts AND an MCP tool file are staged ──────────
    def test_pass_on_valid_mcp_tool_staged(self):
        """schema.ts + mcp-server/src/tools/memories.ts staged → exit 0."""
        code, stderr = _run_hook_with_mock_git(
            "git commit -m 'feat: add memories table + MCP tool'",
            staged_files=[
                "convex/schema.ts",
                "convex/memories.ts",
                "mcp-server/src/tools/memories.ts",
            ],
        )
        self.assertEqual(
            code, 0,
            f"Expected exit 0: schema + MCP tool staged. got {code}. stderr={stderr}",
        )

    def test_pass_on_valid_mcp_tool_index_staged(self):
        """schema.ts + mcp-server/src/tools/index.ts staged → exit 0."""
        code, stderr = _run_hook_with_mock_git(
            "git commit -m 'feat: register new tool'",
            staged_files=[
                "convex/schema.ts",
                "mcp-server/src/tools/index.ts",
            ],
        )
        self.assertEqual(code, 0, f"Expected pass. got {code}. stderr={stderr}")

    def test_pass_when_schema_not_staged(self):
        """Commit without convex/schema.ts → not blocked."""
        code, stderr = _run_hook_with_mock_git(
            "git commit -m 'fix: update query'",
            staged_files=["convex/queries.ts", "convex/auth.ts"],
        )
        self.assertEqual(
            code, 0,
            f"Expected pass: schema not staged. got {code}. stderr={stderr}",
        )

    # ── Case 3: pass when override marker is in commit message ───────────────
    def test_pass_on_override_marker_in_message(self):
        """Commit message with override marker → exit 0."""
        code, stderr = _run_hook_with_mock_git(
            "git commit -m 'refactor: rename field // allow-schema-mirror-skip: internal-rename-no-new-entity'",
            staged_files=["convex/schema.ts"],
        )
        self.assertEqual(
            code, 0,
            f"Expected exit 0 (override). got {code}. stderr={stderr}",
        )

    def test_pass_on_override_marker_heredoc_style(self):
        """Override marker in heredoc-style commit command → exit 0."""
        code, _ = _run_hook_with_mock_git(
            'git commit -m "$(cat <<\'EOF\'\nfeat: schema migration\n// allow-schema-mirror-skip: migration-only-no-client-surface\nEOF\n)"',
            staged_files=["convex/schema.ts"],
        )
        self.assertEqual(code, 0)

    # ── Non-commit commands always pass ───────────────────────────────────────
    def test_pass_on_non_commit_bash_command(self):
        """git push is not a commit → not affected."""
        code, _ = _run_hook("git push origin main")
        self.assertEqual(code, 0)

    def test_pass_on_non_bash_tool(self):
        """Non-Bash tool → pass."""
        payload = json.dumps(
            {
                "tool_name": "Write",
                "tool_input": {"file_path": "/tmp/x.ts", "content": ""},
            }
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
            input="not valid json",
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0)

    def test_pass_on_empty_stdin(self):
        """Empty stdin → fail-open."""
        result = subprocess.run(
            [sys.executable, HOOK],
            input="",
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
