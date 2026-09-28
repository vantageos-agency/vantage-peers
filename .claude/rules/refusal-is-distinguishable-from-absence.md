# A refusal is distinguishable from an absence

Always loaded. Fleet-wide, every published Convex read that can decline to serve a caller.

Class of failure addressed: a read closes a leak by returning a TYPED EMPTY VALUE to a caller it refuses. The leak is gone and a second defect is left standing — `{"status":"success","value":[]}` is the same bytes for *"you may not"* and for *"there is nothing"*. Any guard, cron, monitor or agent built on top of that door reads an empty success and cannot tell a refusal from an absence; sooner or later it **ALLOWS on a refusal**. This is not hypothetical: on Day 158 the prod-deploy guard read an empty success as a clean state and froze every deployment in the fleet. `convex/issues.ts::getStats` was the worst instance — it answered a refused reader with `{closed:0, fixed:0, in_progress:0, open:0, total:0, verified:0}`, which is not an ABSENT figure but a **FALSE** one: a refused reader was told there are zero open issues.

## The rule

1. **A caller that cannot be resolved at all — no credential of any kind — is REFUSED BY RAISING.** `requireResolvedCaller(scope, "module:function")` (`convex/lib/auth.ts`), immediately after `withOrgScope`. It raises the same `ConvexError` carrying the same `RBAC_DENIED:` prefix that `requireScope` beside it already raises, and that `missions:list` already returns to an unscoped caller in production. One helper, one code. **Never a new refusal mechanism and never a per-function variant.**
2. **The refusal carries its CODE and names its DOOR.** `errorData` must contain `RBAC_DENIED` and the `module:function` that refused, so a reader can branch on content rather than on the presence of an exception. `errorMessage` stays the opaque `[Request ID: …] Server Error` — the structured payload is the contract, the message is not.
3. **An absence stays an absence.** A legitimately scoped caller reading a genuinely empty table MUST still receive an empty SUCCESS. A delivery that makes everything throw has not implemented this rule, it has broken the surface. Every site is pinned by three poles — REFUSED / ABSENT / PRESENT — in `convex/__tests__/refusalCarriesItsCode.test.ts`.
4. **No grant is withheld to buy this.** The admission set does not change: a control added here refuses only callers who were ALREADY being served nothing. A withheld grant is as much a defect as a leak, and the PRESENT pole per site is what proves it did not happen.

## R-50, narrowed — the conflict and its resolution

R-50 (backend-doctor) says a reactively-subscribed read cannot refuse by throwing, because the throw surfaces as a crashed render. PR #1349 applied it to fifteen public reads and chose the typed-empty refusal on that ground. **R-50's reasoning is correct and its scope was too wide**, in one specific way:

- **R-50 is about a caller whose SHELL IS MOUNTED.** The only subscribing consumer of this backend is the `vantage-peers-dashboard` Next.js app, and **every route of it sits behind `clerkMiddleware`** (its `middleware.ts`). No `useQuery` subscription is ever established without a Clerk session. An **anonymous** request therefore has no render to crash — it is a direct API probe.
- **The living proof is already in production.** `missions:list` is reactively subscribed at `components/missions/mission-board.tsx:25` and `components/activity/unified-activity-feed.tsx:155`, and it has raised `RBAC_DENIED` at the anonymous pole all along. So have `messages:listMessages` and `messages:searchMessagesByKeyword`. No render has crashed.
- **The population R-50 genuinely protects is the signed-in-but-not-yet-onboarded caller** (`scope.refused` — `withOrgScope`'s `refuseWithoutThrow` branch). That caller's shell IS mounted and IS subscribed. Their typed-empty result is **unchanged** at every site a dashboard `useQuery` actually reaches.

**Therefore R-50 is read as: a reactively-subscribed read may not throw AT A CALLER WHOSE RENDER EXISTS.** Anonymous is not such a caller. Where no subscriber exists at all, a read may also raise at the pre-org caller — declared, never assumed, with an `isolation-contract:` marker naming the enumeration command, the same declared-divergence mechanism R-50 already defines and `convex/orgRoster.ts:59` already uses.

**"Does a subscriber exist" is a MEASUREMENT, never a memory.** Enumerate before relying on it:

```
grep -rn "api\.<module>\." --include=*.tsx --include=*.ts \
  app components hooks lib contexts providers   # in vantage-peers-dashboard
```

At the time of writing, of the fourteen reads closed by PR #1349, **four** have a live `useQuery` (`businessUnits:list`, `mandates:list`, `profiles:listProfiles`, `messages:listByChannel`) and **ten** have none.

## Banned

- Returning a typed empty value, an empty envelope, or a zeroed aggregate to a caller presenting NO CREDENTIAL AT ALL.
- A zeroed numeric aggregate as a refusal, under any caller. A fabricated measurement is worse than a withheld one: an absent figure invites a retry, a false one is acted upon.
- Passing `alsoRefusePreOrg: true` without an `isolation-contract:` marker in that same handler naming the enumeration that found zero subscribers.
- Inventing a second refusal helper, or open-coding a `throw new ConvexError("RBAC_DENIED…")` at a call site, instead of `requireResolvedCaller` / `requireScope`.
- Making a scoped caller's empty table throw in order to satisfy this rule — that is the rule inverted, and pole 3 (ABSENT) exists to catch it.
- Leaving the standard saying one thing while the code does another. If a delivery diverges from a written rule, the rule text is updated in the SAME delivery. That divergence is how R-50 came to certify the thing it exists to catch.

## Reference

Implementation: `convex/lib/auth.ts` (`requireResolvedCaller`, and the `anonymous` field on `OrgScope` that makes the two refused populations distinguishable at all). Three-pole tests: `convex/__tests__/refusalCarriesItsCode.test.ts`. Inverted contract poles: `convex/__tests__/publicRegistrationResolvesCaller.test.ts`, `convex/__tests__/allowNoIdentityMaster-reachability.test.ts`. Siblings: `.claude/rules/authority-attached-to-anonymous-object.md` (who the caller IS), this rule (how a refusal is SAID).

*Origin: task k177hpz3cx9bb842tc9201wf118f94sa — the refusal shape left standing by PR #1349.*
