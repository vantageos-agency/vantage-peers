# A change to who may read or write what names the live connections it touches, and derives at request time or migrates in the same delivery

Always loaded. Fleet-wide, every change to a rule that decides which namespaces, senders or scopes a connection holds: `convex/lib/seatNamespace.ts`, the shape or content of a scope profile (`oauth_scope_profiles`, `seedDefaultProfiles`, `upsertScopeProfile`, `provisionOrganization`), the organisation mapping's grant fields, and `mcp-server/src/auth.ts` `checkNamespace*`.

Class of failure addressed: a rule changes (a seat is now admitted to `orchestrator/<agent ID>`; the profile rows gain it) while every connection already issued keeps the grant it was minted with. `oauth_access_tokens` carried `namespaceReadPrefixes` / `namespaceWritePrefixes` / `fromAllowList` copied from the profile at mint, the MCP ceiling decided on that copy, and 29 live seat tokens (measured 2026-11-02 against prod, see the task) were locked out of the namespace the new rule gave them. Every suite stayed green, because every suite mints a fresh token under the new rule. Task k17dhntq3m2w5x3x1jtdmkkba18hek7m.

## The rule

1. **A grant is DERIVED at request time from the source that holds it now; it is never read from a copy made when the connection was issued.** A profile token: the live scope profile row. A person token: the live organisation mapping. The copy on the token row is at most a NARROWING of the live source (`rightsPinned`, intersect, never widen), and a source that is gone or names another organisation grants NOTHING. This is `convex/lib/tokenRights.ts`, called by `oauth:getAccessTokenByHash`.
2. **A pull request that changes who may read or write what STATES which live connections it affects**: how many exist (a command and its output, measured, not remembered), which classes (seat token, seat plus credential, person, Clerk JWT), and the effect on each (gains, loses, denied).
3. **Then it does one of two things in the same delivery**: (a) it derives at request time, so the change reaches every live connection by construction (`rights-derivation:`), or (b) it ships the migration that re-derives them, dry-run first, listable and reversible (`rights-migration:`). "Existing connections will pick it up when they reconnect" is neither: a seat token lives 7 days to a year.
4. **A test pins the change on a connection issued BEFORE it**, not only on a fresh one: mint under the old rule, change the rule, assert the old connection holds what the new rule grants and has lost what it removed (`convex/__tests__/tokenRightsDerivation.test.ts`). A suite that only mints under the new rule cannot see this class.
5. **A path is not a connection.** Where a rule is enforced per branch of `bearerAuthMiddleware`, the derivation runs once after every branch (`ownNamespacesOf` in `attachContextAndProceed`), not as a carve-out in the branch that was observed (`mcp-server/test/client-own-namespace-all-paths.test.ts`).

## Structural mechanism

| Layer | Component | Role |
|---|---|---|
| Doctrine | this file, always loaded | the obligation, visible before the change is written |
| Derivation | `convex/lib/tokenRights.ts` | the grant is read live; the copy cannot outlive the rule |
| Inventory | `convex/migrations/tokenRightsDrift.ts` `inventory` | what a rule change does to every live token: gains, losses, denied; read-only |
| Check | `scripts/check-rights-change-note.mjs`, test `scripts/__tests__/check-rights-change-note.test.mjs` | refuses a diff touching the rights files without a `rights-derivation:` or `rights-migration:` note |

## Where the check runs, and what it is not

The check is a SCRIPT plus its test, not a hook: `.claude/hooks/` and `.claude/scripts/convex-prod.allow` are owned by the fleet and not writable from a backend station's branch, so a hook registered from this delivery could not be wired by it. Run it before requesting review, and in the PR self-gate (`.github/PULL_REQUEST_TEMPLATE.md`, item 6):

```
node scripts/check-rights-change-note.mjs --base origin/main
```

It reads `git diff <base>...HEAD`, and exits 1 naming each rights file touched when neither the commit messages of the range nor the added lines of the diff carry a `rights-derivation:` or `rights-migration:` note with a reason of ten characters or more. Exit 2 when it cannot judge (no repository, unresolvable base): a failure to read is never a pass. It checks that the note EXISTS, not that it is true; the reviewer's verdict names the command that proves it.

## Banned

- Copying a grant onto a long-lived credential at issue and enforcing the copy.
- A rule change whose test mints a fresh connection under the new rule and nothing else.
- "Reconnect to pick it up" as the migration plan.
- A per-branch carve-out for the path that was observed to fail, leaving the other paths on the old copy.
- A `rights-derivation:` note on a change whose grant is still read from a copy.

## Reference

Derivation: `convex/lib/tokenRights.ts`; consumer `convex/oauth.ts` `getAccessTokenByHash`. Inventory and the one marker's migration: `convex/migrations/tokenRightsDrift.ts`. Tests: `convex/__tests__/tokenRightsDerivation.test.ts`, `convex/__tests__/tokenRightsDrift.test.ts`, `mcp-server/test/client-own-namespace-all-paths.test.ts`. Siblings: `authority-attached-to-anonymous-object.md` (a copy made when the object was registered is not authority), `http-boundary-derives-from-principal.md`, `railway-mcp-redeploy.md` (expand then contract for a shape the running MCP reads).

*Origin: 2026-11-01/02. Rule changes c5348d65 and efbc6193 gave a seat `orchestrator/<agent ID>`; #1676 patched one carve-out; 29 live seat tokens kept the old copy.*
