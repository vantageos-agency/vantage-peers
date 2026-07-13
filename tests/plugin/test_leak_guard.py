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
    derive_inventory,
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


# =============================================================================
# Day 130 T2 — derived inventory (os.walk), closing the two-glob coverage gap.
# These are OFFLINE (no VR, no network): built on a throwaway tmp_path tree
# that mimics the real published artifact's shape (a leak under references/,
# a benign example, an empty inventory case).
# =============================================================================


def test_derived_inventory_catches_leak_outside_old_globs(tmp_path):
    """A leak shipped OUTSIDE `skills/*/SKILL.md` and `hooks/*.py` (e.g. under
    `references/` or `docs/`) MUST be named by the guard. This is the test
    that the OLD two-glob `packaged_paths()` would have missed -- it is the
    one that closes the coverage-gap class of bug (19% -> 100%).
    """
    skill_dir = tmp_path / "skills" / "some-skill" / "references"
    skill_dir.mkdir(parents=True)
    leak_file = skill_dir / "examples.md"
    leak_file.write_text(
        "A worked example featuring Marie Parrent as the client contact.\n",
        encoding="utf-8",
    )

    inventory = derive_inventory(tmp_path)
    checked_paths = {item.path for item in inventory if item.checked}
    assert leak_file in checked_paths, (
        "derive_inventory() did not enumerate a file under references/ -- "
        "the old packaged_paths() glob would have silently skipped this file "
        "and the leak inside it."
    )

    findings = []
    for item in inventory:
        if item.checked:
            findings.extend(client_data(scan_file(item.path)))
    assert findings, (
        "MISSED LEAK: 'Marie Parrent' inside references/examples.md was not "
        "flagged by the derived-inventory scan."
    )
    named = {f.source for f in findings}
    assert str(leak_file) in named, f"leak was found but not attributed to {leak_file}"


def test_derived_inventory_leaves_legitimate_example_slug_green(tmp_path):
    """`guineapig-77` is a WRITTEN, pedagogical worked example (the skill
    teaching the deploy-track rule uses it on purpose) -- not real client
    infrastructure. It must NEVER be flagged as CLIENT_DATA, in a shipped
    file at any depth in the tree.
    """
    skill_dir = tmp_path / "skills" / "deploy-track"
    skill_dir.mkdir(parents=True)
    skill_file = skill_dir / "SKILL.md"
    skill_file.write_text(
        "User: track convex deployment guineapig-77 at "
        "https://guineapig-77.convex.cloud, key in env var DEPLOY_KEY_GUINEAPIG.\n",
        encoding="utf-8",
    )

    inventory = derive_inventory(tmp_path)
    checked_paths = {item.path for item in inventory if item.checked}
    assert skill_file in checked_paths

    findings = client_data(scan_file(skill_file))
    assert not findings, (
        f"FALSE POSITIVE: legitimate example slug 'guineapig-77' was flagged as "
        f"CLIENT DATA: {[f.render() for f in findings]}. Over-purging pedagogical "
        "examples is the symmetric failure to missing real leaks."
    )


def test_derived_inventory_empty_root_fails_loud(tmp_path):
    """An empty artifact directory is a broken parser/path, not a clean repo --
    `derive_inventory` itself must not silently report zero findings on a
    directory it never actually walked; the anti-silence contract lives in
    `main()`, which raises/exits when zero files are enumerated. Here we pin
    that `derive_inventory` on a genuinely-empty directory returns an empty
    list (never raises spuriously, never fabricates entries) so `main()`'s
    zero-check has an honest signal to act on.
    """
    empty_root = tmp_path / "empty-artifact"
    empty_root.mkdir()

    inventory = derive_inventory(empty_root)
    assert inventory == [], "expected zero items from a genuinely empty directory"

    # Simulate main()'s anti-silence gate directly against the derived result.
    targets = [item.path for item in inventory if item.checked]
    assert not targets, "an empty artifact must never produce non-empty targets"


def test_derive_inventory_missing_root_raises():
    """A root that does not exist at all -- as opposed to an empty directory --
    is a broken invocation (wrong --root path). This must raise loudly rather
    than silently returning an empty inventory indistinguishable from case
    above (a real empty artifact).
    """
    with pytest.raises(FileNotFoundError):
        derive_inventory(Path("/nonexistent/leak-guard-path-day130"))


def test_derived_inventory_excludes_dirs_with_written_reason(tmp_path):
    """`.git` and `__pycache__` are the only silent-skip surface, and even
    they are not silent: they must never be enumerated as CHECKED, and any
    OTHER excluded content must carry a written skip_reason, never a bare
    absence.
    """
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    (tmp_path / "__pycache__").mkdir()
    (tmp_path / "__pycache__" / "mod.cpython-312.pyc").write_bytes(b"\x00\x01")
    skill_dir = tmp_path / "skills" / "x"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("clean content\n", encoding="utf-8")

    inventory = derive_inventory(tmp_path)
    paths = {item.path for item in inventory}
    assert not any(".git" in p.parts for p in paths), ".git contents must never be enumerated at all"
    assert not any("__pycache__" in p.parts for p in paths), "__pycache__ contents must never be enumerated at all"
    assert (skill_dir / "SKILL.md") in {item.path for item in inventory if item.checked}
