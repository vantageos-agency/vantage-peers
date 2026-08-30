#!/usr/bin/env python3
"""PreToolUse(Bash) -- refuse a Convex backend deploy unless a backend-doctor
GREEN run exists for the EXACT git tree being deployed.

Task k17eh5g4p6c4sxjeq40rhxzdhx8cg3np (D5). The instrument is
elpiarthera/backend-doctor@main (`npx tsx src/cli.ts <convex-path>`), which
scores the tree: exit 0 = clean, 1 = violations, 2 = COULD-NOT-JUDGE
(unloadable tree). Judgement/process rules PRINT but are NOT mechanical fails.

THIS GATE IS A READER, NOT THE DOCTOR. It does not rebuild or re-run the
doctor. It reads an evidence file the doctor run produced and decides three
things, all MECHANICAL:

  1. ABSENT   -- no backend-doctor evidence for the CURRENT git HEAD exists
                 ("never run against this version") -> REFUSE.
  2. RED      -- evidence for HEAD exists but carries mechanical violations
                 (`mechanical_violations > 0`) or the doctor could-not-judge
                 (`exit_code == 2`) -> REFUSE.
  3. STALE    -- the newest evidence pins an EARLIER commit than HEAD
                 (the stale-green defect) -> REFUSE.

It PASSES when evidence pins HEAD and is mechanically clean.

WHAT IT MUST NOT DO
-------------------
* NEVER refuse on a judgement/process rule (the doctor marks those; the gate
  ignores them). A report with `exit_code == 1` but `mechanical_violations == 0`
  is judgement-only -> PASS. Only MECHANICAL non-conformance refuses.
* Its OWN refusal obeys the standard it enforces: STRUCTURED, naming exactly
  what failed and what to change, in the stderr the caller reads. A gate that
  refuses opaquely while enforcing no-opaque-refusal is unacceptable.

EVIDENCE FILE (keyed to SHA, mirroring enforce-clerk-jwt-smoke-prod.py's
`qa/clerk-jwt-smoke-<sha>.json` shape):

  qa/backend-doctor-<sha>.json
  {
    "sha": "<git sha the doctor judged>",     # full or short, prefix-matched
    "cli_commit": "<backend-doctor CLI commit judged with>",
    "convex_path": "<absolute convex path scored>",
    "exit_code": 0,                            # doctor process exit code
    "checked": 47, "total": 47,                # coverage tally
    "mechanical_violations": 0                 # the only refusal-driving count
  }

Deploy detection reuses the SHARED action tokenizer
(`_lib/command_predicate.py`) -- the same corpus of bypasses that
`block-deploy-without-qa.py` and `enforce-pi-authorization-before-prod-deploy.py`
consume, so a hole closed once protects all three. No new regex ladder here.

OVERRIDE (documented, Laurent-authorized rare case; DEFAULT is refuse):
    # allow-no-backend-doctor: <reason >= 6 chars>
Read from the RAW command (it lives in a comment; the tokenizer strips comments
before analysis, so reading it post-strip would blind the opt-out).

FAIL-OPEN on any unexpected error -> exit 0. A fleet hook never breaks a
session.

Exit 0 = allow, Exit 2 = block.
"""
import glob
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib.command_predicate import (  # noqa: E402
    carries_action_signature,
    has_safe_flag,
    head_matches,
    iter_real_commands,
)

VERSION = "1.0.0"

