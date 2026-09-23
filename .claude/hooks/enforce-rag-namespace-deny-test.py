#!/usr/bin/env python3
"""
PreToolUse hook: enforce cross-tenant deny test coverage for RAG/auth changes.

VantagePeers Cloud — Day 108 conformance (BU-specific).

When a commit touches:
  - convex/auth.ts
  - any file under convex/rag* (convex/rag.ts, convex/ragBundle.ts, etc.)
  - any file under convex/okfBundle* (convex/okfBundle.ts, etc.)

...at least one staged test file in convex/__tests__/ must contain
a test description asserting cross-tenant denial, identified by the
presence of either of these strings in the file content:
  - "AUTH_NAMESPACE_DENIED"
  - "cross-tenant deny"

Root cause this addresses:
  VantagePeers Cloud stores RAG embeddings per-namespace (per tenant).
  A missing deny test means a regression can expose tenant A's memories
  to tenant B's queries. The OKF bundle export path (convex/okfBundle*)
  and the auth configuration (convex/auth.ts) are the highest-risk
  cross-tenant leak vectors per the architecture review.

Enforced on:
  - Bash tool calls where the command starts with `git commit`

Pass conditions (any one):
  - No staged files match the trigger pattern
  - A staged file in convex/__tests__/ contains the required denial string
  - Command contains override marker: // allow-no-rag-deny-test: <reason>

Exit codes:
  0 = allow
  2 = block with remediation message

Override (rare, one-shot):
  Include `// allow-no-rag-deny-test: <reason>` in the commit command.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

# No hardcoded repository path remains. The one that used to live here was
# the fallback for a payload with no `cwd`, and that fallback WAS the
# original defect through a second door — a real repository judged, just
# not the one being committed to. The repo is derived per call in
# `_resolve_repo`, or the call REFUSES.

# Files that trigger the RAG/auth deny test requirement
TRIGGER_PATTERNS = [
    re.compile(r"^convex/auth\.ts$"),
    re.compile(r"^convex/rag"),
    re.compile(r"^convex/okfBundle"),
]

# Test files that satisfy the requirement
TEST_DIR_RE = re.compile(r"^convex/__tests__/")

# Strings that must appear in at least one test file
REQUIRED_STRINGS = ["AUTH_NAMESPACE_DENIED", "cross-tenant deny"]

# Override marker
OVERRIDE_RE = re.compile(
    r"//\s*allow-no-rag-deny-test\s*:\s*\S+",
    re.IGNORECASE,
)


class RepoResolutionError(Exception):
    """Raised when the PreToolUse payload's cwd cannot be resolved to a git
    repository. The caller MUST turn this into exit 2 — never a silent
    pass. See .claude/rules/railway-mcp-redeploy.md's sibling doctrine:
    an unreadable subject is a refusal, not conformance."""

STDERR_MSG = """\
BLOCKED: RAG cross-tenant deny test required (Day 108 — VantagePeers Cloud).

Your commit touches a RAG/auth file that is a cross-tenant leak risk:
  convex/auth.ts | convex/rag* | convex/okfBundle*

No staged test file in convex/__tests__/ was found asserting cross-tenant
namespace denial. VantagePeers Cloud is multi-tenant — tenant A's memories
must NEVER be accessible in tenant B's namespace context.

REQUIRED: At least one staged test file in convex/__tests__/ must contain:
  - the string "AUTH_NAMESPACE_DENIED"  OR
  - the string "cross-tenant deny"

EXAMPLE (convex/__tests__/rag-namespace-deny.test.ts):
  it("AUTH_NAMESPACE_DENIED — rejects query from foreign namespace", async () => {
    await expect(ragQuery({ namespace: "tenant-B", identity: tenantA }))
      .rejects.toThrow("AUTH_NAMESPACE_DENIED");
  });

HOW TO FIX:
  1. Add a test file to convex/__tests__/ that covers the denial case.
  2. Stage it: git add convex/__tests__/your-test-file.ts
  3. Retry the commit.

OVERRIDE (rare — emergencies only, cite the reason):
  Include this marker verbatim in your git commit command:
    // allow-no-rag-deny-test: <reason>

  Example:
    git commit -m "fix: ..." # // allow-no-rag-deny-test: no-auth-surface-changed

  Use once, then add the test in a follow-up commit.
