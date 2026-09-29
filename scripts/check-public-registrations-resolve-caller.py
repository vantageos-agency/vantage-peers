#!/usr/bin/env python3
"""check-public-registrations-resolve-caller.py -- the COUNTER for the sentence
"VantagePeers Cloud has no unauthenticated door".

WHY THIS EXISTS. Three earlier instruments each defined their POPULATION by the
SHAPE OF AN ARGUMENT (an org/namespace-looking parameter) or by a WRITE. A
no-argument list endpoint escaped all three BY CONSTRUCTION, and
`search.searchFixPatterns` -- a live leak -- escaped all three: a wrong
population, not an oversight. This instrument takes its population from the
REGISTRATION ITSELF:

    modules      = every `import type * as X from "../<mod>.js"` in
                   convex/_generated/api.d.ts          (the published surface)
    population   = every `export const X = query|mutation|action(` in them

It never looks at an argument to decide WHETHER a function is in the
population. (Arguments are read only AFTER a function is already counted, to
verify a declared credential -- see below.)

THREE STATES PER REGISTRATION, NEVER TWO:

  resolves-a-caller   the registration TRANSITIVELY reaches a Clerk-identity
                      resolver (`ctx.auth.getUserIdentity()`), following local
                      helpers, relative imports and `api.`/`internal.`
                      references, and no reachable code admits an anonymous
                      caller as master (`allowNoIdentityMaster: true`); OR it
                      DECLARES, at its own registration, the non-Clerk
                      credential that authenticates it and the instrument
                      VERIFIES that declaration (see DECLARATIONS).
  does-not-resolve    reaches no resolver and declares nothing -- ACCUSED. Also
                      the state of a site that reaches a resolver but admits an
                      anonymous caller as master.
  could-not-judge     the instrument cannot decide (opaque import edge, a
                      dynamic `allowNoIdentityMaster`, a declaration it cannot
                      verify, an unbalanced registration). An honest state; a
                      guess is not one. Exits non-zero.

COVERAGE IS ASSERTED, not assumed: resolves + does-not-resolve + could-not-judge
must equal the population, the lexer's population must equal an independent
naive extraction over the RAW bytes, every module named by api.d.ts must have
been read, and the population must be non-empty. Any breach exits 3 -- the
instrument fails on its OWN coverage, not only on its findings. A sweep that
iterated `Object.keys(api)` once returned [] because `api` is a Proxy and
PASSED on nothing (PR #1349); this one goes RED on nothing.

DECLARATIONS -- NO EXEMPTION LIST, NO BASELINE FILE. A registration that is
legitimately not gated by a Clerk identity says so IN ITS OWN LEADING COMMENT,
where a reader of the function sees it:

    // @credential <argName> <kind>: <why this argument is the credential>

  <argName>  must be a key of the registration's own `args` validator AND must
             be referenced by name in the registration's reachable code -- an
             argument nobody reads is not a credential.
  <kind>     one of CREDENTIAL_KINDS below. A kind not in that closed set is
             could-not-judge, never silently accepted.
  <why>      at least 20 characters.

and, for a function with no credential at all (a deliberate public surface):

    // @open <why>: at least 20 characters

An `@open` site is counted as declared-open, reported separately in the output
and NEVER folded into "resolves" or "accused". The declaration proves the
authors decided; it does not prove the decision is right, and the report says
so. A declaration is not a verification of the credential's strength (whether
the license key is checked against a stored value is the site's own test).

CAVEATS a reader must know so the output is never over-read:
  - "resolves" is REACHABILITY of a resolver, not dataflow: it does not prove the
    identity's absence is refused before rows are read. `allowNoIdentityMaster:
    true` is the one fail-open shape that is detected structurally.
  - Green here means "every published registration is gated or declared", NOT
    "every gate is sufficient".
  - Reading is done in Python on raw bytes. `convex/errorMonitorFilters.ts`
    contains a raw NUL byte, so `grep` treats it as BINARY and skips it
    silently; this instrument reads it and reports NUL counts per file.

Exit codes:  0 = every registration resolves or is declared, coverage complete
             1 = at least one ACCUSED (does-not-resolve) registration
             2 = at least one could-not-judge (and none accused)
             3 = COVERAGE / NON-VACUITY failure (overrides 1 and 2)
"""

from __future__ import annotations

import argparse
import json
import posixpath
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# The closed set of credential kinds a registration may declare. Each is a
# credential that is legitimately NOT a Clerk identity. A kind outside this set
# is could-not-judge (a credential nobody has classified needs a ruling).
CREDENTIAL_KINDS = frozenset(
    {
        # a shared fleet secret presented as an argument and compared, in
        # constant time, against a deployment env var; the compare throws
        "master-secret",
        # a purchased license key, looked up by hash in `licenses`
        "license-key",
        # a single-use OAuth authorization code, looked up in its own table
        "authorization-code",
        # a bearer/refresh token presented as its hash and looked up
        "token-hash",
        # an agent credential presented as a secret and resolved by hash
        "agent-credential",
    }
)
# Kinds verified by "the argument flows into a check function that reads an env
# secret and throws". Every other kind is verified as "the argument is consumed
# by a stored-record lookup (`withIndex`) reachable from the registration".
ENV_SECRET_KINDS = frozenset({"master-secret"})
# NOT in the set, on purpose: `hmac-signature`. Every HMAC-authenticated door in
# this repo is an `httpAction` (convex/http.ts), which is not a published
# query/mutation/action registration and so is outside the population by
# construction. A registration that wants that kind needs a ruling, and until it
# has one it is could-not-judge -- see the self-test.

MIN_WHY = 20

REG_HEADS = ("query", "mutation", "action")
REG_RE = re.compile(
    r"\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(query|mutation|action)\s*\("
)
# Independent extraction over the RAW text (no lexer) -- the cross-check.
NAIVE_REG_RE = re.compile(
    r"^export const ([A-Za-z_$][\w$]*)\s*=\s*(query|mutation|action)\b", re.M
)
API_IMPORT_RE = re.compile(
    r'^import type \* as [\w$]+ from "\.\./([^"]+)\.js";', re.M
)
RESOLVER_RE = re.compile(r"\bauth\s*\.\s*getUserIdentity\s*\(")
ANON_MASTER_RE = re.compile(r"(?<![\w$.?])allowNoIdentityMaster\b(?!\s*\?)")

