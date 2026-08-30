#!/usr/bin/env python3
"""count_unguarded_doors.py — measure how many MCP tool "doors" in
mcp-server/src/tools.ts are unguarded, mirroring the fleet leak_guard.py form:
derive, never type, and REFUSE TO JUDGE rather than silently count a door it
could not read as guarded (or as 0).

A "door" is a tool registration call: either the legacy
`server.tool("name", ...)` overload, or the mandatory-scope wrapper
`defineTool(server, ctx, scope, "name", ...)` (see
mcp-server/src/registerTool.ts). Both forms are detected without hard-coding
any tool name or count -- the registration sites and the tool names are
parsed straight out of the source text.

For each door, the FULL registration call (from its opening `(` to the
matching balanced `)`, skipping over parens found inside strings/comments/
regex literals) is sliced out and searched for ANY of the canonical guard
markers. A door is GUARDED if at least one marker appears in its slice,
UNGUARDED if none do, and UNREADABLE if the call's parens never balance
before EOF (or its name literal cannot be found) -- an unreadable door is
never silently counted as guarded OR unguarded; it forces `unreadable>0`,
which is a hard refusal to judge (see main()).
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

GUARD_MARKERS = (
    "guardMasterOnly(",
    "checkNamespaceRead(",
    "checkNamespaceWrite(",
    "checkFromAllowed(",
    "guardWrite(",
    "guardFrom(",
    "scopeFilterList(",
    "scopeFilterGet(",
    "isMasterScope(oauthCtx)",
    "oauthCtx.userId",
)

# Registration call heads this script knows how to find. Each is the literal
# text immediately preceding the call's opening `(`.
CALL_HEADS = ("server.tool(", "defineTool(")

# A `/` starts a regex literal (not a division operator) when the previous
# significant character puts the parser in "expression expected" position --
# this is the classic JS/TS lexer ambiguity. tools.ts has real regex literals
# with a raw `"`/`'` inside their character class (e.g.
# `/\bPath:\s*([\w.[\]"']+)\s*$/`); without recognising these as regexes (and
# skipping their body wholesale) those raw quote chars get misread as string
# delimiters and desynchronise every string/comment boundary for the rest of
# the file -- a prior version of this script hit exactly that.
_REGEX_PRECEDING_CHARS = set("([{,;=:!&|?+-*%<>~^\n")
_REGEX_PRECEDING_KEYWORDS = (
    "return",
    "typeof",
    "instanceof",
    "delete",
    "void",
    "case",
    "do",
    "else",
    "yield",
    "in",
    "of",
    "new",
)


def _prev_significant_char(text: str, idx: int) -> str | None:
    j = idx - 1
    while j >= 0 and text[j] in " \t":
        j -= 1
    return text[j] if j >= 0 else None


def _looks_like_regex_start(text: str, idx: int) -> bool:
    """idx points at a `/` that is NOT `//` or `/*`. Decide whether it opens
    a regex literal based on what precedes it."""
    prev = _prev_significant_char(text, idx)
    if prev is None or prev in _REGEX_PRECEDING_CHARS:
        return True
    # Keyword check: walk back over the preceding identifier chars.
    j = idx - 1
    while j >= 0 and text[j] in " \t":
        j -= 1
    end = j + 1
    while j >= 0 and (text[j].isalnum() or text[j] == "_"):
        j -= 1
    word = text[j + 1 : end]
    return word in _REGEX_PRECEDING_KEYWORDS


def _skip_regex_literal(text: str, idx: int) -> int:
    """idx points at the opening `/` of a regex literal. Return the index
    just past the literal's trailing flags (e.g. `/foo/g` -> past the `g`)."""
    n = len(text)
    i = idx + 1
    in_class = False
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if c == "[":
            in_class = True
            i += 1
            continue
        if c == "]":
            in_class = False
            i += 1
            continue
        if c == "/" and not in_class:
            i += 1
            break
        if c == "\n":
            # Unterminated regex literal -- bail without consuming the
            # newline so the caller's own state machine keeps going.
            return i
        i += 1
    # Consume trailing flags (letters).
    while i < n and text[i].isalpha():
        i += 1
    return i


@dataclass
class Door:
    name: str
    guarded: bool


@dataclass
class ScanResult:
    doors: list[Door] = field(default_factory=list)
    unreadable: list[str] = field(default_factory=list)


