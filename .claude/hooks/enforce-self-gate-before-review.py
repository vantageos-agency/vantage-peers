#!/usr/bin/env python3
"""
PreToolUse hook: block a `gh pr create` whose body carries no filled
SELF-GATE block.

Class of failure closed: an author requests a review without having run the
reviewer's own checklist first, so the reviewer bounces the PR on a gap the
author could have found himself. Two real occurrences: a comment-only PR and
a relocation PR, each opened with no self-gate content, each costing a full
review round-trip. The `self-gate` skill produces the block by executing the
checklist and citing real command output; this hook makes skipping that
block structurally impossible on a fresh PR, the same way
`enforce-pr-opened-via-skill.py` makes skipping the review task impossible.

Same surface as `enforce-pr-opened-via-skill.py` (PreToolUse Bash, `gh pr
create`), distinct sub-policy: that hook checks for the `# via-open-pr`
marker; this hook checks the body content for a filled self-gate block.
Both can coexist because failing one leaves the other's precondition
unverified (hook-doctrine criterion 4).

SELF-GATE block contract (source of truth: .claude/skills/self-gate/SKILL.md):
  A `SELF-GATE:` header followed by four non-empty sub-fields: `refs`,
  `counts`, `standard`, `scope`. A header with any sub-field empty is not a
  filled block.

Override (rare, hook-doctrine four-part criterion -- clean escape path):
  `# allow-self-gate-skip: <reason>` (reason >= 6 chars) on the command
  line. Reserved for a genuinely non-review scaffolding PR.

False-positive guard: quoted string content is stripped before matching
`gh pr create`, so prose merely naming the command never trips the gate.
Other `gh pr` subcommands never match the trigger regex.

Fail-loud contract: when the body cannot be read at all (a `--body-file`
path that does not exist, or neither `--body` nor `--body-file` present),
the hook blocks and names exactly what it could not read -- it never allows
silently on an unreadable input.

Exit 0 = allow
Exit 2 = block
"""
import json
import re
import sys

GH_PR_CREATE_RE = re.compile(r"\bgh\s+pr\s+create\b", re.IGNORECASE)
OVERRIDE_RE = re.compile(r"#\s*allow-self-gate-skip\s*:\s*(.+)$", re.MULTILINE)

BODY_FLAG_RE = re.compile(r'--body(?:\s+|=)"((?:[^"\\]|\\.)*)"')
BODY_FLAG_SQ_RE = re.compile(r"--body(?:\s+|=)'((?:[^'\\]|\\.)*)'")
BODY_FILE_FLAG_RE = re.compile(r'--body-file(?:\s+|=)"([^"]+)"')
BODY_FILE_FLAG_SQ_RE = re.compile(r"--body-file(?:\s+|=)'([^']+)'")
BODY_FILE_FLAG_BARE_RE = re.compile(r"--body-file(?:\s+|=)(\S+)")

SELF_GATE_HEADER_RE = re.compile(r"SELF-GATE:\s*(.*)", re.IGNORECASE | re.DOTALL)
REQUIRED_SUBFIELDS = ("refs", "counts", "standard", "scope")


def strip_quoted_strings(command: str) -> str:
    """Remove content inside single/double quotes for matching `gh pr
    create` only -- never used to extract the body itself."""
    command = re.sub(r'"[^"]*"', '""', command)
    command = re.sub(r"'[^']*'", "''", command)
    return command


def strip_heredocs(command: str) -> str:
    """Remove heredoc bodies (<<EOF ... EOF, <<'EOF' ... EOF) before the
    trigger match, so a `gh pr create` string appearing only as heredoc DATA
    (e.g. a `cat`/`tee` writing a PR body that names the command) never trips
    the gate. The command that actually invokes gh pr create keeps it outside
    any heredoc. Used for the trigger match only -- never to extract a body."""
    return re.sub(
        r"<<-?\s*(['\"]?)(\w+)\1.*?\n\2\b",
        " ",
        command,
        flags=re.DOTALL,
    )


def extract_body(command: str):
    """Return (body_text, source, error). error is set when the body was
    referenced but could not be read -- caller must fail loud, never allow
    silently on that path."""
    m = BODY_FLAG_RE.search(command) or BODY_FLAG_SQ_RE.search(command)
    if m:
        return m.group(1), "--body", None

    m = (
        BODY_FILE_FLAG_RE.search(command)
        or BODY_FILE_FLAG_SQ_RE.search(command)
        or BODY_FILE_FLAG_BARE_RE.search(command)
    )
    if m:
        path = m.group(1)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return fh.read(), "--body-file:" + path, None
        # UnicodeDecodeError is a ValueError, NOT an OSError — without catching
        # it here a non-UTF-8 body file escapes to the top-level `except
        # Exception: allowing` and passes at exit 0, a bypass with no override
        # marker against this guard's own fail-loud contract (Eta REVISE #1210).
        # A body we cannot decode is an unreadable body: refuse, do not allow.
        except (OSError, UnicodeDecodeError) as exc:
            return None, "--body-file:" + path, str(exc)

    return None, None, "no --body or --body-file flag found"


