#!/usr/bin/env python3
"""enforce-fresh-state-in-messages.py — Layer 2 safety net for stale hand-typed
living-artifact state in outbound `send_message` prose.

NOT INSTALLED. Delivered to Pi under artifacts/ for review + installation
under .claude/hooks/ per Day 128 brief (Sigma's Layer 1 is the state-token
resolver in mcp-server/src/state-tokens.ts; this file is Layer 2 — a
defence-in-depth net for orchestrators who typed a state claim in plain
prose INSTEAD of using a `{{pr:...}}` / `{{npm:...}}` / `{{task:...}}`
token).

ROOT CAUSE (Day 128 brief): "un état tapé à la main est un mensonge en
sursis". Two measured incidents same day: a message claimed "PR -> OPEN"
while GitHub said MERGED; a message claimed "latest 0.4.6-alpha" while the
npm registry's `latest` dist-tag was 0.4.7-alpha.

POLICY — the three living-artifact claims this hook recognizes in plain
prose (Layer 1 tokens bypass this hook entirely — they resolve server-side
and never appear as a literal claim in the delivered body):

  1. PR state:  `PR #123 (owner/repo) -> OPEN|MERGED|CLOSED`
                (repo also accepted via `--repo owner/repo` CLI default or
                the STATE_TOKENS_DEFAULT_REPO env var when the claim omits
                the repo, e.g. bare `PR #123 -> OPEN`).
  2. npm state: `<pkg>@<tag> -> <version>`   or   `<pkg> latest <version>`
  3. Task state: `task <k17...id> -> todo|in_progress|review|blocked|done`

Each recognized claim is RE-VERIFIED live (GitHub REST API / npm registry /
`npx convex run tasks:get`) at hook time. A contradiction between the typed
claim and the live value is a hard BLOCK (exit 2), citing BOTH values plus
the resolution instant — the send never happens.

WHAT THIS HOOK NEVER TOUCHES (must stay green — MUST_PASS class):
  - Anything outside the `evidence:` field. `finding:`, `action:`, `next:` are
    where an author NARRATES — including quoting their own past proofs verbatim,
    arrows and all:

        finding: at the time I gated it, PR #870 -> OPEN — that is what I cited,
                 and it was true.

    This is exact, lawful and honest, and an earlier version of this hook BLOCKED
    it, because it scanned the whole body and heard only the current tree. A
    reviewer forbidden from quoting his own evidence routes around the guard, and
    then the guard guards nothing.

    That earlier version also PROMISED this carve-out right here, on the theory
    that past-tense prose says "was" and never "->". The theory was FALSE — the
    arrow IS our proof syntax, and we quote it in past-tense narration constantly,
    precisely because it is the form the proof was produced in. A guard that
    documents an exemption it does not grant is a lying contract inside the guard,
    which is the very defect it exists to prosecute. Caught by Eta on PR #1094;
    the fix is scope, not grammar.
  - Ratios ("788/788"), bare SHAs, unified diffs — no claim grammar, no match.
  - Content with no recognized claim passes through unmodified — silent, exit 0.

DECLARED HOLE (stated, not discovered later):
  A live claim written as ordinary prose ("PR #1092 is already merged") is NOT
  caught — no arrow, and often not in `evidence:` either. This net is deliberately
  partial. A net that believes itself complete is more dangerous than one declared
  partial. Layer 1 (state tokens resolved server-side, mcp-server/src/state-tokens.ts)
  is what actually closes the class; this hook is only the belt over prose Layer 1
  never saw.

FAIL-OPEN ON "CANNOT VERIFY" (deliberate, distinct from Layer 1):
  Layer 1 (state-tokens.ts) is fail-CLOSED: a token that cannot resolve
  blocks the send outright, because the caller EXPLICITLY asked for a live
  value. This Layer 2 hook is a safety net over free-form prose the caller
  did NOT mark as a live claim — if GitHub/npm/Convex are unreachable, or
  the claim's repo/package/task cannot be determined, the hook prints a
  WARNING to stderr and exits 0 (allow). Blocking a legitimate message
  because a network call from the hook process failed would recreate the
  exact "silence read as good news" failure this doctrine exists to kill —
  but for an *unmarked* free-text claim (not a token the author explicitly
  requested resolved), erring toward not-blocking is the correct trade-off.
  Layer 1 remains the authoritative fail-closed gate for anyone who used a
  token; this hook only catches the case where they typed a claim by hand
  INSTEAD of using a token.

OVERRIDE: `// allow-stale-state-claim: <reason, >= 6 chars>` anywhere in the
inspected text — reserved for verbatim citation of historical claims (e.g.
quoting a prior incident's wording), matching the existing hook convention
(`enforce-full-ids.py`).

Wired (intended, once installed by Pi): PreToolUse on
`mcp__vantage-peers__send_message`.

Exit codes: 0 = allow, 2 = block (contradiction proven).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

TEXT_FIELDS = ("content",)

#: The message grid's assertion field. Everything from `evidence:` up to the next
#: top-level grid label is where the author ASSERTS the state of the world NOW.
#: `finding:`, `action:`, `next:` are where the author NARRATES — including quoting
#: their own past evidence verbatim, arrows and all. Only the first is scanned.
EVIDENCE_START_RE = re.compile(r"^\s*evidence\s*:", re.IGNORECASE | re.MULTILINE)
GRID_LABEL_RE = re.compile(
    r"^\s*(finding|action|next|nb|note|context)\s*:", re.IGNORECASE | re.MULTILINE
)


def _evidence_scope(content: str) -> str:
    """Return only the `evidence:` block(s) — the region where a LIVE state is
    asserted. Returns "" when the message carries no evidence field at all.

    A message with no `evidence:` field asserts nothing verifiable and is left
    alone: this net catches over-claiming, not free speech. That it therefore
    misses a live claim written as ordinary prose ("PR #1092 is already merged")
    is a REAL and DELIBERATE hole, stated here rather than discovered later —
    a net that believes itself complete is more dangerous than one declared
    partial. Layer 1 (state tokens, resolved server-side) is what actually closes
    the class; this hook is only the belt over prose that Layer 1 never saw.
    """
    out: list[str] = []
    for m in EVIDENCE_START_RE.finditer(content):
        start = m.start()
        nxt = GRID_LABEL_RE.search(content, m.end())
        out.append(content[start : nxt.start() if nxt else len(content)])
    return "\n".join(out)

OVERRIDE_RE = re.compile(r"//\s*allow-stale-state-claim:\s*\S.{5,}")

PR_CLAIM_RE = re.compile(
    r"\bPR\s*#(?P<number>\d+)\s*(?:\((?P<repo>[\w.-]+/[\w.-]+)\))?\s*->\s*"
    r"(?P<state>OPEN|MERGED|CLOSED)\b"
)

NPM_CLAIM_RE = re.compile(
    r"(?P<pkg>@?[\w.-]+(?:/[\w.-]+)?)@(?P<tag>[\w.-]+)\s*->\s*(?P<version>[0-9][\w.+-]*)"
)

TASK_CLAIM_RE = re.compile(
    r"\btask\s+(?P<taskid>k[0-9a-z]{6,32})\s*->\s*"
    r"(?P<status>todo|in_progress|review|blocked|done)\b"
)

NOW_ISO = lambda: datetime.now(timezone.utc).isoformat()


def warn(msg: str) -> None:
    sys.stderr.write(f"[enforce-fresh-state-in-messages] WARNING: {msg}\n")


def block(claim_kind: str, ref: str, typed_value: str, live_value: str) -> None:
    sys.stderr.write(
        "BLOCKED: hand-typed state claim contradicts live reality.\n"
        f"  kind:    {claim_kind}\n"
        f"  ref:     {ref}\n"
        f"  typed:   {typed_value}\n"
        f"  live:    {live_value}\n"
        f"  checked: {NOW_ISO()}\n"
        "Use a state token instead of typing this by hand: "
        "{{pr:owner/repo#N}} / {{npm:pkg[@tag]}} / {{task:taskId}} — "
        "these resolve at send time and cannot go stale. "
        "If this is a verbatim historical citation, not a live claim: "
        "`// allow-stale-state-claim: <reason>`.\n"
    )
    sys.exit(2)


def http_get_json(url: str, headers: dict[str, str] | None = None) -> dict | None:
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ConnectionError(str(exc)) from exc


def check_pr_claims(text: str) -> None:
    for m in PR_CLAIM_RE.finditer(text):
        number = m.group("number")
        repo = m.group("repo") or os.environ.get("STATE_TOKENS_DEFAULT_REPO")
        typed_state = m.group("state")
        if not repo:
            warn(
                f"PR #{number} claim has no repo (add '(owner/repo)' or set "
                "STATE_TOKENS_DEFAULT_REPO) — cannot verify, allowing."
            )
            continue
        owner, name = repo.split("/", 1)
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "vantage-peers-enforce-fresh-state",
        }
        token = os.environ.get("GITHUB_TOKEN")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            body = http_get_json(
                f"https://api.github.com/repos/{owner}/{name}/pulls/{number}",
                headers,
            )
        except ConnectionError as exc:
            warn(f"GitHub unreachable for PR #{number} ({exc}) — cannot verify, allowing.")
            continue
        if body is None:
            warn(f"PR #{number} not found on {repo} — cannot verify claim, allowing.")
            continue
        live_state = "MERGED" if body.get("merged") else str(body.get("state", "")).upper()
        if live_state != typed_state:
            block(
                "pr",
                f"{repo}#{number}",
                typed_state,
                live_state,
            )


def check_npm_claims(text: str) -> None:
    for m in NPM_CLAIM_RE.finditer(text):
        pkg = m.group("pkg")
        tag = m.group("tag")
        typed_version = m.group("version")
        try:
            body = http_get_json(f"https://registry.npmjs.org/{pkg}")
        except ConnectionError as exc:
            warn(f"npm registry unreachable for {pkg} ({exc}) — cannot verify, allowing.")
            continue
        if body is None:
            warn(f"npm package {pkg} not found — cannot verify claim, allowing.")
            continue
        dist_tags = body.get("dist-tags") or {}
        live_version = dist_tags.get(tag)
        if live_version is None:
            warn(f"npm dist-tag {tag} not found for {pkg} — cannot verify, allowing.")
            continue
        if live_version != typed_version:
            block(
                "npm",
                f"{pkg}@{tag}",
                typed_version,
                live_version,
            )


def check_task_claims(text: str) -> None:
    for m in TASK_CLAIM_RE.finditer(text):
        task_id = m.group("taskid")
        typed_status = m.group("status")
        convex_url = os.environ.get("CONVEX_URL")
        if not convex_url:
            warn(
                f"task {task_id} claim: CONVEX_URL not set — cannot verify, allowing."
            )
            continue
        try:
            proc = subprocess.run(
                [
                    "npx",
                    "convex",
                    "run",
                    "tasks:get",
                    json.dumps({"taskId": task_id}),
                    "--url",
                    convex_url,
                ],
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            warn(f"Convex CLI unreachable for task {task_id} ({exc}) — cannot verify, allowing.")
            continue
        if proc.returncode != 0:
            warn(
                f"Convex CLI failed for task {task_id} ({proc.stderr.strip()[:200]}) — "
                "cannot verify, allowing."
            )
            continue
        raw = proc.stdout.strip()
        if not raw or raw == "null":
            warn(f"task {task_id} does not exist per Convex — cannot verify claim, allowing.")
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            warn(f"Convex CLI returned non-JSON for task {task_id} — cannot verify, allowing.")
            continue
        live_status = data.get("status") if isinstance(data, dict) else None
        if not live_status:
            warn(f"task {task_id} has no readable status — cannot verify, allowing.")
            continue
        if live_status != typed_status:
            block("task", task_id, typed_status, live_status)


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0  # fail-open on unreadable payload (matches enforce-full-ids.py convention)

    tool_input = payload.get("tool_input") or {}
    full = "\n".join(str(tool_input.get(f, "")) for f in TEXT_FIELDS)

    if not full.strip():
        return 0

    if OVERRIDE_RE.search(full):
        return 0

    # SCAN ONLY WHERE A LIVE STATE IS ASSERTED, NEVER WHERE ONE IS NARRATED.
    #
    # The message grid separates the two, and the separation is the whole fix:
    #   evidence:  is where you ASSERT the state of the world right now.
    #   finding: / action: / next:  is where you RECOUNT what you saw, argue,
    #            and quote your own past proofs.
    #
    # Scanning the whole body blocked this, which is exact, lawful, and honest:
    #
    #     finding: at the time I gated it, PR #870 -> OPEN — that is what I cited,
    #              and it was true.
    #
    # The sentence says "at the time". The guard heard only the current tree, and
    # refused the send because the PR has since merged. That is not a leak caught;
    # that is a reviewer forbidden from quoting his own evidence — and a guard you
    # must route around in order to tell the truth is a guard that gets ripped out.
    # No `// allow-stale-state-claim:` marker saves it either: we do not ask people
    # to apologise for citing what they actually observed.
    #
    # The docstring of this very file used to promise this carve-out, on the theory
    # that past-tense prose says "was" and never "->". That theory is FALSE: the
    # arrow IS our proof syntax, and we quote it in past-tense narration constantly,
    # precisely because it is the form the proof was produced in. A guard that
    # documents an exemption it does not grant is a lying contract in the guard
    # itself — the same defect it exists to prosecute. Caught by Eta on PR #1094.
    blob = _evidence_scope(full)
    if not blob.strip():
        return 0

    check_pr_claims(blob)
    check_npm_claims(blob)
    check_task_claims(blob)
    return 0


if __name__ == "__main__":
    sys.exit(main())
