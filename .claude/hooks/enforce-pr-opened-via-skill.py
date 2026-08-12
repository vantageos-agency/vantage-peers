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

Trigger: `tool_name == "Bash"` and the command invokes `gh pr create` (any
position: leading env vars, chained with `&&`, etc.) without the fixed,
literal marker `# via-open-pr` that the `open-pr` skill appends to every PR
it opens.

Marker contract (source of truth: .claude/skills/open-pr/SKILL.md):
  `# via-open-pr`  — byte-exact, appended as a shell comment on the
  `gh pr create` command line. Never paraphrased, never abbreviated.

Override (rare, hook-doctrine four-part criterion — clean escape path):
  `# allow-raw-pr: <reason>` (reason >= 6 chars) on the same command line.
  Reserved for a genuinely non-review PR (e.g. a scaffolding PR against an
  empty repo with no reviewer yet configured) or a documented one-shot
  migration. Each use is a signal to re-check whether the case belongs in
  the skill's scope instead.

False-positive guard: quoted string content (e.g. `git commit -m "docs: gh pr
create flow"`) is stripped before matching `gh pr create`, so prose merely
naming the command never trips the gate. Other `gh pr` subcommands (`view`,
`merge`, `list`, `diff`, `checks`, `comment`) never match the trigger regex.

Exit 0 = allow
Exit 2 = block
"""
import json
import re
import sys

GH_PR_CREATE_RE = re.compile(r"\bgh\s+pr\s+create\b", re.IGNORECASE)
MARKER = "# via-open-pr"
OVERRIDE_RE = re.compile(r"#\s*allow-raw-pr\s*:\s*(.+)$", re.MULTILINE)


def strip_quoted_strings(command: str) -> str:
    """Remove content inside single/double quotes to avoid false positives
    on text like `git commit -m "docs: gh pr create flow"`."""
    command = re.sub(r'"[^"]*"', '""', command)
    command = re.sub(r"'[^']*'", "''", command)
    return command


def run_hook(data: dict) -> int:
    """Return exit code (0=allow, 2=block). Pure-fn for testability."""
    try:
        if data.get("tool_name") != "Bash":
            return 0

        command = data.get("tool_input", {}).get("command", "") or ""
        sanitized = strip_quoted_strings(command)

        if not GH_PR_CREATE_RE.search(sanitized):
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
