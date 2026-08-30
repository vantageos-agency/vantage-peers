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

CLASSIFICATION (kind-based, plus a PER-DOOR DECLARED-AND-VERIFIED rule for
`filtered`; never a central marker list). `defineTool` applies
`enforceScope(scope)` BEFORE the handler ever runs (registerTool.ts) — the
DECLARED SCOPE KIND is itself the guard for `master`/`read`/`write`/`from`.
Searching the handler body for an in-handler marker is the wrong measurement
for those kinds: it is both blind to the real gate (the wrapper, not the
body) and gameable (a redundant in-handler marker added to an
already-envelope-guarded door lowers the count while closing nothing). Per
door, the scope kind is read from the door's OWN registration (its 3rd
positional argument to `defineTool`), never from a neighbouring door.

For `filtered` doors the classifier does NOT consult any central hardcoded
marker list (the retired `FILTERED_GUARD_MARKERS`). A central list rots: it
blesses the next door that merely calls a listed name without restricting
rows, and misses the next door that restricts rows under a new name. Instead,
the `filtered` ToolScope already carries `readonly reason: string`
(registerTool.ts). The rule is DERIVE-NEVER-TYPE, per door, from that door's
own declaration:

  1. read the door's OWN `reason` text (from its scope argument);
  2. extract the mechanism(s) the reason NAMES — every function-call-shaped
     identifier in the reason, i.e. an identifier immediately followed by `(`
     (e.g. `scopeFilterList(`, `scopeFilterGet(`, `listTasksGate(`);
  3. verify at least one such named mechanism identifier actually appears,
     call-shaped, in that door's OWN handler slice.

  IMPORTANT — what `guarded` DOES and DOES NOT assert for a `filtered` door.
  `guarded` means the door's OWN reason names a mechanism AND a call-shaped
  occurrence of that mechanism is TEXTUALLY PRESENT in the handler slice. It
  does NOT prove the mechanism's RESULT actually reaches (scopes) the returned
  rows. Eta's M3 (#1242): a door whose real filter was deleted but that still
  carried a dead `scopeFilterGet(oauthCtx, null)` call (its return value thrown
  away, the unscoped rows returned instead) stayed GREEN — presence is textual,
  not dataflow. The `--dataflow` mode (see below) tightens this toward "the
  named mechanism's result is actually consumed", closing that blind spot; the
  DEFAULT mode remains textual-presence and this caveat applies to it.

  - GUARDED   — kind is `master` / `read` / `write` / `from` (the envelope
                enforces it before the handler runs), OR kind is `filtered`
                AND its reason NAMES a mechanism AND that mechanism is present
                (call-shaped) in the handler slice (textual presence — see the
                IMPORTANT caveat above; in `--dataflow` mode the mechanism's
                result must also be consumed, not discarded).
  - UNGUARDED — kind is `filtered` AND EITHER (a) its reason names NO
                mechanism (no call-shaped identifier — nobody wrote what
                guards the rows), OR (b) its reason names a mechanism that is
                ABSENT from the handler slice. Case (b) is the LYING
                declaration — a door that claims a guard it does not run. No
                central marker list can catch case (b); only reading the
                door's own declaration against its own handler can.
  - PUBLIC    — kind is `public`. This is NOT an unguarded door (it is an
                explicit, reasoned, grep-able exposure) — counted in its own
                bucket, never folded into `unguarded`.
  - UNREADABLE — registration/scope/handler cannot be sliced -> exit 2,
                refusing to judge (never silently counted as guarded,
                unguarded, or public).

For each door, the FULL registration call (from its opening `(` to the
matching balanced `)`, skipping over parens found inside strings/comments/
regex literals) is sliced out; its top-level (depth-0) comma-separated
arguments are split out so the `scope` argument (3rd positional) and the
final `handler` argument can be read independently of each other and of any
nested `kind:`-shaped object literal living inside the handler body (e.g. a
UI marker payload) -- see `_split_top_level_args`.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# A `filtered`-kind door is the ONE scope kind the defineTool wrapper cannot
# auto-apply (it needs post-query rows), so the declaration is a promise the
# handler must keep itself. There is deliberately NO central marker list here
# (the retired FILTERED_GUARD_MARKERS): the guard is whatever mechanism THIS
# door's own `reason` names, and it must appear, call-shaped, in THIS door's
# own handler slice. See the module docstring CLASSIFICATION section.

