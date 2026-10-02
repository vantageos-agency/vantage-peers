#!/usr/bin/env python3
"""PreToolUse(Bash) - a schema change that REMOVES a table is refused without a signed order.

Class of failure addressed. Removing a table declaration is the most destructive edit a
codebase admits, and it is indistinguishable from a tidy-up in a diff: one deleted line
that reads like dead code. Every other gate passes. The type checker is content, the
suite is green, the reviewer sees a cleanup, and the platform drops the table with its
rows on the next deploy.

It is invisible for a structural reason. A test asserts what the code DOES; nothing in a
normal suite asserts what a schema still DECLARES, so removing a declaration removes its
own witness. And the removal reads as smaller than an addition, which is the opposite of
its consequence.

The asymmetry is the whole point. ADDING a table is cheap and reversible; REMOVING one is
neither. So this guard is deliberately one-sided: it never has an opinion about additions,
renames within a declaration, or field changes. It refuses exactly one thing - a table
that was declared and is no longer.

A rename is a REMOVAL PLUS AN ADDITION and is refused as a removal, because the platform
cannot see the author's intent: it drops the old table and creates an empty new one. The
override exists for that case and states which table becomes which.

Three states, never two: no removal, a removal with a signed order, and a schema this
guard COULD NOT READ. The third refuses while saying it did not judge - a file it cannot
read is not a file it has approved.

Exit 0 = allow, exit 2 = block. Fail-open on a malformed payload: a fleet guard never
breaks a session.
"""
import json
import os
import re
import subprocess
import sys

VERSION = "1.0.0"

# Commands that can make a schema removal permanent.
COMMIT_RE = re.compile(r"\bgit\s+(?:-C\s+\S+\s+|--git-dir=\S+\s+|--work-tree=\S+\s+)*commit\b")
PUSH_RE = re.compile(r"\bgit\s+(?:-C\s+\S+\s+|--git-dir=\S+\s+|--work-tree=\S+\s+)*push\b")
DEPLOY_RE = re.compile(r"(?:npx\s+)?convex(?:@[\w.\-]+)?\s+deploy\b")

# The order that authorises a drop. It names the table, so a blanket marker cannot
# stand in for a decision about a specific one.
OVERRIDE_RE = re.compile(
    r"#\s*allow-table-drop\s*:\s*(?P<tables>[A-Za-z0-9_, ]+?)\s*[-—]\s*(?P<reason>\S.{9,})",
    re.IGNORECASE)

SAFE_FLAGS = ("--help", "-h", "--version", "--dry-run")

# A declaration, in either casing convention a Convex schema uses.
TABLE_RE = re.compile(r"^\s*(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*:\s*defineTable\b")

SCHEMA_HINT = "schema.ts"


def _repo_of(path):
    try:
        run = subprocess.run(["git", "-C", path, "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return run.stdout.strip() or None if run.returncode == 0 else None


def _schema_paths(repo, staged_only):
    """Schema files touched by the change under consideration."""
    args = ["diff", "--cached", "--name-only"] if staged_only else ["diff", "--name-only", "HEAD"]
    try:
        run = subprocess.run(["git", "-C", repo, *args],
                             capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return None
    if run.returncode != 0:
        return None
    return [f for f in run.stdout.split("\n") if f.strip().endswith(SCHEMA_HINT)]


def _tables_in(repo, ref, path):
    """Declared table names at `ref`, or None when the file could not be read."""
    try:
        if ref is None:
            with open(os.path.join(repo, path), encoding="utf-8", errors="replace") as fh:
                body = fh.read()
        else:
            run = subprocess.run(["git", "-C", repo, "show", f"{ref}:{path}"],
                                 capture_output=True, text=True, timeout=15)
            if run.returncode != 0:
                return set()  # absent at that ref is a legitimate empty set, not a failure
            body = run.stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return {m.group("name") for m in (TABLE_RE.match(line) for line in body.split("\n")) if m}


def _removals(repo, staged_only):
    """Return (removed_tables, unreadable_paths)."""
    paths = _schema_paths(repo, staged_only)
    if paths is None:
        return None, ["<the list of changed files could not be read>"]
    removed, unreadable = set(), []
    for path in paths:
        before = _tables_in(repo, "HEAD", path)
        after = _tables_in(repo, None, path)
        if before is None or after is None:
            unreadable.append(path)
            continue
        removed |= (before - after)
    return removed, unreadable


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    if data.get("tool_name") != "Bash":
        return 0
    tool_input = data.get("tool_input") or {}
    cmd = tool_input.get("command") or ""

    is_commit = bool(COMMIT_RE.search(cmd))
    is_push = bool(PUSH_RE.search(cmd))
    is_deploy = bool(DEPLOY_RE.search(cmd))
    if not (is_commit or is_push or is_deploy):
        return 0
    if any(tok in SAFE_FLAGS for tok in cmd.split()):
        return 0

    cwd = data.get("cwd") or os.environ.get("CLAUDE_CWD") or os.environ.get("PWD") or os.getcwd()
    flag = re.search(r"(?:-C\s+|--work-tree=)(?P<p>/[^\s;&|]+)", cmd)
    if flag:
        cwd = flag.group("p")

    repo = _repo_of(cwd)
    if repo is None:
        return 0  # not a repository: this guard has no subject and says so by allowing

    removed, unreadable = _removals(repo, staged_only=is_commit)

    if unreadable:
        sys.stderr.write(
            "REFUSED: this guard COULD NOT READ the schema and has judged NOTHING.\n\n"
            f"  unreadable: {', '.join(unreadable)}\n\n"
            "A schema it cannot read is not a schema it has approved. Removing a table\n"
            "drops its rows, so the doubt resolves against the change, never for it.\n\n"
            "Override (names the tables and why):\n"
            "  # allow-table-drop: <table>[,<table>] - <reason, 10 characters or more>\n")
        return 2

    if not removed:
        return 0

    match = OVERRIDE_RE.search(cmd)
    if match:
        named = {t.strip() for t in match.group("tables").split(",") if t.strip()}
        missing = removed - named
        if not missing:
            return 0
        sys.stderr.write(
            "BLOCKED: the order does not cover every table this change removes.\n\n"
            f"  removed:  {', '.join(sorted(removed))}\n"
            f"  named:    {', '.join(sorted(named)) or '(none)'}\n"
            f"  UNNAMED:  {', '.join(sorted(missing))}\n\n"
            "Each dropped table is named explicitly. A blanket order is not a decision\n"
            "about a specific table, and the one you did not name is the one that hurts.\n")
        return 2

    sys.stderr.write(
        "BLOCKED: this change REMOVES a table declaration.\n\n"
        f"  {', '.join(sorted(removed))}\n\n"
        "WHY THIS IS NOT A CLEANUP: on the next deploy the platform drops the table AND\n"
        "ITS ROWS. If customers are on this deployment, their data goes with it. Nothing\n"
        "else refuses this — the type checker is content, the suite stays green, and the\n"
        "diff reads as one deleted line.\n\n"
        "A RENAME LANDS HERE TOO, and correctly: the platform cannot see your intent. It\n"
        "drops the old table and creates an empty new one. Say which becomes which.\n\n"
        "IF THE TABLE IS UNDECLARED RATHER THAN GONE: adding a declaration is free and\n"
        "reversible. Removing one is neither. Prefer the addition.\n\n"
        "Override, naming every table and a reason:\n"
        "  # allow-table-drop: <table>[,<table>] - <reason, 10 characters or more>\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
