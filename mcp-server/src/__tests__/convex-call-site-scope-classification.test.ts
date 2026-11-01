/**
 * Scope-classification guard for every Convex call site the MCP server makes
 * (task k1730pg1m870s58x99jq5x2ycd8hc72b, security sweep).
 *
 * Class of failure. A non-master OAuth caller is served by the fleet service
 * account (authenticatedConvexClient.ts selectConvexClientForRequest). The
 * Convex side then sees a fleet-wide identity, so isolation depends on the MCP
 * layer forwarding the caller's org (verifiedOrg / doorScope) AND on the Convex
 * door narrowing by it. A new call site that forwards neither, added without
 * anyone deciding it is safe, is a silent cross-tenant door.
 *
 * What this test does. It enumerates every Convex call site in the MCP server
 * source by the rules below, keys each by `<owner>|<convex function>`, and
 * requires every key to appear in SCOPE_CLASSIFICATION with a declared class
 * (safe / traced / leak / unmeasured), a severity for each leak, and a reason.
 * A key with no declaration fails. A declared key with no live call site fails,
 * so the allowlist cannot rot.
 *
 * Enumeration rules (mirrored by the sweep script that generated the table):
 *   - a call site is `convex.query|mutation|action(`, `internalClient().query|
 *     mutation|action(`, `client.query(` (boot manifest), or `fetchConvex(`
 *     in call form (a type declaration `fetchConvex: (` is not a site);
 *   - its owner is the registered tool name of the nearest PRECEDING
 *     `defineTool(` in the same file (the first standalone name line, a string
 *     or a constant resolved from `const NAME = "value"`), else the file's
 *     basename;
 *   - its function is the first `"module:name"` literal within seven lines,
 *     else `<dynamic>`.
 *
 * Limit, stated: the key is tool + function, so a NEW call to a function that
 * is already declared under the same tool is not caught by this test. The
 * classification of that function still has to be re-read by a reviewer.
 *
 * Pole test: the fixture below plants an unscoped call under a new tool and the
 * enumerator must report it unclassified.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type ScopeClass = "safe" | "traced" | "leak" | "unmeasured";

type ScopeClassification = {
	readonly class: ScopeClass;
	readonly severity: "High" | "Medium" | null;
	readonly basis: "measured" | "args+gate" | "unread";
	readonly reason: string;
};

type CallSite = {
	readonly file: string;
	readonly line: number;
	readonly owner: string;
	readonly fn: string;
	readonly key: string;
};

const SCOPE_CLASSES: readonly ScopeClass[] = [
	"safe",
	"traced",
	"leak",
	"unmeasured",
];

/**
 * Every declared (tool|function) call site, with its classification. Generated
 * from the sweep table (task k1730pg1m870s58x99jq5x2ycd8hc72b). `leak` rows are
 * open findings; they are declared here so a new one cannot land silently, not
 * because they are accepted.
 */
