#!/usr/bin/env python3
"""Inventory every PUBLIC Convex registration that takes an org/tenant/
namespace-shaped argument, and classify its refusal posture.

WHY THIS EXISTS. Two public Convex functions were measured serving real tenant
rows to a caller presenting NO CREDENTIAL AT ALL, from the open internet:

    POST https://compassionate-goldfinch-737.convex.cloud/api/query
      {"path":"memoriesScoped:listMemoriesScoped","args":{"namespace":"global","limit":3}}
        -> {"status":"success", 3 rows of real memory content}
      {"path":"episodes:getCriticalInsights","args":{"limit":3}}
        -> {"status":"success", 3 rows}

A guard in the MCP transport layer is NOT a defence for a public Convex
function -- the deployment URL is directly reachable, which is how the above
was measured (standing precedent in this repo: oauth.getScopeProfile). See
.claude/rules/authority-attached-to-anonymous-object.md (the data join) and
.claude/rules/http-boundary-derives-from-principal.md (the transport key).

THREE CLASSES, NOT TWO. The scanner that first found this defect had only
"has a getUserIdentity call" vs "does not", and therefore MISCLASSIFIED
convex/memoriesScoped.ts -- which DID call getUserIdentity and then failed
OPEN (`if (!identity) return null`, where null is that module's MASTER
sentinel). A site that consults the principal and then discards it is the
defect, so "consulted identity" is not a pass:

  NO-IDENT    handler reaches no identity-consulting call at all
  FAIL-OPEN   consults identity, but an anonymous caller still resolves to
              unrestricted/master -- open to the internet all the same
  GUARDED     consults identity and an anonymous caller cannot obtain rows

NO EXEMPTION LIST, NO BASELINE, NO TOLERATED COUNT -- deliberately. A list
that can hold a name and still report success IS the defect, not the names in
it. This script therefore exits NON-ZERO whenever any NO-IDENT or FAIL-OPEN
site exists, and there is no way to silence it short of fixing the site.

FORMERLY-ACCUSED, NOW CLOSED (this script exits 0 at the head that closed them):
  convex/iframeEmbedSessions.ts::getSession
  convex/missions.ts::get
  convex/tasks.ts::get
  convex/tasks.ts::getById   <- was DROPPED ENTIRELY, see BLIND SPOT 1 below
These four are the RESOURCE-ID class: they take an opaque resource handle, not a
caller-supplied org/namespace string (they match this scanner only because
`orgId`/`tenantId` appears in their `returns` validator). Closing them needed
resource-derived authorisation -- load the row, then check the ROW's own org
against the caller's -- see `isRowVisibleToScope` in convex/lib/auth.ts and
convex/__tests__/resourceIdOrgScopeRead.test.ts for both poles at every site.

STILL ACCUSED, in writing rather than on an exemption list: neither
`tasks.create` nor `missions.create` stamps `orgId` at all, so the row-vs-caller
org comparison is inert for newly-created rows and the orchestrator-roster leg
carries them. Two orgs with overlapping rosters can still reach each other's
orgId-less rows -- through `get` exactly as through `list`. That is a WRITE-PATH
gap, unchanged by the read fix, and this script cannot see it (it inventories
reads' identity posture, not whether a write stamps a tenant).

Caveats a reader must know, so this output is never over-read:
  - Argument detection scans the registration text before the `handler` KEY,
    which includes the `returns` validator. A site can therefore match on a
    `returns` field rather than a real argument (see the four above).
  - Helper resolution follows ONE level of file-local function. A guard reached
    through two hops, or through an imported helper, reads as NO-IDENT.
  A NO-IDENT verdict is an ACCUSATION to be judged by reading the site, never a
  proof of a hole; a GUARDED verdict is not a proof of correctness either.

TWO MEASURED BLIND SPOTS, both closed at the code below (and both demonstrated
by running this file against the tree as it stood before the fix):
  1. the args window was cut at the first LITERAL "handler" ANYWHERE in the
     registration, including inside a COMMENT -- which silently DROPPED two
     sites from the inventory (convex/tasks.ts::getById, one of the four the
     delivery's own prose named, and convex/briefingNotes.ts::get, which
     happened to already be guarded). The instrument printed 42 total / 3
     accused where the truth was 44 / 4.
  2. run from any directory with no convex/ tree, it printed zero everywhere
     and exited 0 -- a clean bill from an instrument that read no file. It now
     REFUSES with exit 2.
"""
import re
import pathlib
import sys

ORG_ARG = re.compile(
    r"\b(namespace|orgSlug|clerkOrgSlug|orgId|tenantId|organizationId)\b\s*:")
