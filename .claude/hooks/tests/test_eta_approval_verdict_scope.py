"""Bipolar probe for the verdict-scope fix in enforce-eta-approval-before-npm-publish.

Class of failure: the negative-verdict guard scanned the WHOLE comment body, so a
verdict word appearing as the LABEL OF A MEASUREMENT invalidated a genuine
approval. A reviewer proving zero false positives writes a line reading
"legitimate REJECTED : [] <- 0 of 11"; the guard read that proof as a refusal.
The word is data there, not a decision.

Material is REAL and was not authored by the fix's author: an APPROVED comment and
a REVISE comment taken unchanged from two different repositories. Both poles are
load-bearing — a guard that only blocks scores perfectly on a one-sided probe and
gets disabled the week someone needs it.

Run: python3 .claude/hooks/tests/test_eta_approval_verdict_scope.py
"""

import importlib.util
import pathlib
import sys

HOOK = pathlib.Path(__file__).resolve().parents[1] / "enforce-eta-approval-before-npm-publish.py"
FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures"

spec = importlib.util.spec_from_file_location("eta_approval_hook", HOOK)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def _is_approval(body: str) -> bool:
    positive = mod.ETA_APPROVED_VERDICT_RE.search(body)
    negative = mod.ETA_NEGATIVE_VERDICT_RE.search(mod.verdict_scope(body))
    return bool(positive) and not negative


APPROVED = (FIXTURES / "eta-approved-taste-engine-pr9.md").read_text(encoding="utf-8")
REVISE = (FIXTURES / "eta-revise-doc-forge-pr61.md").read_text(encoding="utf-8")

# A verdict word must still block when it IS the verdict, whatever the wording.
SYNTHETIC_BLOCKS = [
    ("heading rejected", "### Eta - REJECTED - some repo PR #1 @abc1234\n\nAPPROVED appears in prose here.\n"),
    ("heading changes requested", "### Eta - CHANGES REQUESTED - PR #2\n\nbody mentions APPROVED\n"),
    ("first line not approved", "NOT APPROVED - hold the publish\n\nAPPROVED elsewhere in the body\n"),
]

# Legitimate approvals whose BODY carries a verdict word as data.
#
# The last three cases matter more than the first two: an approval that REPORTS
# ITS OWN PROBE necessarily writes the words of refusal, because that is what a
# probe measures. Under a body-wide scan the guard's false-positive surface GROWS
# as proof discipline improves — the more rigorous the approval, the more surely
# it is refused. Any fix that closes only the measurement-label case leaves this
# one open, and this one is the larger of the two.
SYNTHETIC_PASSES = [
    ("measurement label in body", "### Eta - APPROVED - PR #3 @deadbee\n\nlegitimate REJECTED : [] <- 0 of 11\n"),
    ("prose citing a past refusal", "### Eta - APPROVED - PR #4 @deadbee\n\nBefore the fix the publish was BLOCKED; it is not now.\n"),
    ("approval reporting its own probe", "### Eta - APPROVED - PR #5 @deadbee\n\nMUST_BLOCK 3/3: each probe BLOCKED as expected.\n"),
    ("approval citing zero false positives", "### Eta - APPROVED - PR #6 @deadbee\n\nzero legitimate forms rejected\n"),
    ("approval citing a rejected count", "### Eta - APPROVED - PR #7 @deadbee\n\n0 legitimate declarations REJECTED\n"),
]

failures: list[str] = []

# --- MUST_PASS: real approval, and the exact line that caused the incident -----
if "REJECTED" not in APPROVED:
    failures.append(
        "fixture no longer contains the measurement label 'REJECTED' - the probe "
        "cannot reproduce the incident and proves nothing"
    )
if not _is_approval(APPROVED):
    failures.append("MUST_PASS real APPROVED comment was refused")

for name, body in SYNTHETIC_PASSES:
    if not _is_approval(body):
        failures.append(f"MUST_PASS {name} was refused")

# --- MUST_BLOCK: real refusal, and every wording of a refusal ------------------
if _is_approval(REVISE):
    failures.append("MUST_BLOCK real REVISE comment was accepted as an approval")

for name, body in SYNTHETIC_BLOCKS:
    if _is_approval(body):
        failures.append(f"MUST_BLOCK {name} was accepted as an approval")

# --- fail closed: no verdict scope means no verdict ---------------------------
if mod.verdict_scope("") != "":
    failures.append("empty body must yield an empty verdict scope")

total = 2 + len(SYNTHETIC_PASSES) + len(SYNTHETIC_BLOCKS) + 1
if failures:
    print(f"FAIL {len(failures)}/{total}")
    for f in failures:
        print("  -", f)
    sys.exit(1)

print(f"PASS {total}/{total} - 0 holes, 0 false positives")
