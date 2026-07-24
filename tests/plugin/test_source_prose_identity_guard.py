"""Source-prose identity guard tests — PR #1120 rework of the third-category
guard from PR #1119.

See scripts/source_prose_identity_guard.py for the full design rationale.
Fictitious identities only, resolved via a throwaway host config
(VANTAGE_CLIENT_IDENTITIES) or a throwaway salted-hash vocabulary
(VANTAGE_CLIENT_HASHES) -- never a real client name in this file, ever.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from client_identity_config import (  # noqa: E402
    ClientIdentityConfigError,
    build_hashed_vocabulary,
)
from source_prose_identity_guard import (  # noqa: E402
    ProseExtractionError,
    extract_prose,
    scan_perimeter,
    scan_perimeter_file_prose,
)

FICTIVE_CONFIG = {
    "organizations": ["Zorblatt Holdings"],
    "contacts": ["Zara Quinlin"],
    "commercial_names": ["Quinlex Suite"],
    "aliases": ["fictive-infra-slug-77"],
}


def _write_host_config(tmp_path: Path, data: dict) -> Path:
    path = tmp_path / "fictive-client-identities.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


@pytest.fixture
def hash_vocab():
    return build_hashed_vocabulary(FICTIVE_CONFIG, salt="deadbeef" * 4)


# =============================================================================
# extract_prose: structural scoping — comments + description: literals ONLY.
# =============================================================================


def test_extract_prose_typescript_comments_and_description():
    content = (
        "// a line comment mentioning Zorblatt Holdings\n"
        "/* a block\n   comment about Zara Quinlin */\n"
        "const x = {\n"
        '  description: "Zorblatt Holdings onboarding profile",\n'
        '  profileId: "zorblatt-holdings-hr",\n'
        '  fromAllowList: ["zorblatt-holdings-hr", "zara-quinlin"],\n'
        "};\n"
    )
    prose = extract_prose(content, is_python=False)
    joined = " ".join(text for _line, text in prose)

    assert "Zorblatt Holdings" in joined
    assert "Zara Quinlin" in joined
    # THE STRUCTURAL GUARANTEE: identifier-array/profileId values are never
    # extracted as prose, by construction -- no allowlist involved.
    assert "zorblatt-holdings-hr" not in joined
    assert "zara-quinlin" not in joined


def test_extract_prose_python_docstring_and_hash_comment():
    content = (
        '"""A module docstring about Zorblatt Holdings."""\n'
        "# a hash comment about Zara Quinlin\n"
        'NOT_PROSE = "zorblatt-holdings-hr"\n'
    )
    prose = extract_prose(content, is_python=True)
    joined = " ".join(text for _line, text in prose)
    assert "Zorblatt Holdings" in joined
    assert "Zara Quinlin" in joined
    assert "zorblatt-holdings-hr" not in joined


# =============================================================================
# BITE — a real vocabulary term injected into PROSE is caught, named by
# file:line.
# =============================================================================


def test_bite_fictive_identity_in_comment_is_caught(tmp_path, monkeypatch):
    monkeypatch.setenv(
        "VANTAGE_CLIENT_IDENTITIES", str(_write_host_config(tmp_path, FICTIVE_CONFIG))
    )
    perimeter_dir = tmp_path / "convex"
    perimeter_dir.mkdir()
    leak_file = perimeter_dir / "oauth.ts"
    leak_file.write_text(
        "// onboarding scope for Zorblatt Holdings\n"
        "export const x = 1;\n",
        encoding="utf-8",
    )

    # monkeypatch REPO_ROOT so scan_perimeter_file_prose resolves relative
    # paths against the tmp fixture tree, not the real repo.
    import source_prose_identity_guard as guard_mod

    monkeypatch.setattr(guard_mod, "REPO_ROOT", tmp_path)

    from client_identity_config import resolve_client_data_patterns

    patterns = resolve_client_data_patterns()
    findings = scan_perimeter_file_prose(
        "convex/oauth.ts", plaintext_patterns=patterns
    )
    assert findings, "MISSED LEAK: fictive identity injected into a comment was not flagged"
    assert "convex/oauth.ts:1" in findings[0]


def test_bite_fictive_identity_in_description_literal_is_caught(tmp_path, monkeypatch):
    monkeypatch.setenv(
        "VANTAGE_CLIENT_IDENTITIES", str(_write_host_config(tmp_path, FICTIVE_CONFIG))
    )
    perimeter_dir = tmp_path / "convex"
    perimeter_dir.mkdir()
    leak_file = perimeter_dir / "oauth.ts"
    leak_file.write_text(
        "export const x = {\n"
        '  description: "Zara Quinlin onboarding profile",\n'
        '  profileId: "some-profile",\n'
        "};\n",
        encoding="utf-8",
    )

    import source_prose_identity_guard as guard_mod

    monkeypatch.setattr(guard_mod, "REPO_ROOT", tmp_path)

    from client_identity_config import resolve_client_data_patterns

    patterns = resolve_client_data_patterns()
    findings = scan_perimeter_file_prose(
        "convex/oauth.ts", plaintext_patterns=patterns
    )
    assert findings, "MISSED LEAK: fictive identity in description: literal was not flagged"


def test_restore_clean_after_bite(tmp_path, monkeypatch):
    """The symmetric half of BITE: once the injected term is removed, the
    same file must scan clean."""
    monkeypatch.setenv(
        "VANTAGE_CLIENT_IDENTITIES", str(_write_host_config(tmp_path, FICTIVE_CONFIG))
    )
    perimeter_dir = tmp_path / "convex"
    perimeter_dir.mkdir()
    leak_file = perimeter_dir / "oauth.ts"
    leak_file.write_text("// a clean comment about nothing in particular\n", encoding="utf-8")

    import source_prose_identity_guard as guard_mod

    monkeypatch.setattr(guard_mod, "REPO_ROOT", tmp_path)

    from client_identity_config import resolve_client_data_patterns

    patterns = resolve_client_data_patterns()
    findings = scan_perimeter_file_prose(
        "convex/oauth.ts", plaintext_patterns=patterns
    )
    assert not findings, f"unexpected finding on a clean file: {findings}"


# =============================================================================
# NO FALSE POSITIVE — the exact tension the previous design needed a custom
# matcher for: kebab-case authorization identifiers must never be flagged,
# even though they normalize (hyphen/underscore -> space) to the same n-gram
# as the client name under the canonical matcher's tokenization. Proven here
# via STRUCTURAL SCOPING, not a special matcher.
# =============================================================================


def test_no_false_positive_on_authorization_identifier_slugs(tmp_path, monkeypatch):
    monkeypatch.setenv(
        "VANTAGE_CLIENT_IDENTITIES", str(_write_host_config(tmp_path, FICTIVE_CONFIG))
    )
    perimeter_dir = tmp_path / "convex"
    perimeter_dir.mkdir()
    leak_file = perimeter_dir / "oauth.ts"
    # The authorization identifier slugs derived from the SAME fictive vocabulary
    # (hyphen-joined, exactly the shape hash_matcher_findings' n-gram tokenizer
    # would normalize to the same token as prose "Zorblatt Holdings"/"Zara
    # Quinlin") -- but these live ONLY inside identifier arrays/profileId,
    # never inside a comment or description: literal.
    leak_file.write_text(
        "export const defaults = [\n"
        "  {\n"
        '    profileId: "zorblatt-holdings-hr",\n'
        '    description: "Full admin access for the ops team.",\n'
        '    fromAllowList: ["zorblatt-holdings-hr", "zara-quinlin-hr"],\n'
        "    namespaceReadPrefixes: [\n"
        '      "orchestrator/zorblatt-holdings",\n'
        '      "project/zara-quinlin",\n'
        "    ],\n"
        "    namespaceWritePrefixes: [\n"
        '      "orchestrator/zorblatt-holdings",\n'
        '      "project/zara-quinlin",\n'
        "    ],\n"
        "  },\n"
        "];\n",
        encoding="utf-8",
    )

    import source_prose_identity_guard as guard_mod

    monkeypatch.setattr(guard_mod, "REPO_ROOT", tmp_path)

    from client_identity_config import resolve_client_data_patterns

    patterns = resolve_client_data_patterns()
    findings = scan_perimeter_file_prose(
        "convex/oauth.ts", plaintext_patterns=patterns
    )
    assert not findings, (
        "FALSE POSITIVE: authorization identifier slugs must never be flagged "
        f"by the structural prose scoping, got: {findings}"
    )


def test_no_false_positive_hash_mode(tmp_path, monkeypatch, hash_vocab):
    """Same false-positive pole, exercised through the CI hash matcher --
    this is the exact matcher whose n-gram tokenizer collapses hyphens to
    spaces, so proving it here (and not just in plaintext-regex mode) is the
    load-bearing half."""
    perimeter_dir = tmp_path / "convex"
    perimeter_dir.mkdir()
    leak_file = perimeter_dir / "oauth.ts"
    leak_file.write_text(
        "export const defaults = [\n"
        "  {\n"
        '    profileId: "zorblatt-holdings-hr",\n'
        '    description: "Full admin access for the ops team.",\n'
        '    fromAllowList: ["zorblatt-holdings-hr", "zara-quinlin-hr"],\n'
        "  },\n"
        "];\n",
        encoding="utf-8",
    )

    import source_prose_identity_guard as guard_mod

    monkeypatch.setattr(guard_mod, "REPO_ROOT", tmp_path)

    findings = scan_perimeter_file_prose("convex/oauth.ts", hash_vocab=hash_vocab)
    assert not findings, (
        f"FALSE POSITIVE in hash-mode structural scoping: {findings}"
    )


def test_bite_hash_mode_catches_prose_leak(tmp_path, monkeypatch, hash_vocab):
    """The BITE pole in hash (CI) mode: same fictive identity, injected into
    prose, must still be caught when resolved via VANTAGE_CLIENT_HASHES."""
    perimeter_dir = tmp_path / "convex"
    perimeter_dir.mkdir()
    leak_file = perimeter_dir / "oauth.ts"
    leak_file.write_text(
        "// onboarding scope for Zorblatt Holdings\n"
        "export const x = 1;\n",
        encoding="utf-8",
    )

    import source_prose_identity_guard as guard_mod

    monkeypatch.setattr(guard_mod, "REPO_ROOT", tmp_path)

    findings = scan_perimeter_file_prose("convex/oauth.ts", hash_vocab=hash_vocab)
    assert findings, "MISSED LEAK in hash mode: fictive prose identity not flagged"


# =============================================================================
# FAIL-LOUD — unresolvable vocabulary must error, never silently pass green.
# =============================================================================


def test_scan_perimeter_file_prose_missing_file_fails_loud(tmp_path, monkeypatch):
    import source_prose_identity_guard as guard_mod

    monkeypatch.setattr(guard_mod, "REPO_ROOT", tmp_path)
    with pytest.raises(ProseExtractionError, match="could not be read"):
        scan_perimeter_file_prose("convex/does-not-exist.ts", plaintext_patterns=[])


def test_main_fails_loud_when_neither_vocabulary_source_resolves(tmp_path, monkeypatch):
    monkeypatch.delenv("VANTAGE_CLIENT_IDENTITIES", raising=False)
    monkeypatch.delenv("VANTAGE_CLIENT_HASHES", raising=False)
    monkeypatch.setenv(
        "VANTAGE_CLIENT_IDENTITIES", str(tmp_path / "no-such-home" / "does-not-exist.json")
    )

    import source_prose_identity_guard as guard_mod

    exit_code = guard_mod.main()
    assert exit_code == 2


# =============================================================================
# CI-MODE activation proof — the actual defect this rework fixes: the guard
# resolves and runs when VANTAGE_CLIENT_HASHES is set and no host file is
# readable, mirroring the real CI runner environment.
# =============================================================================


def test_ci_mode_resolves_via_hash_secret_with_no_host_file(tmp_path, monkeypatch):
    monkeypatch.delenv("VANTAGE_CLIENT_IDENTITIES", raising=False)
    monkeypatch.setenv(
        "VANTAGE_CLIENT_IDENTITIES", str(tmp_path / "no-such-home" / "does-not-exist.json")
    )

    vocab = build_hashed_vocabulary(FICTIVE_CONFIG, salt="deadbeef" * 4)
    monkeypatch.setenv("VANTAGE_CLIENT_HASHES", json.dumps(vocab))

    perimeter_dir = tmp_path / "convex"
    perimeter_dir.mkdir()
    (perimeter_dir / "oauth.ts").write_text(
        "// a clean comment, no client identity here\n", encoding="utf-8"
    )
    (perimeter_dir / "schema.ts").write_text(
        "// another clean comment\n", encoding="utf-8"
    )
    migrations_dir = perimeter_dir / "migrations"
    migrations_dir.mkdir()
    (migrations_dir / "patch_marie_iris_rh_scope.ts").write_text(
        "// clean\n", encoding="utf-8"
    )
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "source_prose_identity_guard.py").write_text(
        "# clean\n", encoding="utf-8"
    )

    import source_prose_identity_guard as guard_mod

    monkeypatch.setattr(guard_mod, "REPO_ROOT", tmp_path)

    from client_identity_config import resolve_vocabulary_or_fail

    vocab_mode, resolved_vocab = resolve_vocabulary_or_fail()
    assert vocab_mode == "hashes", (
        "CI-MODE activation proof failed: expected hash-vocabulary resolution "
        f"with no host file readable, got mode={vocab_mode!r}"
    )

    findings = scan_perimeter(hash_vocab=resolved_vocab)
    assert findings == []
