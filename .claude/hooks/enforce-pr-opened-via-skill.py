#!/usr/bin/env python3
"""
PreToolUse hook: enforce that every `gh pr create` is opened via the `open-pr`
skill, never as a raw command.

Class of failure closed: a raw `gh pr create` opens a pull request with no
review task and no notification to the reviewer or the coordinator. The
delivery sits ready-but-invisible until someone polls for it, which violates
the report-on-complete and dispatch-contract review-gate doctrine. The
`open-pr` skill closes the gap by composing three atomic acts in one
invocation (open PR with the marker, create exactly one reviewer review task,
notify the reviewer plus coordinator) — this hook makes the raw path
impossible so the atomic path is the only path.

Trigger: `tool_name == "Bash"` and the command INVOKES `gh pr create` (any
position: leading env vars, chained with `&&`, inside a shell payload, etc.)
without the fixed, literal marker `# via-open-pr` that the `open-pr` skill
appends to every PR it opens.

Marker contract (source of truth: .claude/skills/open-pr/SKILL.md):
  `# via-open-pr`  — byte-exact, appended as a shell comment on the
  `gh pr create` command line. Never paraphrased, never abbreviated.

Override (rare, hook-doctrine four-part criterion — clean escape path):
  `# allow-raw-pr: <reason>` (reason >= 6 chars) on the same command line.
  Reserved for a genuinely non-review PR (e.g. a scaffolding PR against an
  empty repo with no reviewer yet configured) or a documented one-shot
  migration. Each use is a signal to re-check whether the case belongs in
  the skill's scope instead.

False-positive guard: the decision is taken on the REAL argv the shell runs, by
the shared probe in `.claude/hooks/_lib/command_predicate.py`. Quoted prose that
merely names the command (`git commit -m "docs: gh pr create flow"`) is one
token, not an invocation, so it never trips the gate. Other `gh pr` subcommands
(`view`, `merge`, `list`, `diff`, `checks`, `comment`) never match.

WRAPPER CLASS (closed, Day 133): the guarded command is judged where a shell or a
wrapper runs it: `bash -c` / `sh -c` / `zsh -c` / any POSIX shell, `eval`, `env
[VAR=..]`, `command`, `exec`, `xargs`, `nohup` / `timeout` / `sudo` prefixes, `{ ...; }`,
`! ...`, `find -exec`, a heredoc fed to a shell, and a quoted `;` / `&&` chain inside
a payload. A payload the probe cannot read (a shell variable as the command head, or
`eval` / `bash -c` of one) is REFUSED, never allowed, and the refusal names the reason.

RESIDUE (what this guard does NOT read, so it is not mistaken for coverage):
- Interpreter SOURCE (`python3 -c`, `node -e`, a heredoc fed to python) is not read as
  shell: a `gh pr create` written inside a Python or Node program passes.
- A script FILE (`bash open.sh`) is not opened, so its contents are not judged.
- The `# via-open-pr` marker is text on the command line, not an authenticated token.
  Any command carrying it passes, as before this change; this is a process gate.

Exit 0 = allow
Exit 2 = block
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib.command_predicate import scan_invocations  # noqa: E402

GH_PR_CREATE = ("gh", "pr", "create")
MARKER = "# via-open-pr"
OVERRIDE_RE = re.compile(r"#\s*allow-raw-pr\s*:\s*(.+)$", re.MULTILINE)


def run_hook(data: dict) -> int:
    """Return exit code (0=allow, 2=block). Pure-fn for testability."""
    try:
        if data.get("tool_name") != "Bash":
            return 0

        command = data.get("tool_input", {}).get("command", "") or ""

        try:
            hits, unresolved = scan_invocations(command, GH_PR_CREATE)
        except Exception as exc:
            # A probe that cannot read the command cannot clear it.
            hits, unresolved = [], [f"the predicate could not read this command: {exc}"]

        if unresolved:
            # A payload this guard cannot read is refused, never allowed.
            sys.stderr.write(unresolved_message(unresolved[0]))
            return 2

        if not hits:
            return 0

        if MARKER in command:
            return 0

        m = OVERRIDE_RE.search(command)
        if m and len(m.group(1).strip()) >= 6:
            sys.stderr.write(
                "[enforce-pr-opened-via-skill] override # allow-raw-pr — allowed.\n"
            )
            return 0

        sys.stderr.write(block_message())
        return 2

    except Exception as exc:
        sys.stderr.write(
            f"[enforce-pr-opened-via-skill] WARN exception {exc}, allowing.\n"
        )
        return 0


def unresolved_message(reason: str) -> str:
    return (
        "BLOCKED: the command carries a payload this guard cannot read.\n"
        "\n"
        f"  {reason}\n"
        "\n"
        "A payload that cannot be read is refused, never allowed: a shell variable in\n"
        "a command head, or an eval of one, hides the command it runs. Write\n"
        "`gh pr create` literally on the command line with the `# via-open-pr`\n"
        "marker, then run it again.\n"
    )


def block_message() -> str:
    return (
        "BLOCKED: raw `gh pr create` — every PR is opened via the `open-pr` skill.\n"
        "\n"
        "Reason: a raw `gh pr create` opens a PR with no reviewer review task and\n"
        "no notification. The delivery sits ready-but-invisible until someone\n"
        "polls for it.\n"
        "\n"
        "Use /open-pr — it runs `gh pr create` with the `# via-open-pr` marker,\n"
        "creates exactly one reviewer review task citing the PR number and head\n"
        "SHA, and notifies channel `eta,pi` in the same invocation.\n"
        "\n"
        "Override (rare): append `# allow-raw-pr: <reason>` (reason >= 6 chars)\n"
        "to the command line, reserved for a genuinely non-review PR or a\n"
        "documented one-shot migration.\n"
    )


if __name__ == "__main__" and not globals().get("_TESTING"):
    sys.exit(run_hook(json.load(sys.stdin)))
