"""
Unit tests for .claude/hooks/enforce-brief-grep-verify.py

Day 107 (k173as8n0zj8bmbznhvy9ch4a588yrp7) — dispatch-subagent v3
pre-flight grep verify: any path-like reference in a sub-agent brief
must exist on disk, else block.

Tests verify:
  1. No path-like refs in prompt → exit 0 (no-op).
  2. All refs exist on disk → exit 0 (PASS).
  3. ≥1 ref missing → exit 2 (BLOCK) + missing list in stderr.
  4. Override marker `// allow-missing-refs:` → exit 0.
  5. Exempt agent_type (Explore/Plan) → exit 0 even with missing refs.
  6. URL refs (https://...) ignored.
  7. node_modules / dist / .git prefixes ignored.
  8. Doc-placeholder `path/to/foo.ts` ignored.
  9. file:line refs strip the :LN suffix before existence check.
 10. Malformed JSON stdin → exit 0 (let other hooks catch).
 11. Empty prompt → exit 0.
 12. Mixed PASS+MISSING reports correct ratio in stderr.

Run:
  pytest tests/hooks/test_enforce_brief_grep_verify.py -v
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
HOOK_PATH = REPO_ROOT / ".claude" / "hooks" / "enforce-brief-grep-verify.py"


def run_hook(payload: dict, cwd: str | None = None) -> subprocess.CompletedProcess:
    """Invoke the hook in a subprocess with given JSON payload on stdin."""
    return subprocess.run(
        ["python3", str(HOOK_PATH)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        cwd=cwd or str(REPO_ROOT),
    )


# ──────────────────────────────────────────────────────────────────────
# Test 1 — no refs in prompt → exit 0
# ──────────────────────────────────────────────────────────────────────

def test_no_refs_in_prompt_passes():
    p = run_hook({"tool_input": {"prompt": "Just plain text, no paths anywhere.", "subagent_type": "general-purpose"}})
    assert p.returncode == 0
    assert p.stderr == ""


# ──────────────────────────────────────────────────────────────────────
# Test 2 — all refs exist on disk → exit 0
# ──────────────────────────────────────────────────────────────────────

def test_all_refs_exist_passes():
    # Use known-existing files in this repo.
    prompt = "See convex/episodes.ts and convex/okfBundle.ts:88 for context."
    p = run_hook({"tool_input": {"prompt": prompt, "subagent_type": "general-purpose"}})
    assert p.returncode == 0, f"stderr: {p.stderr}"


# ──────────────────────────────────────────────────────────────────────
# Test 3 — ≥1 missing ref blocks with list in stderr
# ──────────────────────────────────────────────────────────────────────

def test_missing_ref_blocks():
    prompt = "Fix the bug in convex/phantom-doesnotexist.ts please."
    p = run_hook({"tool_input": {"prompt": prompt, "subagent_type": "general-purpose"}})
    assert p.returncode == 2
    assert "BLOCKED" in p.stderr
    assert "convex/phantom-doesnotexist.ts" in p.stderr


# ──────────────────────────────────────────────────────────────────────
# Test 4 — override marker disables the check
# ──────────────────────────────────────────────────────────────────────

def test_override_marker_passes():
    prompt = (
        "Create the new file convex/will-be-created.ts.\n"
        "// allow-missing-refs: net-new file the sub-agent will author"
    )
    p = run_hook({"tool_input": {"prompt": prompt, "subagent_type": "general-purpose"}})
    assert p.returncode == 0


# ──────────────────────────────────────────────────────────────────────
# Test 5 — exempt agent types skip the check
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("agent_type", ["Explore", "Plan", "claude-code-guide", "statusline-setup"])
def test_exempt_agent_types_pass(agent_type: str):
    prompt = "Look at convex/phantom-doesnotexist.ts and report."
    p = run_hook({"tool_input": {"prompt": prompt, "subagent_type": agent_type}})
    assert p.returncode == 0


# ──────────────────────────────────────────────────────────────────────
# Test 6 — URL refs ignored
# ──────────────────────────────────────────────────────────────────────

def test_url_refs_ignored():
    prompt = "Source: https://example.com/some/path/file.ts — context for the work."
    p = run_hook({"tool_input": {"prompt": prompt, "subagent_type": "general-purpose"}})
    assert p.returncode == 0


# ──────────────────────────────────────────────────────────────────────
# Test 7 — deps / build / VCS prefixes ignored
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("path", [
    "node_modules/foo/index.ts",
    "dist/bundle.js",
    "build/output.js",
    ".next/server.js",
    "coverage/lcov.info",
    ".git/HEAD",
])
def test_ignored_prefixes_pass(path: str):
    prompt = f"Touch {path} as part of the work."
    p = run_hook({"tool_input": {"prompt": prompt, "subagent_type": "general-purpose"}})
    assert p.returncode == 0


# ──────────────────────────────────────────────────────────────────────
# Test 8 — doc-placeholder paths ignored
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("placeholder", [
    "path/to/file.ts",
    "your/module.js",
    "foo/bar.py",
])
def test_doc_placeholders_pass(placeholder: str):
    prompt = f"Example: edit {placeholder} to fix the issue."
    p = run_hook({"tool_input": {"prompt": prompt, "subagent_type": "general-purpose"}})
    assert p.returncode == 0


# ──────────────────────────────────────────────────────────────────────
# Test 9 — file:line refs strip :LN before existence check
# ──────────────────────────────────────────────────────────────────────

def test_file_line_refs_strip_suffix():
    # convex/episodes.ts exists; ":69" must be stripped for the existence check.
    prompt = "Fix convex/episodes.ts:69 — the storeEpisode mutation."
    p = run_hook({"tool_input": {"prompt": prompt, "subagent_type": "general-purpose"}})
    assert p.returncode == 0


def test_file_line_range_refs_strip_suffix():
    prompt = "See convex/episodes.ts:69-75 for the scheduler call."
    p = run_hook({"tool_input": {"prompt": prompt, "subagent_type": "general-purpose"}})
    assert p.returncode == 0


# ──────────────────────────────────────────────────────────────────────
# Test 10 — malformed JSON stdin → exit 0 (let other hooks catch)
# ──────────────────────────────────────────────────────────────────────

def test_malformed_json_passes():
    p = subprocess.run(
        ["python3", str(HOOK_PATH)],
        input="this is not json",
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    assert p.returncode == 0


# ──────────────────────────────────────────────────────────────────────
# Test 11 — empty prompt passes
# ──────────────────────────────────────────────────────────────────────

def test_empty_prompt_passes():
    p = run_hook({"tool_input": {"prompt": "", "subagent_type": "general-purpose"}})
    assert p.returncode == 0


def test_missing_prompt_key_passes():
    p = run_hook({"tool_input": {"subagent_type": "general-purpose"}})
    assert p.returncode == 0


# ──────────────────────────────────────────────────────────────────────
# Test 12 — mixed PASS+MISSING reports correct ratio
# ──────────────────────────────────────────────────────────────────────

def test_mixed_pass_missing_reports_ratio():
    # 1 real (convex/episodes.ts) + 2 phantom = 1/3 verified, 2 missing
    prompt = (
        "Refs: convex/episodes.ts, convex/phantom-aaa.ts, convex/phantom-bbb.ts."
    )
    p = run_hook({"tool_input": {"prompt": prompt, "subagent_type": "general-purpose"}})
    assert p.returncode == 2
    assert "Verified 1/3" in p.stderr
    assert "convex/phantom-aaa.ts" in p.stderr
    assert "convex/phantom-bbb.ts" in p.stderr
    # The real one must NOT appear in the missing list.
    # Match it as a standalone bullet to avoid false positives from the
    # summary line referencing the prompt.
    assert "- convex/episodes.ts\n" not in p.stderr