# A function-call-shaped identifier: a name IMMEDIATELY followed by `(` (no
# intervening whitespace — a call, not an English word that happens to precede
# a parenthetical). This is how a `reason` NAMES a mechanism ("scoped via
# scopeFilterList(...)") and how the handler slice is probed for that same
# mechanism's presence. The "immediately" is load-bearing: it keeps a prose
# reason like "the token may speak as (fromAllowList/userId)" from being
# misread as naming a mechanism `as` — that reason names NOTHING.
_CALL_ID_RE = re.compile(r"([A-Za-z_$][\w$]*)\(")

# `reason: "..."` value extraction — the value may be a single string literal
# or several string literals concatenated with `+` across lines (the common
# multi-line style in tools.ts). Grabs the run of adjacent literals so the
# whole reason text is reconstructed before mechanisms are extracted from it.
_REASON_DECL_RE = re.compile(
    r'reason\s*:\s*((?:\s*"(?:[^"\\]|\\.)*"\s*\+?)+)'
)
_STRING_LITERAL_RE = re.compile(r'"((?:[^"\\]|\\.)*)"')

# Registration call heads this script knows how to find. Each is the literal
# text immediately preceding the call's opening `(`.
CALL_HEADS = ("server.tool(", "defineTool(")

# Scope kinds the defineTool wrapper itself enforces before the handler runs
# (registerTool.ts `enforceScope`) -- the declaration alone is the guard.
ENVELOPE_GUARANTEED_KINDS = frozenset({"master", "read", "write", "from"})

_KIND_RE = re.compile(r'kind\s*:\s*"([a-zA-Z_][\w-]*)"')

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
    kind: str | None  # None means "kind could not be derived" (UNREADABLE)
    # For `filtered` doors only: True iff the door's OWN reason NAMES at least
    # one call-shaped mechanism AND at least one such named mechanism actually
    # appears, call-shaped, in the door's OWN handler slice. False when the
    # reason names no mechanism, or names one that is absent from the handler
    # (the LYING declaration). Meaningless for non-`filtered` kinds.
    filtered_reason_verified: bool
    # The mechanism identifiers this door's reason NAMED (call-shaped). Empty
    # when the reason named none. Retained for diagnostics/tests.
    filtered_reason_mechanisms: tuple[str, ...] = ()


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


def _split_top_level_args(slice_text: str) -> list[str] | None:
    """Split a call's argument-list slice (the text strictly between its
    outer `(` and matching `)`) into its top-level (depth-0) comma-separated
    positional arguments, so the 3rd positional arg (`scope`) and the final
    positional arg (`handler`) can be read independently of any `,` or
    `kind:`-shaped object literal nested INSIDE an earlier or later argument
    (e.g. a marker payload built inside the handler body). Returns None if
    the slice's own brackets/strings never balance (UNREADABLE)."""
    n = len(slice_text)
    depth = 0
    i = 0
    in_str: str | None = None
    in_line_comment = False
    in_block_comment = False
    arg_start = 0
    args: list[str] = []
    while i < n:
        c = slice_text[i]
        if in_line_comment:
            if c == "\n":
                in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            if c == "*" and i + 1 < n and slice_text[i + 1] == "/":
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
        if c == "/" and i + 1 < n and slice_text[i + 1] == "/":
            in_line_comment = True
            i += 2
            continue
        if c == "/" and i + 1 < n and slice_text[i + 1] == "*":
            in_block_comment = True
            i += 2
            continue
        if c == "/" and _looks_like_regex_start(slice_text, i):
            i = _skip_regex_literal(slice_text, i)
            continue
        if c in ("'", '"', "`"):
            in_str = c
            i += 1
            continue
        if c in "([{":
            depth += 1
            i += 1
            continue
        if c in ")]}":
            depth -= 1
            if depth < 0:
                return None
            i += 1
            continue
        if c == "," and depth == 0:
            args.append(slice_text[arg_start:i])
            arg_start = i + 1
            i += 1
            continue
        i += 1
    if depth != 0 or in_str is not None:
        return None
    args.append(slice_text[arg_start:n])
    # A trailing comma before the call's closing `)` (allowed, and common
    # multi-line style in this codebase) produces one final whitespace-only
    # "argument" -- drop it so `top_args[-1]` is the real last positional
    # arg (the handler), not an empty tail.
    while args and args[-1].strip() == "":
        args.pop()
    return args


