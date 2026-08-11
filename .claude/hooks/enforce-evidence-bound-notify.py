#!/usr/bin/env python3
"""
enforce-evidence-bound-notify.py v2.0.0

PreToolUse + PostToolUse hook: Evidence-Bound NOTIFY doctrine.

v1.0.0 (PreToolUse) — pattern-presence gate: blocks send_message that asserts
  a finished state without at least one evidence line within ±5 lines.

v2.0.0 (PostToolUse) — fact-check layer: after send_message succeeds, parses
  every `<cmd> -> <output>` evidence line, re-executes WHITELISTED commands,
  and auto-dispatches a CLAIM-MISMATCH reply if actual output diverges from
  the cited output. Addresses critical-recurring Sigma over-claim pattern
  (friction memory j579hr0ht3yx8344kga8hrwhsx87vrbb).

Root cause this hook addresses:
  Orchestrators send "[DONE] PR merged" / "SHIPPED" / "PUBLISHED" status
  pings to other peers that are taken at face value and routed into downstream
  decisions (closing tracking tasks, triggering deploys, releasing mandate
  budget). When the claim is premature or wrong, the false positive cascades
  silently — the receiver trusted the sender because the sender said so.

Enforced on:
  - mcp__vantage-peers__send_message  (PreToolUse: blocks on missing evidence;
                                       PostToolUse: re-executes + fact-checks)

A message PASSES PreToolUse when:
  (a) it has NO state-claim marker — pure status / question / FYI, OR
  (b) for EACH claim line it contains, there is at least one EVIDENCE LINE
      within ±5 lines whose body matches an evidence-command pattern
      (gh|git|npm|sha256sum|wc|cat|curl ...).
  (c) optional URL HEAD check is best-effort and fail-soft.

PostToolUse verifies whitelisted commands by re-execution (10s timeout).
Non-whitelisted commands are silently skipped. On mismatch, an auto-reply
is dispatched to the original sender via mcp__vantage-peers__send_message.

Override (rare):
  PreToolUse:  `// allow-no-evidence-notify: <reason>` anywhere in content.
  PostToolUse: `// allow-claim-mismatch-bypass: <reason>` anywhere in content.

Exit codes (PreToolUse):
  0 = allow
  2 = block with remediation

Exit codes (PostToolUse):
  0 = allow (always; degraded gracefully on error)
"""
import json
import os
import re
import shutil
import subprocess
import sys

ENFORCED_TOOL = "mcp__vantage-peers__send_message"
VERSION = "2.0.0"

# ---------------------------------------------------------------------------
# Shared constants
# ---------------------------------------------------------------------------

# Markers that signal "I am asserting a finished state".
CLAIM_MARKERS = (
    re.compile(r"\[DONE\]", re.IGNORECASE),
    re.compile(r"\b(MERGED|PUBLISHED|SHIPPED|DEPLOYED|RELEASED|APPROVED)\b"),
)

# Evidence line: a command-driven artifact a peer can replay.
#   gh pr view 5 --json state -q .state → MERGED
#   git rev-parse HEAD → d8ceef5
#   npm view @vantageos/mcp-server@2.4.1 version → 2.4.1
#   sha256sum dist/server.js → <hash>
#   wc -l qa/report.md → 142
#   cat package.json | jq .version → "2.4.1"
#   curl -sI https://github.com/.../pull/5 → HTTP/2 200
EVIDENCE_LINE = re.compile(
    r"\b(gh|git|npm|sha256sum|wc|cat|curl)\b[^\n]+?(?:→|->|=>)\s*\S+",
    re.IGNORECASE,
)

# URL shapes worth opportunistically HEAD-checking.
URL_PATTERNS = (
    re.compile(r"https://github\.com/[^/\s]+/[^/\s]+/pull/\d+(?:#issuecomment-\d+)?"),
)

OPT_OUT_PRE = "allow-no-evidence-notify:"
OPT_OUT_POST = "allow-claim-mismatch-bypass:"

NEAR_WINDOW = 5  # lines above/below a claim where evidence can live

# ---------------------------------------------------------------------------
# v2.0.0 PostToolUse: WHITELIST / BLACKLIST
# ---------------------------------------------------------------------------

