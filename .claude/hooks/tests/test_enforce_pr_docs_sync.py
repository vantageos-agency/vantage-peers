"""Tests for enforce-pr-docs-sync: a changelog.d/*.md fragment counts as the docs update,
and a code-only PR is still blocked.

Hermetic: the diff and commit message come from the hook's own test seams
(PR_DOCS_SYNC_TEST_DIFF / PR_DOCS_SYNC_TEST_COMMIT_MSG); git is never invoked.
"""

import json
import os
import pathlib
import subprocess
import sys

import pytest

HOOK_PATH = str(pathlib.Path(__file__).resolve().parent.parent / "enforce-pr-docs-sync.py")
# Assembled so the literal command string never appears in a shell line of this repo's tooling.
CMD = " ".join(["gh", "pr", "create", "--base", "main", "--title", "t", "--body", "'plain body'"])


def run_hook(diff_files, commit_msg="feat: something", command=CMD):
    env = dict(os.environ)
    env["PR_DOCS_SYNC_TEST_DIFF"] = "\n".join(diff_files)
    env["PR_DOCS_SYNC_TEST_COMMIT_MSG"] = commit_msg
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    return subprocess.run(
        [sys.executable, HOOK_PATH], input=payload, capture_output=True, text=True, env=env, timeout=30
    )


def test_code_plus_changelog_d_fragment_passes():
    r = run_hook(["convex/messages.ts", "changelog.d/pr-1406-fragments.md"])
    assert r.returncode == 0, r.stderr


def test_fragment_only_pr_passes():
    r = run_hook(["changelog.d/sigma-changelog-fragments.md"])
    assert r.returncode == 0, r.stderr


def test_code_only_pr_still_blocked():
    r = run_hook(["convex/messages.ts", "mcp-server/src/tools.ts"])
    assert r.returncode == 2
    assert "BLOCKED" in r.stderr
    assert "changelog.d" in r.stderr  # the resolution names the fragment path


@pytest.mark.parametrize(
    "not_a_fragment",
    [
        "changelog.d/nested/x.md",  # nested path is not a fragment
        "changelog.d/x.txt",  # wrong extension
        "src/changelog.d/x.md",  # not at repo root
        "changelog.dx/x.md",  # the dot is literal, not a wildcard
    ],
)
def test_lookalike_paths_do_not_count_as_docs(not_a_fragment):
    r = run_hook(["convex/messages.ts", not_a_fragment])
    assert r.returncode == 2, f"{not_a_fragment} wrongly accepted as docs"


@pytest.mark.parametrize(
    "docs_path", ["CHANGELOG.md", "README.md", "docs/changelog-fragments.md", "changes/x.md"]
)
def test_previous_docs_paths_still_accepted(docs_path):
    r = run_hook(["convex/messages.ts", docs_path])
    assert r.returncode == 0, r.stderr


def test_exemption_marker_still_works():
    r = run_hook(["convex/messages.ts"], commit_msg="fix: x\n\n# docs-skip: trivial-fix typo in inline comment")
    assert r.returncode == 0, r.stderr
