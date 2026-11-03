# Read-visibility grant class: audit (task k1791fcdxk3ha55vgsbmjtpbm18cpv89, deliverable A)

First measured 2026-10-25 at origin/main `0e0c23e`. Re-measured 2026-11-03 at origin/main `72a97e11` (test commit `0d362df3`, fixtures unchanged: they already used agent IDs, org IDs and a roster).
`npx vitest run convex/__tests__/readVisibilityGrantClass.test.ts` -> 6 passed | 9 expected fail | 1 todo (16), identical to 2026-10-25. No class has closed since: all 9 expected-fail tests still fail.

## The class

A table carries a field naming who is granted access, and the read path never consults it. The grant exists in the data and produces nothing for a scoped grantee who is not the creator. Master bypasses the filter, which is why the class stays invisible to fleet callers.

## Scope, derived from the schema

```
awk '/^\t[A-Za-z_]+: defineTable\(/{split($1,a,":");t=a[1]} /^[ \t]+[A-Za-z]*(agents|Agents|agentIds|participant|assignedTo|assignee|pilot|Pilot|owner|Owner|members|Members|recipient|allowed|Allowed|grantee|reviewer|sharedWith|toAgent|fromAgent|watchers|visibleTo):/{print t"\t"NR"\t"$1" "$2}' convex/schema.ts
messageReceipts 249 recipient | missions 316 pilot | missions 317 agents | missions 351 agentIds | tasks 415 assignedTo
briefingNoteParticipants 920 participant | githubRepoMapping 1067 reviewer | githubOwnerBindings 1107 owner
businessUnits 1146 agents | recurringTasks 1191 assignedTo | missionTemplates 1286 assignedTo
```

## Identity used

Every test runs as an ordinary member of org `org-grants`, never as master or the service account: subject `user_grantee`, role `org:member`. The creator is a different agent.

## Inventory

| table | grant | door | state |
|---|---|---|---|
| tasks | assignee = agent on roster | `tasks:get` | CONSULTED-VIA-ORG-SCOPE |
| tasks | assignee = person `user:<sub>` | `tasks:get`, `tasks:list` | NOT-CONSULTED: the roster check (`convex/lib/auth.ts` `allowedOrchestrators.includes`) never admits a person |
| missions | pilot = agent on roster | `missions:get` | CONSULTED-VIA-ORG-SCOPE |
| missions | pilot = person | `missions:get`, `missions:list` (`keepMissionsOnScopeRoster`) | NOT-CONSULTED |
| missions | `agents` / `agentIds` | `missions:get` | NOT-CONSULTED: no door reads it (intent to be ruled) |
| recurringTasks | assignee = agent on roster | `recurringTasks:getById` | CONSULTED-VIA-ORG-SCOPE |
| recurringTasks | assignee = person | `recurringTasks:getById`, `list` | NOT-CONSULTED |
| briefingNotes | participants | `briefingNotes:get` | CONSULTED, in-query (`by_participantId_note`) |
| businessUnits | ownerId (agent) | `businessUnits:get` | CONSULTED-VIA-ORG-SCOPE |
| messageReceipts | recipient = person | `messages:listMyInbox` | CONSULTED, in-query |
| messageReceipts | channel `user:<sub>` | `messages:getById` | NOT-CONSULTED (`RBAC_DENIED not-on-channel`) |
| agentLinks | toAgentId | none | could-not-judge: no public read door |
| missionTemplates, githubRepoMapping, githubOwnerBindings | assignedTo / reviewer / owner | none | could-not-judge: routing/config, not a read grant on a row |

remaining: 4 NOT-CONSULTED classes (person assignee on tasks; person pilot and `agents[]` on missions; person assignee on recurringTasks; a person's direct message via `messages:getById`).

## Why each expected-fail test still fails (2026-11-03)

Measured by running the same file with `test.fails(` rewritten to `test(` (`sed 's/test\.fails(/test(/'`, scratch copy, deleted) and reading the 9 failures. Each fails at the read, on a grant that is in the data and not consulted; none fails at a fixture step (the six passing controls use the same world and the same grantee).

| test | failing line (test file) | what refuses |
|---|---|---|
| tasks:get, person assignee | 138 `expect(row?._id).toBe(taskId)`, got undefined | `isRowVisibleToScope` roster leg: `allowedOrchestrators.includes(assignedTo)` |
| tasks:list {assignedTo} | 147 `.toEqual([taskId])`, got [] | `filterByOrgScope` roster leg |
| tasks:list {} | 154 `.toEqual([taskId])`, got [] | `filterByOrgScope` roster leg |
| missions:get, person pilot | 208 `expect(row?._id).toBe(missionId)`, got undefined | roster leg |
| missions:list, person pilot | 218 `.toEqual([missionId])`, got [] | `keepMissionsOnScopeRoster` |
| missions:get, off-roster pilot, agents[] names grantee | 235 `expect(row?._id).toBe(missionId)`, got undefined | `agents[]` read by no door |
| recurringTasks:getById, person assignee | 276 the query call throws `RBAC_DENIED ... does not belong to the caller's organisation` | `isRowVisibleToScope` roster leg |
| recurringTasks:list, person assignee | 286 `.toEqual([id])`, got [] | roster leg |
| messages:getById, channel `user:user_grantee` | 396 the query call throws `RBAC_DENIED ... not-on-channel` | `isChannelOnScope`: only broadcast, `team/<slug>*` and `allowedOrchestrators.includes(channel)` |

## Open decisions (they gate the GREEN)

1. The fix sits on the scope/roster predicate. Under one-identity-layer it belongs in `@vantageos/cloud-identity`, not in a local VP helper.
2. Is `missions.agents[]` meant to grant read access? A roster narrows and never widens, so this needs a product ruling.

not_measured: whether the expected-fail tests turn green under any specific fix (no fix was written); the MCP-layer filters (`scopeFilterGet`, `scopeFilterList`); agent-token read paths (`verifiedActor`); `messages.listByChannel` / `listMessages` / `checkNewMessages` for a person recipient; `tasks.listPaginated`, `listByMission` and `listOverdue` (read in the source only); `businessUnits.list`; `briefingNotes.list` and `search`; whether a person assignee occurs in production data.
