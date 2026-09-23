#!/usr/bin/env python3
"""
PreToolUse hook: enforce MCP tool registration mirrors Convex schema changes.

VantagePeers Cloud — Day 108 conformance (BU-specific).

RULE #24: Every new table or entity added to convex/schema.ts MUST have
a corresponding MCP tool registered in mcp-server/src/tools/ in the same
commit, OR carry an explicit skip justification in the commit message.

Root cause this addresses (mirrors eta-approval-hook-postmortem-2026-05-26.md
pattern of silent contract drift):
  VantagePeers Cloud exposes all data entities through MCP tools. When a
  developer adds a Convex table without wiring a corresponding MCP tool,
  the data entity becomes invisible to Claude.ai / ChatGPT / Claude Code /
  Codex and all IDE MCP clients. This schema-mirror gap compounds over time
  — discovered only when a client tool call returns "unknown tool".

  The eta-approval postmortem (2026-05-26) identified that silent drift
  between implementation layers is the root class of integration failures.
  This hook applies the same gate to the Convex→MCP surface.

Enforced on:
  - Bash tool calls where the command starts with `git commit`
  - Only when convex/schema.ts is among the staged files

Pass conditions (any one):
  - convex/schema.ts is not staged
  - At least one file under mcp-server/src/tools/ is staged in the same commit
  - Commit message contains override marker: // allow-schema-mirror-skip: <reason>

Exit codes:
  0 = allow
  2 = block with remediation message

Override (rare, one-shot — RULE #24, Day 108):
  Include `// allow-schema-mirror-skip: <reason>` in the commit message.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys

# No hardcoded repository path remains. The one that used to live here was
# the fallback for a payload with no `cwd`, and that fallback WAS the
# original defect through a second door — a real repository judged, just
# not the one being committed to. The repo is derived per call in
# `_resolve_repo`, or the call REFUSES.

# Schema file that triggers the MCP tool coverage check
SCHEMA_FILE = "convex/schema.ts"

# MCP tool registration path prefix
MCP_TOOLS_PREFIX = "mcp-server/src/tools/"

# Override marker — scan commit message flag (-m) for this string
OVERRIDE_RE = re.compile(
    r"//\s*allow-schema-mirror-skip\s*:\s*\S+",
    re.IGNORECASE,
)

# Matches a `git commit` invocation ANYWHERE in the command line — never
# anchored to the start of the string. The anchored form
# (`^\s*git\s+commit\b`) was the trigger defect: `cd <repo> && git commit
# -m x` and `git -C <repo> commit -m x` are the ORDINARY shape a subagent
# commits from inside a git worktree — neither starts with "git commit" —
# so the anchored regex silently passed exactly the population this gate
# exists to inspect (measured: exit 0 on a real RULE #24 violation).
GIT_COMMIT_RE = re.compile(r"\bgit\b[^;&|\n]*?\bcommit\b")

# Shell metacharacters that separate one command from the next in a chain.
CHAIN_SPLIT_RE = re.compile(r"&&|\|\||[;\n|]")

# Flags that tell git to operate on a repository OTHER than its cwd.
REPO_FLAG_RE = re.compile(r"(^|\s)(-C(\s|=)|--git-dir(=|\s)|--work-tree(=|\s))")

CD_RE = re.compile(r"^\s*cd\b")


def _strip_quoted_strings(command: str) -> str:
    """Blank out the contents of single- and double-quoted substrings so a
    commit MESSAGE that merely mentions "cd" or "git commit" (e.g.
    `git commit -m "fix: cd into the dir and git commit"`) is never
    mistaken for an actual shell `cd` or a second git invocation. Only the
    unquoted shell structure is judged."""
    out = []
    i, n = 0, len(command)
    while i < n:
        ch = command[i]
        if ch in ("'", '"'):
            quote = ch
            j = i + 1
            while j < n and command[j] != quote:
                if quote == '"' and command[j] == "\\" and j + 1 < n:
                    j += 2
                    continue
                j += 1
            out.append(" ")
            i = j + 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _invokes_git_commit(command: str) -> bool:
    return bool(GIT_COMMIT_RE.search(_strip_quoted_strings(command)))


def _names_unresolved_repo(command: str) -> bool:
    """True when the command's git-commit invocation explicitly names a
    repository the hook did not resolve from the payload's own `cwd` —
    either via a `-C <dir>` / `--git-dir=` / `--work-tree=` flag on the
    git invocation itself, or via a `cd` earlier in the SAME shell chain
    (joined by `&&`, `;`, `|`) that could move the working directory
    before the commit runs.

    DECISION (fail-closed, chosen over parsing the target and judging it
    anyway): the hook REFUSES rather than guesses which repository the
    command actually targets. An over-fire here is a false RED, which is
    survivable; guessing wrong and silently passing a real violation is
    not — that is the exact defect this rewrite closes. This extends the
    same "an unreadable subject is a refusal, not conformance" doctrine
    `_resolve_repo` already applies to a missing/unresolvable cwd, to a
    command that NAMES a different repo than that cwd.
    """
    stripped = _strip_quoted_strings(command)
    parts = CHAIN_SPLIT_RE.split(stripped)
    commit_part = None
    commit_idx = None
    for idx, part in enumerate(parts):
        if GIT_COMMIT_RE.search(part):
            commit_part = part
            commit_idx = idx
            break
    if commit_part is None:
        return False
    if REPO_FLAG_RE.search(commit_part):
        return True
    for earlier in parts[:commit_idx]:
        if CD_RE.match(earlier):
            return True
    return False


UNRESOLVED_REPO_STDERR_MSG = """\
BLOCKED: this command names a repository the hook did not resolve.