def _extract_kind(scope_arg_text: str) -> str | None:
    m = _KIND_RE.search(scope_arg_text)
    return m.group(1) if m else None


def _extract_reason(scope_arg_text: str) -> str:
    """Reconstruct a `filtered` door's `reason:` string value from its scope
    argument, joining a `+`-concatenated multi-line run of literals into one
    text. Returns "" when no `reason:` field is present."""
    m = _REASON_DECL_RE.search(scope_arg_text)
    if not m:
        return ""
    parts = _STRING_LITERAL_RE.findall(m.group(1))
    return "".join(parts)


def _reason_named_mechanisms(reason: str) -> tuple[str, ...]:
    """Extract every mechanism the reason NAMES — each function-call-shaped
    identifier (a name immediately followed by `(`). e.g.
    "scoped via scopeFilterList(oauthCtx)/scopeFilterGet(oauthCtx)" ->
    ("scopeFilterList", "scopeFilterGet"). A reason with no call-shaped
    identifier (e.g. "restricted to createdBy===oauthCtx.userId") names NONE,
    de-duplicated, in first-seen order."""
    seen: dict[str, None] = {}
    for m in _CALL_ID_RE.finditer(reason):
        seen.setdefault(m.group(1), None)
    return tuple(seen)


def _mechanism_in_handler(mechanism: str, handler_text: str) -> bool:
    """True iff `mechanism` appears CALL-SHAPED (identifier immediately
    followed by `(`) in the handler slice — a bare mention in a comment string
    without the call parens does not count as running it."""
    pat = re.compile(r"(?<![\w$])" + re.escape(mechanism) + r"\(")
    return bool(pat.search(handler_text))


# Characters that, appearing immediately before a call, put it in an
# EXPRESSION position whose value is kept (assignment, argument, element,
# ternary, object value, arrow body, boolean/arith operand). A call preceded
# by one of these has its result CONSUMED, not discarded.
# NOTE: `{` is deliberately EXCLUDED. A call immediately preceded by `{` is a
# block statement start (`{ scopeFilterList(...); }`), i.e. a DISCARDED result,
# not an object-literal value — an object value is reached via its key `:` or a
# leading `,`, both of which ARE in this set. Including `{` would misread the
# M3 dead-call (a bare statement at a block start) as consumed.
_RESULT_CONSUMING_PREVS = set("=(,[:?&|><+-*/%")
# Keywords that, appearing immediately before a call, consume its value.
_RESULT_CONSUMING_KEYWORDS = ("return", "yield")


