# VantagePeers production-readiness security audit — main @16f0907

Task k17akj9yt334tmmvnk4yr374dh8fywkx. Argus — VantageOS Review, 2026-10-09.

## Counts

- Doors: 308 (192 public Convex functions from `grep -rnE "^export const [A-Za-z0-9_]+ = (query|mutation|action)\(" convex`, 5 HTTP route/method rows from `convex/http.ts`, 111 MCP tools from `registerTools` with a stub server).
- Static defects: 110. Reproductions run at 16f0907: RED 108, GREEN (refuted) 1, COULD-NOT-JUDGE 1.
- Independent re-run by Argus: `npx vitest run convex/__tests__/audit` -> 93 failed / 38 passed; `cd mcp-server && npx vitest run test/audit` -> 44 failed / 10 passed. 132 failures are assertion failures, 5 are the door refusing the rightful caller or hitting the read limit (the defect itself); 0 harness errors.
- Doors whose two poles are tested under a scoped identity: see the `poles_tested` column; most doors have none.

## Cross-cutting causes (fix these first; most module defects are instances)

1. **The service account is master in Convex.** Every MCP caller (seat, credential, person token, master bearer) reaches Convex as the fleet service account; only some doors forward `verifiedActor`/`verifiedOrg`. Doors that do not forward a claim are master: cross-tenant reads, writes and deletes by id.
2. **Identity by name or by argument.** `createdBy`, `callerOrchestrator`, `orchestratorId`, `from`, the word `system`, and rosters (`allowedOrchestrators`) that store names decide who acts and who owns.
3. **Identity logic lives in the repo, not in `@vantageos/cloud-identity`.** `withOrgScope`, `inboxReader`, roster checks and tenant gates are local (`convex/lib/*`, `mcp-server/src/*`); the package is imported for helpers only (and pinned `^0.11.0` while 0.12.0 is latest).
4. **Filter after read.** Several list/stats doors read fleet-wide then filter, which starves pages and leaks or truncates counts.
5. **Secrets and tokens.** OAuth codes stored in plaintext, refresh tokens never rotated, the master secret hashed unsalted into an audit log, Clerk-minted bearers unrevocable.

## Defects by module (RED = reproduced by a failing test at 16f0907)

### messages — 17

- **messages:sendMessage** `messages.ts:394-401 (tenant stamp from arg); messages.ts:631-636 (fleetWide skips roster); messages.ts:289-317 (by-ID target org); messages.ts:1049 (member 'from' by roster name)` — (1) A claimless service-account call (every MCP seat reaches Convex this way) with args.tenantId=<client slug> is stamped into that client's tenant and, being fleetWide, reaches every known profile role without roster check, so a test run can write into a real client inbox; the tenant is an unverified argument. (2) A fleet sender (service account, or verifiedActor of an operator-org agent such as pi) addressing a client agent by ID is refused recipient-agent-not-addressable: resolveRecipientAgents requires row.orgSlug === targetOrg where targetOrg is the operator org (no tenantId) or the sender's own org (verifiedActor), and the only cross-org admission is client->operator (isRosterOperatorAgent), never operator->client. (3) A member of a client org can send as any roster orchestrator that has no agents row with no credential (requireOrchestratorOnRoster, string membership) and no writer-role check on the agent path.  
  Fix: Derive the tenant of a fleet send from the verified recipient rows (all recipientAgentIds must share one org, stamp that org) and make the operator->client direction an explicit, tested admission; refuse a claimless service-account write into a client tenant unless a verifiedActor/seat claim names that org; require memberWriterRoles on the member agent path.  
  Proof: **RED** `convex/__tests__/audit/messages.twoPoles.test.ts` — Error: promise resolved "'10025;messages'" instead of rejecting
- **messages:checkNewMessages** `inboxReader.ts:275-291 (fleet reader tenants); inboxReader.ts:327-336 + :477 (ID proof only for agentId readers); inboxReader.ts:301-306 (member reader, no roster check)` — Client-tenant mail to a fleet agent that has no verifiedActor claim (pi, eta) is never returned: the claimless service account becomes the 'fleet' reader whose tenants exclude every client org, ownsReceipt grants the by-ID shortcut only when reader.agentId is set, and the recipientId probe runs only for agent readers, so a receipt stamped in the client tenant with pi's operator-org agent ID stays unread. Separately the 'member' reader accepts any recipient name without checking it is on the member's roster, so any member reads any agent's mailbox in its tenant (getUnreadCount does check the roster).  
  Fix: Let a claimless fleet reader also read receipts whose recipientId resolves to an active operator-org agent of that name (ID, not name), or require fleet stations to present verifiedActor; apply isOrchestratorOnOrgRoster in the member branch of resolveInboxReader.  
  Proof: **RED** `convex/__tests__/audit/messages.twoPoles.test.ts` — AssertionError: expected [] to deeply equal [ 'C1-TO-PI probe' ]
- **messages:checkNewMessagesEnvelope** `inboxReader.ts:275-291; inboxReader.ts:327-336; messages.ts:1395-1403 (task blocks keyed on reader.label name)` — Same as checkNewMessages: claimless fleet reader never sees client-tenant receipts addressed to pi (including its ID-stamped ones); member reader not roster-checked; stale/stuck/peers task blocks are keyed on the reader's name string (taskVisibleTo falls back to true when the task has no ID).  
  Fix: Same fix as checkNewMessages; compute task blocks by reader.agentId when set and refuse name-only task matching for member readers.  
  Proof: **RED** `convex/__tests__/audit/messages.twoPoles.test.ts` — AssertionError: expected [] to deeply equal [ 'C1-TO-PI probe' ]
- **messages:markAsRead** `messages.ts:1625-1632 (fleet tenants only); messages.ts:1648-1677 (member path, roster name + callerOrchestrator arg)` — (1) A fleet station without a claim (pi) cannot mark a client-tenant receipt addressed to it: the claimless-master path refuses the whole call tenant-receipt-needs-verified-reader, and the named-owner path builds a fleet reader whose ownsReceipt is false for client-tenant receipts, so those messages can never be acknowledged. (2) On the member path any member regardless of role (no memberWriterRoles gate) can mark read any receipt of any roster orchestrator in its tenant by passing that orchestrator's name as callerOrchestrator, an unverified argument.  
  Fix: Let the fleet reader own receipts whose recipientId is its operator-org agent ID; require assertMemberMayWrite and the verified person/actor identity on the member path instead of the callerOrchestrator name.  
  Proof: **RED** `convex/__tests__/audit/messages.twoPoles.test.ts` — ConvexError: RBAC_DENIED: receipt 10016;messageReceipts is not the verified reader's — {"reason":"receipt-not-yours","door":"messages:markAsRead","kind":"fleet"}
- **messages:deleteMessage** `messages.ts:1757-1763 + systemCaller.ts:28-32 ('system' word for the service account); messages.ts:1798-1827 (member agent path)` — Every MCP seat, including seats of client orgs, reaches Convex as the service account, so typing callerOrchestrator='system' deletes any tenant's message and receipts with no claim; a naming service account deletes any fleet-tenant message by typing the sender's name; a member of any role (no writer-role gate) deletes messages sent by any roster orchestrator by typing its name.  
  Fix: Require a verifiedActor/verifiedOrg claim for service-account deletes and bind the delete to the claim's org; drop the 'system' bypass for tenants other than the fleet's; add assertMemberMayWrite and an ID-based sender check on the member agent path.  
  Proof: **RED** `convex/__tests__/audit/messages.twoPoles.test.ts` — Error: promise resolved "{ deleted: true, receiptsDeleted: 1 }" instead of rejecting
- **messages:listMessages** `messages.ts:1925-1944 (master reads every tenant); messages.ts:1914-1921 (member: tenant only, no channel narrowing, .filter on from)` — The service account path returns every client tenant's messages with no claim, and an MCP seat of a client org holds that identity; separately a member reads every message of its tenant, including messages addressed to a colleague's user:<subject> inbox that checkNewMessages protects (assertPersonInboxOwner) and channels outside its roster that listByChannel hides.  
  Fix: Accept verifiedOrg/verifiedActor on this door and confine the service account to that org (fleet tenant when none); apply isChannelOnScope and exclude other persons' recipients for members.  
  Proof: **RED** `convex/__tests__/audit/messages.twoPoles.test.ts` — AssertionError: expected true to be false // Object.is equality
- **messages:getUnreadCount** `messages.ts:1999-2017 (reader via inboxReader); messages.ts:2037 (member: roster name)` — A claimless fleet reader (pi) is counted over the fleet tenants only, so unread mail in client tenants addressed to pi reports 0 (a fabricated zero for a rightful caller); for members authorisation is string membership of the orchestratorId in the roster.  
  Fix: Same reader fix as checkNewMessages (count receipts owned by ID); identify the member's counted agent by agents row ID.  
  Proof: **RED** `convex/__tests__/audit/messages.twoPoles.test.ts` — AssertionError: expected +0 to be 1 // Object.is equality
- **messages:listBroadcastStatus** `messages.ts:2136-2159` — The service account (every MCP seat, including client-org seats) reads the recipients and read times of any tenant's message by ID with no claim; the member gate compares the channel string with roster names and startsWith('team/'+orgSlug) without a segment boundary (team/org-ab passes for org-a), so authorisation rests on name strings.  
  Fix: Take a verifiedOrg claim and bound the service account to it; reuse the segment-boundary test of isNamespaceAllowedForScope in isChannelOnScope.  
  Proof: **RED** `convex/__tests__/audit/messages.twoPoles.test.ts` — Error: promise resolved "{ channel: 'vega', …(5) }" instead of rejecting
- **messages:listByChannel** `messages.ts:2290-2299 (master all tenants); messages.ts:2320 (roster filter after the read)` — The service account path reads every tenant's channel with no claim; for members the roster filter runs after take(limit), so a member with a narrow roster gets a short or empty page while admitted rows exist further back (withheld grant); channel admission is roster-name string membership.  
  Fix: Push the channel set into the index range (one by_tenant_channel probe per admitted channel) and accept a verifiedOrg claim for the service account.  
  Proof: **RED** `convex/__tests__/audit/messages.twoPoles.test.ts` — AssertionError: expected true to be false // Object.is equality
- **messages:listByChannelPaginated** `messages.ts:2392-2440 (master); messages.ts:2483-2490 (roster filter after paginate)` — Same two faults as listByChannel: service account reads all tenants with no claim; member pages are filtered after paginate() so pages can be empty while isDone is false and rows remain.  
  Fix: Bound the master to a verified org claim; fetch per admitted channel inside the index range instead of filtering the page.  
  Proof: **RED** `convex/__tests__/audit/messages.twoPoles.test.ts` — AssertionError: expected true to be false // Object.is equality
- **messages:getById** `messages.ts:2534 (master returns any row); messages.ts:2536-2557` — The service account returns any tenant's message row by ID with no claim (every MCP seat holds that identity); the member channel test is a string compare with the same missing segment boundary as listBroadcastStatus.  
  Fix: Require a verifiedOrg claim for the service account and compare the row tenant with it.  
  Proof: **RED** `convex/__tests__/audit/messages.twoPoles.test.ts` — Error: promise resolved "{ …(7) }" instead of rejecting
- **messages:searchMessagesByKeyword** `messages.ts:2604-2622 (master: tenantId optional narrowing; no tenant = all); messages.ts:2615-2616 (member: tenant only, no channel check)` — Service account searches every tenant's content with no claim (tenantId is only an optional narrowing the caller chooses); a member's search ignores the roster/channel rule listByChannel applies, exposing messages addressed to other agents or persons of its own tenant.  
  Fix: Derive the tenant for the service account from a verified claim; apply isChannelOnScope and the person-inbox rule to member results.  
  Proof: **RED** `convex/__tests__/audit/messages.twoPoles.test.ts` — AssertionError: expected [ { …(7) }, { …(7) }, { …(7) }, …(1) ] to deeply equal []