# ---------------------------------------------------------------- lexer ----

_REGEX_PREV = set("([{,;=:!&|?+-*%<>~^\n")
# Characters that can change the lexer's state in normal (code) position. Every
# other character is copied through untouched, which is what makes this fast.
_SPECIAL = frozenset("/\"'`{}\x00")
_SPECIAL_RE = re.compile("[/\"'`{}\x00]")
_REGEX_KW = (
    "return", "typeof", "instanceof", "delete", "void", "case", "do", "else",
    "yield", "in", "of", "new", "await",
)


def mask_code(text: str) -> str:
    """Return `text` with every comment, string, template-text and regex-literal
    body replaced by spaces (newlines kept), so offsets are identical to the raw
    text. Template `${...}` expressions stay as CODE. NUL bytes become spaces."""
    n = len(text)
    out = list(text)
    i = 0
    # stack of brace counters for template `${` nesting
    tstack: list[int] = []
    in_tpl = False

    def blank(a: int, b: int) -> None:
        for k in range(a, b):
            if out[k] != "\n":
                out[k] = " "

    def prev_sig(idx: int) -> str:
        j = idx - 1
        while j >= 0 and text[j] in " \t\r":
            j -= 1
        return text[j] if j >= 0 else "\n"

    def looks_regex(idx: int) -> bool:
        p = prev_sig(idx)
        if p in _REGEX_PREV:
            return True
        j = idx - 1
        while j >= 0 and text[j] in " \t\r\n":
            j -= 1
        k = j
        while k >= 0 and (text[k].isalnum() or text[k] in "_$"):
            k -= 1
        return text[k + 1 : j + 1] in _REGEX_KW

    while i < n:
        c = text[i]
        if in_tpl:
            if c == "\\":
                blank(i, min(i + 2, n))
                i += 2
                continue
            if c == "`":
                blank(i, i + 1)
                in_tpl = False
                i += 1
                continue
            if c == "$" and i + 1 < n and text[i + 1] == "{":
                blank(i, i + 2)
                tstack.append(0)
                in_tpl = False
                i += 2
                continue
            blank(i, i + 1)
            i += 1
            continue
        if c not in _SPECIAL:
            nxt = _SPECIAL_RE.search(text, i)
            i = nxt.start() if nxt else n
            continue
        if c == "\x00":
            out[i] = " "
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            j = n if j < 0 else j
            blank(i, j)
            i = j
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            blank(i, j)
            i = j
            continue
        if c in "\"'":
            j = i + 1
            while j < n and text[j] != c and text[j] != "\n":
                j += 2 if text[j] == "\\" else 1
            blank(i, min(j + 1, n))
            i = j + 1
            continue
        if c == "`":
            blank(i, i + 1)
            in_tpl = True
            i += 1
            continue
        if c == "/" and looks_regex(i):
            j = i + 1
            in_cls = False
            while j < n and text[j] != "\n":
                d = text[j]
                if d == "\\":
                    j += 2
                    continue
                if d == "[":
                    in_cls = True
                elif d == "]":
                    in_cls = False
                elif d == "/" and not in_cls:
                    break
                j += 1
            blank(i, min(j + 1, n))
            i = j + 1
            continue
        if tstack:
            if c == "{":
                tstack[-1] += 1
            elif c == "}":
                if tstack[-1] == 0:
                    tstack.pop()
                    blank(i, i + 1)
                    in_tpl = True
                    i += 1
                    continue
                tstack[-1] -= 1
        i += 1
    return "".join(out)


def match_close(code: str, open_idx: int, o: str = "(", c: str = ")") -> int | None:
    depth = 0
    for k in range(open_idx, len(code)):
        ch = code[k]
        if ch == o:
            depth += 1
        elif ch == c:
            depth -= 1
            if depth == 0:
                return k
    return None


def split_top(code: str, a: int, b: int) -> list[tuple[int, int]]:
    """Split code[a:b] on depth-0 commas -> list of (start, end) spans."""
    spans, depth, start = [], 0, a
    for k in range(a, b):
        ch = code[k]
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch == "," and depth == 0:
            spans.append((start, k))
            start = k + 1
    if code[start:b].strip():
        spans.append((start, b))
    return spans


# --------------------------------------------------------------- model ----


@dataclass
class Module:
    name: str  # "tasks", "lib/auth"
    raw: str
    code: str
    nbytes: int
    nul: int
    segments: dict[str, tuple[int, int]] = field(default_factory=dict)
    imports: dict[str, tuple[str, str]] = field(default_factory=dict)  # local -> (mod, name)


@dataclass
class Reg:
    module: str
    name: str
    kind: str
    start: int
    end: int  # of the registration call's closing paren
    stmt_start: int
    arg_keys: list[str] = field(default_factory=list)
    state: str = ""
    via: str = ""
    reason: str = ""
    witness: list[str] = field(default_factory=list)

    @property
    def ident(self) -> str:
        return f"{self.module}.{self.name}"


SEG_HEAD_RE = re.compile(
    r"^(?:export\s+)?(?:default\s+)?(?:declare\s+)?"
    r"(?:async\s+function\s*\*?\s*([A-Za-z_$][\w$]*)"
    r"|function\s*\*?\s*([A-Za-z_$][\w$]*)"
    r"|(?:const|let|var)\s+([A-Za-z_$][\w$]*))"
)


def segment_module(code: str) -> dict[str, tuple[int, int]]:
    """Top-level statements keyed by declared name. A statement starts on a
    column-0 line while bracket depth is 0."""
    segs: dict[str, tuple[int, int]] = {}
    depth = 0
    n = len(code)
    starts: list[int] = []
    line_start = 0
    while line_start <= n:
        nl = code.find("\n", line_start)
        line_end = n if nl < 0 else nl
        if depth == 0 and line_start < n and code[line_start] not in " \t\n})];,":
            starts.append(line_start)
        seg = code[line_start:line_end]
        depth += (
            seg.count("(") + seg.count("[") + seg.count("{")
            - seg.count(")") - seg.count("]") - seg.count("}")
        )
        if nl < 0:
            break
        line_start = nl + 1
    starts.append(n)
    for a, b in zip(starts, starts[1:]):
        m = SEG_HEAD_RE.match(code[a:b])
        if m:
            name = m.group(1) or m.group(2) or m.group(3)
            segs.setdefault(name, (a, b))
    return segs


