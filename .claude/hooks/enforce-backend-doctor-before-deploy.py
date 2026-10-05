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
                 (`mechanical_violations > 0`) -> REFUSE. A recorded
                 could-not-judge (`exit_code == 2`) with zero mechanical
                 violations is NOT red: abstention is a real backend's normal
                 state (Eta ruling 2026-08-30) and the abstentions stay counted
                 in the report; mechanical_violations is the sole refusal driver.
  3. STALE    -- the newest evidence pins an EARLIER commit than HEAD
                 (the stale-green defect) -> REFUSE.
  4. INCOMPLETE -- evidence pins HEAD but a verdict field
                 (`exit_code`/`mechanical_violations`) is ABSENT or NON-INTEGER,
                 so it records NO verdict -> could-not-judge -> REFUSE. A missing
                 field is NOT a defaulted 0 (the D5 hole).

It PASSES only when evidence pins HEAD and is mechanically clean.

SELECTION ORDER (v1.2.0): evidence whose sha pins HEAD DECIDES, whatever its
position in glob order. A file keyed to HEAD by name that cannot be read is a
could-not-judge -> REFUSE, never replaced by an ancestor. Only when NO HEAD
evidence exists does the ancestor relaxation (see `evaluate`) apply.

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

FAIL-CLOSED for deploys: once the command is (or cannot be ruled out as) a
Convex deploy, any unexpected error during evaluation REFUSES (exit 2) -- a gate
that crashes must not let a deploy through. A command confidently NOT a deploy
still fails-open (exit 0) so a fleet hook never breaks an unrelated session.
A report that pins HEAD but OMITS/non-integer-types a verdict field
(exit_code/mechanical_violations) is a could-not-judge -> REFUSE, never a pass.

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
    raw_carries_action_words,
)

VERSION = "1.2.0"

# `convex run <module>:<fn>` executes an existing function; it pushes no code.
# (`run --push` does, and raw_carries_action_words keeps that case closed.)
NON_DEPLOY_SUBCOMMANDS = frozenset({"run"})

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
            # v1.1.0: WORDS, not substrings -- the env var name
            # CONVEX_DEPLOY_KEY is not a deploy signal.
            if raw_carries_action_words(piece, "convex", "deploy",
                                        NON_DEPLOY_SUBCOMMANDS):
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


def _resolve_deploy_cwd(command: str, data: dict) -> str:
    """The directory the deploy runs in, same shape as the sibling gates: a
    leading `cd <abspath>` wins, else the PreToolUse payload cwd. Needed so
    `git rev-parse HEAD` names the deployed commit.

    NO fallback to the hook process's own `os.getcwd()`. That directory is
    the HOOK's repository, not necessarily the DEPLOY's -- falling back to it
    silently validates a DIFFERENT repository than the one being deployed
    (the exact defect `_resolve_repo` closes; see its docstring). An absent
    or unresolvable cwd raises RepoResolutionError instead of guessing."""
    first_line = command.split("\n", 1)[0]
    m = re.match(r"""^\s*cd\s+(['"]?)([^\s&;|'"]+)\1""", first_line)
    if m:
        candidate = m.group(2).strip()
        if os.path.isabs(candidate) and os.path.isdir(candidate):
            return candidate
    payload_cwd = (data.get("cwd") or "").strip()
    if payload_cwd:
        return payload_cwd
    raise RepoResolutionError(
        "no leading `cd <abspath>` in the command and the PreToolUse "
        "payload carried no 'cwd' -- the directory this deploy runs in "
        "cannot be identified, and falling back to the hook's OWN process "
        "cwd would silently validate a different repository."
    )


# ---------------------------------------------------------------------------
# Evidence reading.
# ---------------------------------------------------------------------------

def _sha_matches(evidence_sha: str, ship_sha: str) -> bool:
    a, b = evidence_sha.lower(), ship_sha.lower()
    return a == b or a.startswith(b) or b.startswith(a)


class RepoResolutionError(Exception):
    """Raised when the deploy's own cwd cannot be resolved to a git
    repository. The caller MUST turn this into a REFUSE (exit 2) -- never a
    silent pass. Same doctrine as `.claude/rules/railway-mcp-redeploy.md`'s
    sibling: an unreadable subject refuses, it does not fall back to a guess.
    Shape matches `_resolve_repo`/`RepoResolutionError` in
    enforce-mcp-tool-coverage-schema-mirror.py -- this repository already
    settled on it."""