EVIDENCE_GLOB = "qa/backend-doctor-*.json"
OVERRIDE_RE = re.compile(r"#\s*allow-no-backend-doctor:\s*(\S.{5,})", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Deploy detection -- SHARED tokenizer, no local regex ladder.
# ---------------------------------------------------------------------------

def _segment_is_deploy(tokens) -> bool:
    """head == `convex` (basename + version-suffix normalized), subcommand ==
    `deploy`, with no harmless flag. `convex dev` / `--dry-run` are not deploys.
    """
    if not head_matches(tokens, "convex"):
        return False
    rest = tokens[1:]
    if not rest or rest[0] != "deploy":
        return False
    if has_safe_flag(rest):
        return False
    return True


def is_backend_deploy(cmd: str) -> bool:
    """True only if the command actually executes a Convex deploy. All
    tokenization (comments, quote-aware split, transparent prefixes,
    interpreter recursion) comes from _lib -- no copy lives here."""
    for piece, tokens in iter_real_commands(cmd):
        if tokens is None:
            low = piece.lower()
            if "convex" in low and "deploy" in low:
                return True
            continue
        if _segment_is_deploy(tokens):
            return True
        # Fail-closed on an unknown wrapper carrying `convex deploy` in two
        # adjacent tokens -- same discipline as the sibling deploy gates.
        if carries_action_signature(tokens, "convex", "deploy"):
            return True
    return False


# ---------------------------------------------------------------------------
# Git HEAD resolution (never raises).
# ---------------------------------------------------------------------------

def head_sha(cwd: str | None = None) -> str | None:
    try:
        r = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=5, cwd=cwd,
        )
        if r.returncode != 0:
            return None
        return r.stdout.strip() or None
    except Exception:
        return None


def _resolve_deploy_cwd(command: str, data: dict) -> str | None:
    """The directory the deploy runs in, same shape as the sibling gates: a
    leading `cd <abspath>` wins, else the PreToolUse payload cwd, else the hook
    process cwd. Needed so `git rev-parse HEAD` names the deployed commit."""
    first_line = command.split("\n", 1)[0]
    m = re.match(r"""^\s*cd\s+(['"]?)([^\s&;|'"]+)\1""", first_line)
    if m:
        candidate = m.group(2).strip()
        if os.path.isabs(candidate) and os.path.isdir(candidate):
            return candidate
    payload_cwd = (data.get("cwd") or "").strip()
    if payload_cwd and os.path.isdir(payload_cwd):
        return payload_cwd
    return os.getcwd()


# ---------------------------------------------------------------------------
# Evidence reading.
# ---------------------------------------------------------------------------

def _sha_matches(evidence_sha: str, ship_sha: str) -> bool:
    a, b = evidence_sha.lower(), ship_sha.lower()
    return a == b or a.startswith(b) or b.startswith(a)


def _load_reports(repo_root: str) -> list[dict]:
    """Every parseable backend-doctor evidence file under qa/. A malformed
    file is skipped (it certifies nothing), never treated as a pass."""
    out = []
    for path in glob.glob(os.path.join(repo_root, EVIDENCE_GLOB)):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        sha = (data.get("sha") or "").strip()
        if not re.fullmatch(r"[0-9a-fA-F]{7,40}", sha):
            continue
        data["_path"] = path
        data["_sha"] = sha
        out.append(data)
    return out


def _is_mechanically_clean(report: dict) -> bool:
    """Clean iff the doctor could judge (exit_code != 2) AND it found zero
    MECHANICAL violations. Judgement/process rules never drive this."""
    if int(report.get("exit_code", 0)) == 2:
        return False
    return int(report.get("mechanical_violations", 0)) == 0


def evaluate(repo_root: str, cwd: str | None) -> tuple[str, str]:
    """(verdict, message). verdict in {"pass", "absent", "stale", "red",
    "refuse"}."""
    ship = head_sha(cwd=cwd)
    if not ship:
        return "refuse", (
            "`git rev-parse HEAD` failed in "
            f"{cwd!r} -- cannot resolve the commit being deployed."
        )

    reports = _load_reports(repo_root)
    if not reports:
        return "absent", (
            "no backend-doctor evidence file exists under qa/backend-doctor-*.json. "
            f"The backend at HEAD {ship[:12]} has NEVER been scored by "
            "backend-doctor@main."
        )

    for r in reports:
        if _sha_matches(r["_sha"], ship):
            if _is_mechanically_clean(r):
                return "pass", (
                    f"backend-doctor evidence {os.path.basename(r['_path'])} pins "
                    f"HEAD {ship[:12]} and is mechanically clean "
                    f"({r.get('checked')}/{r.get('total')} checked, "
                    f"{r.get('mechanical_violations', 0)} mechanical violations)."
                )
            return "red", (
                f"backend-doctor evidence {os.path.basename(r['_path'])} pins HEAD "
                f"{ship[:12]} but is MECHANICALLY RED: exit_code="
                f"{r.get('exit_code')}, mechanical_violations="
                f"{r.get('mechanical_violations')}."
            )

    # Evidence exists, none for HEAD -> stale-green (report(s) pin other shas).
    pinned = ", ".join(sorted({r["_sha"][:12] for r in reports}))
    return "stale", (
        f"backend-doctor evidence exists but pins other commit(s) [{pinned}], "
        f"NOT the deployed HEAD {ship[:12]}. This is a STALE report -- it was "
        "produced against an earlier version than the one being deployed."
    )