IMPORT_RE = re.compile(r"\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*\"([^\"]+)\"")


def parse_imports(raw: str, code: str, modname: str) -> dict[str, tuple[str, str]]:
    """Relative named imports. Read from RAW (the module specifier is a string)
    but only accepted where the `import` keyword itself is real code."""
    res: dict[str, tuple[str, str]] = {}
    for m in IMPORT_RE.finditer(raw):
        if code[m.start() : m.start() + 6] != "import":
            continue  # inside a comment or string
        spec = m.group(2)
        if not spec.startswith("."):
            continue
        target = posixpath.normpath(posixpath.join(posixpath.dirname(modname), spec))
        for part in m.group(1).split(","):
            part = part.strip()
            if not part:
                continue
            part = re.sub(r"^type\s+", "", part)
            if " as " in part:
                orig, local = [x.strip() for x in part.split(" as ", 1)]
            else:
                orig = local = part
            res[local] = (re.sub(r"\.js$", "", target), orig)
    return res


def load_module(root: Path, name: str) -> Module | None:
    p = root / f"{name}.ts"
    if not p.is_file():
        return None
    data = p.read_bytes()
    raw = data.decode("utf-8", "surrogateescape")
    code = mask_code(raw)
    m = Module(name, raw, code, len(data), data.count(b"\x00"))
    m.segments = segment_module(code)
    m.imports = parse_imports(raw, code, name)
    return m


# ---------------------------------------------------------- extraction ----


def api_modules(api_dts: Path) -> list[str]:
    txt = api_dts.read_text()
    return API_IMPORT_RE.findall(txt)


def leading_comment(raw: str, stmt_start: int) -> str:
    """The contiguous `//` / `/* */` comment block directly above a statement."""
    lines = raw[:stmt_start].split("\n")
    lines.pop()  # the (empty) remainder of the statement's own line
    block: list[str] = []
    in_block = False
    for ln in reversed(lines):
        s = ln.strip()
        if in_block:
            block.append(s)
            if s.startswith("/*") or s.startswith("/**"):
                in_block = False
            continue
        if s.startswith("//"):
            block.append(s)
        elif s.endswith("*/"):
            block.append(s)
            if not (s.startswith("/*") or s.startswith("/**")):
                in_block = True
        else:
            break
    return "\n".join(reversed(block))


def extract_regs(mod: Module) -> list[Reg]:
    regs: list[Reg] = []
    for m in REG_RE.finditer(mod.code):
        open_idx = m.end() - 1
        close = match_close(mod.code, open_idx)
        line_start = mod.code.rfind("\n", 0, m.start()) + 1
        r = Reg(mod.name, m.group(1), m.group(2), open_idx, close if close else -1, line_start)
        if close is None:
            r.state = "could-not-judge"
            r.reason = "registration call has unbalanced parentheses"
        else:
            r.arg_keys = arg_keys(mod.code, open_idx, close)
        regs.append(r)
    return regs


def arg_keys(code: str, o: int, c: int) -> list[str]:
    """Top-level keys of the registration's `args` validator (read only to
    verify a declared credential, never to decide population)."""
    body = code[o + 1 : c]
    ob = body.find("{")
    if ob < 0:
        return []
    ce = match_close(body, ob, "{", "}")
    if ce is None:
        return []
    for a, b in split_top(body, ob + 1, ce):
        seg = body[a:b]
        m = re.match(r"\s*args\s*:\s*", seg)
        if m:
            vs = a + m.end()
            if body[vs : vs + 1] == "{":
                ve = match_close(body, vs, "{", "}")
                if ve is not None:
                    keys = []
                    for x, y in split_top(body, vs + 1, ve):
                        km = re.match(r"\s*([A-Za-z_$][\w$]*)\s*:", body[x:y])
                        if km:
                            keys.append(km.group(1))
                    return keys
    return []


# ------------------------------------------------------------- closure ----

REF_KINDS = ("call", "pass")


def strip_scheduler(code: str) -> str:
    """Identity does NOT propagate through `scheduler.runAfter/runAt`; references
    inside such a call are not an edge that carries the caller."""
    out = list(code)
    for m in re.finditer(r"\bscheduler\s*\.\s*run(?:After|At)\s*\(", code):
        o = m.end() - 1
        c = match_close(code, o)
        if c:
            for k in range(o + 1, c):
                if out[k] != "\n":
                    out[k] = " "
    return "".join(out)


IDENT_RE = re.compile(r"(?<![\w$.])([A-Za-z_$][\w$]*)")
API_REF_RE = re.compile(r"(?<![\w$.])(?:api|internal)\s*\.\s*([\w$]+(?:\s*\.\s*[\w$]+)+)")


class Graph:
    def __init__(self, mods: dict[str, Module]):
        self.mods = mods
        self._edges: dict[tuple[str, str], list[tuple[str, str]]] = {}
        self._opaque: dict[tuple[str, str], list[str]] = {}

    def node_text(self, node: tuple[str, str]) -> str | None:
        m = self.mods.get(node[0])
        if not m or node[1] not in m.segments:
            return None
        a, b = m.segments[node[1]]
        return strip_scheduler(m.code[a:b])

    def resolve_name(self, modname: str, ident: str) -> tuple[str, str] | None:
        m = self.mods[modname]
        if ident in m.segments:
            return (modname, ident)
        imp = m.imports.get(ident)
        if imp:
            return imp
        return None

    def edges(self, node: tuple[str, str]) -> tuple[list[tuple[str, str]], list[str]]:
        if node in self._edges:
            return self._edges[node], self._opaque[node]
        text = self.node_text(node)
        edges: list[tuple[str, str]] = []
        opaque: list[str] = []
        if text is not None:
            modname = node[0]
            m = self.mods[modname]
            for im in IDENT_RE.finditer(text):
                ident = im.group(1)
                if ident == node[1]:
                    continue
                after = text[im.end() :].lstrip()[:1]
                before = text[: im.start()].rstrip()[-1:]
                is_call = after == "("
                is_pass = before in ("(", ",", "=", ":") and after in (")", ",")
                if not (is_call or is_pass):
                    continue
                tgt = self.resolve_name(modname, ident)
                if tgt is None:
                    continue
                if tgt[0] == modname:
                    edges.append(tgt)
                else:
                    tm = self.mods.get(tgt[0])
                    if tm is None:
                        # relative import to a file we did not load
                        if not re.search(r"(^|/)(_generated|schema)(/|$)", tgt[0]):
                            opaque.append(f"{ident} <- {tgt[0]}")
                    elif tgt[1] not in tm.segments:
                        opaque.append(f"{ident} <- {tgt[0]} (symbol not found)")
                    else:
                        edges.append(tgt)
            for am in API_REF_RE.finditer(text):
                parts = [p.strip() for p in am.group(1).split(".")]
                for cut in range(len(parts) - 1, 0, -1):
                    modn = "/".join(parts[:cut])
                    fn = parts[cut] if cut < len(parts) else None
                    if fn and modn in self.mods and fn in self.mods[modn].segments:
                        edges.append((modn, fn))
                        break
        self._edges[node] = edges
        self._opaque[node] = opaque
        return edges, opaque

    def closure(self, start: tuple[str, str]) -> tuple[list[tuple[str, str]], dict[tuple[str, str], tuple[str, str] | None]]:
        seen = {start: None}
        order = [start]
        q = [start]
        while q:
            cur = q.pop(0)
            es, _ = self.edges(cur)
            for e in es:
                if e not in seen:
                    seen[e] = cur
                    order.append(e)
                    q.append(e)
        return order, seen