def _resolve_repo(cwd: str) -> str:
    """Resolve `cwd` to its git top-level, or raise RepoResolutionError.

    NO fallback to the hook process's own `os.getcwd()`: that directory is
    the HOOK's repository, not necessarily the DEPLOY's, and validating it
    would silently pass a deploy whose real cwd could not be identified --
    the gate would judge a real repository, just not the one being deployed.
    """
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, cwd=cwd, timeout=10,
        )
    except Exception as exc:
        raise RepoResolutionError(
            f"cwd={cwd!r} -- git rev-parse --show-toplevel raised: {exc}"
        ) from exc
    if result.returncode != 0 or not result.stdout.strip():
        raise RepoResolutionError(
            f"cwd={cwd!r} is not inside a git repository "
            f"(git rev-parse --show-toplevel exit={result.returncode}: "
            f"{result.stderr.strip()!r})"
        )
    return result.stdout.strip()


def _is_ancestor(candidate_sha: str, ship_sha: str, cwd: str) -> bool:
    """True iff `candidate_sha` is an ancestor of (or equal to) `ship_sha`."""
    try:
        r = subprocess.run(
            ["git", "merge-base", "--is-ancestor", candidate_sha, ship_sha],
            capture_output=True, text=True, timeout=10, cwd=cwd,
        )
    except Exception:
        return False
    return r.returncode == 0


def _convex_changed_between(candidate_sha: str, ship_sha: str, cwd: str) -> list[str]:
    """Paths under convex/ that differ between `candidate_sha` and
    `ship_sha`. An EMPTY list means the deployed tree's convex/ subtree is
    byte-identical to what the evidence judged -- the only condition under
    which ancestor evidence may stand in for HEAD evidence.

    Raises on a git failure: a diff we cannot compute must never be read as
    "nothing changed" (fail-closed, same discipline as the rest of this
    gate)."""
    r = subprocess.run(
        ["git", "diff", "--name-only", f"{candidate_sha}..{ship_sha}",
         "--", "convex/"],
        capture_output=True, text=True, timeout=10, cwd=cwd,
    )
    if r.returncode != 0:
        raise RuntimeError(
            f"git diff {candidate_sha}..{ship_sha} -- convex/ failed "
            f"(exit {r.returncode}): {r.stderr.strip()}"
        )
    return [line for line in r.stdout.splitlines() if line.strip()]


_SHA_RE = re.compile(r"[0-9a-fA-F]{7,40}")
_NAME_SHA_RE = re.compile(r"^backend-doctor-([0-9a-fA-F]{7,40})\.json$")


def _name_pins(path: str, ship_sha: str) -> bool:
    """True iff the evidence FILENAME is keyed to `ship_sha`
    (`qa/backend-doctor-<sha>.json`, prefix-matched)."""
    m = _NAME_SHA_RE.match(os.path.basename(path))
    return bool(m) and _sha_matches(m.group(1), ship_sha)


def _load_evidence(repo_root: str, ship_sha: str) -> tuple[list[dict], list[tuple[str, str]]]:
    """(reports, head_broken).

    reports: every parseable evidence file under qa/ with a valid `sha`.
    head_broken: (path, reason) for each file that CLAIMS to be HEAD evidence
    -- its filename is keyed to HEAD -- but cannot be read as such (unreadable,
    not JSON, not an object, `sha` missing/not a sha, or `sha` naming a
    different commit than the filename). Such a file is a could-not-judge for
    HEAD: the caller must REFUSE on it, never fall back to ancestor evidence.
    Any other malformed file is skipped (it certifies nothing)."""
    reports: list[dict] = []
    head_broken: list[tuple[str, str]] = []
    for path in glob.glob(os.path.join(repo_root, EVIDENCE_GLOB)):
        named_for_head = _name_pins(path, ship_sha)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            if named_for_head:
                head_broken.append((path, f"unreadable or not JSON ({exc.__class__.__name__})"))
            continue
        if not isinstance(data, dict):
            if named_for_head:
                head_broken.append((path, "top-level JSON value is not an object"))
            continue
        raw_sha = data.get("sha")
        sha = raw_sha.strip() if isinstance(raw_sha, str) else ""
        if not _SHA_RE.fullmatch(sha):
            if named_for_head:
                head_broken.append((path, f"field `sha` is missing or not a git sha ({raw_sha!r})"))
            continue
        if named_for_head and not _sha_matches(sha, ship_sha):
            head_broken.append((
                path,
                f"filename is keyed to HEAD but field `sha` names {sha[:12]}",
            ))
            continue
        data["_path"] = path
        data["_sha"] = sha
        reports.append(data)
    return reports, head_broken


