#!/usr/bin/env python3
"""
PreToolUse hook : enforce Pi-signed authorization before PR merge / push to main
of client-facing fleet repos.

Blocks Bash commands containing `gh pr merge` or `git push origin main` (or
equivalents) for fleet client-facing repos unless one of:
  - Env var PI_AUTHORIZED_MERGE_TASK_ID is set to a valid VP task ID (k...)
  - Command includes explicit flag `--pi-authorized-merge=k...`
  - Comment on same line `# pi-authorized-merge: k...`
  - Laurent override comment `# laurent-direct-merge`

Reason: Day 87 incident (2026-05-29) — Athena PR #7 + CLAUDE.md fork-residue
commit — auto-mode classifier bloqué Athena sur "Pi GO MERGE" indirect via
send_message. Pi a proposé "attendre Laurent direct merge" → Laurent corrige :
"on construit un système autonome / le système ne doit pas dépendre de moi!"

Pattern extension Day 82 PI-SIGNED PROD DEPLOY AUTHORIZATION applied to merge :
Pi devient autorité fleet pour merges client-facing (déjà 2nd reviewer fleet,
devient aussi authority merge).

Standing rule canonique: memory j577xjby0mncv7wpx4ewjz4n5s87nbcw (global/feedback)
extends Day 82 doctrine (j57bkwc99fnwp348m52d9rw5p987ggq6 + mission k57a32vgtyy9x2gjqe456n6hhs87er7v).

Override discipline: PI_AUTHORIZED_MERGE_TASK_ID is meant for one-shot pre-validated
merge. Set, run gh pr merge once, unset. Never persist in shell rc.

Audit trail: /tmp/pi-auth-pr-merge.log (append-only per call).

Exit 0 = allow
Exit 2 = block
"""
import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

# Patterns that indicate client-facing fleet repo merge
# Hors scope: Pi-workspace internes (CLAUDE.md, .claude/), docs-only PRs
FLEET_CLIENT_FACING_REPOS = [
    r"\belpiarthera/gptpowerups-extension\b",  # chi
    r"\belpiarthera/vantage-peers-extension\b",  # hermes
    r"\belpiarthera/vantage-crm-extension\b",  # athena
    r"\belpiarthera/vantage-gmail-addon\b",  # demeter
    r"\belpiarthera/vantage-peers-dashboard\b",  # sigma (kappa BU)
    r"\belpiarthera/vantage-bridge\b",  # mu
    r"\bvantageos-agency/vantage-peers\b",  # sigma BU
    r"\belpiarthera/vantage-registry\b",  # omega
    r"\belpiarthera/gptpowerups-backend\b",  # iota
    r"\belpiarthera/gptpowerups-site\b",  # psi
    r"\belpiarthera/vantageos-crm\b",  # theta
]

# Commands that trigger fleet merge
MERGE_CMD_PATTERNS = [
    r"\bgh\s+pr\s+merge\b",  # GitHub CLI PR merge
    r"\bgit\s+push\s+origin\s+main\b",  # direct push main
    r"\bgit\s+push\s+.*\bmain\b",  # push variant main
]

# Override token (Pi PR-MERGE-AUTHORIZED task ID, format k... — Convex IDs)
APPROVED_TASK_RE = re.compile(r"\bk[a-z0-9]{15,40}\b")

# Audit log path
AUDIT_LOG = "/tmp/pi-auth-pr-merge.log"


def strip_quoted_strings(command: str) -> str:
    """Remove content inside single/double quotes to avoid false positives
    on text like `git commit -m "merge main into feature"`."""
    command = re.sub(r'"[^"]*"', '""', command)
    command = re.sub(r"'[^']*'", "''", command)
    return command


def _command_cwd(command: str) -> str:
    """Working directory the command will run in: a leading `cd <path> &&`
    prefix wins, else the hook process cwd (inherited from the tool call)."""
    match = re.match(r"\s*cd\s+(['\"]?)([^'\"&;|]+)\1\s*&&", command)
    if match:
        return match.group(2).strip()
    return os.getcwd()


