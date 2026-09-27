#!/usr/bin/env python3
"""Inventory every PUBLIC Convex READ that takes an OPAQUE RESOURCE HANDLE and
returns a row carrying an organisation field, and classify its posture.

WHY THIS EXISTS, AND WHY IT IS A SECOND INSTRUMENT. Its sibling
`check-public-fn-org-arg-identity.py` inventories reads/writes that accept an
ORG-SHAPED ARGUMENT -- a caller-supplied `namespace`/`orgId`/`tenantId` string
to distrust. This script inventories the OTHER shape, which has no such argument
and which the sibling therefore only catches by accident (its args window also
sweeps the `returns` validator):

    a public query/action taking a v.id(...) or a handle-shaped string token,
    returning a row that carries `orgId`/`tenantId`/`namespace`.

For that shape the control cannot be "does the caller have an organisation" --
it must be "does THIS ROW belong to the caller's organisation": load the row,
compare the ROW's own org against the caller's resolved scope, refuse when they
differ. A caller who holds, is handed, or guesses a document id must not thereby
read another tenant's row. Sites closed under this rule:
`convex/tasks.ts::get`, `convex/tasks.ts::getById`, `convex/missions.ts::get`,
`convex/iframeEmbedSessions.ts::getSession` -- see `isRowVisibleToScope` in
convex/lib/auth.ts and convex/__tests__/resourceIdOrgScopeRead.test.ts.

THREE CLASSES, because "it resolves an identity" is not the property:

  NO-IDENT        the handler reaches no identity-consulting call at all.
  ROW-UNCHECKED   an identity IS resolved, but nothing compares the fetched
                  ROW against it. This is the class-specific failure: a guard
                  that only asks "is this caller in some organisation" lets any
                  signed-in tenant read every other tenant's rows by handle.
  ROW-CHECKED     an identity is resolved AND a row-vs-scope comparison is
                  reached in the same handler.

SCOPE, stated so the output is never over-read:
  - READS ONLY (`query`/`action`). `mutation` is excluded because a write's
    target-row authorisation is a separate, already-instrumented class (see
    convex/__tests__/resourceDerivedAuthzCrossTenant.test.ts).
  - `internalQuery`/`internalMutation`/`internalAction` do NOT match: they live
    only under the `internal` tree and are unreachable from the public surface
    this script is about.
  - Named validator constants are resolved ONE level for the `returns` shape
    (`returns: v.array(fooValidator)` -> the body of `const fooValidator = ...`).
    A shape assembled across two hops reads as "no org field" and is skipped, so
    a MISS here is not proof a site is out of class.
  - Helper resolution for the guard follows ONE level of file-local function.
  A NO-IDENT / ROW-UNCHECKED verdict is an ACCUSATION to be judged by reading
  the site; ROW-CHECKED is not a proof of correctness either.

NO EXEMPTION LIST, NO BASELINE, NO TOLERATED COUNT -- deliberately, same as the
sibling. A list that can hold a name and still report success IS the defect.
Exit 1 on any accusation, exit 2 when the target tree cannot be read, exit 0
only on a clean inventory of a tree actually read.
"""
import pathlib
import re
import sys

REG = re.compile(r"^export const (\w+)\s*=\s*(query|action)\s*\(", re.M)
# The `handler` KEY at the start of a line -- never the word "handler", which
# appears in comments above `args` at several sites and silently truncated the
# sibling script's window until it was fixed.
HANDLER_KEY = re.compile(r"^[ \t]*handler\s*:", re.M)
# An opaque resource handle in the ARGUMENTS: a v.id(...) validator, or a
# string-typed argument whose name is handle-shaped.
HANDLE_ARG = re.compile(
    r"v\.id\(|\b\w*(?:Id|Token|Hash|Key)\s*:\s*v\.string\(\)")
# Argument names that make a site the OTHER class (caller-supplied org string),
# already inventoried by check-public-fn-org-arg-identity.py.
ORG_ARG = re.compile(
    r"\b(namespace|orgSlug|clerkOrgSlug|orgId|tenantId|organizationId)\s*:\s*v\.")
# An organisation field carried by the RETURNED row.
ORG_FIELD = re.compile(
    r"\b(orgId|tenantId|orgSlug|clerkOrgSlug|organizationId|namespace)\s*:")
IDENT = re.compile(
    r"getUserIdentity|withOrgScope|requireOrgAdmin|requireMasterAuth|"
    r"requireAuthenticatedCaller|resolveOrgId|requireTenantId|requireScope|"
    r"resolveOrgScopeForAction|resolveSearchNamespace")
