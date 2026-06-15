"""
Unit tests for .claude/hooks/strip-claude-from-pr.py

Day 98 F3 (k177yhgmfk1101046wcv04dbfd88c8kz)

Tests verify:
  1. Hook is a no-op for non-Bash tool calls
  2. Hook is a no-op for Bash calls not containing "gh pr create"
  3. Robot emoji + "Generated with [Claude Code]" is stripped from --body
  4. "Generated with Claude Code" (plain form) is stripped
  5. "Co-Authored-By: Claude ..." is stripped
  6. "Co-authored-by: Claude ..." (case variant) is stripped
  7. Combined strip: both robot emoji AND Co-Authored-By removed in one pass
  8. Idempotent: running twice produces the same command
  9. Audit log written to /tmp/pr-claude-strip.log when command is modified
 10. When command is unmodified, no log entry written

Hermetic seams:
  - Loads the hook module via importlib to avoid hyphenated-filename issues
  - Monkey-patches AUDIT_LOG to a temp file for isolation
  - Passes stdin via io.StringIO
  - Never calls subprocess or git

Run:
  pytest tests/hooks/test_strip_claude_from_pr.py -v
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# Hermetic module load
# ---------------------------------------------------------------------------

HOOK_PATH = Path(__file__).resolve().parent.parent.parent / ".claude" / "hooks" / "strip-claude-from-pr.py"


def load_hook():
    """Load the hook module without executing __main__."""
    spec = importlib.util.spec_from_file_location("strip_claude_from_pr", HOOK_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture(scope="module")
def hook():
    return load_hook()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def run_hook(hook_mod, tool_name: str, command: str, audit_log: str | None = None) -> dict:
    """
    Call hook_mod.main() with synthetic stdin, capture stdout JSON response.
    Optionally redirect AUDIT_LOG.
    """
    payload = json.dumps({
        "tool_name": tool_name,
        "tool_input": {"command": command},
    })
    stdout_capture = io.StringIO()
    log_path = audit_log or "/dev/null"

    with (
        patch.object(hook_mod, "AUDIT_LOG", log_path),
        patch("sys.stdin", io.StringIO(payload)),
        patch("sys.stdout", stdout_capture),
    ):
        hook_mod.main()

    output = stdout_capture.getvalue().strip()
    return json.loads(output)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestNoop:
    def test_non_bash_tool_allowed_unchanged(self, hook):
        """Non-Bash tools pass through unmodified."""
        result = run_hook(hook, "Read", "gh pr create --title test")
        assert result["decision"] == "allow"
        assert "toolInput" not in result

    def test_bash_without_gh_pr_create_allowed(self, hook):
        """Bash commands not containing 'gh pr create' pass through."""
        result = run_hook(hook, "Bash", "git push origin main")
        assert result["decision"] == "allow"
        assert "toolInput" not in result

    def test_bash_gh_issue_create_not_matched(self, hook):
        """gh issue create is not a PR create — no stripping."""
        result = run_hook(hook, "Bash", 'gh issue create --title "bug" --body "🤖 Generated with Claude Code"')
        assert result["decision"] == "allow"
        assert "toolInput" not in result


class TestRobotEmojiStrip:
    def test_strips_robot_emoji_generated_with_claude_code(self, hook):
        """'🤖 Generated with [Claude Code](url)' line is removed."""
        cmd = (
            'gh pr create --title "feat" --body "$(cat <<\'EOF\'\n'
            'My PR body.\n'
            '\n'
            '🤖 Generated with [Claude Code](https://claude.com/claude-code)\n'
            'EOF\n)'
        )
        result = run_hook(hook, "Bash", cmd)
        assert result["decision"] == "allow"
        modified = result["toolInput"]["command"]
        assert "🤖" not in modified
        assert "Generated with" not in modified
        assert "My PR body." in modified

    def test_strips_plain_generated_with_claude_code(self, hook):
        """'Generated with Claude Code' (no emoji, no link) is stripped."""
        cmd = (
            'gh pr create --title "fix" --body "Fix the bug.\n\n'
            'Generated with Claude Code"'
        )
        result = run_hook(hook, "Bash", cmd)
        assert result["decision"] == "allow"
        modified = result["toolInput"]["command"]
        assert "Generated with Claude Code" not in modified

    def test_strips_markdown_link_variant(self, hook):
        """'[Claude Code](https://claude.com/claude-code)' is stripped."""
        cmd = (
            'gh pr create --title "pr" --body "Summary.\n\n'
            '[Claude Code](https://claude.com/claude-code)"'
        )
        result = run_hook(hook, "Bash", cmd)
        assert result["decision"] == "allow"
        assert "[Claude Code]" not in result["toolInput"]["command"]


class TestCoAuthoredByStrip:
    def test_strips_co_authored_by_claude(self, hook):
        """'Co-Authored-By: Claude ...' line is removed."""
        cmd = (
            'gh pr create --title "feat" --body "$(cat <<\'EOF\'\n'
            'My changes.\n'
            '\n'
            'Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>\n'
            'EOF\n)'
        )
        result = run_hook(hook, "Bash", cmd)
        assert result["decision"] == "allow"
        modified = result["toolInput"]["command"]
        assert "Co-Authored-By: Claude" not in modified
        assert "My changes." in modified

    def test_strips_co_authored_by_claude_lowercase(self, hook):
        """'Co-authored-by: Claude ...' (lowercase) is also removed."""
        cmd = (
            'gh pr create --title "fix" --body '
            '"Fix.\n\nCo-authored-by: Claude Sonnet <noreply@anthropic.com>"'
        )
        result = run_hook(hook, "Bash", cmd)
        modified = result["toolInput"]["command"]
        assert "Co-authored-by: Claude" not in modified


class TestCombinedStrip:
    def test_strips_both_robot_and_co_authored_in_one_pass(self, hook):
        """Both patterns stripped from a realistic PR body heredoc."""
        body = (
            "## Summary\n"
            "- Added feature X\n"
            "\n"
            "🤖 Generated with [Claude Code](https://claude.com/claude-code)\n"
            "Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>\n"
        )
        cmd = f'gh pr create --title "feat: X" --body "{body}"'
        result = run_hook(hook, "Bash", cmd)
        modified = result["toolInput"]["command"]
        assert "🤖" not in modified
        assert "Generated with" not in modified
        assert "Co-Authored-By: Claude" not in modified
        assert "Added feature X" in modified

    def test_idempotent_double_application(self, hook):
        """Running strip twice on the already-stripped command is a no-op."""
        cmd = (
            'gh pr create --title "pr" --body "Body.\n\n'
            '🤖 Generated with Claude Code\n'
            'Co-Authored-By: Claude <noreply@anthropic.com>"'
        )
        result1 = run_hook(hook, "Bash", cmd)
        modified1 = result1["toolInput"]["command"]

        # Second pass: no further changes
        result2 = run_hook(hook, "Bash", modified1)
        assert result2["decision"] == "allow"
        assert "toolInput" not in result2  # No change = no toolInput override


class TestAuditLog:
    def test_audit_log_written_when_command_modified(self, hook):
        """An audit entry is appended to AUDIT_LOG when the command is stripped."""
        with tempfile.NamedTemporaryFile(mode="r", suffix=".log", delete=False) as f:
            log_path = f.name
        try:
            cmd = (
                'gh pr create --title "pr" --body "Changes.\n\n'
                '🤖 Generated with Claude Code"'
            )
            run_hook(hook, "Bash", cmd, audit_log=log_path)
            content = Path(log_path).read_text()
            assert "strip-claude-from-pr:" in content
            assert "→" in content  # byte size arrow
        finally:
            os.unlink(log_path)

    def test_no_audit_log_when_command_unchanged(self, hook):
        """No audit entry when command has nothing to strip."""
        with tempfile.NamedTemporaryFile(mode="r", suffix=".log", delete=False) as f:
            log_path = f.name
        try:
            cmd = 'gh pr create --title "clean pr" --body "No branding here."'
            run_hook(hook, "Bash", cmd, audit_log=log_path)
            content = Path(log_path).read_text()
            assert content == ""
        finally:
            os.unlink(log_path)


class TestEdgeCases:
    def test_empty_command_allowed(self, hook):
        """Empty Bash command passes through."""
        payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": ""}})
        stdout = io.StringIO()
        with patch("sys.stdin", io.StringIO(payload)), patch("sys.stdout", stdout):
            hook.main()
        result = json.loads(stdout.getvalue())
        assert result["decision"] == "allow"

    def test_invalid_json_input_allowed(self, hook):
        """Malformed JSON input is handled gracefully (allow, no crash)."""
        stdout = io.StringIO()
        with patch("sys.stdin", io.StringIO("not json")), patch("sys.stdout", stdout):
            hook.main()
        result = json.loads(stdout.getvalue())
        assert result["decision"] == "allow"
