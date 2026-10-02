#!/usr/bin/env python3
"""PreToolUse: a report addressed to the OPERATOR is six lines, named things, no jargon.

Class of failure addressed: an orchestrator reports to the person who runs the
factory by narrating. Each clause is defensible, the account is accurate, and it
costs the reader minutes where thirty seconds would do. The author judges by the
argument rather than by the reading, so the author always finds the extra clause
justified -- which makes the author's judgement the failing instrument. Only a
number the author cannot argue with holds.

SCOPE: messages whose channel is the operator. Peer-to-peer traffic is NOT
capped -- technical precision between stations has value, and a cap there buys
nothing. This guard exists for one reader.

It refuses LENGTH, SHAPE and a closed list of internal vocabulary. It never
judges whether a sentence is an anecdote: a guard that decides on meaning blocks
the legitimate and gets torn out within the week, after which it guards nothing.
"""
import json
import os
import re
import sys

MAX_CHARS = 700
MAX_LINES = 6

# The operator-facing channel names, read from the environment where a station
# names its own, so this list is not a typed constant that drifts.
OPERATOR_CHANNELS = {
    c.strip().lower()
    for c in (os.environ.get("OPERATOR_CHANNELS") or "operator,human").split(",")
    if c.strip()
}

OVERRIDE = re.compile(r"(?://|#)\s*allow-long-report\s*:\s*(\S.{9,})", re.I)

SIGNATURE = re.compile(r"^\s*Orchestrator:\s.+\|\s*\d{4}-\d{2}-\d{2}\s*$")
TAG_LINE = re.compile(r"^\s*\[[A-Z][A-Z \-_]*\]")
TABLE_ROW = re.compile(r"^\s*\|")

# Internal vocabulary that means nothing to this reader. Each entry carries its
# plain equivalent, and the refusal prints it so the writer is not left guessing.
JARGON = {
    "completionNote": "what the task recorded when it closed",
    "dependsOn": "what it waits for",
    "PreToolUse": "the moment the guard runs",
    "bite-probe": "the test that makes the guard refuse",
    "bipolar": "tested both ways",
    "IRP": "input, result, postcondition",
    "TDD": "the test written before the code",
    "backfill": "the pass that fills the missing rows",
    "mergeStateStatus": "whether it can be merged",
    "headRefOid": "the commit at the tip",
    "upsert": "write or update",
    "idempotent": "runs twice without doubling",
    "vitest": "the test suite",
    "tsc": "the type checker",
    "porcelain": "the list of uncommitted files",
}


def measure(content: str):
    kept, has_table = [], False
    for raw in (content or "").splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        if SIGNATURE.match(line):
            continue
        if TABLE_ROW.match(line):
            has_table = True
        if TAG_LINE.match(line):
            continue
        kept.append(line)
    return len("\n".join(kept)), len(kept), has_table


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if payload.get("tool_name") != "mcp__vantage-peers__send_message":
        return 0
    ti = payload.get("tool_input") or {}
    channels = {c.strip().lower() for c in (ti.get("channel") or "").split(",")}
    if not (channels & OPERATOR_CHANNELS):
        return 0
    content = ti.get("content") or ""
    if not content or OVERRIDE.search(content):
        return 0

    chars, lines, has_table = measure(content)
    found = [w for w in JARGON if re.search(rf"\b{re.escape(w)}\b", content)]

    problems = []
    if chars > MAX_CHARS:
        problems.append(f"  {chars} characters; the cap is {MAX_CHARS}.")
    if lines > MAX_LINES:
        problems.append(f"  {lines} non-empty lines; the cap is {MAX_LINES}.")
    if has_table:
        problems.append("  it contains a table. A table is a document, not a report.")
    if found:
        problems.append("  internal vocabulary this reader does not use:")
        for w in sorted(found)[:6]:
            problems.append(f"      {w}  ->  {JARGON[w]}")
    if not problems:
        return 0

    sys.stderr.write(
        "BLOCKED: this report is addressed to the operator.\n\n"
        + "\n".join(problems)
        + "\n\n"
        "Lead with the result. Name the thing exactly as it is written, then say\n"
        "in ordinary words what it does -- a bare name is a lookup imposed on the\n"
        "reader, and a description without the name cannot be searched.\n\n"
        "CUT A SUBJECT, NOT A CLAUSE. A second decision gets its own report.\n"
        "Detail belongs in the task or the pull request; neither is capped.\n\n"
        "Not charged: the tag line, the signature, blank lines.\n\n"
        "Override (rare): // allow-long-report: <reason, 10 characters or more>\n"
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