def _build_code_mask(text: str) -> bytearray:
    """Mark every index as 1 (real code) or 0 (inside a string/comment/regex
    literal), so a CALL_HEADS match found inside a `//` doc comment (e.g.
    this file's own `// Intercept EVERY server.tool(...) ...` narration) is
    never mistaken for an actual registration call."""
    n = len(text)
    mask = bytearray(n)
    i = 0
    in_str: str | None = None
    in_line_comment = False
    in_block_comment = False
    while i < n:
        c = text[i]
        if in_line_comment:
            if c == "\n":
                in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            if c == "*" and i + 1 < n and text[i + 1] == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue
        if in_str is not None:
            if c == "\\":
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            in_line_comment = True
            i += 2
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            in_block_comment = True
            i += 2
            continue
        if c == "/" and _looks_like_regex_start(text, i):
            i = _skip_regex_literal(text, i)
            continue
        if c in ("'", '"', "`"):
            in_str = c
            i += 1
            continue
        mask[i] = 1
        i += 1
    return mask


def _find_matching_paren(text: str, open_idx: int) -> int | None:
    """Return the index of the `)` matching the `(` at open_idx, scanning
    past string/template literals, comments and regex literals so anything
    inside them is never mistaken for call structure. Returns None if it
    never balances before EOF (the call is UNREADABLE)."""
    assert text[open_idx] == "("
    i = open_idx + 1
    depth = 1
    n = len(text)
    in_str: str | None = None  # one of '"', "'", "`", or None
    in_line_comment = False
    in_block_comment = False
    while i < n:
        c = text[i]
        if in_line_comment:
            if c == "\n":
                in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            if c == "*" and i + 1 < n and text[i + 1] == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue
        if in_str is not None:
            if c == "\\":
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            in_line_comment = True
            i += 2
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            in_block_comment = True
            i += 2
            continue
        if c == "/" and _looks_like_regex_start(text, i):
            i = _skip_regex_literal(text, i)
            continue
        if c in ("'", '"', "`"):
            in_str = c
            i += 1
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return None


# Some registrations pass the tool name as a named constant instead of an
# inline literal (e.g. `defineTool(server, authCtx, { kind: "master" },
# BILLING_SUMMARY_BY_PROJECT_TOOL_NAME, ...)`), where the constant is
# declared elsewhere in the same file as
# `export const X_TOOL_NAME = "literal";` (optionally string-concatenated
# across lines). This is still a derivation, never a hard-coded name/count:
# we resolve the identifier back to its own literal declaration in the
# source rather than refusing to judge every constant-named door.
_CONST_STRING_DECL_RE = re.compile(
    r"const\s+([A-Za-z_$][\w$]*)\s*=\s*((?:\s*[\"'][^\"']*[\"']\s*\+?)+)"
)


def _build_const_string_table(text: str) -> dict[str, str]:
    table: dict[str, str] = {}
    for m in _CONST_STRING_DECL_RE.finditer(text):
        ident, rhs = m.group(1), m.group(2)
        parts = re.findall(r"[\"']([^\"']*)[\"']", rhs)
        if parts:
            table[ident] = "".join(parts)
    return table


def _first_top_level_name_token(
    slice_text: str, const_table: dict[str, str]
) -> str | None:
    """Return the tool's registered name: either the first quoted string
    literal found at bracket depth 0 within the call's argument list, or --
    if that first depth-0 token is a bare identifier instead of a literal
    (a `const X_TOOL_NAME = "..."` constant passed by reference) -- that
    constant resolved via `const_table`.

    `defineTool`'s third positional argument is a `ToolScope` object literal
    (e.g. `{ kind: "read", namespaceArg: "namespace" }`, see
    registerTool.ts) whose OWN string values would otherwise be mistaken for
    the tool name if we grabbed the very first quote in the slice
    regardless of nesting -- depth-0 filtering skips straight past those and
    lands on the real `name` argument."""
    i = 0
    n = len(slice_text)
    depth = 0
    while i < n:
        c = slice_text[i]
        if c == "/" and i + 1 < n and slice_text[i + 1] == "/":
            # `//` line comment -- apostrophes/quotes in prose here (e.g.
            # "doesn't") must never be mistaken for a string open.
            j = slice_text.find("\n", i)
            i = n if j == -1 else j + 1
            continue
        if c == "/" and i + 1 < n and slice_text[i + 1] == "*":
            j = slice_text.find("*/", i + 2)
            i = n if j == -1 else j + 2
            continue
        if c in ("{", "(", "["):
            depth += 1
            i += 1
            continue
        if c in ("}", ")", "]"):
            depth -= 1
            i += 1
            continue
        if c in ("'", '"', "`"):
            j = i + 1
            buf = []
            while j < n and slice_text[j] != c:
                if slice_text[j] == "\\":
                    j += 2
                    continue
                buf.append(slice_text[j])
                j += 1
            if j >= n:
                return None
            if depth == 0:
                return "".join(buf)
            i = j + 1
            continue
        if depth == 0 and (c.isalpha() or c == "_" or c == "$"):
            j = i
            while j < n and (slice_text[j].isalnum() or slice_text[j] in "_$"):
                j += 1
            ident = slice_text[i:j]
            # Skip the fixed positional args that precede the name
            # (`server`, the auth-ctx variable) -- neither resolves via the
            # const table, so falling through and continuing the scan for
            # the NEXT depth-0 token is exactly "keep looking", not a guess.
            if ident in const_table:
                return const_table[ident]
            i = j
            continue
        i += 1
    return None