Your command invokes `git commit` together with `-C <dir>`,
`--git-dir=`, `--work-tree=`, or a `cd` earlier in the same shell chain
(e.g. `cd <dir> && git commit ...`). This hook resolves the repository
being judged from the PreToolUse payload's own `cwd` — a `cd` or a
`-C` / `--git-dir` / `--work-tree` flag can move the actual commit
somewhere else entirely, and the hook cannot honour that without
guessing.

DECISION: guessing is refused. Run `git commit` directly, from the
repository's own working directory, with no `cd` chaining and no
`-C` / `--git-dir` / `--work-tree` flag — so the payload `cwd` IS the
repository being committed to.
"""


class RepoResolutionError(Exception):
    """Raised when the PreToolUse payload's cwd cannot be resolved to a git
    repository. The caller MUST turn this into exit 2 — never a silent
    pass. See .claude/rules/railway-mcp-redeploy.md's sibling doctrine:
    an unreadable subject is a refusal, not conformance."""

STDERR_MSG = """\
BLOCKED: RULE #24 — MCP tool coverage must mirror Convex schema changes (Day 108).

Your commit modifies convex/schema.ts but no file under mcp-server/src/tools/
is staged in this commit.

RULE #24 (VantagePeers Cloud architecture doctrine):
  Every table/entity added to convex/schema.ts requires a corresponding
  MCP tool registration in mcp-server/src/tools/ in the SAME commit.

WHY THIS MATTERS:
  VantagePeers Cloud is a multi-client MCP platform (Claude.ai, ChatGPT,
  Claude Code, Codex, IDE clients). The MCP tool layer is the ONLY surface
  through which all clients access Convex data. An unregistered entity is
  invisible to every client simultaneously.

  Root class: silent contract drift between implementation layers —
  the same failure mode documented in the eta-approval postmortem
  (analysis/eta-approval-hook-postmortem-2026-05-26.md).

HOW TO FIX:
  Option A (preferred): Add or update a tool file in mcp-server/src/tools/
    1. Create/edit mcp-server/src/tools/<entity>.ts
    2. Register the tool in mcp-server/src/tools/index.ts
    3. Stage both files: git add mcp-server/src/tools/
    4. Retry the commit.

  Option B (schema refactor, no new entity exposed):
    Include this marker verbatim in your commit message -m argument:
      // allow-schema-mirror-skip: <reason>

    Example:
      git commit -m "refactor: rename internal field // allow-schema-mirror-skip: internal-field-only-no-new-entity"

    Use once, then add the MCP tool before the next deploy.

REFERENCE: RULE #24 — VantagePeers Cloud MCP surface doctrine (Day 108).
"""


def _has_override_in_command(command: str) -> bool:
    """Check for override marker in the commit message embedded in the command."""
    return bool(OVERRIDE_RE.search(command))


def _resolve_repo(payload: dict) -> str:
    """Resolve the repository this commit is actually being made in, FROM
    THE PAYLOAD'S OWN cwd — never the hardcoded WORKSPACE — so a commit
    staged inside a git worktree is judged against ITS OWN index. A
    worktree's HEAD lives under a different git-dir than the main
    checkout; reading WORKSPACE's index for a worktree commit sees an
    empty diff and returns a pass on an unreviewed subject.

    `git rev-parse --show-toplevel` run FROM the payload cwd resolves a
    worktree to its own root (not the main checkout's).

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


def _schema_is_staged(staged: list[str]) -> bool:
    return SCHEMA_FILE in staged


def _mcp_tool_is_staged(staged: list[str]) -> bool:
    return any(f.startswith(MCP_TOOLS_PREFIX) for f in staged)


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

        # Only fire on commands that invoke git commit — anywhere in the
        # command line, not only at the start (see GIT_COMMIT_RE docstring).
        if not _invokes_git_commit(command):
            return 0

        # Fail-closed: a command that names a repository this hook did not
        # resolve from the payload cwd is refused, never guessed at.
        if _names_unresolved_repo(command):
            sys.stderr.write(UNRESOLVED_REPO_STDERR_MSG)
            return 2

        if _has_override_in_command(command):
            return 0

        try:
            repo = _resolve_repo(payload)
            staged = _get_staged_files(repo)
        except RepoResolutionError as exc:
            sys.stderr.write(
                "BLOCKED: enforce-mcp-tool-coverage-schema-mirror could not "
                f"resolve the repository being committed to: {exc}\n"
                "This is a REFUSAL, not a pass — an unreadable commit "
                "subject must never be treated as conformance.\n"
            )
            return 2

        if not _schema_is_staged(staged):
            return 0

        if _mcp_tool_is_staged(staged):
            return 0

        sys.stderr.write(STDERR_MSG)
        sys.stderr.write(f"Repo judged: {repo}\n")
        sys.stderr.write(f"Schema file staged: {SCHEMA_FILE}\n")
        sys.stderr.write(
            f"MCP tool files staged (mcp-server/src/tools/*): none\n"
        )
        return 2
    except Exception:
        return 0


if __name__ == "__main__":
    sys.exit(main())