const SCOPE_CLASSIFICATION: Readonly<Record<string, ScopeClassification>> = {
	"tools.ts|<dynamic>": {
		class: "safe",
		severity: null,
		basis: "measured",
		reason:
			"directory roster door keyed by the verified Clerk JWT or the token hash; org derived server-side (tools.ts:2029-2035)",
	},
	"tools.ts|profiles:listProfiles": {
		class: "traced",
		severity: null,
		basis: "args+gate",
		reason:
			"roster rows kept only when instanceId === <name>-<orgSlug> (tools.ts:2084-2089)",
	},
	"tools.ts|orgRoster:getMyOrgRoster": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"Clerk-JWT caller's own JWT reaches Convex (selectConvexClientForRequest, authenticatedConvexClient.ts:85-89)",
	},
	"tools.ts|orgRoster:getForAccessToken": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"keyed by the access-token hash; org from the token row (tools.ts:2290)",
	},
	"store_memory|memories:storeMemory": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"write with no verifiedOrg; withOrgScope under the service account stamps no org; gates = namespace-write prefix + from roster name (tools.ts:2429)",
	},
	"soft_delete_memory|memories:softDeleteMemory": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master: non-master refused before Convex (tools.ts:2490)",
	},
	"get_memory|memories:getMemory": {
		class: "leak",
		severity: "Medium",
		basis: "measured",
		reason:
			"DOOR_SCOPE says verifiedOrg 'always' but the call (tools.ts:2536) forwards none; Convex fleet read; only gate is scopeFilterGet on the row name",
	},
	"recall|search:recall": {
		class: "leak",
		severity: "Medium",
		basis: "measured",
		reason:
			"namespace-prefix read; convex/search.ts resolveSearchNamespace returns the requested namespace for master; only team/<orgClerkId> is org-keyed",
	},
	"text_search|search:textSearch": {
		class: "leak",
		severity: "Medium",
		basis: "measured",
		reason: "same as recall: namespace-keyed, not tenant-keyed",
	},
	"hybrid_search|search:hybridSearch": {
		class: "leak",
		severity: "Medium",
		basis: "measured",
		reason: "same as recall: namespace-keyed, not tenant-keyed",
	},
	"store_episode|episodes:storeEpisode": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"write with no verifiedOrg; unstamped under the service account; from roster name gate",
	},
	"get_episode|memories:getMemory": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg 'always' + unresolvedOrgDenial (tools.ts:2870-2872)",
	},
	"list_episodes|memories:listMemories": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason: "namespace read, no verifiedOrg forwarded (tools.ts:2973)",
	},
	"search_episodes_by_keyword|search:textSearch": {
		class: "leak",
		severity: "Medium",
		basis: "measured",
		reason: "namespace-keyed search, no org (tools.ts:3060)",
	},
	"search_episodes_by_semantic|search:recall": {
		class: "leak",
		severity: "Medium",
		basis: "measured",
		reason: "namespace-keyed search, no org (tools.ts:3121)",
	},
	"get_profile|profiles:getProfile": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"name-keyed read; verifiedActor only; handler not read (tools.ts:3176)",
	},
	"update_profile|profiles:upsertProfile": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"name-keyed write (orchestratorId from roster); verifiedActor only; handler not read (tools.ts:3270)",
	},
	"list_memories|memories:listMemories": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason: "namespace read, no verifiedOrg forwarded (tools.ts:3384)",
	},
	"send_message|messages:sendMessage": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScope(messages:sendMessage) forwards verifiedPerson/seat (tools.ts:3655)",
	},
	"check_messages|messages:checkNewMessagesEnvelope": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"unresolvedOrgDenial (tools.ts:3792) + doorScopeArgs verifiedOrg unless-proof (tools.ts:3794)",
	},
	"list_blocked_on_me|tasks:listBlockedOnMe": {
		class: "traced",
		severity: null,
		basis: "args+gate",
		reason:
			"unresolvedOrgDenial (tools.ts:3947); Convex serves the verified agent by ID (tools.ts:3950 comment); no org proof forwarded",
	},
	"mark_as_read|messages:markAsRead": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedPerson + verifiedOrg unless-proof, unresolvedOrgDenial (tools.ts:4022-4024)",
	},
	"delete_message|messages:deleteMessage": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg unless-proof, unresolvedOrgDenial (tools.ts:4075-4077)",
	},
	"set_summary|profiles:updateDynamic": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"name-keyed write; verifiedActor only; handler not read (tools.ts:4133)",
	},
	"list_peers|profiles:listProfiles": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"FALLBACK when no clerkOrgSlug: fleet listProfiles then name filter (tools.ts:4239); the directory path (tools.ts:2035) is the traced one",
	},
	"list_messages|messages:listMessages": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always + unresolvedOrgDenial (tools.ts:4387-4396)",
	},
	"search_messages_by_keyword|messages:searchMessagesByKeyword": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always + unresolvedOrgDenial (tools.ts:4526-4528)",
	},
	"list_broadcast_status|messages:listBroadcastStatus": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always + unresolvedOrgDenial (tools.ts:4639-4642)",
	},
	"create_task|tasks:create": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedPerson / verifiedOrg unless-person (tools.ts:4812); verifiedOrg validator spread via createTaskArgsValidatorWithCredential (convex/tasks.ts:876)",
	},
	"list_tasks|tasks:list": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always + unresolvedOrgDenial (tools.ts:4924-4926)",
	},
	"bulk_complete_tasks|tasks:bulkComplete": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always + unresolvedOrgDenial (tools.ts:5043-5069)",
	},
	"get_bulk_complete_run|tasks:getBulkCompleteRun": {
		class: "leak",
		severity: "Medium",
		basis: "measured",
		reason:
			"convex/tasks.ts:5586 skips the org check for hasFleetRead (the service account), so any org's run is returned; MCP filter is scopeFilterGet on the creator name (tools.ts:5113)",
	},
	"search_tasks_by_keyword|tasks:searchTasksByKeyword": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always + unresolvedOrgDenial (tools.ts:5231-5233)",
	},
	"billing_summary_by_project|tasks:billingSummaryByProject": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts:5309)",
	},
	"update_task|tasks:update": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always (+ verifiedPerson where listed) + unresolvedOrgDenial",
	},
	"complete_task|tasks:complete": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always (+ verifiedPerson where listed) + unresolvedOrgDenial",
	},
	"fail_task|tasks:failTask": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always (+ verifiedPerson where listed) + unresolvedOrgDenial",
	},
	"start_task|tasks:start": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always (+ verifiedPerson where listed) + unresolvedOrgDenial",
	},
	"pause_task|tasks:pause": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always (+ verifiedPerson where listed) + unresolvedOrgDenial",
	},
	"resume_task|tasks:resume": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always (+ verifiedPerson where listed) + unresolvedOrgDenial",
	},
	"correct_task_segment|tasks:correctSegment": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always (+ verifiedPerson where listed) + unresolvedOrgDenial",
	},
	"checkout_task|tasks:checkout": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always (+ verifiedPerson where listed) + unresolvedOrgDenial",
	},
	"delete_task|tasks:deleteTask": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always (+ verifiedPerson where listed) + unresolvedOrgDenial",
	},
	"block_task|tasks:blockTask": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always (+ verifiedPerson where listed) + unresolvedOrgDenial",
	},
	"block_task|tasks:update": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always (+ verifiedPerson where listed) + unresolvedOrgDenial",
	},
	"add_task_dependency|tasks:update": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always (+ verifiedPerson where listed) + unresolvedOrgDenial",
	},
	"list_tasks_by_mission|tasks:listByMission": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"withOrgScope under the service account; no verifiedOrg; scopeFilter name gate (tools.ts:6182)",
	},
	"create_mission|missions:create": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedPerson / verifiedOrg unless-person (tools.ts:6325)",
	},
	"list_missions|missions:list": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"fleet listing; non-master gated only by pilot === own userId (tools.ts:6408-6413); no org",
	},
	"get_mission|missions:get": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"withOrgScope fleet read; scopeFilter name gate on pilot/agents (tools.ts:6518)",
	},
	"update_mission|missions:update": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"ID-addressed; verifiedPerson only (person path); service-account OAuth caller gets no org; name roster gates (tools.ts:6610)",
	},
	"update_mission_status|missions:updateStatus": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts:6668)",
	},
	"write_diary|diary:write": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"from-roster name gate; Convex master-only passes the service account; unstamped write (tools.ts:6725)",
	},
	"get_diary|diary:get": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"KNOWN: fix on branch sigma/diary-tenant-scope, do not touch; row scopeFilter by name only (tools.ts:6784)",
	},
	"list_diaries|diary:list": {
		class: "leak",
		severity: "High",
		basis: "args+gate",
		reason:
			"KNOWN: fix on branch sigma/diary-tenant-scope, do not touch; no MCP gate at all; Convex fleet listing (tools.ts:6909)",
	},
	"create_briefing_note|briefingNotes:create": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always + unresolvedOrgDenial (tools.ts:7012-7015)",
	},
	"update_briefing_note|briefingNotes:update": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"ID-addressed; verifiedActor only; handler not read (tools.ts:7086)",
	},
	"get_briefing_note|briefingNotes:get": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always + unresolvedOrgDenial (tools.ts:7162-7164)",
	},
	"list_briefing_notes|briefingNotes:list": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always + unresolvedOrgDenial (tools.ts:7272-7274)",
	},
	"search_briefing_notes_by_keyword|briefingNotes:searchBriefingNotesByKeyword":
		{
			class: "safe",
			severity: null,
			basis: "args+gate",
			reason:
				"doorScopeArgs verifiedOrg always + unresolvedOrgDenial (tools.ts:7422-7424)",
		},
	"create_recurring_task|recurringTasks:create": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"verifiedActor/verifiedPerson only; no verifiedOrg; unstamped write (tools.ts:7527)",
	},
	"list_recurring_tasks|recurringTasks:list": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason: "fleet listing; scopeFilter name gate (tools.ts:7616)",
	},
	"pause_recurring_task|recurringTasks:pause": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts:7688)",
	},
	"resume_recurring_task|recurringTasks:resume": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts:7725)",
	},
	"delete_recurring_task|recurringTasks:remove": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts:7766)",
	},
	"update_recurring_task|recurringTasks:getById": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason: "ID read, scopeFilter name gate (tools.ts:7838)",
	},
	"update_recurring_task|recurringTasks:update": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"ID-addressed mutation after the name check; no org argument (tools.ts:7861)",
	},
	"create_mandate|mandates:create": {
		class: "leak",
		severity: "Medium",
		basis: "unread",
		reason:
			"requireFleetMaster passes the service account; no org; from requestedBy roster; handler not read (tools.ts:7945)",
	},
	"accept_mandate|mandates:accept": {
		class: "safe",
		severity: null,
		basis: "measured",
		reason:
			"convex/mandates.ts:190-201: only the fulfilling agent (verifiedActor) may accept",
	},
	"update_mandate|mandates:update": {
		class: "leak",
		severity: "Medium",
		basis: "unread",
		reason:
			"verifiedActor only; ID-addressed; handler not read (tools.ts:8063)",
	},
	"settle_mandate|mandates:settle": {
		class: "leak",
		severity: "Medium",
		basis: "unread",
		reason:
			"verifiedActor only; ID-addressed; handler not read (tools.ts:8113)",
	},
	"validate_mandate_spending|mandates:validateSpending": {
		class: "leak",
		severity: "High",
		basis: "measured",
		reason:
			"MCP kind public with no gate (tools.ts:8165); convex/mandates.ts:545-553 masterOnly passes the service account; returns budget and spend of any mandate ID",
	},
	"debate_post_turn|debate:postTurn": {
		class: "unmeasured",
		severity: null,
		basis: "unread",
		reason:
			"MCP kind public (tools.ts:8214); Convex verifiedActor; room membership not read",
	},
	"debate_get_room|debate:getRoom": {
		class: "unmeasured",
		severity: null,
		basis: "unread",
		reason:
			"MCP kind public (tools.ts:8269); Convex requireResolvedCaller + verifiedActor; room membership not read",
	},
	"list_mandates|mandates:list": {
		class: "leak",
		severity: "Medium",
		basis: "measured",
		reason:
			"fleet fetch (convex/mandates.ts:339 handler begins with the org-less fleet path); scopeFilterList on requestedBy/fulfilledBy after the fetch (tools.ts:8384-8388); mandates have no org column",
	},
	"create_bu|businessUnits:create": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "doorScopeArgs verifiedOrg always + unresolvedOrgDenial",
	},
	"update_bu|businessUnits:update": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "doorScopeArgs verifiedOrg always + unresolvedOrgDenial",
	},
	"get_bu|businessUnits:get": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "doorScopeArgs verifiedOrg always + unresolvedOrgDenial",
	},
	"list_bus|businessUnits:list": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "doorScopeArgs verifiedOrg always + unresolvedOrgDenial",
	},
	"delete_bu|businessUnits:remove": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts:8875)",
	},
	"add_repo_mapping|githubRepoMapping:add": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "doorScopeArgs verifiedOrg always + unresolvedOrgDenial",
	},
	"list_repo_mappings|githubRepoMapping:list": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "doorScopeArgs verifiedOrg always + unresolvedOrgDenial",
	},
	"remove_repo_mapping|githubRepoMapping:remove": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "doorScopeArgs verifiedOrg always + unresolvedOrgDenial",
	},
	"get_github_owner_bindings|githubOwnerBinding:listBindings": {
		class: "leak",
		severity: "High",
		basis: "measured",
		reason:
			"convex/githubOwnerBinding.ts:159-160 hasFleetRead returns every org's bindings to the service account; MCP gate is guardResolvedCaller only (tools.ts:9228)",
	},
	"get_github_owner_bindings|githubOwnerBinding:listUnprovenMappings": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP gates the call on isMasterScope (tools.ts:9237-9238)",
	},
	"list_issues|issues:listByOrchestrator": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts registration)",
	},
	"list_issues|issues:listByProject": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts registration)",
	},
	"list_issues|issues:listByStatus": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts registration)",
	},
	"get_issue|issues:getByRepoNumber": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts registration)",
	},
	"update_issue_status|issues:updateStatus": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts registration)",
	},
	"link_commit_to_issue|issues:linkCommit": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts registration)",
	},
	"verify_issue|issues:verify": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts registration)",
	},
	"issue_stats|issues:getStats": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts registration)",
	},
	"create_fix_pattern|fixPatterns:create": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"from createdBy roster; unstamped write; handler not read (tools.ts:9758)",
	},
	"add_fix_attempt|fixPatterns:addAttempt": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason: "verifiedActor only; handler not read (tools.ts:9811)",
	},
	"validate_fix|fixPatterns:validate": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts registration)",
	},
	"search_fix_patterns|search:searchFixPatterns": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"withOrgScope action, no org argument; the scopeFilter name gate is on the second call (tools.ts:9902, 9937)",
	},
	"list_fix_patterns|fixPatterns:listByProject": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason: "withOrgScope fleet; scopeFilter name gate (tools.ts:10041)",
	},
	"list_fix_patterns|fixPatterns:listAll": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason: "withOrgScope fleet; scopeFilter name gate (tools.ts:10069)",
	},
	"link_issue_to_pattern|fixPatterns:linkIssue": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts registration)",
	},
	"get_mission_template|missionTemplates:getByName": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason: "scopeFilter name gate; no org (tools.ts:10175)",
	},
	"update_mission_template|missionTemplates:upsert": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason: "from createdBy roster; unstamped write (tools.ts:10270)",
	},
	"instantiate_template_into_mission|missions:get": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason: "scopeFilter name gate on the fleet mission read (tools.ts:10361)",
	},
	"instantiate_template_into_mission|missionTemplates:instantiateTemplateIntoMission":
		{
			class: "leak",
			severity: "Medium",
			basis: "unread",
			reason: "write with no org argument; handler not read (tools.ts:10374)",
		},
	"soft_delete_mission_template|missionTemplates:softDelete": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts registration)",
	},
	"add_deployment|errorMonitor:addDeployment": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts registration)",
	},
	"remove_deployment|errorMonitor:removeDeployment": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts registration)",
	},
	"list_errors|errorMonitor:listErrors": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "guardMasterOnly (tools.ts:10653)",
	},
	"get_error|errorMonitor:getError": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts registration)",
	},
	"get_task|tasks:getById": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason: "withOrgScope fleet read; scopeFilter name gate (tools.ts:10982)",
	},
	"get_fix_pattern|fixPatterns:get": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason: "withOrgScope fleet read; scopeFilter name gate (tools.ts:11043)",
	},
	"get_mandate|mandates:get": {
		class: "leak",
		severity: "Medium",
		basis: "measured",
		reason:
			"convex/mandates.ts:502-516 masterOnly passes the service account; scopeFilterGet on requestedBy/fulfilledBy after the fetch (tools.ts:11090)",
	},
	"get_repo_mapping|githubRepoMapping:getByRepo": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"withOrgScope fleet read; scopeFilter name gate; no verifiedOrg (tools.ts:11153)",
	},
	"get_message|messages:getById": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always + unresolvedOrgDenial (tools.ts:11227-11229)",
	},
	"get_recurring_task|recurringTasks:getById": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason: "ID read, scopeFilter name gate (tools.ts:11306)",
	},
	"improvisation_digest|improvisationDigest:scanWindow": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts registration)",
	},
	"store_document_chunked|kb:storeDocumentChunked": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"kbIngest scopeArgs forwards verifiedOrg (tools/kbIngest.ts:264-266)",
	},
	"soft_delete_document|kb:softDeleteDocument": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"kbIngest scopeArgs forwards verifiedOrg (tools/kbIngest.ts:264-266)",
	},
	"generate_upload_url|kbMutations:generateUploadUrl": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"kbIngest scopeArgs forwards verifiedOrg (tools/kbIngest.ts:264-266)",
	},
	"generate_upload_url|kbMutations:generateUploadUrlWithTicket": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"kbIngest scopeArgs forwards verifiedOrg (tools/kbIngest.ts:264-266)",
	},
	"claim_upload|kbMutations:claimUpload": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"kbIngest scopeArgs forwards verifiedOrg (tools/kbIngest.ts:264-266)",
	},
	"export_okf_bundle|okfBundleNode:exportOkfBundle": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"namespace-read kind (tools/exportOkfBundle.ts:118); no verifiedOrg forwarded",
	},
	"import_okf_bundle|okfBundleNode:importOkfBundle": {
		class: "leak",
		severity: "Medium",
		basis: "args+gate",
		reason:
			"namespace-write kind (tools/importOkfBundle.ts:88); no verifiedOrg forwarded",
	},
	"validate_okf_bundle|okfBundleNode:validateOkfBundle": {
		class: "unmeasured",
		severity: null,
		basis: "unread",
		reason: "MCP kind public (tools/validateOkfBundle.ts:83); handler not read",
	},
	"briefing-note.ts|briefingNotes:get": {
		class: "leak",
		severity: "High",
		basis: "args+gate",
		reason:
			"ui://vp/v1 resource: fetch bridge forwards no org (ui-resources has no verifiedOrg; server-http.ts:2273); KNOWN, fail-closed fix in PR #1636 not merged",
	},
	"briefing-note.ts|briefingNotes:list": {
		class: "leak",
		severity: "High",
		basis: "args+gate",
		reason:
			"ui://vp/v1 resource: fetch bridge forwards no org (ui-resources has no verifiedOrg; server-http.ts:2273); KNOWN, fail-closed fix in PR #1636 not merged",
	},
	"diary-entry.ts|diary:get": {
		class: "leak",
		severity: "High",
		basis: "args+gate",
		reason:
			"ui://vp/v1 resource: fetch bridge forwards no org (ui-resources has no verifiedOrg; server-http.ts:2273); KNOWN, fail-closed fix in PR #1636 not merged",
	},
	"diary-entry.ts|diary:list": {
		class: "leak",
		severity: "High",
		basis: "args+gate",
		reason:
			"ui://vp/v1 resource: fetch bridge forwards no org (ui-resources has no verifiedOrg; server-http.ts:2273); KNOWN, fail-closed fix in PR #1636 not merged",
	},
	"memory-quote.ts|memories:listMemories": {
		class: "leak",
		severity: "High",
		basis: "args+gate",
		reason:
			"ui://vp/v1 resource: fetch bridge forwards no org (ui-resources has no verifiedOrg; server-http.ts:2273); KNOWN, fail-closed fix in PR #1636 not merged",
	},
	"messages-feed.ts|messages:listMessages": {
		class: "leak",
		severity: "High",
		basis: "args+gate",
		reason:
			"ui://vp/v1 resource: fetch bridge forwards no org (ui-resources has no verifiedOrg; server-http.ts:2273); KNOWN, fail-closed fix in PR #1636 not merged",
	},
	"mission-timeline.ts|missions:list": {
		class: "leak",
		severity: "High",
		basis: "args+gate",
		reason:
			"ui://vp/v1 resource: fetch bridge forwards no org (ui-resources has no verifiedOrg; server-http.ts:2273); KNOWN, fail-closed fix in PR #1636 not merged",
	},
	"tasks-table.ts|tasks:list": {
		class: "leak",
		severity: "High",
		basis: "args+gate",
		reason:
			"ui://vp/v1 resource: fetch bridge forwards no org (ui-resources has no verifiedOrg; server-http.ts:2273); KNOWN, fail-closed fix in PR #1636 not merged",
	},
	"auth.ts|agentCredentials:resolveAgentCredential": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "keyed by the presented agent credential",
	},
	"auth.ts|oauth:getAccessTokenByHash": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "keyed by the bearer hash",
	},
	"auth.ts|clientOrgMapping:getByClerkSlug": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "keyed by the JWKS-verified org claim (http-boundary rule)",
	},
	"authorize.ts|oauth:putPersonCode": {
		class: "traced",
		severity: null,
		basis: "unread",
		reason: "keyed by the authorization code",
	},
	"authorize.ts|oauth:consumePersonCode": {
		class: "traced",
		severity: null,
		basis: "unread",
		reason: "keyed by the authorization code",
	},
	"authorize.ts|oauth:getClientByClientId": {
		class: "traced",
		severity: null,
		basis: "unread",
		reason: "keyed by the registered client id (authorize.ts:274)",
	},
	"authorize.ts|clientOrgMapping:getByClerkSlug": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "keyed by the verified org slug",
	},
	"authorize.ts|oauth:listPersonalAgentChoices": {
		class: "traced",
		severity: null,
		basis: "unread",
		reason: "keyed by the person subject; handler not read",
	},
	"actorFromAgentId.ts|<dynamic>": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"AGENT_DIRECTORY_DOOR keyed by the token hash; org derived by Convex (actorFromAgentId.ts:83-92)",
	},
	"registerTool.ts|memberWriterRoles:assertPersonMayWrite": {
		class: "traced",
		severity: null,
		basis: "unread",
		reason: "person-role check keyed by the verified person; handler not read",
	},
	"server-http.ts|oauth:getScopeProfile": {
		class: "traced",
		severity: null,
		basis: "unread",
		reason:
			"keyed by token / grant / client id; HTTP route gate not read in this sweep",
	},
	"server-http.ts|oauth:registerPublicClient": {
		class: "unmeasured",
		severity: null,
		basis: "unread",
		reason:
			"client/org administration over HTTP; the route gate (admin credential) was not read in this sweep",
	},
	"server-http.ts|oauth:getAccessTokenByHash": {
		class: "traced",
		severity: null,
		basis: "unread",
		reason:
			"keyed by token / grant / client id; HTTP route gate not read in this sweep",
	},
	"server-http.ts|oauth:getClientByClientId": {
		class: "traced",
		severity: null,
		basis: "unread",
		reason:
			"keyed by token / grant / client id; HTTP route gate not read in this sweep",
	},
	"server-http.ts|oauth:revokeAccessTokensForCode": {
		class: "traced",
		severity: null,
		basis: "unread",
		reason:
			"keyed by token / grant / client id; HTTP route gate not read in this sweep",
	},
	"server-http.ts|oauth:createAccessToken": {
		class: "traced",
		severity: null,
		basis: "unread",
		reason:
			"keyed by token / grant / client id; HTTP route gate not read in this sweep",
	},
	"server-http.ts|oauth:getRefreshTokenForGrant": {
		class: "traced",
		severity: null,
		basis: "unread",
		reason:
			"keyed by token / grant / client id; HTTP route gate not read in this sweep",
	},
	"server-http.ts|oauth:rotateRefreshToken": {
		class: "traced",
		severity: null,
		basis: "unread",
		reason:
			"keyed by token / grant / client id; HTTP route gate not read in this sweep",
	},
	"server-http.ts|oauth:createClient": {
		class: "unmeasured",
		severity: null,
		basis: "unread",
		reason:
			"client/org administration over HTTP; the route gate (admin credential) was not read in this sweep",
	},
	"server-http.ts|oauth:provisionOrganization": {
		class: "unmeasured",
		severity: null,
		basis: "unread",
		reason:
			"client/org administration over HTTP; the route gate (admin credential) was not read in this sweep",
	},
	"server-http.ts|oauth:listClients": {
		class: "unmeasured",
		severity: null,
		basis: "unread",
		reason:
			"client/org administration over HTTP; the route gate (admin credential) was not read in this sweep",
	},
	"server-http.ts|oauth:deleteClient": {
		class: "unmeasured",
		severity: null,
		basis: "unread",
		reason:
			"client/org administration over HTTP; the route gate (admin credential) was not read in this sweep",
	},
	"server-http.ts|oauth:seedDefaultProfiles": {
		class: "unmeasured",
		severity: null,
		basis: "unread",
		reason:
			"client/org administration over HTTP; the route gate (admin credential) was not read in this sweep",
	},
	"server-http.ts|oauth:patchScopeProfileEmergency": {
		class: "unmeasured",
		severity: null,
		basis: "unread",
		reason:
			"client/org administration over HTTP; the route gate (admin credential) was not read in this sweep",
	},
	"server-http.ts|oauth:patchClientScopeAndRefreshTokens": {
		class: "unmeasured",
		severity: null,
		basis: "unread",
		reason:
			"client/org administration over HTTP; the route gate (admin credential) was not read in this sweep",
	},
	"server-http.ts|oauth:revokeAccessTokensOnly": {
		class: "unmeasured",
		severity: null,
		basis: "unread",
		reason:
			"client/org administration over HTTP; the route gate (admin credential) was not read in this sweep",
	},
	"server-http.ts|<dynamic>": {
		class: "leak",
		severity: "High",
		basis: "args+gate",
		reason:
			"ui://vp/v1 resource: fetch bridge forwards no org (ui-resources has no verifiedOrg; server-http.ts:2273); KNOWN, fail-closed fix in PR #1636 not merged",
	},
	"backendContract.ts|<dynamic>": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "boot-time manifest read (meta:backendContract); no tenant data",
	},
};

