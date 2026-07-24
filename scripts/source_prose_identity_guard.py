#!/usr/bin/env python3
"""Source-surface client-identity leak guard — PROSE ONLY, structural scope.

PR #1119 follow-up (Eta's third category), reworked for PR #1120 (Eta REVISE):
the packaged-artifact leak guard (`scripts/leak_guard.py`) and the branch-ref
guard (`scripts/guard_git_refs.py`, PR #1099) both already refuse to ship a
client identity, but neither one scans this repo's SOURCE description/comment
surface directly. A client name in a Convex `description` field or a schema
comment is neither a packaged artifact nor a branch name, and slipped through
both existing guards -- 8 lines at HEAD d6e43c0, all redacted (see git history
for the introducing commit; this docstring deliberately does not restate the
redacted names or their file:line addresses, to avoid becoming a second
publication of what was just removed).

WHY THIS IS A PYTHON CHECK, NOT A VITEST UNIT (PR #1120 rework):
the first version of this guard resolved its vocabulary ONLY from the host
file `~/.claude/vantage-client-identities.json`. CI runners have no
`$HOME/.claude` and no workflow provisions it, so the vitest suite FAILED by
construction on that PR and every future one. Verification != Activation.
This version reuses the CANONICAL resolver (`client_identity_config.py`,
already wired into `scripts/leak_guard.py` and already fed by the
`VANTAGE_CLIENT_HASHES` GitHub Actions secret in
`.github/workflows/plugin-vr-parity.yml`) instead of inventing a second one.
It lives next to `leak_guard.py` as a Python check because the canonical
resolver + matcher (`resolve_vocabulary_or_fail`, `hash_matcher_findings`,
`build_client_data_patterns`) are Python, and this guard imports them
directly -- no shelling out to a second CLI script, no vocabulary duplicated
into a second surface.

THE STRUCTURAL FIX (this is the actual design decision of the rework):
the previous version reinvented vocabulary resolution
(`scripts/emit_client_tokens.py`, `scripts/emit_client_patterns.py`) with a
custom WHITESPACE-ONLY joiner, specifically to avoid flagging this repo's own
kebab-case AUTHORIZATION IDENTIFIERS (`profileId`, `fromAllowList`,
`namespaceReadPrefixes`, `namespaceWritePrefixes` -- these legitimately fold a
multi-word client identity into a hyphenated slug, e.g. `<org>-<team>-hr`),
which legitimately spell a client identity as a slug, not as prose. That
reinvention is deleted. Instead, the SCOPE is made structural: this guard
extracts only PROSE from the perimeter files -- `//` and `/* */` comments,
and the string literal VALUE of `description:` fields -- and feeds ONLY that
extracted text to the canonical matcher (`hash_matcher_findings` in hash
mode, or the canonical regex patterns in plaintext mode). Authorization
identifier arrays (`fromAllowList: [...]`, `namespaceReadPrefixes: [...]`,
`profileId: "..."`) are neither comments nor `description:` literals, so they
are excluded BY CONSTRUCTION -- no special matcher, no allowlist, no name
list required to keep them green.

FAIL-LOUD contract, preserved: "I could not resolve the vocabulary" and "the
repo is clean" must NEVER produce the same passing result. If neither
vocabulary source resolves (`ClientIdentityConfigError`), this guard's `main`
exits non-zero with a message naming both attempted sources -- it never
silently skips or prints a passing result. In CI, `VANTAGE_CLIENT_HASHES` is
set (see `.github/workflows/plugin-vr-parity.yml`), so an "unresolvable"
outcome in the required job is a real misconfiguration, not the normal case.

SCOPE: this guard checks the "auth profile perimeter" files --
`convex/oauth.ts`, `convex/schema.ts`, `convex/migrations/**/*.ts` -- PLUS its
own source (this file). A guard that refuses a client name must refuse it
inside itself too, or it is blind to its own recurrence -- see
PERIMETER_FILES below. This is intentionally narrower than a whole-repo
sweep (docs/, mcp-server/, existing tests use client/BU vocabulary
pervasively in legitimate, previously reviewed prose -- purging that
repo-wide is a distinct, larger class tracked separately, not silently
folded into this gate).

This file contains NO client name, anywhere, ever -- the vocabulary is
resolved OUTSIDE this repo: either the host file (`VANTAGE_CLIENT_IDENTITIES`
/ `~/.claude/vantage-client-identities.json`, local dev) or the salted-hash
CI secret (`VANTAGE_CLIENT_HASHES`).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from client_identity_config import (  # noqa: E402
    ClientIdentityConfigError,
    hash_matcher_findings,
    resolve_vocabulary_or_fail,
)

REPO_ROOT = Path(__file__).resolve().parent.parent

# The auth-profile perimeter this guard gates -- the surface the 8
# HEAD-d6e43c0 findings came from, PLUS this guard's own source file. A guard
# that documents a client name "as an example" in its own docstring has
# become the leak it exists to prevent -- so it must scan itself, not just
# the files it was written to catch. Widening this list further is a
# deliberate decision, not something this guard should silently do on its
# own.
PERIMETER_FILES: list[str] = [
    "convex/oauth.ts",
    "convex/schema.ts",
    "convex/migrations/patch_marie_iris_rh_scope.ts",
    "scripts/source_prose_identity_guard.py",
]


class ProseExtractionError(RuntimeError):
    """A perimeter file could not be read or parsed for prose extraction."""


# --- DECLARED SCOPE (PR #1120, reviewer contract) ----------------------------
# This guard's REQUIRED, gate-blocking scope is deliberately narrow, and the
# narrowing is written HERE, in code, not left to be inferred from what
# happens to be green today. "Green" on this guard proves ONE class is
# clean; it proves nothing about the other two classes below, and a reader
# must not be able to conclude otherwise from the PASSED line alone.
#
# COVERED (this guard closes this class, at zero, as a REQUIRED CI gate):
#   Client identity spelled in PROSE -- `//`/`/* */` comments and the string
#   literal VALUE of a `description:` field -- across PERIMETER_FILES. See
#   `extract_prose` for the exact structural shapes scanned.
#
# EXCLUDED, class 1 -- repository FILE PATHS / module-invocation strings:
#   A finding whose matched text is (or sits inside) a repository file path
#   or a Convex module-invocation string -- e.g.
#   `convex/migrations/patch_marie_iris_rh_scope.ts` or the `bunx convex run
#   "migrations/patch_marie_iris_rh_scope:patchMarieIrisRhScope"` invocation
#   line -- is OUT OF SCOPE for this guard. The migration's own FILENAME
#   carries the client slug; rewording the PROSE that cites that filename
#   cannot close this class without breaking a live invocation path
#   referenced in 4 places (the migration's own header, its `bunx convex
#   run` line, and its two cross-references from convex/oauth.ts). This
#   class is closed by RENAMING the file, not by rewording prose around it.
#   Tracing id (rename has its own follow-up task): k171ksjnczs3k404nte7kk9m0h8b2a8g.
#   The exclusion below (`_is_repo_path_or_invocation`) is a STRUCTURAL
#   predicate over the SHAPE of the matched text (known repo top-level
#   directories, source-file extensions, the `dir/name:function` Convex
#   invocation shape) -- never a line-number allowlist, never a name list.
#
# EXCLUDED, class 2 -- the authorization identifier ARRAYS themselves:
#   `profileId`, `fromAllowList`, `namespaceReadPrefixes`,
#   `namespaceWritePrefixes` carry the client slug in CLEARTEXT in this
#   PUBLIC repo, by design (they are the blocking authorization control,
#   not decoration -- see PR #1119/#1120 history). `extract_prose` already
#   excludes these BY CONSTRUCTION (they are neither comments nor
#   `description:` literals), so redacting prose while these stay readable
#   is COSMETIC: no decoder is needed to read a cleartext array. This class
#   is not closed by this guard at all -- it is closed by moving these
#   profiles from CODE to DATA (a Convex table, access-controlled like any
#   other row, instead of a slug readable by anyone who can read this public
#   repo's source). Tracing id: k170xwqveg15kzrqwvfq5ynqd58b263s.
#
# The scope WIDENS only in the delivery that actually closes each excluded
# class (the rename PR for class 1, the code-to-data migration for class 2)
# -- never silently, never by editing this comment alone.
_REPO_PATH_OR_INVOCATION_RE = re.compile(
    r"\b(?:convex|scripts|mcp-server|tests)/[\w./-]+\.\w+\b"
    r"|\bmigrations/[\w-]+:[\w]+\b"
    r"|\b[\w-]+\.(?:ts|tsx|js|jsx|py)\b"
)

_PATH_PLACEHOLDER = " REPO_PATH_OR_INVOCATION "


def _strip_repo_paths_and_invocations(prose: str) -> str:
    """Remove class-1-excluded substrings (repo file paths / Convex module
    invocation strings) from `prose` BEFORE it reaches the identity matcher.

    This is the mechanical form of the "EXCLUDED, class 1" scope declared
    above: the exclusion acts on the SHAPE of the matched span (does it look
    like a repo path or a `dir/name:function` invocation?), never on a
    line number or a name -- so a genuine client-identity leak sitting
    ANYWHERE else in the same prose string (not inside a path/invocation
    shape) still reaches the matcher and still fails the gate.
    """
    return _REPO_PATH_OR_INVOCATION_RE.sub(_PATH_PLACEHOLDER, prose)


# --- Structural prose extraction ---------------------------------------------
# ONLY two shapes count as "prose" for this guard: `//`/`/* */` comments, and
# the string literal VALUE bound to a `description:` key. Everything else --
# in particular every entry inside `fromAllowList: [...]`,
# `namespaceReadPrefixes: [...]`, `namespaceWritePrefixes: [...]`, and the
# `profileId: "..."` value itself -- is excluded BY CONSTRUCTION: it is
# neither a comment nor a `description:` literal, so this extractor never
# even looks at it. There is no name list or allowlist doing the exclusion;
# the shape of the source is what does it.

_LINE_COMMENT_RE = re.compile(r"//(.*)$")
_BLOCK_COMMENT_RE = re.compile(r"/\*(.*?)\*/", re.DOTALL)
# `description:` followed by a single- or double-quoted (possibly
# multi-line, JS-style implicit string concatenation via `+` is NOT handled
# here -- perimeter files use a single template/plain string literal per
# `description:` today; a multi-part concatenation would need a follow-up)
# string literal. Matches both `description: "..."` and the
# `description:\n  "..."` layout used in convex/oauth.ts.
_DESCRIPTION_FIELD_RE = re.compile(
    r'description\s*:\s*\n?\s*"((?:[^"\\]|\\.)*)"',
    re.DOTALL,
)
# Python-side `#` comments and docstrings, for this guard's own self-scan
# (this file is Python, everything else in PERIMETER_FILES is TypeScript).
_PY_COMMENT_RE = re.compile(r"#(.*)$")
_PY_DOCSTRING_RE = re.compile(r'"""(.*?)"""', re.DOTALL)


def extract_prose(content: str, *, is_python: bool) -> list[tuple[int, str]]:
    """Return `(line_no, prose_text)` pairs for every comment / description
    literal in `content`. `line_no` is the 1-based line the prose STARTS on
    (multi-line block comments/docstrings/descriptions are reported once, at
    their opening line, with the full extracted body).
    """
    results: list[tuple[int, str]] = []

    if is_python:
        for match in _PY_DOCSTRING_RE.finditer(content):
            line_no = content.count("\n", 0, match.start()) + 1
            results.append((line_no, match.group(1)))
        # Avoid double-reporting `#` inside an already-extracted docstring by
        # scanning line-by-line and skipping lines fully inside a docstring
        # span -- simplest correct approach: recompute per-line comment
        # matches only OUTSIDE docstring byte ranges.
        docstring_spans = [
            (m.start(), m.end()) for m in _PY_DOCSTRING_RE.finditer(content)
        ]
        offset = 0
        for i, line in enumerate(content.split("\n"), start=1):
            line_start = offset
            offset += len(line) + 1
            if any(s <= line_start < e for s, e in docstring_spans):
                continue
            m = _PY_COMMENT_RE.search(line)
            if m:
                results.append((i, m.group(1)))
    else:
        for match in _BLOCK_COMMENT_RE.finditer(content):
            line_no = content.count("\n", 0, match.start()) + 1
            results.append((line_no, match.group(1)))
        block_spans = [(m.start(), m.end()) for m in _BLOCK_COMMENT_RE.finditer(content)]
        offset = 0
        for i, line in enumerate(content.split("\n"), start=1):
            line_start = offset
            offset += len(line) + 1
            if any(s <= line_start < e for s, e in block_spans):
                continue
            m = _LINE_COMMENT_RE.search(line)
            if m:
                results.append((i, m.group(1)))

        for match in _DESCRIPTION_FIELD_RE.finditer(content):
            line_no = content.count("\n", 0, match.start()) + 1
            results.append((line_no, match.group(1)))

    return results


def scan_perimeter_file_prose(
    rel_path: str,
    *,
    hash_vocab: dict | None = None,
    plaintext_patterns: list[tuple[str, str]] | None = None,
) -> list[str]:
    """Scan the PROSE (only) of one perimeter file. Returns human-readable
    finding strings, `path:line: reason` -- never the raw matched plaintext
    in hash mode (see `client_identity_config.hash_matcher_findings`)."""
    abs_path = REPO_ROOT / rel_path
    try:
        content = abs_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ProseExtractionError(f"perimeter file {rel_path} could not be read: {exc}") from exc

    is_python = abs_path.suffix == ".py"
    prose_spans = extract_prose(content, is_python=is_python)

    findings: list[str] = []
    for line_no, raw_prose in prose_spans:
        # Class-1 exclusion (declared above `_REPO_PATH_OR_INVOCATION_RE`):
        # strip repo-path / module-invocation shapes before matching, so a
        # migration filename cited in prose does not trip this REQUIRED
        # gate while any OTHER client-identity mention in the same prose
        # string still does.
        prose = _strip_repo_paths_and_invocations(raw_prose)
        if hash_vocab is not None:
            for _pattern_label, reason in hash_matcher_findings(prose, hash_vocab):
                findings.append(f"{rel_path}:{line_no}: [{reason}]")
        if plaintext_patterns is not None:
            for pattern, reason in plaintext_patterns:
                if re.search(pattern, prose, flags=re.IGNORECASE):
                    findings.append(f"{rel_path}:{line_no}: [{reason}] (prose match)")
    return findings


def scan_perimeter(
    perimeter: list[str] | None = None,
    *,
    hash_vocab: dict | None = None,
    plaintext_patterns: list[tuple[str, str]] | None = None,
) -> list[str]:
    findings: list[str] = []
    for rel_path in perimeter if perimeter is not None else PERIMETER_FILES:
        findings.extend(
            scan_perimeter_file_prose(
                rel_path,
                hash_vocab=hash_vocab,
                plaintext_patterns=plaintext_patterns,
            )
        )
    return findings


def main() -> int:
    try:
        vocab_mode, vocab = resolve_vocabulary_or_fail()
    except ClientIdentityConfigError as exc:
        print(
            "FAIL: could not resolve the client-identity vocabulary -- refusing "
            "to report the source-prose perimeter as clean without one.\n"
            f"  {exc}",
            file=sys.stderr,
        )
        return 2

    hash_vocab = vocab if vocab_mode == "hashes" else None
    plaintext_patterns = vocab if vocab_mode == "plaintext-patterns" else None

    try:
        findings = scan_perimeter(hash_vocab=hash_vocab, plaintext_patterns=plaintext_patterns)
    except ProseExtractionError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 2

    if findings:
        print(
            f"FAILED — {len(findings)} client-identity leak(s) in perimeter PROSE "
            f"(comments / description: literals):",
            file=sys.stderr,
        )
        for f in findings:
            print(f"  {f}", file=sys.stderr)
        return 1

    mode_summary = (
        f"{len(hash_vocab['hashes'])} salted-hash identity entries (VANTAGE_CLIENT_HASHES)"
        if hash_vocab is not None
        else f"{len(plaintext_patterns)} identity pattern(s) (host config)"
    )
    print(
        f"SOURCE-PROSE GUARD PASSED — vocabulary RESOLVED ({mode_summary}); "
        f"no client identity in comment/description prose across "
        f"{len(PERIMETER_FILES)} perimeter file(s)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
