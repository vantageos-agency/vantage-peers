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

import json
import os
import re
from pathlib import Path

CLIENT_IDENTITIES_ENV = "VANTAGE_CLIENT_IDENTITIES"
DEFAULT_CLIENT_IDENTITIES_PATH = Path.home() / ".claude" / "vantage-client-identities.json"

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


def _token_to_pattern(token: str, source_key: str, path: Path) -> str:
    words = token.strip().split()
    if not words:
        raise ClientIdentityConfigError(
            f"client identity config key {source_key!r} at {path} contains a "
            "blank/whitespace-only entry."
        )
    escaped = [re.escape(w) for w in words]
    body = r"[\s\-_]+".join(escaped)
    return rf"\b{body}\b"


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