# A comparison of the FETCHED ROW against the resolved scope. Either through one
# of the named shared helpers, or written INLINE -- the inline form is not a
# lesser control and must not read as an accusation: convex/briefingNotes.ts::get
# compares `note.orgId !== scope.orgSlug` directly inside a file-local helper,
# and a first cut of this script accused it purely for not naming a helper.
ROW_CHECK = re.compile(
    r"isRowVisibleToScope|isTenantAllowedForScope|isNamespaceAllowedForScope|"
    r"filterByOrgScope|assertScopeAuthorizesOrg|"
    r"\.(?:orgId|tenantId)\s*(?:!==|===)\s*scope\.orgSlug|"
    r"scope\.orgSlug\s*(?:!==|===)\s*\w+\.(?:orgId|tenantId)")


def objspan(src, start):
    """The balanced {...} object beginning at/after `start`."""
    i = src.index("{", start)
    depth = 0
    j = i
    while j < len(src):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                return src[i:j + 1]
        j += 1
    return src[i:]


def split_at_handler(body):
    m = HANDLER_KEY.search(body)
    if m is None:
        return body, ""
    return body[:m.start()], body[m.start():]


def args_object(pre_handler):
    """The `args:` object alone -- NOT the `returns` validator beside it."""
    m = re.search(r"^[ \t]*args\s*:", pre_handler, re.M)
    if m is None:
        return ""
    try:
        return objspan(pre_handler, m.end())
    except ValueError:
        # `args: someSharedValidator,` -- no inline object to span.
        return pre_handler[m.end():pre_handler.find("\n", m.end())]


def returns_text(pre_handler, src):
    """The `returns` validator text, resolving named constants one level."""
    m = re.search(r"^[ \t]*returns\s*:", pre_handler, re.M)
    if m is None:
        return ""
    text = pre_handler[m.end():]
    for name in set(re.findall(r"\b(\w*[Vv]alidator)\b", text)):
        cm = re.search(r"\b(?:const|let)\s+%s\s*=" % re.escape(name), src)
        if cm:
            try:
                text += objspan(src, cm.end())
            except ValueError:
                pass
    return text


CONVEX_DIR = pathlib.Path("convex")
if not CONVEX_DIR.is_dir():
    print(
        f"REFUSE: no readable convex/ directory at {CONVEX_DIR.resolve()} — this "
        "script inventories Convex registrations and cannot report on a tree it "
        "did not read. Run it from the repository root. Refusing rather than "
        "reporting zero accused sites.",
        file=sys.stderr,
    )
    sys.exit(2)

rows = []
for f in sorted(CONVEX_DIR.glob("*.ts")):
    if ".test." in f.name:
        continue
    src = f.read_text()
    for m in REG.finditer(src):
        name, kind = m.group(1), m.group(2)
        body = objspan(src, m.end() - 1)
        pre_handler, handler_part = split_at_handler(body)
        args_part = args_object(pre_handler)

        # In class only if the ARGS carry an opaque handle...
        if not HANDLE_ARG.search(args_part):
            continue
        # ...and the args do NOT carry a caller-supplied org string (that is the
        # sibling script's class, not this one).
        if ORG_ARG.search(args_part):
            continue
        # ...and the RETURNED row carries an organisation field.
        if not ORG_FIELD.search(returns_text(pre_handler, src)):
            continue

        scan = handler_part
        for helper in set(re.findall(r"\b(\w+)\s*\(", handler_part)):
            hm = re.search(
                r"(?:async\s+)?function\s+%s\b" % re.escape(helper), src)
            if hm:
                scan += objspan(src, hm.end())

        if not IDENT.search(scan):
            cls = "NO-IDENT"
        elif not ROW_CHECK.search(scan):
            cls = "ROW-UNCHECKED"
        else:
            cls = "ROW-CHECKED"
        rows.append((cls, kind, f"{f}::{name}"))

print(
    "public READS taking an opaque resource handle and returning a row with an "
    f"organisation field: {len(rows)}"
)
for want in ("NO-IDENT", "ROW-UNCHECKED", "ROW-CHECKED"):
    sel = [r for r in rows if r[0] == want]
    print(f"\n=== {want} ({len(sel)}) ===")
    for _cls, kind, site in sel:
        print(f"  {kind:7} {site}")

accused = [r for r in rows if r[0] in ("NO-IDENT", "ROW-UNCHECKED")]
if accused:
    print(
        f"\nACCUSED: {len(accused)} public read(s) return a row carrying an "
        "organisation without comparing that row's own organisation to the "
        "caller's resolved scope. Each must be closed or judged by reading it — "
        "there is no exemption list to add a name to."
    )
sys.exit(1 if accused else 0)