def _judge(r: dict, pin_note: str) -> tuple[str, str]:
    """Verdict for ONE report already accepted as covering HEAD."""
    clean, incomplete = _clean_verdict(r)
    if incomplete is not None:
        return "incomplete", (
            f"backend-doctor evidence {os.path.basename(r['_path'])} {pin_note} "
            f"but records NO usable verdict: {incomplete}. "
            "A report that omits (or non-integer-types) a verdict field "
            "certifies nothing -- it is a could-not-judge, never a pass."
        )
    if clean:
        return "pass", (
            f"backend-doctor evidence {os.path.basename(r['_path'])} {pin_note} "
            f"and is mechanically clean "
            f"({r.get('checked')}/{r.get('total')} checked, "
            f"{r.get('mechanical_violations', 0)} mechanical violations)."
        )
    return "red", (
        f"backend-doctor evidence {os.path.basename(r['_path'])} {pin_note} "
        f"but is MECHANICALLY RED: exit_code="
        f"{r.get('exit_code')}, mechanical_violations="
        f"{r.get('mechanical_violations')}."
    )


_MISSING = object()


def _int_field(report: dict, key: str):
    """Return the field as an int, or None if it is ABSENT or NON-INTEGER.
    An omitted or non-integer verdict field is a could-not-judge, never a 0 --
    the whole point of the D5 hole: a defaulted-to-0 verdict certified clean."""
    raw = report.get(key, _MISSING)
    if raw is _MISSING:
        return None
    # bool is an int subclass but is never a valid verdict value here.
    if isinstance(raw, bool) or not isinstance(raw, int):
        return None
    return raw


def _clean_verdict(report: dict) -> tuple[bool, str | None]:
    """(is_clean, incomplete_reason).

    A report is CLEAN only when BOTH verdict fields are present integers AND it
    found zero MECHANICAL violations. `exit_code` must still be a present integer
    (the absence-read-as-good-news hole stays closed), but its VALUE — including
    a recorded could-not-judge (`exit_code == 2`) — no longer forces RED.

    Eta ruling (2026-08-30): the deployable question is "did the doctor find
    nothing it can DECIDE?", not "did it find nothing?". A backend structurally
    ABSTAINS by design — VP's R-15/R-32/R-39/R-42 are D5-delivery-gate rules and
    every isolation-contract / write-contract marker is a reviewer-verified claim
    the static pass cannot decide — so `exit_code == 2` is a healthy backend's
    NORMAL state, and refusing on it makes the gate unsatisfiable for any real
    tree. mechanical_violations is therefore the SOLE refusal driver: a non-zero
    mechanical count still refuses regardless of exit code. This does NOT collapse
    exit 2 into a silent green — the abstentions remain printed and counted in the
    doctor report; only the deploy VERDICT changed, which is precisely the
    distinction three-state-verdict.md preserves (a could-not-judge is surfaced,
    never suppressed; it just does not, on its own, block a deploy that has zero
    mechanical violations).

    An ABSENT or NON-INTEGER `exit_code`/`mechanical_violations` is still a
    could-not-judge -> NOT clean, returned as an incomplete_reason naming the
    field. A well-formed file that pins HEAD but OMITS a verdict field records no
    verdict and must never certify a clean deploy."""
    missing = []
    exit_code = _int_field(report, "exit_code")
    if exit_code is None:
        missing.append("exit_code")
    mech = _int_field(report, "mechanical_violations")
    if mech is None:
        missing.append("mechanical_violations")
    if missing:
        return False, (
            "field(s) " + ", ".join(missing) + " are ABSENT or NON-INTEGER"
        )
    # exit_code is a present integer here (absence handled above); its value does
    # not force RED. mechanical_violations is the sole refusal driver.
    return mech == 0, None