def witness_path(seen: dict, node: tuple[str, str]) -> list[str]:
    path = []
    cur: tuple[str, str] | None = node
    while cur is not None:
        path.append(f"{cur[0]}.{cur[1]}")
        cur = seen[cur]
    return list(reversed(path))


# ---------------------------------------------------------- classifying ----

OPEN_RE = re.compile(r"@open\b\s*(.*)")
CRED_RE = re.compile(r"@credential\s+([A-Za-z_$][\w$]*)\s+([\w-]+)\s*:\s*(.*)")


def strip_comment_marks(block: str) -> str:
    return "\n".join(re.sub(r"^\s*(//+|/\*+|\*+/?)\s?", "", ln) for ln in block.split("\n"))


def classify(reg: Reg, graph: Graph, mods: dict[str, Module]) -> None:
    if reg.state == "could-not-judge":
        return
    mod = mods[reg.module]
    node = (reg.module, reg.name)
    order, seen = graph.closure(node)
    opaque: list[str] = []
    for nd in order:
        opaque += graph.edges(nd)[1]

    # 1. structural anonymous-master shape anywhere reachable -- checked FIRST, so no
    #    declaration can launder a fail-open into a pass
    for nd in order:
        t = graph.node_text(nd) or ""
        for am in ANON_MASTER_RE.finditer(t):
            tail = t[am.end() :].lstrip()
            if tail.startswith(":"):
                val = re.match(r":\s*([^,}\s]+)", tail)
                v = val.group(1) if val else ""
                if v == "true":
                    reg.state = "does-not-resolve"
                    reg.via = "admits-anonymous-as-master"
                    reg.reason = f"{nd[0]}.{nd[1]} passes allowNoIdentityMaster: true"
                    reg.witness = witness_path(seen, nd)
                    return
                if v != "false":
                    return _cnj(reg, f"{nd[0]}.{nd[1]} passes a dynamic allowNoIdentityMaster ({v!r})")
            elif tail[:1] in (",", "}"):
                return _cnj(reg, f"{nd[0]}.{nd[1]} passes allowNoIdentityMaster by shorthand")

    # 2. declarations, at the registration itself (never checked before the above)
    decl_text = strip_comment_marks(leading_comment(mod.raw, reg.stmt_start))
    cred = CRED_RE.search(decl_text)
    opn = OPEN_RE.search(decl_text)
    if cred:
        arg, kind, why = cred.group(1), cred.group(2), cred.group(3).strip()
        if kind not in CREDENTIAL_KINDS:
            return _cnj(reg, f"declares credential kind `{kind}` which is not in the classified set {sorted(CREDENTIAL_KINDS)} -- needs a ruling")
        if len(why) < MIN_WHY:
            return _cnj(reg, f"@credential declaration for `{arg}` gives no reason (>= {MIN_WHY} chars required)")
        if arg not in reg.arg_keys:
            return _cnj(reg, f"@credential names `{arg}` which is not a key of this registration's `args`")
        bad = verify_credential(kind, arg, node, order, graph)
        if bad:
            return _cnj(reg, f"@credential {arg} {kind}: {bad}")
        reg.state, reg.via, reg.reason = "resolves-a-caller", f"credential:{kind}:{arg}", why
        return
    if opn:
        why = opn.group(1).strip().lstrip(":").strip()
        if len(why) < MIN_WHY:
            return _cnj(reg, f"@open declaration gives no reason (>= {MIN_WHY} chars required)")
        reg.state, reg.via, reg.reason = "resolves-a-caller", "declared-open", why
        return

    # 3. reachability of a Clerk-identity resolver whose result is GATED (the
    #    resolved value is null-tested in the same function). A resolver whose
    #    result is only read for attribution (`(await ctx.auth.getUserIdentity())
    #    ?.subject`) consults the principal and discards it -- not a gate.
    weak: list[str] = []
    for nd in order:
        t = graph.node_text(nd) or ""
        if not RESOLVER_RE.search(t):
            continue
        if gate_shaped(t):
            reg.state, reg.via = "resolves-a-caller", "clerk-identity"
            reg.witness = witness_path(seen, nd)
            return
        weak.append(f"{nd[0]}.{nd[1]}")
    if weak:
        reg.state, reg.via = "does-not-resolve", "identity-consulted-not-gated"
        reg.reason = "getUserIdentity reached but never null-tested in: " + ", ".join(weak)
        return

    # 4. nothing reached: accused, unless an edge was opaque
    if opaque:
        return _cnj(reg, "reaches no resolver but has opaque edges: " + "; ".join(sorted(set(opaque))[:4]))
    reg.state, reg.via = "does-not-resolve", "no-resolver-reachable"


def _word(name: str) -> str:
    return r"(?<![\w$])" + re.escape(name) + r"(?![\w$])"


