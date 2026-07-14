"""Leak guard tests — SECRECY > PARITY (Day 130).

The packaged plugin ships in a PUBLIC repo. No packaged artifact may carry
client/person identifiers or internal infrastructure paths. See
scripts/leak_guard.py for the full rationale.
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from leak_guard import (  # noqa: E402
    BaselineUnresolvableError,
    scan_baseline,
    client_data,
    derive_inventory,
    new_internal_ids,
    packaged_paths,
    repo_wide_baseline,
    scan_file,
    scan_text,
)
from client_identity_config import (  # noqa: E402
    ClientIdentityConfigError,
    derive_organizations_from_bu_registry,
    load_raw_config,
    resolve_client_data_patterns,
    resolve_config_path,
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

# =============================================================================
# TIER 1 corpus — DERIVED from the REAL host-side client-identity config at
# TEST-EXECUTION TIME, never written verbatim in this tracked file.
#
# Describing a leak by reproducing it IS re-publishing it. So this file
# carries zero real client names/orgs in its own source. Instead, at runtime,
# `real_client_identities` loads the actual host config (the same one
# `leak_guard.main()` resolves in CI/prod) and `_synthesize_leak_lines`
# stitches its real tokens into realistic "identity table row" style
# sentences -- the same shape as the VR `session-start` canonical this guard
# exists to catch. The guard is proven against genuine client material this
# way, with the material itself never landing in git history.
#
# If the host config cannot be resolved (missing/empty/malformed), the
# fixture below RAISES -- these tests then ERROR, loudly, in the pytest
# summary. They are never `skip`: a skipped test is a silent green that is
# indistinguishable from "the guard works", which is exactly the failure
# mode this whole effort exists to eliminate.
# =============================================================================


@pytest.fixture(scope="module")
def real_client_identities():
    """The REAL, resolved host-side client-identity config dict.

    Loaded once per test module run. Raises `ClientIdentityConfigError` (via
    `load_raw_config`) if the host config is missing/empty/malformed -- that
    failure propagates as a pytest fixture ERROR, never a skip.
    """
    return load_raw_config(resolve_config_path())


@pytest.fixture(scope="module")
def real_client_patterns():
    """The REAL, resolved (regex, reason) client-data patterns -- same call
    `leak_guard.main()` makes. Raises loudly if unresolvable (see above)."""
    return resolve_client_data_patterns()


def _synthesize_leak_lines(identities: dict) -> list[str]:
    """Stitch REAL tokens from the resolved host config into realistic
    'identity table row' style sentences, entirely at execution time.

    Mirrors the shape of the VR `session-start` canonical this guard exists
    to catch (an internal workspace path paired with a real org/contact
    pair) -- without ever writing a real name into this tracked source file.
    Returns an empty list only if the config itself carries none of the
    fields it can synthesize from; the caller asserts non-emptiness.
    """
    lines: list[str] = []
    orgs = identities.get("organizations") or []
    contacts = identities.get("contacts") or []
    commercial = identities.get("commercial_names") or []
    aliases = identities.get("aliases") or []

    if orgs:
        org = orgs[0]
        contact = contacts[0] if contacts else "the client contact"
        lines.append(
            f'"/root/coding/example-workspace": ("example", "example-vps", '
            f'"Example — {org} ({contact})", "project/example"),'
        )
    if contacts:
        lines.append(f"Onboarding notes for contact {contacts[-1]}.")
    if commercial:
        lines.append(f"Product line reference in a stray doc: {commercial[0]}.")
    if aliases:
        lines.append(f"Infra alias mentioned in passing: {aliases[0]}.")

    return lines


@pytest.fixture(scope="module")
def leaking_corpus(real_client_identities):
    lines = _synthesize_leak_lines(real_client_identities)
    assert lines, (
        "host config resolved but produced ZERO synthesizable leak lines -- "
        "the config has no organizations/contacts/commercial_names/aliases "
        "to build a fixture from."
    )
    return lines


@pytest.mark.parametrize("text", BENIGN_CORPUS)
def test_benign_text_does_not_match(text):
    findings = scan_text(text, "benign")
    assert findings == [], (
        f"FALSE POSITIVE: benign text {text!r} matched "
        f"{[f.pattern for f in findings]}. The guard must use word-boundary "
        "matching, not substrings."
    )


def test_real_leak_material_is_caught(leaking_corpus, real_client_patterns):
    """The guard must flag sentences built from the REAL, resolved
    client-identity vocabulary -- proving it catches genuine client material
    without this file ever republishing that material verbatim."""
    for text in leaking_corpus:
        findings = scan_text(text, "leak", extra_client_patterns=real_client_patterns)
        assert findings, f"MISSED LEAK: a synthesized real-vocabulary line was not flagged: {text!r}"


def test_real_leak_material_is_not_caught_without_resolved_patterns(leaking_corpus):
    """PROOF THE GUARD ACTUALLY BITES (and isn't trivially green): the same
    synthesized real-vocabulary lines, scanned WITHOUT the resolved client
    patterns merged in, must NOT be universally flagged by the historical
    literal CLIENT_DATA_PATTERNS alone -- because as of Day 130 that literal
    set carries no client-org/contact entries at all (see leak_guard.py).
    A guard that reports these as caught either way would mean the resolved
    vocabulary is decorative, not load-bearing.
    """
    for text in leaking_corpus:
        findings = client_data(scan_text(text, "leak"))
        assert not findings, (
            "unexpected: a synthesized line matched WITHOUT the resolved "
            "client vocabulary -- a stale literal client entry may have "
            "leaked back into CLIENT_DATA_PATTERNS in leak_guard.py"
        )


def test_no_client_data_in_packaged_artifact(real_client_patterns):
    """TIER 1: no packaged file may carry real client-org / contact-person data.

    Hard block, no baselining, no exceptions. This is the gate that stops a
    resync from importing the real host-config client vocabulary into a
    public package. Scanned with the RESOLVED patterns merged in -- the
    literal CLIENT_DATA_PATTERNS in leak_guard.py carries no client entries
    by design (Day 130), so this tier only has teeth via the resolved config.
    """
    targets = packaged_paths()
    assert targets, (
        "Leak guard enumerated ZERO packaged files. That is a broken parser, "
        "not a clean repo."
    )
    findings = []
    for t in targets:
        findings.extend(client_data(scan_file(t, extra_client_patterns=real_client_patterns)))
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

    Purely structural (inventory coverage), so a FICTITIOUS identity via a
    throwaway config is sufficient -- no real client material needed here.
    """
    cfg_path = _write_config(tmp_path, FICTIVE_CONFIG)
    patterns = resolve_client_data_patterns(path=cfg_path)

    skill_dir = tmp_path / "pkg" / "skills" / "some-skill" / "references"
    skill_dir.mkdir(parents=True)
    leak_file = skill_dir / "examples.md"
    leak_file.write_text(
        "A worked example featuring Zorblatt Holdings as the client contact.\n",
        encoding="utf-8",
    )

    inventory = derive_inventory(tmp_path / "pkg")
    checked_paths = {item.path for item in inventory if item.checked}
    assert leak_file in checked_paths, (
        "derive_inventory() did not enumerate a file under references/ -- "
        "the old packaged_paths() glob would have silently skipped this file "
        "and the leak inside it."
    )

    findings = []
    for item in inventory:
        if item.checked:
            findings.extend(client_data(scan_file(item.path, extra_client_patterns=patterns)))
    assert findings, (
        "MISSED LEAK: fictitious 'Zorblatt Holdings' inside references/examples.md "
        "was not flagged by the derived-inventory scan."
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
    """`.git` is excluded. `__pycache__` is NOT — and that reversal is the point.

    This test used to assert the opposite: that `__pycache__` contents "must
    never be enumerated at all", on the stated ground that bytecode is "not
    source, never shipped". Both halves were false. The .pyc was committed AND
    published, and `strings` on its bytecode returned six client-name hits. The
    exclusion was not a safe optimisation, it was the hiding place — and this
    test was pinning it there.

    An exclusion is a CLAIM ABOUT REALITY. When the claim is wrong, the guard
    goes blind exactly where the leak is. So a __pycache__ inside a shipped tree
    is now enumerated and scanned like anything else; its presence is itself a
    finding, not a reason to look away.
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
    assert any("__pycache__" in p.parts for p in paths), (
        "a __pycache__ sitting in a shipped tree MUST be enumerated — skipping it "
        "is how a .pyc carrying purged identifiers in its bytecode goes unseen"
    )
    assert (skill_dir / "SKILL.md") in {item.path for item in inventory if item.checked}


def test_leak_inside_compiled_bytecode_is_caught(tmp_path, monkeypatch):
    """A client identity surviving in a .pyc's bytecode must be FOUND.

    Purging a name from the SOURCE does not remove it from a compiled artifact:
    string constants live on in bytecode. This is the case that was live on the
    public repo — the leak guard's own .pyc, published, carrying the very
    identifiers the guard exists to catch, invisible to it because it refused to
    open binary files. Fictitious identity only.
    """
    cfg = tmp_path / "identities.json"
    cfg.write_text(json.dumps({
        "organizations": ["Zorblatt Holdings"], "contacts": [], "commercial_names": [], "aliases": [],
    }), encoding="utf-8")
    monkeypatch.setenv("VANTAGE_CLIENT_IDENTITIES", str(cfg))

    pkg = tmp_path / "pkg"
    (pkg / "__pycache__").mkdir(parents=True)
    # A real .pyc is a binary container with UTF-8 string constants inside.
    (pkg / "__pycache__" / "mod.cpython-312.pyc").write_bytes(
        b"\xcb\x0d\x0d\x0a\x00\x00\x00\x00" + b"Zorblatt Holdings" + b"\x00\x01\x02\xff"
    )

    findings = [f for item in derive_inventory(pkg) if item.checked
                for f in scan_file(item.path, extra_client_patterns=resolve_client_data_patterns())]
    assert any(f.category == "CLIENT_DATA" for f in findings), (
        "a client identity embedded in compiled bytecode must be caught — "
        "a guard that cannot read what it ships cannot vouch for it"
    )
    assert any(".pyc" in f.source for f in findings), "the finding must NAME the .pyc"


# =============================================================================
# Day 130 T? — host-resolved client vocabulary. Eta review (PR #1090) found the
# hand-typed CLIENT_DATA_PATTERNS list missing an ACTIVE client identity: a
# guard that prints PASSED without ever having resolved a client vocabulary is
# worse than no guard. These tests are 100% OFFLINE and use ONLY FICTITIOUS
# identities via a throwaway tmp_path config -- never a real client name.
# =============================================================================

FICTIVE_CONFIG = {
    "organizations": ["Zorblatt Holdings"],
    "contacts": ["Zara Quinlin"],
    "commercial_names": [],
    "aliases": ["FICTIVE_PERSON_ZARA_QUINLIN"],
}


def _write_config(tmp_path, data):
    import json

    path = tmp_path / "fictive-client-identities.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def test_missing_config_fails_loud_not_passed(tmp_path):
    """THE test that proves the guard can no longer lie: an absent config must
    raise, never silently resolve to zero patterns (which would look identical
    to 'the package is clean')."""
    missing = tmp_path / "does-not-exist.json"
    with pytest.raises(ClientIdentityConfigError, match=r"not found"):
        load_raw_config(missing)


def test_empty_config_fails_loud(tmp_path):
    empty = tmp_path / "empty.json"
    empty.write_text("", encoding="utf-8")
    with pytest.raises(ClientIdentityConfigError, match=r"EMPTY"):
        load_raw_config(empty)

    # A config with all-empty lists (valid JSON, zero identities) must also
    # fail loud -- zero identities is indistinguishable from a broken config.
    zero_identities = tmp_path / "zero.json"
    zero_identities.write_text(
        '{"organizations": [], "contacts": [], "commercial_names": [], "aliases": []}',
        encoding="utf-8",
    )
    with pytest.raises(ClientIdentityConfigError, match=r"ZERO identities"):
        load_raw_config(zero_identities)


def test_malformed_config_fails_loud(tmp_path):
    bad_json = tmp_path / "bad.json"
    bad_json.write_text("{not valid json", encoding="utf-8")
    with pytest.raises(ClientIdentityConfigError, match=r"not valid JSON"):
        load_raw_config(bad_json)

    missing_key = tmp_path / "missing-key.json"
    missing_key.write_text('{"organizations": ["x"]}', encoding="utf-8")
    with pytest.raises(ClientIdentityConfigError, match=r"missing required key"):
        load_raw_config(missing_key)


def test_resolved_fictive_identity_caught_outside_old_globs(tmp_path):
    """A FICTITIOUS identity resolved from a throwaway config, shipped in a
    file OUTSIDE the old two-glob surface (under docs/), must be caught and
    NAMED with its file + line. This is the test that proves the vocabulary
    is actually RESOLVED and used, not just documented."""
    cfg_path = _write_config(tmp_path, FICTIVE_CONFIG)
    patterns = resolve_client_data_patterns(path=cfg_path)

    leak_dir = tmp_path / "pkg" / "docs"
    leak_dir.mkdir(parents=True)
    leak_file = leak_dir / "example.md"
    leak_file.write_text(
        "A worked example featuring Zorblatt Holdings as the client contact.\n",
        encoding="utf-8",
    )

    findings = client_data(scan_file(leak_file, extra_client_patterns=patterns))
    assert findings, "MISSED LEAK: fictitious resolved-config identity was not flagged"
    assert findings[0].source == str(leak_file)
    assert findings[0].line_no == 1


def test_resolved_fictive_identity_caught_in_skill_references(tmp_path):
    """Same fictitious identity, this time under skills/*/references/ -- the
    second surface Eta's probes hit."""
    cfg_path = _write_config(tmp_path, FICTIVE_CONFIG)
    patterns = resolve_client_data_patterns(path=cfg_path)

    ref_dir = tmp_path / "pkg" / "skills" / "some-skill" / "references"
    ref_dir.mkdir(parents=True)
    leak_file = ref_dir / "notes.md"
    leak_file.write_text(
        "Onboarding notes for contact Zara Quinlin.\n", encoding="utf-8"
    )

    findings = client_data(scan_file(leak_file, extra_client_patterns=patterns))
    assert findings, "MISSED LEAK: fictitious resolved-config contact name was not flagged"


def test_resolved_client_patterns_do_not_flag_legitimate_example(tmp_path):
    """Zero false positives: a legitimate pedagogical example (guineapig-77,
    DEPLOY_KEY_GUINEAPIG) must stay green even with a resolved client
    vocabulary merged in. Over-purging is the symmetric failure to missing
    real leaks."""
    cfg_path = _write_config(tmp_path, FICTIVE_CONFIG)
    patterns = resolve_client_data_patterns(path=cfg_path)

    skill_dir = tmp_path / "pkg" / "skills" / "deploy-track"
    skill_dir.mkdir(parents=True)
    skill_file = skill_dir / "SKILL.md"
    skill_file.write_text(
        "User: track convex deployment guineapig-77 at "
        "https://guineapig-77.convex.cloud, key in env var DEPLOY_KEY_GUINEAPIG.\n",
        encoding="utf-8",
    )

    findings = client_data(scan_file(skill_file, extra_client_patterns=patterns))
    assert not findings, (
        f"FALSE POSITIVE with resolved client vocabulary merged in: "
        f"{[f.render() for f in findings]}"
    )


def test_build_client_data_patterns_rejects_blank_entry(tmp_path):
    cfg_path = _write_config(
        tmp_path,
        {"organizations": ["  "], "contacts": [], "commercial_names": [], "aliases": []},
    )
    with pytest.raises(ClientIdentityConfigError):
        load_raw_config(cfg_path)


def test_derive_organizations_from_bu_registry_is_supplementary_only():
    """The BU registry can only ever supply ElPi Corp's OWN product/BU names
    (schema has no client-org/contact field) -- this pins that the helper does
    exactly that and nothing more, so it can never be mistaken for a
    substitute for the host client-identity config."""
    bu_entries = [
        {"name": "VantagePeers", "orchestratorId": "sigma"},
        {"name": "VantageRegistry", "orchestratorId": "pi"},
        {"orchestratorId": "no-name-field"},
    ]
    names = derive_organizations_from_bu_registry(bu_entries)
    assert names == ["VantagePeers", "VantageRegistry"]
    # None of these are client org/contact names -- the function's docstring
    # is the load-bearing artifact here, not a runtime assertion, but this
    # pins that it never fabricates a name it wasn't given.
    assert "Zorblatt Holdings" not in names


def test_unresolvable_baseline_ref_fails_loud_never_empty(tmp_path):
    """An unresolvable baseline ref must RAISE, never yield an empty baseline.

    scan_baseline() used to treat ANY `git show` failure as "file absent from
    the baseline -> born-clean rule". That collapsed two different facts:

      (a) the ref resolves and the FILE is new        -> empty baseline is right
      (b) THE REF ITSELF does not resolve (fresh CI clone, shallow clone)
                                                       -> EVERY baseline empty

    Under (b) every already-public identifier is reported as a brand-new
    regression. That is exactly what turned a green local run into a CI failure
    claiming "29 NEW internal identifier(s)" against files the branch never
    touched -- and it is the same defect class this guard exists to prosecute,
    committed by the guard itself: "I could not read the baseline" and "the
    baseline is empty" printed the same thing.
    """
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    f = repo / "packaged.md"
    f.write_text("workspace: /home/laurentperello/coding/x\n", encoding="utf-8")

    with pytest.raises(BaselineUnresolvableError) as exc:
        scan_baseline(f, ref="origin/nope", git_root=repo)

    msg = str(exc.value)
    assert "does not resolve" in msg, "the failure must NAME what it could not resolve"
    assert "origin/nope" in msg
