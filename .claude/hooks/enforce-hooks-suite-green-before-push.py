#!/usr/bin/env python3
"""
PreToolUse hook: refuse `git push` while the fleet's own hook test suite
(`python3 -m pytest .claude/hooks`) reports ANY failure.

VantagePeers Cloud — closes the gap found the day after the cwd-resolution
repair to enforce-mcp-tool-coverage-schema-mirror.py and
enforce-rag-namespace-deny-test.py: both hooks' own unit-test suites went
red at the same merge (11 failures) and nothing ran them as a gate. A probe
the author wrote was green while the tests that already existed were red,
and the author ran the probe and not the tests. This hook is the fix: the
fleet's own test suite becomes a gate, not something a human has to
remember to run by hand.

Root cause class: "pre-existing" is not a category this hook accepts. The
code is us and our agents — there is no calendar excuse for a red test.
There is NO baseline file, NO tolerated count, NO exemption list. The gate
is binary: the suite is green (0 failed) or the push is refused, full stop.
A baseline-file design (permitting a stored "known failure count" to pass)
was considered and REJECTED: "a baseline that passes at 3 is exactly the
banned shape" — an exemption list that legitimizes a nonzero red state is
the same defect this hook exists to close, just moved one file over.

Enforced on:
  - Bash tool calls where the command invokes `git push` (anywhere in the
    command line — see GIT_PUSH_RE below, same non-anchored shape as the
    sibling commit gates, for the same reason: `cd <repo> && git push` and
    `git -C <repo> push` are the ORDINARY way a subagent pushes from a
    worktree, and an anchored `^git push` regex would silently miss both).

Pass conditions:
  - The command does not invoke `git push`
  - `python3 -m pytest .claude/hooks -q` (run from the payload's own
    resolved repo) reports 0 failed

Exit codes:
  0 = allow
  2 = block (suite is red, or the repository being pushed could not be
      resolved — an unreadable subject is a refusal, never conformance)

Override: NONE. This gate has no bypass marker by design — the property it
protects (the fleet's gates are individually green) has no legitimate
reason to ship red. Fix the suite, then push.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys

# Matches a `git push` invocation ANYWHERE in the command line — never
# anchored to the start (see sibling GIT_COMMIT_RE docstrings in
# enforce-mcp-tool-coverage-schema-mirror.py / enforce-rag-namespace-deny-test.py
# for why: `cd <repo> && git push origin main` and `git -C <repo> push` are
# the ordinary shape a subagent pushes from inside a git worktree).
GIT_PUSH_RE = re.compile(r"\bgit\b[^;&|\n]*?\bpush\b")

# Shell metacharacters that separate one command from the next in a chain.
CHAIN_SPLIT_RE = re.compile(r"&&|\|\||[;\n|]")

# Flags that tell git to operate on a repository OTHER than its cwd.
REPO_FLAG_RE = re.compile(r"(^|\s)(-C(\s|=)|--git-dir(=|\s)|--work-tree(=|\s))")

CD_RE = re.compile(r"^\s*cd\b")


def _strip_quoted_strings(command: str) -> str:
    """Blank out quoted substrings so a commit MESSAGE that merely mentions
    "git push" is never mistaken for an actual shell invocation. Only the
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


def _invokes_git_push(command: str) -> bool:
    return bool(GIT_PUSH_RE.search(_strip_quoted_strings(command)))


def _names_unresolved_repo(command: str) -> bool:
    """True when the command's git-push invocation explicitly names a
    repository the hook did not resolve from the payload's own `cwd` —
    either via a `-C <dir>` / `--git-dir=` / `--work-tree=` flag on the git
    invocation itself, or via a `cd` earlier in the same shell chain."""
    stripped = _strip_quoted_strings(command)
    parts = CHAIN_SPLIT_RE.split(stripped)
    push_part = None
    push_idx = None
    for idx, part in enumerate(parts):
        if GIT_PUSH_RE.search(part):
            push_part = part
            push_idx = idx
            break
    if push_part is None:
        return False
    if REPO_FLAG_RE.search(push_part):
        return True
    for earlier in parts[:push_idx]:
        if CD_RE.match(earlier):
            return True
    return False


