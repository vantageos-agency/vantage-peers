#!/usr/bin/env python3
"""A secrets file may be SOURCED or READ BY NAME. It may not be PRINTED.

THE DEFECT THIS CLOSES, and it was committed by the author of this file.

On 2026-09-30 a subagent was dispatched with a brief whose words were:
"Never print a secret's value. Name the variable, never its content." The
subagent ran `cat .env.local` as its first step. The production Convex deploy
key, the dev key and the Clerk secret keys were printed into its transcript.
Its own `sed` redaction was applied AFTER, and did not cover that call.

The brief was not ignored. It was obeyed by an agent that had already printed
the file before it reached the part of its work where the rule applied. Nothing
between the instruction and the output could refuse. A second brief saying the
same sentence more firmly would not have changed a character of that outcome.

So the rule stops being a sentence and becomes a refusal.

WHAT IS REFUSED, and it is narrow ON PURPOSE. A guard that blocks every touch
of a secrets file gets turned off within a day, and a guard everyone turns off
protects nothing. Only the forms that put VALUES on stdout are refused:

    cat .env.local                  refused
    head/tail/less/more .env        refused
    grep CONVEX .env.local          refused  (grep prints the whole line)
    awk/cut/jq over a secrets file  refused

WHAT PASSES, because it is how the file is legitimately used:

    set -a && . ./.env.local && set +a     sourcing prints nothing
    CONVEX_DEPLOY_KEY="$KEY_NAME" npx …    using a value by variable name
    grep -oE '^[A-Z_]+=' .env.local        names only, values not captured
    grep -c / test -f / ls -l on the file  existence and counts, not contents
    sed 's/=.*/=<hidden>/' .env.local      redaction applied BEFORE printing

The asymmetry is deliberate and is the safe direction: a command that might
print is refused, and a command that provably cannot is allowed. A refusal
costs one rewrite; a printed production key costs a rotation across a fleet.

OVERRIDE. `# allow-secret-file-read: <reason of 15 characters or more>` — for
the case where a human genuinely must see a value. Fifteen characters because a
reason shorter than that is a word, and a word is not a reason. Each use is a
line in the audit log, which is the whole difference from what happened.
"""

import json
import os
import re
import sys

AUDIT_LOG = "/tmp/secret-file-print.log"

# Files whose CONTENTS are secrets. Matched on the basename, so a path prefix
# cannot hide one. `.env.example` and `.env.sample` are deliberately NOT here:
# they carry names with placeholder values and are meant to be read.
SECRET_FILE_RE = re.compile(
    r"""(?x)
    (?:^|[\s"'=/])                      # start, separator, or path boundary
    (?P<path>
        [^\s"';|&<>]*                   # optional directory part
        (?:
            \.env(?:\.[A-Za-z0-9_-]+)?  # .env, .env.local, .env.production
          | id_[rd]sa                   # ssh private keys
          | \.pem
          | auth\.json                  # vercel / npm credential stores
          | credentials(?:\.json)?
          | \.npmrc
        )
    )
    (?=$|[\s"';|&<>)])
    """
)

# Allowed because the placeholder files carry no real value.
PLACEHOLDER_RE = re.compile(r"\.env\.(?:example|sample|template)$")

# Commands that put a file's CONTENTS on stdout.
PRINTERS = (
    "cat", "bat", "head", "tail", "less", "more", "nl", "od", "xxd", "strings",
    "awk", "cut", "jq", "tr", "rev", "sort", "uniq", "tac", "column",
)

# `grep` prints the whole matching LINE, so `grep KEY .env` prints the value.
# It is safe only when the match itself is restricted with -o, or when only a
# COUNT or a FILENAME is asked for.
GREP_SAFE_RE = re.compile(r"\bgrep\b[^|;&]*?\s-[A-Za-z]*[oclLq][A-Za-z]*(?=\s|$)")

# `sed`/`perl` are safe when they REDACT before printing: the script replaces
# everything after the first `=`. Anything else with sed is treated as printing.
REDACTING_SED_RE = re.compile(r"s[/|#].*=\.\*[/|#]")

