#!/usr/bin/env python3
"""
PreToolUse hook : enforce Eta APPROVED verdict before npm publish of fleet packages.

v1.3.3 — interpreter-command unwrap fix (2026-08-06)

v1.3.3 (defect 5): the `is_fleet_publish` detection was BYPASSED by wrapping
the publish command in a shell interpreter invocation (e.g., `bash -c 'npm publish'`).
Root cause: `strip_quoted_strings` (added in v1.0.1 to avoid false positives on
git-commit-message strings) also removed the ACTUAL command payload when it was the
argument to an interpreter. Fix: added `extract_interpreter_commands` to UNWRAP
interpreter invocations (`bash/sh/zsh -c <quoted>`, `-lc`) and analyze the inner
command recursively. The git-commit-message false positive is still suppressed for
non-interpreter cases.

v1.3.2 — gh-comment validation + Eta real-verdict-format parser + publish-dir fix (2026-06-29)

v1.3.2 (defect 4): all git calls (origin resolution, HEAD, tree-diff) now run in
the RESOLVED publish directory, not the hook process cwd. The process cwd is the
session root (/root/coding/gamma-workspace) which has no origin remote, so any
monorepo SUBPACKAGE publish (mosaic-tokens, mosaic-i18n, ...) previously blocked
with a false "no origin remote". resolve_publish_dir(command, data) derives the
real dir from a leading `cd <abspath>` (primary), else data["cwd"], else os.getcwd().

v1.3.1 parser: the approval matcher is robust to BOTH the explicit machine-line
format (`ETA_APPROVED_COMMIT_SHA: <sha>`) AND Eta's mosaic prose format
(`**APPROVED**` with the SHA written as "@ `5edbe5c`"). A comment is an Eta
approval iff: author allowlisted + body matches /\\bAPPROVED\\b/i + NO negative
verdict (changes requested / rejected / blocked / not approved) + a SHA binding
(explicit line OR the operator's # eta-approved-sha appears literally in body).

Blocks Bash commands containing `npm publish` (or equivalents) for fleet-impact
npm public packages (@vantageos/*, @elpiarthera/*, vantage-*) unless the publish
command carries a validated Eta APPROVED verdict.

v1.3.0 validation source (replaces the v1.2.0 Convex-fetch path for defect 2):
  Eta APPROVED verdict is validated by reading the PR's GitHub issue-comments via
  the `gh` CLI (already authenticated on this VPS). The publish command must carry:
    - `# eta-approved-pr: <N>`  (PR number — also --eta-approved-pr=<N> / env ETA_APPROVED_PR)
    - `# eta-approved-sha: <sha>` (the reviewed commit SHA — unchanged from prior versions)

  Flow:
    1. Resolve owner/repo from `git remote get-url origin`.
    2. Resolve PR number from the inline token.
    3. `gh api repos/<owner>/<repo>/issues/<N>/comments --paginate` (fail-LOUD on gh error).
    4. Filter comments whose body matches /Eta APPROVED/i; take the LATEST.
    5. Parse `ETA_APPROVED_COMMIT_SHA: <sha>` from that comment body.
    6. SHA: comment_sha must pin the commit actually being shipped (age dropped v1.4.0).
    7. SHA: parsed approved-sha compared to git HEAD via the tree-aware check (defect 3).
    8. SECURITY: approval comment author .user.login must be in ALLOWED_APPROVAL_AUTHORS
       (default ["elpiarthera"], overridable via ETA_APPROVAL_AUTHORS).

v1.1.0 enforcements retained in spirit:
  - COMMIT SHA PINNING — git HEAD compared against the approved SHA (now tree-aware).
  - ENFORCEMENT — both the approval-comment validation and SHA pin must pass.

v1.2.0 → v1.3.0 defect fixes (Day 113-114, task k173qfqe07dv8xtg710yww5kcs89fyxq):
  DEFECT 1 — AGE WINDOW on wrong field. Live path now ages off the approval
    COMMENT's created_at (when Eta APPROVED). The legacy task-mock path keeps the
    completedAt ?? updatedAt ?? createdAt fallback (used by tests only).
  DEFECT 2 — FETCH unreliable / fail-closed. v1.2.0 used a Convex HTTP fetch that
    required CONVEX_DEPLOY_KEY (absent on orchestrator shells). v1.3.0 (Pi option D)
    drops Convex entirely and validates via the PR's GitHub issue-comments through
    the `gh` CLI, which is already authenticated on this VPS (user elpiarthera).
    gh errors (not found / not authed / 404) FAIL-LOUD with the real stderr.
  DEFECT 3 — SHA-MISMATCH on merge commit. After Pi merges a PR, main HEAD is a
    merge commit ≠ Eta-approved branch tip. Hook accepts tree-identical commits:
    if HEAD != approved_sha, runs `git diff --quiet <approved_sha> HEAD
    -- <publish_dir>` and allows if trees are identical. Blocks if trees differ.

Reason: Day 82 incident (2026-05-26) — Sigma published vantage-peers-mcp@2.3.0
with HEAD=f7b33bb, but Eta's APPROVED verdict was issued against HEAD=f7f374c
(two commits earlier). The hook v1.0.1 allowed this because it performed only a
regex format check on the ETA token — no backend lookup, no commit-SHA pin.
Postmortem: /root/coding/vantage-registry/analysis/eta-approval-hook-postmortem-2026-05-26.md

Day 79 original reason: Pi published @vantageos/integration-kit@0.2.0 before
dispatching Eta review. Standing rule canonique: memory j575xnq343b4pg70gqhv2cms9h878jte
+ standing task k17fyv272 (Eta perm).

Laurent: "une mémoire ne suffit pas" — formalization technique requise.

Override discipline: ETA_APPROVED_TASK_ID + ETA_APPROVED_COMMIT_SHA are meant
for one-shot pre-validated publish. Set, run npm publish once, unset.
Never persist in shell rc. Never share across PRs.

Override (rare): `# laurent-direct-publish` literal in command bypasses all checks.

Exit 0 = allow
Exit 2 = block
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib.command_predicate import iter_real_commands  # noqa: E402

VERSION = "1.4.0"

# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────

AUDIT_LOG = "/tmp/eta-approval-npm-publish.log"
# v1.4.0 (2026-08-13): TASK_MAX_AGE_MS removed. The guard now compares the SHA
# the evidence pins to the SHA being shipped; no window size closes the wrong-
# acceptance hole (recent evidence pinning ANOTHER commit passing in silence),
# and widening the window is not a remedy — see docs/probe-spec-evidence-pins-
# the-commit-2026-08-13.md.

# Default allowlist of GitHub logins permitted to post an Eta APPROVED verdict.
# Single-tenant fleet: every orchestrator posts to GitHub as `elpiarthera` (the
# shared GH_TOKEN). Override via env ETA_APPROVAL_AUTHORS (comma-separated logins).
ALLOWED_APPROVAL_AUTHORS = ["elpiarthera"]

# POSITIVE approval verdict word. Eta's mosaic prose writes "**APPROVED**" with no
# literal "Eta APPROVED" phrase, so we match the standalone verdict word.
ETA_APPROVED_VERDICT_RE = re.compile(r"\bAPPROVED\b", re.IGNORECASE)

# NEGATIVE verdict guard: if the body carries any of these, it is NOT an approval
# even if the word APPROVED also appears (e.g. "changes requested, not approved yet").
# Word boundaries are critical: \bBLOCK(ED)?\b must NOT match "unblock" in a title
# like "prod unblock" (Eta's real mosaic verdict contains exactly that phrase).
ETA_NEGATIVE_VERDICT_RE = re.compile(
    r"\bchanges?\s*requested\b|\brequest[-\s]?changes\b|\bREJECTED\b|\bNOT\s+APPROVED\b|\bBLOCKED?\b",
    re.IGNORECASE,
)

# Back-compat: explicit machine-readable SHA line inside the approval comment.
ETA_APPROVED_SHA_IN_BODY_RE = re.compile(r"ETA_APPROVED_COMMIT_SHA:\s*([0-9a-f]{7,40})", re.IGNORECASE)


def verdict_scope(body: str) -> str:
    """Return the part of a review comment where a VERDICT is stated.

    The negative-verdict guard must never read free prose. A verdict word can
    appear in a body as the LABEL OF A MEASUREMENT rather than as a decision —
    a reviewer proving zero false positives writes a line reading
    "legitimate REJECTED : [] <- 0 of 11", and a body-wide scan turns that
    proof into a refusal. The word is data there, not a decision.

    The verdict is stated on the comment's headline. Scope is therefore:
      - the first non-empty line, and
      - every markdown heading line naming the reviewer (### Eta — <VERDICT> —)
    Everything else in the body is evidence, and evidence is data.

    Returns the empty string for an empty body, which fails closed at the
    caller: no verdict scope means no verdict.
    """
    lines = body.splitlines()
    scope: list[str] = []
    for line in lines:
        if line.strip():
            scope.append(line)
            break
    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith("#") and re.search(r"\bEta\b", stripped, re.IGNORECASE):
            if line not in scope:
                scope.append(line)
    return "\n".join(scope)

# Task ID format: k followed by exactly 31 lowercase alphanumeric chars (32 total)
TASK_ID_RE = re.compile(r"^k[a-z0-9]{31}$")

# Inline task ID patterns (embedded in command text) — allow 15-40 chars for
# safety against older Convex ID lengths (Day 79 v1.0.1 fix §A from sigma).
INLINE_TASK_RE = re.compile(r"k[a-z0-9]{15,40}")

# SHA patterns
SHA_FULL_RE = re.compile(r"^[0-9a-f]{40}$")
SHA_SHORT_RE = re.compile(r"^[0-9a-f]{7,12}$")

# Fleet-impact package NAME test — applied to the `name` field READ from
# package.json in the resolved publish dir (v1.4.0), never to command text.
FLEET_PACKAGE_NAME_RE = re.compile(r"^(@vantageos/|@elpiarthera/|vantage-[a-z-]+)")


# ─────────────────────────────────────────────────────────────────────────────
# strip_quoted_strings — verbatim from v1.0.1 / pi-auth hook
# Day 79 v1.0.1 fix §B from sigma — prevents false positives inside commit
# messages or strings like: git commit -m "run npm publish after review"
# ─────────────────────────────────────────────────────────────────────────────
def strip_quoted_strings(command: str) -> str:
    """Remove content inside single/double quotes to avoid false positives
    on text like `git commit -m "docs about npm publish flow"`.
    Day 79 v1.0.1 fix §B from sigma — original regex matched publish patterns
    inside commit message strings, blocking legitimate `git commit` calls."""
    # Remove "..." (double-quoted)
    command = re.sub(r'"[^"]*"', '""', command)
    # Remove '...' (single-quoted)
    command = re.sub(r"'[^']*'", "''", command)
    return command


# ─────────────────────────────────────────────────────────────────────────────
# v1.4.0 — publish-verb detection via the SHARED action tokenizer (defect A).
#
# `iter_real_commands()` (`_lib/command_predicate.py`) already: normalizes
# line continuations, quote-aware strips comments, quote-aware splits on
# `; && || | ( ) \n`, RECURSES into `bash -c` / `sh -c` / `zsh -c` / `-lc` /
# `eval` / `env -S` / interpreter wrappers, and — critically for this hook —
# `strip_transparent()` treats npm/pnpm/yarn/bun/deno uniformly as RUNNERS:
# any of them followed by a non-`run|exec|dlx|x` verb has the runner token
# ITSELF stripped, so `npm publish`, `pnpm -F pkg publish`,
# `npm --workspace=@x/pkg publish`, `bun publish`, `deno publish` all
# normalize to a real command HEAD of literally `publish` — regardless of
# flag order, `--workspace`/`-F`, or which package manager was typed. This is
# "is this a publish action at all", decided on the ACTION, never on an
# enumerated per-form regex list.
#
# `jsr` is not an npm-family RUNNER in the shared tokenizer (jsr registries
# are npm-independent), so it needs one explicit two-token check below — the
# one irreducible addition, not a lengthened motif list.
# ─────────────────────────────────────────────────────────────────────────────
def _segment_is_publish(tokens: list[str]) -> bool:
    """True if a tokenized segment (after strip_transparent) is a publish
    invocation of ANY package manager."""
    if not tokens:
        return False
    if tokens[0] == "publish":
        return True  # npm/pnpm/yarn/bun/deno — normalized by strip_transparent
    if tokens[0] == "jsr" and len(tokens) > 1 and tokens[1] == "publish":
        return True
    return False


def is_publish_action(command: str) -> bool:
    """True if `command` contains a publish invocation from ANY package
    manager, in any flag order / workspace form / interpreter-wrapped form —
    decided on the resolved command HEAD, never on command prose."""
    for _segment, tokens in iter_real_commands(command):
        if tokens and _segment_is_publish(tokens):
            return True
    return False


def read_package_name(publish_dir: str) -> tuple[str | None, str]:
    """Read the `name` field of package.json in `publish_dir`.

    Returns (name, "ok") on success, or (None, diagnostic) on ANY failure
    (missing file, invalid JSON, missing name field). Never a silent
    passthrough — the caller REFUSES loud when this can't be read."""
    pkg_path = os.path.join(publish_dir, "package.json")
    try:
        with open(pkg_path) as f:
            pkg = json.load(f)
    except FileNotFoundError:
        return None, f"no package.json in resolved publish dir '{publish_dir}'"
    except json.JSONDecodeError as e:
        return None, f"package.json in '{publish_dir}' is not valid JSON: {e}"
    except OSError as e:
        return None, f"could not read package.json in '{publish_dir}': {e}"
    name = pkg.get("name")
    if not name or not isinstance(name, str):
        return None, f"package.json in '{publish_dir}' has no string 'name' field"
    return name, "ok"


def classify_publish(command: str, data: dict | None = None) -> tuple[bool, str]:
    """Decide whether `command` is a FLEET-impact publish. Returns
    (is_fleet_publish, diagnostic).

    v1.4.0 (defects A+B fix):
      1. Publish-verb detection is action-based (is_publish_action), not a
         per-form regex list (defect A).
      2. The publish DIRECTORY is resolved via resolve_publish_dir(), fixed
         (defect B) to parse a leading `cd <abspath>` in BOTH the newline
         form and the `&&`-joined form.
      3. Fleet-ness is decided by READING package.json#name in the RESOLVED
         directory — never by whether a fleet name is typed in the command.
         If a publish verb is detected but the dir/package.json cannot be
         read, this REFUSES LOUD (returns True with a REFUSED-UNREADABLE
         diagnostic) rather than silently passing.
    """
    if not is_publish_action(command):
        return False, "not a publish action"
    publish_dir = resolve_publish_dir(command, data)
    name, diag = read_package_name(publish_dir)
    if name is None:
        return True, f"REFUSED-UNREADABLE: publish action detected but {diag}"
    if FLEET_PACKAGE_NAME_RE.match(name):
        return True, f"fleet package '{name}' in '{publish_dir}'"
    return False, f"non-fleet package '{name}' in '{publish_dir}'"


def is_fleet_publish(command: str, data: dict | None = None) -> bool:
    """Boolean convenience wrapper around classify_publish() — kept for
    call-site brevity and self-test compatibility."""
    is_fleet, _ = classify_publish(command, data)
    return is_fleet


# ─────────────────────────────────────────────────────────────────────────────
# Laurent direct bypass
# ─────────────────────────────────────────────────────────────────────────────
def has_laurent_override(command: str) -> bool:
    """Allow if the raw command (not stripped) contains the literal bypass marker."""
    return "# laurent-direct-publish" in command


# ─────────────────────────────────────────────────────────────────────────────
# Token extraction
# ─────────────────────────────────────────────────────────────────────────────
def extract_eta_task_id(command: str) -> tuple[str, str]:
    """Return (task_id, source) from env var, inline flag, or inline comment.
    Returns ('', '') if none found."""
    # Env var (real os.environ set BEFORE subprocess spawn)
    env_task = os.environ.get("ETA_APPROVED_TASK_ID", "").strip()
    if env_task:
        return env_task, "env:ETA_APPROVED_TASK_ID"

    # Inline flag --eta-approved-task=k...
    m = re.search(r"--eta-approved-task=(k[a-z0-9]{15,40})\b", command)
    if m:
        return m.group(1), "flag:--eta-approved-task"

    # Inline comment # eta-approved: k...
    m = re.search(r"#\s*eta-approved:\s*(k[a-z0-9]{15,40})\b", command)
    if m:
        return m.group(1), "comment:eta-approved"

    return "", ""


def extract_eta_commit_sha(command: str) -> tuple[str, str]:
    """Return (sha, source) for the ETA_APPROVED_COMMIT_SHA token.
    Accepts env var, inline flag, or inline comment.
    Returns ('', '') if none found."""
    # Env var
    env_sha = os.environ.get("ETA_APPROVED_COMMIT_SHA", "").strip()
    if env_sha:
        return env_sha, "env:ETA_APPROVED_COMMIT_SHA"

    # Inline flag --eta-approved-sha=<sha>
    m = re.search(r"--eta-approved-sha=([0-9a-f]{7,40})\b", command)
    if m:
        return m.group(1), "flag:--eta-approved-sha"

    # Inline comment # eta-approved-sha: <sha>
    m = re.search(r"#\s*eta-approved-sha:\s*([0-9a-f]{7,40})\b", command)
    if m:
        return m.group(1), "comment:eta-approved-sha"

    return "", ""


def extract_eta_pr_number(command: str) -> tuple[str, str]:
    """Return (pr_number, source) for the ETA_APPROVED_PR token.
    Accepts env var, inline flag, or inline comment. Returns ('', '') if none found.
    v1.3.0 — identifies the PR whose comments carry the Eta APPROVED verdict."""
    # Env var
    env_pr = os.environ.get("ETA_APPROVED_PR", "").strip()
    if env_pr.isdigit():
        return env_pr, "env:ETA_APPROVED_PR"

    # Inline flag --eta-approved-pr=<N>
    m = re.search(r"--eta-approved-pr=(\d+)\b", command)
    if m:
        return m.group(1), "flag:--eta-approved-pr"

    # Inline comment # eta-approved-pr: <N>
    m = re.search(r"#\s*eta-approved-pr:\s*(\d+)\b", command)
    if m:
        return m.group(1), "comment:eta-approved-pr"

    return "", ""


# ─────────────────────────────────────────────────────────────────────────────
# Commit SHA pinning (v1.2.0: tree-aware for merge commits)
# ─────────────────────────────────────────────────────────────────────────────
def get_head_sha(cwd: str | None = None) -> str | None:
    """Read current git HEAD sha via subprocess. Returns None on failure (fail-open
    for SHA check: if git is unavailable, we skip the SHA pin but log a warning)."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=cwd,
        )
        if result.returncode == 0:
            return result.stdout.strip()
        return None
    except Exception:
        return None


def trees_identical(approved_sha: str, head_sha: str, publish_dir: str | None = None) -> tuple[bool, str]:
    """CASE 1 — single-commit (squash) merge: base unchanged, only the commit
    hash differs. Check if the FULL publish-directory tree is identical between
    approved_sha and HEAD via `git diff --quiet <approved_sha> <head_sha> -- <publish_dir>`.
    Returns (identical, diagnostic_message).

    v1.2.0: called when HEAD != approved_sha (merge commit scenario).
    If approved_sha is not reachable (e.g. needs fetch), returns (False, loud diagnostic).

    NOTE: this whole-tree check is worthless for CASE 2 (rebase onto an advanced
    main) — the tree legitimately differs there because it now carries the whole
    moved repo. See touched_files_identical() for the case-2 proof.
    """
    cwd = publish_dir or os.getcwd()
    diff_path = publish_dir or "."

    # First verify approved_sha is reachable in this repo
    try:
        cat_result = subprocess.run(
            ["git", "cat-file", "-t", approved_sha],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=cwd,
        )
        if cat_result.returncode != 0:
            return False, (
                f"eta-approval SHA-tree check: approved_sha '{approved_sha[:12]}' is not reachable "
                f"from current repo — run `git fetch` to ensure the approved commit is local. "
                f"Cannot perform tree-identity check. Re-submit for Eta review or run git fetch."
            )
    except Exception as e:
        return False, f"eta-approval SHA-tree check: git cat-file failed: {e}"

    # Check if trees are identical for the publish directory
    try:
        diff_result = subprocess.run(
            ["git", "diff", "--quiet", approved_sha, head_sha, "--", diff_path],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=cwd,
        )
        if diff_result.returncode == 0:
            return True, "ok:case1-tree-identical"
        return False, (
            f"commit SHA mismatch AND tree differs — Eta reviewed {approved_sha[:12]}... "
            f"but HEAD is {head_sha[:12]}... with file changes in '{diff_path}'. "
            "New commits changed the published files after Eta's APPROVED verdict. "
            "Re-submit for Eta review."
        )
    except Exception as e:
        return False, f"eta-approval SHA-tree check: git diff failed: {e}"


def touched_files_identical(
    approved_sha: str, head_sha: str, publish_dir: str | None = None
) -> tuple[bool, str]:
    """CASE 2 — rebase onto an advanced main: the FULL tree differs legitimately
    (it now carries the whole moved repo), so a whole-tree diff is worthless and
    would wrongly refuse. The only valid proof is file-by-file on the TOUCHED
    files: the reviewed file set is derived from git (never typed — see
    .claude/rules/derive-never-type.md), as the files that changed between the
    merge-base of (approved_sha, head_sha) and approved_sha. Every one of those
    files must then be byte-identical between approved_sha and head_sha.

    Returns (identical, diagnostic_message). On any file that differs, the
    diagnostic NAMES that file so the refusal is actionable.
    """
    cwd = publish_dir or os.getcwd()

    # 1. Determine the reviewed file set from git — never typed by hand.
    try:
        base_result = subprocess.run(
            ["git", "merge-base", approved_sha, head_sha],
            capture_output=True, text=True, timeout=5, cwd=cwd,
        )
        if base_result.returncode != 0:
            return False, (
                f"eta-approval touched-files check: no common ancestor between "
                f"approved_sha {approved_sha[:12]}... and HEAD {head_sha[:12]}... — "
                f"cannot derive the reviewed file set. git stderr: "
                f"{(base_result.stderr or '').strip()[:200]}"
            )
        merge_base = base_result.stdout.strip()

        touched_result = subprocess.run(
            ["git", "diff", "--name-only", merge_base, approved_sha],
            capture_output=True, text=True, timeout=10, cwd=cwd,
        )
        if touched_result.returncode != 0:
            return False, (
                f"eta-approval touched-files check: git diff --name-only failed: "
                f"{(touched_result.stderr or '').strip()[:200]}"
            )
        touched_files = [f for f in touched_result.stdout.splitlines() if f.strip()]
    except Exception as e:
        return False, f"eta-approval touched-files check: failed to derive touched files: {e}"

    if not touched_files:
        return False, (
            "eta-approval touched-files check: no touched files derived between the "
            "merge-base and the approved commit — cannot prove case-2 invariance"
        )

    # 2. Every touched file must be byte-identical between approved_sha and head_sha.
    changed_files: list[str] = []
    for f in touched_files:
        try:
            diff_result = subprocess.run(
                ["git", "diff", "--quiet", approved_sha, head_sha, "--", f],
                capture_output=True, text=True, timeout=10, cwd=cwd,
            )
            if diff_result.returncode != 0:
                changed_files.append(f)
        except Exception as e:
            return False, f"eta-approval touched-files check: git diff on '{f}' failed: {e}"

    if changed_files:
        return False, (
            f"commit SHA mismatch, rebase detected (case 2) — reviewed file(s) changed "
            f"after Eta's APPROVED verdict: {', '.join(changed_files)}. "
            "Re-submit for Eta review."
        )

    return True, (
        f"ok:case2-touched-files-identical ({len(touched_files)} file(s) checked, "
        f"merge-base={merge_base[:12]})"
    )


def carried_forward_on_invariant_content(
    approved_sha: str, head_sha: str, publish_dir: str | None = None
) -> tuple[bool, str]:
    """When approved_sha != head_sha, decide which of the two cases applies and
    apply the matching proof — a whole-tree diff wrongly refuses every rebase
    (case 2), and a touched-files-only diff cannot prove a squash merge is
    honest (case 1 needs the whole tree). Both proofs are attempted; the
    approval carries forward if EITHER establishes the reviewed content did
    not move. Returns (carried, reason) — reason states WHICH case and what
    it compared, or names the changed file(s) on refusal.
    """
    case1_ok, case1_reason = trees_identical(approved_sha, head_sha, publish_dir)
    if case1_ok:
        return True, f"ok:{case1_reason} (approved={approved_sha[:12]} head={head_sha[:12]})"

    case2_ok, case2_reason = touched_files_identical(approved_sha, head_sha, publish_dir)
    if case2_ok:
        return True, f"ok:{case2_reason} (approved={approved_sha[:12]} head={head_sha[:12]})"

    # Neither case proved invariance — refuse with the most specific diagnostic
    # (case 2 names the changed file; prefer it when it ran to completion).
    if "reviewed file(s) changed" in case2_reason:
        return False, case2_reason
    return False, case1_reason


def validate_commit_sha(
    approved_sha: str,
    head_sha: str | None,
    publish_dir: str | None = None,
) -> tuple[bool, str]:
    """Compare approved SHA against current HEAD.
    - Length >= 40: exact match required; if mismatch, try tree-identity check (v1.2.0).
    - Length 7-12: prefix match against head_sha; if mismatch, try tree-identity check.
    Returns (ok, reason)."""
    if not head_sha:
        # git unavailable — fail-open with warning (don't block CI without git)
        return True, "warn:git-unavailable"

    if len(approved_sha) >= 40:
        if approved_sha.lower() == head_sha.lower():
            return True, "ok:exact"
        # SHA mismatch — try CASE 1 (squash/merge, whole tree identical), then
        # CASE 2 (rebase onto advanced main, only touched files must be identical).
        ok, reason = carried_forward_on_invariant_content(approved_sha, head_sha, publish_dir)
        if ok:
            return True, reason
        return False, reason

    elif SHA_SHORT_RE.match(approved_sha):
        if head_sha.lower().startswith(approved_sha.lower()):
            return True, "ok:prefix"
        # prefix mismatch — same two-case fallback.
        ok, reason = carried_forward_on_invariant_content(approved_sha, head_sha, publish_dir)
        if ok:
            return True, reason
        return False, reason

    else:
        return False, f"ETA_APPROVED_COMMIT_SHA '{approved_sha}' is not a valid SHA (7-40 hex chars)"


# ─────────────────────────────────────────────────────────────────────────────
# GitHub PR approval-comment validation (v1.3.0 — Pi option D, replaces Convex)
# ─────────────────────────────────────────────────────────────────────────────
def resolve_publish_dir(command: str, data: dict | None = None) -> str:
    """Resolve the directory where `npm publish` actually runs (v1.3.2, defect 4).

    Precedence:
      a. A leading `cd <abspath>` on the FIRST line of the command — authoritative.
         v1.4.0 (defect B fix): matches BOTH the `cd <abspath>\\nnpm publish`
         newline form AND the ordinary `cd <abspath> && npm publish` form (the
         prior regex's `$` end-anchor only matched the newline form, silently
         falling back to data["cwd"]/os.getcwd() — the WRONG repo — for the
         far more common `&&`-joined form). Used only if the path is ABSOLUTE
         and exists.
      b. data["cwd"] from the PreToolUse payload, if a non-empty existing dir.
      c. os.getcwd().

    WHY: the hook process cwd (os.getcwd()) is the SESSION root
    (/root/coding/gamma-workspace), which has no origin remote — so any monorepo
    SUBPACKAGE publish (mosaic-tokens, mosaic-i18n, ...) would falsely block with
    "no origin remote". data["cwd"] is the session cwd and is often NOT the publish
    dir either, hence it is only the fallback. The leading-cd parse reflects where
    the command actually runs. `git remote get-url origin` resolves from ANY subdir
    of a repo, so as long as publish_dir is inside the target repo, resolution works.
    """
    data = data or {}

    # (a) leading `cd <path>` on the first line — the robust primary signal.
    # v1.4.0 (defect B): matches EITHER the bare newline form (path runs to
    # end of line) OR the `&&`/`;`/`|`-joined form (path stops at the
    # operator, rest of the line ignored here — the publish verb itself is
    # detected separately by is_publish_action()).
    first_line = command.split("\n", 1)[0]
    m = re.match(
        r"""^\s*cd\s+(['"]?)([^\n&;|]+?)\1(?:\s*(?:&&|;|\|).*)?\s*$""",
        first_line,
    )
    if m:
        candidate = m.group(2).strip()
        if os.path.isabs(candidate) and os.path.isdir(candidate):
            return candidate

    # (b) PreToolUse payload cwd (fallback — may be the session root).
    payload_cwd = (data.get("cwd") or "").strip()
    if payload_cwd and os.path.isdir(payload_cwd):
        return payload_cwd

    # (c) hook process cwd (last resort — prior behavior).
    return os.getcwd()


def resolve_owner_repo(cwd: str | None = None) -> tuple[str | None, str | None, str]:
    """Resolve (owner, repo, diagnostic) from `git remote get-url origin`.

    Parses github.com[:/]<owner>/<repo>(.git). Returns (None, None, diag) on failure.
    """
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=cwd,
        )
    except Exception as e:
        return None, None, f"git remote get-url origin failed: {e}"

    if result.returncode != 0:
        return None, None, (
            "no `origin` remote configured — cannot resolve owner/repo for the "
            "Eta approval-comment lookup. "
            f"git stderr: {(result.stderr or '').strip()[:200]}"
        )

    url = result.stdout.strip()
    # Match both SSH (git@github.com:owner/repo.git) and HTTPS (https://github.com/owner/repo.git)
    m = re.search(r"github\.com[:/]+([^/]+)/([^/\s]+?)(?:\.git)?$", url)
    if not m:
        return None, None, f"origin remote '{url}' is not a recognizable github.com URL"
    return m.group(1), m.group(2), "ok"


def fetch_pr_comments(owner: str, repo: str, pr_number: str, mock_json: str | None) -> tuple[list | None, str]:
    """Fetch PR issue-comments via `gh api`. FAIL-LOUD on gh error.

    v1.3.0: returns (comments_list_or_None, diagnostic). If mock_json is set
    (ETA_APPROVAL_HOOK_TEST_MOCK_COMMENTS), parse and return that (test mode).
    """
    if mock_json:
        try:
            parsed = json.loads(mock_json)
            if not isinstance(parsed, list):
                return None, "test mock comments must be a JSON array"
            return parsed, "ok:mock"
        except json.JSONDecodeError as e:
            return None, f"test mock comments parse error: {e}"

    endpoint = f"repos/{owner}/{repo}/issues/{pr_number}/comments"
    cmd = ["gh", "api", endpoint, "--paginate"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except FileNotFoundError:
        return None, (
            "eta-approval gh fetch: `gh` CLI not found in PATH — cannot validate "
            "the Eta APPROVED comment. Install gh or authenticate it on this host."
        )
    except Exception as e:
        return None, f"eta-approval gh fetch: unexpected error invoking gh — {e}"

    if result.returncode != 0:
        stderr_snippet = (result.stderr or "").strip()[:300]
        return None, (
            f"eta-approval gh fetch: `gh api {endpoint}` exited {result.returncode}. "
            f"stderr: {stderr_snippet or '(empty)'}. "
            "Likely cause: gh not authenticated, PR not found (404), or no network."
        )

    output = result.stdout.strip()
    if not output:
        return [], "ok:empty"
    try:
        # --paginate may concatenate multiple JSON arrays: ][  →  ,
        normalized = output.replace("][", ",")
        comments = json.loads(normalized)
        if not isinstance(comments, list):
            return None, "eta-approval gh fetch: response was not a JSON array"
        return comments, "ok:gh"
    except json.JSONDecodeError as e:
        return None, f"eta-approval gh fetch: invalid JSON from gh — {e}. Body: {output[:200]}"


def _parse_iso_to_ms(iso_str: str) -> float | None:
    """Parse ISO 8601 (e.g. 2026-06-29T06:50:43Z) to epoch milliseconds."""
    if not iso_str:
        return None
    try:
        s = iso_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp() * 1000
    except Exception:
        return None


def allowed_authors() -> list[str]:
    """Return the allowlist of GitHub logins permitted to issue an Eta APPROVED.
    Overridable via env ETA_APPROVAL_AUTHORS (comma-separated)."""
    env_val = os.environ.get("ETA_APPROVAL_AUTHORS", "").strip()
    if env_val:
        return [a.strip().lower() for a in env_val.split(",") if a.strip()]
    return [a.lower() for a in ALLOWED_APPROVAL_AUTHORS]


def _comment_is_eta_approval(body: str, operator_sha: str) -> tuple[bool, str]:
    """Decide whether a comment body is a POSITIVE Eta approval and, if so, bind a SHA.

    v1.3.1 — robust to BOTH formats:
      A) explicit machine line  `ETA_APPROVED_COMMIT_SHA: <sha>`  (back-compat)
      B) Eta mosaic prose       `**APPROVED**` + SHA written as "@ `5edbe5c`"
         (the operator-provided SHA must appear literally in the body — full or
         its ≥7-char prefix)

    Returns (is_approval, bound_sha). bound_sha is '' when not an approval.
    """
    # Must carry a POSITIVE verdict word AND no negative-verdict marker.
    # The negative guard reads the VERDICT SCOPE only — see verdict_scope().
    if not ETA_APPROVED_VERDICT_RE.search(body):
        return False, ""
    if ETA_NEGATIVE_VERDICT_RE.search(verdict_scope(body)):
        return False, ""

    # Format A — explicit machine-readable SHA line (authoritative).
    m = ETA_APPROVED_SHA_IN_BODY_RE.search(body)
    if m:
        return True, m.group(1).lower()

    # Format B — operator SHA (full or ≥7-char prefix) appears literally in body.
    op = (operator_sha or "").lower()
    if op and len(op) >= 7 and re.search(re.escape(op), body, re.IGNORECASE):
        return True, op

    # Approval verdict present but no parseable SHA binding.
    return False, ""


def validate_pr_approval(
    pr_number: str,
    mock_comments: str | None,
    operator_sha: str = "",
    cwd: str | None = None,
) -> tuple[bool, str, str]:
    """Validate the Eta APPROVED verdict from the PR's GitHub issue-comments.

    v1.3.2. Returns (allowed, reason, bound_sha_from_comment).

    A comment counts as an Eta APPROVAL when ALL hold:
      - author .user.login is in the allowlist
      - body has a POSITIVE verdict /\\bAPPROVED\\b/i and NO negative-verdict marker
      - SHA binding: explicit `ETA_APPROVED_COMMIT_SHA:` line, OR the operator's
        `# eta-approved-sha` value (full / ≥7-char prefix) appears literally in body
    Among qualifying comments, the LATEST by created_at wins; it must pin the SHA shipped.

    v1.3.2: `cwd` is the resolved publish directory — origin is resolved from THERE
    (any subdir of the target repo works), not from the hook process cwd.
    """
    if not pr_number.isdigit():
        return False, f"invalid PR number '{pr_number}' — expected digits", ""

    # 1. owner/repo (skip resolution in mock mode — tests don't need a real remote)
    if mock_comments is not None:
        owner, repo = "elpiarthera", "mock-repo"
    else:
        owner, repo, diag = resolve_owner_repo(cwd=cwd)
        if owner is None or repo is None:
            return False, diag, ""

    # 2. fetch comments (FAIL-LOUD)
    comments, fetch_diag = fetch_pr_comments(owner, repo, pr_number, mock_comments)
    if comments is None:
        return False, fetch_diag, ""

    allowed = allowed_authors()

    def created_ms(c: dict) -> float:
        return _parse_iso_to_ms(c.get("created_at", "")) or 0.0

    # 3. qualify comments: author allowlisted + positive verdict + SHA binding.
    #    Track diagnostics so a near-miss yields an actionable block reason.
    qualifying: list[tuple[dict, str]] = []
    saw_verdict_word = False
    saw_verdict_no_sha = False
    saw_wrong_author = False
    for c in comments:
        body = c.get("body") or ""
        author = ((c.get("user") or {}).get("login") or "").lower()
        if ETA_APPROVED_VERDICT_RE.search(body) and not ETA_NEGATIVE_VERDICT_RE.search(verdict_scope(body)):
            saw_verdict_word = True
            if author not in allowed:
                saw_wrong_author = True
                continue
            is_appr, bound = _comment_is_eta_approval(body, operator_sha)
            if is_appr:
                qualifying.append((c, bound))
            else:
                saw_verdict_no_sha = True

    if not qualifying:
        if saw_wrong_author:
            return False, (
                f"PR #{pr_number} has an APPROVED comment but its author is not in "
                f"allowlist {allowed} — possible marker spoofing"
            ), ""
        if saw_verdict_no_sha:
            return False, (
                f"PR #{pr_number} approval comment has no parseable SHA — needs either "
                "an `ETA_APPROVED_COMMIT_SHA:` line or the operator's # eta-approved-sha "
                "value present literally in the body"
            ), ""
        if saw_verdict_word:
            return False, f"PR #{pr_number}: APPROVED word present but guarded as non-approval", ""
        return False, f"no Eta APPROVED comment found on PR #{pr_number}", ""

    # 4. pick LATEST qualifying comment by created_at
    latest, comment_sha = max(qualifying, key=lambda pair: created_ms(pair[0]))
    author = ((latest.get("user") or {}).get("login") or "").lower()

    # v1.4.0: the AGE gate is gone. The property that matters is not how old
    # the comment is, it is whether comment_sha pins the commit being shipped
    # — main() step 2 (cmd_sha vs comment_sha) and step 3 (comment_sha vs
    # git HEAD via validate_commit_sha) enforce exactly that, downstream.
    # Old evidence pinning THIS commit must PASS; recent evidence pinning
    # ANOTHER commit must BLOCK — no age check can deliver either property.
    return True, f"ok:pr#{pr_number} author={author}", comment_sha


# ─────────────────────────────────────────────────────────────────────────────
# Legacy task-mock validation (v1.2.0 defect-1 logic) — TEST-ONLY helper.
# Retained so the defect-1 completedAt/age regression tests keep exercising the
# fallback timestamp logic. The LIVE publish path uses validate_pr_approval above.
# ─────────────────────────────────────────────────────────────────────────────
def validate_task(task_id: str, mock_json: str | None) -> tuple[bool, str]:
    """Validate a task dict (mock-driven). Returns (allowed, reason).

    Checks: format, ETA-APPROVED marker, assignedTo=eta, age <= 60min using
    completedAt ?? updatedAt ?? createdAt. Defect-1 fix lives here.
    Not used by the live publish path (which is gh-comment based) — kept for tests.
    """
    if not INLINE_TASK_RE.fullmatch(task_id):
        return False, f"invalid taskId format '{task_id}' — expected k[a-z0-9]{{15,40}}"

    if not mock_json:
        return False, f"task '{task_id}' not provided (mock-only helper, fail closed)"
    try:
        task = json.loads(mock_json)
    except json.JSONDecodeError as e:
        return False, f"task mock parse error: {e}"

    title = task.get("title", "") or ""
    tags = task.get("tags") or []
    status = task.get("status", "") or ""
    if "[ETA-APPROVED]" not in title and "eta-approved" not in tags and status != "done":
        return False, (
            f"task '{task_id}' is not an Eta approval — "
            "title must contain [ETA-APPROVED], or tags must include eta-approved, "
            "or status must be done"
        )

    assigned_to = (task.get("assignedTo") or "").lower()
    if assigned_to and assigned_to != "eta":
        return False, (
            f"task '{task_id}' is assigned to '{assigned_to}', not 'eta' — "
            "this authorization was not issued by Eta"
        )

    # Defect 1: completedAt ?? updatedAt ?? createdAt
    completed_at = task.get("completedAt")
    updated_at = task.get("updatedAt")
    created_at = task.get("createdAt") or task.get("_creationTime")
    age_anchor = completed_at or updated_at or created_at
    age_field = (
        "completedAt" if completed_at is not None
        else "updatedAt" if updated_at is not None
        else "createdAt"
    )
    if not isinstance(age_anchor, (int, float)):
        return False, (
            f"task '{task_id}' missing timestamp for age check "
            "(tried completedAt/updatedAt/createdAt) — fail closed"
        )
    # v1.4.0: age branch dropped (see validate_pr_approval). age_anchor /
    # age_field are still resolved above for the "missing timestamp" instrument
    # check (unreadability), but no longer gate on how old the verdict is.
    _ = (age_anchor, age_field)  # retained for readability of the block above

    return True, "ok"


# ─────────────────────────────────────────────────────────────────────────────
# Audit log
# ─────────────────────────────────────────────────────────────────────────────
def write_audit(command: str, task_id: str, sha: str, allowed: bool, reason: str) -> None:
    """Append a JSON audit line to AUDIT_LOG. Fail silently."""
    try:
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "version": VERSION,
            "command": command[:200],
            "taskId": task_id,
            "approvedSha": sha,
            "allowed": allowed,
            "reason": reason,
        }
        with open(AUDIT_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# Block message
# ─────────────────────────────────────────────────────────────────────────────
def block_message(reason: str) -> str:
    return (
        f"BLOCKED: npm publish of a fleet-impact package — {reason}\n"
        "\n"
        "Day 79 + Day 82 + Day 113-114 + Day 156 doctrine (v1.3.3 — interpreter-unwrap fix):\n"
        "  - Eta APPROVED verdict required BEFORE any fleet npm publish.\n"
        "  - Verdict is read from the PR's GitHub comments (gh CLI).\n"
        "  - The approval comment must cite ETA_APPROVED_COMMIT_SHA: <sha>.\n"
        "  - The cited SHA must equal git HEAD (post-merge identical tree OK).\n"
        "  - The approval comment must pin the SHA being published and be by an allowlisted author.\n"
        "\n"
        "Required order:\n"
        "  1. PR created\n"
        "  2. Eta review dispatched\n"
        "  3. Eta posts a PR comment: `Eta APPROVED` + `ETA_APPROVED_COMMIT_SHA: <sha>`\n"
        "  4. No new file changes after APPROVED (merge commits with identical tree OK)\n"
        "  5. THEN merge + npm publish with the PR + SHA tokens set\n"
        "  6. Smoke test\n"
        "\n"
        "To proceed (only after Eta posts the APPROVED comment, no new file changes):\n"
        "  Option A (comments — canonical):\n"
        "    npm publish ... # eta-approved-pr: <N> # eta-approved-sha: <sha>\n"
        "  Option B (flags):\n"
        "    npm publish ... --eta-approved-pr=<N> --eta-approved-sha=<sha>\n"
        "  Option C (env vars):\n"
        "    ETA_APPROVED_PR=<N> ETA_APPROVED_COMMIT_SHA=<sha> npm publish ...\n"
        "\n"
        "<N>  = the PR number whose comments carry Eta's APPROVED verdict.\n"
        "<sha> = full or 7-char prefix of git HEAD that Eta reviewed.\n"
        "\n"
        "Author allowlist: ALLOWED_APPROVAL_AUTHORS (default ['elpiarthera']),\n"
        "  override via env ETA_APPROVAL_AUTHORS=login1,login2.\n"
        "Exception (rare, Laurent-only): append `# laurent-direct-publish` to command.\n"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Self-test mode
# ─────────────────────────────────────────────────────────────────────────────
def run_self_tests() -> None:
    """Run inline unit tests. Exit 0 if all pass, 1 otherwise."""
    import os
    import tempfile
    import time

    now_ms = int(time.time() * 1000)
    fresh_created_at = now_ms - 300_000    # 5 min ago — valid
    stale_created_at = now_ms - 7_200_000  # 2h ago — expired

    # v1.2.0: for Defect 1 tests, we need completedAt separate from createdAt
    stale_created_fresh_completed = {
        "createdAt": now_ms - 7_200_000,   # 2h ago (dispatched)
        "completedAt": now_ms - 300_000,   # 5 min ago (APPROVED) — should PASS
        "_creationTime": now_ms - 7_200_000,
    }
    stale_completed = {
        "createdAt": now_ms - 7_200_000,
        "completedAt": now_ms - 7_200_000,  # also 2h ago — should BLOCK
        "_creationTime": now_ms - 7_200_000,
    }

    task_id = "k" + "a" * 31  # 32-char task ID

    full_sha = "f7f374c239b610b83a8dfbb99f07ecb1e8243808"
    short_sha = "f7f374c"
    mismatch_sha = "deadbeef12345678901234567890123456789012"
    different_short = "deadbee"

    def make_task(extra: dict | None = None) -> str:
        base = {
            "_id": task_id,
            "title": "[ETA-APPROVED] vantage-peers-mcp@2.3.0",
            "tags": ["eta-approved"],
            "assignedTo": "eta",
            "status": "done",
            "createdAt": fresh_created_at,
            "_creationTime": fresh_created_at,
        }
        if extra:
            base.update(extra)
        return json.dumps(base)

    valid_task_json = make_task()

    stale_task_json = make_task({
        "createdAt": stale_created_at,
        "_creationTime": stale_created_at,
    })

    # Defect 1: stale createdAt but fresh completedAt → should PASS
    defect1_pass_task_json = make_task(stale_created_fresh_completed)

    # Defect 1 inverse: stale completedAt → should BLOCK
    defect1_block_task_json = make_task(stale_completed)

    wrong_assignee_json = make_task({"assignedTo": "pi"})

    missing_marker_json = json.dumps({
        "_id": task_id,
        "title": "review vantage-peers-mcp@2.3.0",
        "tags": [],
        "assignedTo": "eta",
        "status": "in_progress",
        "createdAt": fresh_created_at,
        "_creationTime": fresh_created_at,
    })

    tests = []

    # ── Token extraction tests ────────────────────────────────────────────────

    # T1: env-var prefix parse for task ID
    os.environ["ETA_APPROVED_TASK_ID"] = task_id
    tid, src = extract_eta_task_id("npm publish")
    tests.append(("T1: env-var task ID parse", tid == task_id and src == "env:ETA_APPROVED_TASK_ID"))
    os.environ.pop("ETA_APPROVED_TASK_ID", None)

    # T2: flag parse for task ID
    cmd = f"npm publish --eta-approved-task={task_id}"
    tid, src = extract_eta_task_id(cmd)
    tests.append(("T2: flag task ID parse", tid == task_id and src == "flag:--eta-approved-task"))

    # T3: comment parse for task ID
    cmd = f"npm publish # eta-approved: {task_id}"
    tid, src = extract_eta_task_id(cmd)
    tests.append(("T3: comment task ID parse", tid == task_id and src == "comment:eta-approved"))

    # T4: env-var prefix parse for commit SHA
    os.environ["ETA_APPROVED_COMMIT_SHA"] = full_sha
    sha, src = extract_eta_commit_sha("npm publish")
    tests.append(("T4: env-var SHA parse", sha == full_sha and src == "env:ETA_APPROVED_COMMIT_SHA"))
    os.environ.pop("ETA_APPROVED_COMMIT_SHA", None)

    # T5: flag parse for commit SHA
    cmd = f"npm publish --eta-approved-sha={short_sha}"
    sha, src = extract_eta_commit_sha(cmd)
    tests.append(("T5: flag SHA parse", sha == short_sha and src == "flag:--eta-approved-sha"))

    # T6: comment parse for commit SHA
    cmd = f"npm publish # eta-approved-sha: {short_sha}"
    sha, src = extract_eta_commit_sha(cmd)
    tests.append(("T6: comment SHA parse", sha == short_sha and src == "comment:eta-approved-sha"))

    # ── Commit SHA pinning tests ──────────────────────────────────────────────

    # T7: full SHA mismatch with no git repo → trees_identical fails → BLOCK
    # (We mock by passing a non-git dir so git cat-file fails)
    with tempfile.TemporaryDirectory() as tmpdir:
        ok, reason = validate_commit_sha(mismatch_sha, full_sha, publish_dir=tmpdir)
        tests.append(("T7: commit SHA mismatch (no git repo) → BLOCK", not ok))

    # T8: short SHA prefix match → allow
    ok, reason = validate_commit_sha(short_sha, full_sha)
    tests.append(("T8: short SHA prefix match → ALLOW", ok and "prefix" in reason))

    # T9: full SHA exact match → allow
    ok, reason = validate_commit_sha(full_sha, full_sha)
    tests.append(("T9: full SHA exact match → ALLOW", ok and "exact" in reason))

    # T10: short SHA prefix mismatch with no git repo → BLOCK
    with tempfile.TemporaryDirectory() as tmpdir:
        ok, reason = validate_commit_sha(different_short, full_sha, publish_dir=tmpdir)
        tests.append(("T10: short SHA prefix mismatch (no git repo) → BLOCK", not ok))

    # T11: git unavailable → fail-open (warn, don't block)
    ok, reason = validate_commit_sha(full_sha, None)
    tests.append(("T11: git unavailable → ALLOW (fail-open)", ok and "warn" in reason))

    # ── Defect 3: tree-aware merge commit tests ───────────────────────────────

    # T12-D3: HEAD is merge commit with IDENTICAL tree to approved SHA → PASS
    # We create a real git repo with a merge commit scenario
    with tempfile.TemporaryDirectory() as tmpdir:
        # Init repo
        subprocess.run(["git", "init", tmpdir], capture_output=True)
        subprocess.run(["git", "-C", tmpdir, "config", "user.email", "test@test.com"], capture_output=True)
        subprocess.run(["git", "-C", tmpdir, "config", "user.name", "Test"], capture_output=True)
        # Create initial file
        pkg_file = os.path.join(tmpdir, "package.json")
        with open(pkg_file, "w") as f:
            f.write('{"name":"test","version":"1.0.0"}')
        subprocess.run(["git", "-C", tmpdir, "add", "."], capture_output=True)
        subprocess.run(["git", "-C", tmpdir, "commit", "-m", "initial"], capture_output=True)
        # Get branch tip SHA (this is what Eta approved)
        res = subprocess.run(["git", "-C", tmpdir, "rev-parse", "HEAD"], capture_output=True, text=True)
        branch_tip_sha = res.stdout.strip()
        # Create merge commit (same tree — simulate fast-forward or empty merge)
        # For test purposes, create a merge-like commit via git commit-tree
        # Get the tree SHA of branch tip
        res = subprocess.run(["git", "-C", tmpdir, "rev-parse", "HEAD^{tree}"], capture_output=True, text=True)
        tree_sha = res.stdout.strip()
        # Create a new commit with same tree but different commit SHA
        res = subprocess.run(
            ["git", "-C", tmpdir, "commit-tree", tree_sha, "-p", branch_tip_sha, "-m", "merge commit"],
            capture_output=True, text=True
        )
        merge_commit_sha = res.stdout.strip()
        subprocess.run(["git", "-C", tmpdir, "update-ref", "HEAD", merge_commit_sha], capture_output=True)
        # HEAD is now merge commit, approved is branch_tip — trees should be identical
        ok, reason = validate_commit_sha(branch_tip_sha, merge_commit_sha, publish_dir=tmpdir)
        tests.append((
            "T12-D3: merge commit with identical tree → ALLOW",
            ok and "tree-identical" in reason
        ))

    # T13-D3: HEAD is merge commit with DIFFERENT tree → BLOCK
    with tempfile.TemporaryDirectory() as tmpdir:
        subprocess.run(["git", "init", tmpdir], capture_output=True)
        subprocess.run(["git", "-C", tmpdir, "config", "user.email", "test@test.com"], capture_output=True)
        subprocess.run(["git", "-C", tmpdir, "config", "user.name", "Test"], capture_output=True)
        pkg_file = os.path.join(tmpdir, "package.json")
        with open(pkg_file, "w") as f:
            f.write('{"name":"test","version":"1.0.0"}')
        subprocess.run(["git", "-C", tmpdir, "add", "."], capture_output=True)
        subprocess.run(["git", "-C", tmpdir, "commit", "-m", "initial"], capture_output=True)
        res = subprocess.run(["git", "-C", tmpdir, "rev-parse", "HEAD"], capture_output=True, text=True)
        approved_sha_local = res.stdout.strip()
        # Now add a new file (changes the tree)
        with open(os.path.join(tmpdir, "extra.js"), "w") as f:
            f.write("// extra file added after Eta review")
        subprocess.run(["git", "-C", tmpdir, "add", "."], capture_output=True)
        subprocess.run(["git", "-C", tmpdir, "commit", "-m", "post-review change"], capture_output=True)
        res = subprocess.run(["git", "-C", tmpdir, "rev-parse", "HEAD"], capture_output=True, text=True)
        head_sha_local = res.stdout.strip()
        ok, reason = validate_commit_sha(approved_sha_local, head_sha_local, publish_dir=tmpdir)
        tests.append((
            "T13-D3: merge commit with DIFFERENT tree → BLOCK",
            not ok and ("differ" in reason or "mismatch" in reason)
        ))

    # ── Backend task validation tests ─────────────────────────────────────────

    # T14 (was T12): valid task (fresh, eta assignee, ETA-APPROVED) → allow
    ok, reason = validate_task(task_id, valid_task_json)
    tests.append(("T14: valid task → ALLOW", ok))

    # T15 (was T13): stale task (2h old completedAt) → block
    ok, reason = validate_task(task_id, stale_task_json)
    tests.append(("T15: stale task (completedAt 2h) → BLOCK", not ok and "min old" in reason))

    # T16 (was T14): wrong assignee (pi, not eta) → block
    ok, reason = validate_task(task_id, wrong_assignee_json)
    tests.append(("T16: wrong assignee (pi) → BLOCK", not ok and "pi" in reason))

    # T17 (was T15): task fetch failure (bad JSON) → block (fail closed)
    ok_bad, reason_bad = validate_task(task_id, "not-json")
    tests.append(("T17: task fetch failure → BLOCK (fail closed)", not ok_bad))

    # ── Defect 1 regression tests ─────────────────────────────────────────────

    # T18-D1: completedAt 5min ago, createdAt 90min ago → PASS (not age-blocked)
    ok, reason = validate_task(task_id, defect1_pass_task_json)
    tests.append((
        "T18-D1: completedAt=5min_ago, createdAt=90min_ago → ALLOW (Defect 1 fix)",
        ok
    ))

    # T19-D1: completedAt 90min ago → BLOCK (stale verdict)
    ok, reason = validate_task(task_id, defect1_block_task_json)
    tests.append((
        "T19-D1: completedAt=90min_ago → BLOCK (stale approved verdict)",
        not ok and "min old" in reason
    ))

    # ── Security regression tests ─────────────────────────────────────────────

    # T20-SEC: missing [ETA-APPROVED] marker → BLOCK
    ok, reason = validate_task(task_id, missing_marker_json)
    tests.append((
        "T20-SEC: missing ETA-APPROVED marker → BLOCK",
        not ok and "not an Eta approval" in reason
    ))

    # T21-SEC: non-eta assignedTo → BLOCK (already covered by T16, explicit for security regression)
    ok, reason = validate_task(task_id, wrong_assignee_json)
    tests.append(("T21-SEC: non-eta assignedTo → BLOCK", not ok))

    # ── v1.3.0 PR-number token extraction ─────────────────────────────────────

    # T22-PR: env-var PR number parse
    os.environ["ETA_APPROVED_PR"] = "242"
    pr, src = extract_eta_pr_number("npm publish")
    tests.append(("T22-PR: env-var PR number parse", pr == "242" and src == "env:ETA_APPROVED_PR"))
    os.environ.pop("ETA_APPROVED_PR", None)

    # T23-PR: comment PR number parse
    pr, src = extract_eta_pr_number("npm publish # eta-approved-pr: 242")
    tests.append(("T23-PR: comment PR number parse", pr == "242" and src == "comment:eta-approved-pr"))

    # ── v1.3.0 gh-comment validation tests (mock-driven, no network) ───────────

    def comment(body: str, login: str, created_at: str) -> dict:
        return {"body": body, "user": {"login": login}, "created_at": created_at}

    iso_now = datetime.now(timezone.utc).isoformat()
    iso_stale = datetime.fromtimestamp(
        (now_ms - 5_400_000) / 1000, tz=timezone.utc  # 90 min ago
    ).isoformat()

    # T24-D2: fresh approval by allowlisted author, sha cited → ALLOW
    mock_ok = json.dumps([
        comment("Eta APPROVED\nETA_APPROVED_COMMIT_SHA: " + full_sha, "elpiarthera", iso_now),
    ])
    ok, reason, csha = validate_pr_approval("242", mock_ok)
    tests.append((
        "T24-D2: fresh Eta APPROVED comment by allowlisted author → ALLOW",
        ok and csha == full_sha.lower()
    ))

    # T25-D2: no Eta APPROVED comment → BLOCK
    mock_none = json.dumps([
        comment("Looks good, ship it!", "elpiarthera", iso_now),
        comment("nit: typo in README", "elpiarthera", iso_now),
    ])
    ok, reason, csha = validate_pr_approval("242", mock_none)
    tests.append((
        "T25-D2: no Eta APPROVED comment → BLOCK",
        not ok and "no Eta APPROVED" in reason
    ))

    # T26-D2: approval comment 90min old → BLOCK (stale)
    mock_stale = json.dumps([
        comment("Eta APPROVED\nETA_APPROVED_COMMIT_SHA: " + full_sha, "elpiarthera", iso_stale),
    ])
    ok, reason, csha = validate_pr_approval("242", mock_stale)
    tests.append((
        "T26-D2: stale approval comment (90min) → BLOCK",
        not ok and "min old" in reason
    ))

    # T27-SEC: approval comment by non-allowlisted author → BLOCK
    mock_bad_author = json.dumps([
        comment("Eta APPROVED\nETA_APPROVED_COMMIT_SHA: " + full_sha, "random-attacker", iso_now),
    ])
    ok, reason, csha = validate_pr_approval("242", mock_bad_author)
    tests.append((
        "T27-SEC: approval comment by non-allowlisted author → BLOCK",
        not ok and "not in allowlist" in reason
    ))

    # T28-SEC: approval comment without ETA_APPROVED_COMMIT_SHA → BLOCK
    mock_no_sha = json.dumps([
        comment("Eta APPROVED — looks great", "elpiarthera", iso_now),
    ])
    ok, reason, csha = validate_pr_approval("242", mock_no_sha)
    tests.append((
        "T28-SEC: approval comment missing SHA → BLOCK",
        not ok and "ETA_APPROVED_COMMIT_SHA" in reason
    ))

    # T29-D2: multiple approvals — LATEST by created_at wins
    iso_old = datetime.fromtimestamp((now_ms - 1_800_000) / 1000, tz=timezone.utc).isoformat()
    mock_multi = json.dumps([
        comment("Eta APPROVED\nETA_APPROVED_COMMIT_SHA: " + mismatch_sha, "elpiarthera", iso_old),
        comment("Eta APPROVED\nETA_APPROVED_COMMIT_SHA: " + full_sha, "elpiarthera", iso_now),
    ])
    ok, reason, csha = validate_pr_approval("242", mock_multi)
    tests.append((
        "T29-D2: multiple approvals — latest SHA wins → ALLOW",
        ok and csha == full_sha.lower()
    ))

    # ── v1.3.1 Eta REAL mosaic-prose verdict format ────────────────────────────

    # Eta's actual approval body (verbatim shape): "**APPROVED**" + "@ `5edbe5c`",
    # NO "Eta APPROVED" phrase, NO "ETA_APPROVED_COMMIT_SHA:" line.
    eta_real_body = (
        "## Eta Review — PR #29 `fix(deps): svix ... → 0.2.2-alpha (prod unblock)` "
        "@ `5edbe5c` — **APPROVED**\n\n"
        "Urgent prod-unblock. Tiny, surgical, CI-green: +7 -10 across 3 files.\n\n"
        "**APPROVED** @ `5edbe5c`. Correct prod fix, no scope creep.\n\n"
        "Orchestrator: Eta — VantagePeers Review | 2026-06-29"
    )

    # T33-FMT: real mosaic prose, operator passes # eta-approved-sha=5edbe5c → ALLOW.
    #   SHA binding = operator value appears literally as "@ `5edbe5c`" in body.
    mock_real = json.dumps([comment(eta_real_body, "elpiarthera", iso_now)])
    ok, reason, csha = validate_pr_approval("242", mock_real, operator_sha="5edbe5c")
    tests.append((
        "T33-FMT: Eta mosaic prose **APPROVED** + @ `5edbe5c`, op-sha=5edbe5c → ALLOW",
        ok and csha == "5edbe5c"
    ))

    # T33b-FMT: same body but operator SHA absent → BLOCK (no parseable SHA binding).
    ok, reason, csha = validate_pr_approval("242", mock_real, operator_sha="")
    tests.append((
        "T33b-FMT: mosaic prose but no operator SHA → BLOCK (no SHA binding)",
        not ok and "no parseable SHA" in reason
    ))

    # T34-NEG: APPROVED word only inside a NON-approval verdict → BLOCK.
    neg_body = (
        "## Eta Review — PR #29 @ `5edbe5c` — **CHANGES REQUESTED**\n\n"
        "Changes requested: not approved yet, fix the failing test first.\n"
        "Orchestrator: Eta — VantagePeers Review | 2026-06-29"
    )
    mock_neg = json.dumps([comment(neg_body, "elpiarthera", iso_now)])
    ok, reason, csha = validate_pr_approval("242", mock_neg, operator_sha="5edbe5c")
    tests.append((
        "T34-NEG: 'changes requested, not approved yet' → BLOCK",
        not ok
    ))

    # ── v1.3.2 defect-4: publish-dir resolution from monorepo subpackage ───────

    # T35-D4: leading `cd <abspath-subdir>` → origin found from the subdir → ALLOW.
    with tempfile.TemporaryDirectory() as monorepo:
        subprocess.run(["git", "init", monorepo], capture_output=True)
        subprocess.run(["git", "-C", monorepo, "config", "user.email", "test@test.com"], capture_output=True)
        subprocess.run(["git", "-C", monorepo, "config", "user.name", "Test"], capture_output=True)
        subprocess.run(
            ["git", "-C", monorepo, "remote", "add", "origin",
             "https://github.com/elpiarthera/vantageos-mosaic.git"],
            capture_output=True,
        )
        pkg_dir = os.path.join(monorepo, "packages", "pkg")
        os.makedirs(pkg_dir, exist_ok=True)
        with open(os.path.join(pkg_dir, "package.json"), "w") as f:
            f.write('{"name":"@vantageos/pkg","version":"1.0.0"}')
        subprocess.run(["git", "-C", monorepo, "add", "."], capture_output=True)
        subprocess.run(["git", "-C", monorepo, "commit", "-m", "init"], capture_output=True)
        res = subprocess.run(["git", "-C", monorepo, "rev-parse", "HEAD"], capture_output=True, text=True)
        head_local = res.stdout.strip()

        cmd_t35 = (
            f"cd {pkg_dir}\n"
            f"npm publish @vantageos/pkg # eta-approved-pr: 7 # eta-approved-sha: {head_local}"
        )
        # resolve_publish_dir → packages/pkg
        rpd = resolve_publish_dir(cmd_t35, {})
        # origin resolves from the subdir
        owner_t35, repo_t35, diag_t35 = resolve_owner_repo(cwd=rpd)
        # PR validation via mock comments (verdict format A), HEAD pin exact-match
        mock_t35 = json.dumps([
            comment("**APPROVED**\nETA_APPROVED_COMMIT_SHA: " + head_local, "elpiarthera", iso_now),
        ])
        pr_ok_t35, _, csha_t35 = validate_pr_approval("7", mock_t35, operator_sha=head_local, cwd=rpd)
        head_t35 = get_head_sha(cwd=rpd)
        sha_ok_t35, _ = validate_commit_sha(csha_t35, head_t35, publish_dir=rpd)
        tests.append((
            "T35-D4: monorepo subpackage (leading cd) → origin found + ALLOW",
            rpd == pkg_dir
            and owner_t35 == "elpiarthera" and repo_t35 == "vantageos-mosaic"
            and pr_ok_t35 and sha_ok_t35
        ))

    # T36-D4: no leading cd + no data["cwd"] → falls back to os.getcwd() (prior behavior).
    cmd_t36 = "npm publish @vantageos/pkg # eta-approved-pr: 7 # eta-approved-sha: abc1234def5678"
    rpd_t36 = resolve_publish_dir(cmd_t36, {})
    tests.append((
        "T36-D4: no cd + no payload cwd → os.getcwd() fallback (prior behavior)",
        rpd_t36 == os.getcwd()
    ))

    # T36b-D4: data["cwd"] present (existing dir), no leading cd → uses payload cwd.
    with tempfile.TemporaryDirectory() as payload_dir:
        rpd_t36b = resolve_publish_dir("npm publish @vantageos/pkg", {"cwd": payload_dir})
        tests.append((
            "T36b-D4: payload cwd fallback used when no leading cd",
            rpd_t36b == payload_dir
        ))

    # T36c-D4: leading cd takes PRIORITY over payload cwd (cd is the robust signal).
    with tempfile.TemporaryDirectory() as cd_dir, tempfile.TemporaryDirectory() as other:
        cmd_t36c = f"cd {cd_dir}\nnpm publish @vantageos/pkg"
        rpd_t36c = resolve_publish_dir(cmd_t36c, {"cwd": other})
        tests.append((
            "T36c-D4: leading cd overrides payload cwd",
            rpd_t36c == cd_dir
        ))

    # ── v1.3.3 Defect 5: interpreter-command unwrap tests ──────────────────────

    # T37-D5: bash -c 'npm publish' with single quotes → NOW DETECTED (was fail-open)
    ok = is_fleet_publish("bash -c 'npm publish @vantageos/sdk'")
    tests.append((
        "T37-D5: bash -c 'npm publish @vantageos/sdk' → NOW BLOCKS (was fail-open)",
        ok
    ))

    # T38-D5: sh -c "npm publish" with double quotes → NOW DETECTED
    ok = is_fleet_publish('sh -c "npm publish vantage-peers-mcp"')
    tests.append((
        "T38-D5: sh -c \"npm publish\" → NOW BLOCKS (was fail-open)",
        ok
    ))

    # T39-D5: zsh -lc 'npm publish' → NOW DETECTED
    ok = is_fleet_publish("zsh -lc 'npm publish @elpiarthera/tokens'")
    tests.append((
        "T39-D5: zsh -lc 'npm publish' → NOW BLOCKS (was fail-open)",
        ok
    ))

    # T40-D5: nested interpreter (bash -c "sh -c 'npm publish'") → HANDLES ONE LEVEL
    ok = is_fleet_publish("bash -c 'sh -c \"npm publish @vantageos/core\"'")
    tests.append((
        "T40-D5: nested interpreter (one level) → NOW BLOCKS",
        ok
    ))

    # T41-D5: git commit -m message still suppressed (false positive guard preserved)
    ok = is_fleet_publish('git commit -m "docs: npm publish flow explained"')
    tests.append((
        "T41-D5: git commit -m 'npm publish in message' → STILL PASSES (false positive suppressed)",
        not ok
    ))

    # T42-D5: gh pr create title still suppressed
    ok = is_fleet_publish('gh pr create --title "fix: npm publish CI"')
    tests.append((
        "T42-D5: gh pr create with npm publish in title → STILL PASSES (false positive suppressed)",
        not ok
    ))

    # ── Combined flow + override tests ────────────────────────────────────────

    # T30: laurent-direct-publish override present → bypass
    cmd = "npm publish @vantageos/data-lake # laurent-direct-publish"
    tests.append(("T30: laurent-direct-publish override → ALLOW", has_laurent_override(cmd)))

    # T31: fleet publish detection — strip_quoted_strings prevents false positive
    cmd = 'git commit -m "npm publish docs"'
    tests.append(("T31: git commit with publish in string → NOT fleet publish", not is_fleet_publish(cmd)))

    # T32: non-fleet publish → skip (not detected as fleet). v1.4.0: fleet-ness
    # is decided by package.json#name in the resolved dir, so this now needs a
    # real fixture (the old command-text-only assertion no longer applies).
    with tempfile.TemporaryDirectory() as nonfleet_dir:
        with open(os.path.join(nonfleet_dir, "package.json"), "w") as f:
            f.write('{"name":"my-private-app","version":"1.0.0"}')
        cmd = f"cd {nonfleet_dir} && npm publish my-private-app"
        tests.append(("T32: non-fleet publish (package.json#name) → skip (not fleet)", not is_fleet_publish(cmd)))

    # ── v1.4.0 defect A+B regression tests ──────────────────────────────────

    def _fleet_fixture(tmpdir: str, name: str = "@vantageos/pkg") -> None:
        with open(os.path.join(tmpdir, "package.json"), "w") as f:
            f.write(json.dumps({"name": name, "version": "1.0.0"}))

    # T43-A: detection is ACTION-based, not text-based — six ordinary forms,
    # none of which type the publish patterns the old regex ladder enumerated.
    with tempfile.TemporaryDirectory() as d:
        _fleet_fixture(d)
        forms = [
            f"cd {d} && npm publish",
            f"cd {d} && npm publish --access public",
            f"cd {d} && npm --workspace=@vantageos/pkg publish",
            f"cd {d} && pnpm -F pkg publish",
            f"cd {d} && jsr publish",
            f"cd {d} && deno publish",
        ]
        for i, cmd in enumerate(forms, 1):
            tests.append((f"T43-A.{i}: action-based detection — {cmd!r} → fleet BLOCK", is_fleet_publish(cmd)))

    # T44-B: `cd <abspath> && npm publish` (&&-joined) resolves the publish dir
    # correctly (was falling back to os.getcwd() before defect B fix).
    with tempfile.TemporaryDirectory() as d:
        _fleet_fixture(d)
        cmd = f"cd {d} && npm publish"
        rpd = resolve_publish_dir(cmd, {})
        tests.append(("T44-B: &&-joined cd form resolves publish dir correctly", rpd == d))

    # T45-REFUSE: publish action detected, package.json unreadable → REFUSED
    # LOUD (True/block), never a silent passthrough.
    with tempfile.TemporaryDirectory() as d:
        cmd = f"cd {d} && npm publish"
        is_fleet, diag = classify_publish(cmd, {})
        tests.append(("T45-REFUSE: unreadable package.json → REFUSED LOUD (block)", is_fleet and "REFUSED-UNREADABLE" in diag))

    # T46-NAME: fleet-ness decided by package.json#name, not by command text —
    # a fleet name typed in the command but a NON-fleet package.json → passes.
    with tempfile.TemporaryDirectory() as d:
        _fleet_fixture(d, name="my-private-app")
        cmd = f"cd {d} && npm publish @vantageos/pkg"
        tests.append(("T46-NAME: fleet name typed but non-fleet package.json → PASS (name wins)", not is_fleet_publish(cmd)))

    # ── Print results ─────────────────────────────────────────────────────────
    passed = 0
    for name, ok in tests:
        status = "PASS" if ok else "FAIL"
        if ok:
            passed += 1
        print(f"  [{status}] {name}")

    total = len(tests)
    print(f"\n{passed}/{total} PASS")
    sys.exit(0 if passed == total else 1)


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────
def main() -> None:
    # Self-test mode
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        run_self_tests()
        return

    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_name = data.get("tool_name", "") or ""
    if tool_name != "Bash":
        sys.exit(0)

    command = (data.get("tool_input") or {}).get("command", "") or ""
    if not command:
        sys.exit(0)

    # v1.4.0: publish-verb detection (action-based) + fleet-ness (package.json
    # read in the resolved dir) decided together — see classify_publish().
    is_fleet, publish_diag = classify_publish(command, data)

    # Not a fleet publish — passthrough
    if not is_fleet:
        sys.exit(0)

    # v1.3.2 (defect 4): resolve the directory where `npm publish` actually runs,
    # so every git call below (origin resolution, HEAD, tree-diff) targets the
    # publish package — not the session root which lacks an origin remote.
    publish_dir = resolve_publish_dir(command, data)

    # Laurent direct override — allow unconditionally (rare, audited)
    if has_laurent_override(command):
        write_audit(command, "laurent-direct-publish", "", True, "laurent-direct-publish override")
        sys.exit(0)

    if publish_diag.startswith("REFUSED-UNREADABLE"):
        print(block_message(publish_diag), file=sys.stderr)
        write_audit(command, "", "", False, publish_diag)
        sys.exit(2)

    # Extract PR-number token (v1.3.0 — identifies the PR carrying the verdict)
    pr_number, pr_src = extract_eta_pr_number(command)
    if not pr_number:
        print(block_message("no ETA_APPROVED_PR token found in env var, flag, or comment"),
              file=sys.stderr)
        sys.exit(2)

    # Extract the operator's # eta-approved-sha token. Needed BEFORE PR validation:
    # Eta's mosaic prose format binds the SHA by literal presence of THIS value.
    cmd_sha, sha_src = extract_eta_commit_sha(command)
    if not cmd_sha:
        print(block_message("no ETA_APPROVED_COMMIT_SHA token found in env var, flag, or comment"),
              file=sys.stderr)
        sys.exit(2)

    # Get test mock if present (only used when ETA_APPROVAL_HOOK_TEST_MOCK_COMMENTS is set)
    mock_comments = os.environ.get("ETA_APPROVAL_HOOK_TEST_MOCK_COMMENTS") or None

    # 1. Validate the Eta APPROVED verdict from the PR comments (v1.3.1 gh path).
    #    Pass the operator SHA so the mosaic-prose format ("@ `5edbe5c`") can bind it,
    #    and publish_dir so origin resolves from the actual publish package (v1.3.2).
    pr_ok, pr_reason, comment_sha = validate_pr_approval(
        pr_number, mock_comments, operator_sha=cmd_sha, cwd=publish_dir
    )
    if not pr_ok:
        print(block_message(f"PR approval validation failed: {pr_reason}"),
              file=sys.stderr)
        write_audit(command, f"pr#{pr_number}", comment_sha, False, pr_reason)
        sys.exit(2)

    # 2. Cross-check: the command's # eta-approved-sha token must match the SHA bound
    #    from the approval comment (exact or prefix). The comment SHA is authoritative.
    if cmd_sha and cmd_sha.lower() != comment_sha.lower() and not (
        comment_sha.startswith(cmd_sha.lower()) or cmd_sha.lower().startswith(comment_sha)
    ):
        reason = (
            f"command # eta-approved-sha ({cmd_sha}) does not match the SHA cited in the "
            f"Eta APPROVED comment ({comment_sha}) — re-check the verdict"
        )
        print(block_message(reason), file=sys.stderr)
        write_audit(command, f"pr#{pr_number}", comment_sha, False, reason)
        sys.exit(2)

    # 3. Validate commit SHA pin against git HEAD (tree-aware, defect 3 unchanged).
    #    v1.3.2: HEAD + tree-diff run in the resolved publish_dir, not the session root.
    head_sha = get_head_sha(cwd=publish_dir)
    sha_ok, sha_reason = validate_commit_sha(comment_sha, head_sha, publish_dir=publish_dir)
    if not sha_ok:
        print(block_message(f"commit SHA pin failed: {sha_reason}"),
              file=sys.stderr)
        write_audit(command, f"pr#{pr_number}", comment_sha, False, sha_reason)
        sys.exit(2)

    # All checks passed — allow
    write_audit(
        command, f"pr#{pr_number}", comment_sha, True,
        f"pr:{pr_src} approval:{pr_reason} sha:comment head:{head_sha or 'unknown'}",
    )
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Fail closed: unexpected errors block the publish, never allow silently.
        print(
            f"BLOCKED: enforce-eta-approval-before-npm-publish v{VERSION} internal error (fail closed): {e}\n"
            "Fix the hook or use `# laurent-direct-publish` for an emergency bypass.",
            file=sys.stderr,
        )
        sys.exit(2)
