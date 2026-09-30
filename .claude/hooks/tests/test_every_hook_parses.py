"""Every guard in .claude/hooks/ must PARSE, and the ones that gate a tool must RUN.

Class of failure addressed: a guard that cannot be parsed does not fail loudly — the
interpreter exits non-zero before a single line of it executes, and the runtime reads
that as a guard which did not object. It is the strongest possible form of the defect
this corpus exists to prevent: an instrument reported green on a subject it never
examined, where here the subject is the instrument itself.

Measured on 2026-09-30, at eda2649, on main: TWO of fifty-one hooks did not parse —
`enforce-evidence-bound-completion.py` and `enforce-evidence-bound-notify.py`, both
since #1176, where a "Day 113 fleet deadlock fix" was spliced between a
`data = json.load(sys.stdin)` and the `except` belonging to its own `try`. The whole
of Evidence-Bound Done — the doctrine CLAUDE.md calls non-negotiable, with its
contentHash pinned in that file — was therefore unenforced, and this corpus reported
1848 passed over the directory holding both of them. Nothing here compiled a hook,
and no test named either file.

The first test below is the one that closes the CLASS rather than the two instances:
it enumerates the directory, so a hook added tomorrow is covered without anyone
remembering to add a case.
"""

from __future__ import annotations

import ast
import json
import subprocess
import sys
from pathlib import Path

import pytest

HOOKS_DIR = Path(__file__).resolve().parents[1]


def hook_files() -> list[Path]:
    return sorted(p for p in HOOKS_DIR.glob("*.py") if p.is_file())


def test_the_enumeration_is_not_empty():
    """A vacuous pass would prove nothing: an empty glob makes every test below green."""
    files = hook_files()
    assert len(files) > 20, (
        f"only {len(files)} hook(s) found under {HOOKS_DIR} — the enumeration is "
        "broken, and every parse assertion below would pass over an empty set"
    )


@pytest.mark.parametrize("hook", hook_files(), ids=lambda p: p.name)
def test_hook_parses(hook: Path):
    """The hook is valid Python. A SyntaxError here means it has never run."""
    source = hook.read_text(encoding="utf-8", errors="replace")
    try:
        ast.parse(source, filename=str(hook))
    except SyntaxError as exc:
        pytest.fail(
            f"{hook.name} does not parse: {exc.msg} at line {exc.lineno}. "
            "A hook that cannot be parsed never runs, and the runtime cannot tell "
            "that apart from a hook that ran and did not object."
        )


# The two files this test file was written for. Parsing is necessary and not
# sufficient: a hook whose module-level code raises also never reaches its own
# decision, and that failure is equally silent. Driving it on stdin, exactly as the
# runtime does, is what separates "imports" from "decides".
GATED = {
    "enforce-evidence-bound-completion.py": "mcp__vantage-peers__complete_task",
    "enforce-evidence-bound-notify.py": "mcp__vantage-peers__send_message",
}


@pytest.mark.parametrize("name,tool", sorted(GATED.items()))
def test_hook_reaches_its_own_decision(name: str, tool: str):
    """Driven on stdin with an UNRELATED tool, the hook must exit 0 cleanly.

    Unrelated is deliberately the easiest possible input: the hook's own Day-113
    guard should short-circuit on it. An exit code of 1, or anything on stderr that
    names a traceback, means the module died before deciding.
    """
    hook = HOOKS_DIR / name
    assert hook.exists(), f"{name} is missing from {HOOKS_DIR}"

    payload = {"tool_name": "SomeUnrelatedTool", "tool_input": {}}
    run = subprocess.run(
        [sys.executable, str(hook)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert "Traceback" not in (run.stderr or ""), (
        f"{name} raised instead of deciding:\n{run.stderr}"
    )
    assert "SyntaxError" not in (run.stderr or ""), (
        f"{name} does not parse:\n{run.stderr}"
    )
    assert run.returncode == 0, (
        f"{name} exited {run.returncode} on an unrelated tool it should ignore; "
        f"stderr:\n{run.stderr}"
    )
