# Labels to agent IDs: migration plan for the public doors (VantagePeers Cloud)

Product: VantagePeers Cloud (hosted MCP on Railway + Convex). Not Self-host.
Task: k174vk9f8r6hkj4mbshr13msp98hcy11. Plan only: no code, no deploy, no prod.
Subject revision: `origin/main` = `48ac259ae08d03d5cdefdc00a9b0490915fd3ef9` (git rev-parse origin/main, 2026-11-01).
Authoring station: worktree of sigma, branch `sigma/labels-to-ids-plan`.

Rules this plan is bound by (read first): `.claude/rules/railway-mcp-redeploy.md` (rule 4: expand, MCP ships, then contract; never a removal in the same rollout as an MCP change), `authority-attached-to-anonymous-object.md` (the principal's claims are the only key into a mapping; REFUSE, do not default), `http-boundary-derives-from-principal.md` (the transport reads verified claims), `refusal-is-distinguishable-from-absence.md` (a refusal says so; never a typed empty for it).

## 0. Summary and the one finding that changes the shape of the work

- 70 public Convex doors carry at least one agent-label argument (64 declare it in their own `args:` block, 6 take it from a shared validator). 60 of the 70 are called by the MCP (listed in `MCP_CALLED_FUNCTIONS`, `mcp-server/src/backendContract.ts:46`; corrected from 58, see 1.3).
- **The expand phase is already about half built (35 of 70 doors forward an ID today).** 42 of the 70 doors already declare `verifiedActor` (the agent ID plus org, forwarded by the MCP from `ctx.actor.agentId` or the seat stamp, believed from the service account only). 35 of those are in `VERIFIED_ACTOR_DOORS` (`mcp-server/src/verifiedActor.ts:25`); the other 7 declare it but the MCP does not forward it yet (listed in section 1.3). `messages:sendMessage` (`fromAgentId`, convex/messages.ts:1089), `tasks:create/update` (`assignedToAgentId`, convex/tasks.ts:693, :2211), `tasks:bulkComplete` / `briefingNotes:update` / `tasks:create` (`callerActorId`) and `mandates:create` (`fulfilledByAgentId`, convex/mandates.ts:105) already take IDs. The remaining work is therefore: (a) the 28 doors with no ID path at all, (b) the 7 declared-but-unforwarded doors, (c) the 7 `findAgentByName` call sites that still turn a label into a row, (d) legacy rows that store only a label.
- The label stays accepted for the whole expand phase. The contract phase (section 4) is an operator decision and is not scheduled here.
- Expand is 8 PR-sized steps (section 3). Order: Convex first, read-back, MCP last under the rollout token.

## 1. Inventory (reproduced by commands)

### 1.1 Commands run (all from the worktree root, on 48ac259a)

```
git rev-parse origin/main
  -> 48ac259ae08d03d5cdefdc00a9b0490915fd3ef9

grep -n "findAgentByName" -r convex mcp-server/src --include=*.ts | grep -v __tests__
  -> convex/lib/actorIds.ts:57        convex/messages.ts:967, :993
     convex/lib/seatAgent.ts:117      convex/lib/auth.ts:1155
     convex/lib/fleetActors.ts:68     convex/lib/inboxReader.ts:224
     (+ the definition convex/lib/agentIdentity.ts:251)
  = 7 call sites in 6 files. Pinned by convex/__tests__/agentRegistryNoNameSelection.test.ts
    ("the by-name lookup has exactly the owned callers"): auth.ts 1, messages.ts 2, inboxReader 1,
    actorIds 1, seatAgent 1, fleetActors 1.

npx -y @vantageos/backend-doctor@0.5.0 . --json-evidence <dir>
  -> exit 1; sha 48ac259ae08d03d5cdefdc00a9b0490915fd3ef9; checked 54 / total 56
     mechanical_rule_counts: CR-2 246, CR-3 16, R-5 62, R-53 323, R-54 132, R-55 22, R-56 2
     (the evidence file is backend-doctor-48ac259ae08d03d5cdefdc00a9b0490915fd3ef9.json;
      a second file backend-doctor-8e4dc569... was also in the output directory; its origin was not determined and it is not used here)
```

Note on the invocation: the task brief writes `--json-evidence` without a value; the 0.5.0 CLI requires `<file-or-dir>` and exits 2 without one ("flag --json-evidence needs a value"). That first failed run is why a directory argument was used.

Module counts for the files this plan touches (from `mechanical_rule_module_counts`, same JSON):

| module | CR-2 | R-53 | module | CR-2 | R-53 |
|---|---|---|---|---|---|
| messages | 29 | 39 | recurringTasks | 8 | 8 |
| tasks | 15 | 31 | missions | 6 | 6 |
| auth (convex/lib/auth.ts) | 13 | 11 | mandates | 4 | 5 |
| mcp-server/src/auth | 14 | 11 | profiles | 4 | 9 |
| mcp-server/src/tools | 10 | 22 | businessUnits | 3 | 7 |
| inboxReader | 7 | 7 | githubRepoMapping | 4 | 8 |
| briefingNotes | 8 | 13 | missionTemplates | 5 | 4 |
| diary | 9 | 6 | seatAgent | 1 | 4 |
| actorIds | 0 | 2 | taskActors | 1 | 3 |
| fleetActors | 1 | 1 | personPrincipal | 1 | 1 |
| memories | 3 | 4 | fixPatterns | 1 | 5 |
| errorMonitor | 4 | 3 | episodes | 1 | 1 |

Caveat that matters for every "expected drop" in section 4: the doctor's module counts are per module, not per door, and not per label argument. The doctor report names each site; this plan did not map each of the 246 / 323 sites to a door. The drops in section 4 are therefore upper bounds, stated as such.

### 1.2 Doors that carry an agent label, by command

Method (scripts kept in the scratchpad, not shipped): for each `convex/*.ts` except `schema.ts`, take every line inside a public `query(` / `mutation(` / `action(` `args: {` block whose key is one of `from, recipient, createdBy, assignedTo, callerOrchestrator, participants, pilot, orchestratorId, orchestrator, requestedBy, reviewer`; internal functions (`internalQuery/Mutation/Action`) excluded. Equivalent hand check:

```
grep -nE "^\s+(from|recipient|createdBy|assignedTo|callerOrchestrator|participants|pilot|orchestratorId|orchestrator|requestedBy|reviewer):\s*(v\.|creatorValidator|assigneeValidator)" convex/*.ts
```

(over-matches `returns:` blocks and internal functions; the script is the filtered form.) Result: **75 label arguments in 64 public doors**, plus **6 doors whose label arguments come from a shared validator**:

- `createTaskArgsValidatorWithCredential` (convex/tasks.ts:686-696: `assignedTo`, `createdBy`) -> `tasks:create` (convex/tasks.ts:875). `createTaskArgsValidator` (:665) also feeds the INTERNAL `createForWebhook` (:1051) and is out of scope.
- `tasksListArgsValidator` (convex/tasks.ts:1365-1372: `assignedTo`, `createdBy`) -> `tasks:list` (:1952). INTERNAL `listForWebhook` out of scope.
- `missionsListArgsValidator` (convex/missions.ts:759-761: `pilot`) -> `missions:list` (:770).
- `scheduleActorProofArgs` (convex/recurringTasks.ts:78-79: `callerOrchestrator`) -> `recurringTasks:pause` (:651), `:resume` (:691), `:remove` (:737) and the spread at :484 of `update`.

Total: **70 doors, 81 label declarations** (75 inside the doors' own `args:` blocks + 6 label keys inside the four shared validators).

`creatorValidator` is `v.string()` (convex/schema.ts:27); `assigneeValidator` is `v.string()` (convex/tasks.ts:123, convex/recurringTasks.ts:99). Nothing in the validator shape distinguishes a label from an ID today.

Heuristic limits, said once: the scan is textual. It can miss an argument built from a spread other than the four above, and it can over-count a key that sits in a nested `v.object` inside `args`. Coverage columns below (`VA`) come from `'verifiedActor'` appearing in the door's source text, which a comment can satisfy. See `not_measured:`.

### 1.3 Per-door table

Legend. `args`: label argument(s) of the door. `VA`: door declares `verifiedActor`. `MCP tool @ tools.ts:line`: the tool that calls the door (nearest preceding tool-name line; two attributions are known to be imprecise, marked `?`). The helper each label reaches is in 1.4.

Output of `tools.py` (verbatim; this is the evidence for the table):

```
briefingNotes:create	args=participants,createdBy	VA=VA	tools=create_briefing_note@tools.ts:7015
briefingNotes:deleteBriefingNote	args=callerOrchestrator	VA=VA	tools=NONE
briefingNotes:searchBriefingNotesByKeyword	args=createdBy	VA=--	tools=search_briefing_notes_by_keyword@tools.ts:7425
briefingNotes:update	args=callerOrchestrator,participants	VA=VA	tools=update_briefing_note@tools.ts:7086
businessUnits:create	args=orchestratorId	VA=--	tools=create_bu@tools.ts:8496
businessUnits:list	args=orchestratorId	VA=--	tools=list_bus@tools.ts:8779
businessUnits:update	args=callerOrchestrator,orchestratorId	VA=--	tools=update_bu@tools.ts:8612
diary:deleteDiary	args=callerOrchestrator	VA=--	tools=NONE
diary:get	args=orchestrator	VA=--	tools=get_diary@tools.ts:6784
diary:list	args=orchestrator,createdBy	VA=--	tools=list_diaries@tools.ts:6909
diary:listByDateRange	args=from,orchestrator	VA=--	tools=NONE
diary:write	args=orchestrator,createdBy	VA=--	tools=write_diary@tools.ts:6725
episodes:storeEpisode	args=createdBy	VA=--	tools=store_episode@tools.ts:2809
errorMonitor:addDeployment	args=orchestrator	VA=--	tools=add_deployment@tools.ts:10519
fixPatterns:addAttempt	args=createdBy	VA=VA	tools=add_fix_attempt@tools.ts:9812
fixPatterns:create	args=createdBy	VA=--	tools=create_fix_pattern@tools.ts:9758
githubRepoMapping:add	args=orchestrator,reviewer	VA=--	tools=add_repo_mapping@tools.ts:8957
mandates:accept	args=callerOrchestrator	VA=VA	tools=accept_mandate@tools.ts:8005
mandates:create	args=requestedBy	VA=--	tools=create_mandate@tools.ts:7945
mandates:list	args=requestedBy	VA=--	tools=list_mandates@tools.ts:8364
mandates:settle	args=callerOrchestrator	VA=VA	tools=settle_mandate@tools.ts:8113
mandates:update	args=callerOrchestrator	VA=VA	tools=update_mandate@tools.ts:8063
memories:listMemories	args=createdBy	VA=--	tools=list_episodes@tools.ts:2974; list_memories@tools.ts:3385
memories:storeMemory	args=createdBy	VA=--	tools=store_memory@tools.ts:2429
memoriesScoped:storeMemoryScoped	args=createdBy	VA=--	tools=NONE
messages:checkNewMessages	args=recipient	VA=VA	tools=NONE-in-tools.ts-scan; IN MCP_CALLED_FUNCTIONS (backendContract.ts:108)
messages:checkNewMessagesEnvelope	args=recipient	VA=VA	tools=check_messages@tools.ts:3795
messages:deleteMessage	args=callerOrchestrator	VA=VA	tools=delete_message@tools.ts:4077
messages:getUnreadCount	args=orchestratorId	VA=VA	tools=NONE-in-tools.ts-scan; IN MCP_CALLED_FUNCTIONS (backendContract.ts:112)
messages:listByChannelPaginated	args=from	VA=--	tools=NONE
messages:listMessages	args=from	VA=--	tools=list_messages@tools.ts:4396
messages:markAsRead	args=callerOrchestrator	VA=VA	tools=mark_as_read@tools.ts:4024
messages:searchMessagesByKeyword	args=from	VA=--	tools=search_messages_by_keyword@tools.ts:4529
messages:sendMessage	args=from	VA=VA	tools=send_message@tools.ts:3657
missionTemplates:instantiateTemplateIntoMission	args=callerOrchestrator	VA=--	tools=instantiate_template_into_mission@tools.ts:10375
missionTemplates:upsert	args=createdBy	VA=--	tools=update_mission_template@tools.ts:10271
missions:create	args=pilot,createdBy	VA=VA	tools=create_mission@tools.ts:6325
missions:list	args=(shared validator)	VA=--	tools=list_missions@tools.ts:6433
missions:update	args=callerOrchestrator,pilot	VA=VA	tools=update_mission@tools.ts:6610
profiles:getProfile	args=orchestratorId	VA=VA	tools=get_profile@tools.ts:3176
profiles:getProfileWithMemories	args=orchestratorId	VA=VA	tools=NONE
profiles:listProfiles	args=orchestratorId	VA=VA	tools=None@tools.ts:2078; list_peers@tools.ts:4239
profiles:updateDynamic	args=orchestratorId	VA=VA	tools=set_summary@tools.ts:4133
profiles:upsertProfile	args=orchestratorId	VA=VA	tools=update_profile@tools.ts:3271
recurringTasks:create	args=assignedTo,createdBy	VA=VA	tools=create_recurring_task@tools.ts:7527
recurringTasks:list	args=assignedTo	VA=--	tools=list_recurring_tasks@tools.ts:7616
recurringTasks:pause	args=(shared validator)	VA=VA	tools=pause_recurring_task@tools.ts:7688
recurringTasks:remove	args=(shared validator)	VA=VA	tools=delete_recurring_task@tools.ts:7766
recurringTasks:resume	args=(shared validator)	VA=VA	tools=resume_recurring_task@tools.ts:7725
recurringTasks:update	args=assignedTo	VA=VA	tools=update_recurring_task@tools.ts:7861
tasks:attachReviewArtifact	args=callerOrchestrator	VA=VA	tools=NONE
tasks:blockTask	args=callerOrchestrator	VA=VA	tools=block_task@tools.ts:6013
tasks:bulkComplete	args=callerOrchestrator	VA=VA	tools=list_tasks@tools.ts:5069
tasks:checkout	args=callerOrchestrator	VA=VA	tools=checkout_task@tools.ts:5875
tasks:complete	args=callerOrchestrator	VA=VA	tools=complete_task@tools.ts:5525
tasks:correctSegment	args=callerOrchestrator	VA=VA	tools=correct_task_segment@tools.ts:5816
tasks:create	args=(shared validator)	VA=VA	tools=create_task@tools.ts:4812
tasks:deleteTask	args=callerOrchestrator	VA=VA	tools=delete_task@tools.ts:5927
tasks:failTask	args=callerOrchestrator	VA=VA	tools=fail_task@tools.ts:5583
tasks:list	args=(shared validator)	VA=--	tools=list_tasks@tools.ts:4926
tasks:listBlockedOnMe	args=recipient	VA=VA	tools=list_blocked_on_me@tools.ts:3951
tasks:listByMission	args=createdBy	VA=--	tools=list_tasks_by_mission@tools.ts:6182
tasks:listOverdue	args=assignedTo	VA=VA	tools=NONE
tasks:listPaginated	args=assignedTo	VA=VA	tools=NONE
tasks:pause	args=callerOrchestrator	VA=VA	tools=pause_task@tools.ts:5681
tasks:resume	args=callerOrchestrator	VA=VA	tools=resume_task@tools.ts:5728
tasks:searchTasksByKeyword	args=assignedTo	VA=--	tools=search_tasks_by_keyword@tools.ts:5234
tasks:start	args=callerOrchestrator	VA=VA	tools=start_task@tools.ts:5632
tasks:taskDurationDistribution	args=from	VA=VA	tools=NONE
tasks:update	args=callerOrchestrator,assignedTo	VA=VA	tools=update_task@tools.ts:5455; block_task@tools.ts:6016; add_task_dependency@tools.ts:6088
doors reached by tools.ts: 58 of 70 (superseded: 60 of 70 are in MCP_CALLED_FUNCTIONS)
```

Counts from the same output: 70 doors; 58 matched to a tool name by the `tools.ts` scan; **correction (Eta review): 60 of the 70 are called by the MCP, because `messages:checkNewMessages` and `messages:getUnreadCount` are in `MCP_CALLED_FUNCTIONS` (mcp-server/src/backendContract.ts:108, :112) though the scan marked them NONE**. Check: the 70 door names of the table above, intersected with the quoted `module:function` strings of `backendContract.ts` (`grep -o '"[a-zA-Z]*:[a-zA-Z]*"' mcp-server/src/backendContract.ts`, `LC_ALL=C comm -12`) -> 60; the 10 not called are `deleteBriefingNote`, `deleteDiary`, `diary:listByDateRange`, `memoriesScoped:storeMemoryScoped`, `listByChannelPaginated`, `getProfileWithMemories`, `attachReviewArtifact`, `listOverdue`, `listPaginated`, `taskDurationDistribution` (checked at origin/main 1902c1d9); 42 declare `verifiedActor`; 28 do not.

The 28 with no ID path at all (the main expand work):
`briefingNotes:searchBriefingNotesByKeyword, businessUnits:create/list/update, diary:deleteDiary/get/list/listByDateRange/write, episodes:storeEpisode, errorMonitor:addDeployment, fixPatterns:create, githubRepoMapping:add, mandates:create/list, memories:listMemories/storeMemory, memoriesScoped:storeMemoryScoped, messages:listByChannelPaginated/listMessages/searchMessagesByKeyword, missionTemplates:instantiateTemplateIntoMission/upsert, missions:list, recurringTasks:list, tasks:list/listByMission/searchTasksByKeyword`.

The 7 that declare `verifiedActor` but are not in `VERIFIED_ACTOR_DOORS` (the MCP does not forward it):
`briefingNotes:deleteBriefingNote, profiles:getProfileWithMemories, profiles:listProfiles, tasks:attachReviewArtifact, tasks:listOverdue, tasks:listPaginated, tasks:taskDurationDistribution`. `profiles:listProfiles` is excluded on purpose (comment at mcp-server/src/verifiedActor.ts:76-79: `list_peers` attributes rows by instance label and an ID filter would withhold legacy rows until the profile backfill ran). The other six are not reached by any MCP tool, so forwarding there is a no-op until a tool calls them.

### 1.4 Helpers the labels reach, and the CR-2 / R-53 sites they account for

Each row: label source, helper, what the label decides, doctor module holding the sites (CR-2 / R-53 from 1.1).

| helper (file:line) | reached from (labels) | what the label decides today | doctor module |
|---|---|---|---|
| `requireAgentCredentialMatch` -> `findAgentByName` (convex/lib/auth.ts:1155) | public `from` / `createdBy` / `callerOrchestrator` with no proof | whether the declared name resolves to a registered agent in `targetOrgSlug`, hence `AGENT_CREDENTIAL_REQUIRED`: a label decides whether a credential is demanded | auth 13 / 11 |
| seat sender screening (convex/messages.ts:967, :993) | `sendMessage.from` for a seat token | the seat may not send under a label registered as an agent in the org | messages 29 / 39 |
| `claims.recipient` -> `findAgentByName` (convex/lib/inboxReader.ts:224) | `checkNewMessages(Envelope).recipient`, `getUnreadCount.orchestratorId` for a verified org with no agent | picks the inbox of the named agent row, or an `org-name` reader confined to the tenant | inboxReader 7 / 7 |
| `actorIdResolver` -> `findAgentByName` (convex/lib/actorIds.ts:57) | task `createdBy` / `assignedTo`, recurring schedules, missions, briefing notes | the label becomes the row ID stamped on the new row (`createdById`, `assignedToId`) | actorIds 0 / 2 |
| `callerActorOf`, `requireAssigneeId`, `assigneeIdForRead` (convex/lib/taskActors.ts:37, :79, :106) | every `callerOrchestrator` door; assignee filters of `tasks:*` | acting identity when no credential or `verifiedActor`; assignment target; read filter. All three end in `actorIdResolver` | taskActors 1 / 3 |
| `resolveSeatAgent` -> `findAgentByName` (convex/lib/seatAgent.ts:117) | OAuth profile `fromAllowList[0]` of a legacy profile with no `agentId` | which agent a seat token acts as | seatAgent 1 / 4 |
| `fleetPartyId` -> `findAgentByName` (convex/lib/fleetActors.ts:68) | mandate party label stored on a legacy row | who may act as the party (the label comes from the stored ROW, never from the caller) | fleetActors 1 / 1 |
| `resolvePersonPrincipal` (package; call site convex/lib/personPrincipal.ts:112) | person tokens: `orgSlug` of the token row | org selected by slug; personPrincipal.ts:124-135 already cross-checks `row.clerkOrgId` where present | personPrincipal 1 / 1 |

Label-keyed but not `findAgentByName` callers: the filter-only reads (`diary:*`, `profiles:*`, `businessUnits:list`, `mandates:list`, `memories:listMemories`, `*:search*ByKeyword`, `tasks:list*`) compare a stored label string with the argument and never resolve a row. They are the bulk of the remaining sites in `diary` (9 / 6), `briefingNotes` (8 / 13), `profiles` (4 / 9), `businessUnits` (3 / 7) and `mcp-server/src/tools` (10 / 22).

Already decided by ID (do not redo): the write-gate for person tokens is `personalAgent.onRoster` (PR #1616, cited as given). `requireVerifiedActorMatch` (called first in `requireAgentCredentialMatch`, convex/lib/auth.ts:1138) loads the agent row BY ID, requires it active and in the stated org, and checks that any asserted name resolves to the same row (refusal code `AGENT_IDENTITY_MISMATCH`). PR #1619 (open, cited as given, diff not read) keys `findAgentByName` on the permanent org ID; it changes the lookup key, not the number of call sites, and the by-name caller pin test must be rebased over it.

## 2. Design of the expand phase

### 2.1 Argument shape

For each door and each label argument `<arg>` add `<arg>AgentId: v.optional(v.string())`, reusing the names already shipped: `fromAgentId` (convex/messages.ts:1089), `assignedToAgentId` (convex/tasks.ts:693, :2211), `callerActorId` for the `callerOrchestrator` family (convex/tasks.ts:5437 and others), `fulfilledByAgentId` (convex/mandates.ts:105). New names only where none exists: `recipientAgentId`, `createdByAgentId`, `pilotAgentId`, `requestedByAgentId`, `orchestratorAgentId`; `participants` gets `participantAgentIds`. A second name for an argument that already has one is not allowed.

Resolution, one shared helper `resolveAgentRef(ctx, scope, { label, agentId, door })` in `convex/lib/agentIdentity.ts`, built on the existing by-ID reads (no new refusal mechanism):

1. ID present: read the row by ID (`ctx.db.normalizeId("agents", id)` then `by_id`), require it active and in the caller's org. The org comes from the verified principal, never from an argument (`authority-attached-to-anonymous-object.md` rule 1). The ID wins.
2. ID and label both present: the label must equal the row's CURRENT label under `normalizeOrchestratorId`. Otherwise refuse `AGENT_IDENTITY_MISMATCH` with payload `{ reason: "id-label-mismatch", door, agentId }`. This reuses the existing code; a second code would be the second refusal mechanism the refusal rule bans.
3. ID absent: the label path is unchanged, byte for byte.
4. ID names no agent in the caller's org, or an agent of another org: `AGENT_NOT_FOUND` (existing code, convex/agentCredentials.ts:115) for writes and for reads that return a figure or a list. A READ never answers an unresolvable ID with an empty success (`refusal-is-distinguishable-from-absence.md`). A genuinely empty result for a resolvable in-org ID stays an empty success.
5. Subscribed list reads (`mandates:list`, `profiles:listProfiles`, `businessUnits:list`) keep the `{ refused: true, items: [] }` envelope for the pre-organisation caller and gain no throw.
6. A person (`user:<subject>`) is its own ID (`isHumanActorName`); `<arg>AgentId` is not used for a person.

Measurement for the contract decision: step E1 adds one structured log line `LABEL_ONLY_DOOR { door, arg }` when a door takes the label path with no ID. No such counter exists today.

### 2.2 Where the ID comes from (MCP)

`verifiedActorOf(ctx)` (mcp-server/src/verifiedActor.ts:103) returns `{ agentId, orgSlug }` from `ctx.actor.agentId` (credential) or the one-agent seat stamp (`seatAgentOf`), and excludes Clerk-JWT sessions. Step E8 makes `withVerifiedActor` (verifiedActor.ts:133), or a sibling, fill `<arg>AgentId` from that same source and ONLY that source, never a tool argument (file header, verifiedActor.ts:8-9). `whoamiIdentity.ts:113 resolveActingAgent` and `:162 resolveWhoamiIdentity` stay the source for the whoami tool. Clerk-JWT person sessions take IDs from the personal-agent roster (PR #1616 path), not from this wrapper.

### 2.3 clerkOrgId backfill

As given by the task brief, prod counts measured 2026-11-01 and not re-measured here: 0 of 82 active agents lack `clerkOrgId`; 2 of 16 active `client_org_mapping` rows lack it, both test orgs. The machinery exists: `convex/migrations/backfill_org_clerk_id.ts` (expand phase, never guesses, lists unresolved rows by ID with a reason code), `backfillOrgIds.ts`, `restamp_clerk_ids.ts`, and the mapping filler `clientOrgMapping:setClerkOrgId` (scripts/fill-mapping-clerk-org-id.mjs). The work is: (a) fill the 2 test-org mapping rows or mark them inactive (operator choice); (b) run `backfill_org_clerk_id:inventory` then `:run` and read the per-table unfilled list; (c) gate the first door that keys on `clerkOrgId` (E2) on `inventory` reporting zero unfilled in `agents` and `client_org_mapping`. No new backfill is invented.

Legacy label-only rows the ID path cannot match until stamped: profiles with no `agentId` (`backfill_profile_agent_ids.ts`), tasks, recurring tasks, missions and briefing notes with no `*Id` stamp (`backfill_actor_ids.ts`, `backfill_mission_actor_ids.ts`, `backfillRosterAgentIds.ts`; tests `backfillActorIds.test.ts`, `backfillTaskActorIds.test.ts`, `backfillMissionActorIds.test.ts`, `backfillRecurringTaskActorIds.test.ts`), and mandates with only a party label (resolved lazily by `fleetPartyId`, convex/lib/fleetActors.ts:56). They run in E6; their prod coverage is a precondition of the contract phase, not of expand (the label path keeps serving them).

## 3. PR-sized steps (expand, nothing removed)

Every step carries the tests of section 5.2, a docs update and a `changelog.d/` fragment (RULE #25), and removes no argument, return shape or refusal.

| step | content | depends on | touches | ships |
|---|---|---|---|---|
| E0 | this plan gated by Eta | none | analysis/ only | n/a |
| E1 | `resolveAgentRef` helper, `LABEL_ONLY_DOOR` log, both-pole unit tests; no door changed | E0 | convex/lib/agentIdentity.ts, convex/__tests__ | Convex |
| E2 | messaging: `recipientAgentId` on `checkNewMessages(Envelope)`; `fromAgentId` filter on `listMessages`, `searchMessagesByKeyword`, `listByChannelPaginated`; `callerActorId` on `markAsRead`, `deleteMessage`; `orchestratorAgentId` on `getUnreadCount`; seat screening (messages.ts:967, :993) and auth.ts:1155 read by ID when given | E1 (and PR #1619 landed or rebased) | convex/messages.ts, lib/inboxReader.ts, lib/auth.ts | Convex |
| E3 | tasks: `callerActorId` on the `callerOrchestrator` doors; `createdByAgentId` on create and on filters (`list`, `listByMission`, `searchTasksByKeyword`, `listOverdue`, `listPaginated`); `assignedToAgentId` on filters; the three `taskActors.ts` helpers take the ID first | E1 | convex/tasks.ts, lib/taskActors.ts, lib/actorIds.ts | Convex |
| E4 | briefingNotes, diary, missions, mandates, recurringTasks, missionTemplates (`createdByAgentId`, `pilotAgentId`, `requestedByAgentId`, `participantAgentIds`, `callerActorId`) | E1 | the six modules, lib/fleetActors.ts | Convex |
| E5 | profiles, businessUnits, memories, memoriesScoped, episodes, fixPatterns, errorMonitor, githubRepoMapping; seatAgent.ts:117 resolves by profile `agentId` first | E1 | the listed modules, lib/seatAgent.ts | Convex |
| E6 | backfills: clerkOrgId (2 test-org mappings), actor-id and profile-agent-id stamps; prod `inventory` read-backs recorded | E2-E5 deployed | migrations, run by the operator | Convex (data) |
| E7 | `BACKEND_CONTRACT_VERSION` 9 -> 10 (convex/lib/backendManifest.ts:10), manifest regenerated with `node scripts/gen-backend-manifest.mjs`. New arguments to existing functions are invisible to the boot check, which is why the bump is needed (railway-mcp-redeploy.md rule 1) | E2-E5 | backendManifest.ts, generated manifest | Convex |
| E8 | MCP fills IDs: `REQUIRED_CONTRACT_VERSION` 9 -> 10 (mcp-server/src/backendContract.ts:43); `VERIFIED_ACTOR_DOORS` gains the forwarded-but-unlisted doors a tool reaches; `<arg>AgentId` filled from `verifiedActorOf`; tool schemas keep the label argument (optional for callers with an ID, as in changelog.d/sigma-actor-from-agent-id.md); `MCP_CALLED_FUNCTIONS` updated; drift tests pass | E7 deployed and read back | mcp-server/src | Railway, LAST |

Rollout, one token (railway-mcp-redeploy.md): merge E1-E5 and E7; Convex prod rollout from repo root with the named key and `# pi-authorized: k<id>`; read back `meta:backendContract` (`contractVersion` 10) and have a second orchestrator confirm; E6 data steps; merge E8; explicit Railway redeploy (`serviceInstanceRedeploy`) by the token holder; read back the new deployment's commit, `/health`, the boot line `backend compatible: N called functions present`, and one live tool call per module. Nothing is removed in any step, so rule 4 holds. An old MCP against the new backend works (arguments optional); a new MCP against an old backend refuses at boot (version too old), fail closed. E7 and E8 touch the shared contract constants and must travel alone while another open PR touches them (`parallel-pr-config-separation` hook).

PR size: E2 and E3 are the large ones (messages.ts and tasks.ts are the two biggest modules by sites). If either exceeds the 15-minute review budget, split reads from writes.

## 4. Contract phase (operator decision, NOT built here)

Preconditions, all to be measured at decision time, none measured now: (1) the `LABEL_ONLY_DOOR` log shows zero label-only calls per door over an operator-chosen window; (2) every E6 backfill reports zero unfilled; (3) every MCP client class in use has a version that sends IDs, or has no ID-less path left.

What contract does, per door: the label argument is removed from the validator (or kept display-only and ignored); the ID argument becomes required where a caller always has one; `findAgentByName` is deleted with its last caller (convex/lib/agentIdentity.ts:238-264), `agentRegistryNoNameSelection.test.ts` shrinking row by row. Order: reads first (cannot corrupt data), writes next, the credential-required branch of auth.ts:1155 last (it is the door that tells a known label from an unknown one).

Expected CR-2 / R-53 effect, UPPER BOUNDS taken from the module table in 1.1 (not measured per site). Modules whose label handling is most of their content: actorIds (0 / 2), seatAgent (1 / 4), fleetActors (1 / 1), inboxReader (7 / 7), taskActors (1 / 3). Modules only partly label-driven, so the figure is a ceiling: messages 29 / 39, tasks 15 / 31, auth 13 / 11, briefingNotes 8 / 13, diary 9 / 6, recurringTasks 8 / 8, missions 6 / 6, mcp-server/src/tools 10 / 22. Sum of those 13 modules: CR-2 = 29+15+13+8+9+8+6+10+0+1+1+7+1 = 108 of 246; R-53 = 39+31+11+13+6+8+6+22+2+4+1+7+3 = 153 of 323. The real drop will be a fraction; the first measured figure comes from re-running the doctor after E5.

Client impact (what breaks when labels are removed):

- Callers with a resolved agent ID (agent credential, one-agent seat token, personal agent): nothing. Since changelog.d/sigma-actor-from-agent-id.md the label is already optional for them in the advertised schema.
- Callers with no resolved agent ID: they break. That is the service account (fleet master), stdio masters, org-level seat tokens with no agent (`seatAgent: null`), Clerk-JWT sessions with no personal agent, and any raw Convex client or script naming `from` / `callerOrchestrator`. Today a formerly required acting name stays required for them (`ACTING_NAME_REQUIRED`); after contract it has no replacement. A path (an ID the caller can obtain, for instance from `whoami`) must be decided before contract, or those callers stay on a labelled door. This is the operator decision.
- Claude.ai, ChatGPT, Grok and other MCP connectors: they call MCP tools whose schemas the MCP serves, so the tool schema is the contract; they pass labels only where the schema asks. A tool whose label argument disappears or becomes ID-required breaks sessions opened before the redeploy until reconnect (that connectors cache the tool list per session is expected, not measured). Mitigation: change the tool schemas in a separate MCP rollout after the Convex contract is live, and accept-and-ignore the old argument for one more release.
- Old MCP builds (any Railway build before E8): work against an expanded backend, break against a contracted one. The boot check stops a NEW MCP from starting against an OLD backend; it does not protect an OLD MCP from a CONTRACTED backend. So `REQUIRED_CONTRACT_VERSION` must not be raised for the contract bump until no old build is in service. Self-host copies are a separate product and out of scope.
- How long expand runs first: this plan does not give a number; a calendar guess would be a prediction. It runs until the three preconditions hold, and the `LABEL_ONLY_DOOR` log is what makes that a measurement.

## 5. Risks, test plan, frontend audit

### 5.1 Risks

| risk | mitigation |
|---|---|
| An ID in the argument widens authority (the anonymous-object defect) | The ID is believed only after a by-ID read proves the row active and in the caller's org, with the org taken from the verified principal. The ID selects a row the caller's org already contains; it grants nothing. |
| Same label in two orgs resolves to the wrong agent | The ID path is org-proved; the label path keeps its per-org lookup. Pole 2 below. PR #1619 must land or be rebased before E2. |
| ID/label mismatch silently preferring one | Refused `AGENT_IDENTITY_MISMATCH`, reason `id-label-mismatch`. |
| A read answers an unresolvable ID with `[]` | Section 2.1 rule 4; pole 4 pins ABSENT as a success only for a resolvable in-org ID. |
| A subscribed list read throws at a mounted render | List doors keep the envelope for pre-org callers; nothing new throws at a subscribed render. |
| Renamed agent: a stored label no longer matches | The ID path is immune; the label path is unchanged (as today). Contract is what fixes it. |
| Skew: new MCP sends an argument an old Convex rejects | E7/E8 order plus the boot check; the version bump covers the argument case the boot check cannot see. |
| Retired agent ID | Refused as inactive; reading a retired agent's own history is an open decision (section 6). |
| Doctor counts rise during expand (new arguments, new reads) | Expected. The gate is: no new `findAgentByName` caller (pin test) and no door gains a populated default. |

### 5.2 Test plan

Per door, for all 70, table-driven one file per module in `convex/__tests__/`, using the harness of `refusalCarriesItsCode.test.ts` and `publicRegistrationResolvesCaller.test.ts`:

1. Right agent by ID admitted: caller in org A, `<arg>AgentId` = an active agent of org A, label omitted or equal -> served; the row written or read carries that agent's ID.
2. Same label, other org or other agent, refused: org B has an agent with the identical label; caller in org A passes org B's agent ID -> `AGENT_NOT_FOUND` (never an empty success); caller in org A passes only the label and org A has no such agent -> unchanged legacy behaviour (pinned, so expand is provably not a behaviour change).
3. ID/label mismatch refused: a valid in-org ID and a label naming a different in-org agent -> `AGENT_IDENTITY_MISMATCH`, `reason: "id-label-mismatch"`.
4. ABSENT pole for reads: a resolvable in-org ID with no rows -> empty SUCCESS (no throw, no `refused`).
5. MCP side (`mcp-server/test/`, beside `agent-id-on-seat.test.ts`): a sweep deriving the doors that declare `<arg>AgentId` from `convex/*.ts` and failing when a tool call site for such a door does not forward from `verifiedActorOf`; both poles: a credential-bearing context forwards, a master/stdio context forwards nothing and is byte-for-byte unchanged.
6. Pins: `agentRegistryNoNameSelection.test.ts` green at every step (no new caller); the boot-check test pins the version pair; the manifest drift test runs after E7.
7. Doctor gate per step: `npx -y @vantageos/backend-doctor@0.5.0 . --json-evidence <dir>`; CR-2 / R-53 before and after go in the PR body.

Repo gates before each Convex PR: the RULE #19 sandbox build pass (dry-run of the Convex build, as the project CLAUDE.md prescribes), biome and tsc on touched files.

### 5.3 FRONTEND-AUDIT approach

The dashboard (`elpiarthera/vantage-peers-dashboard`) is not on this station (`ls -d /root/coding/*dashboard*` -> no such file or directory), so no consumer was enumerated for this plan. Before each of E2-E5 merges, the author runs in a clone of that repo at its `main`:

```
grep -rnE "api\.(messages|tasks|briefingNotes|diary|missions|mandates|recurringTasks|profiles|businessUnits|memories|episodes|fixPatterns|missionTemplates)\." --include=*.ts --include=*.tsx app components hooks lib contexts providers
```

and lists for each changed door: subscribed `useQuery` (must not start throwing; keep the envelope), `useMutation`, or server action; the label arguments passed today; whether it reads returned label fields. The result goes in the PR body as a table (door, file:line, subscribed or not, argument passed). Subscribed readers named in the refusal rule: `mandates:list` (mandate-board.tsx:39), `profiles:listProfiles` (orchestrators-grid.tsx:53), `messages:checkNewMessages` (message-timeline.tsx:69, reads the raw array, so it stays a bare array), `messages:getUnreadCount` (`readUnreadCount`). Expand needs no dashboard change (all new arguments optional, no return shape changes); the audit proves that door by door and produces the work list for contract.

## 6. Decisions

Pi rulings (receipt k97ec3g7d75am5j9r1sbq94w1h8hdfry), applied 2026-11-01:

3. The two test-org mappings without `clerkOrgId` (`plan-org-t8-1787337143`, `plan-org-t8-1787337143-out`): fill `clerkOrgId` if the org ID is readable, otherwise deactivate them. Never delete.
4. A retired agent's ID stays refused for reads too (this plan's default kept).
5. `AGENT_IDENTITY_MISMATCH` is reused for the ID/label mismatch: one code, one helper.

Parked (Pi brings them to the operator as ONE decision once `LABEL_ONLY_DOOR` has a window of data):

1. Contract phase: go or no-go and the window, decided on the `LABEL_ONLY_DOOR` measurement, not on a date.
2. What ID-less callers (service account, stdio master, org-level seat with no agent) use after contract.

not_measured:
- Prod state: "0 of 82 active agents without clerkOrgId" and "2 of 16 active mappings without it, both test orgs" are cited as given by the brief; no prod query was run.
- Per-site mapping of the 246 CR-2 and 323 R-53 sites to doors: only module-level counts were read; the "expected drop" figures are ceilings from module counts (a prediction). The doctor report that names every site was not parsed.
- The 70-door / 81-declaration inventory is a textual scan over `convex/*.ts`. It can miss label arguments built by spreads other than the four named validators and can over-count a key inside a nested object; `convex/schema.ts` and `internal*` functions were excluded by construction. The tool-to-door map takes the nearest preceding tool-name line in tools.ts; at least `tasks:bulkComplete` (shown under `list_tasks`) and `profiles:listProfiles` (one hit with no tool name) are imprecise.
- The `VA` column (door declares `verifiedActor`) was decided by the string appearing in the door's source text; a comment would satisfy it. Not read door by door.
- Whether any current MCP client (Claude.ai, ChatGPT, Grok, Claude Code, Codex) sends labels only: no logs were read, and the `LABEL_ONLY_DOOR` counter does not exist yet. That connectors cache tool lists per session is expectation, not measurement.
- PR #1619 and PR #1616: taken from the brief; neither diff was read. Whether #1619 changes the helper signatures E1 builds on is unknown.
- The dashboard repo: not on this station; no consumer of any changed door was enumerated.
- No test, build, tsc, biome or Convex build was run: the deliverable is a document and changes no source.
- Time to run expand before contract: not estimated; section 4 defines it by measured preconditions.