- **mcp:send_message** `mcp-server/src/tools.ts:3435-3440; mcp-server/src/state-tokens.ts (resolveTask, resolvePr)` — Any caller can embed {{task:<id>}} in content: resolveTask calls tasks:get through the caller's client (service account/master for a seat) and writes the task's status into the message it can read back, for a task of any organisation; {{pr:owner/repo#n}} makes the server call GitHub with its own GITHUB_TOKEN for any repo that token can see and returns state, head/merge SHA and mergeable state. No tenant or ownership check applies to either token.  
  Fix: Resolve {{task:}} through the tenant-gated read (tasks:getById + the org gate with the verified org) and send githubToken only for master callers; refuse pr tokens for repos whose owner is not bound to the caller's org (githubOwnerBinding).  
  Proof: **RED** `mcp-server/test/audit/messages.twoPoles.test.ts` — AssertionError: {
- **mcp:list_messages** `mcp-server/src/tools.ts:4172-4195; convex/messages.ts:1845-1930 (master branch returns all tenants)` — A non-master seat/person reads messages of other organisations whose sender name collides with one of its fromAllowList names, and a rightful reader gets a starved page: Convex returns the newest N rows of ALL tenants to the service account (master) and the MCP filters by sender name after the read; messages.tenantId is ignored. A recipient can also not fetch a message addressed to it (filter keys on sender only).  
  Fix: Forward the verified org (verifiedOrgOf / seatOrgSlug) to the Convex query so it filters by tenantId before the limit, and gate rows with rowVisibleToActorTenant keyed on the verified org, not on ctx.actor.  
  Proof: **RED** `mcp-server/test/audit/messages.twoPoles.test.ts` — AssertionError: expected [ 'ORGB-ETA probe', …(2) ] to not include 'ORGB-ETA probe'
- **mcp:search_messages_by_keyword** `mcp-server/src/tools.ts:4298-4329; convex/messages.ts:1845-1930 (master branch returns all tenants)` — A non-master seat/person reads messages of other organisations whose sender name collides with one of its fromAllowList names, and a rightful reader gets a starved page: Convex returns the newest N rows of ALL tenants to the service account (master) and the MCP filters by sender name after the read; messages.tenantId is ignored. A recipient can also not fetch a message addressed to it (filter keys on sender only).  
  Fix: Forward the verified org (verifiedOrgOf / seatOrgSlug) to the Convex query so it filters by tenantId before the limit, and gate rows with rowVisibleToActorTenant keyed on the verified org, not on ctx.actor.  
  Proof: **RED** `mcp-server/test/audit/messages.twoPoles.test.ts` — AssertionError: expected [ 'ORGA-ETA probe', …(2) ] to not include 'ORGB-ETA probe'
- **mcp:list_broadcast_status** `mcp-server/src/tools.ts:4404-4435; convex/messages.ts:1845-1930 (master branch returns all tenants)` — A non-master seat/person reads messages of other organisations whose sender name collides with one of its fromAllowList names, and a rightful reader gets a starved page: Convex returns the newest N rows of ALL tenants to the service account (master) and the MCP filters by sender name after the read; messages.tenantId is ignored. A recipient can also not fetch a message addressed to it (filter keys on sender only).  
  Fix: Forward the verified org (verifiedOrgOf / seatOrgSlug) to the Convex query so it filters by tenantId before the limit, and gate rows with rowVisibleToActorTenant keyed on the verified org, not on ctx.actor.  
  Proof: **RED** `mcp-server/test/audit/messages.twoPoles.test.ts` — AssertionError: {
- **mcp:get_message** `mcp-server/src/tools.ts:10822-10856; convex/messages.ts:1845-1930 (master branch returns all tenants)` — A non-master seat/person reads messages of other organisations whose sender name collides with one of its fromAllowList names, and a rightful reader gets a starved page: Convex returns the newest N rows of ALL tenants to the service account (master) and the MCP filters by sender name after the read; messages.tenantId is ignored. A recipient can also not fetch a message addressed to it (filter keys on sender only).  
  Fix: Forward the verified org (verifiedOrgOf / seatOrgSlug) to the Convex query so it filters by tenantId before the limit, and gate rows with rowVisibleToActorTenant keyed on the verified org, not on ctx.actor.  
  Proof: **RED** `mcp-server/test/audit/messages.twoPoles.test.ts` — AssertionError: {

### tasks — 15

- **tasks:create** `convex/tasks.ts:685-699` — [M] A member can create a task whose missionId or dependsOn names another organisation's mission/task, attaching its row to a foreign mission (it then blocks that mission's auto-complete, tasks.ts:2723-2761) and arming the cross-tenant title/status read in tasks:start.  
  Fix: For non-master callers load missionId and every dependsOn id and require sameTenantStamp with the caller's orgSlug (assertRowVisibleToCaller), refusing with RBAC_DENIED.  
  Proof: **RED** `convex/__tests__/audit/tasks.twoPoles.test.ts` — {ok:true, planted:1} expected {ok:false, planted:0}
- **tasks:update** `convex/tasks.ts:1769,1775,1880-1885` — [M] An authorised member can re-point its own task to another organisation's missionId or dependsOn ids (no tenant check on the new values), the same cross-org write and tasks:start read as tasks:create.  
  Fix: When fields.missionId or fields.dependsOn is present, load each target and require it to sit in the task's own tenant (sameTenantStamp) before patching.  
  Proof: **RED** `convex/__tests__/audit/tasks.twoPoles.test.ts` — update resolved, own task now points at org B mission/task
- **tasks:attachReviewArtifact** `convex/tasks.ts:2115-2133` — [L] First-writer-wins is decided by comparing the asserted callerOrchestrator to reviewArtifactAttachedBy, so anyone on the roster (any role, no writer-role gate) overwrites by typing that name, and a service-account call reaches any org's task with no verifiedOrg claim.  
  Fix: Add verifiedOrg and verifiedActor binding, compare the attacher by ID (reviewArtifactAttachedById) and apply the writer-role gate.  
  Proof: **RED** `convex/__tests__/audit/tasks.twoPoles.test.ts` — second member typing 'alpha' overwrote reviewArtifactRef (ok:true); different name correctly refused
- **tasks:blockTask** `convex/tasks.ts:2346-2364` — [M] blockedOnTaskId is not required to belong to the caller's tenant, so a member gets a status/assignee oracle on any task id and, when that foreign task completes, an unstamped system message containing its title is written to the member's assignee channel.  
  Fix: Require the blocker task to pass isRowVisibleToScope(callerScope) (same tenant) before accepting it, with a uniform refusal for absent and foreign ids; stamp tenantId on the unblock message.  
  Proof: **RED** `convex/__tests__/audit/tasks.twoPoles.test.ts` — org A task became blocked on org B task (status blocked, blockedOnTaskId set)
- **tasks:listUnlinkedBlocked** `convex/tasks.ts:2441-2453` — [L] The tenant predicate is applied after an unbounded fleet-wide collect, so every member query loads all tenants' blocked rows and can hit the read limit and be refused as the fleet grows (a rightful caller refused).  
  Fix: Use the by_orgId_status index (tenant leading equality) for non-master callers and bound the read with take/paginate.  
  Proof: **COULD-NOT-JUDGE** `` — convex-test does not enforce the production read limit; the unbounded .collect() at tasks.ts:2441-2453 cannot be driven to a read-limit refusal here
- **tasks:start** `convex/tasks.ts:2965-2976` — [M] The dependency gate reads dependsOn tasks without a tenant check and returns their title and status in the error, giving a cross-tenant read of any task whose id was planted via tasks:create/update.  
  Fix: Skip or generically refuse dependencies that are not in the caller's tenant (never echo title/status of a foreign row) and close the planting path at create/update.  
  Proof: **RED** `convex/__tests__/audit/tasks.twoPoles.test.ts` — error text contained ORG-B-SECRET-TITLE and status of org B's task
- **tasks:checkout** `convex/tasks.ts:3338-3376` — [M] Any roster member (and any master) can claim and start the clock on a task assigned to someone else, bypassing the creator/assignee rule, the dependsOn gate and the in-progress cap that tasks:start enforces.  
  Fix: Require task.assignedTo (or createdBy) to equal the verified caller as assertTaskCallerAuthorized does, and apply the dependency and concurrency gates.  
  Proof: **RED** `convex/__tests__/audit/tasks.twoPoles.test.ts` — {ok:true, status:in_progress} expected {ok:false, status:todo}
- **tasks:bulkComplete** `convex/tasks.ts:4318-4340,4355` — [M] For a master call the tasks to close are chosen by assignee NAME across all tenants and authorised by a name compare (findBulkCompleteDenied), with the org narrowing (onlyOrgId) applying only if the transport remembered to send verifiedOrg, so same-named orchestrators of different orgs are closed together.  
  Fix: Make verifiedOrg mandatory for any service-account bulkComplete that is not an explicit fleet-wide run, and refuse (UNVERIFIED) when absent.  
  Proof: **RED** `convex/__tests__/audit/tasks.twoPoles.test.ts` — one call closed eta tasks in org-a and org-b (doneOrgs [org-a, org-b]); verifiedOrg narrowing control passes
- **tasks:billingSummaryByProject** `convex/tasks.ts:4854-4878` — [M] The tenant predicate is applied after the fleet-wide scan, so a member's invoice totals are computed over whatever of its rows fall inside the first 5001 fleet rows of the period (silently short, truncated flag only), a withheld grant on money figures.  
  Fix: Add (orgId,status,completedAt[,project]) indexes and filter by orgId inside the index range for non-master callers.  
  Proof: **RED** `convex/__tests__/audit/tasks.twoPoles.test.ts` — received {minutes: undefined, truncated: true}, expected {30, false}
- **tasks:taskDurationDistribution** `convex/tasks.ts:5010-5027` — [L] Same post-read tenant filter as billingSummaryByProject: percentiles for a member are computed over a truncated fleet slice.  
  Fix: Same tenant-leading completedAt index for non-master callers.  
  Proof: **RED** `convex/__tests__/audit/tasks.twoPoles.test.ts` — received {count: 0, truncated: true}, expected {3, false}
- **mcp:create_task** `mcp-server/src/tools.ts:4540-4558; convex/tasks.ts:654-700; convex/__tests__/mcpNameCollisionExposure.test.ts header ('UNSTAMPED a row stating no org -> refused')` — A seat/credential caller's task is written with no tenant: create_task forwards no verifiedOrg and tasks:create stamps orgId from the transport scope, which is the service account (master) => orgIdForWrite returns undefined (a fleet row). The creator's own organisation cannot see it and every later single-task write door (which now forwards verifiedOrg) refuses an unstamped row, so a rightful caller cannot update/complete the task it just created.  
  Fix: Add a verifiedOrg claim to tasks:create (same helper as the ten write doors) and stamp the row with it; call unresolvedOrgDenial('create_task') first.  
  Proof: **RED** `mcp-server/test/audit/tasks.twoPoles.test.ts` — orgs [undefined] expected [org-a]
- **mcp:list_tasks** `mcp-server/src/tools.ts:4646-4672; mcp-server/src/auth.ts rowVisibleToActorTenant (returns true when !ctx.actor)` — A seat/person token without a per-agent credential sees tasks of other organisations whose assignee/creator name equals one of its fromAllowList names: tasks:list runs as the service account (all tenants, limit applied first); the tenant gate filterRowsToActorTenant is a no-op when ctx.actor is undefined, so the row's orgId is ignored and the name decides; a rightful caller also gets a starved page.  
  Fix: Key rowVisibleToActorTenant on the verified org (actor.orgSlug ?? clerkOrgSlug, refuse if unresolved) and forward verifiedOrg so tasks:list filters by orgId before the limit.  
  Proof: **RED** `mcp-server/test/audit/tasks.twoPoles.test.ts` — org-b row returned/affected for org-a seat
- **mcp:get_task** `mcp-server/src/tools.ts:10586-10605; mcp-server/src/auth.ts rowVisibleToActorTenant` — Same cause as list_tasks, by id: a seat without credential reads an org-b task whose creator/assignee name collides with its allowlist, because the tenant gate is keyed on ctx.actor and the row orgId is ignored otherwise.  
  Fix: Gate on the verified org for every non-master non-Clerk caller (verifiedOrgOf) before scopeFilterGet.  
  Proof: **RED** `mcp-server/test/audit/tasks.twoPoles.test.ts` — org-b row returned/affected for org-a seat
- **mcp:search_tasks_by_keyword** `mcp-server/src/tools.ts:4930-4956` — Same cause as list_tasks: BM25 search runs as master over all tenants with the limit applied first, then a name filter; org-b tasks with a colliding name are returned to an org-a seat without credential and the rightful caller's matches can fall outside the first N rows.  
  Fix: Forward verifiedOrg to tasks:searchTasksByKeyword and apply the verified-org gate for non-credentialed seats.  
  Proof: **RED** `mcp-server/test/audit/tasks.twoPoles.test.ts` — org-b row returned/affected for org-a seat
- **mcp:list_tasks_by_mission** `mcp-server/src/tools.ts:5914-5940` — Same cause as list_tasks: missionId (any org's mission) is accepted, tasks come back from the master-reach query, and without a credentialed actor only a name filter applies.  
  Fix: Forward verifiedOrg and gate rows on it for every non-master non-Clerk caller.  
  Proof: **RED** `mcp-server/test/audit/tasks.twoPoles.test.ts` — org-b row returned/affected for org-a seat

### businessUnits — 9

- **businessUnits:create** `businessUnits.ts:34-41 + :127 (roster string includes); businessUnits.ts:155-160 (master write unstamped)` — A member of any role (no memberWriterRoles gate, unlike task/mission writes) creates a BU for any orchestrator name on its roster, ownership decided by the typed orchestratorId; the service account (every MCP seat) creates fleet-owned BUs for any orchestratorId with no claim.  
  Fix: Add assertMemberMayWrite, normalise the roster compare, and take the owner from the verified acting agent.  
  Proof: **RED** `convex/__tests__/audit/businessUnits.twoPoles.test.ts` — a non-writer role must be refused: expected NO REFUSAL (the write succeeded) to contain RBAC_DENIED
- **businessUnits:update** `businessUnits.ts:231-272` — Authority is two name comparisons: roster string membership of bu.orchestratorId and equality with the typed callerOrchestrator; any member regardless of role who types the owner's name rewrites or reassigns the BU, and the service account rewrites any tenant's BU with no claim.  
  Fix: Add assertMemberMayWrite and derive the acting owner from the verified person/actor ID; require a verifiedOrg claim for the service account.  
  Proof: **RED** `convex/__tests__/audit/businessUnits.twoPoles.test.ts` — a non-writer role must be refused: expected NO REFUSAL (the write succeeded) to contain RBAC_DENIED
- **businessUnits:remove** `businessUnits.ts:311-328 (master gate; tenant check below is unreachable)` — Any MCP seat (service account) deletes any tenant's business unit by ID with no claim and no ownership check; the row-tenant check at :322 is dead code behind the master-only gate.  
  Fix: Require a verifiedOrg claim and compare it with bu.orgId (or restrict to operator maintenance via an internal function).  
  Proof: **RED** `convex/__tests__/audit/businessUnits.twoPoles.test.ts` — a claimless caller must not delete a client-org-stamped BU: expected NO REFUSAL (the write succeeded) to contain RBAC_DENIED
- **businessUnits:get** `businessUnits.ts:371` — The read ignores the row's own orgId stamp that update checks (sameTenantStamp): an org whose roster carries the same orchestrator name as another org's (or the fleet's) BU reads that org's BU by ID; the only discriminator is a name string.  
  Fix: Add sameTenantStamp(bu.orgId, scope.orgSlug, operator) before the roster check.  
  Proof: **RED** `convex/__tests__/audit/businessUnits.twoPoles.test.ts` — expected full BU object to be null
- **businessUnits:list** `businessUnits.ts:558 (roster filter after the read, name only); businessUnits.ts:537-544 (collect then filter)` — Same cross-tenant name collision as get (orgId ignored on read), and the roster filter runs after take(limit+1), so a member's page can be short or empty while its own units exist further down.  
  Fix: Filter by orgId inside the index (add a by_org index) and apply the roster as a narrowing intersect.  
  Proof: **RED** `convex/__tests__/audit/businessUnits.twoPoles.test.ts` — expected [A unit] to have length 0 but got 1; expected [] to deeply equal [B-unit] (limit 1, own oldest unit hidden)
- **mcp:create_bu** `mcp-server/src/tools.ts:8099-8118; convex/businessUnits.ts:126-160` — BU written by a seat is stamped with no org (businessUnits.create: scope.isMaster || orgSlug===null => no orgId) because no verified org is forwarded.  
  Fix: Forward verifiedOrg and stamp from it.  
  Proof: **RED** `mcp-server/test/audit/registry.twoPoles.test.ts` — expected undefined to be org-a
- **mcp:update_bu** `mcp-server/src/tools.ts:8204-8233; convex/businessUnits.ts:214-262` — A seat/credential caller can rewrite ANY organisation's business unit by id (masked tool, reachable in-process): the MCP binds only the typed name; businessUnits:update runs as the service account so the row tenant and owner checks (sameTenantStamp, isOrchestratorAllowedForScope) pass as master.  
  Fix: Forward verifiedOrg and refuse unless bu.orgId equals it; add unresolvedOrgDenial.  
  Proof: **RED** `mcp-server/test/audit/registry.twoPoles.test.ts` — expected HIJACKED to be B-a1-unit
- **mcp:get_bu** `mcp-server/src/tools.ts:8278-8290` — BU visibility for seats is a name filter over a master-reach read; bu.orgId is ignored.  
  Fix: Gate on the verified org.  
  Proof: **RED** `mcp-server/test/audit/registry.twoPoles.test.ts` — expected output not to contain SECRET-PRICING
- **mcp:list_bus** `mcp-server/src/tools.ts:8371-8406` — Same as get_bu for the collection: name filter after a master-reach read, orgId ignored, limit before filter.  
  Fix: Forward verifiedOrg and filter in the query.  
  Proof: **RED** `mcp-server/test/audit/registry.twoPoles.test.ts` — expected output not to contain B-unit

### briefingNotes — 8

- **briefingNotes:list** `convex/briefingNotes.ts:502-507,725-730` — [LOW, availability/correctness] createdBefore is applied after the page is cut (rows.slice(0,limit) at 725 then the filter at 727-730) and needsWideScan (502-506) ignores it, so page 2 re-reads the newest `limit` rows, drops all of them as newer than the cursor and returns [] - a rightful caller cannot page past the first page.  
  Fix: push the cursor into the read: add .lt('_creationTime', before) inside the by_orgId / by_orgId_topic / master index ranges (the implicit trailing index column) instead of filtering after the take.  
  Proof: **RED** `convex/__tests__/audit/briefingNotes.twoPoles.test.ts` — AssertionError: expected [] to deeply equal [ n1 ]
- **briefingNotes:deleteBriefingNote** `convex/briefingNotes.ts:797-809` — [MEDIUM] on the agent path callerOrchestrator is never roster- or credential-checked (create does call requireOrchestratorOnRoster at 203), so any member of the note's org, including one who would be refused by the human path's org:admin gate (785-792), deletes any note by passing note.createdBy, which get/list return.  
  Fix: for a non-master scope bind callerOrchestrator to proof (requireAgentCredentialMatch / verifiedActor as messages and tasks do) and roster-check it, or ignore the argument for non-master callers so the human admin path always applies.  
  Proof: **RED** `convex/__tests__/audit/briefingNotes.twoPoles.test.ts` — promise resolved { deleted: true } instead of rejecting (human-path control refuses same member)
- **briefingNotes:update** `convex/briefingNotes.ts:887-898` — [MEDIUM] same flaw as deleteBriefingNote: callerOrchestrator is accepted at face value with no roster or agent-credential check, so any org member skips the human path's writer-role allowlist (880-886) by passing note.createdBy, and the forged name is stored as updatedBy.  
  Fix: require proof for callerOrchestrator on non-master scopes (requireAgentCredentialMatch plus requireOrchestratorOnRoster) or ignore it and always take the resolveHumanActor path.  
  Proof: **RED** `convex/__tests__/audit/briefingNotes.twoPoles.test.ts` — promise resolved null instead of rejecting (human-path control refuses role-not-writer)
- **mcp:create_briefing_note** `mcp-server/src/tools.ts:6749-6757; convex/briefingNotes.ts:184-211` — Note written by a seat/credential caller is stamped with no org (briefingNotes.create uses scope.isMaster ? undefined) because no verified org is forwarded; the organisation's own members cannot see it.  
  Fix: Forward verifiedOrg and stamp from it.  
  Proof: **RED** `mcp-server/test/audit/knowledge.twoPoles.test.ts` — AssertionError: expected +0 to be 1 (briefingNotes:list as org-a member)
- **mcp:update_briefing_note** `mcp-server/src/tools.ts:6819-6831; convex/briefingNotes.ts:854-897` — Ownership of the note is decided by comparing the typed creator NAME to note.createdBy while the org check is satisfied by the service account; a seat whose allowlist name equals the creator name of another organisation's note edits it by id (no verifiedOrg).  
  Fix: Forward verifiedOrg and refuse when note.orgId differs.  
  Proof: **RED** `mcp-server/test/audit/knowledge.twoPoles.test.ts` — AssertionError: expected 'pwned' to be 'org-b secret content'
- **mcp:get_briefing_note** `mcp-server/src/tools.ts:6891-6911` — Briefing-note visibility for a seat is decided by participant/creator NAME after a service-account (all tenants) read; the note's orgId stamp is ignored, so a colliding name in another organisation exposes its notes.  
  Fix: Forward verifiedOrg and gate rows on it for every non-master non-Clerk caller.  
  Proof: **RED** `mcp-server/test/audit/knowledge.twoPoles.test.ts` — AssertionError: expected output not to contain 'org-b secret content' (note returned; own-org control passes)
- **mcp:list_briefing_notes** `mcp-server/src/tools.ts:6995-7028` — Briefing-note visibility for a seat is decided by participant/creator NAME after a service-account (all tenants) read; the note's orgId stamp is ignored, so a colliding name in another organisation exposes its notes, and the limit is applied before the filter.  
  Fix: Forward verifiedOrg and gate rows on it for every non-master non-Clerk caller.  
  Proof: **RED** `mcp-server/test/audit/knowledge.twoPoles.test.ts` — AssertionError: expected output not to contain 'org-b secret content'
- **mcp:search_briefing_notes_by_keyword** `mcp-server/src/tools.ts:7140-7183` — Briefing-note visibility for a seat is decided by participant/creator NAME after a service-account (all tenants) read; the note's orgId stamp is ignored, so a colliding name in another organisation exposes its notes, and the limit is applied before the filter.  
  Fix: Forward verifiedOrg and gate rows on it for every non-master non-Clerk caller.  
  Proof: **RED** `mcp-server/test/audit/knowledge.twoPoles.test.ts` — AssertionError: expected output not to contain 'org-b secret content'

### missions — 7

- **missions:create** `convex/missions.ts:230-237` — [M] A member of any role skips the writer-role gate by supplying createdBy (the human path runs only when createdBy is absent) and may claim any roster name, including a registered agent's, because no credential lock exists on this door.  
  Fix: Apply requireAgentCredentialMatch (add agentCredentialSecret/verifiedActor args) and require resolveHumanActor/writer role for every non-master caller.  
  Proof: **RED** `convex/__tests__/audit/missions.twoPoles.test.ts` — {ok:true, missions:1} expected {ok:false, missions:0}; human path correctly refused role-not-writer
- **missions:update** `convex/missions.ts:722-733,769-777` — [H] Any member of the org, whatever its role, bypasses the writer-role and org:admin gates by passing any callerOrchestrator string: the human path runs only when the arg is absent, and cancel is then authorised by mission.createdBy === callerOrchestrator, a value readable from the mission itself.  
  Fix: Roster-check and credential-bind callerOrchestrator (requireAgentCredentialMatch) for non-master callers and run resolveHumanActor/writer role (adminOnly on cancel) regardless of the arg.  
  Proof: **RED** `convex/__tests__/audit/missions.twoPoles.test.ts` — {ok:true, status:cancelled} expected {ok:false, status:execute}; human path correctly refused
- **mcp:create_mission** `mcp-server/src/tools.ts:6055-6069; convex/missions.ts:246` — A seat/credential caller's mission is stored with orgId undefined (missions.create uses scope.isMaster ? undefined : orgSlug and the transport scope is the service account), so the creating organisation's own dashboard/Clerk members cannot see it and no verified org binds later writes.  
  Fix: Add a verifiedOrg claim to missions:create and stamp orgId from it; call unresolvedOrgDenial first.  
  Proof: **RED** `mcp-server/test/audit/tasks.twoPoles.test.ts` — orgs [undefined] expected [org-a]
- **mcp:list_missions** `mcp-server/src/tools.ts:6140-6171; convex/missions.ts:593-613` — The tenant is decided by an unverified ARGUMENT compared to a token field: a seat whose userId equals a pilot name in another organisation receives that organisation's missions, since missions:list is served to the service account as master (all tenants) and nothing filters by orgId afterwards; a rightful seat whose userId differs from its pilot names is refused.  
  Fix: Drop the userId comparison; forward verifiedOrg to missions:list so the Convex query uses the by_orgId index of the verified org.  
  Proof: **RED** `mcp-server/test/audit/tasks.twoPoles.test.ts` — org-b row returned/affected for org-a seat
- **mcp:get_mission** `mcp-server/src/tools.ts:6248-6255; convex/missions.ts:258-310` — Mission visibility for a seat is decided by name (pilot/agents ∈ fromAllowList) after a master-reach read; the mission's own orgId stamp is ignored, so a colliding name in another organisation reads its mission by id.  
  Fix: Gate on rowVisibleToActorTenant keyed on the verified org before scopeFilterGet.  
  Proof: **RED** `mcp-server/test/audit/tasks.twoPoles.test.ts` — org-b row returned/affected for org-a seat
- **mcp:update_mission** `mcp-server/src/tools.ts:6336-6361; convex/missions.ts:690-716,742-792` — A seat/credential caller can patch ANY organisation's mission by id (name, brief, pilot, agents, status, progress): the MCP checks only the typed caller name, and missions:update runs as the service account so isOrgAllowedForScope(master, mission.orgId) is always true and the non-cancel patch path has no creator/pilot check at all (cancel only checks creator by name).  
  Fix: Forward verifiedOrg (as the ten task write doors do) and make missions:update call resolveDoorVerifiedOrg/assertRowInVerifiedOrg; add unresolvedOrgDenial('update_mission').  
  Proof: **RED** `mcp-server/test/audit/tasks.twoPoles.test.ts` — brief 'overwritten' landed on org-b mission
- **mcp:instantiate_template_into_mission** `mcp-server/src/tools.ts:9964-9990; convex/missionTemplates.ts:446-480` — Instantiation authority rests on a name filter over a master-reach mission read; the mission's orgId is never compared to the caller's, so a seat with a colliding pilot/agents name instantiates (creates tasks stamped with the foreign mission's orgId) into another organisation's mission.  
  Fix: Forward verifiedOrg and refuse unless mission.orgId equals it (rowVisibleToActorTenant on the verified org).  
  Proof: **RED** `mcp-server/test/audit/tasks.twoPoles.test.ts` — 1 task created in org-b mission, expected 0

### recurringTasks — 6

- **recurringTasks:create** `convex/recurringTasks.ts:203,232` — [L] A master call (MCP for a client org) creates an untenanted schedule whose tasks land as fleet rows because the door accepts no verifiedOrg claim, and a scoped caller naming a registered agent as createdBy hits AGENT_CREDENTIAL_REQUIRED (lib/auth.ts:1053-1062) that this door gives no argument to satisfy.  
  Fix: Add verifiedOrg/verifiedActor/agentCredentialSecret args and thread them through requireAuthenticatedCaller, stamping orgId from the verified org.  
  Proof: **RED** `convex/__tests__/audit/recurringTasks.twoPoles.test.ts` — AGENT_CREDENTIAL_REQUIRED, door has no argument to present the credential. Part (a) (master untenanted stamp) not separately tested; code reads scope.isMaster ? undefined (recurringTasks.ts:232)
- **recurringTasks:list** `convex/recurringTasks.ts:312-334` — [M] The tenant predicate is applied after the read, so a member whose schedules sit behind `limit` newer rows of other orgs is served [] (a withheld grant), exactly the shape missions:list and tasks:list were already fixed for.  
  Fix: Add by_orgId (+active/assignee) indexes and put eq('orgId', scope.orgSlug) inside the query for non-master callers.  
  Proof: **RED** `convex/__tests__/audit/recurringTasks.twoPoles.test.ts` — expected ['mine'], received [] (tenant filter after take(limit))
- **mcp:create_recurring_task** `mcp-server/src/tools.ts:7248-7257; convex/recurringTasks.ts:203-233` — Schedule created by a seat/credential caller is stamped with no org (recurringTasks.create: scope.isMaster ? undefined) and the tasks it spawns are stamped from that row, so the organisation cannot see its own schedule.  
  Fix: Forward verifiedOrg to recurringTasks:create and stamp from it.  
  Proof: **RED** `mcp-server/test/audit/tasks.twoPoles.test.ts` — orgs [undefined] expected [org-a]
- **mcp:list_recurring_tasks** `mcp-server/src/tools.ts:7336-7346` — Recurring-task visibility for seats is a name filter over a master-reach read; orgId ignored.  
  Fix: Gate on the verified org.  
  Proof: **RED** `mcp-server/test/audit/tasks.twoPoles.test.ts` — org-b row returned/affected for org-a seat
- **mcp:update_recurring_task** `mcp-server/src/tools.ts:7559-7581; convex/recurringTasks.ts:366-405` — Update authority is a name filter on the fetched row; the schedule's orgId is ignored and recurringTasks:update runs as master, so a colliding assignee/creator name in another organisation lets a seat reassign or rewrite its schedule by id.  
  Fix: Forward verifiedOrg and refuse unless existing.orgId equals it.  
  Proof: **RED** `mcp-server/test/audit/tasks.twoPoles.test.ts` — title became 'hijacked' on org-b schedule
- **mcp:get_recurring_task** `mcp-server/src/tools.ts:10897-10903` — Name filter over a master-reach by-id read; schedule orgId ignored.  
  Fix: Gate on the verified org.  
  Proof: **RED** `mcp-server/test/audit/tasks.twoPoles.test.ts` — org-b row returned/affected for org-a seat

### mandates — 5

- **mandates:create** `convex/mandates.ts:95-108` — [L] The parties of a spending mandate (requestedBy/fulfilledBy) are asserted strings not bound to the verified caller, and budget is unvalidated, so the master can mint a mandate 'requested by pi' for any amount.  
  Fix: Bind requestedBy to a verified actor (verifiedActor/agentCredentialSecret as tasks doors do) and validate budget/limits as finite and > 0.  
  Proof: **RED** `convex/__tests__/audit/mandates.twoPoles.test.ts` — budget -1 mandate was inserted (outcome resolved, rows [-1])
- **mandates:accept** `convex/mandates.ts:129-136` — [L] 'only fulfilledBy or system can accept' is decided by an asserted name, and the only callers are masters who can always type 'system', so the check binds nobody and the door has no agentCredentialSecret/verifiedActor arg.  
  Fix: Add verifiedActor/agentCredentialSecret to the args and compare the verified agent row to fulfilledBy, or drop the pretended ownership check and document master-only.  
  Proof: **RED** `convex/__tests__/audit/mandates.twoPoles.test.ts` — expected status requested/refused, got resolved + status accepted via typed 'system'
- **mandates:update** `convex/mandates.ts:153-184` — [M] The fulfiller can set status:'settled' and tokensCost through update, bypassing settle's requestedBy-only confirmation (mandates.ts:207-214), and the fulfilledBy check is a name compare a master can satisfy by typing the name or 'system'.  
  Fix: Remove status 'settled' (and tokensCost) from update's patchable fields, force transitions through accept/settle, and bind the actor by verifiedActor.  
  Proof: **RED** `convex/__tests__/audit/mandates.twoPoles.test.ts` — update resolved: status settled, tokensCost 99999 without requestedBy confirmation
- **mandates:settle** `convex/mandates.ts:207-214` — [L] Settlement authority is an asserted name compare that any master satisfies with 'system'; finalCost is unvalidated and a mandate can be settled from any status (including 'requested').  
  Fix: Bind the actor via verifiedActor, require status delivered before settle, and validate finalCost >= 0 and <= budget.  
  Proof: **RED** `convex/__tests__/audit/mandates.twoPoles.test.ts` — settle resolved: status settled, tokensCost -5 from state requested
- **mcp:validate_mandate_spending** `mcp-server/src/tools.ts:7858-7893; convex/mandates.ts:425-446` — Any authenticated seat/person (masked tool, reachable in-process) reads the budget, current spend and limits of ANY mandate by id: the tool is declared public and mandates:validateSpending's master-only gate is satisfied by the service account; the stated 'no cross-tenant enumeration' only holds for ids the caller cannot obtain.  
  Fix: Declare the tool master-only (or filter by requestedBy/fulfilledBy ∈ fromAllowList as get_mandate does).  
  Proof: **RED** `mcp-server/test/audit/tasks.twoPoles.test.ts` — fleet mandate figures (budget 424242) returned

### okfBundleNode — 5

- **okfBundleNode:exportOkfBundle** `convex/okfBundle.ts:294-328` — [LOW] _fetchTasksForBundle returns every task stamped with the member's org with no roster intersect (filterByOrgScope / isRowVisibleToScope leg 4), so the export serves tasks assigned to orchestrators outside the org's allowedOrchestrators that tasks:list and tasks:get withhold (auth.ts:640-649: a roster may narrow, never widen).  
  Fix: for a non-master scope apply filterByOrgScope(rows, scope) to the task family (pass the resolved scope or roster into the fetch, derived server-side).  
  Proof: **RED** `convex/__tests__/audit/okfBundleNode.twoPoles.test.ts` — AssertionError: expected 1 to be +0 (manifest.types.taskCount; tasks:list returns 0 for the same row, control)
- **okfBundleNode:validateOkfBundle** `convex/okfBundleNode.ts:558-619,629-667,764` — [MEDIUM] the bundleUrl branch is open to any signed-in caller including one with no organisation, and its SSRF filter (assertBundleUrlSafe) only matches hostname literals: IPv4-mapped IPv6 such as [::ffff:7f00:1] passes (602-617 lists ::1, fc, fd, fe8-feb only), DNS names resolving to private ranges are never resolved, fetch() follows redirects to unchecked targets (764), and the body is read with no size cap.  
  Fix: run requireResolvedCaller(alsoRefusePreOrg) before either branch; resolve DNS and block private/mapped addresses, fetch with redirect:'manual' re-validating each hop, cap the body size, or restrict bundleUrl to the deployment's own storage host.  
  Proof: **RED** `convex/__tests__/audit/okfBundleNode.twoPoles.test.ts` — AssertionError: expected fetch to not be called at all, but actually been called 1 times (4 address forms); controls 127.0.0.1 and [::1] refused HOST_DENIED. Separate test: no-org signed-in caller reaches fetch (OKF_VALI
- **okfBundleNode:importOkfBundle** `convex/okfBundleNode.ts:918-935,1128-1141 -> convex/okfBundle.ts:742-801` — [HIGH] task assignedTo/createdBy/status and memory createdBy are taken from the uploaded bundle's frontmatter at face value (parseEntry 918-935; the validator accepts unknown fields, okfValidator.ts rule 6) and _insertImportedTask (okfBundle.ts:742-801) never calls requireOrchestratorOnRoster(...,'assignee'/'actor') or the writer-role gate, so an org member can plant tasks in a fleet orchestrator's queue (assignedTo 'pi'), forge createdBy 'system' or 'user:<other subject>' (taskActorIdFields returns any user:* name as an id, actorIds.ts:53), and bypass tasks:create's roster and role checks; also every imported row gets createdAt=1_700_000_000_000 (okfBundleNode.ts:1051).  
  Fix: for a non-master scope force createdBy to the verified actor and reject assignedTo not on scope.allowedOrchestrators (requireOrchestratorOnRoster, kind 'assignee'), apply the member writer-role gate, and derive createdAt from Date.now() inside the internal mutation.  
  Proof: **RED** `convex/__tests__/audit/okfBundleNode.twoPoles.test.ts` — AssertionError: expected { err: 'NO-ERROR', planted: 1 } to deeply equal { err: Any<String>, planted: 0 }
- **mcp:import_okf_bundle** `mcp-server/src/tools/importOkfBundle.ts:103-112; convex/okfBundleNode.ts:986-1012` — A seat/person token can import ANY storage blob by storageId into its own namespace: the ownership assertion (kbUploads binding) runs only for non-master scope and the transport scope is the service account (master), so another organisation's exported or uploaded bundle (memories, briefing notes, tasks) is copied into the caller's namespace if its storageId is known.  
  Fix: Forward the verified org and run the owner assertion for any caller that is not the fleet master bearer / stdio trust ctx, not for the service-account transport.  
  Proof: **RED** `mcp-server/test/audit/knowledge.twoPoles.test.ts` — AssertionError: expected { refused: false, copied: 1 } to equal { refused: true, copied: 0 }
- **mcp:validate_okf_bundle** `mcp-server/src/tools/validateOkfBundle.ts:79-112; convex/okfBundleNode.ts:725-760` — Any authenticated seat/person reads the validation report (counts, error paths and messages) of ANY storage blob by storageId: the Convex ownership assertion is skipped for the service-account transport. The tool is masked but reachable in-process.  
  Fix: Same fix as import_okf_bundle: assert ownership for every caller except the fleet master bearer.  
  Proof: **RED** `mcp-server/test/audit/knowledge.twoPoles.test.ts` — AssertionError: expected isError true, got false (report returned)

### diary — 4

- **diary:write** `convex/diary.ts:181` — [LOW] createdBy is documented as auth-derived and unspoofable (diary.ts:109-114, list 371-373) but the public mutation takes it from the caller (125, 181), so any org member writes any author string, and diary:list's createdBy filter then serves forged attribution as verified.  
  Fix: ignore args.createdBy for non-master scopes and stamp the verified actor; accept it only from the MCP-bound master (isMcpBoundMaster).  
  Proof: **RED** `convex/__tests__/audit/diary.twoPoles.test.ts` — AssertionError: expected [ 'user:someone-else' ] to not include 'user:someone-else'
- **mcp:write_diary** `mcp-server/src/tools.ts:6463-6470; convex/diary.ts:185-190` — Diary rows written by a seat/credential caller carry no tenant (diary:write stamps orgId only when the transport scope has an org, and the transport is the service account => fleet row), so the organisation's own members cannot read them and tenant isolation of the row is lost.  
  Fix: Forward verifiedOrg to diary:write and stamp from it.  
  Proof: **RED** `mcp-server/test/audit/knowledge.twoPoles.test.ts` — AssertionError: expected null not to be null (diary:get as org-a member)
- **mcp:get_diary** `mcp-server/src/tools.ts:6522-6530` — Diary entry visibility for seats is decided by name (createdBy ∈ fromAllowList) after a master-reach read; the entry's orgId stamp is ignored.  
  Fix: Gate on the verified org before scopeFilterGet.  
  Proof: **GREEN** `mcp-server/test/audit/knowledge.twoPoles.test.ts` — Test passed: org-b entry not returned; positive control (unstamped row createdBy eta) is returned, so the read path is live.
- **mcp:list_diaries** `mcp-server/src/tools.ts:6621-6653` — Tenant decided by an unverified argument equal to a token field; diary:list is served as master so another organisation's entries for the same name are returned, and a seat whose userId differs from the names it may act as is refused.  
  Fix: Drop the userId comparison; forward verifiedOrg so diary:list uses the tenant index.  
  Proof: **RED** `mcp-server/test/audit/registry.twoPoles.test.ts` — expected output not to contain ORG-B-DIARY

### githubRepoMapping — 4

- **mcp:add_repo_mapping** `mcp-server/src/tools.ts:8547-8557; convex/githubRepoMapping.ts:346-398` — A seat/person token can create or overwrite ANY repo mapping (fleet row, no orgId): githubRepoMapping:add runs as master, so resolveWriteTenant returns undefined, requireOrchestratorOnRoster and the GitHub-owner-binding proof are skipped, and requireRowOwnedBy lets master patch an existing org-owned row. A tenant can re-route another organisation's or the fleet's webhook events to an orchestrator of its choice.  
  Fix: Forward verifiedOrg (or refuse non-master non-Clerk callers) and apply the same tenant/owner-binding rules the Convex door applies to members.  
  Proof: **RED** `mcp-server/test/audit/registry.twoPoles.test.ts` — expected a1 to be eta (mapping overwritten)
- **mcp:list_repo_mappings** `mcp-server/src/tools.ts:8649-8681; convex/githubRepoMapping.ts:203-290` — Mapping visibility for seats is a name filter over a master-reach list (githubRepoMapping:list returns every tenant to master); orgId ignored and limit applied first.  
  Fix: Forward verifiedOrg so the by_org index is used.  
  Proof: **RED** `mcp-server/test/audit/registry.twoPoles.test.ts` — expected output not to contain org-b/app
- **mcp:remove_repo_mapping** `mcp-server/src/tools.ts:8752-8760; convex/githubRepoMapping.ts:405-420` — A seat/person token can delete ANY repo mapping by repo name, including other organisations' and the fleet's: githubRepoMapping:remove runs as master, resolveWriteTenant/requireRowOwnedBy pass.  
  Fix: Forward verifiedOrg; refuse non-master non-Clerk callers or enforce row ownership by orgId.  
  Proof: **RED** `mcp-server/test/audit/registry.twoPoles.test.ts` — expected null not to be null (row deleted)
- **mcp:get_repo_mapping** `mcp-server/src/tools.ts:10750-10781` — Name filter over a master-reach by-repo read; mapping.orgId ignored.  
  Fix: Gate on the verified org.  
  Proof: **RED** `mcp-server/test/audit/registry.twoPoles.test.ts` — assertion expected isError true (mapping returned)

### oauth — 4

- **oauth:provisionOrganization** `convex/oauth.ts:940` — The fleet master secret is accepted as a request argument and an unsalted SHA-256 of it is persisted as actorTokenHash in oauth_audit_log (every sibling door audits sha256 of identity:<userId> instead), so the master secret travels in function arguments and leaves an offline-checkable digest at rest.  
  Fix: Drop the callerToken branch (service-account or Clerk-admin identity only) and audit sha256Hex('identity:'+subject) like requireServiceAccount does.  
  Proof: **RED** `convex/__tests__/audit/oauth.twoPoles.test.ts` — AssertionError: actorTokenHash equals unsalted sha256 of the master secret: expected true to be false
- **oauth:createAuthorizationCode** `convex/oauth.ts:1990` — The single-use authorization code is stored in plaintext (not a hash) and oauth.ts has no purge for oauth_authorization_codes (the purge at :2150 covers oauth_person_codes only), so every unspent legacy code stays readable from the table until consumed.  
  Fix: Delete createAuthorizationCode/consumeAuthorizationCode and the table as the comment already plans, or store sha256(code) and add an expiry purge.  
  Proof: **RED** `convex/__tests__/audit/oauth.twoPoles.test.ts` — AssertionError: row.code holds the plaintext code: expected true to be false
- **oauth:getRefreshTokenByHash** `convex/oauth.ts:2344` — Refresh tokens are not rotated: the refresh grant mints a new refresh token but leaves the presented one valid for its full 30 days (mcp-server/server-http.ts:1140-1146 says revoke-on-use is deferred) and no door can consume one, so a stolen refresh token is replayable for 30 days with no reuse detection, and each refresh adds another live token.  
  Fix: Add an atomic oauth:consumeRefreshToken (read-and-mark like consumePersonCode), have the refresh grant call it, and revoke the whole token family when a consumed token is replayed.  
  Proof: **RED** `mcp-server/test/audit/oauth-refresh.twoPoles.test.ts` — AssertionError: replay status (error=undefined): expected 200 to be 400
- **oauth:patchScopeProfileEmergency** `convex/oauth.ts:2578` — The D4 guard that forbids '*' and 'global' prefixes on non-master profiles inspects only the prefixes passed in this call, so renaming master (prefixes ['*']) to another id with no prefix args succeeds and leaves a wildcard non-master profile, and rename has no collision check so a duplicate profileId makes every by_profileId .unique() lookup throw and locks that profile's seats out.  
  Fix: Evaluate D4 on the final stored prefixes (patched value or existing), and refuse a rename whose target profileId already exists.  
  Proof: **RED** `convex/__tests__/audit/oauth.twoPoles.test.ts` — AssertionError: promise resolved "{ ...(4) }" instead of rejecting (both cases: master->client-x, client-generic->public-readonly)

### profiles — 4

- **profiles:getProfile** `profiles.ts:99 (raw includes on roster); profiles.ts:115-120 (instanceId checked after the read)` — Authorisation is allowedOrchestrators.includes(orchestratorId), an exact-case raw string match while every other roster check normalises (a roster 'Pi' refuses 'pi'; a roster 'pi' exposes the fleet pi's workspace and currentTask to the client org); the instanceId branch decides after the read, an existence oracle for instance IDs.  
  Fix: Use isOrchestratorOnOrgRoster (normalised) and decide the instanceId branch from the requested name before reading, or project away workspace/currentTask for non-master callers.  
  Proof: **RED** `convex/__tests__/audit/profiles.twoPoles.test.ts` — roster [Pi] + request pi -> RBAC_DENIED not-on-roster; roster [pi] -> served /fleet/pi-workspace; foreign instanceId refused vs absent instanceId null (oracle)
- **profiles:upsertProfile** `profiles.ts:21-31 (requireFleetMaster = scope.isMaster); profiles.ts:159` — Any MCP seat (service account, including client-org seats) can create or rewrite the profile of any orchestratorId it names; profiles drive the broadcast recipient set (messages.ts:503), the known-role set for direct sends (messages.ts:590) and the foreign-identity test (messages.ts:826), so a seat can make an arbitrary name a routable fleet role or alter another station's workspace/capabilities. Identity of the writer is never bound to the profile it writes.  
  Fix: Bind the write to the caller's verified agent (verifiedActor ID -> its own profile only) and refuse writes to another orchestrator's profile; keep master for operator maintenance only.  
  Proof: **RED** `convex/__tests__/audit/profiles.twoPoles.test.ts` — upsertProfile must refuse a claimless caller naming 'pi': expected false to be true
- **profiles:updateDynamic** `profiles.ts:21-31; profiles.ts:221-265 (auto-creates)` — Same as upsertProfile: any service-account seat can overwrite another orchestrator's currentTask/endOfDayIndex and auto-create a profile for an unknown orchestratorId, which makes that name a routable broadcast target.  
  Fix: Same: bind the updated orchestrator to the verified acting agent.  
  Proof: **RED** `convex/__tests__/audit/profiles.twoPoles.test.ts` — no profile row may be auto-created for an unverified name: expected row to be null
- **profiles:getProfileWithMemories** `profiles.ts:323-343` — The only gate is the namespace (team/<own org>), then the profile is fetched for any orchestratorId the caller types, so any member of any org reads any fleet orchestrator's workspace path, role, capabilities and currentTask; getProfile refuses the same read for an off-roster name.  
  Fix: Apply the getProfile roster rule (normalised) to the profile half, or return profile:null for non-master callers.  
  Proof: **RED** `convex/__tests__/audit/profiles.twoPoles.test.ts` — expected profile object to be null

### memories — 3

- **memories:storeMemory** `convex/memories.ts:112` — [LOW] createdBy (creatorValidator = v.string()) is stored exactly as sent with no roster or credential binding, unlike briefingNotes:create (requireOrchestratorOnRoster), so an org member can author memories as 'pi', 'system' or another person, falsifying the attribution that listMemories' createdBy filter and the by_creator index report.  
  Fix: for non-master scopes ignore args.createdBy and stamp the verified actor (memberActorOf / resolveHumanActor) or require requireOrchestratorOnRoster plus requireAgentCredentialMatch; accept a free createdBy only from the MCP-bound master (isMcpBoundMaster).  
  Proof: **RED** `convex/__tests__/audit/memories.twoPoles.test.ts` — AssertionError: expected [ 'pi' ] to not include 'pi'
- **memories:softDeleteMemory** `convex/memories.ts:409-419` — [LOW] the row is fetched and a plain 'Memory ... not found' Error is thrown (409-412) BEFORE the caller is resolved (419), so an unauthenticated caller can tell an existing memoryId from a missing one - the get-then-scope order the sibling doors were fixed to avoid (briefingNotes.ts:750-764).  
  Fix: call withOrgScope and refuse anonymous / no-org callers before ctx.db.get, and return the same RBAC_DENIED for a missing and a foreign id.  
  Proof: **RED** `convex/__tests__/audit/memories.twoPoles.test.ts` — AssertionError: expected 'Error: Memory ... not found' to match /RBAC_DENIED/ (live id gives RBAC_DENIED, deleted id gives not-found)
- **mcp:store_memory** `mcp-server/src/tools.ts:2312-2337 (relatesTo forwarded unchecked), convex/memories.ts:84-95` — A non-master caller (OAuth seat/person) can supersede (isLatest=false) ANY memory by id in any namespace/tenant by sending relatesTo{type:'updates',targetId}: the MCP checks only the write namespace of the NEW row, and Convex validates the target namespace with isNamespaceAllowedForScope(scope) where scope is the service account = master (always true).  
  Fix: Resolve the target row at the MCP boundary (or add a verifiedNamespaces/verifiedOrg claim to memories:storeMemory) and refuse an 'updates' relation whose target namespace fails checkNamespaceWrite for the caller.  
  Proof: **RED** `mcp-server/test/audit/knowledge.twoPoles.test.ts` — AssertionError: expected { refused: false, stillLatest: false } to equal { refused: true, stillLatest: true }

### episodes — 2

- **episodes:storeEpisode** `convex/episodes.ts:76` — [LOW] createdBy is persisted at face value (76), so an org member can author episodes as any orchestrator or 'system'; same attribution forgery as memories:storeMemory.  
  Fix: for non-master scopes stamp the verified actor or require requireOrchestratorOnRoster plus requireAgentCredentialMatch; accept a free createdBy only from the MCP-bound master.  
  Proof: **RED** `convex/__tests__/audit/episodes.twoPoles.test.ts` — AssertionError: expected [ 'pi' ] to not include 'pi'
- **episodes:getCriticalInsights** `convex/episodes.ts:227-240` — [LOW-MEDIUM] the tenant predicate is applied after the read instead of inside it: the query collects every tenant's latest episodes then filters, so the work and the 16 MB per-execution read limit are bounded by the global corpus, not the caller's - once the table is large every org member's call throws (the briefingNotes #1294 failure shape), and an anonymous or no-org caller still triggers the full scan before receiving [].  
  Fix: short-circuit refused scopes before reading; for members read the team/<slug> namespace range through the namespace index and take(limit); keep the full by_type scan master-only and bounded.  
  Proof: **RED** `convex/__tests__/audit/episodes.twoPoles.test.ts` — Error: Read too much data in a single function execution (limit: 16777216 bytes) (small-corpus control passes)

### http — 2

- **http:POST /issueBearerFromClerk** `convex/credentials.ts:502` — The extension whitelist compares a string the caller declares in the request body, so any Clerk user can mint a 7-day bearer from curl by sending an allowed extId, and each call adds another live bearer that nothing revokes (the NODE_ENV production refusal at :486 only fires if NODE_ENV is set on the deployment, otherwise the hardcoded dev extension id is accepted); unauthenticated failures also echo the expected audience and issuer (:459-461).  
  Fix: Drop extId as a gate (bind the bearer to the Clerk session and an origin/azp check instead), revoke or cap prior bearers per user on mint, and return a generic 401 body.  
  Proof: **RED** `convex/__tests__/audit/http.twoPoles.test.ts` — AssertionError: 401 body contains the expected audience: expected true to be false; AssertionError: live bearers after two mints: expected 2 to be less than or equal to 1
- **http:POST /api/eta/verify-publish-token** `convex/http.ts:871` — Any holder of the fleet-wide master bearer (documented as curl-able from every orchestrator host) can read the assignee, status and first 200 characters of the completion note of any task in any client org, and the publish approval it returns is forgeable because expectedSha is matched as a case-insensitive substring of the note (http.ts:897) with no minimum length, no APPROVED-verdict check and no tie to a review of that repo/PR, so a one-character expectedSha passes on any done reviewer-assigned task.  
  Fix: Resolve the task through the org gate and refuse any task outside the operator org, require a full 40-hex SHA matched as a token plus an explicit APPROVED marker bound to the PR, drop hint/noteExcerpt/got from the response, and use a scoped verification credential instead of the master secret.  
  Proof: **RED** `convex/__tests__/audit/http.twoPoles.test.ts` — AssertionError: valid for a REVISE note matched by 1 char: expected true to be false; response body contains acme's note text; valid:true for a task of org acme

### kb — 2

- **kb:storeDocumentChunked** `convex/kbMutations.ts:52-65 (called from convex/kb.ts:276)` — [LOW-MEDIUM] bindOrAssertStorageOwnership inserts a binding for the first org that presents an unbound storageId (kbMutations.ts:57-64) - the first-claim pattern the repo refuses on import/validate and in the ticket flow (okfBundleNode.ts:716-722, kbMutations.ts:229-249: 'storageIds leak') - so an org that learns the id of a blob another org uploaded through the plain generateUploadUrl can ingest its bytes into its own namespace and lock the uploader out with AUTH_STORAGE_NOT_OWNED.  
  Fix: require an existing binding (getStorageOwner === orgId, produced by claimUpload) before ctx.storage.get and remove the insert branch for members; move plain-URL uploaders to the ticket flow.  
  Proof: **RED** `convex/__tests__/audit/kb.twoPoles.test.ts` — AssertionError: expected { err: 'NO-ERROR', boundOrgs:['org-b'], chunkCount:1 } to equal { err: AUTH_*, boundOrgs: [], chunkCount: 0 } (bound-to-other-org control refused AUTH_STORAGE_NOT_OWNED)
- **kb:softDeleteDocument** `convex/kbMutations.ts:426-452 (called from convex/kb.ts:390-393)` — [MEDIUM] markDocSoftDeleted flips memories.isLatest but never schedules ragSync.markRagEntrySuperseded (memories:softDeleteMemory does, memories.ts:429), so the RAG entries keep filter isLatest='true' and recall / textSearch / hybridSearch keep returning the deleted document's text straight from the entry (search.ts:254-270 never re-reads memories); a requested delete leaves the content retrievable. supersedePriorChunks (re-ingest) has the same omission.  
  Fix: after patching each chunk schedule internal.ragSync.markRagEntrySuperseded{memoryId, content, namespace, type} (or delete the RAG entry) in markDocSoftDeleted and supersedePriorChunks.  
  Proof: **RED** `convex/__tests__/audit/kb.twoPoles.test.ts` — AssertionError: expected +0 to be 1 (markRagEntrySuperseded scheduled count delta; memories:softDeleteMemory control schedules 1)

### missionTemplates — 2

- **missionTemplates:instantiateTemplateIntoMission** `convex/missionTemplates.ts:521-531` — [M] step.assignedTo from the shared catalog is written without the roster check tasks:create applies to every assignee (tasks.ts:685), so a member can fan tasks assigned to a foreign or fleet orchestrator (with caller-chosen titlePrefix/context text) into its own mission, and the door has no writer-role gate while non-master createdBy defaults to the fleet word 'system'.  
  Fix: For non-master callers run requireOrchestratorOnRoster on every distinct step.assignedTo, require resolveHumanActor (writer role) when callerOrchestrator is absent, and never default createdBy to 'system' for a non-master.  
  Proof: **RED** `convex/__tests__/audit/missionTemplates.twoPoles.test.ts` — {ok:true, created:1} expected {ok:false, created:0} for both the foreign assignee omega and the non-writer viewer
- **mcp:update_mission_template** `mcp-server/src/tools.ts:9868-9883; convex/missionTemplates.ts:215-270` — A seat/person token can create or overwrite any shared mission template by name (the catalog is global, and every tenant instantiates from it): the master-only Convex gate is satisfied by the service account and the MCP only binds the typed createdBy.  
  Fix: Make the tool master-only (as soft_delete_mission_template is) or scope templates by org.  
  Proof: **RED** `mcp-server/test/audit/tasks.twoPoles.test.ts` — shared template step became 'EVIL'

### orgRoster — 2

- **orgRoster:getAgentDirectoryForAccessToken** `orgRoster.ts:118-143 (directory resolves in the token's own org only); orgRoster.ts:148-170` — A client org's roster lists fleet coordinators by name ('pi') but the agent is a row of the operator org; agentDirectoryOf looks the name up only in the client org, so the entry is {name:'pi',agentId:null} ('listed, not addressable') while sendMessage admits that same operator agent by ID (messages.ts:319-331). The rightful client agent cannot learn pi's ID from list_peers.  
  Fix: In agentDirectoryOf, when the org has no agent of the name, resolve operatorAgentForRosterName (operatorRosterAgents.ts:77) and return that agent's ID.  
  Proof: **RED** `convex/__tests__/audit/orgRoster.twoPoles.test.ts` — expected null to be operator pi agent id (ada control resolved)
- **orgRoster:getMyAgentDirectory** `orgRoster.ts:118-143; orgRoster.ts:175-208` — Same fault as getAgentDirectoryForAccessToken: a roster name that denotes an operator-org agent comes back with agentId null, so the caller cannot address it by ID.  
  Fix: Same: fall back to operatorAgentForRosterName for roster names with no agent in the caller's org.  
  Proof: **RED** `convex/__tests__/audit/orgRoster.twoPoles.test.ts` — expected null to be operator pi agent id (ada control resolved)

### stats — 2

- **stats:openTaskCountsByOrchestrator** `convex/stats.ts:405-456` — The visibility predicate is applied after the read: a member's call reads every tenant's tasks (full fleet scan, 16MB/time budget exposure) and the zero-fill leg is silently dead for members, so a rightful member never sees its idle orchestrators.  
  Fix: For a non-master scope query tasks via withIndex('by_orgId', q=>q.eq('orgId', scope.orgSlug)) and fold in zero rows from the org roster (scope.allowedOrchestrators), not from the global profiles table.  
  Proof: **RED** `convex/__tests__/audit/stats.twoPoles.test.ts` — expected [ alpha ] to deeply equal [ alpha, idle ] (own task counted, so door serves)
- **stats:fleetStats** `convex/stats.ts:545-589` — A scoped org member with view-stats-aggregated receives cross-tenant aggregate counts (every org's tasks, missions, messages and receipts) instead of its own org's, because the handler gates on the scope but never narrows by tenant.  
  Fix: For a non-master scope count through by_orgId_status / by_tenant indexes bound to scope.orgSlug (or refuse non-master with requireResolvedCaller masterOnly).  
  Proof: **RED** `convex/__tests__/audit/stats.twoPoles.test.ts` — expected 4 to be 1 (org-b tasks counted)

### agents — 1

- **agents:renameAgent** `agents.ts:420-440 (patch name; rosters not touched)` — Rosters store agent names, and roster membership decides addressing (messages.ts:317 isOrchestratorOnOrgRoster(reach,row.name)), the directory (orgRoster.ts:133) and legacy-receipt reads (inboxReader.ts:147-150 matches roster spellings to the NEW label): after a rename the agent is no longer on its org's roster, so it cannot be addressed by ID, drops out of list_peers with agentId null, and its legacy unread mail is stranded.  
  Fix: Rewrite the org's allowedOrchestrators entry (and addressableFleetCoordinators) in the same mutation, or make roster membership resolve through agent ID.  
  Proof: **RED** `convex/__tests__/audit/agents.twoPoles.test.ts` — renamed agent dropped out of the directory (roster not updated): expected undefined to be defined

### dashboard — 1

- **dashboard:getDashboardSummary** `convex/dashboard.ts:118-123` — A member org whose allowedOrchestrators contains a name that also exists as a fleet orchestrator (e.g. 'eta', 'pi') is served the fleet's profile row for that name (workspace path, capabilities, current task) because the tenant boundary is a string membership test on a table that has no tenant column.  
  Fix: Give profiles a tenant column (or a join table) and read through a by-tenant index, or return no profiles to a non-master scope until it exists; bound the read instead of collect().  
  Proof: **RED** `convex/__tests__/audit/dashboard.twoPoles.test.ts` — expected [ {fleet eta profile} ] to deeply equal []

### fixPatterns — 1

- **mcp:add_fix_attempt** `mcp-server/src/tools.ts:9408-9421; convex/fixPatterns.ts:86-135` — A seat/person token appends attempts (including 'worked' flags and commit refs) to ANY fix pattern by id, including fleet-owned ones: the pattern is not compared to the caller and the master-only Convex gate is satisfied by the service account.  
  Fix: Require pattern.createdBy ∈ fromAllowList at the MCP (or make the tool master-only like validate_fix).  
  Proof: **RED** `mcp-server/test/audit/knowledge.twoPoles.test.ts` — AssertionError: expected { refused: false, attempts: 1 } to equal { refused: true, attempts: 0 }

### githubOwnerBinding — 1

- **mcp:get_github_owner_bindings** `mcp-server/src/tools.ts:8822-8836; convex/githubOwnerBinding.ts:145-168` — A seat/person token reads EVERY organisation's GitHub-owner bindings (owner, orgId, bound-by): the MCP calls githubOwnerBinding:listBindings as the service account, whose master branch paginates the whole table; the tool's own comment promises 'your organisation' only.  
  Fix: Forward verifiedOrg (or pass the org to listBindings) and refuse the all-orgs branch for non-master callers.  
  Proof: **RED** `mcp-server/test/audit/registry.twoPoles.test.ts` — expected output not to contain org-b

### iframeEmbedSessions — 1

- **iframeEmbedSessions:createSession** `convex/iframeEmbedSessions.ts:87` — sessionId is caller-chosen and never checked for uniqueness, so a member of org B who knows or guesses org A's sessionId can insert a second row with it; getSession (:126), touchSession (:191) and revokeSession (:227) all use .unique() and then throw for both tenants, so org A can no longer read, touch or revoke its own session (userId is likewise stored as claimed, not taken from the verified identity).  
  Fix: Refuse a sessionId that already has a row (query by_session_id before insert) or generate it server-side, and set userId from identity.subject.  
  Proof: **RED** `convex/__tests__/audit/iframeEmbedSessions.twoPoles.test.ts` — AssertionError: org B's second insert of sessionId S1: promise resolved instead of rejecting

### memoriesScoped — 1

- **memoriesScoped:storeMemoryScoped** `convex/memoriesScoped.ts:183-194` — [LOW] createdBy is stored as sent (185), same attribution forgery as memories:storeMemory; the door is public although its header says it is used only by the test suite.  
  Fix: stamp the verified actor for non-master scopes (or require roster + agent credential), or remove the public registration if only tests use it.  
  Proof: **RED** `convex/__tests__/audit/memoriesScoped.twoPoles.test.ts` — AssertionError: expected [ 'system' ] to not include 'system'

### orgMembership — 1

- **orgMembership:getMembership** `orgMembership.ts:154-170` — Low severity: the service account (every MCP seat) lists the Clerk user IDs and roles of any organisation by slug with no claim, and any ordinary member (not just an org:admin) lists all members of its own org; MCP exposure of this door was not traced.  
  Fix: Restrict the slug form to org:admin of that org or the operator-admin, and require a verifiedOrg claim for the service account.  
  Proof: **RED** `convex/__tests__/audit/orgMembership.twoPoles.test.ts` — expected 1 to be +0 (member served member list); expected false to be true (service account not refused)

## Door table

| door | module | caller identity | by ID? | identity local | poles tested | verdict |
|---|---|---|---|---|---|---|
| agentCredentials:getAgentCredentialStatus | agentCredentials | Clerk session: verified org:admin of args.orgSlug (requireOrgAdmin) | name | True | none located (no status assertion in agentCredentials.test.ts or closeDoorsCreds.test.ts) | safe |
| agentCredentials:mintAgentCredential | agentCredentials | Clerk session: verified org:admin of args.orgSlug (requireOrgAdmin convex/lib/auth.ts:691- | name | True | agentCredentials.test.ts:79-313 allow (org:admin mints, secret resolves) + deny (same-org  | safe |
| agentCredentials:resolveAgentCredential | agentCredentials | fleet service account only: withOrgScope + requireResolvedCaller(masterOnly, mcpBoundOnly) | id | True | closeDoorsCreds.test.ts:92-158 both: deny (anonymous, acme admin, rival admin holding a VA | safe |
| agentCredentials:revokeAgentCredential | agentCredentials | Clerk session: verified org:admin of args.orgSlug (requireOrgAdmin, no master carve-out) | name | True | none located: no revoke assertion in agentCredentials.test.ts or closeDoorsCreds.test.ts;  | safe |
| agentRelations:childrenOf | agentRelations | requireOrgAdmin | n/a | True | none located (files not enumerable) | safe |
| agentRelations:graphByOrg | agentRelations | requireOrgAdmin | n/a | True | none located (files not enumerable) | safe |
| agentRelations:linkChild | agentRelations | Clerk org:admin verified by requireOrgAdmin (org slug from the token claim == args.orgSlug | n/a | True | none located for agentRelations (callers are convex/__tests__ only per door comment; files | safe |
| agentRelations:parentsOf | agentRelations | requireOrgAdmin | n/a | True | none located (files not enumerable) | safe |
| agentRelations:unlinkChild | agentRelations | requireOrgAdmin (verified org:admin of args.orgSlug) | n/a | True | none located (files not enumerable) | safe |
| agents:deactivateAgent | agents | requireOrgAdmin | name | True | none in agentsEntity.test.ts (other files not enumerable) | safe |
| agents:getAgent | agents | requireOrgAdmin | name | True | agentsEntity.test.ts: ALLOW admin of A reads own agent; DENY org B admin refused (RBAC_DEN | safe |
| agents:listAgentsByOrg | agents | requireOrgAdmin | n/a | True | agentsEntity.test.ts: ALLOW admin of A lists own; DENY admin of B refused for A's slug; po | safe |
| agents:reactivateAgent | agents | requireOrgAdmin | name | True | none in agentsEntity.test.ts (other files not enumerable) | safe |
| agents:registerAgent | agents | Clerk org:admin via requireOrgAdmin (org slug claim == args.orgSlug, role admin, active ma | name | True | agentsEntity.test.ts (read): ALLOW org:admin of A, DENY non-admin of A, DENY anonymous, MA | safe |
| agents:renameAgent | agents | requireOrgAdmin | name | True | none in agentsEntity.test.ts (other files not enumerable); roster-after-rename pole: none  | defect |
| agents:setAgentAddress | agents | requireOrgAdmin | name | True | agentsEntity.test.ts: allow pole only (admin sets and reads back); deny pole for setAgentA | safe |
| briefingNotes:create | briefingNotes | mutation: withOrgScope (auth.ts:158) fail-closed; org from verified scope only (briefingNo | id | True | could-not-judge: none found for the create door (briefingNotesReadScope.test.ts covers rea | safe |
| briefingNotes:deleteBriefingNote | briefingNotes | mutation: withOrgScope resolved before the db.get (764); tenant via isOrgAllowedForScope(n | name (callerOrchestrator string vs stored createdBy) | True | none found for delete (briefingNotesReadScope.test.ts is read-only); could-not-judge: no s | defect |
| briefingNotes:get | briefingNotes | query: withOrgScope(refuseWithoutThrow) (auth.ts:158); anonymous raises RBAC_DENIED, signe | id | True | both: convex/__tests__/briefingNotesReadScope.test.ts:192-264 (ordinary org-a member: cann | safe |
| briefingNotes:list | briefingNotes | query: withOrgScope(refuseWithoutThrow); anonymous raises RBAC_DENIED, signed-in-no-org ge | id | True | both for tenant scoping: briefingNotesReadScope.test.ts:267-334 (org-a list excludes org-b | defect |
| briefingNotes:searchBriefingNotesByKeyword | briefingNotes | query: withOrgScope(refuseWithoutThrow) then requireScope(scope,'view-own-tasks') (942-946 | id | True | none found for this door (briefingNotesReadScope.test.ts covers get/list only); could-not- | safe |
| briefingNotes:update | briefingNotes | mutation: withOrgScope resolved before the db.get (854); tenant via isOrgAllowedForScope ( | name (callerOrchestrator string vs stored createdBy) | True | none found for update; could-not-judge: no search tool in this session | defect |
| businessUnits:create | businessUnits | withOrgScope: service account master (any orchestratorId, row unstamped = fleet-owned); Cl | name | True | publicRegistrationResolvesCaller.test.ts seeds BUs for list only; create deny/allow poles: | defect |
| businessUnits:get | businessUnits | withOrgScope refuseWithoutThrow; master all; member by roster string match on bu.orchestra | name | True | publicRegistrationResolvesCaller.test.ts (opened header only for BU list: anonymous/no-org | defect |
| businessUnits:list | businessUnits | withOrgScope refuseWithoutThrow; master all; member per-row roster string match | name | True | publicRegistrationResolvesCaller.test.ts (opened): ordinary-member allow pole and anonymou | defect |
| businessUnits:remove | businessUnits | withOrgScope master only (service account) | id | True | none located (files not enumerable) | defect |
| businessUnits:update | businessUnits | withOrgScope; callerOrchestrator is a required unverified string compared with bu.orchestr | name | True | none located for update (files not enumerable) | defect |
| clientOrgMapping:getByClerkSlug | clientOrgMapping | withOrgScope isMaster (service account, or operator-admin human in a query ctx); orgSlug a | n/a | True | none located (files not enumerable) | safe |
| dashboard:getDashboardSummary | dashboard | withOrgScope refuseWithoutThrow + requireResolvedCaller(alsoRefusePreOrg) + requireScope v | name | True | could-not-judge: no test file located (guessed convex/__tests__/dashboard.test.ts does not | defect |
| dashboard:getProjectSummary | dashboard | withOrgScope refuseWithoutThrow; requireResolvedCaller (anonymous raises); pre-org gets ty | n/a | True | could-not-judge: no test file located | safe |
| diary:deleteDiary | diary | mutation: withOrgScope before the get (416-427); sameTenantStamp (434-441); roster check ( | name (callerOrchestrator vs entry.orchestrator; intra-org only, tenant stamp is id-derived | True | none found; could-not-judge: no search tool in this session | safe |
| diary:get | diary | query: withOrgScope(refuseWithoutThrow) + requireResolvedCaller(alsoRefusePreOrg) (232-233 | name (orchestrator on roster) within an id-derived tenant range | True | none found; could-not-judge: no search tool in this session | safe |
| diary:list | diary | query: withOrgScope(refuseWithoutThrow) + requireResolvedCaller (316); anonymous raises, n | name within an id-derived tenant range | True | none found; could-not-judge: no search tool in this session (multiTenantIsolation.test.ts  | safe |
| diary:listByDateRange | diary | query: withOrgScope(refuseWithoutThrow) + requireResolvedCaller(alsoRefusePreOrg) (501-504 | name within an id-derived tenant range | True | none found; could-not-judge: no search tool in this session | safe |
| diary:write | diary | mutation: withOrgScope (141); orchestrator checked against scope.allowedOrchestrators.incl | name (orchestrator on roster) and arg (createdBy) | True | none found; could-not-judge: no search tool in this session | defect |
| episodes:getCriticalInsights | episodes | query: withOrgScope(refuseWithoutThrow) (223); per-row isNamespaceAllowedForScope filter i | id | True | both for the result: anonymousCallerServedTenantRows.test.ts:230-283 (org-a sees only org- | defect |
| episodes:listEpisodes | episodes | query: withOrgScope(refuseWithoutThrow) + isNamespaceAllowedForScope before the read (149- | id | True | both: anonymousCallerServedTenantRows.test.ts:172-222 (ordinary org-a member: cannot read  | safe |
| episodes:storeEpisode | episodes | mutation: withOrgScope + isNamespaceAllowedForScope (54-59); createdBy is not bound to the | id for namespace; arg for createdBy | True | none found for the write (anonymousCallerServedTenantRows.test.ts covers episodes reads on | defect |
| errorMonitor:addDeployment | errorMonitor | service-account master by subject (CLERK_SERVICE_ACCOUNT_USER_ID, lib/auth.ts:218-233) via | n/a | True | could-not-judge: no test file located (guessed convex/__tests__/errorMonitor.test.ts does  | safe |
| errorMonitor:getError | errorMonitor | requireResolvedCaller masterOnly before any read (lib/auth.ts:1359-1365); id then normalis | id | True | could-not-judge: no test file located | safe |
| errorMonitor:listDeployments | errorMonitor | withOrgScope refuseWithoutThrow + requireResolvedCaller masterOnly (lib/auth.ts:1301-1366) | n/a | True | could-not-judge: no test file located | safe |
| errorMonitor:listErrors | errorMonitor | withOrgScope + requireResolvedCaller(alsoRefusePreOrg) then isMaster test; anonymous/pre-o | n/a | True | could-not-judge: no test file located | safe |
| errorMonitor:removeDeployment | errorMonitor | service-account master via requireMasterScope (errorMonitor.ts:35-43); same MCP-layer cave | n/a | True | could-not-judge: no test file located (see addDeployment) | safe |
| fixPatterns:addAttempt | fixPatterns | mutation: requireFleetMaster (98) | id | True | none found; could-not-judge: no search tool in this session | safe |
| fixPatterns:create | fixPatterns | mutation: requireFleetMaster -> withOrgScope, scope.isMaster only (20-30); a mutation ctx  | id | True | none found; could-not-judge: no search tool in this session | safe |
| fixPatterns:get | fixPatterns | query: withOrgScope(refuseWithoutThrow) + requireResolvedCaller(alsoRefusePreOrg, masterOn | id | True | master allow only via searchNamespaceAuthorityEndToEnd.test.ts:409-422 (hydration as servi | safe |
| fixPatterns:linkIssue | fixPatterns | mutation: requireFleetMaster (181) | id | True | none found; could-not-judge: no search tool in this session | safe |
| fixPatterns:listAll | fixPatterns | query: requireResolvedCaller(alsoRefusePreOrg) then if (!scope.isMaster) return [] (413-41 | id | True | none found; could-not-judge: no search tool in this session | safe |
| fixPatterns:listByProject | fixPatterns | query: requireResolvedCaller(alsoRefusePreOrg, masterOnly) (330-334) | id | True | none found; could-not-judge: no search tool in this session | safe |
| fixPatterns:listByStack | fixPatterns | query: requireResolvedCaller(alsoRefusePreOrg, masterOnly) (471-474) | id | True | none found; could-not-judge: no search tool in this session | safe |
| fixPatterns:validate | fixPatterns | mutation: requireFleetMaster (146) | id | True | none found; could-not-judge: no search tool in this session | safe |
| githubOwnerBinding:listBindings | githubOwnerBinding | withOrgScope refuseWithoutThrow + requireResolvedCaller(alsoRefusePreOrg); org taken from  | id | True | both poles under scoped members: convex/__tests__/githubOwnerBinding.test.ts:212-219 (org- | safe |
| githubOwnerBinding:listUnprovenMappings | githubOwnerBinding | requireResolvedCaller masterOnly before the scan | n/a | True | both poles: githubOwnerBinding.test.ts:192-210 (master allowed, org-a member denied RBAC_D | safe |
| githubRepoMapping:add | githubRepoMapping | withOrgScope; tenant derived only from verified scope (resolveWriteTenant :47-56, scope ma | id | True | both poles under scoped members: githubOwnerBinding.test.ts:86-152 (own owner allowed incl | safe |
| githubRepoMapping:getByRepo | githubRepoMapping | withOrgScope refuseWithoutThrow + requireResolvedCaller(alsoRefusePreOrg); ownership by st | name | True | could-not-judge: githubOwnerBinding.test.ts does not call getByRepo; no dedicated file loc | safe |
| githubRepoMapping:list | githubRepoMapping | withOrgScope + requireResolvedCaller(alsoRefusePreOrg); org from verified scope | id | True | could-not-judge: no test file located for list (githubOwnerBinding.test.ts does not call i | safe |
| githubRepoMapping:remove | githubRepoMapping | withOrgScope; resolveWriteTenant (scope manage-repo-mappings, org required); requireRowOwn | name | True | could-not-judge: githubOwnerBinding.test.ts does not call remove; no dedicated test locate | safe |
| http:OPTIONS /issueBearerFromClerk | http | none (CORS preflight); same handler returns 204 before any body parse (credentials.ts:403- | n/a | True | none located | safe |
| http:POST /api/eta/verify-publish-token | http | fleet master bearer BEARER_SECRET_MASTER in the Authorization header, constant-time compar | arg | True | none located (no test file found by name; no search tool this session) | defect |
| http:POST /api/gumroad-webhook | http | webhook signature: HMAC-SHA256 hex of the raw body vs X-Gumroad-Signature with GUMROAD_WEB | arg | True | gumroadWebhook.test.ts (header, first 40 lines read): EN and FR happy path, invalid signat | safe |
| http:POST /github/webhook | http | webhook signature: HMAC-SHA256 of the raw body vs x-hub-signature-256 with GITHUB_WEBHOOK_ | name | True | none located (no webhook test file found by name; no search tool this session) | safe |
| http:POST /issueBearerFromClerk | http | Clerk JWT in the body, verified by manual JWKS (credentials.ts:135-233: exp/nbf/iat, iss,  | arg | True | none located (credentials test file not found by name; handler exposes a _verifyJwt inject | defect |
| iframeEmbedSessions:createSession | iframeEmbedSessions | Clerk session resolved by withOrgScope (iframeEmbedSessions.ts:64): member of an active or | arg | True | none located (no iframeEmbedSessions test file found by name; no search tool this session) | defect |
| iframeEmbedSessions:getSession | iframeEmbedSessions | withOrgScope(refuseWithoutThrow) iframeEmbedSessions.ts:164: returns the row only when isT | arg | True | none located | safe |
| iframeEmbedSessions:revokeSession | iframeEmbedSessions | withOrgScope (throws for anonymous/org-less); stored tenantId must equal the caller's orgS | arg | True | none located | safe |
| iframeEmbedSessions:touchSession | iframeEmbedSessions | withOrgScope (throws for anonymous/org-less); stored tenantId must equal the caller's orgS | arg | True | none located | safe |
| improvisationDigest:scanWindow | improvisationDigest | query: withOrgScope(refuseWithoutThrow) (72); anonymous / no-org -> typed-empty digest (74 | id | True | none found; could-not-judge: no search tool in this session | safe |
| issueStatsQueries:getLatest | issueStatsQueries | withOrgScope + requireResolvedCaller(alsoRefusePreOrg) then isMaster test; org member gets | n/a | True | could-not-judge: no test file located | safe |
| issues:getByRepoNumber | issues | requireResolvedCaller masterOnly before the read | name | True | could-not-judge: no test file located | safe |
| issues:getStats | issues | requireResolvedCaller masterOnly (members RAISE rather than receive fabricated zeros) | arg | True | could-not-judge: no test file located | safe |
| issues:linkCommit | issues | requireMasterScope (issues.ts:32-40) | name | True | could-not-judge: no test file located | safe |
| issues:listByOrchestrator | issues | requireResolvedCaller masterOnly before the read | arg | True | could-not-judge: no test file located | safe |
| issues:listByProject | issues | requireResolvedCaller masterOnly before the read | arg | True | could-not-judge: no test file located | safe |
| issues:listByStatus | issues | requireResolvedCaller masterOnly before the read | arg | True | could-not-judge: no test file located | safe |
| issues:listExternalOpen | issues | requireResolvedCaller(alsoRefusePreOrg); non-master resolved member gets an empty envelope | n/a | True | could-not-judge: no test file located | safe |
| issues:updateStatus | issues | service-account master via local requireMasterScope (issues.ts:32-40); mutation ctx so ope | name | True | could-not-judge: no test file located (guessed convex/__tests__/issues.test.ts does not ex | safe |
| issues:verify | issues | requireMasterScope (issues.ts:32-40); verifiedBy is a free argument but only the master ca | name | True | could-not-judge: no test file located | safe |
| kb:softDeleteDocument | kb | action: assertOrgArgs, resolveKbCaller (resolveOrgScopeForAction + requireResolvedCaller), | id | True | both for caller resolution: closeDoorsKb.test.ts:199-269 and anonymousCallerServedTenantRo | defect |
| kb:storeDocumentChunked | kb | action: shape check assertOrgArgs then resolveKbCaller -> resolveOrgScopeForAction + requi | id for org; the storageId binding is first-claim (TOFU) | True | both for caller resolution: closeDoorsKb.test.ts:136-197 (anonymous, no-org, org-a into or | defect |
| kbMutations:claimUpload | kbMutations | mutation: withOrgScope + requireResolvedCaller(alsoRefusePreOrg) (340-343); ticket looked  | id | True | none found; could-not-judge: no search tool in this session | safe |
| kbMutations:generateUploadUrl | kbMutations | mutation: withOrgScope (212); non-master needs args.orgId === scope.orgSlug (218-222); ass | id | True | none found; could-not-judge: no search tool in this session | safe |
| kbMutations:generateUploadUrlWithTicket | kbMutations | mutation: withOrgScope (293); non-master needs args.orgId === scope.orgSlug (299-303); tic | id | True | none found; could-not-judge: no search tool in this session | safe |
| licenses:activate | licenses | none by design: possession of the license key (sha256 matched to one row via by_keyHash) p | arg | True | both: closeDoorsCreds.test.ts:201-243 deny (unknown key, wrong email, revoked, oversize al | safe |
| licenses:validate | licenses | none by design: possession of the license key (sha256 via by_keyHash) | arg | True | both: closeDoorsCreds.test.ts:171-199 present, absent, oversize | safe |
| mandates:accept | mandates | master only (requireFleetMaster); ownership decided by callerOrchestrator, an unverified a | name | True | none found (mandates.test.ts absent in convex/ and convex/__tests__/); could-not-judge: no | defect |
| mandates:create | mandates | master only: requireFleetMaster -> withOrgScope isMaster (mandates.ts:26-37); requestedBy/ | arg | True | none found (probed convex/__tests__/mandates.test.ts, convex/mandates.test.ts: absent); co | defect |
| mandates:get | mandates | withOrgScope + requireResolvedCaller(masterOnly): raises for anonymous and for every non-m | id | True | none found (list only covered in publicRegistrationResolvesCaller.test.ts); could-not-judg | safe |
| mandates:list | mandates | withOrgScope(refuseWithoutThrow) + requireResolvedCaller: anonymous raises RBAC_DENIED; si | n/a | True | both: deny = anonymous, no-org, ordinary active-org member; allow = master only because no | safe |
| mandates:settle | mandates | master only (requireFleetMaster); requestedBy ownership decided by asserted callerOrchestr | name | True | none found; could-not-judge: no grep/ls | defect |
| mandates:update | mandates | master only (requireFleetMaster); fulfilledBy ownership decided by asserted callerOrchestr | name | True | none found; could-not-judge: no grep/ls | defect |
| mandates:validateSpending | mandates | withOrgScope + requireResolvedCaller(masterOnly) | id | True | none found; could-not-judge: no grep/ls | safe |
| mcp:accept_mandate | mandates | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | oauth-scoped.test.ts (accept: predicate level deny only) | safe |
| mcp:add_deployment | errorMonitor | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | test/c0-1-admin-deploy-gate.test.ts | safe |
| mcp:add_fix_attempt | fixPatterns | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | fix-pattern-tools-validation.test.ts (validation only); cross-owner deny: none | defect |
| mcp:add_repo_mapping | githubRepoMapping | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | arg | True | test/c0-3-bu-repo-gate.test.ts asserts the scoped bearer is NOT refused at the MCP layer a | defect |
| mcp:add_task_dependency | tasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | deny only at MCP: task-doors-unresolved-org.tool.test.ts; org-a/org-b row poles not assert | safe |
| mcp:billing_summary_by_project | tasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | src/__tests__/billing_summary_by_project.tool.test.ts (master path); non-master deny via w | safe |
| mcp:block_task | tasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | both, scoped identity: src/__tests__/task-doors-verified-org.tool.test.ts (convex-test as  | safe |
| mcp:bulk_complete_tasks | tasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | src/__tests__/bulk-complete-tasks-scope-guard.test.ts (callerOrchestrator spoof deny + own | safe |
| mcp:check_messages | messages | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | both: test/inbox-doors-verified-reader.test.ts, test/inbox-tools-claims.test.ts, test/inbo | safe |
| mcp:checkout_task | tasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | both, scoped identity: src/__tests__/task-doors-verified-org.tool.test.ts (convex-test as  | safe |
| mcp:claim_upload | kbMutations | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | kb-upload-claim-deploy-skew.test.ts, person-token-writer-role.test.ts | safe |
| mcp:complete_task | tasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | both, scoped identity: src/__tests__/task-doors-verified-org.tool.test.ts (convex-test as  | safe |
| mcp:correct_task_segment | tasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | both, scoped identity: src/__tests__/task-doors-verified-org.tool.test.ts (convex-test as  | safe |
| mcp:create_briefing_note | briefingNotes | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | briefing-note-size-guard.test.ts, person-token-writer-role.test.ts; tenant stamp: none | defect |
| mcp:create_bu | businessUnits | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | oauth-scoped.test.ts (predicate level deny 'sigma') | defect |
| mcp:create_fix_pattern | fixPatterns | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | oauth-scoped.test.ts (predicate deny 'tau'), fix-pattern-tools-validation.test.ts | safe |
| mcp:create_mandate | mandates | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | oauth-scoped.test.ts (predicate level: deny fulfilledBy 'pi'); no handler-vs-backend test | safe |
| mcp:create_mission | missions | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | actor-from-credential.test.ts, person-writes-own-name.test.ts, acting-name-split-sweep.tes | defect |
| mcp:create_recurring_task | recurringTasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | delegation-same-org-predicate.test.ts (allow same-org assignee / deny foreign), person-tok | defect |
| mcp:create_task | tasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | oauth-scoped.test.ts (predicate level), test/delegation-same-org-predicate.test.ts (both p | defect |
| mcp:delete_bu | businessUnits | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | test/c0-3-bu-repo-gate.test.ts (non-master denied, master allowed, absent ctx refused) | safe |
| mcp:delete_message | messages | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | test/inbox-doors-verified-reader.test.ts, test/inbox-doors-consumer-wire.test.ts, test/inb | safe |
| mcp:delete_recurring_task | recurringTasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | test/c0-6-recurring-gate.test.ts (non-master denied, master allowed, absent ctx refused) | safe |
| mcp:delete_task | tasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | both, scoped identity: src/__tests__/task-doors-verified-org.tool.test.ts (convex-test as  | safe |
| mcp:export_okf_bundle | okfBundleNode | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | src/tools/__tests__/exportOkfBundle.test.ts (registration/forwarding only); scoped allow/d | safe |
| mcp:fail_task | tasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | both, scoped identity: src/__tests__/task-doors-verified-org.tool.test.ts (convex-test as  | safe |
| mcp:generate_upload_url | kbMutations | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | kb-upload-claim-deploy-skew.test.ts, person-token-writer-role.test.ts | safe |
| mcp:get_briefing_note | briefingNotes | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | both (mocked rows, distinct names): src/__tests__/get-briefing-note-scope-aware.test.ts, g | defect |
| mcp:get_bu | businessUnits | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | both (mocked, distinct names): src/__tests__/list-bus-cross-tenant-scope.test.ts, scope-aw | defect |
| mcp:get_bulk_complete_run | tasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | both: src/__tests__/get_bulk_complete_run.tool.test.ts (OWN / REFUSED other org / other cr | safe |
| mcp:get_diary | diary | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | scope-aware-filter-wave-c1/c2.test.ts (mocked rows) | defect |
| mcp:get_episode | memories | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | stdio-http-parity.test.ts (registration/parity only): allow/deny not asserted | safe |
| mcp:get_error | errorMonitor | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | test/list-errors-master-only.test.ts, master-guard-absence-refuses.test.ts | safe |
| mcp:get_fix_pattern | fixPatterns | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | none | safe |
| mcp:get_github_owner_bindings | githubOwnerBinding | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | arg | False | none | defect |
| mcp:get_issue | issues | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | test/list-issues-master-only.test.ts / c0-5-issue-gate.test.ts (non-master denied, master  | safe |
| mcp:get_mandate | mandates | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | both (mocked): list-mandates-cross-tenant-scope.test.ts, grant-aware-scope-filter-missions | safe |
| mcp:get_memory | memories | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | scope-aware-filter.test.ts, scope-aware-filter-wave-c1/c2/c3.test.ts (both poles with mock | safe |
| mcp:get_message | messages | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | both at the MCP filter only (mocked Convex rows with distinct names, no same-name cross-or | defect |
| mcp:get_mission | missions | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | src/__tests__/grant-aware-scope-filter-missions-mandates.test.ts, scope-aware-filter-wave- | defect |
| mcp:get_mission_template | missionTemplates | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | scope-aware-filter-wave-c3.test.ts | safe |
| mcp:get_profile | profiles | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | both (mocked rows, distinct names alpha/beta): src/__tests__/profiles-cross-tenant-scope.t | safe |
| mcp:get_recurring_task | recurringTasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | stdio-http-parity.test.ts (parity only) | defect |
| mcp:get_repo_mapping | githubRepoMapping | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | both (mocked): src/__tests__/repo-mapping-cross-tenant-scope.test.ts | defect |
| mcp:get_task | tasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | none for the tenant dimension (get_task appears in fail_task.tool.test.ts etc. as a read h | defect |
| mcp:hybrid_search | search | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | oauth-scoped.test.ts (predicate level: allow + deny incl. namespace=undefined); handler no | safe |
| mcp:import_okf_bundle | okfBundleNode | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | arg | True | none (importOkfBundle.test absent; wrapper test covers export only) | defect |
| mcp:improvisation_digest | improvisationDigest | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | src/__tests__/improvisation_digest.tool.test.ts | safe |
| mcp:instantiate_template_into_mission | missions | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | scope-aware-filter-wave-c3.test.ts (mocked rows) | defect |
| mcp:issue_stats | issues | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | test/list-issues-master-only.test.ts / c0-5-issue-gate.test.ts (non-master denied, master  | safe |
| mcp:link_commit_to_issue | issues | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | test/list-issues-master-only.test.ts / c0-5-issue-gate.test.ts (non-master denied, master  | safe |
| mcp:link_issue_to_pattern | fixPatterns | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | fix-pattern-tools-validation.test.ts, c0-5-issue-gate.test.ts | safe |
| mcp:list_briefing_notes | briefingNotes | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | both (mocked rows, distinct names): src/__tests__/get-briefing-note-scope-aware.test.ts, g | defect |
| mcp:list_broadcast_status | messages | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | both at the MCP filter only (mocked Convex rows with distinct names, no same-name cross-or | defect |
| mcp:list_bus | businessUnits | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | both (mocked): src/__tests__/list-bus-cross-tenant-scope.test.ts, list_bus.tool.test.ts | defect |
| mcp:list_diaries | diary | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | arg | True | src/__tests__/list-diaries-scope-guard-v2.4.8.test.ts (STATIC source parse: deny undefined | defect |
| mcp:list_episodes | memories | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | list_memories_episodes_pagination.test.ts (pagination); scope allow/deny not asserted for  | safe |
| mcp:list_errors | errorMonitor | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | test/list-errors-master-only.test.ts, master-guard-absence-refuses.test.ts | safe |
| mcp:list_fix_patterns | fixPatterns | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | scope-aware-filter-wave-c3.test.ts, list-tools-cursor-paging-followup-batch-2.test.ts | safe |
| mcp:list_issues | issues | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | test/list-issues-master-only.test.ts / c0-5-issue-gate.test.ts (non-master denied, master  | safe |
| mcp:list_mandates | mandates | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | both (mocked): src/__tests__/list-mandates-cross-tenant-scope.test.ts, grant-aware-scope-f | safe |
| mcp:list_memories | memories | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | list_memories_episodes_pagination.test.ts, scope-aware-filter.test.ts, scope-aware-filter- | safe |
| mcp:list_messages | messages | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | both at the MCP filter only (mocked Convex rows with distinct names, no same-name cross-or | defect |
| mcp:list_missions | missions | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | arg | True | none for the non-master pilot===userId path (list-queries tests use master); scope-guard-c | defect |
| mcp:list_peers | orgRoster | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | False | both: test list-peers-org-roster.test.ts (real handler, mocked Convex), profiles-cross-ten | safe |
| mcp:list_recurring_tasks | recurringTasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | scope-aware-filter-wave-c2.test.ts (mocked rows) | defect |
| mcp:list_repo_mappings | githubRepoMapping | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | both (mocked, distinct names): src/__tests__/repo-mapping-cross-tenant-scope.test.ts, list | defect |
| mcp:list_tasks | tasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | both: test/guard-filtered-doors-list-tasks-update-recurring.test.ts, src/__tests__/list_ta | defect |
| mcp:list_tasks_by_mission | tasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | src/__tests__/grant-aware-scope-filter-missions-mandates.test.ts, scope-aware-filter-wave- | defect |
| mcp:mark_as_read | messages | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | both: src/__tests__/mark-as-read-scope-guard.test.ts, test/inbox-doors-verified-reader.tes | safe |
| mcp:pause_recurring_task | recurringTasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | test/c0-6-recurring-gate.test.ts (non-master denied, master allowed, absent ctx refused) | safe |
| mcp:pause_task | tasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | both, scoped identity: src/__tests__/task-doors-verified-org.tool.test.ts (convex-test as  | safe |
| mcp:recall | search | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | oauth-scoped.test.ts (predicate level: allow + deny incl. namespace=undefined); handler no | safe |
| mcp:remove_deployment | errorMonitor | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | test/c0-1-admin-deploy-gate.test.ts | safe |
| mcp:remove_repo_mapping | githubRepoMapping | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | arg | True | test/c0-3-bu-repo-gate.test.ts (mock backend; scoped bearer not refused at MCP); cross-org | defect |
| mcp:resume_recurring_task | recurringTasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | test/c0-6-recurring-gate.test.ts (non-master denied, master allowed, absent ctx refused) | safe |
| mcp:resume_task | tasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | both, scoped identity: src/__tests__/task-doors-verified-org.tool.test.ts (convex-test as  | safe |
| mcp:search_briefing_notes_by_keyword | briefingNotes | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | both (mocked rows, distinct names): src/__tests__/get-briefing-note-scope-aware.test.ts, g | defect |
| mcp:search_episodes_by_keyword | search | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | oauth-scoped.test.ts (predicate level, both poles incl. 'bu-m cannot read orchestrator/ta | safe |
| mcp:search_episodes_by_semantic | search | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | oauth-scoped.test.ts (predicate level, both poles incl. 'bu-m cannot read orchestrator/ta | safe |
| mcp:search_fix_patterns | search | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | scope-aware-filter-wave-c3.test.ts (mocked rows) | safe |
| mcp:search_messages_by_keyword | messages | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | False | both at the MCP filter only (mocked Convex rows with distinct names, no same-name cross-or | defect |
| mcp:search_tasks_by_keyword | tasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | src/__tests__/search-tasks-cross-tenant-scope.test.ts (owner + deny, mocked rows, distinct | defect |
| mcp:send_message | messages | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | both: src/__tests__/send-message-sender-binding.test.ts, test/send-message-seat-org.test.t | defect |
| mcp:set_summary | profiles | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | oauth-scoped.test.ts: predicate-level allow ('bu-m' own name); set-summary-unknown-param- | safe |
| mcp:settle_mandate | mandates | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | none | safe |
| mcp:soft_delete_document | kb | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | kb-ingest-e2e.test.ts (happy path); cross-org deny: none | safe |
| mcp:soft_delete_memory | memories | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | master-guard-absence-refuses.test.ts (absent ctx refused), scope-aware-filter-wave-c3.test | safe |
| mcp:soft_delete_mission_template | missionTemplates | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | none | safe |
| mcp:start_task | tasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | both, scoped identity: src/__tests__/task-doors-verified-org.tool.test.ts (convex-test as  | safe |
| mcp:store_document_chunked | kb | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | none beyond kb-ingest-e2e.test.ts (happy path); cross-org deny: none | safe |
| mcp:store_episode | episodes | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | none (no test names store_episode) | safe |
| mcp:store_memory | memories | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | oauth-scoped.test.ts asserts the predicates, not the handler against a backend; mcp-route- | defect |
| mcp:text_search | search | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | oauth-scoped.test.ts (predicate level: allow + deny incl. namespace=undefined); handler no | safe |
| mcp:update_briefing_note | briefingNotes | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | convex-error-propagation.test.ts, briefing-note-size-guard.test.ts, scope-aware-filter-wav | defect |
| mcp:update_bu | businessUnits | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | acting-name-split-sweep.test.ts, actor-from-credential.test.ts; cross-org deny: none | defect |
| mcp:update_issue_status | issues | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | test/list-issues-master-only.test.ts / c0-5-issue-gate.test.ts (non-master denied, master  | safe |
| mcp:update_mandate | mandates | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | none | safe |
| mcp:update_mission | missions | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | actor-from-credential.test.ts, person-writes-own-name.test.ts, acting-name-split-sweep.tes | defect |
| mcp:update_mission_status | missions | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | test/c0-4-mission-status-gate.test.ts (non-master denied, master allowed, absent ctx refus | safe |
| mcp:update_mission_template | missionTemplates | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | none | defect |
| mcp:update_profile | profiles | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | oauth-scoped.test.ts: predicate-level deny ('p-v' from bu-m) and allow for set_summary | safe |
| mcp:update_recurring_task | recurringTasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | both (mocked): test/guard-filtered-doors-list-tasks-update-recurring.test.ts, delegation-s | defect |
| mcp:update_task | tasks | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | id | True | both, scoped identity: src/__tests__/task-doors-verified-org.tool.test.ts (convex-test as  | safe |
| mcp:validate_fix | fixPatterns | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | fix-pattern-tools-validation.test.ts, c0-5-issue-gate.test.ts | safe |
| mcp:validate_mandate_spending | mandates | kind public (reason: 'keyed on a caller-supplied mandateId; no cross-tenant enumeration'); | arg | True | none | defect |
| mcp:validate_okf_bundle | okfBundleNode | kind public with ctx {} (no auth context passed to defineTool, validateOkfBundle.ts:79-90) | arg | True | none | defect |
| mcp:validate_task_payload | mcp | kind public: stateless linter, no data access | n/a | False | none (no auth dimension) | safe |
| mcp:verify_issue | issues | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | test/list-issues-master-only.test.ts / c0-5-issue-gate.test.ts (non-master denied, master  | safe |
| mcp:whoami | mcp | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | n/a | False | test/whoami-day92.test.ts, whoami-opaque-id.test.ts, path-b-org-authority.test.ts (both id | safe |
| mcp:write_diary | diary | OAuthContext built by bearerAuthMiddleware: master bearer (auth.ts:1340, package validateM | name | True | oauth-scoped.test.ts (predicate level deny 'tau' from bu-m); person-token-writer-role.tes | defect |
| memberWriterRoles:assertPersonMayWrite | memberWriterRoles | MCP-bound service account only (isMcpBoundMaster); role and orgSlug are arguments the MCP  | id | False | none located (files not enumerable); decision is @vantageos/cloud-identity resolveWriterRo | safe |
| memories:getMemory | memories | query: withOrgScope(refuseWithoutThrow) after the row is fetched; decision = isNamespaceAl | id (memory id fetched, namespace of the row decides) | True | could-not-judge: multiTenantIsolation.test.ts header (lines 1-60 read) names getMemory/lis | safe |
| memories:listMemories | memories | query: withOrgScope(refuseWithoutThrow); isNamespaceAllowedForScope(scope, args.namespace) | id | True | could-not-judge: multiTenantIsolation.test.ts header names listMemories as a cross-tenant  | safe |
| memories:softDeleteMemory | memories | mutation: withOrgScope + isNamespaceAllowedForScope on the stored row's namespace (419-424 | id | True | none found; could-not-judge: no search tool in this session | defect |
| memories:storeMemory | memories | mutation: withOrgScope (no allowNoIdentityMaster) then isNamespaceAllowedForScope(scope, n | id for the namespace (slug from verified claims); arg for createdBy | True | none found for storeMemory itself (memoriesScoped and kb write poles exist, not this door) | defect |
| memoriesScoped:listMemoriesScoped | memoriesScoped | query: resolveCallerOrgId -> withOrgScope(refuseWithoutThrow) (83-104); no-org/anonymous - | id | True | both: auth-namespace-deny.test.ts:52-113 (org-a cannot read team/org-b, reads own) and ano | safe |
| memoriesScoped:storeMemoryScoped | memoriesScoped | mutation: resolveCallerOrgId (83-104) -> withOrgScope(refuseWithoutThrow); refused/anonymo | id for namespace; arg for createdBy | True | allow + anonymous/no-org deny: anonymousCallerServedTenantRows.test.ts:398-451 (ordinary i | defect |
| messages:checkNewMessages | messages | resolveInboxReader (inboxReader.ts:168): verifiedActor (agent ID, via package) > verifiedO | name | True | staleInProgress.test.ts and preOrgRefusalCarriesItsMarker.test.ts (named in source comment | defect |
| messages:checkNewMessagesEnvelope | messages | same resolveInboxReader as checkNewMessages; task blocks use reader.label (a name) + taskV | name | True | staleInProgress.test.ts (named in source comment, not opened); fleet-seat-reads-client-mai | defect |
| messages:deleteMessage | messages | service account / member scope via withOrgScope; callerOrchestrator unverified argument; v | name | True | none located (directory not enumerable); deny pole for another org's member deleting a mes | defect |
| messages:getById | messages | withOrgScope: service account / operator-admin master; Clerk member (tenant equal + channe | id | True | none located (directory not enumerable); cross-tenant deny pole: could-not-judge | defect |
| messages:getUnreadCount | messages | resolveInboxReader for verifiedActor/verifiedOrg/master; Clerk member by orchestratorId na | name | True | preOrgRefusalCarriesItsMarker.test.ts (named in source comment, not opened); fleet-reader- | defect |
| messages:listBroadcastStatus | messages | withOrgScope: service account / operator-admin master (any message), Clerk member (message | id | True | none located (directory not enumerable); cross-tenant deny pole under scoped identity: cou | defect |
| messages:listByChannel | messages | withOrgScope: service account / operator-admin master; Clerk member | name | True | publicRegistrationResolvesCaller.test.ts (opened; anonymous, no-org and ordinary member de | defect |
| messages:listByChannelPaginated | messages | withOrgScope: service account / operator-admin master; Clerk member | name | True | operatorListByChannel.test.ts (named in source comment, not opened); none confirmed | defect |
| messages:listMessages | messages | service account master / operator-admin human (all tenants); Clerk member (own tenant); no | n/a | True | messages-with-org-scope.test.ts (opened lines 1-80: tenant-A Clerk caller cannot read tena | defect |
| messages:listMyInbox | messages | Clerk member scope, or verifiedPerson (SHA-256 of the person's bearer, believed from servi | id | True | none located (directory not enumerable); allow pole and cross-person deny pole under a sco | safe |
| messages:markAsRead | messages | service account / member scope via withOrgScope; verifiedPerson; verifiedActor/verifiedOrg | name | True | none located for markAsRead (directory not enumerable); markAsRead cross-owner deny and fl | defect |
| messages:searchMessagesByKeyword | messages | withOrgScope: service account / operator-admin master; Clerk member | arg | True | messages-with-org-scope.test.ts (opened lines 1-80; searchMessagesByKeyword cross-tenant p | defect |
| messages:sendMessage | messages | service-account master bearer (withOrgScope, messages.ts:975) OR Clerk member scope; optio | name | True | verifiedActorProof.test.ts (opened lines 1-80: poles ACCEPTED/OTHER ROW/ORG/UNTRUSTED/NEIT | defect |
| missionTemplates:getByName | missionTemplates | withOrgScope + requireResolvedCaller(alsoRefusePreOrg, masterOnly): raises for anonymous,  | n/a | True | none found (only listNames covered); could-not-judge: no grep/ls | safe |
| missionTemplates:instantiateTemplateIntoMission | missionTemplates | withOrgScope (member or master); target mission tenant derived from the stored mission.org | id | True | master-only functional tests (convex/missionTemplates.test.ts:75-192, asMaster); no scoped | defect |
| missionTemplates:listNames | missionTemplates | withOrgScope(refuseWithoutThrow) + requireResolvedCaller(alsoRefusePreOrg); ordinary org m | n/a | True | both: deny anonymous/no-org/ordinary member, allow master (convex/__tests__/publicRegistra | safe |
| missionTemplates:softDelete | missionTemplates | withOrgScope then isMaster required | id | True | none found; could-not-judge: no grep/ls | safe |
| missionTemplates:upsert | missionTemplates | withOrgScope (no allowNoIdentityMaster) then isMaster required; createdBy is a stored-only | n/a | True | allow-only under master (convex/missionTemplates.test.ts:51-69 seeds via asMaster); no sco | safe |
| missions:create | missions | withOrgScope(ctx) + resolveVerifiedPerson; createdBy an unverified arg checked against the | name | True | none found; convex/missionTemplates.test.ts seeds missions as master only; could-not-judge | defect |
| missions:get | missions | withOrgScope(refuseWithoutThrow); isRowVisibleToScope | id | True | none found; could-not-judge: no grep/ls | safe |
| missions:list | missions | withOrgScope(refuseWithoutThrow) + requireScope('view-own-missions') | n/a | True | none found; could-not-judge: no grep/ls | safe |
| missions:update | missions | withOrgScope(ctx) + resolveVerifiedPerson; tenant gate isOrgAllowedForScope on mission.org | name | True | none found; could-not-judge: no grep/ls | defect |
| missions:updateProgress | missions | withOrgScope(ctx); tenant gate; non-master -> resolveHumanActor writer role; master unnarr | id | True | none found; no caller outside convex-test (comment 866); could-not-judge: no grep/ls | safe |
| missions:updateStatus | missions | withOrgScope(ctx); tenant gate on mission.orgId; non-master -> resolveHumanActor (writer r | id | True | none found; could-not-judge: no grep/ls | safe |
| oauth:canCreateOrganization | oauth | anonymous: refused by raising via requireResolvedCaller; signed-in: answers about the call | id | True | none located | safe |
| oauth:consumeAuthorizationCode | oauth | fleet service account only (requireServiceAccount oauth.ts:2024) | arg | True | both: closeDoorsOauth.test.ts:284-316 deny (a refused call leaves the code unspent) + :359 | safe |
| oauth:consumePersonCode | oauth | fleet service account only (requireServiceAccount oauth.ts:2098) | arg | True | none located | safe |
| oauth:createAccessToken | oauth | fleet service account only (requireServiceAccount oauth.ts:2191) | arg | True | both: closeDoorsOauth.test.ts:318-334 deny + :371-382 allow | safe |
| oauth:createAuthorizationCode | oauth | fleet service account only (requireServiceAccount oauth.ts:1989); legacy door kept for rol | arg | True | both: closeDoorsOauth.test.ts:318-334 deny + :349-358 allow | defect |
| oauth:createClient | oauth | fleet service account only (requireServiceAccount oauth.ts:547) | arg | True | deny-only located: closeDoorsOauth.test.ts:318-334 (anonymous, no-org, acme member, globex | safe |
| oauth:createRefreshToken | oauth | fleet service account only (requireServiceAccount oauth.ts:2324) | arg | True | both: closeDoorsOauth.test.ts:318-334 deny + :383-389 allow | safe |
| oauth:deleteClient | oauth | fleet service account only (requireServiceAccount oauth.ts:1706) | arg | True | deny-only located: closeDoorsOauth.test.ts:318-334; allow pole not in that file | safe |
| oauth:getAccessTokenByHash | oauth | fleet service account only (requireServiceAccount oauth.ts:2278) | id | True | both: closeDoorsOauth.test.ts:284-300 deny + :391-419 allow, :422-475 absent/revoked/expir | safe |
| oauth:getClientByClientId | oauth | MCP-bound master only (isMcpBoundMaster oauth.ts:1199-1205) | arg | True | none located for this door directly (its caller is exercised only inside mcp-server paths  | safe |
| oauth:getRefreshTokenByHash | oauth | fleet service account only (requireServiceAccount oauth.ts:2359) | id | True | both: closeDoorsOauth.test.ts:284-300 deny + :397-419 allow, :422-475 absent -> null; no t | defect |
| oauth:getScopeProfile | oauth | MCP-bound master only: isMcpBoundMaster(withOrgScope(ctx)) oauth.ts:495-501; operator-admi | arg | True | none located | safe |
| oauth:listClients | oauth | fleet service account only (requireServiceAccount oauth.ts:1472) | n/a | True | deny-only located: closeDoorsOauth.test.ts:318-334; allow pole not in that file | safe |
| oauth:patchClientScopeAndRefreshTokens | oauth | fleet service account only (requireServiceAccount oauth.ts:1784); reason >= 20 chars | arg | True | none located | safe |
| oauth:patchScopeProfileEmergency | oauth | fleet service account only (requireServiceAccount oauth.ts:2551); reason >= 40 chars | arg | True | none located | defect |
| oauth:provisionOrganization | oauth | any of: BEARER_SECRET_MASTER sent in the request body as args.callerToken (constant-time c | arg | True | provisionOrganizationOrgAdmin.test.ts (header): allow admin of X into X; deny admin of X i | defect |
| oauth:putPersonCode | oauth | fleet service account only (requireServiceAccount oauth.ts:2083) | arg | True | none located | safe |
| oauth:registerPublicClient | oauth | fleet service account only (requireServiceAccount oauth.ts:1113); anonymous DCR is gated M | arg | True | both: closeDoorsOauth.test.ts:284-300 deny (anonymous, no-org, acme member, globex member; | safe |
| oauth:revokeAccessTokensForCode | oauth | fleet service account only (requireServiceAccount oauth.ts:2132) | arg | True | none located | safe |
| oauth:revokeAccessTokensOnly | oauth | fleet service account only (requireServiceAccount oauth.ts:1915); reason >= 20 chars | arg | True | deny-only located: closeDoorsOauth.test.ts:318-334; allow pole not in that file | safe |
| oauth:seedDefaultProfiles | oauth | fleet service account only: requireServiceAccount oauth.ts:124-152 (withOrgScope without a | n/a | True | none located (closeDoorsOauth.test.ts covers 11 other oauth doors, not this one) | safe |
| okfBundleDurable:cancelOkfBundleExportDurable | okfBundleDurable | mutation: identity must exist (472-477), then assertCanExportNamespaceV8 on the progress r | id | True | none found (okfBundleDurable.test.ts has no cancel test) | safe |
| okfBundleDurable:getOkfBundleExportDurableStatus | okfBundleDurable | query: withOrgScope(refuseWithoutThrow) + requireResolvedCaller(alsoRefusePreOrg) (410-413 | id (jobId row -> stored namespace -> verified org) | True | none found (okfBundleDurable.test.ts has no status test) | safe |
| okfBundleDurable:startOkfBundleExportDurable | okfBundleDurable | mutation: assertCanExportNamespaceV8 -> withOrgScope(refuseWithoutThrow) + requireTenantNa | id | True | deny-only in substance: okfBundleDurable.test.ts:422-447 and 516-536 (other-org slug, anon | safe |
| okfBundleNode:exportOkfBundle | okfBundleNode | action: internal.lib.auth.resolveOrgScopeForAction bridge (convex/lib/auth.ts:1555) -> wit | id | True | none at action level under a scoped identity: okfBundle.test.ts (lines 1-80 read) is helpe | defect |
| okfBundleNode:importOkfBundle | okfBundleNode | action: assertCanExportNamespace gate on targetNamespace (okfBundleNode.ts:848-859) via re | arg (assignedTo / createdBy read from uploaded frontmatter; tenant stamp itself comes from | True | none found (no importOkfBundle test among files opened). could-not-judge: no search tool i | defect |
| okfBundleNode:validateOkfBundle | okfBundleNode | action: assertCanValidate accepts ANY identity carrying one claim (okfBundleNode.ts:629-66 | id for storageId (kbUploads binding); arg for bundleUrl (hostname string literal check) | True | none found (no validateOkfBundle test among files opened). could-not-judge: no search tool | defect |
| orgMembership:getMembership | orgMembership | withOrgScope refuseWithoutThrow; master (service account / operator-admin) any org; Clerk  | id | True | none located (files not enumerable); cross-org deny pole under scoped identity: could-not- | defect |
| orgRoster:getAgentDirectoryForAccessToken | orgRoster | MCP-bound service account (isMcpBoundMaster) plus tokenHash argument (bearer hash) from wh | name | True | none located (files not enumerable); allow pole for a roster name owned by the operator or | defect |
| orgRoster:getForAccessToken | orgRoster | MCP-bound service account (isMcpBoundMaster) + tokenHash from the bearer; org derived from | n/a | True | orgRoster.getForAccessToken.test.ts (named in source comment, not opened) | safe |
| orgRoster:getMyAgentDirectory | orgRoster | Clerk session (withOrgScope; operator-admin re-resolved as member); org from scope, never  | name | True | none located (files not enumerable) | defect |
| orgRoster:getMyOrgRoster | orgRoster | withOrgScope (Clerk member; operator-admin re-resolved as member; service account gets ['* | n/a | True | none located (files not enumerable) | safe |
| profiles:getProfile | profiles | withOrgScope: service account / operator-admin master (all); Clerk member (orchestratorId  | name | True | publicRegistrationResolvesCaller.test.ts (opened: covers listProfiles only); getProfile po | defect |
| profiles:getProfileWithMemories | profiles | withOrgScope refuseWithoutThrow; isNamespaceAllowedForScope(scope, args.namespace); orches | arg | True | none located (files not enumerable); roster deny pole for the profile half: none | defect |
| profiles:listProfiles | profiles | withOrgScope refuseWithoutThrow; master only (service account / operator-admin); members g | n/a | True | publicRegistrationResolvesCaller.test.ts (opened): anonymous, no-org and ordinary member o | safe |
| profiles:updateDynamic | profiles | withOrgScope master; orchestratorId/instanceId unverified arguments | arg | True | profiles.summaryIndexClobber.test.ts (named in source comment, not opened); caller-binding | defect |
| profiles:upsertProfile | profiles | withOrgScope master (service account); orchestratorId/instanceId/name are unverified argum | arg | True | publicRegistrationResolvesCaller.test.ts third deny pole covers the READ listProfiles unde | defect |
| recurringTasks:create | recurringTasks | requireAuthenticatedCaller(ctx, args.createdBy, undefined) (tasks.ts:200-286): Clerk sessi | arg | True | none found for create; could-not-judge: no grep/ls | defect |
| recurringTasks:getById | recurringTasks | identity required (AUTH_REQUIRED) then withOrgScope(allowNoIdentityMaster:false); isRowVis | id | True | none found; could-not-judge: no grep/ls | safe |
| recurringTasks:list | recurringTasks | withOrgScope(refuseWithoutThrow) + requireResolvedCaller(alsoRefusePreOrg); Clerk session  | n/a | True | partial: roster deny + ordinary-member allow only, no cross-org same-roster deny (convex/_ | defect |
| recurringTasks:pause | recurringTasks | requireAuthenticatedCaller(undefined); non-master without org refused before the read; aut | id | True | none found; could-not-judge: no grep/ls | safe |
| recurringTasks:remove | recurringTasks | same as pause plus adminOnly (verified org:admin) for non-master | id | True | none found; could-not-judge: no grep/ls | safe |
| recurringTasks:resume | recurringTasks | same as pause | id | True | none found; could-not-judge: no grep/ls | safe |
| recurringTasks:update | recurringTasks | requireAuthenticatedCaller(undefined) then isRowVisibleToScope (tenant stamp + roster) and | id | True | none found; could-not-judge: no grep/ls | safe |
| search:hybridSearch | search | action: resolveSearchNamespace bridge (search.ts:182-204) | id | True | both: searchNamespaceAuthorityEndToEnd.test.ts:184-319 (SEARCH_ACTIONS loop covers hybridS | safe |
| search:recall | search | action: resolveSearchNamespace -> internal.lib.auth.resolveOrgScopeForAction (search.ts:18 | id | True | both: searchNamespaceAuthorityEndToEnd.test.ts:184-319 (ordinary scoped identities; deny:  | safe |
| search:searchFixPatterns | search | action: resolveSearchNamespace(ctx,'fixpatterns') (search.ts:474); only master resolves it | id | True | deny + master allow: searchNamespaceAuthorityEndToEnd.test.ts:361-423 (anonymous, no-org,  | safe |
| search:textSearch | search | action: resolveSearchNamespace bridge (search.ts:182-204) | id | True | both: searchNamespaceAuthorityEndToEnd.test.ts:184-319 (SEARCH_ACTIONS loop covers textSea | safe |
| stats:fleetStats | stats | withOrgScope refuseWithoutThrow; refused pre-org caller gets an all-zero object (:512-544, | arg | True | could-not-judge: no test file located | defect |
| stats:openTaskCountsByOrchestrator | stats | withOrgScope refuseWithoutThrow; refused pre-org caller gets [] (line 394); anonymous reac | name | True | could-not-judge: no test file located | defect |
| stats:orchestratorStats | stats | withOrgScope refuseWithoutThrow + requireResolvedCaller(alsoRefusePreOrg) + requireScope v | id | True | could-not-judge: no test file located (guessed convex/__tests__/stats.test.ts does not exi | safe |
| tasks:attachReviewArtifact | tasks | requireAuthenticatedCaller (callerOrchestrator mandatory); tenant via assertTaskVisibleToC | name | True | none found; no MCP wiring either (comment 2079-2083); could-not-judge: no grep/ls | defect |
| tasks:billingSummaryByProject | tasks | withOrgScope(refuseWithoutThrow) + requireScope('view-own-tasks') | n/a | True | none found; could-not-judge: no grep/ls | defect |
| tasks:blockTask | tasks | requireAuthenticatedCaller + verifiedOrg binding of the TARGET task; the cited blockedOnTa | arg | True | none found; could-not-judge: no grep/ls | defect |
| tasks:bulkComplete | tasks | requireAuthenticatedCaller + resolveVerifiedOrg (claim optional); callerOrchestrator an un | name | True | member tenant + RBAC + run-row poles under an ordinary member (convex/__tests__/bulkComple | defect |
| tasks:checkout | tasks | requireAuthenticatedCaller + verifiedOrg; only assertTaskVisibleToCaller (tenant + assigne | id | True | none found; could-not-judge: no grep/ls | defect |
| tasks:complete | tasks | requireAuthenticatedCaller (Clerk/service account) + verifiedOrg/verifiedPerson/verifiedAc | name | True | none found for authz; tasksMutationConvexErrors.test.ts is master-only; could-not-judge: n | safe |
| tasks:correctSegment | tasks | requireAuthenticatedCaller + verifiedOrg; assertTaskCallerAuthorized (agent path only, cre | name | True | none found; could-not-judge: no grep/ls | safe |
| tasks:create | tasks | Clerk session or MCP service account via requireAuthenticatedCaller (tasks.ts:200-286); cr | arg | True | none found: convex/__tests__/tasksMutationConvexErrors.test.ts runs as service-account mas | defect |
| tasks:deleteTask | tasks | requireAuthenticatedCaller + verifiedOrg; tenant gate, then human path (writer role + org: | name | True | none found; could-not-judge: no grep/ls | safe |
| tasks:failTask | tasks | same lock as tasks:complete (verifiedOrg, verifiedActor, credential; no verifiedPerson so  | name | True | none found; could-not-judge: no grep/ls | safe |
| tasks:get | tasks | withOrgScope(refuseWithoutThrow); isRowVisibleToScope (master / row.orgId == scope.orgSlug | id | True | none found; could-not-judge: no grep/ls | safe |
| tasks:getBulkCompleteRun | tasks | withOrgScope(allowNoIdentityMaster:false) + requireResolvedCaller; run row org compared by | id | True | both: run readable by own org or master and by nobody else (convex/__tests__/bulkCompleteS | safe |
| tasks:getById | tasks | same as tasks:get | id | True | none found; could-not-judge: no grep/ls | safe |
| tasks:list | tasks | withOrgScope(refuseWithoutThrow) + requireScope('view-own-tasks'); anonymous scope has no  | n/a | True | none found for tasks:list proper; could-not-judge: no grep/ls | safe |
| tasks:listByMission | tasks | withOrgScope(refuseWithoutThrow) | arg | True | none found; could-not-judge: no grep/ls | safe |
| tasks:listOverdue | tasks | withOrgScope(refuseWithoutThrow) | n/a | True | none found; could-not-judge: no grep/ls | safe |
| tasks:listPaginated | tasks | withOrgScope(refuseWithoutThrow) + requireScope('view-own-tasks') | n/a | True | none found; could-not-judge: no grep/ls | safe |
| tasks:listUnlinkedBlocked | tasks | withOrgScope(refuseWithoutThrow) + requireResolvedCaller(alsoRefusePreOrg) | n/a | True | partial: roster deny + ordinary-member allow, no cross-org same-roster deny (convex/__test | defect |
| tasks:pause | tasks | requireAuthenticatedCaller + verifiedOrg; creator/assignee by asserted name (residual cond | name | True | none found; could-not-judge: no grep/ls | safe |
| tasks:resume | tasks | same as tasks:pause | name | True | none found; could-not-judge: no grep/ls | safe |
| tasks:searchTasksByKeyword | tasks | withOrgScope(refuseWithoutThrow) + requireScope('view-own-tasks') | n/a | True | none found; could-not-judge: no grep/ls | safe |
| tasks:start | tasks | requireAuthenticatedCaller + verifiedOrg + verifiedPerson claims; creator/assignee by asse | name | True | none found; could-not-judge: no grep/ls | defect |
| tasks:taskDurationDistribution | tasks | withOrgScope(refuseWithoutThrow) + requireScope('view-own-tasks') | n/a | True | none found; could-not-judge: no grep/ls | defect |
| tasks:update | tasks | requireAuthenticatedCaller + resolveDoorVerifiedOrg/assertRowInVerifiedOrg (verifiedOrg on | name | True | none found; tasksMutationConvexErrors.test.ts is master-only; could-not-judge: no grep/ls | defect |