def scan_source(text: str) -> ScanResult:
    result = ScanResult()
    code_mask = _build_code_mask(text)
    const_table = _build_const_string_table(text)
    for head in CALL_HEADS:
        start = 0
        while True:
            idx = text.find(head, start)
            if idx == -1:
                break
            if not code_mask[idx]:
                # Match lives inside a comment/string/regex (narration about
                # the call heads, not an actual registration) — not a door
                # at all, skip it silently and keep scanning.
                start = idx + len(head)
                continue
            open_idx = idx + len(head) - 1  # index of the "(" itself
            close_idx = _find_matching_paren(text, open_idx)
            if close_idx is None:
                result.unreadable.append(
                    f"{head}...  (unbalanced parens starting at offset {idx})"
                )
                # Cannot trust anything past an unbalanced call; stop
                # scanning for this call head to avoid cascading garbage.
                break
            call_slice = text[open_idx + 1 : close_idx]
            name = _first_top_level_name_token(call_slice, const_table)
            if name is None:
                result.unreadable.append(
                    f"{head}...  (no name literal found, offset {idx})"
                )
                start = close_idx + 1
                continue
            guarded = any(marker in call_slice for marker in GUARD_MARKERS)
            result.doors.append(Door(name=name, guarded=guarded))
            start = close_idx + 1
    return result


def derive_tool_names(text: str) -> list[str]:
    """Public helper (used by the test suite) — return every registered
    tool name found in the source, in file order, doors that could not be
    read excluded (callers must separately check unreadable count)."""
    return [d.name for d in scan_source(text).doors]


def derive_read_tool_names(text: str) -> list[str]:
    """Naming-convention derivation of the tools whose handler crosses
    tenants if unscoped, replacing the hand-typed READ_TOOLS_THAT_NEED_GUARD
    list in scope-guard-coverage.test.ts. Any tool named with the list_/
    get_/search_ convention is a bulk-list or single-row read by
    construction; `check_messages` and `issue_stats` are the two structural
    exceptions that don't follow that naming convention but are still reads
    (present in the original hand-typed list)."""
    names = derive_tool_names(text)
    out = []
    for n in names:
        if n.startswith(("list_", "get_", "search_")):
            out.append(n)
        elif n in ("check_messages", "issue_stats"):
            out.append(n)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "path",
        nargs="?",
        default="mcp-server/src/tools.ts",
        help="Path to tools.ts (default: mcp-server/src/tools.ts)",
    )
    parser.add_argument(
        "--baseline",
        type=int,
        default=None,
        help="Fail (exit 1) if the derived unguarded count exceeds this",
    )
    args = parser.parse_args(argv)

    path = Path(args.path)
    if not path.exists():
        print(f"REFUSING TO JUDGE: {path} does not exist")
        print("guarded=0")
        print("unguarded=0")
        print("unreadable=1")
        print("total=0")
        return 2

    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError) as exc:
        print(f"REFUSING TO JUDGE: {path} could not be read as UTF-8 text ({exc})")
        print("guarded=0")
        print("unguarded=0")
        print("unreadable=1")
        print("total=0")
        return 2

    result = scan_source(text)
    guarded = sum(1 for d in result.doors if d.guarded)
    unguarded = sum(1 for d in result.doors if not d.guarded)
    unreadable = len(result.unreadable)
    total = len(result.doors) + unreadable

    if unreadable > 0:
        for entry in result.unreadable:
            print(f"REFUSING TO JUDGE: {entry}")

    print(f"guarded={guarded}")
    print(f"unguarded={unguarded}")
    print(f"unreadable={unreadable}")
    print(f"total={total}")

    if unreadable > 0:
        return 2
    if args.baseline is not None and unguarded > args.baseline:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
