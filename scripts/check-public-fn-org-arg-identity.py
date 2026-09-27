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

KNOWN-ACCUSED AT TIME OF WRITING (exits 1 because of these three, by design):
  convex/iframeEmbedSessions.ts::getSession
  convex/missions.ts::get
  convex/tasks.ts::get
These three are a DIFFERENT defect class from the one closed here: they take an
opaque resource ID, not a caller-supplied org/namespace string (they match this
scanner only because `orgId`/`tenantId` appears in their `returns` validator).
Closing them needs resource-derived authorisation -- load the row, then check
the row's own org against the caller's -- which is tracked separately
(convex/__tests__/resourceDerivedAuthzCrossTenant.test.ts). They are named here
rather than exempted, because an unclosed site must stay visible.

Caveats a reader must know, so this output is never over-read:
  - Argument detection scans the registration text before `handler`, which
    includes the `returns` validator. A site can therefore match on a `returns`
    field rather than a real argument (see the three above).
  - Helper resolution follows ONE level of file-local function. A guard reached
    through two hops, or through an imported helper, reads as NO-IDENT.
  A NO-IDENT verdict is an ACCUSATION to be judged by reading the site, never a
  proof of a hole; a GUARDED verdict is not a proof of correctness either.
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


rows = []
for f in sorted(pathlib.Path("convex").glob("*.ts")):
    if ".test." in f.name:
        continue
    src = f.read_text()
    for m in REG.finditer(src):
        name, kind = m.group(1), m.group(2)
        body = objspan(src, m.end() - 1)
        hi = body.find("handler")
        args_part, handler_part = (body[:hi], body[hi:]) if hi > 0 else (body, "")
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
