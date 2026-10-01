# A refusal is distinguishable from an absence

Always loaded. Fleet-wide, every published Convex read that can decline to serve a caller.

Class of failure addressed: a read closes a leak by returning a TYPED EMPTY VALUE to a caller it refuses. The leak is gone and a second defect is left standing — `{"status":"success","value":[]}` is the same bytes for *"you may not"* and for *"there is nothing"*. Any guard, cron, monitor or agent built on top of that door reads an empty success and cannot tell a refusal from an absence; sooner or later it **ALLOWS on a refusal**. This is not hypothetical: on Day 158 the prod-deploy guard read an empty success as a clean state and froze every deployment in the fleet. `convex/issues.ts::getStats` was the worst instance — it answered a refused reader with `{closed:0, fixed:0, in_progress:0, open:0, total:0, verified:0}`, which is not an ABSENT figure but a **FALSE** one: a refused reader was told there are zero open issues.

## The rule

1. **A caller that cannot be resolved at all — no credential of any kind — is REFUSED BY RAISING.** `requireResolvedCaller(scope, "module:function")` (`convex/lib/auth.ts`), immediately after `withOrgScope`. It raises the same `ConvexError` carrying the same `RBAC_DENIED:` prefix that `requireScope` beside it already raises, and that `missions:list` already returns to an unscoped caller in production. One helper, one code. **Never a new refusal mechanism and never a per-function variant.**
2. **The refusal carries its CODE and names its DOOR.** `errorData` must contain `RBAC_DENIED` and the `module:function` that refused, so a reader can branch on content rather than on the presence of an exception. `errorMessage` stays the opaque `[Request ID: …] Server Error` — the structured payload is the contract, the message is not.
3. **An absence stays an absence.** A legitimately scoped caller reading a genuinely empty table MUST still receive an empty SUCCESS. A delivery that makes everything throw has not implemented this rule, it has broken the surface. Every site is pinned by three poles — REFUSED / ABSENT / PRESENT — in `convex/__tests__/refusalCarriesItsCode.test.ts`. At the three master-only sites (`issues:getStats`, `mandates:list`, `profiles:listProfiles`) the REFUSED pole runs as an ORDINARY member of an active org, and PRESENT/ABSENT can only run as the fleet service account, because those reads admit no ordinary reader by design — the REFUSED pole over a SEEDED table is what pins that.
4. **No grant is withheld to buy this.** The admission set does not change: a control added here refuses only callers who were ALREADY being served nothing. A withheld grant is as much a defect as a leak, and the PRESENT pole per site is what proves it did not happen.
5. **There are FOUR callers, and a refusal is said to each in the shape ITS consumer can survive.** "Unresolvable" is not the only refused population: an ORDINARY MEMBER of an active organisation is resolved, is somebody, and at a fleet-master-only read is still refused. Which shape they get is decided by what the read returns and by whether a render subscribes to it:

   | Caller | Measurement read (`issues:getStats`) | Subscribed list read (`mandates:list`, `profiles:listProfiles`) |
   |---|---|---|
   | anonymous (no credential) | RAISES `RBAC_DENIED` | RAISES `RBAC_DENIED` |
   | signed in, no organisation (`scope.refused`) | RAISES (no subscriber) | `{ refused: true, items: [] }` (R-50: a mounted render, so never a throw; and never the bytes of an absence) |
   | ordinary org member | RAISES `RBAC_DENIED`, `reason: "not-fleet-master"` | `{ refused: true, items: [] }` |
   | fleet master | the real figure (a real zero is still a zero) | bare array: rows, or a genuine absence with NO `refused` key |

   **Why the member is not treated like the anonymous caller on a list.** A member's shell IS mounted and IS subscribed (`mandate-board.tsx:39`, `orchestrators-grid.tsx:53`), so a throw crashes a render. But a bare `[]` is byte-identical to "no mandates exist" and silently degrades. The typed envelope is what those consumers are already written to read (`Array.isArray(r) ? r : (r.items ?? [])`, `mandate-board.tsx:41-46`, `orchestrators-grid.tsx:56-61`): it renders as empty AND says `refused: true`. The fleet master is served the bare array, unchanged, so the MCP readers (`mcp-server/src/tools.ts`, `list_peers` and `list_mandates`) still receive an array for a served caller; for a refused one they test `isRefusedEnvelope` first and surface the refusal in the tool text instead of coalescing it to `[]`.

   **Why the member is treated like the anonymous caller on a measurement.** A count has no "empty" shape: `{open:0, total:0}` does not say "nothing" but "zero", and it was quoted. There is no subscriber, so a throw needs no render to crash. The one helper carries this as `requireResolvedCaller(scope, "module:function", { masterOnly: true })`; it is not a second helper.