def _mechanism_result_consumed(mechanism: str, handler_text: str) -> bool:
    """DATAFLOW probe (Eta #1242 M3). True iff AT LEAST ONE call-shaped
    occurrence of `mechanism` in the handler slice has its RESULT CONSUMED —
    assigned, returned, or used as a subexpression — rather than discarded as
    a bare expression statement.

    The M3 blind spot: a door whose real filter was deleted but that still
    carried a dead `scopeFilterGet(oauthCtx, null);` (return value thrown away,
    the unscoped rows returned instead) passed the textual-presence rule. Here,
    a call whose result is discarded (statement-start, no assignment/return)
    does NOT count as consuming the mechanism.

    Conservative by design: it asks only whether the RESULT flows somewhere,
    not whether that somewhere is the returned rows specifically — a full
    taint trace is out of scope (see the TODO if this needs tightening). It
    closes the specific dead-unused-result case M3 named without a rewrite."""
    pat = re.compile(r"(?<![\w$])" + re.escape(mechanism) + r"\(")
    for m in pat.finditer(handler_text):
        idx = m.start()
        # Walk back over whitespace, then over an optional `await`/`void`
        # keyword (which does NOT itself consume the value), then whitespace.
        j = idx - 1
        while j >= 0 and handler_text[j] in " \t\n\r":
            j -= 1
        # Skip a leading `await`/`void` so `await scopeFilterGet(...)` as a
        # bare statement is still judged on what precedes the `await`.
        end = j + 1
        k = j
        while k >= 0 and (handler_text[k].isalnum() or handler_text[k] in "_$"):
            k -= 1
        word = handler_text[k + 1 : end]
        if word in ("await", "void"):
            j = k
            while j >= 0 and handler_text[j] in " \t\n\r":
                j -= 1
        if j < 0:
            # Start of the handler slice with no preceding token — a bare
            # leading statement, result discarded.
            continue
        prev = handler_text[j]
        if prev in _RESULT_CONSUMING_PREVS:
            return True
        # Preceding identifier/keyword (e.g. `return`/`yield`).
        end2 = j + 1
        k2 = j
        while k2 >= 0 and (handler_text[k2].isalnum() or handler_text[k2] in "_$"):
            k2 -= 1
        prev_word = handler_text[k2 + 1 : end2]
        if prev_word in _RESULT_CONSUMING_KEYWORDS:
            return True
        # Anything else (`;`, `{`, `}`, `)`, a bare identifier) → the call is a
        # discarded expression statement for this occurrence; keep scanning
        # for another occurrence that IS consumed.
    return False