# Safe read-only deterministic commands that can be re-executed.
WHITELIST_PATTERNS = [
    # gh pr view <num> [--repo <owner/repo>] --json <fields> [-q <jq>]
    # jq expression restricted to safe charset only: letters, digits, ._@[]\-
    # Semicolons, pipes, backticks, $, quotes are rejected → shell injection prevention.
    re.compile(
        r"^gh pr view \d+( --repo [a-zA-Z0-9_.\-]+/[a-zA-Z0-9_.\-]+)?( --json [a-zA-Z0-9,|]+)?( -q [a-zA-Z0-9._@\[\]\\-]+)?\s*$"
    ),
    # npm view <pkg>[@<version>] version  OR  npm view <pkg> version
    re.compile(r"^npm view [@a-zA-Z0-9/._\-]+ version\s*$"),
    # sha256sum <safe-path>
    re.compile(r"^sha256sum [/.a-zA-Z0-9_\-]+\s*$"),
    # git rev-parse <ref>
    re.compile(r"^git rev-parse [a-zA-Z0-9_./\-]+\s*$"),
    # git log --oneline -<N>  (N 1-50)
    re.compile(r"^git log --oneline -([1-9]|[1-4]\d|50)\s*$"),
    # wc -l <safe-path>
    re.compile(r"^wc -l [/.a-zA-Z0-9_\-]+\s*$"),
    # ls [-la] <path>
    re.compile(r"^ls( -la?)? [/.a-zA-Z0-9_\-]+\s*$"),
    # cat <path> for safe extensions only
    re.compile(r"^cat [/.a-zA-Z0-9_\-]+\.(json|md|txt|yml|yaml)\s*$"),
]

# Never re-run these — skip silently.
BLACKLIST_PATTERNS = [
    re.compile(r"--prod\b"),
    re.compile(r"--yes\b"),
    re.compile(r"\s-f\b"),
    re.compile(r"--force\b"),
    re.compile(r"\bnpm publish\b"),
    re.compile(r"\bnpx convex deploy\b"),
    re.compile(r"\bgit push\b"),
    re.compile(r"\bgh pr (merge|create|comment)\b"),
    re.compile(r"\bmcp__[a-z_]+\b"),
    re.compile(r"\brm\b"),
    re.compile(r"\bmv\b"),
    re.compile(r"\bcp\b"),
]

# Regex to parse evidence lines from message body:
#   <cmd> -> <output>   or   <cmd> → <output>
EVIDENCE_PARSE = re.compile(
    r"^(.+?)\s*(?:→|->)\s*(.+?)\s*$"
)


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def find_claim_lines(lines):
    hits = []
    for i, ln in enumerate(lines):
        for pat in CLAIM_MARKERS:
            if pat.search(ln):
                hits.append(i)
                break
    return hits


def has_evidence_near(lines, idx):
    lo = max(0, idx - NEAR_WINDOW)
    hi = min(len(lines), idx + NEAR_WINDOW + 1)
    for j in range(lo, hi):
        if EVIDENCE_LINE.search(lines[j]):
            return True
    return False


def head_check(url, timeout=3):
    """Best-effort HTTP HEAD. Returns (ok, status_or_reason). Fail-soft."""
    if not shutil.which("curl"):
        return (True, "no-curl-fail-soft")
    try:
        proc = subprocess.run(
            ["curl", "-sI", "-o", "/dev/null", "-w", "%{http_code}",
             "--max-time", str(timeout), url],
            capture_output=True, text=True, timeout=timeout + 2,
        )
        code = (proc.stdout or "").strip()
        if code.startswith("2") or code.startswith("3"):
            return (True, code)
        if code == "000":
            return (True, "network-unreachable-fail-soft")
        return (False, code or "unknown")
    except Exception as exc:
        return (True, f"exception-fail-soft:{exc}")


# ---------------------------------------------------------------------------
# v2.0.0 PostToolUse helpers
# ---------------------------------------------------------------------------

def is_blacklisted(cmd):
    for pat in BLACKLIST_PATTERNS:
        if pat.search(cmd):
            return True
    return False


def is_whitelisted(cmd):
    if is_blacklisted(cmd):
        return False
    for pat in WHITELIST_PATTERNS:
        if pat.match(cmd.strip()):
            return True
    return False


def _sha_prefix_match(cited, actual, min_len=7):
    """Return True if one is a 7+ char prefix of the other (SHA shortening)."""
    cited = cited.strip()
    actual = actual.strip()
    if len(cited) >= min_len and actual.startswith(cited):
        return True
    if len(actual) >= min_len and cited.startswith(actual):
        return True
    return False


def _json_equiv(cited, actual):
    """Try to compare as JSON dicts/lists, order-independent."""
    try:
        c = json.loads(cited)
        a = json.loads(actual)
        return c == a
    except Exception:
        return False


def outputs_match(cited, actual):
    """Return True if cited and actual are considered equivalent."""
    cited = cited.strip()
    actual = actual.strip()
    if cited == actual:
        return True
    if _sha_prefix_match(cited, actual):
        return True
    if _json_equiv(cited, actual):
        return True
    return False


