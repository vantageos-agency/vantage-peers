#!/usr/bin/env python3
"""
PreToolUse hook : enforce RULE #25 DOCS-CONTEXT-LOOP on `gh pr create`.

v1.1.0 — Day 109 (changelog-fragments-doctrine: accept changes/*.md as docs).
v1.0.0 — Day 103 (Pi-dispatched, RULE #25 ship).

Blocks `gh pr create` commands when the branch diff vs the PR base touches
code paths but DOES NOT touch any docs path (README.md, CHANGELOG.md,
docs/**, vantage-peers/docs/**, changes/*.md), UNLESS the PR body or the
latest commit message carries a well-formed exemption marker:

    # docs-skip: <type> <reason ≥15 chars>

where <type> ∈ {trivial-fix, chore, hotfix-urgent}.

Decision matrix:
  - no code in diff                              -> ALLOW (pure docs/infra)
  - code + docs in diff                          -> ALLOW
  - code + no docs + valid exemption marker      -> ALLOW (WARN to stderr)
  - code + no docs + no/invalid exemption        -> BLOCK (exit 2)

Docs paths accepted (additive, backward-compatible):
  - README.md / CHANGELOG.md (any directory level)
  - docs/** and vantage-peers/docs/**
  - changes/*.md  (changelog fragment — see docs/fleet/changelog-fragments-doctrine.md)

Fail-open on any git plumbing failure or unexpected exception: this hook
NEVER blocks a PR because it could not talk to git -- only because the
author skipped docs.

Audit trail: /tmp/pr-docs-sync.log (append-only JSONL per call).

Exit 0 = allow
Exit 2 = block
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

VERSION = "1.1.0"

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

AUDIT_LOG = "/tmp/pr-docs-sync.log"
GIT_TIMEOUT_SEC = 10

GH_PR_CREATE_RE = re.compile(r"\bgh\s+pr\s+create\b", re.IGNORECASE)

# Exemption marker: "# docs-skip: <type> <reason>"
# <type> ∈ {trivial-fix, chore, hotfix-urgent}
# <reason> must be ≥15 chars
EXEMPTION_TYPES = ("trivial-fix", "chore", "hotfix-urgent")
EXEMPTION_RE = re.compile(
    r"#\s*docs-skip\s*:\s*(trivial-fix|chore|hotfix-urgent)\s+(.{15,})",
    re.IGNORECASE,
)

# Code path classification
CODE_DIR_PREFIXES = (
    "vantage-peers/hooks/",
    "vantage-peers/skills/",
    "vantage-peers/agents/",
    "vantage-peers/templates/",
)
CODE_EXACT_FILES = (
    "vantage-peers/.claude-plugin/plugin.json",
    "vantage-peers/hooks/hooks.json",
)
CODE_EXT_RE = re.compile(r".*\.(py|ts|tsx|js|jsx)$", re.IGNORECASE)

# Docs path classification
DOCS_BASENAMES = ("readme.md", "changelog.md")

# Changelog fragment pattern — changes/<anything>.md
# See docs/fleet/changelog-fragments-doctrine.md for the convention.
CHANGELOG_FRAGMENT_RE = re.compile(r"^changes/[^/]+\.md$", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Argument parsing helpers
# ---------------------------------------------------------------------------

def _strip_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def parse_base(command: str) -> str:
    """Extract --base <branch> from the gh pr create command. Default: main."""
    match = re.search(r"--base[=\s]+(['\"]?)([A-Za-z0-9._/-]+)\1", command)
    if match:
        return match.group(2)
    return "main"


def parse_body(command: str) -> str:
    """Extract --body content (inline) from the gh pr create command.

    Supports both --body 'text' and --body="text" forms (also --body $'...').
    Returns "" if not found.
    """
    # --body="..."
    match = re.search(r"--body=(['\"])(.*?)\1", command, re.DOTALL)
    if match:
        return match.group(2)
    # --body "..."
    match = re.search(r"--body\s+(['\"])(.*?)\1", command, re.DOTALL)
    if match:
        return match.group(2)
    # --body $(cat <<'EOF' ... EOF) — best-effort: capture between EOF markers
    match = re.search(r"--body\s+\"\$\(cat\s*<<\s*'?EOF'?\s*\n(.*?)\nEOF", command, re.DOTALL)
    if match:
        return match.group(1)
    return ""


def parse_body_file(command: str) -> str:
    """Extract content of --body-file <path>. Fail-open on read error."""
    match = re.search(r"--body-file[=\s]+(['\"]?)([^\s'\"]+)\1", command)
    if not match:
        return ""
    path = match.group(2)
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        return ""


# ---------------------------------------------------------------------------
# Git diff
# ---------------------------------------------------------------------------

def parse_cwd(command: str) -> str | None:
    """Extract a leading `cd <path> &&` prefix so git runs in the PR own
    worktree, never the ambient checkout. Day 130: the hook audited the main
    worktree branch while the PR was opened from a linked worktree — it
    blocked a conforming PR and would silently pass a non-conforming one."""
    match = re.match(r"\s*cd\s+(['\"]?)([^'\"&;|]+)\1\s*&&", command)
    if match:
        return match.group(2).strip()
    return None


def parse_head(command: str) -> str:
    """Extract --head <branch>. Default: HEAD. Auditing the named head branch
    removes any dependence on the ambient HEAD."""
    match = re.search(r"--head[=\s]+(['\"]?)([A-Za-z0-9._/-]+)\1", command)
    if match:
        return match.group(2)
    return "HEAD"


def git_diff_files(base: str, cwd: str | None = None, head: str = "HEAD") -> list[str] | None:
    """Return list of changed files vs base (subprocess). None on failure.

    Hermetic test seam: env PR_DOCS_SYNC_TEST_DIFF, when set, is parsed as a
    newline-delimited file list and short-circuits the subprocess call.
    """
    mock = os.environ.get("PR_DOCS_SYNC_TEST_DIFF")
    if mock is not None:
        if mock == "__FAIL__":
            return None
        return [line for line in mock.splitlines() if line.strip()]

    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", f"{base}...{head}"],
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT_SEC,
            cwd=cwd,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    return [line for line in result.stdout.splitlines() if line.strip()]


def git_last_commit_message(cwd: str | None = None, head: str = "HEAD") -> str:
    """Return latest commit message. Empty on failure.

    Hermetic test seam: env PR_DOCS_SYNC_TEST_COMMIT_MSG short-circuits.
    """
    mock = os.environ.get("PR_DOCS_SYNC_TEST_COMMIT_MSG")
    if mock is not None:
        return mock

    try:
        result = subprocess.run(
            ["git", "log", "-1", "--format=%B", head],
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT_SEC,
            cwd=cwd,
        )
    except Exception:
        return ""
    if result.returncode != 0:
        return ""
    return result.stdout


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

def is_docs_path(path: str) -> bool:
    p = path.lower()
    if "/docs/" in p or p.startswith("docs/"):
        return True
    basename = p.rsplit("/", 1)[-1]
    if basename in DOCS_BASENAMES:
        return True
    # v1.1.0 — changelog fragment: changes/<branch-slug>.md
    if CHANGELOG_FRAGMENT_RE.match(p):
        return True
    return False


def is_code_path(path: str) -> bool:
    # Docs always win — if it's classified docs, it's not code.
    if is_docs_path(path):
        return False
    if path in CODE_EXACT_FILES:
        return True
    if any(path.startswith(prefix) for prefix in CODE_DIR_PREFIXES):
        # tests/ subpaths under these dirs are not production code
        if "/tests/" in path or path.endswith("/tests"):
            return False
        return True
    if CODE_EXT_RE.match(path):
        # files matching *.py|*.ts|... outside tests/
        if "/tests/" in path or path.startswith("tests/"):
            return False
        return True
    return False


def classify(files: list[str]) -> tuple[list[str], list[str]]:
    code = [f for f in files if is_code_path(f)]
    docs = [f for f in files if is_docs_path(f)]
    return code, docs


# ---------------------------------------------------------------------------
# Exemption detection
# ---------------------------------------------------------------------------

def find_exemption(text: str) -> tuple[str, str] | None:
    """Return (type, reason) if a valid exemption marker is found, else None.

    Reason is stripped of trailing whitespace; the regex already enforces a
    minimum length of 15 chars in the captured group.
    """
    if not text:
        return None
    for match in EXEMPTION_RE.finditer(text):
        ex_type = match.group(1).lower()
        reason = match.group(2).strip()
        if len(reason) >= 15 and ex_type in EXEMPTION_TYPES:
            return ex_type, reason
    return None


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------

def audit_log(entry: dict) -> None:
    try:
        with open(AUDIT_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # fail-open on log write error


# ---------------------------------------------------------------------------
# Core hook logic
# ---------------------------------------------------------------------------

def run_hook(command: str) -> int:
    if not GH_PR_CREATE_RE.search(command):
        return 0

    base = parse_base(command)
    files = git_diff_files(base, cwd=parse_cwd(command), head=parse_head(command))
    if files is None:
        # git plumbing failure — fail-open
        audit_log({
            "ts": int(time.time()),
            "verdict": "allow",
            "reason": "git-diff-failed",
            "base": base,
        })
        return 0

    code_files, docs_files = classify(files)

    if not code_files:
        audit_log({
            "ts": int(time.time()),
            "verdict": "allow",
            "reason": "no-code-changes",
            "base": base,
            "code_files": 0,
        })
        return 0

    if docs_files:
        audit_log({
            "ts": int(time.time()),
            "verdict": "allow",
            "reason": "code-and-docs",
            "base": base,
            "code_files": len(code_files),
            "docs_files": len(docs_files),
        })
        return 0

    # Code-only diff — need exemption.
    body_inline = parse_body(command)
    body_file = parse_body_file(command)
    commit_msg = git_last_commit_message(cwd=parse_cwd(command), head=parse_head(command))

    for source_name, source_text in (
        ("pr-body", body_inline),
        ("pr-body-file", body_file),
        ("commit-msg", commit_msg),
    ):
        exemption = find_exemption(source_text)
        if exemption:
            ex_type, reason = exemption
            audit_log({
                "ts": int(time.time()),
                "verdict": "allow",
                "reason": "exemption",
                "exemption_type": ex_type,
                "exemption_source": source_name,
                "base": base,
                "code_files": len(code_files),
            })
            print(
                f"[pr-docs-sync v{VERSION}] WARN: docs-skip exemption accepted "
                f"(type={ex_type}, source={source_name}). "
                f"Reason: {reason[:120]}",
                file=sys.stderr,
            )
            return 0

    # BLOCK
    audit_log({
        "ts": int(time.time()),
        "verdict": "block",
        "reason": "code-without-docs",
        "base": base,
        "code_files": len(code_files),
    })
    listing = "\n  - ".join(code_files[:20])
    print(
        "BLOCKED: PR touches code but no docs (RULE #25 DOCS-CONTEXT-LOOP).\n"
        "\n"
        f"Base branch: {base}\n"
        f"Code files changed ({len(code_files)}):\n  - {listing}\n"
        "\n"
        "Resolution — pick ONE:\n"
        "  A) Update at least one doc: README.md, CHANGELOG.md, or docs/**.\n"
        "  B) Add an exemption marker to the PR body OR the latest commit message:\n"
        "       # docs-skip: <type> <reason ≥15 chars>\n"
        "     where <type> ∈ {trivial-fix, chore, hotfix-urgent}.\n"
        "\n"
        "Examples:\n"
        "  # docs-skip: trivial-fix typo in inline comment\n"
        "  # docs-skip: chore bump dev dependency versions\n"
        "  # docs-skip: hotfix-urgent prod outage P0 mitigation patch\n"
        "\n"
        "Audit trail: /tmp/pr-docs-sync.log\n",
        file=sys.stderr,
    )
    return 2


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__" and not globals().get("_TESTING"):
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            sys.exit(0)
        data = json.loads(raw)
        tool_name = data.get("tool_name", "")
        if tool_name and tool_name != "Bash":
            sys.exit(0)
        command = data.get("tool_input", {}).get("command", "")
        if not command:
            sys.exit(0)
        sys.exit(run_hook(command))
    except Exception as e:
        print(f"[hook warning] enforce-pr-docs-sync: {e}", file=sys.stderr)
        sys.exit(0)