def _classify_filtered(
    reason: str, handler_text: str, dataflow: bool = False
) -> tuple[bool, tuple[str, ...]]:
    """Per-door DECLARED-AND-VERIFIED rule for a `filtered` door. Returns
    (verified, named_mechanisms). `verified` is True iff the reason names at
    least one mechanism AND at least one named mechanism is present,
    call-shaped, in the handler slice. A reason that names no mechanism, or
    names only mechanism(s) absent from the handler (the LYING declaration),
    yields False.

    When `dataflow` is True (--dataflow mode, Eta #1242 M3), textual presence
    is not enough: at least one named mechanism must additionally have its
    RESULT CONSUMED (see `_mechanism_result_consumed`), so a dead call whose
    return value is discarded reads as UNGUARDED."""
    mechanisms = _reason_named_mechanisms(reason)
    if dataflow:
        verified = any(
            _mechanism_in_handler(m, handler_text)
            and _mechanism_result_consumed(m, handler_text)
            for m in mechanisms
        )
    else:
        verified = any(
            _mechanism_in_handler(m, handler_text) for m in mechanisms
        )
    return verified, mechanisms


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
    literal found at bracket depth 0 within the arg-text, or -- if that
    first depth-0 token is a bare identifier instead of a literal (a
    `const X_TOOL_NAME = "..."` constant passed by reference) -- that
    constant resolved via `const_table`."""
    i = 0
    n = len(slice_text)
    depth = 0
    while i < n:
        c = slice_text[i]
        if c == "/" and i + 1 < n and slice_text[i + 1] == "/":
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
            if ident in const_table:
                return const_table[ident]
            i = j
            continue
        i += 1
    return None


def scan_source(text: str, dataflow: bool = False) -> ScanResult:
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

            top_args = _split_top_level_args(call_slice)
            if top_args is None:
                result.unreadable.append(
                    f"{head}{name!r}...  (call argument list did not balance)"
                )
                start = close_idx + 1
                continue

            if head == "defineTool(":
                # Positional order: server, ctx, scope, name, description,
                # schema, [annotations], handler.
                if len(top_args) < 4:
                    result.unreadable.append(
                        f"{head}{name!r}...  (fewer than 4 positional args, "
                        f"cannot locate scope/name)"
                    )
                    start = close_idx + 1
                    continue
                scope_arg = top_args[2]
                handler_arg = top_args[-1]
                kind = _extract_kind(scope_arg)
                if kind is None:
                    result.unreadable.append(
                        f"{head}{name!r}...  (no `kind:` literal found in "
                        f"the scope argument)"
                    )
                    start = close_idx + 1
                    continue
                if kind == "filtered":
                    reason = _extract_reason(scope_arg)
                    verified, mechanisms = _classify_filtered(
                        reason, handler_arg, dataflow
                    )
                else:
                    verified, mechanisms = False, ()
                result.doors.append(
                    Door(
                        name=name,
                        kind=kind,
                        filtered_reason_verified=verified,
                        filtered_reason_mechanisms=mechanisms,
                    )
                )
            else:
                # Legacy `server.tool(name, ...)` overload carries no
                # structural ToolScope -- there is no declared kind to read,
                # so this door cannot be classified by the kind-based rule.
                # Refuse to judge rather than guess.
                result.unreadable.append(
                    f"{head}{name!r}...  (legacy server.tool() call carries "
                    f"no ToolScope; kind-based classification not possible)"
                )
            start = close_idx + 1
    return result


def derive_tool_names(text: str) -> list[str]:
    """Public helper (used by the test suite) — return every registered
    tool name found in the source, in file order, doors that could not be
    read excluded (callers must separately check unreadable count)."""
    return [d.name for d in scan_source(text).doors]


def classify_door(door: Door) -> str:
    """Return one of "guarded" / "unguarded" / "public" for a Door whose
    kind was successfully derived (Door.kind is not None)."""
    if door.kind == "public":
        return "public"
    if door.kind in ENVELOPE_GUARANTEED_KINDS:
        return "guarded"
    if door.kind == "filtered":
        return "guarded" if door.filtered_reason_verified else "unguarded"
    # An unrecognised kind string is not one of the five ToolScope members --
    # treat as unreadable-equivalent by classifying unguarded is wrong (that
    # would silently trust an unknown kind); callers should have already
    # filtered these via scan_source's own unreadable bucket. Kept defensive.
    return "unguarded"


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
    parser.add_argument(
        "--dataflow",
        action="store_true",
        help=(
            "Tighten the `filtered` rule (Eta #1242 M3): a named mechanism "
            "must also have its RESULT CONSUMED (not discarded) to count as "
            "guarded, closing the dead-unused-result blind spot."
        ),
    )
    args = parser.parse_args(argv)

    path = Path(args.path)
    if not path.exists():
        print(f"REFUSING TO JUDGE: {path} does not exist")
        print("guarded=0")
        print("unguarded=0")
        print("public=0")
        print("unreadable=1")
        print("total=0")
        return 2

    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError) as exc:
        print(f"REFUSING TO JUDGE: {path} could not be read as UTF-8 text ({exc})")
        print("guarded=0")
        print("unguarded=0")
        print("public=0")
        print("unreadable=1")
        print("total=0")
        return 2

    result = scan_source(text, dataflow=args.dataflow)
    buckets = [classify_door(d) for d in result.doors]
    guarded = buckets.count("guarded")
    unguarded = buckets.count("unguarded")
    public = buckets.count("public")
    unreadable = len(result.unreadable)
    total = len(result.doors) + unreadable

    if unreadable > 0:
        for entry in result.unreadable:
            print(f"REFUSING TO JUDGE: {entry}")

    print(f"guarded={guarded}")
    print(f"unguarded={unguarded}")
    print(f"public={public}")
    print(f"unreadable={unreadable}")
    print(f"total={total}")

    if unreadable > 0:
        return 2
    if args.baseline is not None and unguarded > args.baseline:
        # Name WHICH doors are unguarded — Door.name is populated, so a
        # baseline-exceeded failure must not leave the operator grepping the
        # source by hand (Eta #1242 correction (a)). List them in file order.
        offending = [
            d.name
            for d in result.doors
            if classify_door(d) == "unguarded"
        ]
        print(
            f"BASELINE EXCEEDED: {unguarded} unguarded door(s) > "
            f"baseline {args.baseline}"
        )
        print(f"unguarded doors: {', '.join(offending)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