IDENT = re.compile(
    r"getUserIdentity|withOrgScope|requireOrgAdmin|requireMasterAuth|"
    r"requireAuthenticatedCaller|resolveOrgId|requireTenantId|requireScope|"
    r"assertNamespaceAllowed|requireOrgScopeForWrite|resolveScope|"
    r"assertCanExportNamespace|assertCanExportNamespaceV8|"
    r"resolveSearchNamespace|assertScopeAuthorizesOrg|resolveCallerOrgId|"
    r"resolveOrgScopeForAction")
# Markers that the identity path can still resolve an anonymous caller to
# master. Scanned over the handler + its file-local helpers ONLY -- a file-wide
# regex is WRONG here: messages.ts's only `allowNoIdentityMaster: true` sits on
# an internalMutation (structurally unreachable from the public api.* tree), and
# a file-wide match misreported 6 correctly-guarded sites as fail-open.
FAILOPEN = re.compile(
    r"allowNoIdentityMaster\s*:\s*true|if\s*\(!identity\)\s*return null")
# `internalQuery`/`internalMutation`/`internalAction` do NOT match: they are
# registered only under the `internal` tree and are unreachable from the public
# surface this script is about.
REG = re.compile(r"^export const (\w+)\s*=\s*(mutation|query|action)\s*\(", re.M)


def objspan(src, start):
    i = src.index("{", start)
    d = 0
    j = i
    while j < len(src):
        if src[j] == "{":
            d += 1
        elif src[j] == "}":
            d -= 1
            if d == 0:
                return src[i:j + 1]
        j += 1
    return src[i:]


# BLIND SPOT 1 (measured, fixed): the args window used to be cut at the first
# LITERAL occurrence of the word "handler" anywhere in the registration —
# including inside a COMMENT. convex/tasks.ts::getById carries the comment
# "the v.id() validator runs BEFORE the handler" above its `args`, so the
# window collapsed to that comment alone, matched no org-shaped field, and the
# site was DROPPED from the inventory entirely: the script printed 3 accused
# while the delivery's own prose named 4. An instrument that prints a SMALLER
# number than the prose beside it is the defect class this repo keeps paying
# for, so the split is now anchored on the `handler` KEY (a `handler:` property
# at the start of a line), never on the word.
HANDLER_KEY = re.compile(r"^[ \t]*handler\s*:", re.M)


def split_at_handler(body):
    m = HANDLER_KEY.search(body)
    if m is None:
        return body, ""
    return body[:m.start()], body[m.start():]


# BLIND SPOT 2 (measured, fixed): run from any directory without a `convex/`
# tree, this script used to glob nothing, print zero in every bucket and exit
# 0 — a CLEAN BILL from an instrument that read no file, which is exactly the
# false green it exists to prevent. An unresolvable target REFUSES (exit 2,
# distinct from both the 0 "clean" and the 1 "accused" verdicts) so a CI shell
# that cd's somewhere unexpected can never be told everything is fine.
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
        args_part, handler_part = split_at_handler(body)
        if not ORG_ARG.search(args_part):
            continue

        # Resolve ONE level of local helper: a handler that delegates its
        # identity check to a file-local function must be judged on that
        # function's body, not on the handler's own text.
        scan = handler_part
        for helper in set(re.findall(r"\b(\w+)\s*\(", handler_part)):
            hm = re.search(r"(?:async\s+)?function\s+%s\b" % re.escape(helper), src)
            if hm:
                scan += objspan(src, hm.end())

        if not IDENT.search(scan):
            cls = "NO-IDENT"
        elif FAILOPEN.search(scan):
            cls = "FAIL-OPEN"
        else:
            cls = "GUARDED"
        rows.append((cls, kind, f"{f}::{name}"))

print(f"TOTAL public registrations with an org/tenant/namespace-shaped arg: {len(rows)}")
for want in ("NO-IDENT", "FAIL-OPEN", "GUARDED"):
    sel = [r for r in rows if r[0] == want]
    print(f"\n=== {want} ({len(sel)}) ===")
    for _cls, kind, site in sel:
        print(f"  {kind:9} {site}")

accused = [r for r in rows if r[0] in ("NO-IDENT", "FAIL-OPEN")]
if accused:
    print(
        f"\nACCUSED: {len(accused)} site(s) serve a tenant-shaped argument with no "
        "fail-closed identity resolution. Each must be closed or judged by "
        "reading it -- there is no exemption list to add a name to."
    )
sys.exit(1 if accused else 0)
