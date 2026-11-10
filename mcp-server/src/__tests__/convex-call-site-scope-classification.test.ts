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
 * Scanned files are DERIVED, never listed: the test walks mcp-server/src
 * recursively (tests, `__tests__`, `*.test.ts` and `*.d.ts` excluded) plus
 * mcp-server/server-http.ts and server.ts, and FAILS if the walk finds no
 * file. A new file, or an existing file nobody listed, is scanned by default.
 *
 * Call forms used in the tree (enumerated by grep over those files, 2026-11-03):
 *   1. `convex.query|mutation|action(`          the per-request client
 *   2. `internalClient().query|mutation|action(` server-http.ts, own identity
 *   3. `client.query(`                          boot manifest, backendContract.ts
 *   4. `deps.convexQuery(`                      injected caller (state-tokens.ts,
 *                                               fresh-state-guard.ts); the
 *                                               injection point in tools.ts is
 *                                               form 1 and is classified itself
 *   5. `fetchConvex(`                           ui-resources bridge; the bridge
 *                                               body in register.ts is form 1
 *   The matcher is `.query|mutation|action(` on ANY receiver (so a renamed
 *   client variable is still a site), plus `convexQuery|convexMutation|
 *   convexAction(` and `fetchConvex(` in call form. Not sites: `c.req.query(`
 *   (the HTTP framework's query string) and type members such as
 *   `fetchConvex: (`.
 *
 * Enumeration rules:
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

import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
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
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:2462: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/memories.ts:62: acting for A cannot write into B's namespace, a write into A's stamps A; pinned by convex/__tests__/actingOrgIsolation.test.ts:409-421",
	},
	"soft_delete_memory|memories:softDeleteMemory": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master: non-master refused before Convex (tools.ts:2490)",
	},
	"erase_memory|memories:redactMemoryContent": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"Clerk-JWT bearer only (tools.ts erase_memory, clerkJwt branch): the client forwards the caller's OWN session JWT, so Convex resolves the caller's org and role from the claims (convex/memories.ts redactMemoryContent, resolveSessionCaller); an org admin erases any row of its org, a member only the rows it authored, the row's stored org ID must equal the caller's; pinned by convex/__tests__/redactMemoryContent.test.ts",
	},
	"erase_memory|memories:redactMemoryContentAsPerson": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"person bearer (tools.ts erase_memory): verifiedPerson = the bearer hash from the verified context via doorScope (DOOR_SCOPE memories:redactMemoryContentAsPerson); Convex re-reads subject, org and role from the token row, proves the person in its org by ID, admits an org admin or the row's author only, and compares the row's stored org ID; pinned by convex/__tests__/redactMemoryContentAsPerson.test.ts",
	},
	"erase_memory|memories:redactMemoryContentAsAgent": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"seat (tools.ts erase_memory, no person bearer): verifiedActor = the agent ID the transport verified, passed from the verified context (verifiedActorOf), never an argument; Convex (resolveEraseCaller) accepts it from the service account acting for an org only, judges it by the one agent-proof check and erases only the memories whose stored createdById is that agent, in the row's own organisation; pinned by convex/__tests__/eraseRow.test.ts and the seat two-pole sweep",
	},
	"erase_row|erase:eraseRow": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"decided by the door (convex/erase.ts, lib/eraseRow.ts): the caller is derived from the proof the call carries (verifiedPerson = the bearer hash from the verified context via doorScope, verifiedActor = the agent ID added by the wrapped client, or a Clerk-JWT bearer's own session), the row's stored org ID must equal the caller's, and only an org admin or the row's stored author is served; pinned by convex/__tests__/eraseRow.test.ts (every covered table) and the seat two-pole sweep",
	},
	"erase_fix_pattern|fixPatterns:erase": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"decided by the door (convex/fixPatterns.ts erase, lib/eraseRow.ts assertMayErase): the caller is derived from the proof the call carries (verifiedPerson = the bearer hash from the verified context via doorScope, verifiedActor = the agent ID added by the wrapped client, or a Clerk-JWT bearer's own session); the pattern's owning organisation is the operator org, so a client organisation's caller is refused by ID, and only an operator-org admin is served (a pattern carries no author ID); pinned by convex/__tests__/fixPatternErase.test.ts and the seat two-pole sweep",
	},
	"get_memory|memories:getMemory": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:2572: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/memories.ts:212 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
	},
	"recall|search:recall": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:2635: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/search.ts:219: convex/search.ts:184-200 resolveSearchNamespace refuses a namespace outside the caller's own team subtree; pinned by convex/__tests__/actingOrgSearch.test.ts:113-139",
	},
	"text_search|search:textSearch": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:2700: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/search.ts:285: convex/search.ts:184-200 resolveSearchNamespace refuses a namespace outside the caller's own team subtree; pinned by convex/__tests__/actingOrgSearch.test.ts:113-139",
	},
	"hybrid_search|search:hybridSearch": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:2773: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/search.ts:346: convex/search.ts:184-200 resolveSearchNamespace refuses a namespace outside the caller's own team subtree; pinned by convex/__tests__/actingOrgSearch.test.ts:113-139",
	},
	"store_episode|episodes:storeEpisode": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:2845: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/episodes.ts:25: acting for A cannot write into B's namespace; pinned by convex/__tests__/actingOrgIsolation.test.ts:423-430",
	},
	"get_episode|memories:getMemory": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg 'always' + unresolvedOrgDenial (tools.ts:2870-2872)",
	},
	"list_episodes|memories:listMemories": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:3009: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/memories.ts:327 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
	},
	"search_episodes_by_keyword|search:textSearch": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:3096: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/search.ts:285: convex/search.ts:184-200 resolveSearchNamespace refuses a namespace outside the caller's own team subtree; pinned by convex/__tests__/actingOrgSearch.test.ts:113-139",
	},
	"search_episodes_by_semantic|search:recall": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:3157: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/search.ts:219: convex/search.ts:184-200 resolveSearchNamespace refuses a namespace outside the caller's own team subtree; pinned by convex/__tests__/actingOrgSearch.test.ts:113-139",
	},
	"get_profile|profiles:getProfile": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:3212: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/profiles.ts:179 requires the orchestrator on the caller's org roster (convex/profiles.ts:200-225) and reads the row by agent ID in the caller's own org (convex/profiles.ts:111-117); measured with a throwaway probe test: acting for A asking for B's orchestrator returns RBAC_DENIED; convex/__tests__/profilesById.test.ts passes",
	},
	"update_profile|profiles:upsertProfile": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:3306: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/profiles.ts:256 writes via writerOf (convex/profiles.ts:57-76), which refuses a call naming another agent; measured with a throwaway probe test: acting for A on B's orchestrator returns RBAC_DENIED, B's profile unchanged",
	},
	"list_memories|memories:listMemories": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:3420: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/memories.ts:327 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
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
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:4172: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/profiles.ts:319 writes via writerOf (convex/profiles.ts:57-76); measured with a throwaway probe test: acting for A on B's orchestrator returns RBAC_DENIED, B's profile unchanged",
	},
	"list_peers|profiles:listProfiles": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:4278: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/profiles.ts:499 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
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
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:5152: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/tasks.ts:5701: the acting scope is not fleet-read, so the org check applies; pinned by convex/__tests__/actingOrgIsolation.test.ts:479-503 (org-B run not served)",
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
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:6244: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/tasks.ts:4311 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
	},
	"create_mission|missions:create": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedPerson / verifiedOrg unless-person (tools.ts:6325)",
	},
	"list_missions|missions:list": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:6495: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/missions.ts:771 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
	},
	"get_mission|missions:get": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:6580: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/missions.ts:409 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
	},
	"update_mission|missions:update": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:6672: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/missions.ts:822 checks the mission's org against the scope (convex/missions.ts:875-899); measured with a throwaway probe test: acting for A on B's mission returns RBAC_DENIED, name unchanged",
	},
	"update_mission_status|missions:updateStatus": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts:6668)",
	},
	"write_diary|diary:write": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:6793: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/diary.ts:205 resolves the tenant scope and refuses another org's orchestrator (convex/diary.ts:233-300); measured with a throwaway probe test: acting for A naming B's orchestrator returns RBAC_DENIED, B's entry unchanged",
	},
	"get_diary|diary:get": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:6860: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/diary.ts:337 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
	},
	"list_diaries|diary:list": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:6991: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/diary.ts:415 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
	},
	"create_briefing_note|briefingNotes:create": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always + unresolvedOrgDenial (tools.ts:7012-7015)",
	},
	"update_briefing_note|briefingNotes:update": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:7171: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/briefingNotes.ts:1118: acting for A cannot change B's note; pinned by convex/__tests__/actingOrgIsolation.test.ts:455-463",
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
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:7614: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/recurringTasks.ts:211 stamps the row with the scope's own org for a non-master (convex/recurringTasks.ts:263-272); measured with a throwaway probe test: acting call without the agent credential returns AGENT_CREDENTIAL_REQUIRED, nothing written",
	},
	"list_recurring_tasks|recurringTasks:list": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:7703: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/recurringTasks.ts:337 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
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
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:7940: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/recurringTasks.ts:1075 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
	},
	"update_recurring_task|recurringTasks:update": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:7963: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/recurringTasks.ts:471: acting for A cannot change B's row; pinned by convex/__tests__/actingOrgIsolation.test.ts:432-441",
	},
	"create_mandate|mandates:create": {
		class: "safe",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:8047: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/mandates.ts:99 fleet-only (convex/mandates.ts:33-45); pinned: acting call refused RBAC_DENIED (convex/__tests__/actingOrgIsolation.test.ts:443-453)",
	},
	"accept_mandate|mandates:accept": {
		class: "safe",
		severity: null,
		basis: "measured",
		reason:
			"convex/mandates.ts:190-201: only the fulfilling agent (verifiedActor) may accept",
	},
	"update_mandate|mandates:update": {
		class: "safe",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:8165: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/mandates.ts:221 calls requireFleetMaster (convex/mandates.ts:33-45, :235); measured with a throwaway probe test: acting for A on B's mandate returns RBAC_DENIED, row unchanged",
	},
	"settle_mandate|mandates:settle": {
		class: "safe",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:8215: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/mandates.ts:285 calls requireFleetMaster (convex/mandates.ts:33-45, :296); measured with a throwaway probe test: acting for A on B's mandate returns RBAC_DENIED, row unchanged",
	},
	"validate_mandate_spending|mandates:validateSpending": {
		class: "safe",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:8269: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/mandates.ts:534 fleet-only (convex/mandates.ts:545-553); pinned: acting call on B's mandate refused RBAC_DENIED (convex/__tests__/actingOrgIsolation.test.ts:443-453)",
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
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:8469: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/mandates.ts:341 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
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
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:9342: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/githubOwnerBinding.ts:151 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
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
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"MCP site tools.ts:9869: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/fixPatterns.ts:44 calls requireFleetMaster (convex/fixPatterns.ts:24-37), which refuses a non-master acting scope; outcome equals the org-A member's (convex/__tests__/actingOrgIsolation.test.ts:466-477)",
	},
	"add_fix_attempt|fixPatterns:addAttempt": {
		class: "safe",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:9922: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/fixPatterns.ts:94 calls requireFleetMaster (convex/fixPatterns.ts:24-37); measured with a throwaway probe test: acting for A on B's pattern returns RBAC_DENIED, no fixAttempts row written",
	},
	"validate_fix|fixPatterns:validate": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts registration)",
	},
	"search_fix_patterns|search:searchFixPatterns": {
		class: "safe",
		severity: null,
		basis: "measured",
		reason:
			'MCP site tools.ts:10013, tools.ts:10048: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller\'s org (convex/lib/auth.ts:376-413). Convex convex/search.ts:421 resolves the constant namespace "fixpatterns" through resolveSearchNamespace (convex/search.ts:441-479), refused for any org member; pinned by convex/__tests__/searchNamespaceAuthorityEndToEnd.test.ts:364-',
	},
	"list_fix_patterns|fixPatterns:listByProject": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:10152: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/fixPatterns.ts:365 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
	},
	"list_fix_patterns|fixPatterns:listAll": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:10180: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/fixPatterns.ts:432 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
	},
	"link_issue_to_pattern|fixPatterns:linkIssue": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "MCP kind master (tools.ts registration)",
	},
	"get_mission_template|missionTemplates:getByName": {
		class: "safe",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:10286: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/missionTemplates.ts:120 masterOnly (convex/missionTemplates.ts:124-127); measured with a throwaway probe test: acting call returns RBAC_DENIED",
	},
	"update_mission_template|missionTemplates:upsert": {
		class: "safe",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:10381: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/missionTemplates.ts:213 refuses non-master (convex/missionTemplates.ts:227-231); measured with a throwaway probe test: acting call returns RBAC_DENIED",
	},
	"instantiate_template_into_mission|missions:get": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:10472: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/missions.ts:409 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
	},
	"instantiate_template_into_mission|missionTemplates:instantiateTemplateIntoMission":
		{
			class: "traced",
			severity: null,
			basis: "args+gate",
			reason:
				"MCP site tools.ts:10486: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/missionTemplates.ts:424 refuses a mission outside the caller's org by ID (convex/missionTemplates.ts:445-474, reason mission-not-in-caller-org) and writes the tasks under the caller's own org; pinned for a Clerk member of org B by convex/__tests__/missionTemplatesById.test.ts:217-229. The acting-org call itself was not run against this door (inferred from the identity layer giving the same member scope)",
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
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:11217: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/tasks.ts:1212 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
	},
	"get_fix_pattern|fixPatterns:get": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:11278: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/fixPatterns.ts:233 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
	},
	"get_mandate|mandates:get": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:11325: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/mandates.ts:504 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
	},
	"get_repo_mapping|githubRepoMapping:getByRepo": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:11388: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/githubRepoMapping.ts:108 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
	},
	"get_message|messages:getById": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"doorScopeArgs verifiedOrg always + unresolvedOrgDenial (tools.ts:11227-11229)",
	},
	"get_recurring_task|recurringTasks:getById": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site tools.ts:11541: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/recurringTasks.ts:1075 narrows by withOrgScope under the acting org; pinned: acting call never returns an org-B row and equals the org-A member answer (convex/__tests__/actingOrgIsolation.test.ts:352-386)",
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
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site exportOkfBundle.ts:145: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/okfBundleNode.ts:290: assertCanExportNamespace admits only team/<own org> to a member (convex/okfBundleNode.ts:248-282); pinned by convex/__tests__/actingOrgOkf.test.ts (B's namespace refused RBAC_DENIED)",
	},
	"import_okf_bundle|okfBundleNode:importOkfBundle": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"MCP site importOkfBundle.ts:103: the client carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/okfBundleNode.ts:959: namespace gate as export plus storage ownership by the resolved org (convex/okfBundleNode.ts:750-771, 1006-1027); pinned by convex/__tests__/actingOrgOkf.test.ts",
	},
	"validate_okf_bundle|okfBundleNode:validateOkfBundle": {
		class: "unmeasured",
		severity: null,
		basis: "unread",
		reason: "MCP kind public (tools/validateOkfBundle.ts:83); handler not read",
	},
	"briefing-note.ts|briefingNotes:get": {
		class: "traced",
		severity: null,
		basis: "args+gate",
		reason:
			"ui://vp/v1 resource read: register.ts:96 refuses a non-master bearer whose org did not resolve before any Convex query; a resolved bearer's client carries __actingOrg on every call (test/ui-resource-read-org-scoped.test.ts, per primitive, two-org fake)",
	},
	"briefing-note.ts|briefingNotes:list": {
		class: "traced",
		severity: null,
		basis: "args+gate",
		reason:
			"ui://vp/v1 resource read: register.ts:96 refuses a non-master bearer whose org did not resolve before any Convex query; a resolved bearer's client carries __actingOrg on every call (test/ui-resource-read-org-scoped.test.ts, per primitive, two-org fake)",
	},
	"diary-entry.ts|diary:get": {
		class: "traced",
		severity: null,
		basis: "args+gate",
		reason:
			"ui://vp/v1 resource read: register.ts:96 refuses a non-master bearer whose org did not resolve before any Convex query; a resolved bearer's client carries __actingOrg on every call (test/ui-resource-read-org-scoped.test.ts, per primitive, two-org fake)",
	},
	"diary-entry.ts|diary:list": {
		class: "traced",
		severity: null,
		basis: "args+gate",
		reason:
			"ui://vp/v1 resource read: register.ts:96 refuses a non-master bearer whose org did not resolve before any Convex query; a resolved bearer's client carries __actingOrg on every call (test/ui-resource-read-org-scoped.test.ts, per primitive, two-org fake)",
	},
	"memory-quote.ts|memories:listMemories": {
		class: "traced",
		severity: null,
		basis: "args+gate",
		reason:
			"ui://vp/v1 resource read: register.ts:96 refuses a non-master bearer whose org did not resolve before any Convex query; a resolved bearer's client carries __actingOrg on every call (test/ui-resource-read-org-scoped.test.ts, per primitive, two-org fake)",
	},
	"messages-feed.ts|messages:listMessages": {
		class: "traced",
		severity: null,
		basis: "args+gate",
		reason:
			"ui://vp/v1 resource read: register.ts:96 refuses a non-master bearer whose org did not resolve before any Convex query; a resolved bearer's client carries __actingOrg on every call (test/ui-resource-read-org-scoped.test.ts, per primitive, two-org fake)",
	},
	"mission-timeline.ts|missions:list": {
		class: "traced",
		severity: null,
		basis: "args+gate",
		reason:
			"ui://vp/v1 resource read: register.ts:96 refuses a non-master bearer whose org did not resolve before any Convex query; a resolved bearer's client carries __actingOrg on every call (test/ui-resource-read-org-scoped.test.ts, per primitive, two-org fake)",
	},
	"tasks-table.ts|tasks:list": {
		class: "traced",
		severity: null,
		basis: "args+gate",
		reason:
			"ui://vp/v1 resource read: register.ts:96 refuses a non-master bearer whose org did not resolve before any Convex query; a resolved bearer's client carries __actingOrg on every call (test/ui-resource-read-org-scoped.test.ts, per primitive, two-org fake)",
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
	"authorize.ts|oauth:getDocumentClientDenial": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"keyed by the client_id URL the caller presented; service-account gated, an unresolved caller RAISES RBAC_DENIED (convex/oauth.ts getDocumentClientDenial); the answer is a deny-list entry, not tenant data",
	},
	"authorize.ts|clientOrgMapping:getByClerkOrgId": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"keyed by the verified Clerk org id of a membership (service-account gated, convex/clientOrgMapping.ts getByClerkOrgId)",
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
	"register.ts|<dynamic>": {
		class: "traced",
		severity: null,
		basis: "args+gate",
		reason:
			"ui://vp/v1 fetch bridge (register.ts:104), the successor of the server-http.ts bridge: isUiResourceReadAdmitted gate at register.ts:96 runs before any Convex query; a resolved bearer's client carries __actingOrg (test/ui-resource-read-org-scoped.test.ts)",
	},
	"block_task|tasks:getById": {
		class: "traced",
		severity: null,
		basis: "args+gate",
		reason:
			"read-back after tasks:update on the same taskId with doorScopeArgs (tools.ts:6062): a foreign-tenant row never reaches it; the door itself narrows by withOrgScope + isRowVisibleToScope (convex/tasks.ts:1329); only dependsOn ids are returned (tools.ts:6069)",
	},
	"add_task_dependency|tasks:getById": {
		class: "traced",
		severity: null,
		basis: "args+gate",
		reason:
			"read-back after tasks:update on the same taskId with doorScopeArgs (tools.ts:6145); the door narrows by isRowVisibleToScope (convex/tasks.ts:1329); only dependsOn ids are returned (tools.ts:6147)",
	},
	"get_tool_usage|toolUsage:getToolUsage": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"toolUsageReadArgs (toolUsage.ts:119) forwards doorScopeArgs verifiedOrg and refuses a bearer that resolves no identity; the Convex door raises RBAC_DENIED for a foreign caller or non-admin (convex/toolUsage.ts:321-338); call at tools.ts:10924",
	},
	"get_owner_tool_usage|toolUsage:usageByOwner": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason:
			"toolUsageReadArgs (toolUsage.ts:119) forwards doorScopeArgs verifiedOrg and refuses an unidentified bearer; the Convex door refuses an owner outside the organisation with RBAC_DENIED (convex/toolUsage.ts:385-405); call at tools.ts:10986",
	},
	"toolUsage.ts|toolUsage:record": {
		class: "safe",
		severity: null,
		basis: "measured",
		reason:
			"toolUsage.ts:71 (Clerk session: no key, Convex derives subject and org from the JWT) and :88 (other bearer: verifiedOrg or the person's token proof, no row returned); convex/toolUsage.ts:104 resolves the caller through resolveReader (convex/toolUsage.ts:90-100 refuses a claimless service account) and writes a counter under the resolved org only (convex/toolUsage.ts:117-138); fire-and-forget, returns {recorded}; convex/__tests__/toolUsage.test.ts passes (25 tests with the probe)",
	},
	"state-tokens.ts|tasks:get": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"state-tokens.ts:287 deps.convexQuery('tasks:get'); the injected caller is tools.ts:3606 (send_message), the client is the request's convex (tools.ts), which carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/tasks.ts:1096 returns null unless isRowVisibleToScope (convex/tasks.ts:1203); measured with a throwaway probe test: acting for A on org B's task returns null, on A's own returns the row",
	},
	"fresh-state-guard.ts|tasks:get": {
		class: "traced",
		severity: null,
		basis: "measured",
		reason:
			"fresh-state-guard.ts:496 deps.convexQuery(taskQueryName ?? 'tasks:get'); taskQueryName is set by no production caller (grep over mcp-server/src and server-http.ts), the injected caller is tools.ts:3642 (send_message), the client is the request's convex (tools.ts), which carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268), so Convex answers as an ordinary member of the caller's org (convex/lib/auth.ts:376-413). Convex convex/tasks.ts:1096 returns null for a foreign row (convex/tasks.ts:1203); same probe as state-tokens.ts",
	},
	"send_message|<dynamic>": {
		class: "traced",
		severity: null,
		basis: "args+gate",
		reason:
			"tools.ts:3606 and :3642: the injection points of deps.convexQuery for resolveStateTokens and guardFreshState, the client is the request's convex, which carries __actingOrg on every call (authenticatedConvexClient.ts:111,144-151; server-http.ts:2268); the only function the two consumers query is tasks:get (state-tokens.ts:287, fresh-state-guard.ts:496), classified above",
	},
	"backendContract.ts|<dynamic>": {
		class: "safe",
		severity: null,
		basis: "args+gate",
		reason: "boot-time manifest read (meta:backendContract); no tenant data",
	},
};