# ---------------------------------------------------------------------------
# Structured refusal (obeys the standard it enforces).
# ---------------------------------------------------------------------------

def _print_block(verdict: str, detail: str, ship_hint: str) -> None:
    print(
        "BLOCKED by enforce-backend-doctor-before-deploy: a Convex deploy "
        "requires a backend-doctor@main GREEN run keyed to THIS exact commit.\n"
        f"  Reason ({verdict}): {detail}\n"
        "\n"
        "  For DEV: use `npx convex dev --once` (no prod gate applies).\n"
        "\n"
        "  To proceed, score THIS commit and write the evidence file:\n"
        "    1. Clone/point at backend-doctor@main and run:\n"
        "         npx tsx src/cli.ts <repo>/convex\n"
        "    2. Capture the run to "
        f"qa/backend-doctor-{ship_hint}.json with fields:\n"
        '         {"sha","cli_commit","convex_path","exit_code",'
        '"checked","total","mechanical_violations"}\n'
        "    3. The gate reads that file, verifies sha == `git rev-parse HEAD`,\n"
        "       and that mechanical_violations == 0 (exit_code != 2).\n"
        "\n"
        "  The gate refuses ONLY on MECHANICAL non-conformance -- never on a "
        "judgement/process rule (a report with exit_code=1 but "
        "mechanical_violations=0 PASSES).\n"
        "\n"
        "  Override (documented, Laurent-authorized rare case; DEFAULT is refuse):\n"
        "    npx convex deploy --yes  # allow-no-backend-doctor: <reason >= 6 chars>\n",
        file=sys.stderr,
    )


# ---------------------------------------------------------------------------
# Core logic (extracted for testability).
# ---------------------------------------------------------------------------

def run_hook(command: str, cwd: str | None = None, data: dict | None = None) -> int:
    if not command:
        return 0
    # Override lives in a comment -> read the RAW command (tokenizer strips
    # comments; reading post-strip would blind the opt-out).
    if OVERRIDE_RE.search(command):
        return 0
    if not is_backend_deploy(command):
        return 0

    deploy_cwd = _resolve_deploy_cwd(command, data or {})
    if cwd is not None:
        deploy_cwd = cwd
    repo_root = deploy_cwd or os.getcwd()

    verdict, detail = evaluate(repo_root, deploy_cwd)
    if verdict == "pass":
        return 0

    ship = head_sha(cwd=deploy_cwd) or "<sha>"
    _print_block(verdict, detail, ship[:12])
    return 2


# ---------------------------------------------------------------------------
# Entrypoint (skipped under test).
# ---------------------------------------------------------------------------

if not globals().get("_TESTING"):
    try:
        data = json.load(sys.stdin)
        if data.get("tool_name") != "Bash":
            sys.exit(0)
        command = data.get("tool_input", {}).get("command", "") or ""
        sys.exit(run_hook(command, data=data))
    except Exception as e:  # FAIL-OPEN: a fleet hook never breaks a session.
        print(f"[hook warning] enforce-backend-doctor-before-deploy: {e}",
              file=sys.stderr)
        sys.exit(0)
