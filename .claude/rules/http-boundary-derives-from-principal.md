# The HTTP/MCP boundary derives mint authority from the live authenticated principal, never a client-registration field

Always loaded. Fleet-wide, every branch of `mcp-server/src/auth.ts`'s `bearerAuthMiddleware` (or any future HTTP-layer bearer-auth branch) that attaches an `oauthContext` before a request reaches a Convex query/mutation/action.

Class of failure addressed: the HTTP/MCP transport layer verifies a caller's credential itself (e.g. a Clerk JWT against Clerk's JWKS — `tryVerifyClerkJwt`) BEFORE any Convex round-trip, so there is no `ctx.auth.getUserIdentity()` for Convex to resolve. If that branch then attaches a hardcoded, POPULATED grant (non-empty `scopes`/`fromAllowList`) keyed only on "which branch matched" rather than on the verified principal it just extracted, the verified principal is computed and discarded — the anti-pattern is a client-registration-shaped default winning silently over the caller Convex would have resolved. Task k17bf7bsfrm255x4pr5r96q5g58cw691 (Path B): the Clerk-JWT branch had `clerkResult.sub`/`clerkResult.org_id` in hand and still hardcoded `scopeProfile: "team-member"`, `fromAllowList: []`.

## The rule

1. **A control at this boundary READS the verified principal's own claims** — for the Clerk-JWT branch, `clerkResult.org_id` (the JWKS-verified `org_id` claim), never a client-registration field (`clientId`, a registered client's own `scopeProfile`). The verified claim is the ONLY permitted key forwarded to Convex's `client_org_mapping` join (`clientOrgMapping:getByClerkSlug`, the public-query mirror of `convex/lib/auth.ts`'s `withOrgScope`/`lookupOrgMapping` — see the paired backend-standard rule, `.claude/rules/authority-attached-to-anonymous-object.md`, for what that query itself must enforce).
2. **REFUSE on lookup failure or lookup miss.** No mapping row for the verified org, `isActive === false`, or the Convex round-trip itself erroring/throwing — all three are a DENY (403/401), never a fall-through to a populated default. A lookup failure at this boundary must not silently grant, because (unlike the OAuth-token layer above it, which can legitimately fall through to the next auth layer on a lookup miss) a Clerk JWT that reaches this branch has no other layer that will accept it.
3. **A hardcoded literal in a bearer-auth branch is safe ONLY as the DENY pole.** Empty `fromAllowList`/`scopes` with no principal-derived join (the legacy `mcpTenants` and DCR `client-generic` branches) is PASS — nothing to widen. A hardcoded literal that GRANTS something non-empty with no principal-derived join in that same branch is BLOCK, full stop.
4. **PASS is earned by identical inputs producing identical outputs.** Two different `clientId`s (e.g. two different Clerk `sub` values) resolving to the SAME verified `org_id` MUST reach the SAME mapping row and receive IDENTICAL `fromAllowList`/`scopes`/`scopeProfile` — the both-pole test in `mcp-server/test/path-b-org-authority.test.ts` pins this exactly.
5. **This rule governs the TRANSPORT boundary only** — where the key fed into the Convex join comes from (a JWKS-verified claim, never a client-supplied argument). The paired backend-standard rule governs the DATA JOIN itself once that key reaches Convex. Neither rule substitutes for the other: a branch that reads the right key but calls a broken/bypassed join still fails the backend-standard rule; a join that is itself correct but is fed a client-supplied (unverified) key instead of a JWKS-verified claim still fails THIS rule.

## Banned

- Setting `scopeProfile`/`fromAllowList`/`scopes` to a non-empty literal in any bearer-auth branch without a `clientOrgMapping:getByClerkSlug` (or equivalent principal-derived) call feeding those values in that same branch.
- Treating a Convex query failure/exception on the mapping lookup as "fall through to the next auth layer" for a credential type (Clerk JWT) that no other layer accepts — that is an unconditional silent grant of the pre-fix hardcoded default, not a fallback.
- Widening a resolved grant using ANY field from a client-registration row (a DCR client's own `scopeProfile`, a cached `clientId`-keyed profile) once a principal-derived mapping has already been resolved — narrow only, never widen (see the backend-standard rule's "narrowing ceiling" language).
- Advertising a tool/endpoint as reading `oauthContext.fromAllowList` (or similar) while a bearer-auth branch upstream can still populate that field from a hardcoded, non-empty literal.

## Reference

Enforcement: `mcp-server/scripts/check-http-boundary-derives-from-principal.py` (mcp-doctor, `--self-test` for the bipolar probe, default mode for the 5-path coverage inventory over every `bearerAuthMiddleware` branch). Both-pole test: `mcp-server/test/path-b-org-authority.test.ts`. Implementation: `mcp-server/src/auth.ts`'s `bearerAuthMiddleware`, case (2.5).

*Origin: task k17bf7bsfrm255x4pr5r96q5g58cw691 — Path B org authority rewire (mcp-server/src/auth.ts Clerk-JWT branch). Sibling: `.claude/rules/authority-attached-to-anonymous-object.md`.*