## R-50, narrowed — the conflict and its resolution

R-50 (backend-doctor) says a reactively-subscribed read cannot refuse by throwing, because the throw surfaces as a crashed render. PR #1349 applied it to fifteen public reads and chose the typed-empty refusal on that ground. **R-50's reasoning is correct and its scope was too wide**, in one specific way:

- **R-50 is about a caller whose SHELL IS MOUNTED.** The only subscribing consumer of this backend is the `vantage-peers-dashboard` Next.js app, and **every route of it sits behind `clerkMiddleware`** (its `middleware.ts`). No `useQuery` subscription is ever established without a Clerk session. An **anonymous** request therefore has no render to crash — it is a direct API probe.
- **The living proof is already in production.** `missions:list` is reactively subscribed at `components/missions/mission-board.tsx:25` and `components/activity/unified-activity-feed.tsx:155`, and it has raised `RBAC_DENIED` at the anonymous pole all along. So have `messages:listMessages` and `messages:searchMessagesByKeyword`. No render has crashed.
- **The population R-50 genuinely protects is the signed-in-but-not-yet-onboarded caller** (`scope.refused` — `withOrgScope`'s `refuseWithoutThrow` branch). That caller's shell IS mounted and IS subscribed. At every site a dashboard `useQuery` actually reaches it is still NEVER a throw; since k1749w7ecx2yffr1hbhjpk8v858fbrf1 it is the typed envelope rather than a bare `[]` (see below).

**The signed-in-no-organisation caller is answered with the envelope, not a bare `[]`** (task k1749w7ecx2yffr1hbhjpk8v858fbrf1). R-50's reasoning (do not throw at a mounted render) stands; its conclusion (a bare `[]`) did not follow from it, because a bare `[]` is byte-identical to "no rows exist". At `mandates:list`, `profiles:listProfiles` and `messages:listByChannel` the pre-organisation caller receives `{ refused: true, items: [] }`, which every dashboard consumer already normalises with `.items ?? []`. At `messages:listMessages` and `messages:searchMessagesByKeyword` no dashboard `useQuery` exists (measured), so the pre-organisation caller is RAISED at (`alsoRefusePreOrg`, each carrying an `isolation-contract:` marker with the enumeration).

**Therefore R-50 is read as: a reactively-subscribed read may not throw AT A CALLER WHOSE RENDER EXISTS.** Anonymous is not such a caller. Where no subscriber exists at all, a read may also raise at the pre-org caller — declared, never assumed, with an `isolation-contract:` marker naming the enumeration command, the same declared-divergence mechanism R-50 already defines and `convex/orgRoster.ts:59` already uses.

`messages:getUnreadCount` (a measurement read with a mounted sidebar subscriber) answers the signed-in pre-organisation caller `{ refused: true, count: 0 }` rather than a bare `0`; a served caller keeps the bare number, anonymous is RAISED. The dashboard reads both shapes (`readUnreadCount`, dashboard PR #60).

**"Does a subscriber exist" is a MEASUREMENT, never a memory.** Enumerate before relying on it:

```
grep -rn "api\.<module>\." --include=*.tsx --include=*.ts \
  app components hooks lib contexts providers   # in vantage-peers-dashboard
```

At the time of writing, of the fourteen reads closed by PR #1349, **four** have a live `useQuery` (`businessUnits:list`, `mandates:list`, `profiles:listProfiles`, `messages:listByChannel`) and **ten** have none.

## Banned

- Returning a typed empty value, an empty envelope, or a zeroed aggregate to a caller presenting NO CREDENTIAL AT ALL.
- A zeroed numeric aggregate as a refusal, under any caller. A fabricated measurement is worse than a withheld one: an absent figure invites a retry, a false one is acted upon. This includes the ordinary org member, not only the anonymous caller: `issues:getStats` once carried `if (!scope.isMaster) return stats`, so a member received six zeros.
- A BARE empty array to an ordinary org member at a subscribed list read whose consumer already reads `.items`. The bare array is the shape that silently degrades; use `{ refused: true, items: [] }`.
- Giving the fleet master the envelope in order to "be consistent". The master's absence is the bare array with no `refused` key; if a refusal and an absence came out as the same bytes the delivery has not done its job, and the adjacent test pins exactly that.
- Passing `alsoRefusePreOrg: true` without an `isolation-contract:` marker in that same handler naming the enumeration that found zero subscribers.
- Inventing a second refusal helper, or open-coding a `throw new ConvexError("RBAC_DENIED…")` at a call site, instead of `requireResolvedCaller` / `requireScope`.
- Making a scoped caller's empty table throw in order to satisfy this rule — that is the rule inverted, and pole 3 (ABSENT) exists to catch it.
- Leaving the standard saying one thing while the code does another. If a delivery diverges from a written rule, the rule text is updated in the SAME delivery. That divergence is how R-50 came to certify the thing it exists to catch.

## What this rule does NOT yet cover — stated, not hidden

- **Six other fleet-master-only reads still answer an ORDINARY member with a typed empty value**, and none of them has a reactive subscriber, so each could raise: `fixPatterns:listAll`, `missionTemplates:listNames`, `errorMonitor:listErrors`, `errorMonitorFilters:listFilterRules`, `issueStatsQueries:getLatest`, `githubRepoMapping:list`. They are pinned in their current shape by `publicRegistrationResolvesCaller.test.ts` (third deny pole, `site.empty`). That is the same class as the three closed here, minus the fabricated number; it is a follow-up, not a decision that a member's silence is acceptable.
- **Two subscribed sites still answer the signed-in pre-organisation caller with the shape of an absence.** `messages:checkNewMessages` keeps a bare `[]` because `vantage-peers-dashboard/components/messages/message-timeline.tsx:69` subscribes to it and calls `.map()` on the raw result (an envelope would throw `map is not a function` inside the render, and a raise would crash it too); it is also a frozen bare-array contract. It closes when the dashboard reads `.items`. `businessUnits:list` keeps its typed-empty paging envelope `{ items: [], nextCursor: null }` with no `refused` key, and was not among the six sites of k1749w7ecx2yffr1hbhjpk8v858fbrf1. `checkNewMessages` also still answers an ANONYMOUS caller with `[]`.
- **Six uncovered no-arg reads still answer an anonymous caller with an empty success** (`diary:list`, `episodes:getCriticalInsights`, `errorMonitor:listDeployments`, `errorMonitorFilters:getPendingAliasReleases`, `orgRoster:getMyOrgRoster`, `tasks:listOverdue`), re-measured by the surface sweep in `refusalCarriesItsCode.test.ts`. `tasks:listOverdue` is a special case: #1354 closed its LEAK (a member is served only its own tenant's rows) but its refusal SHAPE is still typed-empty for an anonymous caller, so it is closed against the leak and open against this rule.
- **The MCP readers no longer swallow the envelope** (task k1730ybh4j5dfmq2nkpdsmf7y98fb77a). `list_peers` and `list_mandates` test `isRefusedEnvelope` BEFORE the `Array.isArray(x) ? x : []` coalescing and return an ERROR result whose text opens `REFUSED (RBAC_DENIED)`, names the tool and the backend door, and says it is NOT an empty result; an absence stays a plain `[]`. The sweep in `mcp-server/test/refusal-marker-survives-transport.test.ts` derives the envelope-capable doors from `convex/*.ts` and fails on any MCP call site of such a door that does not test `isRefusedEnvelope`. The coalescing shape occurs at 27 sites in `mcp-server/src`; only the two above read an envelope-capable door (`messages:listByChannel` and `messages:getUnreadCount` are envelope-capable and have no MCP reader). A NEW envelope door must be added to that test's expected set on purpose.

## Reference

Implementation: `convex/lib/auth.ts` (`requireResolvedCaller`, and the `anonymous` field on `OrgScope` that makes the two refused populations distinguishable at all). Three-pole tests: `convex/__tests__/refusalCarriesItsCode.test.ts`. Inverted contract poles: `convex/__tests__/publicRegistrationResolvesCaller.test.ts`, `convex/__tests__/allowNoIdentityMaster-reachability.test.ts`. Siblings: `.claude/rules/authority-attached-to-anonymous-object.md` (who the caller IS), this rule (how a refusal is SAID).

*Origin: task k177hpz3cx9bb842tc9201wf118f94sa — the refusal shape left standing by PR #1349.*
