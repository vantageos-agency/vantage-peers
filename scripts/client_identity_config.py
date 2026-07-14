#!/usr/bin/env python3
"""Host-side client identity vocabulary — resolved, never hardcoded, never silent.

Day 130 finding (Eta review, PR #1090): the leak guard's TIER 1 client-data
vocabulary was hand-typed into `leak_guard.py`. A real, ACTIVE client identity
was absent from that hand-typed list, so the guard printed `LEAK GUARD PASSED`
on a package that shipped the client's NAME while correctly blocking an
unrelated infra slug. A hand-typed vocabulary rots at every new client: the
next one is always the one nobody remembered to add, and the guard keeps
printing PASSED through the gap it cannot see.

THE FIX: the client-data vocabulary is RESOLVED at run time from a config
file that lives OUTSIDE any repo and OUTSIDE any packaged artifact --
`VANTAGE_CLIENT_IDENTITIES` env var, defaulting to
`~/.claude/vantage-client-identities.json`. This module never ships that
file's content anywhere -- it only reads it. If the config is missing,
unreadable, malformed, or resolves to zero identities, resolution FAILS
LOUDLY (raises `ClientIdentityConfigError`, naming exactly what could not be
resolved). The caller (`leak_guard.main()`) MUST treat that as a hard,
un-passable failure: "I could not resolve the client vocabulary" and "the
package is clean" are DIFFERENT outcomes and must never look the same on
stdout/exit code. A guard that reports PASSED when it never actually
resolved its own vocabulary is worse than no guard: it manufactures false
assurance about exactly the thing it claims to protect.

CONFIG SCHEMA (JSON object, all four keys required, each a list of strings):

    {
      "organizations":     ["Real Client Org Name", ...],
      "contacts":          ["Real Contact Person Name", ...],
      "commercial_names":  ["Real Product/Commercial Name", ...],
      "aliases":           ["real-infra-slug-not-expressible-as-a-BU-name", ...]
    }

  - organizations:    third-party client org names.
  - contacts:         real people who are client contacts (not ElPi Corp staff).
  - commercial_names:  client-facing brand/product names distinct from the org
                       name (e.g. a client's own product line).
  - aliases:           anything else identifying a specific client that is not
                       expressible as any of the above -- e.g. a live production
                       infra slug, a client-owned domain, a project codename.
                       This is the escape hatch for the class of finding Day 130
                       actually hit (a Convex deployment slug, not an org/person
                       name) -- see `derive_organizations_from_bu_registry` below
                       for why this key can never be auto-derived.

  At least one identity total (across all four keys) is required -- an empty
  config is indistinguishable from a broken one and is rejected the same way
  as a missing file.

WHAT THIS MODULE NEVER DOES: it never writes, logs, prints, or returns the
raw config content in a way callers should surface verbatim in a public
place. `leak_guard.py` only ever emits the *pattern* and a generic *reason*
string per finding (see `LeakFinding.render()`), never the literal config
file content.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
from pathlib import Path

CLIENT_IDENTITIES_ENV = "VANTAGE_CLIENT_IDENTITIES"
DEFAULT_CLIENT_IDENTITIES_PATH = Path.home() / ".claude" / "vantage-client-identities.json"

# --- CI vocabulary source: salted hashes, never the plaintext ---------------
# Day 130 v2: the plaintext host config (`VANTAGE_CLIENT_IDENTITIES`) is
# deliberately absent from the GitHub Actions runner -- we will not transport
# client names off the operator's machine, encrypted secret or not: WE DO NOT
# TRANSPORT THE SECRET TO PROVE WE DETECT IT. Instead CI is handed a set of
# salted SHA-256 hashes of the (normalized) identity vocabulary via
# `VANTAGE_CLIENT_HASHES` (a JSON *value*, not a path -- lives in a GitHub
# Actions secret). The guard matches by hashing candidate n-grams from the
# scanned text with the SAME salt and comparing hash sets -- it never needs,
# and never sees, the plaintext name in CI.
CLIENT_HASHES_ENV = "VANTAGE_CLIENT_HASHES"
_HASH_VOCAB_REQUIRED_KEYS = ("algo", "salt", "hashes")
_NORMALIZE_SEPARATORS_RE = re.compile(r"[\s\-_]+")


def normalize_identity_token(token: str) -> str:
    """Normalize an identity token for hashing/matching: lowercase, collapse
    every run of whitespace/hyphen/underscore into a single space, trim.

    This is the SAME normalization on both sides of the hash comparison (the
    vocabulary side in `build_hashed_vocabulary` and the candidate side in
    `hash_matcher_findings`) -- so "Acme Corp", "acme-corp", and "acme_corp"
    all normalize to "acme corp" and hash identically. This is the hashed
    counterpart of the regex guard's `[\\s\\-_]+` separator class.
    """
    collapsed = _NORMALIZE_SEPARATORS_RE.sub(" ", token.strip().lower())
    return collapsed.strip()


def _hash_token(token: str, salt: str) -> str:
    return hashlib.sha256((salt + token).encode("utf-8")).hexdigest()


def build_hashed_vocabulary(config: dict, salt: str | None = None) -> dict:
    """Build a salted-hash vocabulary from a plaintext host config dict.

    Every identity across `REQUIRED_LIST_KEYS` (organizations, contacts,
    commercial_names, aliases) is normalized (see `normalize_identity_token`)
    and hashed with SHA-256 + the given (or freshly generated) salt. Returns
    `{"algo": "sha256", "salt": <hex>, "hashes": [<hex>, ...]}` -- this dict
    contains NO plaintext identity, by construction: only normalized tokens
    ever reach the hash function, and only the hash digest is returned.

    `salt` is provided by the caller when reproducibility across runs is
    needed (e.g. to regenerate the same hash set); when omitted, a fresh
    cryptographically random 32-byte salt is generated and returned in the
    output so the caller can persist it if desired.
    """
    salt = salt if salt is not None else secrets.token_hex(32)
    hashes: set[str] = set()
    for key in REQUIRED_LIST_KEYS:
        for token in config.get(key, []) or []:
            normalized = normalize_identity_token(str(token))
            if normalized:
                hashes.add(_hash_token(normalized, salt))
    return {"algo": "sha256", "salt": salt, "hashes": sorted(hashes)}


def resolve_client_hash_vocabulary() -> dict | None:
    """Read + validate the CI hash vocabulary from `VANTAGE_CLIENT_HASHES`
    (a JSON *value* -- direct env content, never a file path).

    Returns None if the env var is absent (caller falls back to another
    source). Raises `ClientIdentityConfigError` if it IS present but
    malformed -- a present-but-broken CI secret must never be silently
    treated as "no vocabulary here, try elsewhere", the same anti-silence
    discipline as the plaintext config path.
    """
    raw = os.environ.get(CLIENT_HASHES_ENV)
    if raw is None or not raw.strip():
        return None

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ClientIdentityConfigError(
            f"{CLIENT_HASHES_ENV} is set but is not valid JSON: {exc}"
        ) from exc

    if not isinstance(data, dict):
        raise ClientIdentityConfigError(
            f"{CLIENT_HASHES_ENV} must be a JSON object with keys "
            f"{_HASH_VOCAB_REQUIRED_KEYS}, got a {type(data).__name__}."
        )

    for key in _HASH_VOCAB_REQUIRED_KEYS:
        if key not in data:
            raise ClientIdentityConfigError(
                f"{CLIENT_HASHES_ENV} is missing required key {key!r}. Schema "
                f"requires all of {_HASH_VOCAB_REQUIRED_KEYS}."
            )

    if data.get("algo") != "sha256":
        raise ClientIdentityConfigError(
            f"{CLIENT_HASHES_ENV} has unsupported algo {data.get('algo')!r}; "
            "only 'sha256' is supported."
        )
    if not isinstance(data.get("salt"), str) or not data["salt"].strip():
        raise ClientIdentityConfigError(
            f"{CLIENT_HASHES_ENV}['salt'] must be a non-empty string."
        )
    hashes = data.get("hashes")
    if not isinstance(hashes, list) or not hashes:
        raise ClientIdentityConfigError(
            f"{CLIENT_HASHES_ENV}['hashes'] must be a non-empty list -- an "
            "empty hash vocabulary is indistinguishable from a broken one and "
            "is rejected the same way as a missing plaintext config."
        )
    for i, h in enumerate(hashes):
        if not isinstance(h, str) or not h.strip():
            raise ClientIdentityConfigError(
                f"{CLIENT_HASHES_ENV}['hashes'][{i}] must be a non-empty string, "
                f"got {h!r}."
            )

    return {"algo": "sha256", "salt": data["salt"], "hashes": list(hashes)}


# N-gram tokenizer for hash matching: mirrors the word-boundary discipline of
# the regex guard, but works over 1-4 word windows so a multi-word identity
# ("Acme Corp Holdings") can be matched without needing a pre-known token
# count. Separators mirror leak_guard's own text-splitting character class.
_NGRAM_SPLIT_RE = re.compile(r"[\s\-_/.,:;()\[\]{}\"'`]+")
_MAX_NGRAM_WORDS = 4


def hash_matcher_findings(text: str, vocab: dict) -> list[tuple[str, str]]:
    """Scan `text` for tokens whose normalized+salted hash appears in `vocab`.

    Returns a list of (line_repr, reason) pairs -- NEVER the matched
    plaintext n-gram itself (that would defeat the entire point of hash
    matching: the whole design exists so the matched name never has to be
    known or displayed by the CI-side matcher). `line_repr` is a generic,
    non-identifying marker; callers (leak_guard.py) are responsible for
    pairing this with file/line context without echoing the raw n-gram.

    Tokenization: word-boundary split (mirrors the regex guard's separator
    class), 1-to-4-word sliding n-grams, each normalized identically to
    `build_hashed_vocabulary` before hashing -- so "Acme-Corp", "acme_corp",
    and "Acme  Corp" all resolve to the same hash regardless of which
    separator variant appears in the scanned text.
    """
    algo = vocab.get("algo")
    if algo != "sha256":
        raise ClientIdentityConfigError(f"unsupported hash vocabulary algo {algo!r}")
    salt = vocab["salt"]
    hash_set = set(vocab["hashes"])

    words = [w for w in _NGRAM_SPLIT_RE.split(text) if w]
    findings: list[tuple[str, str]] = []
    seen: set[int] = set()
    for start in range(len(words)):
        for n in range(1, _MAX_NGRAM_WORDS + 1):
            end = start + n
            if end > len(words):
                break
            ngram = " ".join(words[start:end])
            normalized = normalize_identity_token(ngram)
            if not normalized:
                continue
            digest = _hash_token(normalized, salt)
            if digest in hash_set and start not in seen:
                findings.append(
                    (
                        "matched client-identity hash vocabulary",
                        "real client identifier (salted-hash vocabulary match, VANTAGE_CLIENT_HASHES)",
                    )
                )
                seen.add(start)
    return findings


def resolve_vocabulary_or_fail() -> tuple[str, object]:
    """Resolve a client vocabulary, plaintext host config FIRST, salted-hash
    vocabulary SECOND. Returns `(mode, vocab)` where `mode` is
    `"plaintext-patterns"` (vocab is a list[tuple[str, str]] of compiled
    regex patterns) or `"hashes"` (vocab is the hash-vocab dict).

    Raises `ClientIdentityConfigError`, naming BOTH sources attempted, if
    NEITHER resolves. "I could not resolve the vocabulary" and "the package
    is clean" must never produce the same outcome -- this function is the
    single choke point that guarantees that for both vocabulary sources, not
    just the plaintext one.
    """
    plaintext_error: Exception | None = None
    try:
        patterns = resolve_client_data_patterns()
        return ("plaintext-patterns", patterns)
    except ClientIdentityConfigError as exc:
        plaintext_error = exc

    hash_error: Exception | None = None
    try:
        vocab = resolve_client_hash_vocabulary()
    except ClientIdentityConfigError as exc:
        hash_error = exc
        vocab = None

    if vocab is not None:
        return ("hashes", vocab)

    raise ClientIdentityConfigError(
        "could not resolve a client-identity vocabulary from EITHER source: "
        f"(1) plaintext host config ({CLIENT_IDENTITIES_ENV} / "
        f"{DEFAULT_CLIENT_IDENTITIES_PATH}): {plaintext_error}; "
        f"(2) salted-hash CI vocabulary ({CLIENT_HASHES_ENV}): "
        f"{hash_error if hash_error is not None else 'not set'}. "
        "Refusing to report PASSED without a resolved vocabulary from either source."
    )

REQUIRED_LIST_KEYS: tuple[str, ...] = (
    "organizations",
    "contacts",
    "commercial_names",
    "aliases",
)

_FIELD_REASONS: dict[str, str] = {
    "organizations": "real client org name (resolved client-identity config)",
    "contacts": "real client contact person name (resolved client-identity config)",
    "commercial_names": "real client commercial/product name (resolved client-identity config)",
    "aliases": "real client alias/infra identifier, not expressible as a BU name (resolved client-identity config)",
}


class ClientIdentityConfigError(RuntimeError):
    """The client-identity vocabulary could not be resolved.

    Raised on: missing file, unreadable file, malformed JSON, wrong shape,
    or zero total identities. Every raise site names exactly what failed --
    callers must never catch this and continue as if the vocabulary were
    empty-but-valid; those are different states and must produce different
    outcomes (see module docstring).
    """


def resolve_config_path() -> Path:
    """Path to the host-side config: env override, else the out-of-repo default."""
    raw = os.environ.get(CLIENT_IDENTITIES_ENV)
    return Path(raw).expanduser() if raw else DEFAULT_CLIENT_IDENTITIES_PATH


def load_raw_config(path: Path) -> dict:
    """Load + validate the JSON shape at `path`. Raises `ClientIdentityConfigError`
    on any failure -- never returns a partial/default config."""
    if not path.is_file():
        raise ClientIdentityConfigError(
            f"client identity config not found at {path}. Set {CLIENT_IDENTITIES_ENV} "
            "to a readable, host-side JSON file OUTSIDE any repo/package, or create "
            f"the default at {DEFAULT_CLIENT_IDENTITIES_PATH}. Refusing to report "
            "PASSED without a resolved client vocabulary."
        )
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ClientIdentityConfigError(
            f"client identity config at {path} exists but is unreadable: {exc}"
        ) from exc

    if not text.strip():
        raise ClientIdentityConfigError(
            f"client identity config at {path} is EMPTY. An empty file is "
            "indistinguishable from a broken one and is rejected the same way "
            "as a missing file."
        )

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ClientIdentityConfigError(
            f"client identity config at {path} is not valid JSON: {exc}"
        ) from exc

    if not isinstance(data, dict):
        raise ClientIdentityConfigError(
            f"client identity config at {path} must be a JSON object with keys "
            f"{REQUIRED_LIST_KEYS}, got a {type(data).__name__}."
        )

    for key in REQUIRED_LIST_KEYS:
        if key not in data:
            raise ClientIdentityConfigError(
                f"client identity config at {path} is missing required key "
                f"{key!r}. Schema requires all of {REQUIRED_LIST_KEYS} (each a "
                "list of strings, may be empty individually)."
            )
        if not isinstance(data[key], list):
            raise ClientIdentityConfigError(
                f"client identity config key {key!r} at {path} must be a list, "
                f"got {type(data[key]).__name__}."
            )
        for i, entry in enumerate(data[key]):
            if not isinstance(entry, str) or not entry.strip():
                raise ClientIdentityConfigError(
                    f"client identity config key {key!r}[{i}] at {path} must be "
                    f"a non-empty string, got {entry!r}."
                )

    total = sum(len(data[k]) for k in REQUIRED_LIST_KEYS)
    if total == 0:
        raise ClientIdentityConfigError(
            f"client identity config at {path} resolved to ZERO identities "
            f"across {REQUIRED_LIST_KEYS}. An empty vocabulary must never be "
            "reported as PASSED -- fix the config or point "
            f"{CLIENT_IDENTITIES_ENV} at one that has content."
        )

    return data


#: The boundary, and why it is NOT `\b`.
#:
#: `\b` is the reflex, and it is HALF-BLIND, because `_` is a WORD character in
#: regex. So `\biris` finds no boundary between `marie_` and `iris`, and the guard
#: cannot see a client identity embedded in a snake_case identifier:
#:
#:     iris-rh                       -> caught
#:     iris_rh                       -> caught
#:     marie_iris_rh                 -> INVISIBLE
#:     patch_marie_iris_rh_scope.ts  -> INVISIBLE   <- and this file is on public main
#:
#: That is the SYMMETRIC error of the one this guard was built to avoid. The first
#: purge did substring matching and renamed "summaries" because it contains "marie".
#: The fix was word boundaries — and the word-boundary fix introduced a NEW blindness,
#: in exactly the place identifiers actually live: file names, function names,
#: variable names, namespace constants. Correcting an over-matcher produced an
#: under-matcher, and nobody looked back.
#:
#: So the boundary is stated explicitly: a client token must not be flanked by a
#: LETTER or a DIGIT. `_`, `-`, `/`, `.` and whitespace all count as separators,
#: because in a path or an identifier that is exactly what they are.
#:
#: This keeps the benign corpus safe, and the tests pin it: in "summaries", the
#: token "marie" is flanked by letters (`m`…`s`), so it still does not match. The
#: guard gains snake_case sight without regaining substring blindness.
_LEFT_BOUNDARY = r"(?<![A-Za-z0-9])"
_RIGHT_BOUNDARY = r"(?![A-Za-z0-9])"


def _token_to_pattern(token: str, source_key: str, path: Path) -> str:
    words = token.strip().split()
    if not words:
        raise ClientIdentityConfigError(
            f"client identity config key {source_key!r} at {path} contains a "
            "blank/whitespace-only entry."
        )
    escaped = [re.escape(w) for w in words]
    # `/` belongs in the joiner, not only in the boundary. The boundary already
    # treats `/` as a separator, so a SINGLE-word identity is seen inside a ref.
    # A MULTI-word one was not: the words could be joined by space, `-`, `_` or `.`
    # and nothing else — so `org/name` fell straight through, on a guard whose whole
    # subject is BRANCH NAMES, where `/` is THE separator. The docstring above
    # promised `/` was covered; the code did not do it. A lying contract, inside the
    # remedy written to catch lying contracts. Caught by Eta on #1099 with a probe
    # derived from the vocabulary: `-` 5/5, `_` 5/5, `.` 5/5, `/` 2/5.
    body = r"[\s\-_./]+".join(escaped)
    return rf"{_LEFT_BOUNDARY}{body}{_RIGHT_BOUNDARY}"


def build_client_data_patterns(config: dict, path: Path | None = None) -> list[tuple[str, str]]:
    """Compile the validated config dict into (regex, reason) pairs, same shape
    as `leak_guard.CLIENT_DATA_PATTERNS`. Word-boundary anchored per token --
    same matching discipline as the rest of the guard (never substrings)."""
    path = path or resolve_config_path()
    patterns: list[tuple[str, str]] = []
    for key in REQUIRED_LIST_KEYS:
        for token in config.get(key, []):
            patterns.append((_token_to_pattern(token, key, path), _FIELD_REASONS[key]))
    return patterns


def resolve_client_data_patterns(path: Path | None = None) -> list[tuple[str, str]]:
    """End-to-end: resolve config path -> load + validate -> compile patterns.

    This is the single entry point `leak_guard.py` calls. Raises
    `ClientIdentityConfigError` on any failure; callers must treat that as a
    hard failure, never as "zero client patterns, proceed clean".
    """
    cfg_path = path or resolve_config_path()
    config = load_raw_config(cfg_path)
    return build_client_data_patterns(config, cfg_path)


# =============================================================================
# ANTI-ROT (2): derive what CAN be derived from the VantagePeers BU registry,
# with an explicit, permanent, in-code statement of what it CANNOT cover.
# =============================================================================
#
# `list_bus` / the `businessUnits` Convex table (see convex/schema.ts) has a
# `name` field -- e.g. "VantagePeers", "VantageRegistry" -- and free-text
# fields like `targetCustomers`, `description`. It has NO dedicated
# client-organisation or client-contact-person field: a BU row names ElPi
# Corp's OWN product, not a third party's identity.
#
# Day 130 proved this gap is not theoretical: the missing client identity Eta
# found does not live under any BU `name` -- that client's work is tracked
# under a PRODUCT SLUG, not the client's own name. A function that "derives
# client identities from list_bus" and stops there would pass a green
# CHECKED status while STILL missing exactly the identity that mattered --
# a derived-but-incomplete source is more dangerous than a hand-written one,
# because it carries the appearance of rigor without the coverage.
#
# So: this function derives ONLY the BU-level names that legitimately live in
# the registry (useful as a supplementary, always-current signal), and the
# docstring/return value both say, explicitly, that `aliases` and `contacts`
# in the host config are NOT optional extras -- they are the ONLY place the
# gap this class of finding lives in gets closed. Do not let this function's
# existence become an excuse to stop maintaining the host config.


def derive_organizations_from_bu_registry(bu_entries: list[dict]) -> list[str]:
    """Best-effort, SUPPLEMENTARY derivation of organisation-shaped names from
    `list_bus` entries (each entry is one row's JSON shape, `name` required).

    THIS IS NOT A SUBSTITUTE for the host client-identity config. It derives
    ElPi Corp's own product/BU names only -- never a third-party client's
    organisation name or contact person, because the `businessUnits` schema
    (convex/schema.ts) has no field for those. Day 130: the client identity
    Eta found is filed under a product slug, not any BU `name` -- proving
    that "derive from the BU registry" alone is INSUFFICIENT and would ship
    a guard that still misses real client data while looking derived and
    rigorous. Callers MUST still resolve `contacts` and `aliases` from the
    host config; this function only ever feeds the supplementary,
    always-current subset that the registry can honestly provide.
    """
    names: list[str] = []
    for entry in bu_entries:
        name = entry.get("name") if isinstance(entry, dict) else None
        if isinstance(name, str) and name.strip():
            names.append(name.strip())
    return names