def run_cmd(cmd, timeout=10):
    """
    Run cmd via shlex.split + shell=False. Returns (stdout_stripped, success_bool).
    success_bool=False if non-zero exit or exception.
    Shell metacharacters cannot be interpreted — defence-in-depth against injection.
    """
    import shlex
    try:
        proc = subprocess.run(
            shlex.split(cmd), shell=False, capture_output=True, text=True, timeout=timeout
        )
        stdout = (proc.stdout or "").strip()
        return (stdout, proc.returncode == 0)
    except subprocess.TimeoutExpired:
        print(
            f"[enforce-evidence-bound-notify v{VERSION}] timeout running: {cmd}",
            file=sys.stderr,
        )
        return ("", False)
    except Exception as exc:
        print(
            f"[enforce-evidence-bound-notify v{VERSION}] error running cmd: {exc}",
            file=sys.stderr,
        )
        return ("", False)


def dispatch_mismatch_reply(sender, message_id, mismatches):
    """
    Attempt to dispatch an auto-reply via mcp__vantage-peers__send_message.
    We emit a structured JSON to stdout so the MCP runtime can execute it,
    following the Claude hooks PostToolUse output format.
    """
    lines = [f"[CLAIM-MISMATCH] auto-detected on message {message_id}", ""]
    lines.append("Claims fabricated:")
    for lineno, cited_cmd, cited_out, actual_out in mismatches:
        lines.append(f"  L{lineno}: {cited_cmd} -> {cited_out}")
        lines.append(f"          actual:        {actual_out}")
    lines.append("")
    lines.append(f"(Reported by enforce-evidence-bound-notify.py v{VERSION})")
    # Self-tag prevents the PostToolUse hook from re-firing on this auto-reply
    # and entering a recursion loop when the mismatch report itself contains
    # command citations.
    lines.append("// allow-claim-mismatch-bypass: auto-reply-from-fact-check")
    body = "\n".join(lines)

    # Emit structured hook output to trigger auto-reply via runtime injection.
    # The hooks protocol allows PostToolUse to output JSON with
    # {"stopReason": ..., "toolResults": ...} — but for send_message auto-reply
    # the safest approach is to emit to stderr (visible to orchestrator) and
    # also attempt a direct subprocess call if the MCP binary is available.
    print(body, file=sys.stderr)

    # Auto-reply uses VP_SEND_CMD env var (path to mcp__vantage-peers__send_message
    # dispatcher script) if set, else logs a warning to stderr and skips the reply.
    # This makes the hook testable without a live MCP connection: set VP_SEND_CMD
    # to a test stub script; leave it unset in CI to safely skip the network call.
    # mcp__vantage-peers__send_message schema: channel (str), from (str),
    # content (str), optionally fromInstanceId, sessionDay, tenantId.
    # "channel" is the recipient's role/instance identifier, NOT "to".
    vp_send = os.environ.get("VP_SEND_CMD")
    if vp_send and sender:
        from_id = os.environ.get("CLAUDE_AGENT_ID", "enforce-evidence-bound-notify")
        from_instance = os.environ.get("CLAUDE_INSTANCE_ID", "")
        payload = json.dumps({
            "tool": "mcp__vantage-peers__send_message",
            "input": {
                "channel": sender,
                "from": from_id,
                "fromInstanceId": from_instance,
                "content": body,
            }
        })
        try:
            subprocess.run(
                [vp_send, payload],
                timeout=15,
                capture_output=True,
            )
        except Exception as exc:
            print(
                f"[enforce-evidence-bound-notify v{VERSION}] auto-reply failed: {exc}",
                file=sys.stderr,
            )
    else:
        if not vp_send:
            print(
                f"[enforce-evidence-bound-notify v{VERSION}] VP_SEND_CMD not set — skipping auto-reply (set env var to enable)",
                file=sys.stderr,
            )


def posttooluse_fact_check(data):
    """
    v2.0.0 PostToolUse handler.
    Parses evidence lines from the sent message, re-executes whitelisted
    commands, and dispatches CLAIM-MISMATCH reply on divergence.
    Always exits 0 (fail-open, degrade gracefully).
    """
    tool_input = data.get("tool_input", {}) or {}
    tool_response = data.get("tool_response", {}) or {}

    content = tool_input.get("content")
    content = content if isinstance(content, str) else ""

    if not content.strip():
        sys.exit(0)

    # Override bypass
    if OPT_OUT_POST in content:
        sys.exit(0)

    # Extract message id from response (best-effort)
    message_id = (
        tool_response.get("messageId")
        or tool_response.get("id")
        or tool_response.get("message_id")
        or "unknown"
    )

    # Extract sender (the "from" field or agent identity)
    sender = tool_input.get("from") or tool_input.get("sender") or os.environ.get("CLAUDE_AGENT_ID", "")

    lines = content.splitlines()
    mismatches = []

    for lineno, line in enumerate(lines, start=1):
        m = EVIDENCE_PARSE.match(line.strip())
        if not m:
            continue
        cited_cmd = m.group(1).strip()
        cited_out = m.group(2).strip()

        # Skip if blacklisted (silently)
        if is_blacklisted(cited_cmd):
            continue

        # Only fact-check whitelisted commands
        if not is_whitelisted(cited_cmd):
            continue

        actual_out, success = run_cmd(cited_cmd)

        if not success:
            # Non-zero exit while cited as success = mismatch
            mismatches.append((lineno, cited_cmd, cited_out, f"[exit!=0] {actual_out}"))
            continue

        if not outputs_match(cited_out, actual_out):
            mismatches.append((lineno, cited_cmd, cited_out, actual_out))

    if mismatches:
        dispatch_mismatch_reply(sender, message_id, mismatches)

    sys.exit(0)