def evaluate(repo_root: str, cwd: str | None) -> tuple[str, str]:
    """(verdict, message). verdict in {"pass", "absent", "stale", "red",
    "incomplete", "diverged", "refuse"}. Only "pass" allows; every other
    verdict refuses.

    ANCESTOR-EVIDENCE RELAXATION: evidence for a commit cannot be committed
    AT that commit (writing qa/backend-doctor-<sha>.json either dirties the
    tree or advances HEAD past the commit it names) while deploy authorization
    separately requires a clean checkout with zero local commits. Evidence
    pinned to an ANCESTOR of HEAD therefore stands in for HEAD evidence, but
    ONLY when nothing under convex/ changed between that ancestor and HEAD
    (`git merge-base --is-ancestor` AND an empty `git diff --name-only
    <ancestor>..HEAD -- convex/`). Either check failing is a REFUSE naming
    which one -- this widens WHICH TREE may stand in for HEAD's tree, never
    what a report is allowed to say (mechanical_violations is still the sole
    refusal driver once a report is accepted as covering HEAD)."""
    ship = head_sha(cwd=cwd)
    if not ship:
        return "refuse", (
            "`git rev-parse HEAD` failed in "
            f"{cwd!r} -- cannot resolve the commit being deployed."
        )

    reports, head_broken = _load_evidence(repo_root, ship)

    # 1. HEAD EVIDENCE DECIDES. A file keyed to HEAD that cannot be read is a
    #    could-not-judge for HEAD -> REFUSE; it never falls back to an ancestor.
    if head_broken:
        path, reason = sorted(head_broken)[0]
        return "incomplete", (
            f"backend-doctor evidence {os.path.basename(path)} is keyed to HEAD "
            f"{ship[:12]} but is MALFORMED: {reason}. HEAD evidence that cannot "
            "be read is a could-not-judge -- it is never replaced by an "
            "ancestor's verdict."
        )

    if not reports:
        return "absent", (
            "no backend-doctor evidence file exists under qa/backend-doctor-*.json. "
            f"The backend at HEAD {ship[:12]} has NEVER been scored by "
            "backend-doctor@main."
        )

    # Every report whose sha pins HEAD is judged, in path order, independent
    # of glob order. Any non-pass among them refuses (fail-closed): two HEAD
    # files that disagree cannot certify a deploy.
    head_reports = sorted(
        (r for r in reports if _sha_matches(r["_sha"], ship)),
        key=lambda r: r["_path"],
    )
    if head_reports:
        pin_note = f"pins HEAD {ship[:12]}"
        verdicts = [_judge(r, pin_note) for r in head_reports]
        for verdict, message in verdicts:
            if verdict != "pass":
                return verdict, message
        return verdicts[0]

    # 2. No HEAD evidence: the ancestor relaxation applies, unchanged.
    diverged = []  # (report, changed_files): ancestor evidence, convex/ moved
    for r in reports:
        if not _is_ancestor(r["_sha"], ship, cwd):
            continue
        changed = _convex_changed_between(r["_sha"], ship, cwd)
        if changed:
            diverged.append((r, changed))
            continue
        return _judge(r, (
            f"pins ancestor {r['_sha'][:12]} of HEAD {ship[:12]} "
            "with no convex/ change since"
        ))

    if diverged:
        r, changed = diverged[0]
        listed = ", ".join(changed[:10])
        return "diverged", (
            f"backend-doctor evidence {os.path.basename(r['_path'])} pins ancestor "
            f"{r['_sha'][:12]} of HEAD {ship[:12]}, but convex/ changed since: "
            f"{listed}. The evidence describes a DIFFERENT tree than the one "
            "being deployed -- an ancestor pin only stands in for HEAD when "
            "convex/ is byte-identical between the two."
        )

    # Evidence exists, none for HEAD (nor a covering ancestor) -> stale-green.
    pinned = ", ".join(sorted({r["_sha"][:12] for r in reports}))
    return "stale", (
        f"backend-doctor evidence exists but pins other commit(s) [{pinned}], "
        f"NOT the deployed HEAD {ship[:12]} nor an ancestor of it with an "
        "unchanged convex/ tree. This is a STALE report -- it was produced "
        "against an earlier version than the one being deployed."
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

def _raw_has_deploy_signal(command: str) -> bool:
    """Cheap, exception-proof last-resort probe: does the raw text even mention
    a Convex deploy? Used only when structured detection itself raised, so we
    can decide fail-open (clearly not a deploy) vs fail-closed (might be one)."""
    return raw_carries_action_words(command or "", "convex", "deploy",
                                    NON_DEPLOY_SUBCOMMANDS)


def run_hook(command: str, cwd: str | None = None, data: dict | None = None) -> int:
    if not command:
        return 0
    # Override lives in a comment -> read the RAW command (tokenizer strips
    # comments; reading post-strip would blind the opt-out).
    if OVERRIDE_RE.search(command):
        return 0

    # Detect deploy FIRST, defensively. Once we know it's a deploy, any
    # downstream error must FAIL CLOSED (exit 2) -- a gate that crashes must not
    # let a deploy through. A command we can confidently rule out as a deploy
    # stays fail-open.
    try:
        is_deploy = is_backend_deploy(command)
    except Exception as e:
        # Detection itself crashed: we cannot rule this out as a deploy. Refuse
        # only if the raw text carries a deploy signal; otherwise allow.
        if _raw_has_deploy_signal(command):
            print(
                "BLOCKED by enforce-backend-doctor-before-deploy: deploy "
                "detection raised while a Convex deploy signal is present in the "
                f"command -- failing CLOSED. Error: {e}",
                file=sys.stderr,
            )
            return 2
        return 0

    if not is_deploy:
        return 0

    # From here the command IS a backend deploy. Any error while evaluating the
    # evidence -> REFUSE (exit 2), never fall through to allow.
    try:
        # `cwd` is a direct test-harness override that bypasses command/payload
        # parsing entirely; only fall through to `_resolve_deploy_cwd` (which
        # reads the `cd`-prefix / PreToolUse payload) when no override is given.
        deploy_cwd = cwd if cwd is not None else _resolve_deploy_cwd(command, data or {})
        # No fallback to os.getcwd(): `_resolve_repo` raises RepoResolutionError
        # if `deploy_cwd` is not itself inside a git repository, and that
        # exception is deliberately let through to the outer handler below,
        # which REFUSES naming the path -- never silently validates a
        # different (the hook's own) repository.
        repo_root = _resolve_repo(deploy_cwd)

        verdict, detail = evaluate(repo_root, deploy_cwd)
        if verdict == "pass":
            return 0

        ship = head_sha(cwd=deploy_cwd) or "<sha>"
        _print_block(verdict, detail, ship[:12])
        return 2
    except Exception as e:
        print(
            "BLOCKED by enforce-backend-doctor-before-deploy: the gate raised "
            "while evaluating a Convex deploy -- failing CLOSED (a gate that "
            f"crashes must refuse, not allow). Error: {e}",
            file=sys.stderr,
        )
        return 2


# ---------------------------------------------------------------------------
# Entrypoint (skipped under test).
# ---------------------------------------------------------------------------

if not globals().get("_TESTING"):
    raw = ""
    try:
        raw = sys.stdin.read()
        data = json.loads(raw)
        if data.get("tool_name") != "Bash":
            sys.exit(0)
        command = data.get("tool_input", {}).get("command", "") or ""
        sys.exit(run_hook(command, data=data))
    except SystemExit:
        raise
    except Exception as e:
        # Malformed stdin / unexpected error at the boundary. We could not
        # reliably parse a command. Fail CLOSED only if the raw payload carries
        # a Convex deploy signal (we cannot rule out a deploy); otherwise
        # fail-open so a fleet hook never breaks an unrelated session.
        if _raw_has_deploy_signal(raw):
            print(
                "BLOCKED by enforce-backend-doctor-before-deploy: could not "
                "parse the hook payload but a Convex deploy signal is present -- "
                f"failing CLOSED. Error: {e}",
                file=sys.stderr,
            )
            sys.exit(2)
        print(f"[hook warning] enforce-backend-doctor-before-deploy: {e}",
              file=sys.stderr)
        sys.exit(0)