def missing_subfields(body: str):
    """Return the list of required SELF-GATE sub-fields that are absent or
    empty. Returns None if there is no SELF-GATE header at all."""
    m = SELF_GATE_HEADER_RE.search(body)
    if not m:
        return None

    tail = m.group(1)
    missing = []
    for field in REQUIRED_SUBFIELDS:
        # `[ \t]` NOT `\s`: `\s` crosses a line boundary, so a blank `- counts:`
        # would let `\s*` eat the newline and `(.*)` capture the NEXT field's
        # line — every field borrows its successor and none is ever empty
        # (Eta REVISE #1210, all-four-blank self-gate walked through at exit 0).
        # Restricting the inter-token whitespace to spaces/tabs keeps the
        # capture on the field's own line, so a blank field reads as empty.
        field_re = re.compile(
            r"-[ \t]*" + re.escape(field) + r"[ \t]*:[ \t]*(.*)", re.IGNORECASE
        )
        fm = field_re.search(tail)
        if not fm or not fm.group(1).strip():
            missing.append(field)
    return missing


def run_hook(data: dict) -> int:
    """Return exit code (0=allow, 2=block). Pure-fn for testability."""
    try:
        if data.get("tool_name") != "Bash":
            return 0

        command = data.get("tool_input", {}).get("command", "") or ""
        sanitized = strip_quoted_strings(strip_heredocs(command))

        if not GH_PR_CREATE_RE.search(sanitized):
            return 0

        m = OVERRIDE_RE.search(command)
        if m and len(m.group(1).strip()) >= 6:
            sys.stderr.write(
                "[enforce-self-gate-before-review] override "
                "# allow-self-gate-skip -- allowed.\n"
            )
            return 0

        body, source, error = extract_body(command)

        if body is None:
            sys.stderr.write(block_message_unreadable(source, error))
            return 2

        missing = missing_subfields(body)

        if missing is None:
            sys.stderr.write(block_message_no_header(source))
            return 2

        if missing:
            sys.stderr.write(block_message_incomplete(source, missing))
            return 2

        return 0

    except Exception as exc:
        sys.stderr.write(
            f"[enforce-self-gate-before-review] WARN exception {exc}, allowing.\n"
        )
        return 0


def block_message_unreadable(source, error) -> str:
    what = source or "no --body or --body-file flag"
    return (
        "BLOCKED: gh pr create -- self-gate body could not be read.\n"
        "\n"
        f"Could not read: {what} ({error}).\n"
        "\n"
        "WHY (the timing, not the flag): this guard reads the --body-file\n"
        "at inspection time, BEFORE the command runs. A file created on the\n"
        "SAME command line -- a heredoc, or a `> file` redirect chained with\n"
        "&& before `gh pr create` -- does not exist yet when the guard looks.\n"
        "So the --body-file flag is not wrong; the file is simply absent at\n"
        "check time. (The guard cannot parse a here-document to find it, and\n"
        "must not try -- that would trade a correct guard for a fragile one.)\n"
        "\n"
        "FIX: write the description to a file in a SEPARATE step first, then\n"
        "open the PR pointing at it:\n"
        "    1) Write the filled SELF-GATE body to <path>  (its own action)\n"
        "    2) gh pr create ... --body-file <path>         (the next action)\n"
        "A review is never requested without a readable, filled SELF-GATE\n"
        "block; an inline --body carrying the filled block passes equally.\n"
        "\n"
        "Override (rare): append # allow-self-gate-skip: <reason>\n"
        "(reason >= 6 chars) to the command line, reserved for a genuinely\n"
        "non-review scaffolding PR.\n"
    )


def block_message_no_header(source) -> str:
    return (
        "BLOCKED: gh pr create -- no SELF-GATE block in the PR body.\n"
        f"(body source: {source})\n"
        "\n"
        "Every review request runs the `self-gate` skill first, which\n"
        "executes the reviewer's own checklist and emits a filled\n"
        "SELF-GATE: block (refs, counts, standard, scope) into the body\n"
        "before gh pr create runs.\n"
        "\n"
        "Override (rare): append # allow-self-gate-skip: <reason>\n"
        "(reason >= 6 chars) to the command line, reserved for a genuinely\n"
        "non-review scaffolding PR.\n"
    )


def block_message_incomplete(source, missing) -> str:
    return (
        "BLOCKED: gh pr create -- SELF-GATE block incomplete.\n"
        f"(body source: {source})\n"
        f"Missing or empty sub-field(s): {', '.join(missing)}.\n"
        "\n"
        "All four sub-fields (refs, counts, standard, scope) must be\n"
        "non-empty and filled from an executed command's output -- run the\n"
        "`self-gate` skill to produce them.\n"
        "\n"
        "Override (rare): append # allow-self-gate-skip: <reason>\n"
        "(reason >= 6 chars) to the command line, reserved for a genuinely\n"
        "non-review scaffolding PR.\n"
    )


if __name__ == "__main__" and not globals().get("_TESTING"):
    sys.exit(run_hook(json.load(sys.stdin)))
