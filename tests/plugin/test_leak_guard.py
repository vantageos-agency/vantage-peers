"""Leak guard tests — SECRECY > PARITY (Day 130).

The packaged plugin ships in a PUBLIC repo. No packaged artifact may carry
client/person identifiers or internal infrastructure paths. See
scripts/leak_guard.py for the full rationale.
"""

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from leak_guard import (  # noqa: E402
    client_data,
    new_internal_ids,
    packaged_paths,
    repo_wide_baseline,
    scan_file,
    scan_text,
)

# Benign terms that MUST NOT match. A prior fleet purge used substring matching
# and renamed "summaries" because it contains "marie" -- these pin that we do
# word-boundary/token matching, not substrings.
BENIGN_CORPUS = [
    "generate summaries of the day",
    "summaries and standups",
    "client-side rendering only",
    "client delivery timeline",
    "the marinade was ready",
    "a summary of client feedback",
]

# Real leak material. Verbatim from the VR canonical of `session-start`.
LEAKING_CORPUS = [
    '"/root/coding/victor-workspace": ("victor", "victor-vps", "Victor — Iris RH (Marie Parrent)", "project/iris-rh"),',
    '"/home/laurentperello/coding/ElPi Corp": ("pi", "pi-chromebook", ...)',
    '"/root/coding/gaia-workspace": ("gaia", "gaia-vps", "Gaia — (1er client Marie Josée / Mini Mondes)"),',
]


@pytest.mark.parametrize("text", BENIGN_CORPUS)
def test_benign_text_does_not_match(text):
    findings = scan_text(text, "benign")
    assert findings == [], (
        f"FALSE POSITIVE: benign text {text!r} matched "
        f"{[f.pattern for f in findings]}. The guard must use word-boundary "
        "matching, not substrings."
    )


@pytest.mark.parametrize("text", LEAKING_CORPUS)
def test_real_leak_material_is_caught(text):
    findings = scan_text(text, "leak")
    assert findings, f"MISSED LEAK: {text!r} was not flagged"


def test_no_client_data_in_packaged_artifact():
    """TIER 1: no packaged file may carry real client-org / contact-person data.

    Hard block, no baselining, no exceptions. This is the gate that stops a
    resync from importing 'Marie Parrent' / 'Iris RH' into a public package.
    """
    targets = packaged_paths()
    assert targets, (
        "Leak guard enumerated ZERO packaged files. That is a broken parser, "
        "not a clean repo."
    )
    findings = []
    for t in targets:
        findings.extend(client_data(scan_file(t)))
    if findings:
        detail = "\n".join(f"  {f.render()}" for f in findings)
        pytest.fail(f"{len(findings)} CLIENT DATA leak(s) in the PUBLIC package:\n{detail}")


def test_no_new_internal_identifiers():
    """TIER 2: internal ids may not GROW vs the origin/main baseline.

    Pre-existing ones are tracked, not fatal -- failing on day one for state
    already public would make the gate permanently red, and a permanently-red
    gate gets disabled. A NEW one is a regression and fails.
    """
    targets = packaged_paths()
    assert targets, "enumerated ZERO packaged files -- broken parser"
    baseline = repo_wide_baseline()
    regressions = []
    for t in targets:
        regressions.extend(new_internal_ids(scan_file(t), baseline))
    if regressions:
        detail = "\n".join(f"  {f.render()}" for f in regressions)
        pytest.fail(
            f"{len(regressions)} NEW internal identifier(s) vs origin/main:\n{detail}"
        )