UNRESOLVED_REPO_STDERR_MSG = """\
BLOCKED: this command names a repository the hook did not resolve.

Your command invokes `git push` together with `-C <dir>`, `--git-dir=`,
`--work-tree=`, or a `cd` earlier in the same shell chain. This hook
resolves the repository being pushed from the PreToolUse payload's own
`cwd` — guessing which repository a `cd` or a `-C` flag actually targets
is refused.

Run `git push` directly, from the repository's own working directory, with
no `cd` chaining and no `-C` / `--git-dir` / `--work-tree` flag.
"""


class RepoResolutionError(Exception):
    """Raised when the PreToolUse payload's cwd cannot be resolved to a git
    repository. The caller MUST turn this into exit 2 — never a silent
    pass. An unreadable subject is a refusal, not conformance."""


def _resolve_repo(payload: dict) -> str:
    """Resolve the repository this push is actually being made from, FROM
    THE PAYLOAD'S OWN cwd — same discipline as the sibling commit gates.
    No fallback: an absent cwd key is an unreadable subject, and REFUSES."""
    payload_cwd = (payload.get("cwd") or "").strip()
    if not payload_cwd:
        raise RepoResolutionError(
            "the tool payload carried no 'cwd' — the repository being "
            "pushed cannot be identified, and a hardcoded default would "
            "judge a different repository's test suite"
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


_SUMMARY_RE = re.compile(r"^(\d+) failed(?:, (\d+) passed)?", re.MULTILINE)
_FAILED_LINE_RE = re.compile(r"^FAILED (\S+)", re.MULTILINE)


def _run_pytest(repo: str) -> tuple[int, list[str], str]:
    """Run the fleet hook test suite from `repo`. Returns
    (failed_count, failing_node_ids, raw_output). Raises on any failure to
    even RUN the suite (timeout, missing interpreter, missing dir) — a
    suite that could not be run is treated as a refusal, never a pass."""
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pytest", ".claude/hooks", "-q"],
            capture_output=True,
            text=True,
            cwd=repo,
            timeout=300,
        )
    except Exception as exc:
        raise RepoResolutionError(
            f"repo={repo!r} — could not run the hook test suite: {exc}"
        ) from exc
    combined = result.stdout + "\n" + result.stderr
    m = _SUMMARY_RE.search(combined)
    failed = int(m.group(1)) if m else (0 if result.returncode == 0 else 1)
    failing = _FAILED_LINE_RE.findall(combined)
    return failed, failing, combined


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

        if not _invokes_git_push(command):
            return 0

        if _names_unresolved_repo(command):
            sys.stderr.write(UNRESOLVED_REPO_STDERR_MSG)
            return 2

        try:
            repo = _resolve_repo(payload)
            failed, failing, output = _run_pytest(repo)
        except RepoResolutionError as exc:
            sys.stderr.write(
                "BLOCKED: enforce-hooks-suite-green-before-push could not "
                f"verify the hook test suite: {exc}\n"
                "This is a REFUSAL, not a pass — an unreadable/unrunnable "
                "suite must never be treated as conformance.\n"
            )
            return 2

        if failed == 0:
            return 0

        names = "\n".join(f"  - {n}" for n in failing) or "  (names not parsed — see raw output below)"
        sys.stderr.write(
            "BLOCKED: enforce-hooks-suite-green-before-push — "
            f"`python3 -m pytest .claude/hooks` reports {failed} failed.\n"
            "\n"
            "Failing tests:\n"
            f"{names}\n"
            "\n"
            "There is no baseline, no tolerated count, no override marker for "
            "this gate. Fix the suite (the hook or the test, whichever is "
            "wrong), get 0 failed, then push.\n"
            "\n"
            f"Raw pytest output:\n{output}\n"
        )
        return 2
    except Exception:
        return 0


if __name__ == "__main__":
    sys.exit(main())