const SRC_DIR = resolve(__dirname, "..");
const ROOT_FILES = ["server-http.ts", "server.ts"];

/** Production TypeScript under `dir`: tests, __tests__ and declaration files out. */
function walkProductionSources(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__" || entry.name === "node_modules") continue;
			walkProductionSources(abs, out);
		} else if (
			entry.name.endsWith(".ts") &&
			!entry.name.endsWith(".test.ts") &&
			!entry.name.endsWith(".d.ts")
		) {
			out.push(abs);
		}
	}
	return out;
}

/** The scanned set: the walk of `srcDir` plus the entry points one level above it. */
function scannedFiles(srcDir: string): string[] {
	const files = [
		...walkProductionSources(srcDir),
		...ROOT_FILES.map((f) => join(srcDir, "..", f)),
	];
	return files.sort();
}

const CALL_SITE =
	/(?<!\breq)\.(?:query|mutation|action)\(|\bconvex(?:Query|Mutation|Action)\(|\bfetchConvex\(/;
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
		const trimmed = line.trimStart();
		if (
			trimmed.startsWith("//") ||
			trimmed.startsWith("*") ||
			trimmed.startsWith("/*")
		)
			continue;
		if (!CALL_SITE.test(line)) continue;
		if (/fetchConvex\s*:\s*\(/.test(line)) continue;
		const block = lines.slice(i, i + FN_WINDOW).join("\n");
		const fnMatch = CONVEX_FN.exec(block);
		const fn = fnMatch ? fnMatch[1] : "<dynamic>";
		sites.push({ file, line: i + 1, owner, fn, key: `${owner}|${fn}` });
	}
	return sites;
}

function liveSitesIn(srcDir: string): CallSite[] {
	return scannedFiles(srcDir).flatMap((abs) => {
		const rel = relative(__dirname, abs).split("\\").join("/");
		return enumerateConvexCallSites(readFileSync(abs, "utf-8"), rel);
	});
}

function liveSites(): CallSite[] {
	return liveSitesIn(SRC_DIR);
}

/** A throwaway tree shaped like mcp-server/src, for the walker poles. */
function withScratchTree<T>(
	files: Record<string, string>,
	run: (srcDir: string) => T,
): T {
	const root = mkdtempSync(join(tmpdir(), "vp-callsite-"));
	try {
		const srcDir = join(root, "src");
		mkdirSync(srcDir, { recursive: true });
		for (const [name, text] of Object.entries(files)) {
			const abs = join(srcDir, name);
			mkdirSync(join(abs, ".."), { recursive: true });
			writeFileSync(abs, text);
		}
		for (const f of ROOT_FILES) writeFileSync(join(root, f), "export {};\n");
		return run(srcDir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const unclassifiedKeys = (sites: CallSite[]) =>
	sites.map((x) => x.key).filter((k) => SCOPE_CLASSIFICATION[k] === undefined);

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

	it("the walk finds files; an empty walk fails instead of passing", () => {
		expect(scannedFiles(SRC_DIR).length).toBeGreaterThan(20);
		expect(() =>
			withScratchTree({}, (dir) => {
				const found = walkProductionSources(dir);
				if (found.length === 0) throw new Error("walk found zero source files");
			}),
		).toThrow("zero source files");
	});

	it("pole: a planted call in an existing file nobody listed is unclassified", () => {
		const text = `export async function f(convex: any) {\n\tawait convex.query("tasks:list" as any, {});\n}\n`;
		const keys = withScratchTree({ "toolUsageLike.ts": text }, (d) =>
			unclassifiedKeys(liveSitesIn(d)),
		);
		expect(keys).toEqual(["toolUsageLike.ts|tasks:list"]);
	});

	it("pole: a planted call in a NEW file under a new directory is unclassified", () => {
		const text = `export const g = (client: any) => client.mutation("tasks:update" as any, {});\n`;
		const keys = withScratchTree({ "newdir/brand-new.ts": text }, (d) =>
			unclassifiedKeys(liveSitesIn(d)),
		);
		expect(keys).toEqual(["brand-new.ts|tasks:update"]);
	});

	it("pole: a planted call in the injected-caller form deps.convexQuery is unclassified", () => {
		const text = `export async function h(deps: any) {\n\treturn await deps.convexQuery("tasks:get", {});\n}\n`;
		const keys = withScratchTree({ "injected.ts": text }, (d) =>
			unclassifiedKeys(liveSitesIn(d)),
		);
		expect(keys).toEqual(["injected.ts|tasks:get"]);
	});

	it("c.req.query( (HTTP framework) is not a Convex call site", () => {
		const text = `export const q = (c: any) => c.req.query("x");\n`;
		expect(withScratchTree({ "http.ts": text }, (d) => liveSitesIn(d))).toEqual(
			[],
		);
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