const SOURCE_FILES = [
	"../tools.ts",
	"../tools/kbIngest.ts",
	"../tools/exportOkfBundle.ts",
	"../tools/importOkfBundle.ts",
	"../tools/validateOkfBundle.ts",
	"../ui-resources/index.ts",
	"../ui-resources/primitives/briefing-note.ts",
	"../ui-resources/primitives/diary-entry.ts",
	"../ui-resources/primitives/memory-quote.ts",
	"../ui-resources/primitives/messages-feed.ts",
	"../ui-resources/primitives/mission-timeline.ts",
	"../ui-resources/primitives/tasks-table.ts",
	"../auth.ts",
	"../authorize.ts",
	"../actorFromAgentId.ts",
	"../registerTool.ts",
	"../../server-http.ts",
	"../backendContract.ts",
];

const CALL_SITE =
	/(convex\.(?:query|mutation|action)\(|internalClient\(\)\.(?:query|mutation|action)\(|\bclient\.query\(|\bfetchConvex\()/;
const DEFINE_TOOL = /^\s*defineTool\(/;
const NAME_LINE = /^\s*("[a-z_0-9]+"|[A-Z_]+),\s*$/;
const CONST_VALUE = /const ([A-Z_]+)\s*=\s*"([a-z_0-9]+)"/g;
const CONVEX_FN = /"([a-zA-Z]+:[a-zA-Z0-9_]+)"/;
const NAME_WINDOW = 45;
const FN_WINDOW = 7;

/** Enumerates the Convex call sites of one source file by the rules in the header. */
function enumerateConvexCallSites(source: string, file: string): CallSite[] {
	const lines = source.split("\n");
	const consts = new Map<string, string>();
	for (const m of source.matchAll(CONST_VALUE)) consts.set(m[1], m[2]);
	const basename = file.split("/").pop() ?? file;
	let owner = basename;
	const sites: CallSite[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (DEFINE_TOOL.test(line)) {
			owner = `UNNAMED-defineTool@${i + 1}`;
			for (
				let j = i + 1;
				j < Math.min(i + NAME_WINDOW + 1, lines.length);
				j++
			) {
				const m = NAME_LINE.exec(lines[j]);
				if (m) {
					const tok = m[1];
					const resolved = tok.startsWith('"')
						? tok.slice(1, -1)
						: consts.get(tok);
					if (resolved !== undefined) owner = resolved;
					break;
				}
			}
			continue;
		}
		if (!CALL_SITE.test(line)) continue;
		if (
			/fetchConvex\s*:\s*\(/.test(line) ||
			line.includes("convexQuery: (name")
		)
			continue;
		const block = lines.slice(i, i + FN_WINDOW).join("\n");
		const fnMatch = CONVEX_FN.exec(block);
		const fn = fnMatch ? fnMatch[1] : "<dynamic>";
		sites.push({ file, line: i + 1, owner, fn, key: `${owner}|${fn}` });
	}
	return sites;
}

function liveSites(): CallSite[] {
	return SOURCE_FILES.flatMap((rel) => {
		const abs = resolve(__dirname, rel);
		return enumerateConvexCallSites(readFileSync(abs, "utf-8"), rel);
	});
}

describe("Convex call-site scope classification (task k1730pg1m870s58x99jq5x2ycd8hc72b)", () => {
	it("pole: a planted unscoped call under a new tool is reported unclassified", () => {
		const fixture = [
			"defineTool(",
			"\tserver,",
			"\tauthCtx,",
			'\t{ kind: "filtered", reason: "fixture" },',
			'\t"planted_unscoped_door",',
			'\t"fixture description",',
			"\t{},",
			"\tasync () => {",
			'\t\tawait convex.query("tasks:list" as any, {});',
			"\t},",
			");",
		].join("\n");
		const sites = enumerateConvexCallSites(fixture, "fixture.ts");
		const unclassified = sites
			.map((s) => s.key)
			.filter((k) => SCOPE_CLASSIFICATION[k] === undefined);
		expect(unclassified).toEqual(["planted_unscoped_door|tasks:list"]);
	});

	it("every production Convex call site has a declared scope classification", () => {
		const unclassified = liveSites()
			.filter((s) => SCOPE_CLASSIFICATION[s.key] === undefined)
			.map((s) => `${s.file}:${s.line} ${s.key}`);
		expect(unclassified).toEqual([]);
	});

	it("no stale classification: every declared key is still a live call site", () => {
		const live = new Set(liveSites().map((s) => s.key));
		const stale = Object.keys(SCOPE_CLASSIFICATION).filter((k) => !live.has(k));
		expect(stale).toEqual([]);
	});

	it("every classification is well-formed (class, severity for leaks, non-empty reason)", () => {
		const malformed: string[] = [];
		for (const [key, c] of Object.entries(SCOPE_CLASSIFICATION)) {
			if (!SCOPE_CLASSES.includes(c.class))
				malformed.push(`${key}: class ${c.class}`);
			if (c.class === "leak" && c.severity === null)
				malformed.push(`${key}: leak without severity`);
			if (c.class !== "leak" && c.severity !== null)
				malformed.push(`${key}: severity on ${c.class}`);
			if (c.reason.trim().length < 20)
				malformed.push(`${key}: reason too short`);
			if (/TODO|FIXME/.test(c.reason))
				malformed.push(`${key}: placeholder in reason`);
		}
		expect(malformed).toEqual([]);
	});
});