def verify_credential(kind: str, arg: str, node: tuple[str, str], order: list, graph: Graph) -> str:
    """Return "" when the declared credential is really exercised by the code,
    else the reason it is not. A declaration alone never earns the state."""
    own = graph.node_text(node) or ""
    used_in_own = len(re.findall(_word(arg), own)) >= 2  # 1 = the validator key
    used_elsewhere = any(
        nd != node and re.search(_word(arg), graph.node_text(nd) or "") for nd in order
    )
    if not (used_in_own or used_elsewhere):
        return f"nothing reachable reads `{arg}`"
    if kind in ENV_SECRET_KINDS:
        # the argument must be handed to a function that reads an env secret
        # and refuses (throws) -- `requireMasterAuth(args.callerToken)`.
        for m in re.finditer(r"(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(\s*(?:args\s*\.\s*)?" + re.escape(arg) + r"\b", own):
            tgt = graph.resolve_name(node[0], m.group(1))
            t = graph.node_text(tgt) if tgt else None
            if t and "process.env" in t and re.search(r"\bthrow\b", t):
                return ""
        return f"`{arg}` never reaches a function that reads process.env and throws"
    # lookup kinds: the presented value must be consumed by a stored-record lookup
    if any("withIndex(" in (graph.node_text(nd) or "") for nd in order):
        return ""
    return f"`{arg}` is read but no stored-record lookup (`withIndex`) is reachable"


BIND_RE = re.compile(
    r"(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*\(*\s*(?:await\s*)?\(*\s*[\w$.]*auth\s*\.\s*getUserIdentity\s*\("
)


def gate_shaped(text: str) -> bool:
    """True when some `getUserIdentity()` result in `text` is bound to a name
    that is then null-tested (`!x`, `x === null`, `x == undefined`, ...), or the
    call itself is null-tested inline."""
    for m in BIND_RE.finditer(text):
        n = re.escape(m.group(1))
        if re.search(
            rf"(?<![\w$.])!\s*{n}\b|(?<![\w$.]){n}\s*(?:===|==|!==|!=)\s*(?:null|undefined)\b"
            rf"|\b(?:null|undefined)\s*(?:===|==|!==|!=)\s*{n}\b|(?<![\w$.]){n}\s*\?\s*[^.:]",
            text,
        ):
            return True
    for m in RESOLVER_RE.finditer(text):
        before = text[max(0, m.start() - 12) : m.start()]
        after = text[m.end() : m.end() + 40]
        if re.search(r"!\s*\(*\s*(?:await\s*)?[\w$.]*$", before) or re.match(r"\)*\s*(?:===|==|!==|!=)\s*(?:null|undefined)", after):
            return True
    return False


def _cnj(reg: Reg, why: str) -> None:
    reg.state, reg.via, reg.reason = "could-not-judge", "", why


# ------------------------------------------------------------------ run ----


THREE_STATES = ("resolves-a-caller", "does-not-resolve", "could-not-judge")


def partition_errors(regs: list[Reg]) -> list[str]:
    """The union of the three states must EQUAL the population: no registration
    may be left without a state, and none may carry a fourth."""
    outside = [r.ident for r in regs if r.state not in THREE_STATES]
    if outside:
        return [
            f"COVERAGE: {len(outside)} registration(s) outside the three states "
            f"(union {len(regs) - len(outside)} != population {len(regs)}): {outside[:5]}"
        ]
    return []


@dataclass
class Result:
    regs: list[Reg]
    modules_listed: list[str]
    modules_read: list[str]
    modules_missing: list[str]
    unlisted_with_registrations: list[str]
    naive_pop: int
    nul: dict[str, int]
    coverage_errors: list[str]
    bytes_read: int


def run(convex_dir: Path, api_dts: Path, classifier=None) -> Result:
    listed = api_modules(api_dts)
    mods: dict[str, Module] = {}
    missing: list[str] = []
    for name in listed:
        m = load_module(convex_dir, name)
        if m is None:
            missing.append(name)
        else:
            mods[name] = m
    # Every other .ts module (helpers, lib) is loaded so the call graph can
    # follow imports into modules api.d.ts does not publish.
    for p in sorted(convex_dir.rglob("*.ts")):
        rel = p.relative_to(convex_dir).with_suffix("")
        name = str(rel)
        if name.startswith("_generated") or name.endswith(".test") or name in mods:
            continue
        m = load_module(convex_dir, name)
        if m is not None:
            mods[name] = m
    published = [n for n in listed if n in mods]

    # tree modules that register public functions but api.d.ts does not list:
    # the published surface is generated from the TREE at deploy, so a stale
    # api.d.ts must not hide them.
    unlisted = sorted(
        n for n, m in mods.items() if n not in listed and NAIVE_REG_RE.search(m.raw)
    )
    pop_modules = published + unlisted

    regs: list[Reg] = []
    for name in pop_modules:
        regs += extract_regs(mods[name])

    naive = 0
    naive_set: set[str] = set()
    for name in pop_modules:
        for mm in NAIVE_REG_RE.finditer(mods[name].raw):
            naive += 1
            naive_set.add(f"{name}.{mm.group(1)}")
    lex_set = {r.ident for r in regs}

    graph = Graph(mods)
    for r in regs:
        (classifier or classify)(r, graph, mods)

    errs: list[str] = []
    if not listed:
        errs.append("NON-VACUITY: api.d.ts named zero modules")
    if not published:
        errs.append("NON-VACUITY: zero api.d.ts modules could be read")
    if not regs:
        errs.append("NON-VACUITY: population is empty -- extraction matched nothing")
    if lex_set != naive_set or len(regs) != naive:
        errs.append(
            "COVERAGE: lexer population != independent raw extraction "
            f"(lexer={len(regs)} raw={naive}; only-lexer={sorted(lex_set - naive_set)[:5]} "
            f"only-raw={sorted(naive_set - lex_set)[:5]})"
        )
    errs += partition_errors(regs)
    if len({r.ident for r in regs}) != len(regs):
        errs.append("COVERAGE: duplicate registration identities in population")

    nul = {n: mods[n].nul for n in mods if mods[n].nul}
    return Result(regs, listed, published, missing, unlisted, naive, nul, errs, sum(m.nbytes for m in mods.values()))