OVERRIDE_RE = re.compile(r"#\s*allow-secret-file-read:\s*(?P<reason>.{15,})")


def secret_paths(command: str):
    """Every secrets-shaped path the command names, placeholders excluded."""
    found = []
    for m in SECRET_FILE_RE.finditer(command):
        path = m.group("path")
        if PLACEHOLDER_RE.search(path):
            continue
        found.append(path)
    return found


def sourcing_only(segment: str) -> bool:
    """`. ./.env.local` and `source .env` read the file into the shell and
    print nothing. This is the legitimate use and it must stay cheap.

    The dot must be the segment's FIRST word. Anchoring it anywhere was
    measured wrong on `jq . credentials.json`, where the `.` is jq's filter
    argument: the guard read it as a source command and let a credential file
    through. A pattern that turns another command's ARGUMENT into a licence is
    the shape this whole file exists to refuse."""
    return bool(re.match(r"\s*(?:source|\.)\s+\S", segment))


def prints_contents(command: str) -> bool:
    """Does any segment of this command put the file's contents on stdout?

    Judged per SEGMENT rather than on the whole line, because a command may
    legitimately source the file and then run something else entirely."""
    for segment in re.split(r"[;&|]+|\n", command):
        if not secret_paths(segment):
            continue
        if sourcing_only(segment):
            continue
        if re.search(r"\bsed\b", segment) and REDACTING_SED_RE.search(segment):
            continue
        if re.search(r"\bgrep\b", segment):
            if GREP_SAFE_RE.search(segment):
                continue
            return True
        # `test -f`, `ls`, `stat`, `wc`, `sha256sum`, `md5sum` report ABOUT the
        # file without revealing what is in it.
        if re.search(r"\b(?:test|ls|stat|wc|sha256sum|md5sum|find|rm|cp|mv|chmod|chown|touch)\b", segment):
            if not re.search(r"\b(?:%s)\b" % "|".join(PRINTERS), segment):
                continue
        if re.search(r"\b(?:%s)\b" % "|".join(PRINTERS), segment):
            return True
    return False


def audit(entry: dict) -> None:
    try:
        with open(AUDIT_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # a log that cannot be written never blocks a command


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0  # unreadable payload: this guard has nothing to judge

    if data.get("tool_name") != "Bash":
        return 0
    command = data.get("tool_input", {}).get("command", "")
    if not command:
        return 0

    paths = secret_paths(command)
    if not paths or not prints_contents(command):
        return 0

    override = OVERRIDE_RE.search(command)
    if override:
        audit({
            "verdict": "allow",
            "reason": "override",
            "override_reason": override.group("reason").strip()[:200],
            "paths": paths[:5],
        })
        return 0

    audit({"verdict": "block", "paths": paths[:5], "command": command[:200]})
    named = ", ".join(sorted(set(paths))[:5])
    print(
        f"BLOCKED: this command would print the CONTENTS of a secrets file: {named}\n"
        "\n"
        "A secrets file may be SOURCED or read BY VARIABLE NAME. It may not be\n"
        "printed. On 2026-09-30 a subagent whose brief said 'never print a secret's\n"
        "value' ran `cat .env.local` as its first step and put a production deploy\n"
        "key into its transcript. The brief was not ignored — nothing could refuse.\n"
        "\n"
        "What to do instead, in order of preference:\n"
        "  set -a && . ./.env.local && set +a      # source it; prints nothing\n"
        "  CONVEX_DEPLOY_KEY=\"$SOME_KEY_NAME\" ...   # use the value by its NAME\n"
        "  grep -oE '^[A-Z_]+=' .env.local         # the names, never the values\n"
        "  sed 's/=.*/=<hidden>/' .env.local       # redact BEFORE printing\n"
        "  test -f / ls -l / sha256sum             # facts about it, not its contents\n"
        "\n"
        "If a human genuinely must see a value, say why in the command:\n"
        "  <your command>  # allow-secret-file-read: <reason, 15 characters or more>\n"
        "\n"
        f"Audit trail: {AUDIT_LOG}\n",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