# ---------------------------------------------------------------------------
# v1.0.0 PreToolUse handler (UNCHANGED)
# ---------------------------------------------------------------------------

def pretooluse_gate(data):
    tool_input = data.get("tool_input", {}) or {}
    content = tool_input.get("content")
    content = content if isinstance(content, str) else ""

    if not content.strip():
        sys.exit(0)  # empty messages handled by other hooks

    if OPT_OUT_PRE in content:
        sys.exit(0)

    lines = content.splitlines()
    claim_indices = find_claim_lines(lines)

    # No state-claim → pure FYI / question / status → always pass.
    if not claim_indices:
        sys.exit(0)

    missing = []
    for idx in claim_indices:
        if not has_evidence_near(lines, idx):
            missing.append((idx + 1, lines[idx].strip()[:120]))

    # Optional URL HEAD check — only when a claim is present, fail-soft.
    url_failures = []
    if os.environ.get("ENFORCE_NOTIFY_URL_CHECK", "0") == "1":
        for ln in lines:
            for pat in URL_PATTERNS:
                for m in pat.finditer(ln):
                    ok, info = head_check(m.group(0))
                    if not ok:
                        url_failures.append((m.group(0), info))

    if not missing and not url_failures:
        sys.exit(0)

    msg = ["BLOCKED: Evidence-Bound NOTIFY doctrine."]
    msg.append("")
    msg.append(
        "Your message asserts a finished state (e.g. [DONE], MERGED, PUBLISHED,"
    )
    msg.append(
        "SHIPPED, DEPLOYED, APPROVED) but the receiver cannot independently"
    )
    msg.append("verify it without trusting you.")
    msg.append("")
    if missing:
        msg.append("Claim lines without nearby evidence:")
        for lineno, snippet in missing:
            msg.append(f"  L{lineno}: {snippet}")
        msg.append("")
    if url_failures:
        msg.append("URLs that failed HEAD check:")
        for url, info in url_failures:
            msg.append(f"  {url} -> {info}")
        msg.append("")
    msg.append(
        "FIX: for each claim line, add (within +/-5 lines) an evidence line of"
    )
    msg.append("the form:")
    msg.append("  <gh|git|npm|sha256sum|wc|cat|curl> <args> -> <result>")
    msg.append("")
    msg.append("Examples:")
    msg.append("  gh pr view 5 --json state -q .state -> MERGED")
    msg.append("  git rev-parse HEAD -> d8ceef5")
    msg.append("  npm view @vantageos/mcp-server@2.4.1 version -> 2.4.1")
    msg.append("  curl -sI https://github.com/o/r/pull/5 -> HTTP/2 200")
    msg.append("")
    msg.append(
        "Override (rare): add `// allow-no-evidence-notify: <reason>` in the"
    )
    msg.append("message body, then fix the source so the next notify carries proof.")

    print("\n".join(msg), file=sys.stderr)
    sys.exit(2)


# ---------------------------------------------------------------------------
# Main dispatch: PreToolUse vs PostToolUse
# ---------------------------------------------------------------------------

def main():
    try:
        data = json.load(sys.stdin)
    # TOOL_NAME_GUARD_PI_FIX Day 113 — fleet deadlock fix (matcher=* fires every tool)
    if data.get("tool_name") != "mcp__vantage-peers__send_message":
        sys.exit(0)
    except Exception:
        sys.exit(0)

    tool_name = data.get("tool_name", "") or ""
    if tool_name != ENFORCED_TOOL:
        sys.exit(0)

    hook_type = data.get("hook_event_name", "") or os.environ.get("CLAUDE_HOOK_TYPE", "PreToolUse")

    if hook_type == "PostToolUse":
        posttooluse_fact_check(data)
    else:
        pretooluse_gate(data)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(
            f"[enforce-evidence-bound-notify] internal error, fail-open: {e}",
            file=sys.stderr,
        )
        sys.exit(0)