def _remote_repo(cwd: str) -> str | None:
    """Derive the target repo from the git remote of the command's cwd —
    the only source of truth for where a merge lands (derive-never-type).
    Returns None when unreadable."""
    try:
        result = subprocess.run(
            ["git", "-C", cwd, "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=10,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def is_fleet_merge(command: str) -> bool:
    """Returns True if command is a merge/push targeting a fleet client-facing repo.
    Day 130 fail-open closed: `gh pr merge N` from a checkout names no repo —
    gh derives it from the git remote, so the gate must derive it the same way.
    A PWD path pattern never matches an org/repo and guarded nothing.
    Fail-closed: a merge whose target repo cannot be established is refused."""
    sanitized = strip_quoted_strings(command)
    cmd_lower = sanitized.lower()

    has_merge = any(re.search(p, cmd_lower) for p in MERGE_CMD_PATTERNS)
    if not has_merge:
        return False

    # Help/dry invocations act on nothing — never gate them (a false positive
    # on --help teaches operators to bypass, and a bypassed guard guards nothing).
    if re.search(r"(^|\s)(--help|-h)(\s|$)", sanitized):
        return False

    # Explicit repo in the command wins
    if any(re.search(p, sanitized, re.IGNORECASE) for p in FLEET_CLIENT_FACING_REPOS):
        return True

    # No explicit repo: derive from the git remote of the command's cwd
    remote = _remote_repo(_command_cwd(command))
    if remote is None:
        # Unreadable remote on a merge command: refuse rather than assume.
        return True
    return any(re.search(p, remote, re.IGNORECASE) for p in FLEET_CLIENT_FACING_REPOS)


def has_pi_authorization(command: str) -> bool:
    """Check for Pi-signed merge authorization (env var, flag, or comment)."""
    # Env var (set BEFORE subprocess spawn, not inline-prefixed shell var)
    env_task = os.environ.get("PI_AUTHORIZED_MERGE_TASK_ID", "").strip()
    if env_task and APPROVED_TASK_RE.fullmatch(env_task):
        return True

    # Inline flag --pi-authorized-merge=k...
    if re.search(r"--pi-authorized-merge=k[a-z0-9]{15,40}\b", command):
        return True

    # Inline comment # pi-authorized-merge: k...
    if re.search(r"#\s*pi-authorized-merge:\s*k[a-z0-9]{15,40}\b", command):
        return True

    return False


def has_laurent_override(command: str) -> bool:
    """Laurent direct override comment for rare manual cases."""
    return bool(re.search(r"#\s*laurent-direct-merge\b", command))


# ---------------------------------------------------------------------------
# THE REVIEWER'S VERDICT — added after two pull requests landed on main over a
# live REVISE (vantageos-crm #215 @ b53b3890, vantage-peers #1364 @ 824cf8a2).
#
# The token check above answers ONE question correctly: is there a Pi-signed
# authorization. It is SILENT on the question the fleet reads it as answering:
# did the REVIEWER say yes. A missing guard is visible; a silent one is cited as
# protection, which is why this is worse than an absent check.
#
# The two questions are asked separately. The token check is untouched.
# ---------------------------------------------------------------------------

# A verdict OPENS a comment: the first non-empty line is a markdown header whose
# text, after the reviewer's name and a dash, IS the verdict word. This is not
# "the last comment containing APPROVED": on vantage-peers #1370 the last such
# comment is "### Eta - correction to the merge order in my re-pin (APPROVED @
# ...)", a note ABOUT a verdict, and selecting on the word lands on it.
VERDICT_OPENER_RE = re.compile(
    r"^\s{0,3}#{1,6}\s*[^\n]{0,60}?[\u2014-]\s*"
    r"(?P<verdict>APPROVED|REVISE|REJECTED|BLOCKED)\b",
    re.IGNORECASE,
)

# The override. A merge over a live REVISE is sometimes right — a prose-only
# finding, a reviewer unavailable while a client waits. What is banned is the
# SILENT version, which is what happened twice. Fifteen characters, because a
# reason shorter than that is a word, and a word is not a reason.
MERGE_OVER_REVISE_RE = re.compile(r"#\s*merge-over-revise:\s*(?P<reason>.{15,})")

PR_NUMBER_RE = re.compile(r"\bgh\s+pr\s+merge\s+(?P<pr>\d+)\b")
PR_REPO_RE = re.compile(r"(?:-R|--repo)[=\s]+(?P<repo>[\w.-]+/[\w.-]+)")

# The pull request as a URL, which `gh pr merge` accepts in place of a number.
PR_URL_RE = re.compile(r"https?://[^\s\"']*/pull/(?P<pr>\d+)\b")

# Flags of `gh pr merge` that TAKE A VALUE. Their value is not the pull request,
# and `--body 215` must never be read as one.
_VALUE_FLAGS = {
    "-R", "--repo", "-b", "--body", "-F", "--body-file", "-t", "--subject",
    "-m", "--match-head-commit", "--author-email",
}


def extract_pr_number(command: str):
    """The pull request `gh pr merge` will act on, derived from ANY argument
    shape — or None, which this guard treats as a REFUSAL, never as a skip.

    Measured wrong by Eta on PR #1371 @ 536ceee: `PR_NUMBER_RE` alone requires
    the number to sit immediately after `merge`, so `gh pr merge --squash 215`,
    `gh pr merge -R owner/repo 215` and the /pull/215 URL form all failed to
    match. The caller then fell through the verdict block entirely and the audit
    line recorded `verdict-approved-at-head` for a verdict that was never read —
    a guard going green on a subject it never examined, written into the log as
    if it had examined it.

    The number is therefore derived by TOKENISING, so argument order cannot hide
    it, and the failure to derive one is an answer rather than a silence."""
    if not command:
        return None

    m = PR_NUMBER_RE.search(command)
    if m:
        return m.group("pr")
    m = PR_URL_RE.search(command)
    if m:
        return m.group("pr")

    # Tokenise from `gh pr merge` onward and take the first bare number that is
    # not the value of a value-taking flag.
    head = re.search(r"\bgh\s+pr\s+merge\b", command)
    if not head:
        return None
    try:
        tokens = shlex.split(command[head.end():])
    except ValueError:
        tokens = command[head.end():].split()

    skip_next = False
    for tok in tokens:
        if skip_next:
            skip_next = False
            continue
        if tok in _VALUE_FLAGS:
            skip_next = True
            continue
        if tok.startswith("-"):
            continue  # `--flag=value` and valueless flags alike
        if tok.isdigit():
            return tok
        m = PR_URL_RE.search(tok)
        if m:
            return m.group("pr")
    return None


def first_nonempty_line(body: str) -> str:
    for line in (body or "").splitlines():
        if line.strip():
            return line
    return ""


# A REFUSAL is looked for on EVERY announcement line of a comment, not only the
# opening one. Measured by Eta on #1371 @ 536ceee: reading the first line alone
# means a RIEN line, a bold opener, an en dash or the word CHANGES_REQUESTED
# hides a live refusal, and the selection then lands on an OLDER APPROVED — the
# exact failure this whole block was added to close, one formatting choice away.
#
# The asymmetry is deliberate and is the safe direction: a refusal is heard
# wherever it is written, an APPROVAL is heard only where the convention puts it.
# The refusal words are matched in CAPITALS ONLY, because prose about this guard
# routinely contains `verdict-says-revise` in lower case and that is a sentence,
# not a verdict.
REFUSAL_LINE_RE = re.compile(
    r"^\s{0,3}(?:#{1,6}|\*\*|__)?[^\n]{0,80}?"
    r"\b(?P<verdict>REVISE|REJECTED|BLOCKED|CHANGES_REQUESTED)\b"
)


def refusal_in_any_line(body: str):
    """The first refusal announced anywhere in the comment, or None."""
    for line in (body or "").splitlines():
        m = REFUSAL_LINE_RE.match(line)
        if m:
            return m.group("verdict").upper()
    return None


def verdict_of(body: str):
    """The verdict this comment carries, or None if it carries none.

    Property 1 of the contract is unchanged for APPROVAL: a follow-up note
    quoting an earlier verdict does not GRANT one, so only the opening line can
    say yes. A refusal is read from any announcement line, and a refusal found
    anywhere outranks an approval on the opening line — a reviewer who approved
    and then refused in the same comment has refused."""
    refusal = refusal_in_any_line(body)
    if refusal:
        return refusal
    m = VERDICT_OPENER_RE.match(first_nonempty_line(body))
    return m.group("verdict").upper() if m else None


SHA_RE = re.compile(r"\b[0-9a-f]{7,40}\b")


def _contains_head(text: str, head: str) -> bool:
    """Containment, never a formatted-SHA pattern — property 2.

    Reviewers write the head inside backticks, after an at-sign, and on a bare
    line. A pattern expecting one spelling reports a pinned verdict as unpinned,
    so every non-alphanumeric character is stripped from both sides and the
    prefix is looked for in what remains. Seven characters is git's own
    abbreviation floor; shorter would collide and make containment a coin toss."""
    flat = re.sub(r"[^0-9a-zA-Z]", "", text or "").lower()
    h = (head or "").lower()
    return bool(h) and (h in flat or h[:8] in flat or h[:7] in flat)


def names_head(body: str, head: str) -> bool:
    """Does this verdict PIN the head being merged?

    The opening line decides WHENEVER IT CARRIES A SHA AT ALL, because that is
    where the convention puts the pin: "### Eta - APPROVED - repo #N @ `abc1234`".
    Falling back to the whole body unconditionally was measured wrong on
    vantage-peers #1370: its last verdict pins `032394ce`, and the body also
    mentions `df57da7` in the sentence "identical to the approved df57da7 tree".
    Whole-body containment therefore answered YES for a head the verdict does
    not pin — a sha mentioned in passing read as an authorisation, which is the
    same shape as treating "it has a caller" as "it is authorised".

    A verdict whose opening line carries NO sha is not using the convention, so
    the body is consulted rather than refusing a reviewer for their formatting."""
    if not head:
        return False
    opening = first_nonempty_line(body)
    if SHA_RE.search(opening):
        return _contains_head(opening, head)
    return _contains_head(body, head)


def judge_verdict(comments, head):
    """Pure decision, so the corpus drives it without a network call.

    Returns (allowed: bool, cause: str, detail: str). The three causes are kept
    DISTINCT — property 4 — because one message for three causes sends the
    reader to the wrong remedy."""
    if comments is None:
        return (False, "no-verdict-readable",
                "the pull request's comments could not be read; could-not-read "
                "and found-nothing are different facts and neither is a pass")
    verdicts = [c for c in comments if verdict_of(c.get("body", ""))]
    if not verdicts:
        return (False, "no-verdict-readable",
                "no comment on this pull request OPENS with a reviewer verdict")
    last = verdicts[-1]
    word = verdict_of(last.get("body", ""))
    opening = first_nonempty_line(last.get("body", ""))[:160]
    if word != "APPROVED":
        return (False, "verdict-says-revise",
                f"the last verdict is {word}: {opening}")
    if not names_head(last.get("body", ""), head):
        return (False, "verdict-does-not-name-this-head",
                f"the last verdict is APPROVED but does not name {head[:12]}: {opening}")
    return (True, "approved-at-this-head", opening)


def read_pr_comments(repo: str, pr: str):
    """Returns (comments, head) or (None, None) when the read FAILED.

    A failed read must never be indistinguishable from an empty comment list —
    that is the collapse this whole file exists to prevent."""
    try:
        result = subprocess.run(
            ["gh", "pr", "view", str(pr), "-R", repo, "--json", "comments,headRefOid"],
            capture_output=True, text=True, timeout=30,
            env={**os.environ, "GH_TOKEN": "", "GITHUB_TOKEN": ""},
        )
        if result.returncode != 0:
            return (None, None)
        payload = json.loads(result.stdout)
        return (payload.get("comments", []), payload.get("headRefOid", ""))
    except Exception:
        return (None, None)


def audit_log(entry: dict) -> None:
    """Append-only audit log to /tmp/pi-auth-pr-merge.log."""
    try:
        with open(AUDIT_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # Fail-open on log write error


try:
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    if tool_name != "Bash":
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")
    if not command:
        sys.exit(0)

    if not is_fleet_merge(command):
        sys.exit(0)

    # Laurent override (rare manual case)
    if has_laurent_override(command):
        audit_log({
            "ts": int(time.time()),
            "verdict": "allow",
            "reason": "laurent-direct-merge",
            "command": command[:200],
        })
        sys.exit(0)

    # Pi-signed authorization. It is NECESSARY and, since the two pull requests
    # that landed over a live REVISE, no longer SUFFICIENT: the reviewer's
    # verdict on the head being merged is a separate question, asked below.
    if has_pi_authorization(command):
        # A pull request this guard cannot NAME is one whose verdict it cannot
        # read, and an unread verdict is never a pass. The previous shape was
        # `if pr_m:` — on a command whose number it failed to parse it skipped
        # this whole block and logged `verdict-approved-at-head`, asserting in
        # the audit trail the very examination it had just declined to perform.
        pr_number = extract_pr_number(command)
        repo_m = PR_REPO_RE.search(command)
        if not pr_number:
            allowed, cause, detail = (
                False, "no-verdict-readable",
                "the pull request number could not be derived from this command, "
                "so no verdict could be read; name the pull request explicitly",
            )
        else:
            repo = repo_m.group("repo") if repo_m else _remote_repo(_command_cwd(command))
            if not repo:
                allowed, cause, detail = (
                    False, "no-verdict-readable",
                    "the repository could not be derived, so no verdict could be read",
                )
            else:
                comments, head = read_pr_comments(repo, pr_number)
                allowed, cause, detail = judge_verdict(comments, head)

        if not allowed:
            ov = MERGE_OVER_REVISE_RE.search(command)
            if ov:
                audit_log({
                    "ts": int(time.time()), "verdict": "allow",
                    "reason": "merge-over-revise-override",
                    "cause_overridden": cause,
                    "override_reason": ov.group("reason").strip()[:200],
                    "command": command[:200],
                })
                sys.exit(0)
            audit_log({
                "ts": int(time.time()), "verdict": "block",
                "reason": cause, "detail": detail[:300],
                "command": command[:200],
            })
            print(
                f"BLOCKED: the Pi token is present and valid — this refusal is about the REVIEWER'S VERDICT.\n"
                f"\n"
                f"  cause: {cause}\n"
                f"  {detail}\n"
                f"\n"
                "A signed token says the coordinator authorised a merge. It does not say the\n"
                "reviewer approved THIS head. Two pull requests landed on main over a live\n"
                "REVISE because the two were read as one question — vantageos-crm #215 at\n"
                "b53b3890 and vantage-peers #1364 at 824cf8a2, both merged at the exact head\n"
                "their last verdict refused.\n"
                "\n"
                "The three causes are distinct and so are their remedies:\n"
                "  verdict-says-revise             the reviewer refused this head; fix or override\n"
                "  verdict-does-not-name-this-head the head moved after the verdict; ask for a re-pin\n"
                "  no-verdict-readable             nobody gated it, or the read failed; neither is a pass\n"
                "\n"
                "Override, when merging over a refusal is the right call (a prose-only finding,\n"
                "a reviewer unavailable while a client waits). The reason is recorded in the\n"
                "audit line, which is the whole difference from what happened last night:\n"
                "  gh pr merge N ... # merge-over-revise: <reason, at least 15 characters>\n"
                "\n"
                "Audit trail: /tmp/pi-auth-pr-merge.log\n",
                file=sys.stderr,
            )
            sys.exit(2)

        audit_log({
            "ts": int(time.time()),
            "verdict": "allow",
            "reason": "pi-authorized+verdict-approved-at-head",
            "command": command[:200],
        })
        sys.exit(0)

    # Block
    audit_log({
        "ts": int(time.time()),
        "verdict": "block",
        "reason": "no-pi-authorization",
        "command": command[:200],
    })

    print(
        "BLOCKED: PR merge / push to main of client-facing fleet repo without Pi-signed authorization.\n"
        "\n"
        "Day 87 standing rule (Laurent verbatim, memory j577xjby0mncv7wpx4ewjz4n5s87nbcw):\n"
        "  Pi devient autorité fleet pour merges client-facing — système autonome,\n"
        "  ne dépend pas de Laurent. Extension pattern Day 82 PI-SIGNED PROD DEPLOY.\n"
        "\n"
        "Required order:\n"
        "  1. PR created\n"
        "  2. Eta review dispatched (create_task assignedTo=eta dim 12 brief)\n"
        "  3. Verdict APPROVED received (eta send_message [DONE])\n"
        "  4. Pi crée VP task [PR-MERGE-AUTHORIZED] avec scope (orchestrator + PR# + repo + ETA_APPROVED_TASK_ID ref)\n"
        "  5. Orchestrator merge avec PI_AUTHORIZED_MERGE_TASK_ID référencé\n"
        "\n"
        "To proceed (only after Eta APPROVED + Pi task [PR-MERGE-AUTHORIZED] created):\n"
        "  Option A: PI_AUTHORIZED_MERGE_TASK_ID=k<task-id> gh pr merge N ...\n"
        "  Option B: gh pr merge N --pi-authorized-merge=k<task-id>\n"
        "  Option C: gh pr merge N ... # pi-authorized-merge: k<task-id>\n"
        "\n"
        "task-id = the VP task ID where Pi tagged [PR-MERGE-AUTHORIZED] for this merge.\n"
        "\n"
        "Exception (rare, Laurent-only): commande contient `# laurent-direct-merge`\n"
        "→ allow (Laurent manual override toujours possible).\n"
        "\n"
        "Hors scope: PRs internes Pi-workspace (CLAUDE.md, .claude/, docs-only).\n"
        "Audit trail: /tmp/pi-auth-pr-merge.log\n",
        file=sys.stderr,
    )
    sys.exit(2)

except Exception as e:
    # Fail-open on any unexpected error to avoid blocking legitimate work
    print(f"[hook warning] enforce-pi-authorization-before-pr-merge: {e}", file=sys.stderr)
    sys.exit(0)
