#!/usr/bin/env python3
"""An outside contribution with no verdict is silent, and silence is the answer it reads.

Task k176fxspcaqea13ezm831mzkbx8ez0p9. THE CASE: vantageos-agency/vantage-peers #1306
was opened by `bertux` on 2026-09-21T11:15:53Z and carried no verdict until
2026-09-23T14:05:41Z. Two days. Nothing went red, no queue entry aged, no message
waited. The coordinator found it by listing pull requests BY HAND.

WHY NO EXISTING INSTRUMENT SAW IT
---------------------------------
Every instrument this fleet owns is pointed INWARD:

  - `.claude/skills/daily-start/SKILL.md` Step 4 reads `refs/remotes/origin` — OUR
    branches, and only ours. An outside contribution lives on a FORK; it never
    appears in that list.
  - review tasks are minted by OUR own pull-request flow (`.claude/skills/open-pr`,
    `enforce-pr-opened-via-skill`) — an outside pull request goes through none of it,
    so no task is ever created to age.
  - `check_messages` reads a queue nobody outside the fleet can write to.

Three instruments, none pointed outward. This is the same shape as daily-start Step 4
("a branch older than yesterday is a day that never closed"), turned around: an outside
pull request older than a verdict is a contribution that was never answered.

WHAT COUNTS AS AN ANSWER
------------------------
A verdict — APPROVED, REVISE, CHANGES REQUESTED, REJECTED — is an answer whatever it
says. Only silence is the defect (property 2 of the brief).

A VERDICT IS RECOGNISED BY ITS SHAPE, NEVER BY A WORD APPEARING SOMEWHERE. The first
version of this file searched for a bare verdict word anywhere in a comment body,
case-insensitively — and so it produced the very failure it exists to close. Two real
sentences, both from the review of this script, rendered it CLEAN:

    "I will revise the wording of our contributing guide... No decision on your change yet"
    "I have NOT approved this yet"

Ordinary English. A fleet member who has decided NOTHING, and says so plainly, turned
the detector green. The first is the worse of the two: "revise" there is about a GUIDE,
not about the contribution.

Why the probe could not see it, and this generalises: every MUST_PASS body was a
well-formed verdict written by the matcher's own author. Not one put a verdict WORD
inside a non-verdict SENTENCE. A probe built only from cases its author imagined tests
the author's imagination, not the matcher.

The fix was already half-present here: `VERDICT_REVIEW_STATES` is STRUCTURAL — a GitHub
review state cannot occur by accident in prose. The comment path now has the same
discipline. Three anchors, all three read off real posted verdicts:

  1. THE HEADER. A posted verdict opens a LINE with the decision in a header slot —
     `### Eta — APPROVED — vantageos-agency/vantage-peers #1306 at `cc6dc91``,
     `CHANGES_REQUESTED: the test is missing its red pole`. Markdown furniture, an
     optional actor of at most three words, a DASH-OR-COLON SEPARATOR, the decision,
     then another separator or the end of the line. Prose does not have that shape:
     "I will revise..." and "I have NOT approved this yet" put no separator before the
     word, so neither can reach the header slot.
  2. THE MARKER STANDING ALONE. `[MERGE-APPROVED]` as the utterance of its line (a short
     citation may follow). Quoted inside a sentence — "[MERGE-APPROVED] is the marker a
     coordinator posts, not the contributor" — it is not the utterance and does not count.
  3. THE TRAILER. `ETA_REVIEWED_COMMIT_SHA: <sha>` at line start with a real hex sha
     after it. A named trailer carrying a commit id cannot occur in prose by accident,
     and naming the trailer without a sha ("the trailer is missing") does not match.

BOTH the header and the trailer were kept, because they fail in different directions: a
`[MERGE-APPROVED]` from the coordinator carries no `### Eta —` header, and a review
posted as a GitHub review body sometimes carries the header with the trailer stripped.
Either alone would have been a new blind spot.

A word-anywhere path is GONE. What remains is word-based only INSIDE a structural slot,
and the slot is what it cannot be fooled by: to be read as a verdict, the word must be
the decision a line is making, not a noun the line happens to contain.

The residual error is deliberately one-directional. A verdict posted in some shape none
of the three anchors knows is read as SILENCE, and the run goes RED on a contribution
that was in fact answered — a false alarm a human closes in a minute. The opposite
error, prose read as a decision, is SILENT, and silence is this detector's whole
subject. When the matcher must be wrong, it is wrong out loud.

A GATE BOUNCE IS NOT A VERDICT. On #1306 a `NO GATE — SELF-GATE block not filled`
comment landed at 11:20:33Z, five minutes in, and was RETRACTED four minutes later
("you do not need to fill in the SELF-GATE block. That paperwork is ours to carry for
outside contributions"). Counting it as an answer would have rendered #1306 green for
the whole two days it was unanswered — the detector would have been shown green on the
one case that motivated it. It is classified as a non-verdict, deliberately.

FLEET MEMBERSHIP IS DATA, NOT A LIST IN THIS FILE
-------------------------------------------------
Membership is read from the repository's own collaborators with PUSH permission
(`GET /repos/{repo}/collaborators`). Justification: that ACL is already the authority
deciding who can merge; onboarding or offboarding a fleet member is ALREADY an edit to
it, so a contributor joining or leaving never requires editing this script. Measured on
2026-09-23: `elpiarthera` (admin) and `eta-vantageteam` (maintain) carry push;
`CedricDdl` carries pull only and is therefore OUTSIDE — which is correct, a read-only
collaborator's pull request needs an answer exactly like a stranger's.

Rejected alternatives: the VantagePeers peer records key on orchestrator role
(Sigma/Pi/Eta), not on GitHub login, and reading them needs a deployment key this
DEV-only check must never hold; a committed file rots at the first joiner, which is the
defect class the first property forbids.

IF MEMBERSHIP CANNOT BE READ, THIS REFUSES TO JUDGE (exit 2). An empty push-set is
also a refusal: every repository has at least an owner, so an empty answer means the
read failed, not that the fleet is empty. "I could not check" and "nothing is waiting"
must not produce the same exit code — this fleet measured today that a passing check
and an absent check render identically, and that is the whole point of this class.

EXIT CODES
  0  clean — and the run STATES THE SCOPE it examined, never prints nothing
  1  at least one outside contribution is unanswered — named with author and age
  2  refusing to judge — the scope, or the membership, could not be read
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

# The decision vocabulary. A gate bounce ("NO GATE", "SELF-GATE block not filled") is
# paperwork and is deliberately absent — see the module docstring for the #1306
# measurement that settles this.
#
# These words are NEVER searched for on their own. They are only ever read inside one
# of the three structural anchors below; a bare word in a sentence does not count.
VERDICT_WORDS = [
    "APPROVED",
    "REVISE",
    "CHANGES[ _-]REQUESTED",
    "REJECTED",
    "MERGE-APPROVED",
]
_WORDS = "|".join(VERDICT_WORDS)

# ANCHOR 1 — the header slot. `### Eta — APPROVED — …`, `Eta - REVISE - …`,
# `CHANGES_REQUESTED: …`. Markdown furniture, an optional actor of at most three
# words, a DASH-OR-COLON separator, the decision, then a separator or end of line.
# The separator before the decision is what prose lacks: "I will revise the wording"
# and "I have NOT approved this yet" have only a space there.
VERDICT_HEADER_RE = re.compile(
    r"^[ \t>#*_]*"
    r"(?:[A-Za-z][A-Za-z.'-]{0,20}(?:[ \t]+[A-Za-z][A-Za-z.'-]{0,20}){0,2}"
    r"[ \t]*[—–:|-]+[ \t]*)?"
    rf"(?:{_WORDS})\b"
    r"[ \t]*(?:[—–:|*_.-]|$)",
    re.IGNORECASE | re.MULTILINE,
)

# ANCHOR 2 — the doctrine marker standing as the utterance of its line. A short
# citation (a sha, a task id) may follow it; a sentence may not.
VERDICT_MARKER_RE = re.compile(
    r"^[ \t>*_]*\[MERGE-APPROVED\][ \t]*[—–:|-]*[ \t]*\S{0,64}[ \t]*$",
    re.IGNORECASE | re.MULTILINE,
)

# ANCHOR 3 — the trailer every posted verdict carries, WITH its commit id. Naming
# the trailer in prose without a sha after it does not match.
VERDICT_TRAILER_RE = re.compile(
    r"^[ \t>*_]*[A-Z][A-Z0-9]*_REVIEWED_COMMIT_SHA\**[ \t]*:?[ \t]*`?[0-9a-f]{7,40}`?",
    re.MULTILINE,
)

# GitHub review states that are themselves a verdict, independent of body text.
# Structural in the same sense: a review state cannot occur by accident in prose.
VERDICT_REVIEW_STATES = {"APPROVED", "CHANGES_REQUESTED", "DISMISSED"}


def is_verdict_text(body: str) -> bool:
    """Does this body MAKE a decision, or merely contain a word for one?

    Shape only. There is no word-anywhere path; removing one of these anchors must
    make `--self-test` go red (see `MUST_REPORT`'s prose comments)."""
    if not body:
        return False
    return bool(
        VERDICT_HEADER_RE.search(body)
        or VERDICT_MARKER_RE.search(body)
        or VERDICT_TRAILER_RE.search(body)
    )

MAX_PAGES = 5  # bounded read; see `fetch_pulls` — truncation is a refusal, never a pass


class Unreadable(Exception):
    """The scope could not be read. Never downgraded to a clean result."""


# ─────────────────────────────────────────────────────────────────────────────
# Pure classification. No network here, so both poles are provable offline.
# ─────────────────────────────────────────────────────────────────────────────


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def is_open_at(pull: dict, as_of: datetime) -> bool:
    """Reconstruct openness at an instant, so the historical pole is read from live
    data rather than invented. A pull request closed AFTER `as_of` was open at `as_of`."""
    if parse_ts(pull["createdAt"]) > as_of:
        return False
    closed = pull.get("closedAt") or pull.get("mergedAt")
    if closed is None:
        return True
    return parse_ts(closed) > as_of


def is_verdict_comment(comment: dict, members: set[str], author: str) -> bool:
    who = (comment.get("author") or "").lower()
    if who not in members or who == author.lower():
        return False  # a contribution is never answered by its own author
    return is_verdict_text(comment.get("body") or "")


def is_verdict_review(review: dict, members: set[str], author: str) -> bool:
    who = (review.get("author") or "").lower()
    if who not in members or who == author.lower():
        return False
    if (review.get("state") or "").upper() in VERDICT_REVIEW_STATES:
        return True
    return is_verdict_text(review.get("body") or "")


def events_before(items: list[dict], as_of: datetime) -> list[dict]:
    out = []
    for item in items:
        stamp = item.get("createdAt") or item.get("submittedAt")
        if stamp is None or parse_ts(stamp) <= as_of:
            out.append(item)
    return out


def has_verdict(pull: dict, members: set[str], as_of: datetime) -> bool:
    author = pull["author"]
    for comment in events_before(pull.get("comments") or [], as_of):
        if is_verdict_comment(comment, members, author):
            return True
    for review in events_before(pull.get("reviews") or [], as_of):
        if is_verdict_review(review, members, author):
            return True
    return False


def humanise_age(delta: timedelta) -> str:
    total = int(delta.total_seconds())
    if total < 0:
        total = 0
    return f"{total // 86400}d {(total % 86400) // 3600}h"


def classify(pulls: list[dict], members: set[str], as_of: datetime) -> dict:
    """The whole judgement, over an already-read repository state."""
    members = {m.lower() for m in members}
    open_pulls = [p for p in pulls if is_open_at(p, as_of)]
    outside = [p for p in open_pulls if p["author"].lower() not in members]
    unanswered = [p for p in outside if not has_verdict(p, members, as_of)]
    return {
        "openExamined": len(open_pulls),
        "outside": len(outside),
        "unanswered": [
            {
                "number": p["number"],
                "author": p["author"],
                "title": p.get("title", ""),
                "url": p.get("url", ""),
                "createdAt": p["createdAt"],
                "age": humanise_age(as_of - parse_ts(p["createdAt"])),
            }
            for p in sorted(unanswered, key=lambda p: parse_ts(p["createdAt"]))
        ],
    }


# ─────────────────────────────────────────────────────────────────────────────
# Reading the scope. Every failure here raises Unreadable — never returns empty.
# ─────────────────────────────────────────────────────────────────────────────


def gh(args: list[str]) -> str:
    env = dict(os.environ)
    # Fleet doctrine: the ambient GH_TOKEN/GITHUB_TOKEN are not this check's credential.
    env.pop("GH_TOKEN", None)
    env.pop("GITHUB_TOKEN", None)
    try:
        proc = subprocess.run(
            ["gh", *args], capture_output=True, text=True, env=env, timeout=120
        )
    except FileNotFoundError as exc:
        raise Unreadable(f"`gh` is not installed or not on PATH ({exc})") from exc
    except subprocess.TimeoutExpired as exc:
        raise Unreadable(f"`gh {' '.join(args)}` timed out after 120s") from exc
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()
        first = detail[0] if detail else "no stderr"
        raise Unreadable(f"`gh {' '.join(args)}` exited {proc.returncode}: {first}")
    return proc.stdout


def gh_json(args: list[str]):
    raw = gh(args)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise Unreadable(f"`gh {' '.join(args)}` returned unparsable JSON: {exc}") from exc


def fetch_members(repo: str) -> tuple[set[str], str]:
    rows = gh_json(["api", f"repos/{repo}/collaborators", "--paginate", "--slurp"])
    logins = set()
    for page in rows if rows and isinstance(rows[0], list) else [rows]:
        for row in page:
            if (row.get("permissions") or {}).get("push"):
                logins.add(row["login"].lower())
    if not logins:
        # Every repository has at least an owner with push. An empty answer is a
        # failed read wearing the costume of a clean one.
        raise Unreadable(
            f"repos/{repo}/collaborators resolved ZERO logins with push permission — "
            "that is a failed read, not an empty fleet"
        )
    return logins, f"GitHub collaborators with push on {repo}"


def fetch_pulls(repo: str, as_of: datetime | None) -> list[dict]:
    """Bounded read. If the oldest page fetched is still newer than `as_of`, the
    window is incomplete and that is a REFUSAL, never a short clean answer."""
    state = "all" if as_of else "open"
    pulls: list[dict] = []
    for page in range(1, MAX_PAGES + 1):
        batch = gh_json(
            [
                "api",
                f"repos/{repo}/pulls?state={state}&sort=created&direction=desc"
                f"&per_page=100&page={page}",
            ]
        )
        if not batch:
            break
        pulls.extend(batch)
        if len(batch) < 100:
            break
    else:
        if as_of and pulls and parse_ts(pulls[-1]["created_at"]) > as_of:
            raise Unreadable(
                f"read {len(pulls)} pull requests over {MAX_PAGES} pages and the oldest "
                f"({pulls[-1]['created_at']}) is still newer than --as-of {as_of.isoformat()} — "
                "the window is incomplete, refusing to report on a truncated read"
            )

    out = []
    for p in pulls:
        out.append(
            {
                "number": p["number"],
                "author": (p.get("user") or {}).get("login") or "",
                "title": p.get("title") or "",
                "url": p.get("html_url") or "",
                "createdAt": p["created_at"],
                "closedAt": p.get("closed_at"),
                "mergedAt": p.get("merged_at"),
                "comments": None,  # filled lazily, only for outside pull requests
                "reviews": None,
            }
        )
    return out


def fetch_conversation(repo: str, pull: dict) -> None:
    comments = gh_json(
        ["api", f"repos/{repo}/issues/{pull['number']}/comments?per_page=100"]
    )
    reviews = gh_json(
        ["api", f"repos/{repo}/pulls/{pull['number']}/reviews?per_page=100"]
    )
    pull["comments"] = [
        {
            "author": (c.get("user") or {}).get("login") or "",
            "createdAt": c.get("created_at"),
            "body": c.get("body") or "",
        }
        for c in comments
    ]
    pull["reviews"] = [
        {
            "author": (r.get("user") or {}).get("login") or "",
            "submittedAt": r.get("submitted_at"),
            "state": r.get("state") or "",
            "body": r.get("body") or "",
        }
        for r in reviews
    ]


def read_scope(repo: str, as_of: datetime | None) -> tuple[list[dict], set[str], str]:
    members, source = fetch_members(repo)
    pulls = fetch_pulls(repo, as_of)
    horizon = as_of or datetime.now(timezone.utc)
    for pull in pulls:
        if pull["author"].lower() not in members and is_open_at(pull, horizon):
            fetch_conversation(repo, pull)
    return pulls, members, source


# ─────────────────────────────────────────────────────────────────────────────
# Reporting. The empty case and the unreadable case must be DISTINGUISHABLE at
# the output, not merely in the author's head.
# ─────────────────────────────────────────────────────────────────────────────


def report(repo: str, source: str, members: set[str], result: dict, as_of: datetime) -> int:
    print(f"SCOPE: {repo} @ {as_of.isoformat().replace('+00:00', 'Z')}")
    print(f"  fleet membership: {len(members)} login(s) — source: {source}")
    print(f"  open pull requests examined: {result['openExamined']}")
    print(f"  outside contributions among them: {result['outside']}")

    if not result["unanswered"]:
        if result["outside"] == 0:
            print(
                "CLEAN: no outside contribution is open — "
                f"{result['openExamined']} open pull request(s) read, all from the fleet."
            )
        else:
            print(
                f"CLEAN: {result['outside']} outside contribution(s) examined, "
                "every one carries a verdict."
            )
        return 0

    print("")
    for item in result["unanswered"]:
        print(
            f"OPEN, NO TERMINAL VERDICT — #{item['number']} by {item['author']}, "
            f"open {item['age']}"
        )
        print(f"  opened: {item['createdAt']}   {item['title'][:80]}")
        if item["url"]:
            print(f"  {item['url']}")
    print("")
    print(
        f"{len(result['unanswered'])} outside contribution(s) open with no terminal "
        "verdict. THIS IS NOT THE SAME AS UNANSWERED: the thread may hold courtesy, "
        "questions, or a bounce that was retracted — what is missing is a DECISION. "
        "A terminal verdict (APPROVED or REVISE) ends the wait; anything else leaves "
        "the contributor holding an open question."
    )
    return 1


def refuse(reason: str) -> int:
    print(f"REFUSING TO JUDGE: {reason}", file=sys.stderr)
    print(
        "This is NOT a clean run. 'I could not read the scope' and 'nothing is waiting' "
        "are different answers, and a detector that renders them identically is the "
        "defect it was built to close.",
        file=sys.stderr,
    )
    return 2


# ─────────────────────────────────────────────────────────────────────────────
# Bipolar probe over fixtures — red-provable forever, even once every open
# contribution has been answered.
# ─────────────────────────────────────────────────────────────────────────────

MEMBERS_FIXTURE = {"elpiarthera", "eta-vantageteam"}
AS_OF_FIXTURE = parse_ts("2026-09-23T12:00:00Z")

# MUST_REPORT — the #1306 shape: an outside author, open, and the only fleet comments
# are a gate bounce, its retraction, and PROSE THAT DECIDES NOTHING. The prose bodies
# are the point: they each contain a verdict WORD, and the pre-fix bare-word matcher
# rendered this fixture green on every one of them.
MUST_REPORT = [
    {
        "number": 1306,
        "author": "bertux",
        "title": "fix: an outside contribution",
        "url": "https://example.invalid/1306",
        "createdAt": "2026-09-21T11:15:53Z",
        "closedAt": None,
        "mergedAt": None,
        "comments": [
            {
                "author": "elpiarthera",
                "createdAt": "2026-09-21T11:20:33Z",
                "body": "NO GATE - SELF-GATE block not filled. Thanks for the contribution.",
            },
            {
                "author": "elpiarthera",
                "createdAt": "2026-09-21T11:24:32Z",
                "body": "A correction: you do not need to fill in the SELF-GATE block.",
            },
            {
                "author": "bertux",
                "createdAt": "2026-09-21T12:01:47Z",
                "body": "Understood, this is APPROVED on my side.",
            },
            {
                "author": "eta-vantageteam",
                "createdAt": "2026-09-21T13:00:00Z",
                "body": (
                    "I will revise the wording of our contributing guide... "
                    "No decision on your change yet"
                ),
            },
            {
                "author": "eta-vantageteam",
                "createdAt": "2026-09-21T13:30:00Z",
                "body": "I have NOT approved this yet",
            },
            {
                "author": "elpiarthera",
                "createdAt": "2026-09-21T14:00:00Z",
                "body": (
                    "[MERGE-APPROVED] is the marker a coordinator posts, never the "
                    "contributor. Please do not add it yourself."
                ),
            },
        ],
        "reviews": [],
    }
]

# MUST_PASS — same contribution, answered. Whatever the verdict says. One entry per
# anchor, so deleting any single anchor turns this pole red.
MUST_PASS = [
    # the HEADER anchor
    {
        **MUST_REPORT[0],
        "comments": MUST_REPORT[0]["comments"]
        + [
            {
                "author": "elpiarthera",
                "createdAt": "2026-09-22T09:00:00Z",
                "body": "### Eta - REVISE - vantage-peers #1306\n\nSplit this in two.",
            }
        ],
    },
    # the TRAILER anchor, with the header stripped
    {
        **MUST_REPORT[0],
        "number": 1307,
        "comments": MUST_REPORT[0]["comments"]
        + [
            {
                "author": "eta-vantageteam",
                "createdAt": "2026-09-22T09:00:00Z",
                "body": "Measured it myself, the poles hold.\n\n"
                "ETA_REVIEWED_COMMIT_SHA: cc6dc91a88455573796aa3fb37ceeee2eacf85ca",
            }
        ],
    },
    # the MARKER anchor, standing as the utterance of its line
    {
        **MUST_REPORT[0],
        "number": 1308,
        "comments": MUST_REPORT[0]["comments"]
        + [
            {
                "author": "elpiarthera",
                "createdAt": "2026-09-22T09:00:00Z",
                "body": "[MERGE-APPROVED]",
            }
        ],
    },
    {
        "number": 1329,
        "author": "elpiarthera",
        "title": "a fleet pull request, unanswered",
        "url": "",
        "createdAt": "2026-09-23T00:00:00Z",
        "closedAt": None,
        "mergedAt": None,
        "comments": [],
        "reviews": [],
    },
]


def self_test() -> int:
    red = classify(MUST_REPORT, MEMBERS_FIXTURE, AS_OF_FIXTURE)
    green = classify(MUST_PASS, MEMBERS_FIXTURE, AS_OF_FIXTURE)

    ok = True
    if len(red["unanswered"]) != 1 or red["unanswered"][0]["author"] != "bertux":
        ok = False
        print("SELF-TEST FAIL: the #1306 shape did not report.", file=sys.stderr)
    elif red["unanswered"][0]["age"] != "2d 0h":
        ok = False
        print(
            f"SELF-TEST FAIL: age reported {red['unanswered'][0]['age']}, expected 2d 0h.",
            file=sys.stderr,
        )
    if green["unanswered"]:
        ok = False
        print(
            "SELF-TEST FAIL: an answered contribution, or a fleet pull request, reported.",
            file=sys.stderr,
        )

    if not ok:
        return 1
    print("SELF-TEST PASS (both poles)")
    print(f"  MUST_REPORT: #1306 by bertux, age {red['unanswered'][0]['age']} -> 1 failure")
    print(f"  MUST_PASS:   header + trailer + marker + fleet PR -> {len(green['unanswered'])} failures")
    print("  a gate bounce is not a verdict; a verdict by the author is not a verdict")
    print("  a verdict WORD inside a sentence that decides nothing is not a verdict")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--repo", help="owner/name of the repository to examine")
    ap.add_argument(
        "--as-of",
        help="ISO-8601 instant; reconstruct the state at that time from live data",
    )
    ap.add_argument(
        "--snapshot",
        help="read the repository state from a JSON file instead of the network",
    )
    ap.add_argument("--self-test", action="store_true", help="bipolar probe over fixtures")
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    if not args.repo and not args.snapshot:
        return refuse("no --repo and no --snapshot given — there is no scope to examine")

    try:
        as_of = parse_ts(args.as_of) if args.as_of else datetime.now(timezone.utc)
    except ValueError as exc:
        return refuse(f"--as-of {args.as_of!r} is not an ISO-8601 instant: {exc}")

    try:
        if args.snapshot:
            with open(args.snapshot, encoding="utf-8") as fh:
                snap = json.load(fh)
            repo = args.repo or snap.get("repo") or args.snapshot
            members = {m.lower() for m in snap.get("members", [])}
            if not members:
                raise Unreadable(f"snapshot {args.snapshot} carries no fleet membership")
            source = snap.get("membersSource", f"snapshot {args.snapshot}")
            pulls = snap.get("pulls", [])
        else:
            repo = args.repo
            pulls, members, source = read_scope(repo, as_of if args.as_of else None)
    except Unreadable as exc:
        return refuse(str(exc))
    except (OSError, json.JSONDecodeError) as exc:
        return refuse(f"could not read {args.snapshot}: {exc}")

    return report(repo, source, members, classify(pulls, members, as_of), as_of)


if __name__ == "__main__":
    sys.exit(main())
