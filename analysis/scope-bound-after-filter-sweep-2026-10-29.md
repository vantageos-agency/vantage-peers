# Scope bound after filter: re-measurement and class sweep (2026-10-29)

Task k179f1mq0sp896p0jp183b5yks8b12qj. Product: VantagePeers Cloud.
Subject: branch `sigma/scope-bound-after-filter`. First measured at 3d31f96f; rebased on `origin/main` 8aa3a7c1 (#1582 merged) and the two aggregate verdicts below re-read at that head.
Method: reading the code at that head. Sweep command: `rg -n "truncated|scopeFilterList|filterByOrgScope|nextCursor" convex/ mcp-server/src/` (505 matches outside tests, generated code and migrations; the call sites below are the ones that narrow a read).

The class: a bound (page-full test, cap, `truncated`) is evaluated on the population AFTER a filter narrowed it, or a filter removes rows and the result is a shorter list byte-identical to an empty one.

## Step 1: the three named sites

| Site | Verdict at this head |
|---|---|
| `convex/tasks.ts` `billingSummaryByProject` | At 3d31f96f: cap before the roster filter, roster removals silent. ALREADY FIXED at 8aa3a7c1 by #1582 (R-55): `taskScopeReach` + `taskRowFilter` put the tenant gate and roster INSIDE the read, before `take(BILLING_SUMMARY_SCAN_CAP + 1)` (`convex/tasks.ts`, search `taskScopeReach(scope)` in the handler), so `truncated` describes the scoped population. Not touched. The roster removals are no longer visible after the fact (they are never fetched), so no `scopeFiltered` is derivable without a second read; my earlier `countRosterFiltered` was dropped (it added an R-53 name-comparing site, ratchet rise=1). |
| `convex/tasks.ts` `taskDurationDistribution` | Same: already fixed at 8aa3a7c1. Not touched. |
| `mcp-server/src/tools.ts` `list_broadcast_status` (was :4528) | Still in the class, in two ways. (1) Backend `limit` cut the receipts (`truncated` computed there) and then `scopeFilterList` removed receipts from that cut page: `truncated` described a population the caller could not see, and the removed receipts were silent. (2) `receipts: []` for "all removed" equalled "nobody received". Note the Convex door `messages:listBroadcastStatus` (convex/messages.ts:2306) is NOT in the class: it gates tenant and channel before any receipt row is read and refuses by raising `RBAC_DENIED`. FIXED in the MCP reader: fetch at the tool cap, filter, then apply the caller's `limit` and compute `truncated` after the filter; `scopeFiltered` names the removed receipts (the door is tenant-gated, so every fetched receipt is in-tenant; a token bound to no organisation gets no count). |

## Step 2: class sweep (site, before/after/n.a.)

Convex
- convex/tasks.ts billingSummaryByProject / taskDurationDistribution: after (tenant gate + roster inside the read since #1582).
- convex/tasks.ts runTasksList (`list`, :1816-1833): `limit` slice BEFORE roster `filterByOrgScope`; bare array, no flag claims completeness. before, left as is: a roster-narrowed member can get fewer than `limit` rows with no signal. Tenant is bound in the index for members. Follow-up (bare array consumed widely, rule (c) needs a design call).
- convex/tasks.ts `listPaginated` (:2031): filter after `paginate`; `isDone`/`continueCursor` are the cursor's own, so a short page is never read as the end. after-safe (the roster drop is unannounced, same follow-up as above).
- convex/tasks.ts listByMission (:4079), overdue (:4155), searchTasksByKeyword (:5692): filter before `limit`/in the read, no bound flag. n.a. / after.
- convex/dashboard.ts :116, :161, :284: tenant bound before the cap through `by_orgId*` indexes, roster after; counts are not described as cap-bound. n.a.
- convex/stats.ts :162, :503; convex/improvisationDigest.ts :190: `filterByOrgScope` per streamed row ahead of the count. after.
- convex/lib/blockedOnMe.ts, convex/lib/taskClosureGate.ts (`walkIndexedTasks`): visibility predicate inside the stream, `truncated` set when the scan budget is hit. after (documented ETA-M28).
- convex/recurringTasks.ts :459: roster applied before the cursor filter and `limit`. after.
- convex/businessUnits.ts :817, convex/githubRepoMapping.ts :319: `nextCursor` from the page after cursor filter, scope applied in the read before. after.
- convex/messages.ts checkNewMessagesEnvelope (:1571): `truncated` over the recipient's own receipts. n.a.
- convex/messages.ts listBroadcastStatus (:2411): gated before the read. after.
- convex/okfBundle.ts, convex/okfBundleNode.ts, convex/reviewBacklogSweep.ts, convex/githubOwnerBinding.ts, convex/orgMembership.ts: byte or row budgets, no scope narrowing after. n.a.
- convex/migrations/*: operator-only batch walks. n.a.

MCP (`mcp-server/src/tools.ts`, `scopeFilterList` call sites)
- list_peers (:4219), list_tasks_by_mission (:6111), list_recurring_tasks (:7533), list_mandates (:8295): `nextCursor` decided on the FILTERED length (page "full" after narrowing), so a narrowed full page lost its cursor and read as the end. before. FIXED (`scopedPageContinuation` in mcp-server/src/paging.ts: raw page decides the cursor; `scopeFiltered` counts in-tenant rows removed, via `inTenantCount` for list_tasks_by_mission, whose tenant gate runs in the handler).
- list_issues (:9296): same post-filter cursor, but the tool is `{ kind: "master" }`; the filter is the identity for master. n.a., untouched.
- list_briefing_notes (:7208): cursor derived from `rawNotes`, never from survivors (comment at the site). after, the reference shape.
- list_episodes (:2937), list_memories (:3352), list_messages (:4368), list_tasks (:4868), list_bus (:8721), list_repo_mappings (:9001): cursor is the scoped read's own cursor computed by the Convex door. after.
- search_messages_by_keyword (:4510), search_tasks_by_keyword (:5170), search_briefing_notes_by_keyword (:7368), search_fix_patterns (:9854), list_fix_patterns (:9962/:9986), list_missions (:6353), list_diaries (:6833), list_errors (:10593): no narrowing filter between the raw page and the cursor (door-scoped or master-only). n.a.
- billing_summary_by_project: master-only reader; unchanged.

## Adjacent findings, NOT changed

- The signed-in-no-organisation branch of billingSummaryByProject / taskDurationDistribution (R-50 `refuseWithoutThrow`) still returns a zeroed aggregate with no `refused` marker, which `.claude/rules/refusal-is-distinguishable-from-absence.md` bans for a measurement read. Whether a dashboard `useQuery` subscribes to either was NOT enumerated (the dashboard repo is not in this tree). Open question for a follow-up, with `grep -rn "api\.tasks\.\(billingSummaryByProject\|taskDurationDistribution\)" app components hooks lib` in vantage-peers-dashboard.
- `tasks.list` limit-before-roster (above).

not_measured: the dashboard subscribers of the two aggregate reads; behaviour against a deployed backend (MCP tests run on a mocked Convex client); the sites marked "after"/"n.a." were classified by reading, not by a per-site probe; lines are at HEAD 3d31f96f and move with the fix commit.