"""


def _has_override(command: str) -> bool:
    return bool(OVERRIDE_RE.search(command))


def _resolve_repo(payload: dict) -> str:
    """Resolve the repository this commit is actually being made in, FROM
    THE PAYLOAD'S OWN cwd — never the hardcoded WORKSPACE — so a commit
    staged inside a git worktree is judged against ITS OWN index. See the
    identical rationale in enforce-mcp-tool-coverage-schema-mirror.py's
    `_resolve_repo` — both hooks shared this defect.

    There is NO fallback. An ABSENT cwd key is an unreadable subject exactly
    as a present-but-unresolvable one is, and both REFUSE. Falling back to
    the hardcoded WORKSPACE reinstated the original defect through a second
    door: it judges a real repository, just not the one being committed to.
    The objection that the runtime always sends `cwd` is precisely the
    assumption that kept the first door open unnoticed — this gate does not
    rest on what a caller is expected to send.
    """
    payload_cwd = (payload.get("cwd") or "").strip()
    if not payload_cwd:
        raise RepoResolutionError(
            "the tool payload carried no 'cwd' — the repository being "
            "committed to cannot be identified, and a hardcoded default "
            "would judge a different repository's index"
        )
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            cwd=payload_cwd,
            timeout=10,
        )
    except Exception as exc:
        raise RepoResolutionError(
            f"cwd={payload_cwd!r} — git rev-parse --show-toplevel raised: {exc}"
        ) from exc
    if result.returncode != 0 or not result.stdout.strip():
        raise RepoResolutionError(
            f"cwd={payload_cwd!r} is not inside a git repository "
            f"(git rev-parse --show-toplevel exit={result.returncode}: "
            f"{result.stderr.strip()!r})"
        )
    return result.stdout.strip()


def _get_staged_files(repo: str) -> list[str]:
    try:
        result = subprocess.run(
            ["git", "diff", "--cached", "--name-only"],
            capture_output=True,
            text=True,
            cwd=repo,
            timeout=10,
        )
    except Exception as exc:
        raise RepoResolutionError(
            f"repo={repo!r} — git diff --cached raised: {exc}"
        ) from exc
    if result.returncode != 0:
        raise RepoResolutionError(
            f"repo={repo!r} — git diff --cached exit={result.returncode}: "
            f"{result.stderr.strip()!r}"
        )
    return [f.strip() for f in result.stdout.splitlines() if f.strip()]


def _file_triggers(path: str) -> bool:
    return any(p.search(path) for p in TRIGGER_PATTERNS)


def _file_is_test(path: str) -> bool:
    return bool(TEST_DIR_RE.match(path))


def _test_file_has_denial(repo: str, path: str) -> bool:
    full_path = os.path.join(repo, path)
    try:
        with open(full_path, encoding="utf-8", errors="replace") as f:
            content = f.read()
        return any(s in content for s in REQUIRED_STRINGS)
    except Exception:
        return False


def main() -> int:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return 0
        payload = json.loads(raw)
    except Exception:
        return 0

    try:
        tool_name = payload.get("tool_name") or payload.get("tool") or ""
        if tool_name != "Bash":
            return 0

        tool_input = payload.get("tool_input") or payload.get("input") or {}
        if not isinstance(tool_input, dict):
            return 0

        command = tool_input.get("command") or ""
        if not isinstance(command, str):
            return 0

        # Only fire on git commit commands
        if not re.match(r"\s*git\s+commit\b", command):
            return 0

        if _has_override(command):
            return 0

        try:
            repo = _resolve_repo(payload)
            staged = _get_staged_files(repo)
        except RepoResolutionError as exc:
            sys.stderr.write(
                "BLOCKED: enforce-rag-namespace-deny-test could not resolve "
                f"the repository being committed to: {exc}\n"
                "This is a REFUSAL, not a pass — an unreadable commit "
                "subject must never be treated as conformance.\n"
            )
            return 2

        trigger_files = [f for f in staged if _file_triggers(f)]

        if not trigger_files:
            return 0

        # Check if any staged test file has the required denial assertion
        staged_tests = [f for f in staged if _file_is_test(f)]
        for test_file in staged_tests:
            if _test_file_has_denial(repo, test_file):
                return 0

        # Also check ALL existing test files in convex/__tests__/ (not just staged)
        # to handle the case where the test already exists and wasn't modified
        tests_dir = os.path.join(repo, "convex", "__tests__")
        if os.path.isdir(tests_dir):
            for fname in os.listdir(tests_dir):
                fpath = os.path.join("convex", "__tests__", fname)
                if _test_file_has_denial(repo, fpath):
                    return 0

        sys.stderr.write(STDERR_MSG)
        sys.stderr.write(f"Repo judged: {repo}\n")
        sys.stderr.write("Triggering staged files:\n")
        for f in trigger_files:
            sys.stderr.write(f"  {f}\n")
        sys.stderr.write("\nStaged test files found:\n")
        if staged_tests:
            for f in staged_tests:
                sys.stderr.write(f"  {f}\n")
        else:
            sys.stderr.write("  (none)\n")
        return 2
    except Exception:
        return 0


if __name__ == "__main__":
    sys.exit(main())