def summarize(res: Result) -> dict:
    by = {"resolves-a-caller": [], "does-not-resolve": [], "could-not-judge": []}
    for r in res.regs:
        by.setdefault(r.state, []).append(r)
    via: dict[str, int] = {}
    for r in res.regs:
        key = r.via.split(":")[0] if r.state == "resolves-a-caller" else r.state + ":" + r.via
        via[key] = via.get(key, 0) + 1
    return {
        "population": len(res.regs),
        "resolves-a-caller": len(by["resolves-a-caller"]),
        "does-not-resolve": len(by["does-not-resolve"]),
        "could-not-judge": len(by["could-not-judge"]),
        "breakdown": dict(sorted(via.items())),
        "modules_listed": len(res.modules_listed),
        "modules_read": len(res.modules_read),
        "modules_missing": res.modules_missing,
        "unlisted_modules_with_public_registrations": res.unlisted_with_registrations,
        "nul_bytes": res.nul,
        "coverage_errors": res.coverage_errors,
    }


def exit_code(res: Result) -> int:
    if res.coverage_errors:
        return 3
    s = summarize(res)
    if s["does-not-resolve"]:
        return 1
    if s["could-not-judge"]:
        return 2
    return 0


def report(res: Result, verbose: bool) -> None:
    s = summarize(res)
    print("check-public-registrations-resolve-caller")
    print(f"  modules named by api.d.ts : {s['modules_listed']}  (read: {s['modules_read']}, missing on disk: {s['modules_missing']})")
    print(f"  unlisted modules registering public fns (stale api.d.ts): {s['unlisted_modules_with_public_registrations']}")
    print(f"  NUL bytes (grep would skip these files): {s['nul_bytes']}")
    print(f"  POPULATION (registrations)            : {s['population']}   (independent raw extraction: {res.naive_pop})")
    print(f"  resolves-a-caller                     : {s['resolves-a-caller']}")
    print(f"  does-not-resolve (ACCUSED)            : {s['does-not-resolve']}")
    print(f"  could-not-judge                       : {s['could-not-judge']}")
    for k, v in s["breakdown"].items():
        print(f"      {k}: {v}")
    for st in ("does-not-resolve", "could-not-judge"):
        rows = [r for r in res.regs if r.state == st]
        if rows:
            print(f"\n{st.upper()}:")
            for r in rows:
                extra = f"  [{r.via}] {r.reason}" if (r.reason or r.via) else ""
                print(f"  {r.kind:8} convex/{r.module}.ts::{r.name}{extra}")
    if verbose:
        print("\nRESOLVES:")
        for r in res.regs:
            if r.state == "resolves-a-caller":
                print(f"  {r.kind:8} convex/{r.module}.ts::{r.name}  [{r.via}]  {' > '.join(r.witness) if r.witness else r.reason}")
    for e in res.coverage_errors:
        print(f"\nCOVERAGE FAILURE: {e}")
    print(f"\nexit {exit_code(res)}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--convex-dir", default="convex")
    ap.add_argument("--api", default=None, help="path to api.d.ts (default <convex-dir>/_generated/api.d.ts)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args(argv)
    if a.self_test:
        return self_test()
    cdir = Path(a.convex_dir)
    api = Path(a.api) if a.api else cdir / "_generated" / "api.d.ts"
    if not api.is_file():
        print(f"api.d.ts not found at {api}", file=sys.stderr)
        return 3
    res = run(cdir, api)
    if a.json:
        out = summarize(res)
        out["registrations"] = [
            {"id": r.ident, "kind": r.kind, "state": r.state, "via": r.via, "reason": r.reason, "witness": r.witness}
            for r in res.regs
        ]
        out["exit"] = exit_code(res)
        print(json.dumps(out, indent=1))
    else:
        report(res, a.verbose)
    return exit_code(res)


# ------------------------------------------------------------ self-test ----

_FIXTURE_API = 'import type * as m from "../m.js";\nimport type * as n from "../n.js";\n'
_FIXTURE_LIB = """import { query, mutation } from "./_generated/server";
export async function guard(ctx: any) {
\tconst identity = await ctx.auth.getUserIdentity();
\tif (!identity) throw new Error("no");
\treturn identity;
}
"""
_FIXTURE_M = """import { guard } from "./lib";
import { query, mutation, action } from "./_generated/server";

export const gated = query({
\targs: {},
\thandler: async (ctx) => {
\t\tawait guard(ctx);
\t\treturn [];
\t},
});

export const leaky = query({
\targs: {},
\thandler: async (ctx) => ctx.db.query("t").collect(),
});

// @credential licenseKey license-key: the license key is the only bearer here
export const declared = mutation({
\targs: { licenseKey: v.string() },
\thandler: async (ctx, args) => ctx.db.query("l").withIndex("by_key", (q) => q.eq("k", args.licenseKey)).first(),
});

// @open a deliberately public health probe with no data
export const probe = query({
\targs: {},
\thandler: async () => "ok",
});

export const opaque = query({
\targs: {},
\thandler: async (ctx) => mystery(ctx),
});
"""
_FIXTURE_N = """import { query } from "./_generated/server";
export const ghost = query({ args: {}, handler: async () => 1 });
"""


def _write_tree(root: Path, m_text: str, lib_text: str = _FIXTURE_LIB, n_text: str = _FIXTURE_N, api: str = _FIXTURE_API) -> Path:
    (root / "_generated").mkdir(parents=True, exist_ok=True)
    (root / "_generated" / "api.d.ts").write_text(api)
    (root / "lib.ts").write_text(lib_text)
    (root / "m.ts").write_text(m_text)
    (root / "n.ts").write_text(n_text)
    return root


def self_test() -> int:
    import tempfile

    fails: list[str] = []

    def check(cond: bool, label: str) -> None:
        print(f"  {'ok  ' if cond else 'FAIL'} {label}")
        if not cond:
            fails.append(label)

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        # the `opaque` fixture registration calls an identifier that is a
        # relative import into a file that does not exist -> could-not-judge
        m_text = _FIXTURE_M.replace(
            'import { guard } from "./lib";',
            'import { guard } from "./lib";\nimport { mystery } from "./missing";',
        )
        _write_tree(root, m_text)
        res = run(root, root / "_generated" / "api.d.ts")
        st = {r.name: r.state for r in res.regs}
        via = {r.name: r.via for r in res.regs}
        print("three states reachable, one fixture each:")
        check(st.get("gated") == "resolves-a-caller" and via["gated"] == "clerk-identity", "gated -> resolves-a-caller (transitive, through an import)")
        check(st.get("leaky") == "does-not-resolve", "leaky -> does-not-resolve")
        check(st.get("opaque") == "could-not-judge", "opaque -> could-not-judge")
        check(st.get("declared") == "resolves-a-caller" and via["declared"].startswith("credential:license-key"), "declared credential verified -> resolves-a-caller")
        check(st.get("probe") == "resolves-a-caller" and via["probe"] == "declared-open", "declared open -> counted as declared-open")
        check(st.get("ghost") == "does-not-resolve", "ghost (n.ts) -> does-not-resolve")
        check(len(res.regs) == 6 and not res.coverage_errors, "coverage holds on the healthy fixture (6 = 6)")
        check(exit_code(res) == 1, "accused present -> exit 1")

        print("bipolar: known-unguarded registration RED, closed GREEN:")
        red = run(_write_tree(root, _FIXTURE_M.replace("mystery(ctx)", "guard(ctx)"), n_text=_FIXTURE_N), root / "_generated" / "api.d.ts")
        check(exit_code(red) == 1 and any(r.name == "leaky" and r.state == "does-not-resolve" for r in red.regs), "tree with leaky registration -> exit 1")
        closed_m = _FIXTURE_M.replace("mystery(ctx)", "guard(ctx)").replace(
            'handler: async (ctx) => ctx.db.query("t").collect(),',
            'handler: async (ctx) => { await guard(ctx); return ctx.db.query("t").collect(); },',
        )
        closed_n = _FIXTURE_N.replace("export const ghost", "// @open a deliberately public status counter\nexport const ghost")
        green = run(_write_tree(root, closed_m, n_text=closed_n), root / "_generated" / "api.d.ts")
        check(exit_code(green) == 0 and not green.coverage_errors, "leaky guarded + ghost declared -> exit 0")

        print("declaration verification:")
        bad_kind = closed_m.replace("license-key", "vibes")
        r1 = run(_write_tree(root, bad_kind, n_text=closed_n), root / "_generated" / "api.d.ts")
        check({r.name: r.state for r in r1.regs}["declared"] == "could-not-judge", "unclassified credential kind -> could-not-judge")
        unread = closed_m.replace("args.licenseKey", "1")
        r2 = run(_write_tree(root, unread, n_text=closed_n), root / "_generated" / "api.d.ts")
        check({r.name: r.state for r in r2.regs}["declared"] == "could-not-judge", "credential arg nobody reads -> could-not-judge")
        wrong_arg = closed_m.replace("@credential licenseKey", "@credential nothing")
        r3 = run(_write_tree(root, wrong_arg, n_text=closed_n), root / "_generated" / "api.d.ts")
        check({r.name: r.state for r in r3.regs}["declared"] == "could-not-judge", "credential arg absent from args -> could-not-judge")
        short_open = closed_n.replace("a deliberately public status counter", "public")
        r4 = run(_write_tree(root, closed_m, n_text=short_open), root / "_generated" / "api.d.ts")
        check({r.name: r.state for r in r4.regs}["ghost"] == "could-not-judge", "@open with no reason -> could-not-judge")
        anon = closed_m.replace("await guard(ctx);", "await guard(ctx); await withOrgScope(ctx, { allowNoIdentityMaster: true });", 1)
        r5 = run(_write_tree(root, anon, n_text=closed_n), root / "_generated" / "api.d.ts")
        check({r.name: r.state for r in r5.regs}["gated"] == "does-not-resolve", "resolver reached but allowNoIdentityMaster: true -> does-not-resolve")

        print("coverage assertion fires (exit 3):")
        empty_api = _FIXTURE_API.replace("m.js", "gone.js").replace("n.js", "gone2.js")
        r6 = run(_write_tree(root, closed_m, n_text=closed_n, api=empty_api), root / "_generated" / "api.d.ts")
        check(exit_code(r6) == 3 and any("NON-VACUITY" in e for e in r6.coverage_errors), "api.d.ts naming unreadable modules -> non-vacuity, exit 3")
        r7 = run(_write_tree(root, closed_m, n_text=closed_n, api="// no imports at all\n"), root / "_generated" / "api.d.ts")
        check(exit_code(r7) == 3 and any("named zero modules" in e for e in r7.coverage_errors), "api.d.ts naming zero modules -> exit 3")
        # a registration only the raw extractor sees: alias form the lexer cannot open
        alias = closed_m + "\nexport const aliased = query\n"
        r8 = run(_write_tree(root, alias, n_text=closed_n), root / "_generated" / "api.d.ts")
        check(exit_code(r8) == 3 and any("independent raw extraction" in e for e in r8.coverage_errors), "population disagrees with raw extraction -> exit 3")
        # a registration that only appears in a comment must NOT enter the population
        commented = closed_m + "\n// export const phantom = query({})\n"
        r9 = run(_write_tree(root, commented, n_text=closed_n), root / "_generated" / "api.d.ts")
        check(len(r9.regs) == 6 and exit_code(r9) == 0, "commented-out registration is not population")
        # NUL byte in a string is read, not skipped
        nul_m = closed_m + '\nexport const withNul = query({ args: {}, handler: async (ctx) => { await guard(ctx); return ["a", "b"].join("\\u0000"); } });\n'
        (root / "m.ts").write_bytes((_write_tree(root, nul_m, n_text=closed_n) / "m.ts").read_bytes().replace(b"\\u0000", b"\x00"))
        r10 = run(root, root / "_generated" / "api.d.ts")
        check(any(r.name == "withNul" for r in r10.regs) and r10.nul.get("m") == 1, "raw NUL byte: file still read, registration counted, NUL reported")

    with tempfile.TemporaryDirectory() as td2:
        root2 = Path(td2)
        (root2 / "_generated").mkdir()
        (root2 / "_generated" / "api.d.ts").write_text('import type * as k from "../k.js";\n')
        k_text = """import { query, mutation, internalQuery } from "./_generated/server";

async function requireSecret(token: string) {
\tconst s = process.env.SECRET;
\tif (token !== s) throw new Error("no");
}

async function attribution(ctx: any) {
\treturn (await ctx.auth.getUserIdentity())?.subject ?? "anon";
}

export const bridge = internalQuery({
\targs: {},
\thandler: async (ctx) => {
\t\tconst identity = await ctx.auth.getUserIdentity();
\t\tif (!identity) throw new Error("no");
\t\treturn identity.subject;
\t},
});

// @credential callerToken master-secret: the master secret is compared by requireSecret before any read
export const secretGood = mutation({
\targs: { callerToken: v.string() },
\thandler: async (ctx, args) => {
\t\tawait requireSecret(args.callerToken);
\t\treturn 1;
\t},
});

// @credential callerToken master-secret: the master secret is compared by requireSecret before any read
export const secretNeverChecked = mutation({
\targs: { callerToken: v.string() },
\thandler: async (ctx, args) => {
\t\tconsole.log(args.callerToken);
\t\treturn 1;
\t},
});

export const attributionOnly = query({
\targs: {},
\thandler: async (ctx) => {
\t\tconst who = await attribution(ctx);
\t\treturn ctx.db.query("t").collect();
\t},
});

export const viaBridge = query({
\targs: {},
\thandler: async (ctx) => {
\t\tawait ctx.runQuery(internal.k.bridge, {});
\t\treturn 1;
\t},
});

export const viaScheduler = mutation({
\targs: {},
\thandler: async (ctx) => {
\t\tawait ctx.scheduler.runAfter(0, internal.k.bridge, {});
\t\treturn 1;
\t},
});

// @credential licenseKey license-key: a lookup key held by the buyer, matched against stored rows
export const licenseLookup = query({
\targs: { licenseKey: v.string() },
\thandler: async (ctx, args) => ctx.db.query("l").withIndex("by_key", (q) => q.eq("k", args.licenseKey)).unique(),
});

// @credential licenseKey license-key: a lookup key held by the buyer, matched against stored rows
export const licenseNoLookup = query({
\targs: { licenseKey: v.string() },
\thandler: async (ctx, args) => ctx.db.query("l").collect().then((r) => [args.licenseKey, r]),
});
"""
        (root2 / "k.ts").write_text(k_text)
        r = run(root2, root2 / "_generated" / "api.d.ts")
        st2 = {x.name: x.state for x in r.regs}
        via2 = {x.name: x.via for x in r.regs}
        print("credential + edge semantics:")
        check(st2.get("secretGood") == "resolves-a-caller" and via2["secretGood"].startswith("credential:master-secret"), "master-secret flowing into an env-reading, throwing check -> resolves")
        check(st2.get("secretNeverChecked") == "could-not-judge", "master-secret declared but never passed to a check -> could-not-judge")
        check(st2.get("attributionOnly") == "does-not-resolve" and via2["attributionOnly"] == "identity-consulted-not-gated", "identity read for attribution only -> does-not-resolve")
        check(st2.get("viaBridge") == "resolves-a-caller", "ctx.runQuery(internal.*) reaching a gated resolver -> resolves")
        check(st2.get("viaScheduler") == "does-not-resolve", "scheduler.runAfter reference does not carry the caller -> does-not-resolve")
        check(st2.get("licenseLookup") == "resolves-a-caller", "license key consumed by a stored-record lookup -> resolves")
        check(st2.get("licenseNoLookup") == "could-not-judge", "license key read but no lookup reachable -> could-not-judge")
        check(len(r.regs) == 7 and not r.coverage_errors, "coverage holds (internalQuery is not population: 7 registrations)")

    with tempfile.TemporaryDirectory() as td3:
        root3 = Path(td3)
        (root3 / "_generated").mkdir()
        api3 = root3 / "_generated" / "api.d.ts"
        print("coverage assertions, each with its own fixture:")

        # readable modules, ZERO registrations: only the empty-population check
        # can fire (every module IS read, api.d.ts DOES name modules).
        (root3 / "h.ts").write_text("export const helper = 1;\n")
        api3.write_text('import type * as h from "../h.js";\n')
        e = run(root3, api3)
        check(exit_code(e) == 3 and any("population is empty" in x for x in e.coverage_errors), "modules read, nothing registered -> non-vacuity, exit 3")

        # the same module named twice: double-counted identities
        (root3 / "h.ts").write_text(_FIXTURE_N)
        api3.write_text('import type * as h from "../h.js";\nimport type * as h2 from "../h.js";\n')
        d = run(root3, api3)
        check(exit_code(d) == 3 and any("duplicate registration identities" in x for x in d.coverage_errors), "module named twice -> duplicate identities, exit 3")

        # a module that registers but api.d.ts does not name (stale api.d.ts)
        (root3 / "h.ts").write_text("export const helper = 1;\n")
        (root3 / "stale.ts").write_text(_FIXTURE_N)
        api3.write_text('import type * as h from "../h.js";\n')
        u = run(root3, api3)
        check(any(x.module == "stale" and x.state == "does-not-resolve" for x in u.regs) and u.unlisted_with_registrations == ["stale"], "registration in a module api.d.ts does not name -> still population, accused")

        # @credential with no reason
        (root3 / "stale.ts").unlink()
        (root3 / "h.ts").write_text(
            "// @credential licenseKey license-key: short\n"
            "export const lk = query({ args: { licenseKey: v.string() }, handler: async (ctx, args) => ctx.db.query(\"l\").withIndex(\"i\", (q) => q.eq(\"k\", args.licenseKey)).first() });\n"
        )
        c = run(root3, api3)
        check({x.name: x.state for x in c.regs}["lk"] == "could-not-judge", "@credential with no reason -> could-not-judge")

        # the partition check, driven directly: a registration left without a
        # state, and one carrying a fourth state, must both be reported
        ok = Reg("m", "a", "query", 0, 1, 0)
        ok.state = "resolves-a-caller"
        blank = Reg("m", "b", "query", 0, 1, 0)
        fourth = Reg("m", "c", "query", 0, 1, 0)
        fourth.state = "declared-open"
        # ...and through run(): a classifier that forgets to set a state must
        # turn the whole run red (exit 3), not be silently counted
        (root3 / "h.ts").write_text(_FIXTURE_N)
        forgetful = run(root3, api3, classifier=lambda reg, graph, mods: None)
        check(exit_code(forgetful) == 3 and any("outside the three states" in x for x in forgetful.coverage_errors), "run(): a registration left without a state -> exit 3")
        check(partition_errors([ok]) == [], "partition: every registration in a state -> no error")
        check(len(partition_errors([ok, blank])) == 1 and len(partition_errors([ok, fourth])) == 1, "partition: stateless or fourth-state registration -> reported")

    print("\nself-test:", "PASS" if not fails else f"FAIL ({len(fails)})")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
