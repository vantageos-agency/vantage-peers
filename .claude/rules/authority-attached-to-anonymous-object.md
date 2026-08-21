# Authority attached to an anonymously-registered object is not authority

Always loaded. Fleet-wide, every Convex query/mutation/action that resolves a caller's rights (scope, allowlist, namespace prefixes) before serving a request.

Class of failure addressed: a token or session gets resolved to a POPULATED grant (non-empty scopes/allowlist/prefixes) sourced from an object that was registered ANONYMOUSLY at some prior point (a DCR client row, a hardcoded per-branch literal, a client-registration `scopeProfile` field) — with no join back to the AUTHENTICATED PRINCIPAL who is making THIS request. Two authorities exist (the verified principal vs. the anonymous object), and the anonymous object silently wins. Task k17bf7bsfrm255x4pr5r96q5g58cw691 (Path B): `mcp-server/src/auth.ts`'s Clerk-JWT branch had the verified human (`clerkResult.sub`, `clerkResult.org_id`) in hand but hardcoded `scopeProfile: "team-member"`, `fromAllowList: []` regardless — the verified principal was computed and then discarded.

## The rule

1. **A control that grants rights READS the authenticated principal first.** For Convex, that is `ctx.auth.getUserIdentity()` (never a client-supplied argument for "who am I"). The principal's own claims (subject, org id/slug) are the ONLY permitted key into a mapping table.
2. **The mapping row is consulted by that key, and by that key alone.** `client_org_mapping.by_clerk_slug` (see `convex/lib/auth.ts`'s `withOrgScope` / `lookupOrgMapping`) is the canonical join. A registered client's own fields (its `scopeProfile`, its `clientId`) may narrow what that mapping grants — intersect, never widen — but must never BE the grant in place of the mapping.
3. **REFUSE, don't default.** No mapping row for the principal's org, or `isActive === false`, throws `RBAC_DENIED` (or an equivalent explicit refusal). A populated default synthesized from anywhere else (a client-registration profile, a hardcoded per-branch literal) is exactly the defect class this rule closes — never emit one.
4. **PASS is earned by identical inputs producing identical outputs.** The same (principal, org) pair MUST resolve to the same rights regardless of which client, connector, or session made the request. If two different `clientId`s for the same principal+org produce different `fromAllowList`/`scopes`, the mapping join is broken (or bypassed) somewhere in the chain.
5. **The paired rule at the HTTP/MCP boundary** (`.claude/rules/http-boundary-derives-from-principal.md`) enforces the SAME property one layer up, for callers that verify their own principal (a Clerk JWT via JWKS) before Convex ever sees a `ctx.auth` identity. This rule (Convex-side) and that rule (HTTP-side) are NOT the same obligation twice — this rule governs the DATA JOIN itself (`client_org_mapping`); the paired rule governs where the KEY into that join comes from at the transport boundary. A control satisfying one does not imply the other.

## Banned

- A query/mutation resolving scope/allowlist/namespace-prefixes from a client-registration row's own fields (e.g. `client.scopeProfile`) as a SUBSTITUTE for the principal→mapping join, rather than as a narrowing ceiling on top of it.
- A hardcoded per-branch literal that GRANTS something non-empty (populated `fromAllowList`/`scopes`) with no principal-derived join anywhere in that branch. (A hardcoded literal that only ever DENIES — empty arrays — is not this defect; see `scripts/check-token-mint-authority-source.py`'s classifier, which treats "hardcoded + empty" as PASS and "hardcoded + populated, no join" as BLOCK.)
- Falling back to a populated default when the mapping lookup errors, times out, or the table is mid-migration — a lookup failure is a DENY, never an implicit ALLOW.
- Treating a wildcard sentinel (`allowedOrchestrators: ["*"]`) resolved from ONE caller's own mapping row as license to widen a DIFFERENT caller's request — the wildcard is that org's own openness, never a cross-org grant (see `checkDelegationAllowed`'s ETA-M15 doctrine in `mcp-server/src/auth.ts`).

## Reference

Enforcement: `scripts/check-token-mint-authority-source.py` (backend-doctor, `--self-test` for the bipolar probe, default mode for the 6-path coverage inventory over every known token-mint site in this repo). Both-pole test: `convex/lib/auth.ts` (`withOrgScope`/`lookupOrgMapping`), `convex/clientOrgMapping.ts` (`getByClerkSlug`), `mcp-server/test/path-b-org-authority.test.ts`.

*Origin: task k17bf7bsfrm255x4pr5r96q5g58cw691 — Path B org authority rewire (mcp-server/src/auth.ts Clerk-JWT branch).*
