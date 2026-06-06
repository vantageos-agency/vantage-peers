---
title: "VP MCP Tools Audit Matrix — Day 92"
date: 2026-06-05
mission: k57a36y8w5t085bqr23dsmvb2d882506
task: k17ar0a22swt7qq4dthsb2w8dh883fv3
---

# VP MCP Tools Audit Matrix — Day 92

VantagePeers **Cloud** (multi-tenant) only. Never mix with Self-host.

## Tool Inventory Matrix

| # | Tool name | Category | Desc len (chars) | inputSchema present | outputSchema present | Case-sensitivity on orch-id fields | Scope-filter semantic | Symmetric pre-gate present | Naming convention (verb_noun_snake) | Example in description | Obsolete legacy-ref (fixed C4) | Severity | Notes |
|---|-----------|----------|-----------------|--------------------|--------------------|------------------------------------|-----------------------|---------------------------|-------------------------------------|------------------------|--------------------------|----------|-------|
| 1 | `store_memory` | ECRITURE | 159 | Yes | No | Case-sensitive (createdBy passthrough) | guardFrom(createdBy) + guardWrite(namespace) | Yes — guardFrom + guardWrite | Yes | No | No | P1 | outputSchema missing; content size guard present |
| 2 | `soft_delete_memory` | ECRITURE | 129 | Yes | No | N/A (no orch-id filter arg) | guardMasterOnly | Yes — guardMasterOnly | Yes | No | No | P1 | outputSchema missing; master-only restriction |
| 3 | `get_memory` | LECTURE | 95 | Yes | No | Case-sensitive | scopeFilterGet | Yes — scopeFilterGet collapses cross-tenant | Yes | No | No | P1 | outputSchema missing; non-leaky 404 shape |
| 4 | `recall` | LECTURE | 155 | Yes | No | N/A (no orch-id filter) | guardRead(namespace) + scopeFilterList implicit via backend | Yes — guardRead | Yes | No | No | P1 | outputSchema missing; fields lite/full present |
| 5 | `text_search` | LECTURE | 107 | Yes | No | N/A | guardRead(namespace) | Yes — guardRead | Yes | No | No | P1 | outputSchema missing |
| 6 | `hybrid_search` | LECTURE | 124 | Yes | No | N/A | guardRead(namespace) | Yes — guardRead | Yes | No | No | P1 | outputSchema missing; vectorWeight/textWeight args present |
| 7 | `store_episode` | ECRITURE | 227 | Yes | No | Case-sensitive (createdBy) | guardFrom(createdBy) + guardWrite(namespace) | Yes — guardFrom + guardWrite | Yes | No | No | P1 | outputSchema missing |
| 8 | `get_profile` | LECTURE | 133 | Yes | No | Case-sensitive (orchestratorId) | scopeFilterGet | Yes — scopeFilterGet | Yes | No | No | P1 | outputSchema missing |
| 9 | `update_profile` | ECRITURE | 201 | Yes | No | Case-sensitive (orchestratorId) | guardFrom(orchestratorId) | Yes — guardFrom | Yes | No | No | P1 | outputSchema missing |
| 10 | `list_memories` | LECTURE | 203 | Yes | No | Case-sensitive (createdBy filter) | guardRead(namespace) + scopeFilterList | Yes — guardRead | Yes | No | No | P1 | outputSchema missing; cursor paging present |
| 11 | `send_message` | ECRITURE | 215 | Yes | No | Case-sensitive (from) | guardFrom(from) | Yes — guardFrom | Yes | Yes ("broadcast") | Yes — FIXED in C4 (was: legacy ref) | P2 | outputSchema missing; legacy ref removed in C4 |
| 12 | `check_messages` | LECTURE | 244 | Yes | No | Case-sensitive (recipient) | fromAllowList check (symmetric to send_message.from) | Yes — explicit fromAllowList gate | Yes | No | Yes — FIXED in C4 (was: legacy ref) | P2 | outputSchema missing; symmetric gate correct per Eta retro |
| 13 | `mark_as_read` | ECRITURE | 82 | Yes | No | N/A | None (no orch-id scoping) | N/A — no identity arg | Yes | No | No | P1 | outputSchema missing; no per-receipt ownership check |
| 14 | `delete_message` | ECRITURE | 88 | Yes | No | Case-sensitive (callerOrchestrator optional) | guardFrom(callerOrchestrator) when provided | Partial — guard only when arg present | Yes | No | No | P1 | outputSchema missing; guardFrom conditional |
| 15 | `set_summary` | ECRITURE | 186 | Yes | No | Case-sensitive (orchestratorId) | guardFrom(orchestratorId) | Yes — guardFrom | Yes | Yes ("pi-chromebook") | No | P1 | outputSchema missing |
| 16 | `list_peers` | LECTURE | 145 | Yes | No | N/A | scopeFilterList (fromAllowList or namespaceReadPrefixes) | Yes — scopeFilterList | Yes | No | Yes — FIXED in C4 (was: legacy ref) | P2 | outputSchema missing; cursor paging present |
| 17 | `list_messages` | LECTURE | 166 | Yes | No | Case-sensitive (`from` filter arg) | scopeFilterList (post-query row filter) | **NO** — `from` filter arg has no pre-gate; scope collapse only post-query | Yes | No | No | **P1** | **FLAG: `list_messages.from` — sole identity-filter arg without symmetric pre-gate (Eta retro PR #654). Non-master client can pass any `from` value; filtering deferred to scopeFilterList post-query row filter, not pre-checked against fromAllowList.** |
| 18 | `list_broadcast_status` | LECTURE | 104 | Yes | No | N/A | scopeFilterList | Yes — scopeFilterList | Yes | No | No | P1 | outputSchema missing; doctrine exception: single-object-shape-not-list (no cursor) |
| 19 | `create_task` | ECRITURE | 133 | Yes | No | Case-sensitive (createdBy, assignedTo) | guardFrom(createdBy) + guardFrom(assignedTo) | Yes — dual guardFrom | Yes | No | No | P1 | outputSchema missing |
| 20 | `list_tasks` | LECTURE | 209 | Yes | No | Case-sensitive (assignedTo, createdBy) | listTasksGate (fromAllowList case-insensitive) | Yes — listTasksGate | Yes | No | No | P1 | outputSchema missing; cursor paging present; listTasksGate is dedicated gate (commit 24b39c5 regression fix) |
| 21 | `update_task` | ECRITURE | 96 | Yes | No | Case-sensitive (callerOrchestrator optional, assignedTo optional) | guardFrom when provided | Partial — conditional | Yes | No | No | P1 | outputSchema missing |
| 22 | `complete_task` | ECRITURE | 249 | Yes | No | Case-sensitive (callerOrchestrator optional) | guardFrom when provided | Partial — conditional | Yes | No | No | P1 | outputSchema missing; evidence-bound doctrine in description |
| 23 | `start_task` | ECRITURE | 130 | Yes | No | Case-sensitive (callerOrchestrator optional) | guardFrom when provided | Partial — conditional | Yes | No | No | P1 | outputSchema missing |
| 24 | `checkout_task` | ECRITURE | 163 | Yes | No | Case-sensitive (callerOrchestrator required) | guardFrom(callerOrchestrator) | Yes — guardFrom required arg | Yes | No | No | P1 | outputSchema missing; atomic claim semantics |
| 25 | `delete_task` | ECRITURE | 73 | Yes | No | Case-sensitive (callerOrchestrator optional) | guardFrom when provided | Partial — conditional | Yes | No | No | P1 | outputSchema missing |
| 26 | `block_task` | ECRITURE | 105 | Yes | No | Case-sensitive (callerOrchestrator optional) | guardFrom when provided | Partial — conditional | Yes | No | No | P1 | outputSchema missing |
| 27 | `add_task_dependency` | ECRITURE | 138 | Yes | No | Case-sensitive (callerOrchestrator optional) | guardFrom when provided | Partial — conditional | Yes | No | No | P1 | outputSchema missing |
| 28 | `list_tasks_by_mission` | LECTURE | 131 | Yes | No | N/A | scopeFilterList | Yes — scopeFilterList | Yes | No | No | P1 | outputSchema missing; cursor paging present |
| 29 | `create_mission` | ECRITURE | 171 | Yes | No | Case-sensitive (createdBy, pilot) | guardFrom(createdBy) + guardFrom(pilot) | Yes — dual guardFrom | Yes | No | No | P1 | outputSchema missing |
| 30 | `list_missions` | LECTURE | 170 | Yes | No | Case-sensitive (`pilot` filter; compared to userId not fromAllowList) | userId equality check (pilot === oauthCtx.userId) | Partial — uses userId not fromAllowList (inconsistent with list_tasks pattern) | Yes | No | No | **P1** | **FLAG: `list_missions.pilot` gate uses `oauthCtx.userId` equality (same pattern as pre-fix list_tasks regression commit 28db616). Should use fromAllowList. Inconsistent with list_tasks fix.** Cursor paging present. |
| 31 | `get_mission` | LECTURE | 107 | Yes | No | N/A | scopeFilterGet | Yes — scopeFilterGet | Yes | No | No | P1 | outputSchema missing |
| 32 | `update_mission` | ECRITURE | 99 | Yes | No | Case-sensitive (pilot optional) | guardFrom(pilot) when provided | Partial — conditional | Yes | No | No | P1 | outputSchema missing |
| 33 | `update_mission_status` | ECRITURE | 67 | Yes | No | N/A | None | No — no identity arg and no scope guard | Yes | No | No | **P0** | **No scope guard at all — any non-master token can change any mission's status if they know the missionId. Should at minimum check oauthCtx scope before writing.** |
| 34 | `write_diary` | ECRITURE | 128 | Yes | No | Case-sensitive (orchestrator) | guardFrom(orchestrator) | Yes — guardFrom | Yes | No | No | P1 | outputSchema missing; anti-spoof createdBy derived from oauthCtx.userId |
| 35 | `get_diary` | LECTURE | 101 | Yes | No | Case-sensitive (orchestrator) | scopeFilterGet | Yes — scopeFilterGet | Yes | No | No | P1 | outputSchema missing |
| 36 | `list_diaries` | LECTURE | 131 | Yes | No | Case-sensitive (orchestrator or createdBy; compared to userId) | userId equality (orchestrator===myId OR createdBy===myId) | Yes — requires explicit self-scope | Yes | No | No | P1 | outputSchema missing; cursor paging present; uses userId comparison (symmetric intent, different mechanism from fromAllowList) |
| 37 | `create_briefing_note` | ECRITURE | 426 | Yes | No | Case-sensitive (createdBy) | guardFrom(createdBy) | Yes — guardFrom | Yes | No | No | P1 | outputSchema missing; lengthy linkedMemoryIds disclaimer in description (inflates char count) |
| 38 | `update_briefing_note` | ECRITURE | 191 | Yes | No | Case-sensitive (callerOrchestrator) | guardFrom(callerOrchestrator) | Yes — guardFrom | Yes | No | No | P1 | outputSchema missing; RBAC deny-by-default; schema from exported updateBriefingNoteSchema |
| 39 | `get_briefing_note` | LECTURE | 145 | Yes | No | N/A | scopeFilterGet | Yes — scopeFilterGet | Yes | No | No | P1 | outputSchema missing; non-leaky 404 |
| 40 | `list_briefing_notes` | LECTURE | 100 | Yes | No | N/A | scopeFilterList | Yes — scopeFilterList | Yes | No | No | P1 | outputSchema missing; cursor paging present |
| 41 | `register_component` | ECRITURE | 133 | Yes | No | Case-sensitive (createdBy) | guardFrom(createdBy) | Yes — guardFrom | Yes | No | No | P1 | outputSchema missing; upsert by name+type |
| 42 | `list_components` | LECTURE | 120 | Yes | No | N/A | scopeFilterList | Yes — scopeFilterList | Yes | No | No | P1 | outputSchema missing; cursor paging present |
| 43 | `get_component` | LECTURE | 76 | Yes | No | N/A | scopeFilterGet | Yes — scopeFilterGet | Yes | No | No | P1 | outputSchema missing |
| 44 | `update_component` | ECRITURE | 89 | Yes | No | N/A (no orch-id arg) | None | No — no identity arg; no scope guard | Yes | No | No | **P0** | **No auth check — any token can update any component by ID. Missing guardFrom or guardMasterOnly.** |
| 45 | `delete_component` | ECRITURE | 57 | Yes | No | N/A | None | No — no identity arg; no scope guard | Yes | No | No | **P0** | **No auth check — any token can delete any component by ID. Missing guardFrom or guardMasterOnly.** |
| 46 | `search_components` | LECTURE | 76 | Yes | No | N/A | scopeFilterList | Yes — scopeFilterList | Yes | No | No | P1 | outputSchema missing; doctrine exception: relevance-ranked (no cursor) |
| 47 | `create_recurring_task` | ECRITURE | 164 | Yes | No | Case-sensitive (createdBy, assignedTo) | guardFrom(createdBy) + guardFrom(assignedTo) | Yes — dual guardFrom | Yes | Yes ("every 30min") | No | P1 | outputSchema missing |
| 48 | `list_recurring_tasks` | LECTURE | 113 | Yes | No | Case-sensitive (assignedTo) | scopeFilterList | Yes — scopeFilterList | Yes | No | No | P1 | outputSchema missing; cursor paging present |
| 49 | `pause_recurring_task` | ECRITURE | 71 | Yes | No | N/A | None | No — no identity arg; no scope guard | Yes | No | No | **P0** | **No auth check — any token can pause any recurring task by ID.** |
| 50 | `resume_recurring_task` | ECRITURE | 63 | Yes | No | N/A | None | No — no identity arg; no scope guard | Yes | No | No | **P0** | **No auth check — any token can resume any recurring task by ID.** |
| 51 | `delete_recurring_task` | ECRITURE | 52 | Yes | No | N/A | None | No — no identity arg; no scope guard | Yes | No | No | **P0** | **No auth check — any token can delete any recurring task by ID.** |
| 52 | `update_recurring_task` | ECRITURE | 131 | Yes | No | Case-sensitive (assignedTo optional) | guardFrom(assignedTo) when provided | Partial — conditional on assignedTo | Yes | No | No | P1 | outputSchema missing; guardFrom only when assignedTo present |
| 53 | `create_mandate` | ECRITURE | 222 | Yes | No | Case-sensitive (requestedBy, fulfilledBy) | guardFrom(requestedBy) + guardFrom(fulfilledBy) | Yes — dual guardFrom | Yes | No | No | P1 | outputSchema missing |
| 54 | `accept_mandate` | ECRITURE | 102 | Yes | No | Case-sensitive (callerOrchestrator) | guardFrom(callerOrchestrator) | Yes — guardFrom | Yes | No | No | P1 | outputSchema missing |
| 55 | `update_mandate` | ECRITURE | 149 | Yes | No | Case-sensitive (callerOrchestrator) | guardFrom(callerOrchestrator) | Yes — guardFrom | Yes | No | No | P1 | outputSchema missing |
| 56 | `settle_mandate` | ECRITURE | 199 | Yes | No | Case-sensitive (callerOrchestrator) | guardFrom(callerOrchestrator) | Yes — guardFrom | Yes | No | No | P1 | outputSchema missing |
| 57 | `validate_mandate_spending` | LECTURE | 114 | Yes | No | N/A | None | No — no identity arg (query-only, reads public spend limits) | Yes | No | No | P2 | outputSchema missing; read-only query; no sensitive data leak risk |
| 58 | `list_mandates` | LECTURE | 200 | Yes | No | Case-sensitive (requestedBy, fulfilledBy) | scopeFilterList | Yes — scopeFilterList | Yes | No | No | P1 | outputSchema missing; cursor paging present |
| 59 | `create_bu` | ECRITURE | 119 | Yes | No | Case-sensitive (orchestratorId) | guardFrom(orchestratorId) | Yes — guardFrom | Yes | No | No | P1 | outputSchema missing |
| 60 | `update_bu` | ECRITURE | 104 | Yes | No | Case-sensitive (orchestratorId optional) | guardFrom(orchestratorId) when provided | Partial — conditional | Yes | No | No | P1 | outputSchema missing |
| 61 | `get_bu` | LECTURE | 88 | Yes | No | N/A | scopeFilterGet | Yes — scopeFilterGet | Yes | No | No | P1 | outputSchema missing |
| 62 | `list_bus` | LECTURE | 124 | Yes | No | Case-sensitive (orchestratorId filter) | scopeFilterList | Yes — scopeFilterList | Yes | No | No | P1 | outputSchema missing; cursor paging present |
| 63 | `delete_bu` | ECRITURE | 62 | Yes | No | N/A | None | No — no identity arg; no scope guard | Yes | No | No | **P0** | **No auth check — any token can delete any BU by ID. Missing guardFrom or guardMasterOnly.** |
| 64 | `add_repo_mapping` | ECRITURE | 131 | Yes | No | N/A | None | No — no identity arg; no scope guard | Yes | No | No | **P0** | **No auth check — any token can add/overwrite repo mappings.** |
| 65 | `list_repo_mappings` | LECTURE | 162 | Yes | No | N/A | scopeFilterList | Yes — scopeFilterList | Yes | No | No | P1 | outputSchema missing; cursor paging present |
| 66 | `remove_repo_mapping` | ECRITURE | 103 | Yes | No | N/A | None | No — no identity arg; no scope guard | Yes | No | No | **P0** | **No auth check — any token can remove repo mappings.** |
| 67 | `list_issues` | LECTURE | 164 | Yes | No | Case-sensitive (assignedTo) | scopeFilterList | Yes — scopeFilterList | Yes | No | No | P1 | outputSchema missing; cursor paging present; multi-query dispatch (by orchestrator/project/status) |
| 68 | `get_issue` | LECTURE | 74 | Yes | No | N/A | scopeFilterGet | Yes — scopeFilterGet | Yes | No | No | P1 | outputSchema missing |
| 69 | `update_issue_status` | ECRITURE | 59 | Yes | No | N/A | None | No — no identity arg; no scope guard | Yes | No | No | **P0** | **No auth check — any token can change any issue status.** |
| 70 | `link_commit_to_issue` | ECRITURE | 75 | Yes | No | Case-sensitive (fixedBy string) | None | No — fixedBy is free string, no guardFrom | Yes | No | No | P1 | outputSchema missing; fixedBy not validated against identity (intended for human names too) |
| 71 | `verify_issue` | ECRITURE | 70 | Yes | No | Case-sensitive (verifiedBy string) | None | No — verifiedBy is free string, no guardFrom | Yes | No | No | P1 | outputSchema missing; same pattern as link_commit_to_issue |
| 72 | `issue_stats` | LECTURE | 78 | Yes | No | N/A | scopeFilterGet | Yes — scopeFilterGet | Yes | No | No | P1 | outputSchema missing; aggregate read |
| 73 | `create_fix_pattern` | ECRITURE | 163 | Yes | No | Case-sensitive (createdBy) | guardFrom(createdBy) | Yes — guardFrom | Yes | No | No | P1 | outputSchema missing |
| 74 | `add_fix_attempt` | ECRITURE | 157 | Yes | No | Case-sensitive (createdBy) | guardFrom(createdBy) | Yes — guardFrom | Yes | No | No | P1 | outputSchema missing |
| 75 | `validate_fix` | ECRITURE | 72 | Yes | No | N/A | None | No — no identity arg; no scope guard | Yes | No | No | **P0** | **No auth check — any token can validate any fix pattern.** |
| 76 | `search_fix_patterns` | LECTURE | 161 | Yes | No | N/A | scopeFilterList | Yes — scopeFilterList | Yes | No | No | P1 | outputSchema missing; semantic action; doctrine exception (no cursor) |
| 77 | `list_fix_patterns` | LECTURE | 171 | Yes | No | N/A | scopeFilterList | Yes — scopeFilterList | Yes | No | No | P1 | outputSchema missing; cursor paging present; dual dispatch (by project / all) |
| 78 | `link_issue_to_pattern` | ECRITURE | 82 | Yes | No | N/A | None | No — no identity arg; no scope guard | Yes | No | No | **P0** | **No auth check — any token can link issues to patterns.** |
| 79 | `get_mission_template` | LECTURE | 145 | Yes | No | N/A | scopeFilterGet | Yes — scopeFilterGet | Yes | Yes ("issue-resolution-v2") | No | P1 | outputSchema missing |
| 80 | `update_mission_template` | ECRITURE | 157 | Yes | No | Case-sensitive (createdBy) | guardFrom(createdBy) | Yes — guardFrom | Yes | No | No | P1 | outputSchema missing; upsert by name |
| 81 | `instantiate_template_into_mission` | ECRITURE | 196 | Yes | No | N/A | scopeFilterGet pre-check on target mission | Yes — pre-mutation mission scope check | Yes | No | No | P1 | outputSchema missing; scope guard via pre-fetch pattern |
| 82 | `add_deployment` | ECRITURE | 273 | Yes | No | N/A | None | No — no identity arg; no scope guard | Yes | No | No | **P0** | **No auth check — any token can register a deployment for error monitoring. High-impact: exposes admin deploy keys indirectly.** |
| 83 | `remove_deployment` | ECRITURE | 96 | Yes | No | N/A | None | No — no identity arg; no scope guard | Yes | No | No | **P0** | **No auth check — any token can deactivate monitoring.** |
| 84 | `list_errors` | LECTURE | 213 | Yes | No | N/A | scopeFilterList | Yes — scopeFilterList | Yes | No | No | P1 | outputSchema missing; cursor paging present |
| 85 | `get_error` | LECTURE | 122 | Yes | No | N/A | scopeFilterGet | Yes — scopeFilterGet | Yes | No | No | P1 | outputSchema missing |

---

## Roll-Up Summary

- **Total tools: 85**
- LECTURE (reads): 38 / ECRITURE (writes): 47 / META: 0
- With outputSchema: 0 / Without outputSchema: **85** (100% gap)
- All tools have inputSchema: Yes (85/85)
- With case-insensitive lookup: 0 — all orchestrator-id fields are case-sensitive string comparisons
- With symmetric pre-gate: 62 / Without symmetric pre-gate: 23
  - Pre-gate absent list (23 tools flagged):
    1. `list_messages` — `from` filter arg has no pre-gate (Eta retro PR #654, P1)
    2. `list_missions` — `pilot` gate uses `oauthCtx.userId` equality, not `fromAllowList` (inconsistent, P1)
    3. `mark_as_read` — no receipt ownership check
    4. `delete_message` — conditional only
    5. `update_mission_status` — no scope guard at all (P0)
    6. `update_component` — no auth check (P0)
    7. `delete_component` — no auth check (P0)
    8. `pause_recurring_task` — no auth check (P0)
    9. `resume_recurring_task` — no auth check (P0)
    10. `delete_recurring_task` — no auth check (P0)
    11. `validate_mandate_spending` — read-only, acceptable (P2)
    12. `delete_bu` — no auth check (P0)
    13. `add_repo_mapping` — no auth check (P0)
    14. `remove_repo_mapping` — no auth check (P0)
    15. `update_issue_status` — no auth check (P0)
    16. `link_commit_to_issue` — free-string fixedBy, no guardFrom (P1)
    17. `verify_issue` — free-string verifiedBy, no guardFrom (P1)
    18. `validate_fix` — no auth check (P0)
    19. `link_issue_to_pattern` — no auth check (P0)
    20. `add_deployment` — no auth check (P0, high-impact)
    21. `remove_deployment` — no auth check (P0)
    22. `update_task` — conditional only
    23. `complete_task` — conditional only
- **P0 count: 14** (production write-without-auth bugs)
- **P1 count: 69** (outputSchema missing across all 85 + identity-filter gaps)
- **P2 count: 2** (validate_mandate_spending read-only no-guard; cosmetic legacy-refs (fixed in C4))
- Obsolete legacy-ref (fixed C4)s total: **3** (lines 1260, 1353, 1605 — in send_message, check_messages, list_peers descriptions)

---

## Severity Definitions

- **P0** = production bug live — a non-master OAuth token can execute a write operation with zero identity or scope validation. Any tenant with a valid (but non-master) bearer token can mutate data that does not belong to them. Examples: `update_component`, `delete_component`, `pause_recurring_task`, `resume_recurring_task`, `delete_recurring_task`, `delete_bu`, `add_repo_mapping`, `remove_repo_mapping`, `update_issue_status`, `validate_fix`, `link_issue_to_pattern`, `add_deployment`, `remove_deployment`, `update_mission_status`. The scope-filter regression pattern seen in PR #654 can recur here.
- **P1** = UX degraded — outputSchema missing on all 85 tools means MCP clients (Claude.ai, ChatGPT, etc.) cannot perform shape-checking on tool results. Clients receive raw text and must parse defensively. Also includes identity-filter args without symmetric pre-gate (`list_messages.from`, `list_missions.pilot`) that leak query scope.
- **P2** = cosmétique — stale legacy-refs in tool descriptions — FIXED in C4. `validate_mandate_spending` missing guard is P2 because it is a read-only query with no sensitive data path.

---

## Methodology

- **Source scanned:** `mcp-server/src/tools.ts` lines 573–6311
- **Count derivation:** `grep -c "server\.tool(" mcp-server/src/tools.ts` → **85**. Cross-checked against `mcp-server/dist/src/tools.js` (built artifact): also **85**. No tools missed.
- **Cross-reference:** `convex/_generated/api.d.ts` reviewed for mutation/query names; all Convex calls use string-cast `as any` bypassing typed API — this is a separate debt item (no Convex typed API usage).
- **outputSchema count:** `grep -c "outputSchema" mcp-server/src/tools.ts` → **0**. Confirmed: zero tools declare outputSchema.
- **Obsolete legacy-refs:** was 3 — FIXED in C4. `grep -ic "claude-peers" mcp-server/src/tools.ts` → **0**.
- **symmetric pre-gate analysis:** manual scan of each handler body for `guardFrom`, `guardRead`, `guardWrite`, `guardMasterOnly`, `isMasterScope`, `fromAllowList`, `oauthCtx.userId` equality checks against the filter arg.
- **Reproducibility:** Re-run with `grep -n 'server\.tool(' mcp-server/src/tools.ts | wc -l` to recount. Eta or Athena can re-run for vCRM by swapping the source path.

---

## P0 Priority Fix List (14 tools — ordered by blast radius)

| Priority | Tool | Missing gate | Recommended fix |
|----------|------|-------------|-----------------|
| 1 | `add_deployment` | None | `guardMasterOnly("add_deployment")` — admin op exposing deploy key env var refs |
| 2 | `remove_deployment` | None | `guardMasterOnly("remove_deployment")` |
| 3 | `update_mission_status` | None | `guardMasterOnly` or `guardFrom(callerOrchestrator)` with required callerOrchestrator arg |
| 4 | `update_component` | None | Add optional `callerOrchestrator` + `guardFrom` or `guardMasterOnly` |
| 5 | `delete_component` | None | `guardMasterOnly("delete_component")` |
| 6 | `delete_bu` | None | `guardMasterOnly("delete_bu")` |
| 7 | `add_repo_mapping` | None | `guardMasterOnly("add_repo_mapping")` |
| 8 | `remove_repo_mapping` | None | `guardMasterOnly("remove_repo_mapping")` |
| 9 | `update_issue_status` | None | Add optional `callerOrchestrator` + `guardFrom` |
| 10 | `validate_fix` | None | Add optional `callerOrchestrator` + `guardFrom` |
| 11 | `link_issue_to_pattern` | None | `guardMasterOnly` or add `callerOrchestrator` |
| 12 | `pause_recurring_task` | None | Add optional `callerOrchestrator` + `guardFrom` |
| 13 | `resume_recurring_task` | None | Add optional `callerOrchestrator` + `guardFrom` |
| 14 | `delete_recurring_task` | None | Add optional `callerOrchestrator` + `guardFrom` |
