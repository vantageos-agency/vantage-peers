/**
 * VantagePeers MCP Tool Registrations
 *
 * This module exports registerTools(server, convex) — a single function that
 * registers all 82 tools against any McpServer instance with a given
 * ConvexHttpClient. Both the stdio entry point (server.ts) and the HTTP entry
 * point (server-http.ts) call this function so tool definitions are never
 * duplicated.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/server";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import {
	passesScopeFilter,
	scopeFilterGet,
	scopeFilterList,
} from "@vantageos/cloud-identity";
import type { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import {
	actingClaimRefusal,
	checkDelegationAllowed,
	checkInstanceOfSender,
	checkNamespaceRead,
	checkNamespaceWrite,
	defaultWriteNamespace,
	filterRowsToActorTenant,
	isMasterScope,
	NO_CONTEXT_REFUSAL,
	namespaceRequiredRefusal,
	type OAuthContext,
	PERSON_ACTOR_PREFIX,
	personActorOf,
	resolveSeatOrg,
	rowVisibleToActorTenant,
	toPackageOAuthCtx,
	type WriteSpace,
	writableNamespacesOf,
} from "./auth.js";
import {
	type DoorScopeArgs,
	type DoorScopeFacts,
	resolveDoorScope,
	verifiedOrgIdOf,
	verifiedOrgSlugOf,
} from "./doorScope.js";
import {
	BareStateLiteralError,
	FreshStateGuardError,
	guardFreshState,
} from "./fresh-state-guard.js";
import { listTasksGate } from "./list-tasks-gate.js";
import { memberAuthorLabel } from "./memberAuthor.js";
import {
	addRepoMappingServedOutputSchema,
	addTaskDependencyServedOutputSchema,
	billingSummaryByProjectServedOutputSchema,
	blockTaskServedOutputSchema,
	briefingNoteUpdatedServedOutputSchema,
	checkoutTaskServedOutputSchema,
	correctTaskSegmentServedOutputSchema,
	createBriefingNoteServedOutputSchema,
	createMissionServedOutputSchema,
	createRecurringTaskServedOutputSchema,
	createTaskServedOutputSchema,
	deleteMessageServedOutputSchema,
	deletedServedOutputSchema,
	getBriefingNoteServedOutputSchema,
	getBulkCompleteRunServedOutputSchema,
	getEpisodeServedOutputSchema,
	getFixPatternServedOutputSchema,
	getGithubOwnerBindingsServedOutputSchema,
	getMemoryServedOutputSchema,
	getMessageServedOutputSchema,
	getOwnerToolUsageServedOutputSchema,
	getRecurringTaskServedOutputSchema,
	getTaskServedOutputSchema,
	getToolUsageServedOutputSchema,
	hybridSearchServedOutputSchema,
	linkIssueToPatternServedOutputSchema,
	listBlockedOnMeServedOutputSchema,
	listBriefingNotesServedOutputSchema,
	listBroadcastStatusServedOutputSchema,
	listDiariesServedOutputSchema,
	listEpisodesServedOutputSchema,
	listFixPatternsServedOutputSchema,
	listMemoriesServedOutputSchema,
	listMessagesServedOutputSchema,
	listMissionsServedOutputSchema,
	listPeersServedOutputSchema,
	listRecurringTasksServedOutputSchema,
	listRepoMappingsServedOutputSchema,
	listTasksByMissionServedOutputSchema,
	listTasksServedOutputSchema,
	markAsReadServedOutputSchema,
	missionStatusServedOutputSchema,
	missionUpdatedServedOutputSchema,
	pauseRecurringTaskServedOutputSchema,
	recallServedOutputSchema,
	removeRepoMappingServedOutputSchema,
	resumeRecurringTaskServedOutputSchema,
	searchBriefingNotesByKeywordServedOutputSchema,
	searchEpisodesByKeywordServedOutputSchema,
	searchEpisodesBySemanticServedOutputSchema,
	searchFixPatternsServedOutputSchema,
	searchMessagesByKeywordServedOutputSchema,
	searchTasksByKeywordServedOutputSchema,
	sendMessageServedOutputSchema,
	setSummaryServedOutputSchema,
	softDeleteMemoryServedOutputSchema,
	storeEpisodeServedOutputSchema,
	storeMemoryServedOutputSchema,
	taskClosedServedOutputSchema,
	taskStatusServedOutputSchema,
	taskUpdatedServedOutputSchema,
	textSearchServedOutputSchema,
	updateProfileServedOutputSchema,
	updateRecurringTaskServedOutputSchema,
	validateFixServedOutputSchema,
	writeDiaryServedOutputSchema,
} from "./outputSchemas.js";
import { normalizeOrchestratorId } from "./normalizeOrchestratorId.js";
import {
	clampLimit,
	decodeCursor,
	encodeCursor,
	scopedPageContinuation,
} from "./paging.js";
import { isRefusedEnvelope } from "./refusal.js";
import {
	arrayStructured,
	type CappedList,
	type PageStructured,
	pageStructured,
} from "./structuredResult.js";
import {
	defineTool,
	fromNotOnRosterRefusal,
	PERSON_NO_AGENT_STEP,
	type ToolAuthContext,
} from "./registerTool.js";
import { resolveStateTokens, StateTokenError } from "./state-tokens.js";
import { registerExportOkfBundle } from "./tools/exportOkfBundle.js";
import { registerImportOkfBundle } from "./tools/importOkfBundle.js";
import { registerKbIngestTools } from "./tools/kbIngest.js";
import { registerValidateOkfBundle } from "./tools/validateOkfBundle.js";
import { registerUiAppResources, withUiAppLink } from "./ui-resources/apps.js";
import type { VpToolResult } from "./ui-resources/schemas.js";
import { wrapToolResult } from "./ui-resources/stream-marker.js";
import { ERASE_ROW_TABLES } from "./eraseTables.js";
import { recordToolUsage, toolUsageReadArgs } from "./toolUsage.js";
import { validateTaskPayload } from "./validate-task-payload.js";
import { verifiedActorOf, withVerifiedActor } from "./verifiedActor.js";
import {
	idListSchema,
	statusListSchema,
	stringListSchema,
} from "./listArgs.js";
import { resolveActingAgent, resolveWhoamiIdentity } from "./whoamiIdentity.js";

// ─────────────────────────────────────────────────────────────────────────────
// VP_EMIT_UI_MARKERS gate
//
// When VP_EMIT_UI_MARKERS=1 the 6 list/get tools that have a matching
// ui:// primitive append a __VP_TOOL_RESULT__<json>__END__ marker after the
// existing JSON payload. The Gen UI iframe bridge detects this marker and
// renders the structured primitive inline. Default is OFF so prod behaviour
// is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

const UI_MARKERS_ENABLED =
	process.env.VP_EMIT_UI_MARKERS === "1" ||
	process.env.VP_EMIT_UI_MARKERS === "true";

/**
 * Absence-refuses sentinel for the package scope filters
 * (scopeFilterGet/scopeFilterList). It replaces the removed
 * `oauthCtx ?? DENIED_SCOPE_CTX` pattern, whose fallback resolved a MASTER
 * wildcard from an ABSENT context — the exact defect class
 * `.claude/rules/one-identity-layer.md` clause 3 forbids.
 *
 * A deny-everything context: empty allowlist, no read/write prefixes, not
 * master. Passing it to the package filters makes every row fail the visibility
 * predicate, so an absent oauthCtx REFUSES (empty result) instead of widening
 * to see everything. Production never hits it (HTTP always sets a context;
 * stdio passes LOCAL_STDIO_TRUST_CTX) — it is the structural floor that stops a
 * future path from landing on absence-as-master.
 */
const DENIED_SCOPE_CTX: OAuthContext = {
	clientId: "no-context-denied",
	userId: "no-context-denied",
	scopes: [],
	scopeProfile: "denied-no-context",
	fromAllowList: [],
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	expiresAt: 0,
	isMaster: false,
};

/**
 * Append a stream marker to a text response when UI markers are enabled.
 * `buildPayload` is called only when the flag is ON to avoid any overhead.
 */
function appendMarkerIfEnabled(
	text: string,
	buildPayload: () => VpToolResult | null,
): string {
	if (!UI_MARKERS_ENABLED) return text;
	try {
		const payload = buildPayload();
		if (payload === null) return text;
		return `${text}\n${wrapToolResult(payload)}`;
	} catch {
		// Never break the primary response — marker emission is best-effort.
		return text;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight content size guard
//
// Convex has a 1 MiB HTTP body limit. When MCP tools forward oversized
// `content` arguments, Convex returns an opaque "Server Error" that clients
// cannot interpret. We enforce a conservative 900 KB ceiling client-side so
// the caller receives an explicit InvalidParams error with byte-level detail
// and the recommended remediation (deliverable .md file pattern).
//
// 900,000 bytes ≈ 130,000 French words — far beyond any realistic briefing
// note, diary entry, memory snippet, or component source file. The 148 KB
// of headroom absorbs the JSON framing and other argument overhead before
// Convex's real 1,048,576-byte limit.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_CONTENT_BYTES = 900_000;

/**
 * Measure a string's UTF-8 byte length and throw an ProtocolError if it exceeds
 * MAX_CONTENT_BYTES. Returns the byte count on success so callers can reuse
 * it for observability in the catch path.
 *
 * @param content   The content string to measure.
 * @param toolName  Caller tool name (used only in the error message).
 */
export function assertContentSize(content: string, toolName: string): number {
	const contentBytes = new TextEncoder().encode(content).length;
	if (contentBytes > MAX_CONTENT_BYTES) {
		throw new ProtocolError(
			ProtocolErrorCode.InvalidParams,
			`[${toolName}] Content too large: ${contentBytes} bytes, max ${MAX_CONTENT_BYTES} bytes (~${Math.floor(
				MAX_CONTENT_BYTES / 6,
			)} words). Use deliverable .md file pattern for large content (commit to repo + reference from ${toolName}).`,
		);
	}
	return contentBytes;
}

// ─────────────────────────────────────────────────────────────────────────────
// List response byte cap (overflow protection for MCP clients)
//
// MCP clients (Claude.ai, ChatGPT, Claude Code) reject tool results that
// exceed their token budget — typical ceiling ~25k tokens ≈ 75 KB JSON.
// When that happens the entire response is lost to a downstream truncation
// error and the user must fall back to reading the on-disk overflow file.
//
// `capListResponseBytes` guards every bulk list_* tool: if the serialized
// payload exceeds MAX_LIST_RESPONSE_BYTES (60 KB), it truncates the items
// array (halving until it fits) and wraps the result in a _meta envelope
// that tells the caller exactly how to refine the query.
//
// 60 KB leaves headroom for tool-call JSON framing and the UI stream marker
// before any MCP client hits its own ceiling. The cap is byte-counted on the
// raw JSON string, not on item count, because content-heavy rows
// (memories / diaries / briefing notes) blow past 30 items easily.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_LIST_RESPONSE_BYTES = 60_000;

export function capListResponseBytes(
	items: unknown,
	rawText: string,
	toolName: string,
	maxBytes: number = MAX_LIST_RESPONSE_BYTES,
): string {
	return capListResponse(items, rawText, toolName, maxBytes).text;
}

/**
 * capListResponseBytes, also saying whether it cut and which rows the text it
 * returns shows (task k17592gg5t2tencwxks3kysghx8htqg8): the structuredContent
 * of a list is built from these, so it can never disagree with the text.
 * Uncut, `shown` is `items` when it is an array (else empty) and the text is
 * `rawText` unchanged.
 */
export function capListResponse(
	items: unknown,
	rawText: string,
	toolName: string,
	maxBytes: number = MAX_LIST_RESPONSE_BYTES,
): CappedList {
	const uncut = {
		text: rawText,
		shown: Array.isArray(items) ? items : [],
		truncated: false,
	};
	const byteLen = Buffer.byteLength(rawText, "utf8");
	if (byteLen <= maxBytes) return uncut;
	if (!Array.isArray(items) || items.length === 0) return uncut;

	let n = items.length;
	let truncated: unknown[] = items;
	let truncatedText = rawText;
	while (n > 1) {
		n = Math.max(1, Math.floor(n / 2));
		truncated = (items as unknown[]).slice(0, n);
		truncatedText = JSON.stringify(truncated, null, 2);
		if (Buffer.byteLength(truncatedText, "utf8") <= maxBytes - 600) break;
	}

	const envelope = {
		_meta: {
			_truncated: true,
			_showing: truncated.length,
			_total: (items as unknown[]).length,
			_bytesOriginal: byteLen,
			_bytesCap: maxBytes,
			_tool: toolName,
			_advice:
				`Response exceeded ${maxBytes} bytes. Showing first ${truncated.length}/${(items as unknown[]).length}. ` +
				`Pass fields="lite", a smaller limit, stricter filters (status, assignedTo, project, namespace, updatedSince), or paginate.`,
		},
		items: truncated,
	};
	return {
		text: JSON.stringify(envelope, null, 2),
		shown: truncated,
		truncated: true,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared Zod schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convex document IDs are 32 lowercase alphanumeric characters (a-z0-9).
 * Exported so tests can validate the schema independently of the MCP server.
 */
export const convexIdPattern = /^[a-z0-9]{32}$/;
export const receiptIdSchema = z
	.string()
	.regex(
		convexIdPattern,
		"receiptId must be a 32-char lowercase alphanumeric Convex ID",
	);

export const memoryIdSchema = z
	.string()
	.regex(
		convexIdPattern,
		"Invalid memory ID format (expected 32-char Convex ID)",
	);

/** Build a strict Convex document-ID schema with a field-named error message. */
const convexIdSchema = (field: string) =>
	z
		.string()
		.regex(
			convexIdPattern,
			`${field} must be a 32-char lowercase alphanumeric Convex ID`,
		);

export const taskIdSchema = convexIdSchema("taskId");
export const missionIdSchema = convexIdSchema("missionId");
export const messageIdSchema = convexIdSchema("messageId");
export const noteIdSchema = convexIdSchema("noteId");
export const componentIdSchema = convexIdSchema("componentId");
export const mandateIdSchema = convexIdSchema("mandateId");
export const patternIdSchema = convexIdSchema("patternId");
export const errorIdSchema = convexIdSchema("errorId");
export const recurringTaskIdSchema = convexIdSchema("recurringTaskId");
export const buIdSchema = convexIdSchema("buId");
export const episodeIdSchema = convexIdSchema("episodeId");
export const diaryIdSchema = convexIdSchema("diaryId");
export const debateRoomIdSchema = convexIdSchema("roomId");

const memoryTypeSchema = z
	.enum(["user", "feedback", "project", "reference", "episode"])
	.describe("Memory classification type");

const CREATED_BY_REQUIRED =
	"createdBy is required: name the orchestrator role this call acts as. Only a signed-in person (a dashboard session, or a person connected through the consent page) may omit it, and is then recorded under its own verified account.";

export const creatorSchema = z
	.string()
	.describe(
		"Orchestrator role name (e.g. pi, tau, phi, sigma, omega, zeta, eta, kappa, alpha, lambda, epsilon, omicron, upsilon, laurent, or any custom client role (lowercase string)). " +
			"New internal orchestrators use Greek letters (lowercase); external client orchestrators use free lowercase strings.",
	);

export const severitySchema = z
	.enum(["critical", "major", "minor"])
	.describe("Episode severity — critical = cross-orchestrator lesson");

// A JSON-string list and a bare string are normalised before validation (src/listArgs.ts).
export const flexArray = stringListSchema;
const flexArrayOptional = flexArray.optional();

// The artifact a task claims to deliver (an npm export today). Setting it makes
// the backend read the npm registry and record a delivery state beside the typed
// status; get_task/list_tasks then expose `deliverableDivergence`.
const deliverableSchema = z
	.object({
		pkg: z
			.string()
			.min(1)
			.max(214)
			.describe("Which npm package the task is meant to publish, e.g. '@vantageos/widget': the backend watches the npm registry for it to tell when the work has in fact shipped."),
		export: z
			.string()
			.min(1)
			.max(200)
			.describe("The name the published package must export, e.g. 'WidgetPanel': once a published version exports it while the task is still open, get_task reports deliverableDivergence='delivered-but-open', the cue that the task is in fact done."),
	})
	.strict()
	.optional()
	.describe(
		"Optional artifact this task delivers. The backend checks the npm registry (latest version) for the named export; get_task then shows deliverableState and deliverableDivergence='delivered-but-open' when it is published while the task is still open.",
	);

// ─────────────────────────────────────────────────────────────────────────────
// list_bus — exported description + args schema (PR-A envelope safety)
// ─────────────────────────────────────────────────────────────────────────────

export const LIST_BUS_TOOL_DESCRIPTION =
	"List business units with optional filters and pagination. " +
	"Defaults: limit default 20, cap 200, fields=lite|full (default full). " +
	"Pagination via cursor (opaque token returned as nextCursor). " +
	"Use fields=lite to get compact projection {_id, name, status, orchestratorId, _creationTime} (~5KB for 100 BUs). " +
	"EXAMPLE: list_bus orchestratorId='sigma' status='live' limit=20 fields='lite'.";

export const listBusArgsSchema = z.object({
	orchestratorId: z.string().optional(),
	status: z.enum(["idea", "building", "live", "revenue"]).optional(),
	limit: z.number().int().min(1).max(200).optional(),
	cursor: z.string().optional(),
	fields: z.enum(["lite", "full"]).optional(),
});

// list_repo_mappings — exported description + args schema (PR-C envelope safety)
// ─────────────────────────────────────────────────────────────────────────────

export const LIST_REPO_MAPPINGS_TOOL_DESCRIPTION =
	"List GitHub repo to orchestrator webhook mappings, newest first with pagination. " +
	"Defaults: limit default 20, cap 200, fields=lite|full (default full). " +
	"Pagination via cursor (opaque token returned as nextCursor). " +
	"Use fields=lite to get compact projection {_id, repo, orchestrator, project, _creationTime} (~2KB for 100 mappings). " +
	"EXAMPLE: list_repo_mappings limit=20 fields='lite'.";

export const listRepoMappingsArgsSchema = z.object({
	limit: z.number().int().min(1).max(200).optional(),
	cursor: z.string().optional(),
	fields: z.enum(["lite", "full"]).optional(),
});

// list_tasks — exported description + args schema (PR-E excludeAutoGenerated)
// ─────────────────────────────────────────────────────────────────────────────

export const LIST_TASKS_TOOL_DESCRIPTION =
	"List tasks with optional filters by assignee, status, project, or creator, newest first. " +
		"Returns { items, nextCursor, truncated }: items are tasks, newest first; nextCursor is the next page's cursor, null on the last page; truncated is true when the 60 KB response cap cut the page (nextCursor is then null). The text is the bare JSON array of the tasks on the last page, else { items, nextCursor }. " +
		"WHEN: use to check the backlog, review in-progress items, or audit a specific project's tasks. " +
		"EXAMPLE: list_tasks assignedTo='gamma' status='in_progress' project='vantage-peers' limit=20. " +
		"excludeAutoGenerated: when true, filters out cron-spawned tasks (createdBy starts with `cron-` OR title matches the `/check-messages` polling pattern). " +
		"Use to keep Pi's queue clean from scheduler noise. " +
		"With updatedSince the rows come newest-UPDATED first and a window of any size pages complete through nextCursor. " +
		"Refused above 2000 rows (drop one key, narrow by status or raise updatedSince): assignedTo with createdBy, project or assignedToInstance with createdBy or updatedSince, and createdBy over an updatedSince window where that creator is rare.";

export const listTasksArgsSchema = z.object({
	assignedTo: z.string().optional().describe("Keep only tasks assigned to this orchestrator, e.g. 'gamma'. Omit for every assignee."),
	assignedToInstance: z
		.string()
		.optional()
		.describe(
			"Keep only tasks assigned to this instance, e.g. 'pi-vps'. Omit for every instance.",
		),
	// One published shape (S-43), see statusListSchema (src/listArgs.ts).
	status: statusListSchema(
		["todo", "in_progress", "review", "blocked", "done", "cancelled"],
		["open", "active", "all"],
	)
		.optional()
		.describe("Narrows the result to tasks in any of the given states. A shorthand stands alone in the list: open keeps everything not finished, active only work not started or under way, all applies no filter. " +
			"Omit for every status."),
	project: z.string().optional().describe("Keep only tasks of this project, e.g. 'vantage-peers'. Omit for every project."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(200)
		.optional()
		.meta({ default: 20 })
		.describe("At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page."),
	fields: z
		.enum(["lite", "full"])
		.optional()
		.meta({ default: "lite" })
		.describe("How much of each row comes back: lite is each task's ID, creation time, title, status, priority, assignee and mission (plus deliverableDivergence when set), enough to pick a row for fewer tokens; full is every stored field."),
	createdBy: z
		.string()
		.optional()
		.describe("Keep only tasks created by this orchestrator, e.g. 'pi'. Omit for every creator."),
	updatedSince: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			"The moment from which changes count: keep only tasks last updated at or after it (a millisecond timestamp, as Date.now() gives), newest-updated first. Omit for no time window.",
		),
	cursor: z
		.string()
		.optional()
		.describe(
			"The nextCursor value a previous list_tasks call returned, to fetch the following (older) page. " +
				"Omit for the first page.",
		),
	excludeAutoGenerated: z
		.boolean()
		.optional()
		.describe(
			"Set true to hide scheduler noise: tasks whose creator starts with 'cron-' or whose title is the check-messages polling title. " +
				"Omit to include them.",
		),
});

// bulk_complete_tasks — exported name, description, and args schema (PR-F)
// ─────────────────────────────────────────────────────────────────────────────

export const BULK_COMPLETE_TASKS_TOOL_NAME = "bulk_complete_tasks";

export const BULK_COMPLETE_TASKS_TOOL_DESCRIPTION =
	"Bulk-close the open tasks matching a filter, in one atomic mutation. " +
		"SAFETY: a call without dryRun only previews the matching tasks; dryRun=false commits. " +
		"The filter must narrow (autoGeneratedOnly, assignedTo or status); an empty filter throws BULK_FILTER_TOO_BROAD. " +
		"A live run needs callerOrchestrator (BULK_CALLER_REQUIRED). " +
		"At most 500 tasks close per call: when more match, the live call closes 500, returns remaining: true + cappedAt: 500, and the rest drains in the background under the same filter and checks; poll get_bulk_complete_run with the bulkRunId. " +
		"Re-calling with the same filter is safe: closed tasks leave the scan. " +
		"Returns {count, sampleIds, bulkRunId, executedAt?, cappedAt?, remaining?}: bulkRunId is the evidence token; cappedAt + remaining appear together when more than 500 matched, otherwise count is exact. " +
		"WHEN: cron-spam cleanup of auto-generated check-messages polling tasks. " +
		"EXAMPLE (preview): bulk_complete_tasks filter={autoGeneratedOnly:true} callerOrchestrator='system'. " +
		"EXAMPLE (commit): bulk_complete_tasks filter={status:'todo'} dryRun=false callerOrchestrator='system'.";

export const bulkCompleteTasksArgsSchema = z.object({
	filter: z.object({
		autoGeneratedOnly: z.boolean().optional().describe("Set true to close only scheduler-made tasks: a creator starting with 'cron-' (the dash is required) or a title that is exactly the check-messages polling title. " +
			"Omit to not filter on origin."),
		assignedTo: z.string().optional().describe("Close only tasks assigned to this orchestrator, e.g. 'beta'. Omit for every assignee."),
		// Day 163 (k171rbm2txe42jxzddyqakbg7n8ch7zr) — mirrors the Convex
		// `bulkComplete` filter.status contract EXACTLY: the same four-value
		// open-status set the scan iterates over (todo/in_progress/review/
		// blocked — "done"/"cancelled" are terminal and never in-scope for a
		// close operation). Without this field the nested `filter` object
		// (not itself `.strict()` — only the TOP-LEVEL args object is, via
		// registerTool's buildStrictInputSchema) SILENTLY STRIPS an unknown
		// `status` key before the Convex mutation ever sees it.
		status: z.enum(["todo", "in_progress", "review", "blocked"]).optional().describe("Close only open tasks currently in this state, e.g. review for the ones waiting on a reviewer. Omit to close open tasks whatever their state."),
	}).describe("Which open tasks to close. Set at least one key; several keys narrow together."),
	dryRun: z.boolean().default(true).describe("Whether this call only previews: true lists what would close and writes nothing; false closes the matched tasks for real."),
	completionNoteTemplate: z.string().optional().describe("The completion note written on every closed task; {{day}}, {{bulkRunId}} and {{executedAt}} are filled in. " +
		"Omit for 'bulk-cleanup: cron-spam day {{day}} runId={{bulkRunId}} executedAt={{executedAt}}'."),
	// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
	callerOrchestrator: z.string().optional().describe("The agent closing the tasks; every matched task must name it as creator or assignee, unless the fleet master acts as 'system'. " +
		"Omit it when your credential resolves one agent: it is then that agent. " +
		"A live run (dryRun=false) without one is refused."),
});

// get_bulk_complete_run — status of one live bulk_complete_tasks run (R-31)
// ─────────────────────────────────────────────────────────────────────────────

export const GET_BULK_COMPLETE_RUN_TOOL_NAME = "get_bulk_complete_run";

export const GET_BULK_COMPLETE_RUN_TOOL_DESCRIPTION =
	"Read the status of one live bulk_complete_tasks run by the `bulkRunId` its first call returned. " +
		"WHEN: a bulk_complete_tasks call reported `remaining: true` — the rest drains in the background, and this is where you see how it went. " +
		"Returns {bulkRunId, status, closed, remaining, failureReason?, createdBy, orgId?, startedAt, updatedAt}: status `running` (batches still draining), `complete` (the pile is gone; `closed` is the total) or `failed` (a later batch was refused — RBAC or the closure gate — `failureReason` says why, `closed` is what was closed before it, the rest stay open; re-calling bulk_complete_tasks with the same filter meets the same refusal). " +
		"Readable by the run's own organisation and by its creator only; any other id, org or caller gets 'not found'. " +
		"EXAMPLE: get_bulk_complete_run bulkRunId='bulk-1760000000000-ab12cd34'.";

export const getBulkCompleteRunArgsSchema = z.object({
	bulkRunId: z
		.string()
		.min(1)
		.max(100)
		.describe("The run to read: the bulkRunId the first live bulk_complete_tasks call returned."),
});

// billing_summary_by_project — Day 130 (k17dhcmzqafve1ayzvh833kf558ae019)
// closure-gate mission, deliverable #6: refacturation base. Backed by
// Convex `tasks:billingSummaryByProject`.
// ─────────────────────────────────────────────────────────────────────────────

export const BILLING_SUMMARY_BY_PROJECT_TOOL_NAME =
	"billing_summary_by_project";

export const BILLING_SUMMARY_BY_PROJECT_TOOL_DESCRIPTION =
	"Billing/refacturation base — sums MACHINE-derived actualMinutes (startedAt→completedAt, never a hand-typed time line) grouped by project for tasks completed within [from, to]. " +
		"WHEN: use to build the refacturation base for a client or period, or to audit billed time before invoicing. " +
		"project is optional — omit to get every project, or pass one to filter the returned rows to a single project. " +
		"from/to bound the completion moment of the tasks counted — omit both to count every completed task up to now. " +
		"NEVER hides truncation: if the underlying scan hit its cap, `truncated: true` is returned — treat that as a signal to narrow the period and re-query, not as a complete total. " +
		"EXAMPLE: billing_summary_by_project project='vantage-immo' from=1783000000000 to=1783949200149. " +
		"unattributedTaskCount is split into noProjectCount (done task with no project, whatever its duration) and noDurationCount (a project but no measured duration); a task with neither counts in noProjectCount only. " +
		"Pass listNoDuration=true to also get noDurationTasks [{taskId, assignedTo, project, completedAt}] (at most 200; noDurationTasksTruncated says when it is cut). " +
		"A duration is never estimated. Returns {byProject: [{project, totalMinutes, taskCount, legacyTaskCount, legacyMinutes}], unattributedTaskCount, noProjectCount, noDurationCount, noDurationTasks?, noDurationTasksTruncated?, invalidDurationTaskCount, truncated}: legacyMinutes is the part of totalMinutes timed from start to close rather than by work segments, invalidDurationTaskCount the done tasks left out for a negative duration.";

export const billingSummaryByProjectArgsSchema = z.object({
	project: z
		.string()
		.optional()
		.describe(
			"Report only this project, e.g. 'vantage-immo'. Omit to get every project's totals.",
		),
	from: z
		.number()
		.int()
		.optional()
		.describe("The moment the billed period starts: tasks completed at or after it count (a millisecond timestamp, as Date.now() gives). Omit to count from the first completed task."),
	to: z
		.number()
		.int()
		.optional()
		.describe("The moment the billed period ends: tasks completed at or before it count (a millisecond timestamp, as Date.now() gives). Omit to count up to now."),
	listNoDuration: z
		.boolean()
		.optional()
		.describe(
			"Set true to also list the done tasks that have a project but no measured duration (noDurationTasks, at most 200; noDurationTasksTruncated says when the list is cut). " +
				"Omit to get their count only.",
		),
});

// ─────────────────────────────────────────────────────────────────────────────
// Search/recall tool descriptions. Each states only its own behaviour, inputs
// and outputs: tool metadata never tells the model to call another tool or how
// to word its answer (Anthropic Software Directory Policy D, Manufact
// policy-review-d26bfdfb4c66). The optional citation workflow is user
// documentation: mcp-server/README.md, "Citing what an answer rests on".
// ─────────────────────────────────────────────────────────────────────────────

export const RECALL_TOOL_DESCRIPTION =
	"Semantic vector search over VantagePeers memories, ranked by cosine similarity. " +
		"Returns { items[{ memoryId, score, namespace, type, content }] }, best match first; the text is the same items as a bare JSON array. " +
		"WHEN: looking up past decisions, rules or facts by meaning rather than by exact words (text_search matches exact terms). " +
		"EXAMPLE: recall query='Pi feedback rules' namespace='global' type='feedback' limit=20.";

export const HYBRID_SEARCH_TOOL_DESCRIPTION =
	"Combined vector + BM25 search via Reciprocal Rank Fusion for best semantic and keyword coverage. " +
		"Returns { items[{ memoryId, rrfScore, namespace, type, content }] }, highest fused score first; the text is the same items as a bare JSON array. " +
		"WHEN: a query needs both meaning and exact terms to match; it fuses the two rankings recall and text_search compute alone. " +
		"EXAMPLE: hybrid_search query='onboarding customer flow' namespace='project/vantage-peers' limit=20.";

export const TEXT_SEARCH_TOOL_DESCRIPTION =
	"BM25 full-text keyword search over VantagePeers memories for exact term matching. " +
		"Returns { items[{ memoryId, namespace, type, content }] }, best match first; the text is the same items as a bare JSON array. " +
		"WHEN: the words or ID to find are known exactly (recall ranks by meaning instead). " +
		"EXAMPLE: text_search query='Day 92 C3 descriptions' namespace='project/vantage-peers' limit=10.";

export const LIST_BRIEFING_NOTES_TOOL_DESCRIPTION =
	"List briefing notes filtered by topic, newest first, with cursor paging support. " +
		"Returns { items, nextCursor, truncated }: items are notes, newest first; nextCursor is the next page's cursor, null on the last page; truncated is true when the 60 KB response cap cut the page (nextCursor is then null). The text is the bare JSON array of the notes on the last page, else { items, nextCursor }. " +
		"WHEN: use to review recent discussions on a topic or audit the full briefing history. " +
		"EXAMPLE: list_briefing_notes topic='architecture' limit=10 fields='lite'.";

export const SEARCH_BRIEFING_NOTES_BY_KEYWORD_TOOL_DESCRIPTION =
	"BM25 full-text keyword search over briefing note content, ranked by relevance. " +
		"Returns { items }: the matching notes, best match first; the text is the same items as a bare JSON array. " +
		"WHEN: use to recall briefings about a topic/decision when list_briefing_notes filters are too coarse — e.g. " +
		"'find briefings about migration plan'. EXAMPLE: search_briefing_notes_by_keyword query='migration plan' topic='daily' limit=10.";

// ─────────────────────────────────────────────────────────────────────────────
// improvisation_digest — Zod schema + description (PR-I T-GREEN)
//
// Advisory-only read tool. Scans recent VP tasks + messages + memories for
// durable artifacts that carry fleet/state tokens (SHA / PR# / VP id /
// decisive verb) but NO source citation line — Eta heuristic proxy for
// "claimed fleet state without recall upstream".
//
// Pi-approved Option C (msg jn779tfjpg68v01db67b4ht20c189c8yw-class).
// Mission k571gcctka8mq5jbkgpj0a0b2n892ctg — Bloc A PR-I.
// ─────────────────────────────────────────────────────────────────────────────

export const IMPROVISATION_DIGEST_TOOL_NAME = "improvisation_digest";

export const IMPROVISATION_DIGEST_TOOL_DESCRIPTION =
	"Audit a rolling window of recent closed-task notes, messages and memories for claims about fleet state (a commit SHA, a PR number, a VantagePeers ID, or a decisive verb such as merged, deployed or approved) that carry no source citation line (a 'recall(\"<query>\")→[ids]' or 'none-needed: <reason>' marker). Served to the fleet master only; advisory, it changes and blocks nothing. " +
		"Returns { countsByOrch, countsByCategory, samples }: countsByOrch maps each orchestrator to its number of flagged artifacts; countsByCategory counts them by the tool that wrote them (complete_task notes, send_message messages, store_memory memories); samples lists up to 50 flagged artifacts, newest first, each { orchestrator, day (YYYY-MM-DD), category, snippet (first 200 characters), artifactId }. At most 2000 rows of each kind are read per call. " +
		"WHEN: auditing a sprint window or one orchestrator's citation rate. " +
		"EXAMPLE: improvisation_digest windowDays=7 orchestrators=['sigma','pi'].";

export const improvisationDigestArgsSchema = z.object({
	windowDays: z
		.number()
		.default(7)
		.describe("The length of the scanned window, in days ending now: artifacts created before it are not read."),
	orchestrators: z
		.array(z.string())
		.optional()
		.describe(
			"Count and sample only artifacts written by these orchestrators, e.g. ['sigma', 'pi']. Omit for every orchestrator.",
		),
});

// ─────────────────────────────────────────────────────────────────────────────
// update_briefing_note — Zod schema + description
//
// Mirrors `api.briefingNotes.update` Convex mutation. `noteId` is a permissive
// `z.string()` because Convex `v.id("briefingNotes")` enforces the real shape
// server-side (same pattern as `update_task`). `callerOrchestrator` is REQUIRED
// (deny-by-default RBAC per memory j573cwcs3znp0xsvtg34x435jh84b0eg). Arrays
// are FULL REPLACE — to clear, pass an empty array; to keep, omit entirely.
// ─────────────────────────────────────────────────────────────────────────────

export const updateBriefingNoteDescription =
	"Update an existing briefing note; only provided fields are patched (arrays are FULL REPLACE). " +
		"Returns { noteId, updated: true }. WHEN: use to add decisions, fix content, or relink memories — RBAC: caller must be createdBy or system. " +
		"EXAMPLE: update_briefing_note noteId='j57aaaaa...' callerOrchestrator='alpha' decisions=['Use hybrid_search first'].";

export const updateBriefingNoteSchema = z.object({
	noteId: noteIdSchema.describe(
		"The note to update: its noteId as returned by create_briefing_note or list_briefing_notes.",
	),
	// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
	callerOrchestrator: creatorSchema.describe(
		"The agent updating; it must be the note's author (or 'system'). " +
			"Omit it when your credential resolves one agent: it is then that agent. Otherwise omitting it is refused.",
	),
	title: z.string().optional().describe("A new title, replacing the current one. Omit to keep it."),
	topic: z.string().optional().describe("The category the note is filed under, compared exactly by the topic filter of list_briefing_notes and search_briefing_notes_by_keyword: after the change the note is listed under the new topic, no longer under the old one. Omit to keep it."),
	participants: z
		.array(z.string())
		.optional()
		.describe("The complete new participant list, replacing the current one (never appended). Omit to keep it."),
	content: z
		.string()
		.optional()
		.describe("New content, replacing the current one. Omit to keep it."),
	decisions: z
		.array(z.string())
		.optional()
		.describe("The complete new decision list, replacing the current one (never appended). Omit to keep it."),
	linkedMemoryIds: z
		.array(memoryIdSchema)
		.optional()
		.describe(
			"The complete new list of linked memories, replacing the current one: memoryId values from store_memory or recall (memory IDs only). " +
				"Omit to keep it.",
		),
});

const assigneeSchema = z
	.string()
	.describe(
		"Orchestrator to assign to (e.g. pi, tau, phi, sigma, omega, zeta, eta, kappa, alpha, lambda, epsilon, omicron, upsilon, laurent, or any custom client role (lowercase string)). " +
			"New internal orchestrators use Greek letters (lowercase); external client orchestrators use free lowercase strings.",
	);

const prioritySchema = z
	.enum(["urgent", "high", "medium", "low"])
	.describe("Task priority level");

const taskStatusValues = [
	"todo",
	"in_progress",
	"review",
	"blocked",
	"done",
	"cancelled",
	// T1 (PRD-evevantage-v1 §7.1) — the FAILED terminal, distinct from
	// "done"/"cancelled". Excluded from updateTaskStatusSchema below the
	// same way "blocked" is — see the comment there.
	"failed",
] as const;
const taskStatusAliases = ["open", "active", "all"] as const;
export const taskStatusSchema = z
	.enum(taskStatusValues)
	.describe("Task status");

// Day 159 — update_task must not advertise "blocked" as a settable status:
// the server (convex/tasks.ts `update`) refuses status="blocked" through this
// verb (BLOCK_VIA_UPDATE_REFUSED) and redirects to block_task, which carries
// the anti-anonymous-block gate (a cited blockedOnTaskId or an explicit
// "# blocked-on-nobody: <reason>" marker). Keep the schema in sync so a
// client is refused loud at the tool-input layer, not just server-side.
//
// T1 — the same reasoning applies to "failed" (server refuses it via
// FAILED_VIA_UPDATE_REFUSED, redirecting to fail_task, which carries the
// mandatory failureNote). Both exclusions keep the client-facing schema in
// sync with the two server-side ungated-door gates.
type SettableTaskStatus = Exclude<
	(typeof taskStatusValues)[number],
	"blocked" | "failed"
>;
const taskStatusValuesExcludingBlockedAndFailed = taskStatusValues.filter(
	(s) => s !== "blocked" && s !== "failed",
) as SettableTaskStatus[];
export const updateTaskStatusSchema = z
	.enum(
		taskStatusValuesExcludingBlockedAndFailed as [
			SettableTaskStatus,
			...SettableTaskStatus[],
		],
	)
	.describe(
		'New status. NOT "blocked" (use block_task) and NOT "failed" (use fail_task) — ' +
			"each carries its own mandatory-evidence gate the generic update verb cannot enforce.",
	);

const missionStatusValues = [
	"brainstorm",
	"plan",
	"execute",
	"validate",
	"complete",
	"cancelled",
] as const;
const missionStatusAliases = ["open", "active", "all"] as const;
export const missionStatusSchema = z
	.enum(missionStatusValues)
	.describe("Mission lifecycle status");

// Filter-only schemas, ONE published shape (S-43): an array of status tokens.
// A bare status or alias, or a JSON-string list, is normalised first; an alias
// stands alone (the backend expands it, convex/tasks.ts + convex/missions.ts);
// the backend receives one token as a string, several statuses as an array.
export const taskStatusFilterSchema = statusListSchema(
	taskStatusValues,
	taskStatusAliases,
).describe(
	'Task status filter, a list: one status ("todo"|"in_progress"|"review"|"blocked"|"done"|"cancelled"|"failed"), ' +
		'one alias alone (["open"] = todo+in_progress+review+blocked, ["active"] = todo+in_progress, ["all"] = no filter), ' +
		"or several direct statuses (no alias among them).",
);

export const missionStatusFilterSchema = statusListSchema(
	missionStatusValues,
	missionStatusAliases,
).describe(
	'Mission status filter, a list: one status ("brainstorm"|"plan"|"execute"|"validate"|"complete"|"cancelled"), ' +
		'one alias alone (["open"] = brainstorm+plan+execute+validate, ["active"] = plan+execute, ["all"] = no filter), ' +
		"or several direct statuses (no alias among them).",
);

// v2.3.2 — fields projection toggle. "lite" returns compact projection
// (5-10× smaller payload), "full" (default) returns full doc.
export const fieldsSchema = z
	.enum(["lite", "full"])
	.describe(
		'Field projection — "lite" returns compact fields only ' +
			"(typical 5-10× smaller payload for large list scans), " +
			'"full" (default) returns the full document.',
	);

// v2.3.3 — Unix timestamp ms filter for "updated since".
// Pass `Date.now() - 24*60*60*1000` for "last 24h" pattern.
export const updatedSinceSchema = z
	.number()
	.int()
	.positive()
	.describe(
		"Unix timestamp (ms) — return only rows whose updatedAt >= this value. " +
			"Typical usage: Date.now() - 24*60*60*1000 for last-24h window.",
	);

const mandateStatusSchema = z
	.enum(["requested", "accepted", "in_progress", "delivered", "settled"])
	.describe("Mandate lifecycle status");

const buStatusSchema = z
	.enum(["idea", "building", "live", "revenue"])
	.describe("Business unit lifecycle status");

const revenueProjectionsSchema = z
	.object({
		y1: z.number().describe("Year 1 revenue projection"),
		y2: z.number().describe("Year 2 revenue projection"),
		y3: z.number().describe("Year 3 revenue projection"),
	})
	.describe("3-year revenue projections");

const coreTeamSchema = z
	.object({
		agents: z.array(z.string()).describe("Agent names involved"),
		skills: z.array(z.string()).describe("Skill names deployed"),
		hooks: z.array(z.string()).describe("Hook names deployed"),
		plugins: z.array(z.string()).describe("Plugin names deployed"),
	})
	.describe("Core team composition — agents, skills, hooks, plugins");

// ─────────────────────────────────────────────────────────────────────────────
// A.7 — project day number derivation
//
// VantagePeers uses a sequential "Day N" numbering convention where Day 1 =
// 2026-03-06 UTC. This is the confirmed epoch: Day 88 = 2026-06-01 (87 days
// after Day 1), verified from Pi VP task k178tqgzhbhzg1h4vbgn4kwdm987vntn
// Day 88 brief (2026-06-01).
//
// No Convex-side day-counter table exists. The value is purely clock-based:
//   dayNumber = floor((nowUTC_midnight - epoch_midnight) / MS_PER_DAY) + 1
//
// Callers who pass explicit sessionDay always override this derivation.
// ─────────────────────────────────────────────────────────────────────────────

/** UTC midnight of Day 1 (2026-03-06). All arithmetic is in whole UTC days. */
const VP_DAY1_EPOCH_UTC_MS = Date.UTC(2026, 2, 6); // month is 0-indexed: 2 = March

/**
 * Derive the current VantagePeers day number from the server clock.
 * Returns 1 on or before 2026-03-06 UTC; increments by 1 per UTC day.
 */
export function deriveSessionDay(nowMs: number = Date.now()): number {
	const MS_PER_DAY = 86_400_000;
	const deltaDays = Math.floor((nowMs - VP_DAY1_EPOCH_UTC_MS) / MS_PER_DAY);
	return Math.max(1, deltaDays + 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: normalize string|array inputs to array
// ─────────────────────────────────────────────────────────────────────────────

function toArray(val: string | string[] | undefined): string[] | undefined {
	if (val === undefined) return undefined;
	if (Array.isArray(val)) {
		if (val.length === 1 && typeof val[0] === "string") {
			try {
				const parsed = JSON.parse(val[0]);
				if (Array.isArray(parsed)) return parsed;
			} catch {
				// not JSON — use as-is
			}
		}
		return val;
	}
	if (val.startsWith("[")) {
		try {
			const parsed = JSON.parse(val);
			if (Array.isArray(parsed)) return parsed;
		} catch {
			// not valid JSON — wrap as single-element array
		}
	}
	return [val];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: structured error response
// ─────────────────────────────────────────────────────────────────────────────

function mcpError(message: string): {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
} {
	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		isError: true,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: a backend REFUSAL must not be flattened into an ABSENCE
//
// A Convex list read that declines to serve an ordinary organisation member (or
// a pre-organisation caller) answers `{ refused: true, items: [] }` instead of a
// bare `[]` (convex/mandates.ts, convex/profiles.ts; rule
// .claude/rules/refusal-is-distinguishable-from-absence.md). A reader that does
// `Array.isArray(x) ? x : []` sees "not an array" and substitutes an EMPTY
// ARRAY: the marker the backend went out of its way to send is discarded at the
// last hop, and a model reading "[]" concludes that nothing exists.
//
// An MCP tool result is read by a model AND a human, so the two outcomes must
// differ in the TEXT, not in a field nobody renders. A refusal is therefore an
// ERROR result (`isError: true`) whose text opens with `REFUSED (RBAC_DENIED)`,
// names the tool and the backend door, and says in plain words that it is NOT
// an empty result. An absence is unchanged: a plain `[]`. It is an error result
// rather than a success with a note because the same class already surfaces
// that way through `mcpConvexError` when a backend read RAISES `RBAC_DENIED`, so
// a caller handles one refusal shape, not two.
//
// Every MCP reader of an envelope-capable door MUST test `isRefusedEnvelope`
// BEFORE it coalesces; the sweep in test/refusal-marker-survives-transport.test.ts
// derives the door set from convex/*.ts and fails on a reader that does not.
// ─────────────────────────────────────────────────────────────────────────────

// Defined in ./refusal.ts (a leaf module, so a UI primitive can test the
// envelope without importing this whole file); re-exported here unchanged.
export { isRefusedEnvelope };

export function mcpRefused(
	tool: string,
	door: string,
): {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
} {
	return {
		content: [
			{
				type: "text" as const,
				text:
					`REFUSED (RBAC_DENIED): ${tool} was refused by the backend read "${door}". ` +
					`This identity is not permitted to read this list. ` +
					`This is NOT an empty result: rows may exist that you cannot see, so do not conclude that none exist.`,
			},
		],
		isError: true,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// ConvexError parser + structured error propagation
//
// When a Convex mutation fails with ArgumentValidationError (e.g. passing a
// briefingNotes ID into linkedMemoryIds which expects a memories ID), the
// ConvexHttpClient throws a plain Error whose message starts with:
//
//   "[CONVEX M(briefingNotes:create)] ArgumentValidationError: Found ID
//   \"<id>\" from table briefingNotes, which does not match the table name in
//   validator v.id(\"memories\"). Path: .linkedMemoryIds[4]"
//
// Without explicit parsing this would reach the client as an opaque generic
// error. This helper:
//  1. Detects ArgumentValidationError (and other named Convex error types)
//  2. Extracts the path (".linkedMemoryIds[4]"), the validator hint, and the
//     raw Convex message
//  3. Returns a structured JSON payload so orchestrators can diagnose and
//     retry with the correct table IDs without blind guessing
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedConvexError {
	code: string;
	message: string;
	path: string | null;
	hint: string | null;
}

/**
 * Parse a Convex error message string into a structured object.
 *
 * Input example (from ConvexHttpClient):
 *   "[CONVEX M(briefingNotes:create)] ArgumentValidationError: Found ID
 *    \"js72ewf0m...\" from table briefingNotes, which does not match the table
 *    name in validator v.id(\"memories\"). Path: .linkedMemoryIds[4]"
 *
 * Returns { code, message, path, hint } where:
 *  - code  = "ArgumentValidationError" (or the parsed error type)
 *  - message = the full human-readable error description after the code prefix
 *  - path  = e.g. ".linkedMemoryIds[4]" extracted from "Path: ..." suffix
 *  - hint  = a concise guidance string derived from the error, or null
 *
 * For unrecognised error strings, code = "ServerError" and path/hint = null.
 *
 * Exported for unit testing.
 */
export function parseConvexError(rawMessage: string): ParsedConvexError {
	// Known Convex validation/runtime error codes surfaced as plaintext
	const knownCodes = [
		"ArgumentValidationError",
		"AuthorizationError",
		"ConvexError",
		"SchemaValidationError",
		"QueryError",
		"MutationError",
		"ActionError",
	];

	// Strip the [CONVEX M(path)] / [CONVEX Q(path)] prefix if present
	const stripped = rawMessage.replace(/^\[CONVEX [A-Z]+\([^\]]*\)\]\s*/, "");

	// Detect the error code
	let code = "ServerError";
	let remainder = stripped;
	for (const candidate of knownCodes) {
		if (
			stripped.startsWith(candidate + ":") ||
			stripped.startsWith(candidate + " ")
		) {
			code = candidate;
			remainder = stripped.slice(candidate.length).replace(/^[:\s]+/, "");
			break;
		}
	}

	// Extract "Path: .<fieldPath>" from the tail of the message
	// Convex appends this as the last sentence: "Path: .linkedMemoryIds[4]"
	let path: string | null = null;
	const pathMatch = remainder.match(/\bPath:\s*([\w.[\]"']+)\s*$/);
	if (pathMatch) {
		path = pathMatch[1];
		remainder = remainder
			.slice(0, pathMatch.index)
			.trim()
			.replace(/\.\s*$/, "");
	}

	// Build a concise hint for common patterns
	let hint: string | null = null;
	if (code === "ArgumentValidationError") {
		const tableMatch = remainder.match(
			/from table (\w+),.*validator v\.id\("(\w+)"\)/,
		);
		if (tableMatch) {
			hint = `ID belongs to table "${tableMatch[1]}" but validator expects v.id("${tableMatch[2]}"). Check that you are passing the correct document ID from the "${tableMatch[2]}" table.`;
		}
	}

	return { code, message: remainder || rawMessage, path, hint };
}

/**
 * Produce a structured MCP error response for any error thrown by a Convex
 * operation. For ConvexError / ArgumentValidationError the response body
 * contains a JSON object with { code, message, path, hint } so the MCP client
 * can display actionable diagnostics instead of a bare "Server Error" string.
 *
 * For unrecognised errors the response falls back to the plain text format
 * used by `mcpError`.
 */
export function mcpConvexError(error: unknown): {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
} {
	// Empirical probe (Day 127, 2026-07-10 — Sigma): Convex redacts
	// `error.message` to a bare "[Request ID: ...] Server Error" string for
	// ConvexError throws, but the ACTUAL actionable payload passed to
	// `throw new ConvexError(...)` server-side survives on `error.data`
	// (string or arbitrary JSON-serialisable value). Prefer `.data` when
	// present so callers see e.g. "TASK_START_BLOCKED: ..." instead of the
	// opaque redacted message.
	const data = (error as { data?: unknown } | null)?.data;
	const rawMessage =
		data !== undefined && data !== null
			? typeof data === "string"
				? data
				: JSON.stringify(data)
			: error instanceof Error
				? error.message
				: String(error);

	const parsed = parseConvexError(rawMessage);

	// For ArgumentValidationError and other known Convex codes, return structured JSON
	if (parsed.code !== "ServerError") {
		const payload: Record<string, string> = {
			code: parsed.code,
			message: parsed.message,
		};
		if (parsed.path !== null) payload.path = parsed.path;
		if (parsed.hint !== null) payload.hint = parsed.hint;

		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify(payload, null, 2),
				},
			],
			isError: true,
		};
	}

	// Fallback: generic error, preserve existing plain-text format
	return {
		content: [{ type: "text" as const, text: `Error: ${rawMessage}` }],
		isError: true,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// whoami output schema — module-level export so downstream tooling (C1 Workflow,
// code-gen, client SDKs) can reference the type without re-declaring it.
// First tool in the codebase with an exported outputSchema — precedent for C1.
// ─────────────────────────────────────────────────────────────────────────────

// Open to added fields (z.looseObject): a client validates against the schema
// it read at connect time, so a closed object breaks every older connection on
// any additive change (task k17e9sx6e8wd951b47wvm0p5qn8hampb).
export const whoamiOutputSchema = z.looseObject({
	scope_profile_name: z
		.string()
		.describe(
			"The scope profile name of the current bearer (e.g. 'alpha-test-trio', 'master', 'legacy'). " +
				"'legacy' indicates a pre-OAuth bearer with no scope profile.",
		),
	fromAllowList: z
		.array(z.string())
		.describe(
			"Identities this bearer is authorized to act as (the `from` values for send_message / create_task). " +
				"Empty for master scope (wildcard suppressed) and legacy bearers.",
		),
	namespaceReadPrefixes: z
		.array(z.string())
		.describe(
			"Namespace prefixes this bearer may read from. Empty for master scope (wildcard suppressed) and legacy bearers.",
		),
	namespaceWritePrefixes: z
		.array(z.string())
		.describe(
			"Namespace prefixes this bearer may write to. Empty for master scope (wildcard suppressed) and legacy bearers.",
		),
	writableNamespaces: z
		.array(z.string())
		.optional()
		.describe(
			"Every namespace this session may write (each also admits its sub-namespaces): the write prefixes plus the caller's own agent and project namespaces. Empty for master scope (wildcard suppressed) and legacy bearers.",
		),
	default_write_namespace: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Where store_memory / store_episode write when namespace is omitted (a person: 'team/<org>'; a seat: 'orchestrator/<its own agent ID>'). Null when the session has no single natural namespace (master, legacy): name one explicitly.",
		),
	suggested_orchestrator_id: z
		.string()
		.nullable()
		.describe(
			"The canonical orchestrator ID to use as `from` in send_message / create_task / create_mission. " +
				"Derived from fromAllowList[0] (case preserved). " +
				"Null when no fromAllowList is configured (DCR client-generic or legacy bearer). " +
				"'master' for master-scope bearers (internal orchestrators only).",
		),
	actor: z
		.looseObject({
			agentId: z
				.string()
				.nullable()
				.describe(
					"The acting agent's stored ID (the identity tools take as an agent ID); null when the backend returned no ID.",
				),
			orgId: z
				.string()
				.describe("The permanent ID of the organisation the agent belongs to."),
			agentName: z
				.string()
				.describe("The agent's current name: a label, not its identity."),
			orgSlug: z
				.string()
				.describe("The slug of the organisation the agent belongs to."),
		})
		.nullable()
		.describe(
			"The agent acting on THIS request: verified from the x-vantage-agent-credential header, " +
				"designated by the signed-in person, or stamped on a one-agent seat. agentId is the stored " +
				"agent ID (the identity; agentName is only its current label), null when the backend returned " +
				"no ID. null when no agent acts. Never contains the secret.",
		),
	agent_id: z
		.string()
		.nullable()
		.describe(
			"The acting agent's stored ID (same as actor.agentId); null when no agent is resolved.",
		),
	agent_name: z
		.string()
		.nullable()
		.optional()
		.describe(
			"The acting agent's current name (same as actor.agentName); null when no agent acts.",
		),
	agent_status: z
		.string()
		.nullable()
		.optional()
		.describe(
			"One plain sentence when no agent is bound to this connection, naming the step that binds one; null when an agent acts (and for the fleet master).",
		),
	agent_unresolved_reason: z
		.enum([
			"no-context",
			"actor-without-agent-id",
			"person-designates-no-agent",
			"org-level-seat-no-agent",
			"seat-agent-not-in-token-org",
			"no-agent-credential-presented",
			"no-agent-resolved",
		])
		.nullable()
		.describe(
			"Why agent_id is null (e.g. person-designates-no-agent: the signed-in person has no designated agent); null when an agent ID is returned.",
		),
	caller_id: z
		.string()
		.nullable()
		.describe(
			"Stable OPAQUE id of the caller (vpu_ + 32 hex): an HMAC of the verified principal under a server secret. " +
				"Identical for the same identity across sessions and tokens, different for two identities, " +
				"never the raw Clerk user id and never an agent name. Null when the server has no id secret configured.",
		),
	org_slug: z
		.string()
		.nullable()
		.describe(
			"Slug of the organisation the caller is bound to (verified org claim or token row); null for master/legacy.",
		),
	role: z
		.enum(["master", "org-member", "oauth-client", "legacy"])
		.describe(
			"How the caller authenticated: master bearer, Clerk-verified organisation member, VantagePeers OAuth client, or legacy (no context).",
		),
	acting_name: z
		.string()
		.nullable()
		.describe(
			"The acting agent name verified from the agent credential on THIS request; null when none was presented.",
		),
});

/**
 * whoami's `agent_status`: null when an agent acts (or for the fleet master, which
 * acts as no agent by design); otherwise one plain sentence saying no agent is bound
 * and naming the step that binds one. A person binds one on the consent page of a
 * new connection; a seat token is bound by its organisation's admin.
 */
export function agentStatusSentence(
	oauthCtx: OAuthContext | undefined,
	agentId: string | null,
): string | null {
	if (agentId !== null) return null;
	if (oauthCtx !== undefined && isMasterScope(oauthCtx)) return null;
	if (oauthCtx?.principal === "person") {
		return `No agent is bound to this connection, so your writes are recorded under your own account. ${PERSON_NO_AGENT_STEP}`;
	}
	return "No agent is bound to this connection. A seat token acts through an agent only once your organisation admin binds the seat to one; a signed-in person reconnects this client and chooses (or, as an organisation admin, creates) an agent on the consent page.";
}

// ─────────────────────────────────────────────────────────────────────────────
// C1 — Per-tool outputSchema exports (B2 §3 standard)
//
// One module-level Zod schema export per tool. Naming: <toolName>OutputSchema.
// These describe the JSON structure inside content[0].text on success paths.
// Error paths (isError: true) are not covered by these schemas.
// ─────────────────────────────────────────────────────────────────────────────

// store_memory
export const storeMemoryOutputSchema = z.object({
	memoryId: z.string(),
	createdBy: z.string().optional(),
	namespace: z.string(),
	type: z.enum(["user", "feedback", "project", "reference", "episode"]),
	content: z.string(),
});

// soft_delete_memory
export const softDeleteMemoryOutputSchema = z.object({
	deleted: z.literal(true),
	memoryId: z.string(),
});

// erase_memory
export const eraseMemoryOutputSchema = z.object({
	memoryId: z.string(),
	replacements: z.number(),
	contentHashChanged: z.boolean(),
});

// erase_row
export const eraseRowOutputSchema = z.object({
	table: z.string(),
	rowId: z.string(),
	erased: z.boolean(),
	cascaded: z.record(z.string(), z.number()),
});

// get_memory
export const getMemoryOutputSchema = z
	.record(z.string(), z.unknown())
	.nullable();

// recall
export const recallOutputSchema = z.array(z.record(z.string(), z.unknown()));

// text_search
export const textSearchOutputSchema = z.array(
	z.record(z.string(), z.unknown()),
);

// hybrid_search
export const hybridSearchOutputSchema = z.array(
	z.record(z.string(), z.unknown()),
);

// store_episode
export const storeEpisodeOutputSchema = z.object({
	memoryId: z.string(),
	createdBy: z.string().optional(),
	type: z.literal("episode"),
	severity: z.enum(["critical", "major", "minor"]),
	namespace: z.string(),
});

// get_profile
export const getProfileOutputSchema = z
	.record(z.string(), z.unknown())
	.nullable();

// update_profile
export const updateProfileOutputSchema = z.object({
	profileId: z.string(),
	orchestratorId: z.string(),
	name: z.string().optional(),
});

// list_memories
export const listMemoriesOutputSchema = z.union([
	z.array(z.record(z.string(), z.unknown())),
	z.object({
		items: z.array(z.record(z.string(), z.unknown())),
		nextCursor: z.string().nullable().optional(),
		_meta: z.record(z.string(), z.unknown()).optional(),
		page: z.array(z.record(z.string(), z.unknown())).optional(),
	}),
]);

// debate_post_turn: the accepted answer. A refusal is not this shape: it is an
// ERROR result whose text opens `REFUSED (<reason>)`.
export const debatePostTurnOutputSchema = z.object({
	accepted: z.literal(true),
	turnSeq: z.number(),
	closed: z.boolean(),
	closeReason: z.string().optional(),
	workDuringTurn: z.string(),
});

// debate_get_room
export const debateGetRoomOutputSchema = z.object({
	room: z.record(z.string(), z.unknown()),
	turns: z.array(z.record(z.string(), z.unknown())),
});

// send_message
export const sendMessageOutputSchema = z.object({
	messageId: z.string(),
	from: z.string(),
	channel: z.string(),
});

// check_messages
export const checkMessagesOutputSchema = z.union([
	z.array(
		z.object({
			receiptId: z.string(),
			from: z.string(),
			fromInstanceId: z.string().optional(),
			channel: z.string().optional(),
			content: z.string(),
			createdAt: z.number(),
		}),
	),
	z.string(),
]);

/**
 * Day-156 reader-first: `stuckInProgress` / `peersStuckOnYou` may be missing
 * (old Convex), a raw `{taskId,title,age}[]` (already-deployed MCP), or the
 * new capped object `{entries,total,truncated,actionableStuckCount}` — the
 * last field may itself be absent (Convex older than the one that added
 * it), and defaults to 0 rather than undefined. Never throw on `.length`.
 */
export function asCappedStuckList(value: unknown): {
	entries: Array<{ taskId: string; title: string; age: number }>;
	total: number;
	truncated: boolean;
	actionableStuckCount: number;
} {
	if (value == null)
		return { entries: [], total: 0, truncated: false, actionableStuckCount: 0 };
	if (Array.isArray(value)) {
		return {
			entries: value as Array<{ taskId: string; title: string; age: number }>,
			total: value.length,
			truncated: false,
			actionableStuckCount: 0,
		};
	}
	if (typeof value === "object") {
		const o = value as Record<string, unknown>;
		const entries = Array.isArray(o.entries)
			? (o.entries as Array<{ taskId: string; title: string; age: number }>)
			: [];
		const total = typeof o.total === "number" ? o.total : entries.length;
		const truncated = o.truncated === true;
		const actionableStuckCount =
			typeof o.actionableStuckCount === "number" ? o.actionableStuckCount : 0;
		return { entries, total, truncated, actionableStuckCount };
	}
	return { entries: [], total: 0, truncated: false, actionableStuckCount: 0 };
}

// mark_as_read
export const markAsReadOutputSchema = z.object({ markedAsRead: z.number() });

// delete_message
export const deleteMessageOutputSchema = z.record(z.string(), z.unknown());

// set_summary
export const setSummaryOutputSchema = z.object({
	orchestratorId: z.string(),
	instanceId: z.string().optional(),
	summary: z.string(),
});

// list_peers
export const listPeersOutputSchema = z.union([
	z.array(
		z.object({
			_id: z.string(),
			_creationTime: z.number().optional(),
			id: z.string(),
			instanceId: z.string(),
			name: z.string().optional(),
			role: z.string(),
			workspace: z.string(),
			currentTask: z.string(),
			lastSeen: z.string(),
			sessionCount: z.number(),
		}),
	),
	z.object({
		items: z.array(z.record(z.string(), z.unknown())),
		nextCursor: z.string().nullable().optional(),
		scopeFiltered: z.number().optional(),
	}),
]);

// list_messages
export const listMessagesOutputSchema = z.union([
	z.array(z.record(z.string(), z.unknown())),
	z.object({
		items: z.array(z.record(z.string(), z.unknown())),
		nextCursor: z.string().nullable(),
	}),
]);

// list_broadcast_status
// Fix for the "Server Error on every call" incident: the backend returns a
// single status ENVELOPE (`{ messageId, from, channel, createdAt, receipts[],
// truncated }`), not a top-level list. The schema previously declared
// `z.array(...)`, which combined with `Array.isArray(status) ? status : []`
// in the handler silently collapsed every real payload into `[]`.
export const listBroadcastStatusOutputSchema = z.object({
	messageId: z.string(),
	from: z.string(),
	channel: z.string().optional(),
	createdAt: z.number(),
	receipts: z.array(z.record(z.string(), z.unknown())),
	truncated: z.boolean(),
	scopeFiltered: z.number().optional(),
});

// create_task
// Status-completeness fix (operator, same T1 delivery) — this was the ONLY
// strict status enum in this file (get_task/list_tasks use loose
// z.record) and it omitted "cancelled" (a first-class Convex status with
// its own cancelReason field, not a note) and now "failed" (T1). Hardcoding
// a literal list here is exactly how it silently drifted from the Convex
// union once already — reuse `taskStatusValues` (declared above, itself
// the canonical mirror of convex/schema.ts's tasks.status union) instead
// of a second hand-typed list, so the two cannot diverge again.
export const createTaskOutputSchema = z.object({
	taskId: z.string(),
	title: z.string(),
	assignedTo: z.string(),
	priority: z.enum(["urgent", "high", "medium", "low"]),
	status: z.enum(taskStatusValues),
});

// list_tasks
export const listTasksOutputSchema = z.union([
	z.array(z.record(z.string(), z.unknown())),
	z.object({
		items: z.array(z.record(z.string(), z.unknown())),
		nextCursor: z.string().nullable(),
		_meta: z.record(z.string(), z.unknown()).optional(),
	}),
]);

// update_task
export const updateTaskOutputSchema = z.object({
	taskId: z.string(),
	updated: z.literal(true),
});

// complete_task
export const completeTaskOutputSchema = z.object({
	taskId: z.string(),
	status: z.literal("done"),
});

// fail_task — T1 (PRD-evevantage-v1 §7.1) third terminal state.
export const failTaskOutputSchema = z.object({
	taskId: z.string(),
	status: z.literal("failed"),
});

// start_task
export const startTaskOutputSchema = z.object({
	taskId: z.string(),
	status: z.literal("in_progress"),
});

// checkout_task
export const checkoutTaskOutputSchema = z.union([
	z.object({ claimed: z.literal(true) }),
	z.object({ claimed: z.literal(false), reason: z.string() }),
]);

// delete_task
export const deleteTaskOutputSchema = z.record(z.string(), z.unknown());

// block_task
// T1 — blockedCause is the structured discriminator of WHAT is being
// waited on (peer_task/human/authorisation/other); it is orthogonal to
// blockedOnTaskId, never a caller-written "state". Optional here too so
// this schema stays compatible while the Convex backend still accepts
// omission (see convex/tasks.ts:blockTask).
export const blockedCauseSchema = z
	.union([
		z.literal("peer_task"),
		z.literal("human"),
		z.literal("authorisation"),
		z.literal("other"),
	])
	.optional();

export const blockTaskOutputSchema = z.object({
	taskId: z.string(),
	status: z.literal("blocked"),
	reason: z.string().optional(),
	blockedOnTaskId: z.string().optional(),
	blockedCause: z
		.union([
			z.literal("peer_task"),
			z.literal("human"),
			z.literal("authorisation"),
			z.literal("other"),
		])
		.optional(),
	// Present only when blockedBy was given: the list the row holds afterwards.
	dependsOn: z.array(z.string()).optional(),
});

// add_task_dependency
export const addTaskDependencyOutputSchema = z.object({
	taskId: z.string(),
	dependsOn: z.array(z.string()),
	updated: z.literal(true),
});

// list_tasks_by_mission
export const listTasksByMissionOutputSchema = z.union([
	z.array(z.record(z.string(), z.unknown())),
	z.object({
		items: z.array(z.record(z.string(), z.unknown())),
		nextCursor: z.string().nullable().optional(),
		scopeFiltered: z.number().optional(),
	}),
]);

// create_mission
export const createMissionOutputSchema = z.object({
	missionId: z.string(),
	name: z.string(),
	project: z.string(),
	pilot: z.string(),
	status: z.enum(["brainstorm", "plan", "execute", "validate", "complete"]),
});

// list_missions
export const listMissionsOutputSchema = z.union([
	z.array(z.record(z.string(), z.unknown())),
	z.object({
		items: z.array(z.record(z.string(), z.unknown())),
		nextCursor: z.string().nullable(),
		_meta: z.record(z.string(), z.unknown()).optional(),
	}),
]);

// get_mission
export const getMissionOutputSchema = z
	.record(z.string(), z.unknown())
	.nullable();

// update_mission
export const updateMissionOutputSchema = z.object({
	missionId: z.string(),
	updated: z.literal(true),
});

// update_mission_status
export const updateMissionStatusOutputSchema = z.object({
	missionId: z.string(),
	status: z.enum(["brainstorm", "plan", "execute", "validate", "complete"]),
});

// write_diary
export const writeDiaryOutputSchema = z.object({
	diaryId: z.string(),
	date: z.string(),
	orchestrator: z.string(),
});

// get_diary
export const getDiaryOutputSchema = z
	.record(z.string(), z.unknown())
	.nullable();

// list_diaries
export const listDiariesOutputSchema = z.union([
	z.array(z.record(z.string(), z.unknown())),
	z.object({
		items: z.array(z.record(z.string(), z.unknown())),
		nextCursor: z.string().nullable(),
		_meta: z.record(z.string(), z.unknown()).optional(),
	}),
]);

// create_briefing_note
export const createBriefingNoteOutputSchema = z.object({
	noteId: z.string(),
	title: z.string(),
	topic: z.string(),
	createdBy: z.string(),
});

// update_briefing_note
export const updateBriefingNoteOutputSchema = z.object({
	noteId: z.string(),
	updated: z.literal(true),
});

// get_briefing_note
export const getBriefingNoteOutputSchema = z
	.record(z.string(), z.unknown())
	.nullable();

// list_briefing_notes
export const listBriefingNotesOutputSchema = z.union([
	z.array(z.record(z.string(), z.unknown())),
	z.object({
		items: z.array(z.record(z.string(), z.unknown())),
		nextCursor: z.string().nullable(),
		_meta: z.record(z.string(), z.unknown()).optional(),
	}),
]);

// create_recurring_task
export const createRecurringTaskOutputSchema = z.object({
	taskId: z.string(),
	cronExpression: z.string(),
});

// list_recurring_tasks
export const listRecurringTasksOutputSchema = z.union([
	z.array(z.record(z.string(), z.unknown())),
	z.object({
		items: z.array(z.record(z.string(), z.unknown())),
		nextCursor: z.string().nullable().optional(),
		scopeFiltered: z.number().optional(),
	}),
]);

// pause_recurring_task
export const pauseRecurringTaskOutputSchema = z.record(z.string(), z.unknown());

// resume_recurring_task
export const resumeRecurringTaskOutputSchema = z.record(
	z.string(),
	z.unknown(),
);

// delete_recurring_task
export const deleteRecurringTaskOutputSchema = z.record(
	z.string(),
	z.unknown(),
);

// update_recurring_task
export const updateRecurringTaskOutputSchema = z.object({
	recurringTaskId: z.string(),
	updated: z.literal(true),
});

// create_mandate
export const createMandateOutputSchema = z.object({
	mandateId: z.string(),
	requestedBy: z.string(),
	fulfilledBy: z.string(),
	service: z.string(),
	budget: z.number(),
});

// accept_mandate
export const acceptMandateOutputSchema = z.object({
	mandateId: z.string(),
	status: z.literal("accepted"),
});

// update_mandate
export const updateMandateOutputSchema = z.object({
	mandateId: z.string(),
	updated: z.literal(true),
});

// settle_mandate
export const settleMandateOutputSchema = z.object({
	mandateId: z.string(),
	status: z.literal("settled"),
	finalCost: z.number(),
});

// validate_mandate_spending
export const validateMandateSpendingOutputSchema = z.record(
	z.string(),
	z.unknown(),
);

// list_mandates
export const listMandatesOutputSchema = z.union([
	z.array(z.record(z.string(), z.unknown())),
	z.object({
		items: z.array(z.record(z.string(), z.unknown())),
		nextCursor: z.string().nullable().optional(),
		scopeFiltered: z.number().optional(),
		_meta: z.record(z.string(), z.unknown()).optional(),
	}),
]);

// create_bu
export const createBuOutputSchema = z.object({
	buId: z.string(),
	name: z.string(),
	orchestratorId: z.string(),
	status: z.enum(["idea", "building", "live", "revenue"]),
});

// update_bu
export const updateBuOutputSchema = z.object({
	buId: z.string(),
	updated: z.literal(true),
});

// get_bu
export const getBuOutputSchema = z.record(z.string(), z.unknown()).nullable();

// list_bus
export const listBusOutputSchema = z.union([
	z.array(z.record(z.string(), z.unknown())),
	z.object({
		items: z.array(z.record(z.string(), z.unknown())),
		nextCursor: z.string().nullable(),
		_meta: z.record(z.string(), z.unknown()).optional(),
	}),
]);

// delete_bu
export const deleteBuOutputSchema = z.record(z.string(), z.unknown());

// add_repo_mapping
export const addRepoMappingOutputSchema = z.object({
	id: z.string(),
	repo: z.string(),
	orchestrator: z.string(),
	project: z.string(),
	active: z.boolean().optional(),
});

// list_repo_mappings
export const listRepoMappingsOutputSchema = z.union([
	z.array(z.record(z.string(), z.unknown())),
	z.object({
		items: z.array(z.record(z.string(), z.unknown())),
		nextCursor: z.string().nullable(),
	}),
]);

// remove_repo_mapping
export const removeRepoMappingOutputSchema = z.record(z.string(), z.unknown());

// list_issues
export const listIssuesOutputSchema = z.object({
	count: z.number(),
	issues: z.array(z.record(z.string(), z.unknown())),
	nextCursor: z.string().nullable().optional(),
});

// get_issue
export const getIssueOutputSchema = z
	.union([z.record(z.string(), z.unknown()), z.object({ error: z.string() })])
	.nullable();

// update_issue_status
export const updateIssueStatusOutputSchema = z.object({
	repo: z.string(),
	issueNumber: z.number(),
	status: z.string(),
	updated: z.literal(true),
});

// link_commit_to_issue
export const linkCommitToIssueOutputSchema = z.object({
	repo: z.string(),
	issueNumber: z.number(),
	commitSha: z.string(),
	fixedBy: z.string(),
	linked: z.literal(true),
});

// verify_issue
export const verifyIssueOutputSchema = z.object({
	repo: z.string(),
	issueNumber: z.number(),
	verifiedBy: z.string(),
	verified: z.literal(true),
});

// issue_stats
export const issueStatsOutputSchema = z
	.record(z.string(), z.unknown())
	.nullable();

// create_fix_pattern
export const createFixPatternOutputSchema = z.object({
	patternId: z.string(),
	created: z.literal(true),
});

// add_fix_attempt
export const addFixAttemptOutputSchema = z.object({
	attemptId: z.string(),
	patternId: z.string(),
	worked: z.boolean(),
});

// validate_fix
export const validateFixOutputSchema = z.object({
	patternId: z.string(),
	validatedFix: z.string(),
	validated: z.literal(true),
});

// search_fix_patterns
export const searchFixPatternsOutputSchema = z.array(
	z.record(z.string(), z.unknown()),
);

// list_fix_patterns
export const listFixPatternsOutputSchema = z.union([
	z.array(z.record(z.string(), z.unknown())),
	z.object({
		items: z.array(z.record(z.string(), z.unknown())),
		nextCursor: z.string().nullable(),
		_meta: z.record(z.string(), z.unknown()).optional(),
	}),
]);

// link_issue_to_pattern
export const linkIssueToPatternOutputSchema = z.object({
	patternId: z.string(),
	issueId: z.string(),
	linked: z.literal(true),
});

// get_mission_template
export const getMissionTemplateOutputSchema = z
	.record(z.string(), z.unknown())
	.nullable();

// update_mission_template
export const updateMissionTemplateOutputSchema = z.object({
	templateId: z.string(),
	name: z.string(),
	stepCount: z.number(),
});

// instantiate_template_into_mission
export const instantiateTemplateIntoMissionOutputSchema = z.record(
	z.string(),
	z.unknown(),
);

// add_deployment
export const addDeploymentOutputSchema = z.object({
	id: z.string(),
	name: z.string(),
	deploymentUrl: z.string(),
	githubRepo: z.string(),
	orchestrator: z.string(),
});

// remove_deployment
export const removeDeploymentOutputSchema = z.object({ removed: z.string() });

// list_errors
export const listErrorsOutputSchema = z.union([
	z.array(z.record(z.string(), z.unknown())),
	z.object({
		items: z.array(z.record(z.string(), z.unknown())),
		nextCursor: z.string().nullable(),
		_meta: z.record(z.string(), z.unknown()).optional(),
	}),
]);

// get_error
export const getErrorOutputSchema = z
	.record(z.string(), z.unknown())
	.nullable();

// validate_task_payload (F1 — Day 92)
export const validateTaskPayloadOutputSchema = z.object({
	valid: z.boolean(),
	errors: z.array(z.string()),
	warnings: z.array(z.string()),
	payload: z.record(z.string(), z.unknown()).optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Main export: register all tools against a server + convex client pair
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Tool exposure filter — DATA-DRIVEN CORE allowlist (S8, mission
// vp-mcp-alias-cleanup-v1). Only tool names listed in `core` inside
// tool-exposure.json are registered/advertised to clients; every other tool
// stays fully present in the code + DB, just not exposed. The list lives as
// DATA, never a code constant — reverting = editing tool-exposure.json.
// VP_TOOL_EXPOSURE_PATH overrides the path for tests only.
//
// Derived from analysis/vantagepeers/vp-restructuring/vp-by-tool-day158.csv
// (outil column where T2_verdict == "CORE"), intersected with the
// actually-registered tool-name set — see tool-exposure.json's own header.
// ─────────────────────────────────────────────────────────────────────────────

function resolveToolExposurePath(): string {
	if (process.env.VP_TOOL_EXPOSURE_PATH) {
		return resolve(process.env.VP_TOOL_EXPOSURE_PATH);
	}
	// This module resolves at "<mcp-server>/src/tools.ts" when run from source
	// (bun run server.ts) and at "<mcp-server>/dist/src/tools.js" when run from
	// the tsc build (dist/server.js) — tool-exposure.json always lives at the
	// mcp-server package root, one directory further up in the built case.
	const here = dirname(fileURLToPath(import.meta.url));
	const fromSource = resolve(here, "../tool-exposure.json");
	const fromDist = resolve(here, "../../tool-exposure.json");
	try {
		readFileSync(fromSource, "utf-8");
		return fromSource;
	} catch {
		return fromDist;
	}
}

function loadCoreToolNames(): string[] {
	const path = resolveToolExposurePath();

	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err) {
		throw new Error(
			`tool-exposure: failed to read ${path}: ${(err as Error).message}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(
			`tool-exposure: invalid JSON in ${path}: ${(err as Error).message}`,
		);
	}

	const core = (parsed as { core?: unknown })?.core;
	if (!Array.isArray(core) || !core.every((n) => typeof n === "string")) {
		throw new Error(
			`tool-exposure: "core" must be an array of strings in ${path}`,
		);
	}
	return core;
}

/**
 * The roster claim a fleet-internal door takes (`fixPatterns:get`). It forwards
 * the bearer's already-verified roster to the Convex door and decides nothing
 * from it (backend-doctor 0.4.3 credits this forward; no exemption marker).
 *
 * `fixPatterns` has no tenant column, so there is no org to send. A bearer that
 * is not the master forwards the roster of its verified oauthContext (an absent
 * context forwards an EMPTY roster, which names nothing); the door answers
 * `null` for a row that roster does not name, before it reads any dependent
 * row. The master forwards nothing and reads unchanged. The claim only ever
 * narrows what the master-only door admits.
 */
function rosterClaimArgs(ctx: OAuthContext | undefined): {
	callerIdentities?: string[];
} {
	if (ctx !== undefined && isMasterScope(ctx)) return {};
	return { callerIdentities: ctx?.fromAllowList ?? [] };
}

/**
 * Day 165 fix (task k175ga65p654z200ydj7s8qv5s8cnxfc) — briefingNotes
 * defense-in-depth participant check.
 *
 * The authoritative fix lives in the Convex query itself
 * (convex/briefingNotes.ts get/list/searchBriefingNotesByKeyword): visibility
 * is resolved server-side via the `by_participant_note` index when
 * `master`/`callerIdentities` are threaded in from this handler.
 *
 * scopeFilterGet/scopeFilterList (the generic package-level post-query
 * filter used across many resources) only ever discriminate on
 * `createdBy`/`namespace` — they have no notion of `participants`, and they
 * are the ONLY tenant-isolation enforcement some of these tools have when
 * routed through the MCP server's fixed service-account Convex identity
 * (Day 141 fix note: `ctx.auth` resolves the MCP service account, not the
 * real caller, so Convex's own org-scope check does not apply here — the
 * real caller identity only exists as `oauthCtx` at this layer).
 *
 * This helper does NOT trust that Convex already authorized the row (that
 * would defeat the defense-in-depth these tools rely on) — it independently
 * re-checks `row.participants` (data already present on the row) against the
 * real caller's `fromAllowList`, exactly mirroring what the Convex-side
 * index lookup does, without a remap/blind-trust shortcut.
 */
function passesBriefingNoteParticipantScope(
	oauthCtx: OAuthContext | undefined,
	row: { createdBy?: string; participants?: string[] } | null | undefined,
): boolean {
	if (row == null) return false;
	// Absence REFUSES — a missing oauthCtx is NOT equivalent to master. Split
	// from the old `undefined || isMasterScope` which treated no-context as a
	// full pass (one-identity-layer.md clause 3).
	if (oauthCtx === undefined) return false;
	if (isMasterScope(oauthCtx)) return true;
	if (Array.isArray(row.participants)) {
		return row.participants.some((p) => oauthCtx.fromAllowList.includes(p));
	}
	return false;
}

// Upper bound on the roster entries one list_peers call lists.
const ROSTER_LISTING_CAP = 200;

const LIST_PEERS = "list_peers";

/**
 * list_peers for a NON-MASTER token that carries a verified org: the listing
 * is the caller's OWN org roster. The org is never read from an argument:
 * orgRoster:getMyAgentDirectory (Clerk session) and
 * orgRoster:getAgentDirectoryForAccessToken (access-token hash) derive it
 * server-side from the verified credential and attach each agent's unique ID
 * (`agentId`, null = not addressable) for send_message `recipientAgentIds`.
 * Returns null when the roster path does not apply (no context, master, no
 * org, no credential handle); the caller then scopes with scopeFilterList.
 */
async function listPeersFromOrgRoster(
	convex: Pick<ConvexHttpClient, "query">,
	oauthCtx: OAuthContext | undefined,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	isError?: true;
	structuredContent?: PageStructured;
} | null> {
	// Directory vs. identity: `fromAllowList` governs who a token may ACT
	// AS (send_message `from`, message reads). It is NOT the org directory.
	// A seat narrowed to its own name (e.g. ["agent-a"]) must still see the
	// colleagues of its org. A non-master token that carries a verified org
	// is therefore listed FROM THE ORG ROSTER (the door the delegation
	// guard reads), never from a page of the global profiles table and never
	// from fromAllowList. Master, and a token with no org, keep the
	// caller's scopeFilterList path unchanged. Only this listing changes: no
	// acting, message-read or namespace gate is touched.
	const directoryDoors =
		!oauthCtx || isMasterScope(oauthCtx) || oauthCtx.clerkOrgSlug === undefined
			? null
			: oauthCtx.clerkJwt
				? {
						directory: "orgRoster:getMyAgentDirectory",
						args: {},
					}
				: oauthCtx.accessTokenHash
					? {
							directory: "orgRoster:getAgentDirectoryForAccessToken",
							args: { tokenHash: oauthCtx.accessTokenHash },
						}
					: null;
	if (directoryDoors === null || oauthCtx?.clerkOrgSlug === undefined) {
		return null;
	}
	// A provider that cannot answer the directory door is an error, raised as
	// such: it is never silently replaced by a name-only roster.
	const roster: unknown = await convex.query(
		// biome-ignore lint/suspicious/noExplicitAny: Convex string API
		directoryDoors.directory as any,
		directoryDoors.args,
	);
	if (isRefusedEnvelope(roster)) {
		return mcpRefused(LIST_PEERS, directoryDoors.directory);
	}
	// "*" names nobody here: a wildcard never widens a directory to
	// other organisations. ONE entry per AGENT (keyed by agentId): two agents
	// may carry the same label (a client agent and an operator coordinator)
	// and each keeps its own ID. An entry with no ID is keyed by its
	// normalised name. Bounded.
	const seen = new Map<string, { name: string; agentId: string | null }>();
	for (const entry of Array.isArray(roster) ? (roster as unknown[]) : []) {
		let name: string | null = null;
		let agentId: string | null = null;
		if (typeof entry === "string") {
			name = entry;
		} else if (
			entry !== null &&
			typeof entry === "object" &&
			typeof (entry as { name?: unknown }).name === "string"
		) {
			const en = entry as { name: string; agentId?: unknown };
			name = en.name;
			agentId = typeof en.agentId === "string" ? en.agentId : null;
		}
		if (name === null || name === "*") continue;
		const key = agentId ?? `name:${normalizeOrchestratorId(name)}`;
		if (!seen.has(key)) seen.set(key, { name, agentId });
	}
	const directory = [...seen.values()].slice(0, ROSTER_LISTING_CAP);
	// The listing is the directory itself: name and agentId. It is NOT enriched
	// from `profiles:listProfiles`: that door is fleet-master-only, and this
	// path serves only non-master bearers whose Convex client acts for their
	// org (`__actingOrg`, authenticatedConvexClient.ts) or carries their own
	// Clerk session, so Convex resolves an ordinary member and the door answers
	// `{ refused: true, items: [] }` every time. Reading it turned the whole
	// listing into a refusal for every client seat (task
	// k177e8dyrnykk3c56yf2b0pgfs8hhz06). The status fields are null because they
	// were not read, never because a profile row is known to be absent.
	const orgPeers = directory.map(({ name, agentId }) => ({
		id: name,
		agentId,
		instanceId: name,
		name,
		role: null,
		workspace: null,
		currentTask: null,
		lastSeen: null,
		sessionCount: null,
	}));
	const capped = capListResponse(
		orgPeers,
		JSON.stringify(orgPeers, null, 2),
		LIST_PEERS,
	);
	return {
		content: [{ type: "text", text: capped.text }],
		structuredContent: pageStructured(orgPeers, capped),
	};
}

export function registerTools(
	server: McpServer,
	rawConvex: ConvexHttpClient,
	oauthCtx?: OAuthContext,
	// `recordToolUsage`: file one `tool_usage` row per resolved tool call (the
	// HTTP entry, server-http.ts, passes it; pinned by
	// test/get-tool-usage-tool.test.ts). Off elsewhere: the stdio entry's caller
	// is the master, which is never recorded, and a test that counts the Convex
	// mutations a tool made must not see a second one it did not make.
	// `publicBaseUrl`: the origin this request was served on (server-http.ts
	// resolveIssuer), for the MCP App views' `_meta.ui.domain`. Absent: none.
	options?: {
		readonly recordToolUsage?: boolean;
		readonly publicBaseUrl?: string | null;
	},
): void {
	// The acting agent's unique ID rides every actor-taking Convex door
	// (verifiedActor.ts). Same client object when no ID was resolved.
	const convex = withVerifiedActor(rawConvex, oauthCtx);
	// The agent ID the server forwards as the acting agent; whoami reports it.
	const verifiedActor = verifiedActorOf(oauthCtx);
	// Intercept EVERY server.registerTool(...) call made below (directly or
	// through defineTool()/registerExportOkfBundle()/registerImportOkfBundle()/
	// registerKbIngestTools()/registerValidateOkfBundle() — they all receive
	// this same `server` instance) so only CORE names are actually advertised.
	//
	// registerTool is the only registration entry: defineTool() registers
	// through the config-object API (the Day-159 incident fix, see
	// registerTool.ts `defineTool` doc comment), and @modelcontextprotocol/server
	// 2.x removed the positional `server.tool(...)` overload altogether.
	//
	// The registration itself always goes through — the tool stays fully
	// present in the code + handler wiring (masking ≠ deletion; a non-CORE
	// tool's handler is still reachable in-process, e.g. by existing unit
	// tests that capture registrations against a stub McpServer). What is
	// masked is client-facing ADVERTISEMENT: a non-CORE tool is immediately
	// `.disable()`d on its returned RegisteredTool, which is the MCP SDK's own
	// mechanism for keeping a tool out of `tools/list` (server/mcp.js filters
	// `tool.enabled` when building that list) while refusing `tools/call` on
	// it with an explicit "Tool <name> disabled" error — never a silent
	// unregistration.
	const coreToolNames = new Set(loadCoreToolNames());
	const allRegisteredNames = new Set<string>();
	const maskIfNotCore = (name: string, registered: unknown) => {
		allRegisteredNames.add(name);
		if (
			!coreToolNames.has(name) &&
			registered &&
			typeof (registered as { disable?: unknown }).disable === "function"
		) {
			(registered as { disable: () => void }).disable();
		}
		return registered;
	};
	const realRegisterTool = server.registerTool.bind(server);
	// biome-ignore lint/suspicious/noExplicitAny: narrowing the overloaded McpServer#registerTool signature for interception.
	(server as any).registerTool = (
		name: string,
		config: unknown,
		...rest: unknown[]
	) => {
		// MCP Apps: a tool with a UI names its document in `_meta.ui.resourceUri`
		// (ui-resources/apps.ts). The handler and its text result are untouched.
		// Forwarding to the real overloaded signature, arguments as received.
		const forward = realRegisterTool as unknown as (
			...args: unknown[]
		) => unknown;
		const registered = forward(name, withUiAppLink(name, config), ...rest);
		return maskIfNotCore(name, registered);
	};

	// ── scope guards ────────────────────────────────────────────────────────
	// These REFUSE when oauthCtx is undefined (absence is never authority).
	// The old "no-op when undefined — legacy bearer path" behaviour was wrong on
	// both counts: the legacy bearer path (auth.ts §4) DOES set an oauthContext
	// ("legacy-tenant-generic", deny-by-default), and the only caller that
	// legitimately reaches registerTools without one is the stdio transport,
	// which now hands in the explicit LOCAL_STDIO_TRUST_CTX. So `undefined` here
	// means "misconfigured / no identity" and each guard below fails closed.
	//
	// The acting name (`callerOrchestrator`, a `from` tool's `fromArg`) is NOT
	// re-checked in a handler: defineTool judges it once, before the handler
	// (registerTool.ts: bindActingNames for the actor, the `from` scope kind for
	// the roster). The one `filtered` tool that takes an acting name,
	// bulk_complete_tasks, applies the roster itself (see there).
	// The organisation THIS bearer was verified for, for a call that reaches
	// Convex as the fleet service account (so `ctx.auth` there carries no org).
	// Read from the verified oauthContext only: the agent credential's org
	// (`actor`, bound to the principal's own org before it is set) or the org
	// snapshotted on the access-token row. Never from an argument. The master
	// and a Clerk-JWT caller (whose own org Convex already sees) forward none.
	// Convex believes it from the service account only and resolves it against an
	// active org (convex/lib/verifiedOrg.ts).
	const verifiedOrgOf = (): string | undefined => verifiedOrgSlugOf(oauthCtx);
	// THE one resolver of the scope a door call carries (doorScope.ts, task
	// k176y0q5jcz3m8m673bf61kva98h49js): verifiedPerson (a PERSON acting in its
	// own name, k176ch9tamzab3dnhye94kga1d8fkbhm), verifiedOrg (the bearer's
	// verified org) and seatOrgSlug (a seat's org for a recipient-scoped door),
	// each forwarded exactly when the DOOR accepts it. Every tool goes through
	// it, write and read alike, so a write can never carry less scope than its
	// read sibling. The facts are read from the verified oauthContext only, ONCE
	// per registration: the context is this connection's verified principal and
	// nothing in the server mutates it after authentication, so every door call
	// reads the same facts and identity is derived at this one point.
	const verifiedOrgSlug = verifiedOrgOf();
	const doorFacts: DoorScopeFacts = {
		...(personActorOf(oauthCtx) !== undefined &&
		oauthCtx?.accessTokenHash !== undefined
			? { personAccessTokenHash: oauthCtx.accessTokenHash }
			: {}),
		...(verifiedOrgSlug !== undefined ? { verifiedOrgSlug } : {}),
		...(verifiedOrgIdOf(oauthCtx) !== undefined
			? { verifiedOrgId: verifiedOrgIdOf(oauthCtx) as string }
			: {}),
		hasVerifiedActor: verifiedActor !== undefined,
		seat: resolveSeatOrg(oauthCtx),
	};
	const doorScope = (door: string, actingName: string | undefined) =>
		resolveDoorScope(door, actingName, doorFacts);
	// The args fragment for a door that cannot refuse on scope (no seatOrgSlug).
	const doorScopeArgs = (
		door: string,
		actingName: string | undefined,
	): DoorScopeArgs => {
		const resolved = doorScope(door, actingName);
		if ("denied" in resolved) throw new Error(resolved.denied);
		return resolved.args;
	};
	// A lookup miss at this boundary is a DENY, never a fall-through
	// (.claude/rules/http-boundary-derives-from-principal.md): a NON-master bearer
	// whose organisation cannot be resolved (no verified actor, no token-row org,
	// and not a Clerk session, whose own org Convex already sees) is refused here,
	// before Convex, instead of reaching a door that would compare names only.
	// The fleet master and the stdio trust context are not this population.
	const unresolvedOrgDenial = (door: string) => {
		if (oauthCtx?.isMaster === true || oauthCtx?.clerkJwt !== undefined) {
			return null;
		}
		if (verifiedOrgOf() !== undefined) return null;
		return mcpError(
			`RBAC_DENIED: ${door} needs the caller's verified organisation and this bearer resolves none — ${JSON.stringify({ reason: "verified-org-unresolved", door })}`,
		);
	};
	// Delegation guard — distinct question from the acting-name gates (identity CLAIM).
	// Applies ONLY to the ASSIGNEE (delegation target): is `assignedTo` a
	// member of the CALLER's own organisation? Membership is read from DATA
	// (convex/orgRoster.ts getMyOrgRoster for Clerk JWT, getForAccessToken
	// for a provisioned OAuth token — org derived from the token row, never
	// an org argument), never a list hard-coded here. Master scope
	// short-circuits inside checkDelegationAllowed without querying Convex.
	const guardDelegation = async (assignedTo: string, field = "assignedTo") => {
		const err = await checkDelegationAllowed(
			oauthCtx,
			assignedTo,
			async () => {
				if (oauthCtx?.clerkJwt) {
					return convex.query(
						// biome-ignore lint/suspicious/noExplicitAny: Convex string API
						"orgRoster:getMyOrgRoster" as any,
						{},
					) as Promise<string[]>;
				}
				if (oauthCtx?.accessTokenHash) {
					return convex.query(
						// biome-ignore lint/suspicious/noExplicitAny: Convex string API
						"orgRoster:getForAccessToken" as any,
						{ tokenHash: oauthCtx.accessTokenHash },
					) as Promise<string[]>;
				}
				return [];
			},
			field,
		);
		return err ? mcpError(err) : null;
	};
	// Assignment guard — for a name that ASSIGNS work to someone (pilot,
	// fulfilledBy, a BU's new lead), as opposed to the ACTING name a credential
	// binds (callerOrchestrator / the scope's fromArg, see registerTool.ts
	// actingNameKeys). An assignee is not an identity claim, so it is never
	// refused as AGENT_IDENTITY_MISMATCH (task k1748jbt7yfgrv747p8gky1f358fk1r5).
	// The caller naming ITSELF passes: a name its credential binds
	// (decideActingClaim) AND its roster lists (@vantageos/cloud-identity
	// passesScopeFilter), the same two gates an acting name passes. Any other
	// name must be a member of the caller's OWN organisation roster — the same
	// delegation gate create_task applies to assignedTo.
	const guardAssignee = async (field: string, name: string) => {
		if (
			oauthCtx !== undefined &&
			actingClaimRefusal(oauthCtx, name) === null &&
			passesScopeFilter(toPackageOAuthCtx(oauthCtx, { actingName: true }), {
				createdBy: name,
			})
		)
			return null;
		return guardDelegation(name, field);
	};
	const guardRead = (namespace: string | undefined) => {
		const err = checkNamespaceRead(oauthCtx, namespace);
		return err ? mcpError(err) : null;
	};
	const guardWrite = (namespace: string) => {
		const err = checkNamespaceWrite(oauthCtx, namespace);
		return err ? mcpError(err) : null;
	};
	// What this session may write, as values (WriteSpace): undefined for master
	// and for a request with no context. Read once here; whoami and the write
	// tools' default derive from it.
	const writeSpace: WriteSpace | undefined =
		oauthCtx !== undefined && !isMasterScope(oauthCtx)
			? {
					writePrefixes: oauthCtx.namespaceWritePrefixes,
					ownAgentNamespace: oauthCtx.ownAgentNamespace,
					ownProjectNamespace: oauthCtx.ownProjectNamespace,
					principal: oauthCtx.principal,
				}
			: undefined;
	// The namespace a write lands in: the one the caller named, else the
	// session's own (defaultWriteNamespace: a person's team/<org key>, a seat's
	// orchestrator/<agent ID>). No natural default refuses, naming what is
	// writable. The result still goes through guardWrite.
	const resolveWriteNamespace = (
		namespace: string | undefined,
		toolName: string,
	): { namespace: string } | { denied: ReturnType<typeof mcpError> } => {
		if (namespace !== undefined && namespace !== "") return { namespace };
		if (!oauthCtx) return { denied: mcpError(NO_CONTEXT_REFUSAL) };
		const fallback = defaultWriteNamespace(writeSpace);
		if (fallback !== undefined) return { namespace: fallback };
		return {
			denied: mcpError(
				namespaceRequiredRefusal(toolName, oauthCtx.scopeProfile, writeSpace),
			),
		};
	};
	// Some tools take no identity/namespace arg (e.g. soft_delete_memory only
	// takes an ID). When the underlying mutation cannot enforce per-resource
	// RBAC, we restrict the whole tool to master scope. Absence REFUSES: a
	// missing oauthCtx is never master (the guard whose PURPOSE is to restrict
	// to master must not pass when there is no identity). Production always
	// carries a context — HTTP via bearerAuthMiddleware, stdio via
	// LOCAL_STDIO_TRUST_CTX (isMaster) — so the local path still passes here
	// through the master branch, not through absence.
	const guardMasterOnly = (toolName: string) => {
		if (!oauthCtx)
			return mcpError(
				`Forbidden: ${toolName} requires master scope, but the request carried no authorization context (absence is never master).`,
			);
		if (isMasterScope(oauthCtx)) return null;
		return mcpError(
			`Forbidden: ${toolName} requires master scope (current: ${oauthCtx.scopeProfile}).`,
		);
	};

	// A caller the transport could not resolve is never served (absence is never
	// master). Used by tools whose Convex door derives the tenant itself.
	const guardResolvedCaller = (toolName: string) => {
		if (oauthCtx) return null;
		return mcpError(
			`Forbidden: ${toolName} requires an authenticated caller, but the request carried no authorization context (absence is never master).`,
		);
	};

	// Auth context threaded into every defineTool registration. The wrapper reads
	// the declared scope and applies the shared predicates (checkNamespace*,
	// isMasterScope, and for the `from` kind the actor binding plus the
	// package's passesScopeFilter roster). See registerTool.ts.
	const authCtx: ToolAuthContext = {
		oauthCtx,
		...(options?.recordToolUsage === true
			? {
					recordUsage: (toolName: string) =>
						recordToolUsage(convex, oauthCtx, toolName),
				}
			: {}),
	};

	// ── store_memory ────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "createdBy" },
		"store_memory",
		"Store a typed memory entry in VantagePeers, optionally linked to an earlier memory. " +
			"Omit namespace to write in your own space. " +
			"Returns { memoryId, namespace, type, content, createdBy }; keep memoryId for get_memory or soft_delete_memory. " +
			"WHEN: use after any decision, rule, or lesson that must persist across sessions. " +
			"EXAMPLE: store_memory type='feedback' content='Alpha prefers concise replies' (no namespace: written in your own space).",
		{
			namespace: z
				.string()
				.optional()
				.describe(
					"Where the record is stored, e.g. 'global', 'orchestrator/pi', 'project/vantage-starter'. " +
						"Omit it to write in your own space (a signed-in person: 'team/<org>'; a seat: 'orchestrator/<its own agent ID>'; whoami returns it as default_write_namespace). " +
						"A client seat may write only 'team/<org ID>', 'project/<org slug>' and 'orchestrator/<its own agent ID>' (the permanent ID, never the agent name); a refused write names the namespaces your session may write.",
				),
			type: memoryTypeSchema.describe("What kind of knowledge this is; recall and list_memories filter on it. episode is accepted but stores the text alone; store_episode records an episode with its context, goal, action, outcome and insight."),
			content: z
				.string()
				.describe("The memory itself, written so it reads on its own in a later session."),
			createdBy: creatorSchema.optional().describe(
				"The agent this call writes as, recorded as the memory's author (e.g. 'sigma'). " +
					"Omit it when your credential resolves one agent: it is then that agent; a signed-in person omits it and is recorded under its own verified account. " +
					"Otherwise omitting it is refused.",
			),
			relatesTo: z
				.object({
					targetId: memoryIdSchema.describe(
						"The earlier memory this one links to: its memoryId as store_memory, recall or list_memories returned it.",
					),
					type: z
						.enum(["updates", "extends", "derives"])
						.describe(
							"How this memory relates to the earlier one: updates (supersedes it), extends (adds detail to it), derives (is inferred from it).",
						),
				})
				.optional()
				.describe("Links this memory to an earlier one. Omit for a standalone memory. " +
					"With type 'updates' the earlier memory stops being the latest version."),
			ttl: z
				.string()
				.optional()
				.describe("When the memory expires, as an ISO 8601 timestamp, e.g. '2026-06-01T00:00:00Z'. " +
					"Omit it and the memory never expires."),
		},
		{
			outputSchema: storeMemoryServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Store memory",
			memberAuthorDoor: true,
			personDoor: true,
		},
		async ({
			namespace: requestedNamespace,
			type,
			content,
			createdBy,
			relatesTo,
			ttl,
		}) => {
			let contentBytes = 0;
			try {
				contentBytes = assertContentSize(content, "store_memory");

				// A Clerk-JWT member, and a PERSON acting in its own name (an OAuth
				// person token with no agent: defineTool already dropped any acting
				// name), are recorded as their own verified subject by Convex; every
				// other caller names the seat it acts as.
				const selfAuthor =
					memberAuthorLabel(oauthCtx) ??
					(createdBy === undefined ? personActorOf(oauthCtx) : undefined);
				const author = selfAuthor ?? createdBy;
				if (author === undefined) return mcpError(CREATED_BY_REQUIRED);
				const target = resolveWriteNamespace(requestedNamespace, "store_memory");
				if ("denied" in target) return target.denied;
				const namespace = target.namespace;
				const nsDenied = guardWrite(namespace);
				if (nsDenied) return nsDenied;

				const relations = relatesTo
					? [{ targetId: relatesTo.targetId as any, type: relatesTo.type }]
					: [];

				const forwardedAuthor = selfAuthor === undefined ? author : undefined;
				const memoryId = await convex.mutation("memories:storeMemory" as any, {
					namespace,
					type,
					content,
					...(forwardedAuthor !== undefined ? { createdBy: forwardedAuthor } : {}),
					// verifiedPerson for a person acting in its own name (doorScope).
					...doorScopeArgs("memories:storeMemory", forwardedAuthor),
					relations,
					ttl,
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { memoryId, namespace, type, content, createdBy: author };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				if (error instanceof ProtocolError) throw error;
				console.error("[store_memory] mutation failed", {
					contentBytes,
					namespace: requestedNamespace ?? null,
					type,
					createdBy: createdBy ?? null,
					errorMessage: error?.message ?? String(error),
					// A ConvexError's message is redacted to "[Request ID] Server Error"; its
					// code lives on .data. Log it so a typed refusal reads as one.
					errorData: error?.data ?? null,
				});
				return mcpConvexError(error);
			}
		},
	);

	// ── soft_delete_memory ──────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		"soft_delete_memory",
		"Soft-delete a memory so it stops appearing in recall results while remaining in the audit log. " +
			"Returns { deleted: true, memoryId }. WHEN: use to retire an outdated fact or superseded rule without permanent data loss. " +
			"EXAMPLE: soft_delete_memory memoryId='j57dy3049btafda9m2f5d2ggk987ph3f'.",
		{
			memoryId: memoryIdSchema.describe(
				"The memory to retire: its memoryId as returned by store_memory, recall or list_memories.",
			),
		},
		{
			outputSchema: softDeleteMemoryServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: true,
			title: "Hide a memory (soft delete)",
		},
		async ({ memoryId }) => {
			try {
				const denied = guardMasterOnly("soft_delete_memory");
				if (denied) return denied;

				await convex.mutation("memories:softDeleteMemory" as any, {
					memoryId,
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { deleted: true, memoryId };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── erase_memory ────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "public",
			reason:
				"decided by its Convex doors memories:redactMemoryContent (a Clerk-JWT bearer's own session), memories:redactMemoryContentAsPerson (a person bearer, forwarded as verifiedPerson = the bearer hash, resolved by the door) and memories:redactMemoryContentAsAgent (a seat, forwarded as verifiedActor = the agent ID the transport verified): an org admin erases any memory of its org, a member only the memories it authored (stored createdBy = the verified actor name), an agent only the memories its verified agent ID authored (stored createdById), in the row's own organisation; the tool takes no acting name and relays the door's typed refusal unchanged",
		},
		"erase_memory",
		"Permanently erase a secret (a credential, token or key) from a memory: the matching text is replaced in the stored body, the content hash is recomputed and the search index entry is re-indexed and purged, so the original text is gone (unlike soft_delete_memory, which leaves the body readable). " +
			"Returns { memoryId, replacements, contentHashChanged }; a find text that occurs nowhere is refused (REDACT_NO_MATCH), never a silent no-op. " +
			"WHEN: a credential was pasted into a memory and must not stay retrievable. " +
			"Allowed for an organisation admin (any memory of the org), for the person who authored the memory, or for the agent (seat) whose verified ID authored it; anyone else is refused with RBAC_DENIED. " +
			"EXAMPLE: erase_memory memoryId='j57dy3049btafda9m2f5d2ggk987ph3f' redactions=[{find:'sk-live-abc', replaceWith:'[REDACTED]'}].",
		{
			memoryId: memoryIdSchema.describe(
				"The memory holding the secret: its memoryId as returned by recall, list_memories or get_memory.",
			),
			redactions: z
				.array(
					z.object({
						find: z.string().min(1).describe("The exact text to erase, e.g. the leaked token."),
						replaceWith: z
							.string()
							.describe("What replaces it, e.g. '[REDACTED]'. An empty string removes the text."),
					}),
				)
				.min(1)
				.max(50)
				.describe("The find/replace pairs to apply to the memory body (and to every earlier version of it)."),
		},
		{
			readOnlyHint: false,
			idempotentHint: false,
			openWorldHint: false,
			destructiveHint: true,
			title: "Erase text from a memory",
		},
		async ({ memoryId, redactions }) => {
			try {
				// A Clerk-JWT bearer reaches Convex as itself (its own session JWT is
				// forwarded by the client): the session door judges role and org.
				if (authCtx.oauthCtx?.clerkJwt !== undefined) {
					const result = await convex.mutation(
						"memories:redactMemoryContent" as any,
						{ memoryId, redactions },
					);
					return {
						content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					};
				}
				// A person bearer: the bearer hash (verifiedPerson) comes from the
				// verified context via the door-scope resolver, never from an argument.
				const scoped = doorScopeArgs("memories:redactMemoryContentAsPerson", undefined);
				if (scoped.verifiedPerson === undefined) {
					// A seat: the agent the transport verified (never a typed name). The
					// door erases only the memories that agent's stored ID authored.
					if (verifiedActor !== undefined) {
						const result = await convex.mutation(
							"memories:redactMemoryContentAsAgent" as any,
							{ memoryId, redactions, verifiedActor },
						);
						return {
							content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
						};
					}
					return mcpError(
						"Forbidden: erase_memory is for a signed-in person (an organisation admin, or the member who authored the memory) or for a seat with a verified agent identity (it erases the memories that agent authored). This credential is neither.",
					);
				}
				const result = await convex.mutation(
					"memories:redactMemoryContentAsPerson" as any,
					{ memoryId, redactions, ...scoped },
				);
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── erase_row ───────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "public",
			reason:
				"decided by its Convex door erase:eraseRow (convex/lib/eraseRow.ts, one mechanism for every covered table): a Clerk-JWT bearer's own session, a person bearer (verifiedPerson = the bearer hash, resolved by the door) or a seat (verifiedActor = the agent ID the transport verified, added by the wrapped client): an org admin erases any row of its org, an author the rows whose stored author ID it is (a person's subject, an agent's ID), in the row's own organisation; the tool takes no acting name and relays the door's typed refusal unchanged",
		},
		"erase_row",
		"Permanently erase one row you or your organisation own: the row is DELETED (and, for a memory, its search entry is purged), unlike the soft deletes that leave the body readable. " +
			"Covered tables: memories, messages, missions, tasks, recurringTasks, briefingNotes, diary, debateRooms, issues, businessUnits, debateTemplates. " +
			"Returns { table, rowId, erased: true, cascaded }, where cascaded counts the dependent rows deleted with it (receipts, turns, participants). " +
			"WHEN: authored content must be gone for good. " +
			"Allowed for an organisation admin (any row of the org), for the person who wrote the row, or for the agent (seat) whose verified ID wrote it; a row without a stored author ID (legacy, or written by an unverified seat) is erasable by an admin only; anyone else, and any other organisation, is refused with RBAC_DENIED and the row is unchanged. " +
			"For a secret inside a memory that must otherwise stay, use erase_memory. " +
			"EXAMPLE: erase_row table='tasks' rowId='j57dy3049btafda9m2f5d2ggk987ph3f'.",
		{
			table: z
				.enum(ERASE_ROW_TABLES)
				.describe("The table the row lives in; the tool that returned the row tells you which."),
			rowId: z
				.string()
				.min(1)
				.max(64)
				.describe("The row to erase: its ID as returned by the tool that listed it (e.g. " +
					"list_tasks, list_memories, list_messages)."),
		},
		{
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: true,
			title: "Erase a row",
		},
		async ({ table, rowId }) => {
			try {
				// The scope facts come from the verified context (a person's bearer hash);
				// a seat's verifiedActor is added by the wrapped client. A Clerk-JWT bearer
				// carries its own session. Convex refuses everything else, typed.
				const result = await convex.mutation("erase:eraseRow" as any, {
					table,
					rowId,
					...doorScopeArgs("erase:eraseRow", undefined),
				});
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_memory ──────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"get_memory",
		"Fetch a single memory by its memoryId, including relations and episode metadata. " +
			"Returns the memory row as JSON (content, type, namespace, createdBy, relations, isLatest, episode, createdAt, updatedAt): createdBy is the author, episode is present on an episode only; an ID you may not read returns 'Memory not found'. " +
			"WHEN: use when you have a specific memoryId from a prior recall/store and need the full record. " +
			"EXAMPLE: get_memory memoryId='j57dy3049btafda9m2f5d2ggk987ph3f'.",
		{
			memoryId: memoryIdSchema.describe("The memory to fetch: its memoryId as returned by recall, text_search, list_memories or store_memory."),
		},
		{
			outputSchema: getMemoryServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get memory",
		},
		async ({ memoryId }) => {
			try {
				// S3.1.A Wave A — scope-aware filter replaces guardMasterOnly.
				// Non-master clients may now read their own data; cross-tenant rows
				// collapse to a non-leaky "not found" shape (same as a missing row).
				const memory = await convex.query("memories:getMemory" as any, {
					memoryId,
				});
				const filtered = scopeFilterGet(oauthCtx ?? DENIED_SCOPE_CTX, memory);
				if (filtered === null) {
					return mcpError(`Memory not found: ${memoryId}`);
				}
				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = filtered;
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── recall ──────────────────────────────────────────────────────────────────
	// Canonical semantic memory-search tool (fleet-primary, 118 call-sites).
	// The former `search_memories_by_semantic` twin was removed day159
	// (mission vp-mcp-alias-cleanup-v1, S2) — usage, not the code label, decides.

	defineTool(
		server,
		authCtx,
		{ kind: "read", namespaceArg: "namespace" },
		"recall",
		RECALL_TOOL_DESCRIPTION,
		{
			query: z
				.string()
				.describe("What you are looking for, in natural language; results are ranked by meaning, not exact words."),
			namespace: z
				.string()
				.optional()
				.describe("The namespace to read memories from, e.g. " +
					"'project/vantage-peers' or 'orchestrator/sigma'; whoami lists the namespaces your session may read. " +
					"The fleet master may omit it to read every namespace."),
			type: memoryTypeSchema
				.optional()
				.describe("Keep only memories of this kind: user (about a person), feedback (a rule or correction), project (a fact about work), reference (a pointer to an external source), episode (a structured past event). " +
					"Omit to include every kind."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many of the best matches come back; weaker matches beyond it are not returned."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.meta({ deprecated: true })
				.describe("Has no effect on this tool: every row comes back whole, with every stored field, whichever value is sent. Accepted only so that a client which sends it is not refused; leave it out."),
		},
		{
			outputSchema: recallServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Recall memories",
		},
		async ({ query, namespace, type, limit, fields }) => {
			try {
				const nsDenied = guardRead(namespace);
				if (nsDenied) return nsDenied;

				const results = await convex.action("search:recall" as any, {
					query,
					namespace,
					type,
					limit: limit ?? 20,
					fields: fields ?? "lite",
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(results, null, 2),
						},
					],
					// The text stays the bare array; the object form of the same rows.
					structuredContent: arrayStructured(results),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── text_search ─────────────────────────────────────────────────────────────
	// Canonical BM25 keyword memory-search tool (fleet-primary, 18 call-sites).
	// The former `search_memories_by_keyword` twin was removed day159
	// (mission vp-mcp-alias-cleanup-v1, S2) — usage, not the code label, decides.

	defineTool(
		server,
		authCtx,
		{ kind: "read", namespaceArg: "namespace" },
		"text_search",
		TEXT_SEARCH_TOOL_DESCRIPTION,
		{
			query: z.string().describe("The words to match; results are ranked by keyword relevance, so exact terms and IDs work best."),
			namespace: z
				.string()
				.optional()
				.describe("The namespace to read memories from, e.g. " +
					"'project/vantage-peers' or 'orchestrator/sigma'; whoami lists the namespaces your session may read. " +
					"The fleet master may omit it to read every namespace."),
			type: memoryTypeSchema.optional().describe("Keep only memories of this kind: user (about a person), feedback (a rule or correction), project (a fact about work), reference (a pointer to an external source), episode (a structured past event). " +
				"Omit to include every kind."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many of the best matches come back; weaker matches beyond it are not returned."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.meta({ deprecated: true })
				.describe("Has no effect on this tool: every row comes back whole, with every stored field, whichever value is sent. Accepted only so that a client which sends it is not refused; leave it out."),
		},
		{
			outputSchema: textSearchServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Search memories (text)",
		},
		async ({ query, namespace, type, limit, fields }) => {
			try {
				const nsDenied = guardRead(namespace);
				if (nsDenied) return nsDenied;

				const results = await convex.action("search:textSearch" as any, {
					query,
					namespace,
					type,
					limit: limit ?? 20,
					fields: fields ?? "lite",
				});
				return {
					content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
					// The text stays the bare array; the object form of the same rows.
					structuredContent: arrayStructured(results),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── hybrid_search ───────────────────────────────────────────────────────────

	// oracle-justified: verb: a ranked semantic/BM25 search is a different effect from an indexed list on the same
	//   table (SEARCH vs READ-LIST, Pi ruling (a), 2026-11-03); retrieval: RAG namespace retrieval by design
	//   (hybrid RRF), where list_episodes reads an index range (memories:listMemories).
	defineTool(
		server,
		authCtx,
		{ kind: "read", namespaceArg: "namespace" },
		"hybrid_search",
		HYBRID_SEARCH_TOOL_DESCRIPTION,
		{
			query: z.string().describe("What you are looking for; matched both by meaning and by keywords."),
			namespace: z.string().optional().describe("The namespace to read memories from, e.g. " +
				"'project/vantage-peers' or 'orchestrator/sigma'; whoami lists the namespaces your session may read. " +
				"The fleet master may omit it to read every namespace."),
			type: memoryTypeSchema.optional().describe("Keep only memories of this kind: user (about a person), feedback (a rule or correction), project (a fact about work), reference (a pointer to an external source), episode (a structured past event). " +
				"Omit to include every kind."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many of the best matches come back; weaker matches beyond it are not returned."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.meta({ deprecated: true })
				.describe("Has no effect on this tool: every row comes back whole, with every stored field, whichever value is sent. Accepted only so that a client which sends it is not refused; leave it out."),
			vectorWeight: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.meta({ default: 1 })
				.describe("How much the meaning-based ranking counts in the fusion, relative to textWeight; raise it for intent-style queries."),
			textWeight: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.meta({ default: 1 })
				.describe("How much the keyword ranking counts in the fusion, relative to vectorWeight; raise it for exact terms or IDs."),
		},
		{
			outputSchema: hybridSearchServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Search memories by meaning+words",
		},
		async ({
			query,
			namespace,
			type,
			limit,
			fields,
			vectorWeight,
			textWeight,
		}) => {
			try {
				const nsDenied = guardRead(namespace);
				if (nsDenied) return nsDenied;

				const results = await convex.action("search:hybridSearch" as any, {
					query,
					namespace,
					type,
					limit: limit ?? 20,
					fields: fields ?? "lite",
					vectorWeight,
					textWeight,
				});
				return {
					content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
					// The text stays the bare array; the object form of the same rows.
					structuredContent: arrayStructured(results),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── store_episode ───────────────────────────────────────────────────────────

	// oracle-justified: verb: an episode is only ever CREATED (the tool forwards no relations), where
	//   store_memory UPSERTS (an "updates" relation patches the superseded memory); the two share a table
	//   group only because both doors now read the person's token row (verifiedPerson, task
	//   k177e8dyrnykk3c56yf2b0pgfs8hhz06). Pinned on both poles by
	//   convex/__tests__/storeEpisodeNeverSupersedes.test.ts:35 (storeMemory flips the target's isLatest)
	//   and :54 (storeEpisode with the same relation leaves it latest).
	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "createdBy" },
		"store_episode",
		"Store a structured episodic memory capturing context, goal, action, outcome, and insight from a past event. " +
			"Omit namespace to write in your own space. " +
			"Returns { memoryId, type: 'episode', severity, namespace, createdBy }; the memoryId is the episodeId get_episode takes. " +
			"WHEN: use after completing a non-trivial task or encountering an unexpected failure or success. " +
			"EXAMPLE: store_episode namespace='orchestrator/alpha' createdBy='alpha' severity='major' context='...' goal='...' action='...' outcome='...' insight='...'.",
		{
			namespace: z
				.string()
				.optional()
				.describe(
					"Where the episode is stored, e.g. 'orchestrator/pi'. " +
						"Omit it to write in your own space (a signed-in person: 'team/<org>'; a seat: 'orchestrator/<its own agent ID>'); a refused write names the namespaces your session may write.",
				),
			createdBy: creatorSchema.optional().describe(
				"The agent this call writes as, recorded as the episode's author (e.g. 'sigma'). " +
					"Omit it when your credential resolves one agent: it is then that agent; a signed-in person omits it and is recorded under its own verified account. " +
					"Otherwise omitting it is refused.",
			),
			context: z
				.string()
				.describe("The situation that triggered the episode: what the setup was."),
			goal: z.string().describe("What was being attempted."),
			action: z.string().describe("What was actually done."),
			outcome: z.string().describe("What happened as a result, success or failure."),
			insight: z
				.string()
				.describe(
					"The lesson to keep: what to do (or avoid) next time.",
				),
			severity: severitySchema.describe("How far the lesson reaches: critical (every orchestrator should learn it), major (changes how this work is done), minor (a local note)."),
		},
		{
			outputSchema: storeEpisodeServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Store episode",
			memberAuthorDoor: true,
			personDoor: true,
		},
		async ({
			namespace: requestedNamespace,
			createdBy,
			context,
			goal,
			action,
			outcome,
			insight,
			severity,
		}) => {
			try {
				// Same author rule as store_memory (see memberAuthor.ts): a member and
				// a person acting in its own name are recorded by Convex as themselves.
				const selfAuthor =
					memberAuthorLabel(oauthCtx) ??
					(createdBy === undefined ? personActorOf(oauthCtx) : undefined);
				const author = selfAuthor ?? createdBy;
				if (author === undefined) return mcpError(CREATED_BY_REQUIRED);
				const target = resolveWriteNamespace(requestedNamespace, "store_episode");
				if ("denied" in target) return target.denied;
				const namespace = target.namespace;
				const nsDenied = guardWrite(namespace);
				if (nsDenied) return nsDenied;

				const forwardedAuthor = selfAuthor === undefined ? author : undefined;
				const memoryId = await convex.mutation("episodes:storeEpisode" as any, {
					namespace,
					...(forwardedAuthor !== undefined ? { createdBy: forwardedAuthor } : {}),
					...doorScopeArgs("episodes:storeEpisode", forwardedAuthor),
					context,
					goal,
					action,
					outcome,
					insight,
					severity,
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { memoryId, type: "episode", severity, namespace, createdBy: author };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_episode ────────────────────────────────────────────────────────────
	// Day 102 v2.9.0 — episode entity 5-op surface (PR-B).
	// Thin wrapper: episodes are stored as memories with type='episode'
	// (no separate table — see hotfix 7f958d0). This calls memories:getMemory
	// and asserts type='episode' so callers get a non-leaky 404 on wrong-type IDs.

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"get_episode",
		"Fetch a single episode by its memory document ID. " +
			"Episodes are memories with type='episode' carrying context/goal/action/outcome/insight + severity. " +
			"Returns the episode's memory row as JSON (episode { context, goal, action, outcome, insight, severity }, content, namespace, createdBy, relations, createdAt, updatedAt): the structured fields are under episode, the author is createdBy; an ID that is not an episode, or that you may not read, returns 'Episode not found'. " +
			"WHEN: use when you have an episodeId from store_episode or a prior search and need the full record. " +
			"EXAMPLE: get_episode episodeId='j57dy3049btafda9m2f5d2ggk987ph3f'.",
		{
			episodeId: episodeIdSchema.describe("The episode to fetch: the memoryId returned by store_episode, list_episodes or search_episodes_by_semantic."),
		},
		{
			outputSchema: getEpisodeServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get episode",
		},
		async ({ episodeId }) => {
			try {
				// Tenant applied INSIDE the Convex read (`verifiedOrg`): a memory
				// outside the caller's namespaces is answered null by the door and
				// never reaches this process.
				const orgDenied = unresolvedOrgDenial("get_episode");
				if (orgDenied !== null) return orgDenied;
				const memory = await convex.query("memories:getMemory" as any, {
					memoryId: episodeId,
					...doorScopeArgs("memories:getMemory", undefined),
				});
				const filtered = scopeFilterGet(oauthCtx ?? DENIED_SCOPE_CTX, memory);
				if (filtered === null) {
					return mcpError(`Episode not found: ${episodeId}`);
				}
				if ((filtered as any)?.type !== "episode") {
					return mcpError(`Episode not found: ${episodeId}`);
				}
				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = filtered;
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── list_episodes ──────────────────────────────────────────────────────────
	// Day 102 v2.9.0 — episode entity 5-op surface (PR-B).
	// Thin wrapper on memories:listMemories with type='episode' forced.

	defineTool(
		server,
		authCtx,
		{ kind: "read", namespaceArg: "namespace" },
		"list_episodes",
		"List episodes (memories with type='episode') ordered newest first. " +
			"Returns { items, nextCursor, truncated }: items are episode documents, newest first; nextCursor is the next page's cursor, null on the last page; truncated is true when the 60 KB response cap cut the page (nextCursor is then null). The text is the same page as JSON, without nextCursor on the last page. " +
			"WHEN: use to enumerate episodes by namespace or creator before recall/audit. " +
			"EXAMPLE: list_episodes namespace='orchestrator/sigma' limit=20.",
		{
			namespace: z
				.string()
				.optional()
				.describe("The namespace to read episodes from, e.g. " +
					"'orchestrator/sigma' or 'orchestrator/pi'; whoami lists the namespaces your session may read. " +
					"The fleet master may omit it to read every namespace."),
			createdBy: z
				.string()
				.optional()
				.describe("Keep only episodes written by this agent, e.g. 'sigma'. Omit to include every author."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page. Left out on a call that passes cursor, that page holds 50 rows."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.meta({ deprecated: true })
				.describe("Has no effect on this tool: every row comes back whole, with every stored field, whichever value is sent. Accepted only so that a client which sends it is not refused; leave it out."),
			cursor: z
				.string()
				.optional()
				.describe(
					"The nextCursor value a previous list_episodes call returned, to fetch the following (older) page. " +
						"Omit for the first page.",
				),
		},
		{
			outputSchema: listEpisodesServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List episodes",
		},
		async ({ namespace, createdBy, limit, fields, cursor }) => {
			try {
				const nsDenied = guardRead(namespace);
				if (nsDenied) return nsDenied;

				let backendCursor: string | null | undefined;
				if (cursor !== undefined && cursor !== "") {
					try {
						const decoded = decodeCursor(cursor);
						if (decoded && "backendCursor" in decoded) {
							backendCursor = decoded.backendCursor;
						}
					} catch (err: any) {
						return mcpError(err?.message ?? "invalid cursor");
					}
				}
				const effectiveLimit =
					limit === undefined ? undefined : clampLimit(limit);

				const queryArgs: Record<string, unknown> = {
					namespace,
					type: "episode",
					createdBy,
					limit: effectiveLimit ?? 20,
					fields: fields ?? "lite",
				};
				if (backendCursor !== undefined) {
					queryArgs.paginationOpts = {
						numItems: effectiveLimit ?? 50,
						cursor: backendCursor,
					};
				}

				const memories = await convex.query(
					"memories:listMemories" as any,
					queryArgs,
				);

				// S3.3 B8 — extract from Convex paginationOpts shape {value, continueCursor, isDone}
				// Pre-fix bug: handler read memories?.page (undefined) → rawList = [] always.
				const rawList = Array.isArray((memories as any)?.value)
					? (memories as any).value
					: [];

				const filteredList = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					rawList,
				);

				// Encode continueCursor → opaque nextCursor token for the MCP caller.
				const backendNextCursor = (memories as any)?.continueCursor ?? null;
				const isDone = (memories as any)?.isDone ?? true;
				const nextCursor =
					!isDone && backendNextCursor !== null
						? encodeCursor({ backendCursor: backendNextCursor })
						: undefined;

				const envelope = {
					items: filteredList,
					...(nextCursor !== undefined ? { nextCursor } : {}),
				};

				const capped = capListResponse(
					filteredList,
					JSON.stringify(envelope, null, 2),
					"list_episodes",
				);

				return {
					content: [{ type: "text", text: capped.text }],
					structuredContent: pageStructured(envelope, capped),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── search_episodes_by_keyword ─────────────────────────────────────────────
	// Day 102 v2.9.0 — episode entity 5-op surface (PR-B).
	// Thin wrapper on search:textSearch with type='episode' forced.

	defineTool(
		server,
		authCtx,
		{ kind: "read", namespaceArg: "namespace" },
		"search_episodes_by_keyword",
		"BM25 full-text keyword search restricted to episodes (memories with type='episode'). " +
			"Returns { items[{ memoryId, namespace, type, content }] }: the matching episodes, best match first; the text is the same items as a bare JSON array. " +
			"WHEN: use when search_episodes_by_semantic returns too-broad results and you need an exact phrase or ID inside an episode field. " +
			"EXAMPLE: search_episodes_by_keyword query='convex deploy schema' namespace='orchestrator/sigma' limit=10.",
		{
			query: z.string().describe("The words to match; results are ranked by keyword relevance, so exact terms and IDs work best."),
			namespace: z
				.string()
				.optional()
				.describe("The namespace to read episodes from, e.g. " +
					"'orchestrator/sigma' or 'orchestrator/pi'; whoami lists the namespaces your session may read. " +
					"The fleet master may omit it to read every namespace."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many of the best matches come back; weaker matches beyond it are not returned."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.meta({ deprecated: true })
				.describe("Has no effect on this tool: every row comes back whole, with every stored field, whichever value is sent. Accepted only so that a client which sends it is not refused; leave it out."),
		},
		{
			outputSchema: searchEpisodesByKeywordServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Search episodes by keyword",
		},
		async ({ query, namespace, limit, fields }) => {
			try {
				const nsDenied = guardRead(namespace);
				if (nsDenied) return nsDenied;

				const results = await convex.action("search:textSearch" as any, {
					query,
					namespace,
					type: "episode",
					limit: limit ?? 20,
					fields: fields ?? "lite",
				});
				return {
					content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
					// The text stays the bare array; the object form of the same rows.
					structuredContent: arrayStructured(results),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── search_episodes_by_semantic ────────────────────────────────────────────
	// Day 102 v2.9.0 — episode entity 5-op surface (PR-B).
	// Thin wrapper on search:recall with type='episode' forced.

	defineTool(
		server,
		authCtx,
		{ kind: "read", namespaceArg: "namespace" },
		"search_episodes_by_semantic",
		"Semantic vector search restricted to episodes (memories with type='episode'), ranked by cosine similarity. " +
			"Returns { items[{ memoryId, score, namespace, type, content }] }, best match first; the text is the same items as a bare JSON array. " +
			"WHEN: use to recall structured past events by intent — failure modes, lessons, similar contexts. " +
			"EXAMPLE: search_episodes_by_semantic query='hook false positive blocked publish' namespace='orchestrator/sigma' limit=20.",
		{
			query: z
				.string()
				.describe("What you are looking for, in natural language; results are ranked by meaning, not exact words."),
			namespace: z
				.string()
				.optional()
				.describe("The namespace to read episodes from, e.g. " +
					"'orchestrator/sigma' or 'orchestrator/pi'; whoami lists the namespaces your session may read. " +
					"The fleet master may omit it to read every namespace."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many of the best matches come back; weaker matches beyond it are not returned."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.meta({ deprecated: true })
				.describe("Has no effect on this tool: every row comes back whole, with every stored field, whichever value is sent. Accepted only so that a client which sends it is not refused; leave it out."),
		},
		{
			outputSchema: searchEpisodesBySemanticServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Find similar past episodes",
		},
		async ({ query, namespace, limit, fields }) => {
			try {
				const nsDenied = guardRead(namespace);
				if (nsDenied) return nsDenied;

				const results = await convex.action("search:recall" as any, {
					query,
					namespace,
					type: "episode",
					limit: limit ?? 20,
					fields: fields ?? "lite",
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(results, null, 2),
						},
					],
					// The text stays the bare array; the object form of the same rows.
					structuredContent: arrayStructured(results),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_profile ─────────────────────────────────────────────────────────────

	// oracle-justified: single-row read that serves a member only profiles of orchestrators on its own roster
	//   (profiles:getProfile), where list_peers lists and set_summary is an actor-bound write; profile
	//   WRITES are master-only at the Convex door (requireFleetMaster, convex/profiles.ts) because the
	//   table has no orgId.
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"get_profile",
		"Fetch an orchestrator profile with static identity and dynamic session state fields. " +
			"Returns the profile as JSON (orchestratorId, name, static identity, dynamic session state), or null when no profile by that ID is visible to you. " +
			"WHEN: use to check peer status, capabilities, or current task before assigning work. " +
			"EXAMPLE: get_profile orchestratorId='gamma'.",
		{
			orchestratorId: z.string().describe("The orchestrator whose profile to read, e.g. 'gamma', as list_peers shows it."),
		},
		{
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get orchestrator profile",
		},
		async ({ orchestratorId }) => {
			try {
				// S3.1.C1 — scope-aware filter replaces guardMasterOnly.
				// Master + legacy bearer pass through unchanged. Non-master clients
				// see the profile only when createdBy ∈ fromAllowList OR namespace
				// matches namespaceReadPrefixes; otherwise null (non-leaky 404).
				const profile = await convex.query("profiles:getProfile" as any, {
					orchestratorId,
				});
				// Class-sweep fix (mission vp-multitenant-zero-hole-v1, final 8):
				// profiles rows (schema.ts:118) carry `orchestratorId`, NOT
				// `createdBy` and NOT `namespace` -- scopeFilterGet finds nothing
				// to discriminate on and refuses EVERY non-master caller,
				// including the owner (refus-total). Same remedy as
				// list_broadcast_status/list_messages: remap
				// orchestratorId->createdBy before scopeFilterGet, then strip the
				// synthetic field back out.
				const profileWithCreatedBy =
					profile == null
						? null
						: {
								...(profile as Record<string, unknown>),
								createdBy: (profile as Record<string, unknown>)
									.orchestratorId as string | undefined,
							};
				const scoped = scopeFilterGet(
					oauthCtx ?? DENIED_SCOPE_CTX,
					profileWithCreatedBy as any,
				);
				const filteredProfile =
					scoped == null
						? null
						: (() => {
								const { createdBy: _createdBy, ...rest } = scoped as Record<
									string,
									unknown
								>;
								return rest;
							})();
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(filteredProfile, null, 2),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── update_profile ──────────────────────────────────────────────────────────

	// oracle-justified: actor-bound `from` tool, but its door profiles:upsertProfile is master-only (requireFleetMaster,
	//   convex/profiles.ts: the table has no orgId); get_profile serves a member its own roster.
	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "orchestratorId" },
		"update_profile",
		"Create or update an orchestrator profile with static identity facts and dynamic session state. " +
			"Writes only the calling agent's own profile (the fleet master may write any); given fields replace the stored ones, omitted fields are kept. " +
			"Returns { profileId, orchestratorId, name }. " +
			"WHEN: call on each session start to update lastSeen/sessionCount, or when role/capabilities change. " +
			"EXAMPLE: update_profile orchestratorId='alpha' dynamic={lastSeen: Date.now(), sessionCount: 5}.",
		{
			orchestratorId: z.string().describe("The orchestrator whose profile is written, as list_peers shows it. " +
				"Omit it when your credential resolves one agent: it is then that agent. Otherwise omitting it is refused."),
			name: z.string().optional().describe("The display name shown to peers. Omit to keep the stored one ('Unknown' on a new profile)."),
			static: z
				.object({
					role: z.string().describe("What this orchestrator is for, in a few words."),
					workspace: z.string().describe("The orchestrator's primary working directory."),
					capabilities: z
						.array(z.string())
						.describe("Keywords for what this orchestrator can do, e.g. ['convex', 'mcp']."),
				})
				.optional()
				.describe("Identity facts that rarely change. Omit to keep the stored ones; given, the whole object is replaced."),
			dynamic: z
				.object({
					currentTask: z
						.string()
						.optional()
						.describe("The task or goal in progress. Omit to clear it in the replaced state."),
					lastSeen: z
						.number()
						.describe("The moment this session started (a millisecond timestamp, as Date.now() gives)."),
					sessionCount: z.number().int().describe("How many sessions this orchestrator has run so far."),
				})
				.optional()
				.describe("Session state. Omit to keep the stored state; given, the whole object is replaced."),
		},
		{
			outputSchema: updateProfileServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Update an agent profile",
		},
		async ({ orchestratorId, name, static: staticFields, dynamic }) => {
			try {
				const profileId = await convex.mutation(
					"profiles:upsertProfile" as any,
					{
						orchestratorId,
						name,
						static: staticFields,
						dynamic,
					},
				);

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { profileId, orchestratorId, name };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── list_memories ───────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "read", namespaceArg: "namespace" },
		"list_memories",
		"List active (isLatest=true) memories for a namespace, ordered newest first. " +
			"Returns { items, nextCursor, truncated }: items are memory documents (latest versions only), newest first; nextCursor is the next page's cursor, null on the last page; truncated is true when the 60 KB response cap cut the page (nextCursor is then null). The text is the same page as JSON, without nextCursor on the last page. " +
			"WHEN: use to audit what a namespace contains or to paginate all entries without a query. " +
			"EXAMPLE: list_memories namespace='project/vantage-peers' type='project' limit=20.",
		{
			namespace: z
				.string()
				.describe(
					"The namespace to list, e.g. 'global' or 'orchestrator/pi'; whoami lists the namespaces your session may read.",
				),
			type: memoryTypeSchema
				.optional()
				.describe("Keep only memories of this kind: user (about a person), feedback (a rule or correction), project (a fact about work), reference (a pointer to an external source), episode (a structured past event). " +
					"Omit to include every kind."),
			createdBy: assigneeSchema
				.optional()
				.describe(
					"Keep only memories written by this agent, e.g. 'pi'. Omit to include every author.",
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page. Left out on a call that passes cursor, that page holds 50 rows."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.meta({ deprecated: true })
				.describe("Has no effect on this tool: every row comes back whole, with every stored field, whichever value is sent. Accepted only so that a client which sends it is not refused; leave it out."),
			cursor: z
				.string()
				.optional()
				.describe(
					"The nextCursor value a previous list_memories call returned, to fetch the following (older) page. " +
						"Omit for the first page.",
				),
		},
		{
			outputSchema: listMemoriesServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List memories",
		},
		async ({ namespace, type, createdBy, limit, fields, cursor }) => {
			try {
				const nsDenied = guardRead(namespace);
				if (nsDenied) return nsDenied;

				// S3.3 B8 — decode cursor → backendCursor (paginationOpts.cursor)
				let backendCursor: string | null | undefined;
				if (cursor !== undefined && cursor !== "") {
					try {
						const decoded = decodeCursor(cursor);
						if (decoded && "backendCursor" in decoded) {
							backendCursor = decoded.backendCursor;
						}
					} catch (err: any) {
						return mcpError(err?.message ?? "invalid cursor");
					}
				}
				const effectiveLimit =
					limit === undefined ? undefined : clampLimit(limit);

				const queryArgs: Record<string, unknown> = {
					namespace,
					type,
					createdBy,
					limit: effectiveLimit ?? 20,
					fields: fields ?? "lite",
				};
				if (backendCursor !== undefined) {
					queryArgs.paginationOpts = {
						numItems: effectiveLimit ?? 50,
						cursor: backendCursor,
					};
				}

				const memories = await convex.query(
					"memories:listMemories" as any,
					queryArgs,
				);

				// S3.3 B8 — extract from Convex paginationOpts shape {value, continueCursor, isDone}
				// Pre-fix bug: handler read memories?.page (undefined) → rawList = [] always.
				const rawList = Array.isArray((memories as any)?.value)
					? (memories as any).value
					: [];

				// S3.1.A Wave A — row-level scope filter on the post-query list.
				// Master + legacy bearer pass through unchanged. Non-master clients
				// see only rows whose createdBy ∈ fromAllowList OR whose namespace
				// matches one of namespaceReadPrefixes (exact or '/' boundary).
				const filteredList = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					rawList,
				);

				// Encode continueCursor → opaque nextCursor token for the MCP caller.
				const backendNextCursor = (memories as any)?.continueCursor ?? null;
				const isDone = (memories as any)?.isDone ?? true;
				const nextCursor =
					!isDone && backendNextCursor !== null
						? encodeCursor({ backendCursor: backendNextCursor })
						: undefined;

				const filteredEnvelope = {
					items: filteredList,
					...(nextCursor !== undefined ? { nextCursor } : {}),
				};

				const capped = capListResponse(
					filteredList,
					JSON.stringify(filteredEnvelope, null, 2),
					"list_memories",
				);
				const text = appendMarkerIfEnabled(capped.text, () => ({
					kind: "memory-quote",
					items: filteredList.map((m: any) => ({
						_id: m._id,
						namespace: m.namespace,
						type: m.type,
						content: m.content,
						score: m.score,
					})),
				}));

				return {
					content: [{ type: "text", text }],
					structuredContent: pageStructured(filteredEnvelope, capped),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── send_message ────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "from" },
		"send_message",
		"Send a message to one or more agents BY AGENT ID (recipientAgentIds, the `agentId` values list_peers returns), or via channel routing (broadcast / fleet role / instance). " +
			"Returns { messageId, from, recipientAgentIds or channel }, plus stateUnverified (the state claims in the content the server could not check) when there are any; keep messageId for list_broadcast_status. " +
			"WHEN: use to notify peers of task completion, handoff, or decision; creates one receipt per recipient. " +
			"Pass exactly one of recipientAgentIds and channel; an agent of your organisation is addressed by its ID, a name is never matched against an ID. " +
			"EXAMPLE: send_message from='agent-a' recipientAgentIds=['<agentId from list_peers>'] content='Brief ready'. " +
			"EXAMPLE: send_message from='alpha' channel='beta' content='C3 descriptions PR ready for review'.",
		{
			from: creatorSchema
				.optional()
				.describe(
					"The agent sending, by name (e.g. 'sigma'), recorded as the sender. " +
						"Omit it when your credential resolves one agent (it is then that agent) or when you are a signed-in person (you send in your own name). " +
						"Otherwise omitting it is refused.",
				),
			fromAgentId: z
				.string()
				.min(1)
				.optional()
				.describe(
					"The agent this message is sent as, named by its agent ID: yours is whoami's agent_id, and list_peers shows each agent's agentId; the recipients see that agent as the sender. " +
						"Given beside from, the ID alone decides; a verified agent may only name itself. " +
						"Omit it to be identified by your credential or by from.",
				),
			fromInstanceId: z
				.string()
				.optional()
				.describe("The sending instance, e.g. 'pi-chromebook', as set_summary and list_peers name it. " +
					"Omit when you run as a single instance."),
			channel: z
				.string()
				.optional()
				.describe(
					"Recipients by name: 'broadcast' for everyone, a role such as 'tau', an instance such as 'pi-vps', or several comma-separated. " +
						"Omit it when recipientAgentIds is given.",
				),
			recipientAgentIds: z
				.array(z.string().min(1))
				.min(1)
				.max(50)
				.optional()
				.describe(
					"Recipients by agent ID: the agentId values list_peers returns for your organisation. " +
						"A name here is refused, never matched. Omit it when channel is given.",
				),
			content: z.string().describe("The message text the recipients will read."),
			sessionDay: z
				.number()
				.int()
				.optional()
				.describe(
					"The session day the message belongs to (Day 1 = 2026-03-06 UTC); list_messages filters by it. " +
						"Omit it and today's day is derived.",
				),
			tenantId: z
				.string()
				.optional()
				.describe("The organisation the message belongs to, by slug (whoami returns yours as org_slug). " +
					"Omit it: it is derived from your credential. " +
					"A slug other than your own organisation's is refused unless you are the fleet master."),
		},
		{
			outputSchema: sendMessageServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Send message",
			personDoor: true,
		},
		async ({
			from,
			fromAgentId,
			fromInstanceId,
			channel,
			recipientAgentIds,
			content,
			sessionDay,
			tenantId,
		}) => {
			let contentBytes = 0;
			try {
				// A sender named BY ID is judged against the agent this call is
				// verified as, before anything is sent; Convex judges it again
				// (messages:sendMessage). Without a verified agent the ID cannot
				// stand alone: the roster / binding gates read `from`, so it must
				// accompany the ID.
				if (fromAgentId !== undefined) {
					const proven = verifiedActorOf(oauthCtx);
					if (proven !== undefined && proven.agentId !== fromAgentId) {
						return mcpError(
							"AGENT_IDENTITY_MISMATCH: fromAgentId is not the agent this call is verified as — a verified caller may only send as itself.",
						);
					}
					if (proven === undefined && from === undefined) {
						return mcpError(
							"INVALID_SENDER: fromAgentId needs a verified agent identity or `from` beside it — pass `from` (the sender's name) with fromAgentId.",
						);
					}
				}
				// Exactly one recipient form. Refused here, before anything is
				// resolved or sent; Convex refuses the same (INVALID_RECIPIENTS).
				if ((channel === undefined) === (recipientAgentIds === undefined)) {
					return mcpError(
						"INVALID_RECIPIENTS: send_message takes exactly one of `recipientAgentIds` (agent IDs from list_peers `agentId`) or `channel` (broadcast, a fleet role, an instance).",
					);
				}
				// No sender named: a person acting in its own name (doorScope verifiedPerson).
				// An instance label, if typed, is forwarded and refused by the
				// Convex human door (a person has no instance).
				let senderInstance: string | undefined = fromInstanceId;
				if (from !== undefined) {
					const instanceCheck = checkInstanceOfSender(
						oauthCtx,
						from,
						fromInstanceId,
					);
					if (instanceCheck.error) return mcpError(instanceCheck.error);
					senderInstance = instanceCheck.instance;
				}

				// State tokens (Day 128 brief, k... — "un état tapé à la main
				// est un mensonge en sursis"): {{pr:owner/repo#N}} /
				// {{npm:pkg[@tag]}} / {{task:taskId}} are resolved against the
				// LIVE source right now, at send time — never from a value the
				// author typed earlier in the compose session. Resolution
				// failure (unreachable network, nonexistent artifact) is
				// fail-closed: the message is NOT sent, and the caller gets an
				// explicit "ÉTAT NON RÉSOLU" error citing what could not be
				// resolved. Content with zero tokens passes through unchanged.
				let resolvedContent: string;
				try {
					resolvedContent = await resolveStateTokens(content, {
						fetchImpl: fetch,
						convexQuery: (name, args) => convex.query(name as any, args),
						now: () => new Date(),
						githubToken: process.env.GITHUB_TOKEN,
					});
				} catch (tokenError) {
					if (tokenError instanceof StateTokenError) {
						throw new ProtocolError(
							ProtocolErrorCode.InvalidParams,
							`ÉTAT NON RÉSOLU — send_message aborted, nothing was sent: ${tokenError.message}`,
						);
					}
					throw tokenError;
				}

				// Layer 2 (Day 128 brief, defence-in-depth over Layer 1 above):
				// catch a hand-typed living-artifact state claim in the
				// `evidence:` field of the message that was typed INSTEAD of
				// using a `{{pr:...}}` / `{{npm:...}}` / `{{task:...}}` token.
				// Re-verifies the claim against the live source; a
				// contradiction is a hard refusal (nothing is sent). Fail-OPEN
				// (warns, allows) when the live value cannot be determined —
				// this is a safety net over unmarked prose, not an explicit
				// resolution request, so erring toward not-blocking is correct.
				// The third state. A guard has three outcomes, never two: it passed,
				// it bit, or IT COULD NOT MEASURE. Collapsing the last into the first
				// is how an absence of measurement becomes a certificate of cleanliness.
				// This guard is fail-open on "cannot verify" — deliberately, see above —
				// but fail-open MUST NOT mean fail-silent: the warning went to the
				// server's own console, where the orchestrator who sent the message
				// never sees it, so from the caller's side "GitHub was unreachable"
				// and "your claim checks out" rendered the SAME screen. They are
				// returned to the caller now, on the send result.
				const unverified: string[] = [];
				try {
					await guardFreshState(resolvedContent, {
						fetchImpl: fetch,
						convexQuery: (name, args) => convex.query(name as any, args),
						now: () => new Date(),
						githubToken: process.env.GITHUB_TOKEN,
						defaultRepo: process.env.STATE_TOKENS_DEFAULT_REPO,
						warn: (message) => unverified.push(message),
					});
				} catch (guardError) {
					if (guardError instanceof FreshStateGuardError) {
						throw new ProtocolError(
							ProtocolErrorCode.InvalidParams,
							`ÉTAT PÉRIMÉ — send_message aborted, nothing was sent: ${guardError.message}`,
						);
					}
					if (guardError instanceof BareStateLiteralError) {
						throw new ProtocolError(
							ProtocolErrorCode.InvalidParams,
							`ÉTAT SANS COMMANDE — send_message aborted, nothing was sent: ${guardError.message}`,
						);
					}
					throw guardError;
				}

				contentBytes = assertContentSize(resolvedContent, "send_message");

				// A.7: auto-derive sessionDay from project epoch when caller omits it.
				// Day 1 = 2026-03-06 UTC (Day 88 confirmed as 2026-06-01).
				// Explicit args.sessionDay always wins (backward-compat).
				const derivedSessionDay: number =
					sessionDay !== undefined ? sessionDay : deriveSessionDay();

				// C2: normalize orchestrator-id fields at write time (B2 §6+§7).
				// `channel` may be "broadcast", a role name, or "pi,tau" CSV —
				// only normalize non-broadcast single-role values to preserve CSV
				// splitting behaviour in the Convex layer.
				const normFrom =
					from === undefined ? undefined : normalizeOrchestratorId(from);
				// A person channel ("user:<Clerk subject>") is also kept verbatim: a
				// subject is case-sensitive and Convex matches it byte for byte
				// against the name the person was written down under.
				// Agent IDs are forwarded verbatim: an ID is never normalised.
				const normChannel =
					channel === undefined ||
					channel === "broadcast" ||
					channel.includes(",") ||
					channel.toLowerCase().startsWith(PERSON_ACTOR_PREFIX)
						? channel
						: normalizeOrchestratorId(channel);
				// The seat's verified org rides along so Convex scopes the
				// RECIPIENTS to it (doorScope seatOrgSlug). Resolved before any write.
				const seatDoor = doorScope("messages:sendMessage", from);
				if ("denied" in seatDoor) return mcpError(seatDoor.denied);
				const messageId = await convex.mutation("messages:sendMessage" as any, {
					from: normFrom,
					...(fromAgentId !== undefined ? { fromAgentId } : {}),
					fromInstanceId: senderInstance,
					...(recipientAgentIds !== undefined
						? { recipientAgentIds }
						: { channel: normChannel }),
					content: resolvedContent,
					sessionDay: derivedSessionDay,
					tenantId,
					...seatDoor.args,
				});
				const sender = from ?? personActorOf(oauthCtx);

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = unverified.length > 0
					? {
							messageId,
							from: sender,
							...(recipientAgentIds !== undefined
								? { recipientAgentIds }
								: { channel }),
							stateUnverified: unverified,
						}
					: {
							messageId,
							from: sender,
							...(recipientAgentIds !== undefined
								? { recipientAgentIds }
								: { channel }),
						};
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				if (error instanceof ProtocolError) throw error;
				console.error("[send_message] mutation failed", {
					contentBytes,
					from,
					channel,
					recipientAgentIds,
					errorMessage: error?.message ?? String(error),
					// A ConvexError's message is redacted to "[Request ID] Server Error"; its
					// code lives on .data. Log it so a typed refusal reads as one.
					errorData: error?.data ?? null,
				});
				return mcpConvexError(error);
			}
		},
	);

	// ── check_messages ──────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"recipient restricted in-handler to identities the token may speak as (fromAllowList/userId)",
		},
		"check_messages",
		"Check for unread messages addressed to a recipient role, returning receiptIds for acknowledgment. " +
			"Returns a JSON array of { receiptId, from, fromInstanceId, fromId?, channel, content, createdAt } (pass the receiptIds to mark_as_read), or 'No new messages.'; a truncated page ends with the since= value to resume, and stuckInProgress / peersStuckOnYou blocks follow when present. " +
			"WHEN: call at session start and after long pauses to drain the inbox before starting work. " +
			"EXAMPLE: check_messages recipient='gamma' recipientInstanceId='gamma-vps'.",
		{
			recipient: creatorSchema.describe(
				"The orchestrator whose inbox to read, e.g. 'sigma'.",
			),
			recipientInstanceId: z
				.string()
				.optional()
				.describe(
					"Also read the messages addressed to this instance, e.g. 'pi-chromebook', as set_summary names it. " +
						"Omit to read role-addressed messages only.",
				),
			tenantId: z
				.string()
				.optional()
				.describe("Keep only messages of this organisation, by slug (whoami returns yours as org_slug). " +
					"Omit for every organisation your session may read."),
			since: z
				.number()
				.int()
				.optional()
				.describe(
					"The moment after which messages count: return only messages created after it (a millisecond timestamp, as Date.now() gives). " +
						"Pass the nextSince of a truncated reply to page the backlog. Omit for the whole unread backlog.",
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(50)
				.optional()
				.meta({ default: 20 })
				.describe(
					"How many messages to return in this call; pair a smaller value with since to page.",
				),
		},
		{
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Check messages",
		},
		async ({ recipient, recipientInstanceId, tenantId, since, limit }) => {
			try {
				// Non-master: caller may read messages addressed to any identity
				// they are authorized to speak as, i.e. recipient ∈ fromAllowList.
				// fromAllowList is the set of `from` values the bearer can use
				// when sending; by symmetry the bearer can also read the inbox
				// of each of those identities (case variants, multi-host orches-
				// trator personas, shared-team aliases). Anything else would
				// let the client read another tenant's inbox. The legacy
				// userId equality is preserved as a fallback when fromAllowList
				// is empty (e.g. minted token without explicit allow list).
				if (oauthCtx && !isMasterScope(oauthCtx)) {
					// C2 (Day 92): NFC + case-insensitive comparison per B2 §6+§7.
					// Raw .includes() was exact-match only, rejecting "ELAN" when
					// fromAllowList contained "Elan". Now both sides are normalized.
					const normRecipient = normalizeOrchestratorId(recipient);
					const allowed =
						(oauthCtx.fromAllowList?.length ?? 0) > 0
							? oauthCtx.fromAllowList.some(
									(a) => normalizeOrchestratorId(a) === normRecipient,
								)
							: normRecipient === normalizeOrchestratorId(oauthCtx.userId);
					if (!allowed) {
						return mcpError(
							`Forbidden: check_messages can only read messages addressed to an identity you are authorized to speak as (token userId='${oauthCtx.userId}', allowed senders=[${(oauthCtx.fromAllowList ?? []).join(", ")}]); requested recipient '${recipient}' is not in that set.`,
						);
					}
				}

				const orgUnresolved = unresolvedOrgDenial("check_messages");
				if (orgUnresolved) return orgUnresolved;
				const result = await convex.query(
					"messages:checkNewMessagesEnvelope" as any,
					{
						recipient,
						recipientInstanceId,
						tenantId,
						since,
						limit,
						...doorScopeArgs("messages:checkNewMessagesEnvelope", recipient),
					},
				);
				// Day-156 reader-first: extra envelope fields are ignored;
				// missing keys MUST default so old Convex prod cannot throw
				// `.length` on undefined. Do not revive pendingOnYou.
				const envelope = (result ?? {}) as {
					messages?: Array<{
						receiptId: string;
						from: string;
						fromInstanceId?: string;
						fromId?: string;
						channel?: string;
						content: string;
						createdAt: number;
					}>;
					truncated?: boolean;
					nextSince?: number | null;
					staleInProgress?: Array<{
						taskId: string;
						title: string;
						age: number;
					}>;
					stuckInProgress?: unknown;
					peersStuckOnYou?: unknown;
				};
				const messages = envelope.messages ?? [];
				const truncated = envelope.truncated ?? false;
				const nextSince = envelope.nextSince ?? null;
				const stuckInProgress = asCappedStuckList(envelope.stuckInProgress);
				const peersStuckOnYou = asCappedStuckList(envelope.peersStuckOnYou);

				const stuckBlocks: string[] = [];
				// Stuck SIGNAL = entries present OR truncated (a cap with an
				// empty page is still a signal — never Vide).
				if (stuckInProgress.entries.length > 0 || stuckInProgress.truncated) {
					stuckBlocks.push(
						`stuckInProgress:\n${JSON.stringify(stuckInProgress, null, 2)}`,
					);
				}
				if (peersStuckOnYou.entries.length > 0 || peersStuckOnYou.truncated) {
					stuckBlocks.push(
						`peersStuckOnYou:\n${JSON.stringify(peersStuckOnYou, null, 2)}`,
					);
				}
				const stuckText = stuckBlocks.join("\n\n");

				if (messages.length === 0) {
					return {
						content: [
							{
								type: "text",
								// Empty unread + non-empty stuck must still surface
								// the stuck block — never "No new messages." / Vide.
								text: stuckText.length > 0 ? stuckText : "No new messages.",
							},
						],
					};
				}

				const payload = messages.map((m) => ({
					receiptId: m.receiptId,
					from: m.from,
					fromInstanceId: m.fromInstanceId,
					...(m.fromId !== undefined ? { fromId: m.fromId } : {}),
					channel: m.channel,
					content: m.content,
					createdAt: m.createdAt,
				}));

				const body = JSON.stringify(payload, null, 2);
				const truncatedNote = truncated
					? `\n— truncated. Resume with check_messages since=${nextSince}`
					: "";
				const text =
					stuckText.length > 0
						? `${body}${truncatedNote}\n\n${stuckText}`
						: `${body}${truncatedNote}`;

				return {
					content: [
						{
							type: "text",
							text,
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── list_blocked_on_me ──────────────────────────────────────────────────────

	// oracle-justified: identity-gated by its Convex door tasks:listBlockedOnMe (verifiedActor agent ID), not
	//   in-handler org filtering like list_tasks; bounded opt-in read with no cursor; isolation at the
	//   convex-door, boundary key agentId(verifiedActor). The instrument has no category for a door guarded
	//   in Convex: task k1735h1xs805q1dwh3xd3vhzw98gygdy. Ruled by Pi 2026-10-28 (msg receipt
	//   k978emevw7gpnz3vy01s3p0ntd8h5sch).
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"no in-handler recipient gate: tasks:listBlockedOnMe serves only the agent resolved by ID from the verified identity (a seat's verifiedActor); refuses a label-only reader and the claimless service account; recipient is ignored and never forwarded",
		},
		"list_blocked_on_me",
		"List the tasks that other peers have BLOCKED on one of YOUR live tasks (blockedOnTaskId), oldest wait first, with the age of each wait. " +
			"A dedicated opt-in read: check_messages returns messages only and never carries this list. " +
			"WHEN: call after check_messages, or before picking new work, to see who is waiting on you. " +
			"EXAMPLE: list_blocked_on_me. Returns { entries[{ blockedTaskId, blockedTitle, blockedAssignee, onTaskId, onTaskTitle, age }], total, truncated, oldestAge }; ages are ms. " +
			"truncated=true means the bounded scan stopped early and total is a lower bound. " +
			"An empty list is a real absence; a refusal is an error, never an empty list.",
		{
			recipient: creatorSchema
				.optional()
				.meta({ deprecated: true })
				.describe(
					"Has no effect: the waiters listed are always those of the verified agent your credential resolves, whatever name is sent, and a caller with none is refused. " +
						"Accepted only so that a client which sends it is not refused; leave it out.",
				),
			tenantId: z
				.string()
				.optional()
				.describe("Keep only waiters of this organisation, by slug (whoami returns yours as org_slug). " +
					"Omit for every organisation your session may read."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 50 })
				.describe(
					"How many waiters to list; total still counts every waiter found.",
				),
		},
		{
			outputSchema: listBlockedOnMeServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List tasks blocked on me",
		},
		async ({ tenantId, limit }) => {
			try {
				// No speak-as gate and no name forwarded: Convex serves only the verified
				// agent, by ID. `recipient` is accepted for compatibility and ignored.
				const orgUnresolved = unresolvedOrgDenial("list_blocked_on_me");
				if (orgUnresolved) return orgUnresolved;
				const result = await convex.query(
					// biome-ignore lint/suspicious/noExplicitAny: Convex string API
					"tasks:listBlockedOnMe" as any,
					{
						...(tenantId !== undefined ? { tenantId } : {}),
					},
				);
				const waiters = (result ?? {}) as {
					entries?: unknown[];
					total?: number;
					truncated?: boolean;
					oldestAge?: number;
				};
				const entries = waiters.entries ?? [];
				const shown = entries.slice(0, limit ?? 50);
				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = {
						entries: shown,
						total: waiters.total ?? entries.length,
						truncated: waiters.truncated ?? false,
						oldestAge: waiters.oldestAge ?? 0,
					};
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── mark_as_read ────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"mark_as_read",
		"Mark one or more message receipts as read using receiptIds from check_messages. " +
			"Returns { markedAsRead: <count> }; a receipt already read is not counted again. " +
			"WHEN: call immediately after processing each batch of messages returned by check_messages. " +
			"EXAMPLE: mark_as_read receiptIds=['j57aaaaa...', 'j57bbbbb...'] callerOrchestrator='pi'.",
		{
			receiptIds: idListSchema(receiptIdSchema).describe(
				"The receipts to acknowledge: the receiptId values check_messages returned, as a list.",
			),
			// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
			callerOrchestrator: creatorSchema
				.optional()
				.describe(
					"The recipient marking its own receipts; each receipt must be addressed to it. " +
						"Omit it when your credential resolves one agent: it is then that agent. " +
						"An organisation-level token and the fleet master must name it.",
				),
		},
		{
			outputSchema: markAsReadServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			// Own-state write: the receipt-owner check (callerOrchestrator must be
			// the receipt's recipient, messages:markAsRead) is the authority, so a
			// viewer person may mark its own receipts read (Pi ruling).
			ownStateOnly: true,
			title: "Mark messages as read",
		},
		async ({ receiptIds, callerOrchestrator }) => {
			try {
				// Normalised to an array by idListSchema before validation.
				const receiptIdsArray: string[] = receiptIds;
				const orgUnresolved = unresolvedOrgDenial("mark_as_read");
				if (orgUnresolved) return orgUnresolved;
				const count = await convex.mutation("messages:markAsRead" as any, {
					receiptIds: receiptIdsArray,
					callerOrchestrator,
					...doorScopeArgs("messages:markAsRead", callerOrchestrator),
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { markedAsRead: count };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── delete_message ──────────────────────────────────────────────────────────

	// oracle-justified: actor-bound `from` write (callerOrchestrator) whose door compares message.tenantId with the
	//   caller's org before deleting (messages:deleteMessage); list_broadcast_status is an
	//   in-handler-filtered read whose crud is `?` because it loads the message by id and lists its
	//   receipts, a get+list composite.
	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"delete_message",
		"Delete a message and all its receipts; only the original sender or system may delete. " +
			"Returns { deleted: true, receiptsDeleted }. " +
			"WHEN: use to retract a mistaken broadcast or sensitive content before recipients read it. " +
			"EXAMPLE: delete_message messageId='j57dy3049btafda9m2f5d2ggk987ph3f' callerOrchestrator='alpha'.",
		{
			messageId: messageIdSchema.describe(
				"The message to delete: its messageId as returned by send_message, list_messages or get_message.",
			),
			// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
			callerOrchestrator: creatorSchema
				.optional()
				.describe("The agent deleting; it must be the message's sender (or 'system'). " +
					"Omit it when your credential resolves one agent: it is then that agent. " +
					"A signed-in organisation admin may also omit it; anyone else omitting it is refused."),
		},
		{
			outputSchema: deleteMessageServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: true,
			title: "Delete message",
		},
		async ({ messageId, callerOrchestrator }) => {
			try {
				const orgUnresolved = unresolvedOrgDenial("delete_message");
				if (orgUnresolved) return orgUnresolved;
				const result = await convex.mutation("messages:deleteMessage" as any, {
					messageId: messageId as any,
					callerOrchestrator,
					...doorScopeArgs("messages:deleteMessage", callerOrchestrator),
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = result;
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── set_summary ─────────────────────────────────────────────────────────────

	// oracle-justified: actor-bound `from` tool, but its door profiles:updateDynamic is master-only (requireFleetMaster,
	//   convex/profiles.ts: the table has no orgId); get_profile serves a member its own roster.
	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "orchestratorId" },
		"set_summary",
		"Set the status summary of an orchestrator instance: one or two sentences on what it is working on now, replacing the previous summary, which peers read in list_peers. " +
			"Returns { orchestratorId, instanceId, summary }. " +
			"WHEN: use at the start of a session and after a major change of focus, so peers see what you are doing. " +
			"EXAMPLE: set_summary orchestratorId='alpha' instanceId='alpha-vps' summary='Standardizing 86 tool descriptions for B2'.",
		{
			orchestratorId: z.string().describe("The orchestrator whose summary this is, e.g. 'alpha', as list_peers shows it. " +
				"Omit it when your credential resolves one agent: it is then that agent. Otherwise omitting it is refused."),
			instanceId: z
				.string()
				.optional()
				.describe("Which running instance this is, e.g. 'pi-vps'; list_peers shows one row per instance. " +
					"Omit for the orchestrator's role-level profile."),
			summary: z.string().describe("One or two sentences on what you are working on now, shown to peers by list_peers."),
			endOfDayIndex: z
				.string()
				.optional()
				.describe(
					"The durable end-of-day index written by close-day, kept apart from summary so the next live-status write does not overwrite it. " +
						"Omit it on normal updates: the stored index is kept.",
				),
		},
		{
			outputSchema: setSummaryServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Set my status summary",
		},
		async ({ orchestratorId, instanceId, summary, endOfDayIndex }) => {
			try {
				await convex.mutation("profiles:updateDynamic" as any, {
					orchestratorId,
					instanceId,
					currentTask: summary,
					endOfDayIndex,
					lastSeen: Date.now(),
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { orchestratorId, instanceId, summary };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── list_peers ──────────────────────────────────────────────────────────────

	// oracle-justified: served to the fleet master only: a member receives { refused: true, items: [] }
	//   (profiles:listProfiles, convex/profiles.ts); get_profile serves a member its own roster and
	//   profile writes are master-only (requireFleetMaster).
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"org-scoped non-master token served from its own org roster via listPeersFromOrgRoster(convex,oauthCtx,...) " +
				"(org derived server-side from the verified session/token by orgRoster:getMyAgentDirectory / orgRoster:getAgentDirectoryForAccessToken); " +
				"master and no-org tokens scoped in-handler via scopeFilterList(oauthCtx,...)",
		},
		"list_peers",
		"List all orchestrator profiles with current status, summary, and session info, newest first. " +
			"For an organisation token, lists the organisation's agents, each with its unique `agentId`: pass it to send_message `recipientAgentIds` (agentId null = not addressable). " +
			"Returns { items, nextCursor, truncated, scopeFiltered? }: items are profiles, newest first; nextCursor is the next page's cursor, null on the last page; scopeFiltered counts rows withheld by scope; truncated is true when the 60 KB response cap cut the page (nextCursor is then null). The text is the bare JSON array of the profiles, or { items, nextCursor?, scopeFiltered? } when another page exists or rows were withheld. " +
			"WHEN: use before assigning work or sending a DM to confirm who is active and what they are doing. " +
			"EXAMPLE: list_peers limit=20.",
		{
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.meta({ deprecated: true })
				.describe("Has no effect on this tool: every row comes back whole, with every stored field, whichever value is sent. Accepted only so that a client which sends it is not refused; leave it out."),
			cursor: z
				.string()
				.optional()
				.describe(
					"The nextCursor value a previous list_peers call returned, to fetch the following (older) page. " +
						"Omit for the first page.",
				),
		},
		{
			outputSchema: listPeersServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List my organisation's agents",
		},
		async ({ limit, fields, cursor }) => {
			try {
				// S3.3 B8 follow-up batch 3 FINAL — decode opaque cursor → createdBefore.
				let createdBefore: number | undefined;
				if (cursor !== undefined && cursor !== "") {
					try {
						const decoded = decodeCursor(cursor);
						if (decoded && "createdBefore" in decoded) {
							createdBefore = decoded.createdBefore;
						}
					} catch (err: any) {
						return mcpError(err?.message ?? "invalid cursor");
					}
				}
				const effectiveLimit =
					limit === undefined ? undefined : clampLimit(limit);

				// Org-scoped non-master token: served from its own org roster (the org
				// is derived server-side from the verified credential, never from an
				// argument). Master and no-org tokens fall through to scopeFilterList.
				const rosterListing = await listPeersFromOrgRoster(convex, oauthCtx);
				if (rosterListing !== null) return rosterListing;

				// S3.1.B Wave B — scope-aware filter replaces guardMasterOnly.
				// Master + legacy bearer pass through unchanged. Non-master clients
				// see only profiles whose createdBy ∈ fromAllowList OR whose namespace
				// matches one of namespaceReadPrefixes (exact or '/' boundary).
				const profiles = await convex.query("profiles:listProfiles" as any, {
					limit: effectiveLimit ?? 20,
					fields: fields ?? "lite",
					createdBefore,
				});

				// A refusal is not an absence: say so BEFORE the `Array.isArray`
				// coalescing below turns the envelope into an empty array.
				if (isRefusedEnvelope(profiles)) {
					return mcpRefused("list_peers", "profiles:listProfiles");
				}

				// Class-sweep fix (mission vp-multitenant-zero-hole-v1, final 8):
				// profiles rows (schema.ts:118) carry `orchestratorId`, NOT
				// `createdBy` and NOT `namespace` -- scopeFilterList finds nothing
				// to discriminate on and refuses EVERY non-master caller,
				// including the owner (refus-total). Same remedy as get_profile:
				// remap orchestratorId->createdBy before scopeFilterList, then
				// strip the synthetic field back out (the output projection below
				// never reads `createdBy`, so no explicit strip is needed).
				const filteredProfiles = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					(Array.isArray(profiles) ? profiles : []).map(
						(p: Record<string, unknown>) => ({
							...p,
							createdBy: p.orchestratorId as string | undefined,
						}),
					),
				);

				const peers = filteredProfiles.map((p: any) => ({
					_id: p._id,
					_creationTime: p._creationTime,
					id: p.orchestratorId,
					instanceId: p.instanceId ?? p.orchestratorId,
					name: p.name,
					role: p.static.role,
					workspace: p.static.workspace,
					currentTask: p.dynamic.currentTask ?? "idle",
					lastSeen: new Date(p.dynamic.lastSeen).toISOString(),
					sessionCount: p.dynamic.sessionCount,
				}));

				// S3.3 B8 follow-up — emit nextCursor when page is full.
				// Measured on the RAW page, before the scope filter narrowed it.
				const requestedLimit = effectiveLimit ?? 20;
				const { nextCursor, scopeFiltered } = scopedPageContinuation(
					Array.isArray(profiles) ? profiles : [],
					requestedLimit,
					filteredProfiles.length,
					{ reportRemoved: oauthCtx?.clerkOrgSlug !== undefined },
				);
				const peersWithCursor =
					nextCursor !== null || scopeFiltered > 0
						? {
								items: peers,
								...(nextCursor !== null ? { nextCursor } : {}),
								...(scopeFiltered > 0 ? { scopeFiltered } : {}),
							}
						: peers;

				const capped = capListResponse(
					peersWithCursor,
					JSON.stringify(peersWithCursor, null, 2),
					"list_peers",
				);
				return {
					content: [{ type: "text", text: capped.text }],
					structuredContent: pageStructured(peersWithCursor, capped),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── list_messages ───────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"list_messages",
		"List historical messages filtered by session day or sender, newest first; use check_messages for unread. " +
			"Returns { items, nextCursor, truncated }: items are messages, newest first; nextCursor is the next page's cursor, null on the last page; truncated is true when the 60 KB response cap cut the page (nextCursor is then null). The text is the bare JSON array of the messages on the last page, else { items, nextCursor }. " +
			"WHEN: use for audit, recap, or debugging a specific day's message traffic. " +
			"EXAMPLE: list_messages sessionDay=92 from='alpha' limit=20.",
		{
			sessionDay: z
				.number()
				.int()
				.optional()
				.describe("Keep only messages of this session day (Day 1 = 2026-03-06 UTC), as send_message stamps it. " +
					"Omit for every day."),
			from: creatorSchema.optional().describe("Keep only messages from this sender, e.g. 'alpha'. Omit for every sender."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.meta({ deprecated: true })
				.describe("Has no effect on this tool: every row comes back whole, with every stored field, whichever value is sent. Accepted only so that a client which sends it is not refused; leave it out."),
			cursor: z
				.string()
				.optional()
				.describe(
					"The nextCursor value a previous list_messages call returned, to fetch the following (older) page. " +
						"Omit for the first page.",
				),
		},
		{
			outputSchema: listMessagesServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List messages",
		},
		async ({ sessionDay, from, limit, fields, cursor }) => {
			try {
				// S3.3 B8 follow-up — decode opaque cursor → createdBefore anchor.
				let createdBefore: number | undefined;
				if (cursor !== undefined && cursor !== "") {
					try {
						const decoded = decodeCursor(cursor);
						if (decoded && "createdBefore" in decoded) {
							createdBefore = decoded.createdBefore;
						}
					} catch (err: any) {
						return mcpError(err?.message ?? "invalid cursor");
					}
				}
				const effectiveLimit =
					limit === undefined ? undefined : clampLimit(limit);

				// The caller's tenant is applied INSIDE the Convex read: a bearer
				// that is not the master forwards its verified org (`verifiedOrg`),
				// and the door reads only that org's index range. A bearer whose org
				// cannot be resolved is refused here, before any read.
				const orgDenied = unresolvedOrgDenial("list_messages");
				if (orgDenied !== null) return orgDenied;

				// S3.1.B Wave B — scope-aware filter replaces guardMasterOnly.
				// Master + legacy bearer pass through unchanged. Non-master clients
				// see only messages whose createdBy ∈ fromAllowList OR whose namespace
				// matches one of namespaceReadPrefixes (exact or '/' boundary) — a
				// narrowing intersect on top of the tenant-scoped read, never the
				// tenant boundary itself.
				const messages = await convex.query("messages:listMessages" as any, {
					sessionDay,
					from,
					limit: effectiveLimit ?? 20,
					fields: fields ?? "lite",
					createdBefore,
					...doorScopeArgs("messages:listMessages", undefined),
				});

				// k1780azk7n8fdb7bpnx5n91sx18b5vjf — refus-total fix. Message rows
				// carry `from` (schema.ts:149, creatorValidator), NOT `createdBy`
				// and NOT `namespace`. Passing rows through unmapped finds no
				// field to discriminate on and refuses EVERY non-master caller,
				// sender included. Same remedy as search_messages_by_keyword
				// (tools.ts ~3399-3423): remap `from`->`createdBy` before
				// scopeFilterList, then strip the synthetic field back out.
				const filteredMessages = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					(Array.isArray(messages) ? messages : []).map(
						(m: Record<string, unknown>) => ({
							...m,
							createdBy: m.from as string | undefined,
						}),
					),
				).map(({ createdBy: _createdBy, ...rest }) => rest);

				// S3.3 B8 follow-up — emit nextCursor when the SCOPED READ's page is
				// full. Derived from the page Convex returned for this caller's
				// tenant, never from what survives the narrowing filter above: a
				// full page whose rows the roster filter then dropped is still a
				// page with more behind it.
				const requestedLimit = effectiveLimit ?? 20;
				const messagesPage = Array.isArray(messages)
					? (messages as Array<{ _creationTime?: number }>)
					: [];
				let nextCursor: string | null = null;
				if (messagesPage.length >= requestedLimit && messagesPage.length > 0) {
					const last = messagesPage[messagesPage.length - 1];
					if (typeof last._creationTime === "number") {
						nextCursor = encodeCursor({ createdBefore: last._creationTime });
					}
				}
				const messagesWithCursor =
					nextCursor !== null
						? { items: filteredMessages, nextCursor }
						: filteredMessages;

				const capped = capListResponse(
					messagesWithCursor,
					JSON.stringify(messagesWithCursor, null, 2),
					"list_messages",
				);
				const text = appendMarkerIfEnabled(capped.text, () => ({
					kind: "messages-feed",
					items: filteredMessages.map((m: any) => ({
						_id: m._id,
						from: m.from,
						channel: m.channel,
						content: m.content,
						createdAt: m.createdAt,
					})),
				}));

				return {
					content: [{ type: "text", text }],
					structuredContent: pageStructured(messagesWithCursor, capped),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── search_messages_by_keyword ─────────────────────────────────────────────
	// Day 102 v2.11.0 — CRUD baseline PR-C-bis option B (mission k575kc1r).
	// BM25 keyword search over message content. Backed by Convex
	// `messages:searchMessagesByKeyword` using the `search_content` searchIndex.

	// oracle-justified: BM25 searchIndex read that applies a post-take tenant filter in the handler
	//   (messages:searchMessagesByKeyword), where list_messages pushes the tenant into its index range
	//   before the take; both go through requireResolvedCaller and requireScope.
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"search_messages_by_keyword",
		"BM25 full-text keyword search over message content, ranked by relevance. " +
			"Returns { items }: the matching messages, best match first; the text is the same items as a bare JSON array. " +
			"WHEN: use for post-incident audit or to find peer DMs by topic — e.g. " +
			"'find messages about deploy' across the recent sessionDay window. " +
			"EXAMPLE: search_messages_by_keyword query='convex deploy' from='pi' sessionDay=102 limit=10.",
		{
			query: z
				.string()
				.describe("The words to match; results are ranked by keyword relevance, so exact terms and IDs work best."),
			from: z.string().optional().describe("Keep only messages from this sender, e.g. 'pi'. Omit for every sender."),
			channel: z
				.string()
				.optional()
				.describe("Keep only messages sent on this channel, e.g. 'sigma' or 'broadcast'. Omit for every channel."),
			sessionDay: z
				.number()
				.int()
				.optional()
				.describe("Keep only messages of this session day (Day 1 = 2026-03-06 UTC), as send_message stamps it. " +
					"Omit for every day."),
			tenantId: z.string().optional().describe("Keep only messages of this organisation, by slug (whoami returns yours as org_slug). " +
				"Omit for every organisation your session may read."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many of the best matches come back; weaker matches beyond it are not returned."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.meta({ default: "lite" })
				.describe("How much of each match comes back: lite is the message's ID, sender, channel, text, session day and creation time; full is every stored field."),
		},
		{
			outputSchema: searchMessagesByKeywordServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Search messages by keyword",
		},
		async ({ query, from, channel, sessionDay, tenantId, limit, fields }) => {
			try {
				// Tenant applied INSIDE the Convex read (`verifiedOrg`), see list_messages.
				const orgDenied = unresolvedOrgDenial("search_messages_by_keyword");
				if (orgDenied !== null) return orgDenied;
				const results = await convex.query(
					"messages:searchMessagesByKeyword" as any,
					{
						query,
						from,
						channel,
						sessionDay,
						tenantId,
						limit: limit ?? 20,
						fields: fields ?? "lite",
						...doorScopeArgs("messages:searchMessagesByKeyword", undefined),
					},
				);
				// k175j2jems5deccegp4p0fy4x98b4ypn — cross-tenant content leak fix.
				// Convex's searchMessagesByKeyword is reached through the MCP
				// server's fixed service-account identity for legacy bearer
				// callers, so scope isolation must be enforced at this boundary.
				// Message rows carry `from` (schema.ts:149, creatorValidator), NOT
				// `createdBy` and NOT `namespace` — scopeFilterList discriminates
				// on `createdBy`/`namespace` only, so passing rows through
				// unmapped would find no field to match against and refuse EVERY
				// non-master caller, sender included (refus-total — same defect
				// class as list_broadcast_status pre-fix, tools.ts:3502-3509,
				// which established the sanctioned remedy: remap the tool's real
				// ownership field onto `createdBy` BEFORE calling scopeFilterList,
				// then strip the synthetic field back out of the response.
				const filteredResults = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					(Array.isArray(results)
						? (results as Array<Record<string, unknown>>)
						: []
					).map((m) => ({ ...m, createdBy: m.from as string | undefined })),
				).map(({ createdBy: _createdBy, ...rest }) => rest);
				return {
					content: [
						{ type: "text", text: JSON.stringify(filteredResults, null, 2) },
					],
					// The text stays the bare array; the object form of the same rows.
					structuredContent: arrayStructured(filteredResults),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── list_broadcast_status ───────────────────────────────────────────────────
	// S3.3 B8 follow-up batch 3 FINAL — DOCTRINE EXCEPTION.
	// @cursorPagingException single-object-shape-not-list
	// Rationale: this tool returns a single status object — `{ messageId, from,
	// channel, createdAt, receipts[] }` — not a top-level array. Cursor paging
	// is defined on top-level arrays, not embedded sub-arrays of a single
	// envelope. Migrating would require a separate `list_broadcast_receipts`
	// tool, which is out of scope for the S3.3 B8 rollout.
	//
	// LIVE DEFECT FIX (GitHub issue, "Server Error" on every call):
	//   1. `limit` is now DECLARED by messages:listBroadcastStatus (was
	//      previously injected unconditionally by this wrapper against a
	//      backend arg list that didn't accept it → ArgumentValidationError
	//      on every single call, regardless of whether the caller passed
	//      `limit`).
	//   2. The backend returns a single OBJECT envelope, never an array.
	//      `Array.isArray(status) ? status : []` used to silently collapse
	//      every real payload into `[]` — "nobody read this" instead of the
	//      real receipts. Scope filtering now applies to the `receipts` array
	//      (per-recipient visibility), not the envelope: the envelope
	//      (messageId/from/channel/createdAt/truncated) is always returned
	//      intact so a scoped caller still knows the broadcast exists.

	const BROADCAST_STATUS_FETCH_CAP = 200;

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"list_broadcast_status",
		"Show read/unread receipt status for a broadcast message by messageId. " +
			"Returns { messageId, from, channel, createdAt, receipts: [{ recipient, recipientInstanceId, read, readAt }], truncated, scopeFiltered? }. " +
			"WHEN: use after send_message to confirm all recipients acknowledged a critical announcement. " +
			"EXAMPLE: list_broadcast_status messageId='j57dy3049btafda9m2f5d2ggk987ph3f'.",
		{
			messageId: messageIdSchema.describe(
				"The broadcast to inspect: the messageId send_message returned.",
			),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many receipts come back; truncated is true when more exist."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.meta({ deprecated: true })
				.describe("Has no effect on this tool: every row comes back whole, with every stored field, whichever value is sent. Accepted only so that a client which sends it is not refused; leave it out."),
		},
		{
			outputSchema: listBroadcastStatusServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List broadcast status",
		},
		async ({ messageId, limit, fields }) => {
			try {
				// Tenant applied INSIDE the Convex read (`verifiedOrg`): the door
				// refuses a message outside the caller's org before any receipt row
				// is read. See list_messages.
				const orgDenied = unresolvedOrgDenial("list_broadcast_status");
				if (orgDenied !== null) return orgDenied;
				// S3.1.C1 — scope-aware filter replaces guardMasterOnly.
				const status = await convex.query(
					"messages:listBroadcastStatus" as any,
					{
						messageId,
						// The caller's `limit` is applied HERE, after the scope filter
						// (below). The door is asked for the tool's cap so that the page
						// it cuts is not narrowed afterwards by the allow-list: a cut made
						// before the filter would be reported as "N of M" about a
						// population the caller cannot see.
						limit: BROADCAST_STATUS_FETCH_CAP,
						fields: fields ?? "lite",
						...doorScopeArgs("messages:listBroadcastStatus", undefined),
					},
				);

				const envelope = status as {
					messageId: string;
					from: string;
					channel?: string;
					createdAt: number;
					receipts: Array<Record<string, unknown>>;
					truncated: boolean;
				};

				// Scope filtering targets the receipts array, not the envelope: a
				// non-master caller may not see every recipient's read status, but
				// it still learns the broadcast exists (envelope fields carry no
				// per-row ownership, so denying the whole envelope would just
				// re-manufacture the "Server Error" experience under a different
				// name). Each receipt is matched against fromAllowList by mapping
				// `recipient` onto the `createdBy` field scopeFilterList expects.
				const filteredReceipts = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					envelope.receipts.map((r) => ({
						...r,
						createdBy: r.recipient as string | undefined,
					})),
				).map(({ createdBy: _createdBy, ...rest }) => rest);

				// Every bound is evaluated AFTER the filter that narrows the
				// population it describes. `scopeFiltered` says how many fetched
				// receipts the allow-list removed, so a caller whose receipts were
				// removed never reads bytes identical to a broadcast nobody received.
				// `truncated` is true when the door cut its own list (receipts beyond
				// the fetch cap exist, unseen) or when more visible receipts exist
				// than the caller's `limit`.
				const callerLimit = limit ?? 20;
				// The door gated tenant and channel before reading a receipt, so
				// every fetched receipt is the caller's own organisation's; a token
				// bound to no organisation gets no count.
				const scopeFiltered =
					oauthCtx?.clerkOrgSlug === undefined
						? 0
						: Math.max(
								0,
								envelope.receipts.length - filteredReceipts.length,
							);
				const responsePayload = {
					...envelope,
					receipts: filteredReceipts.slice(0, callerLimit),
					truncated:
						envelope.truncated === true ||
						filteredReceipts.length > callerLimit,
					...(scopeFiltered > 0 ? { scopeFiltered } : {}),
				};

				// Deliberately NOT routed through capListResponseBytes: that helper
				// truncates a bare array and rewraps it as `{_meta, items}`, which
				// would silently swap this tool's envelope shape for a different one
				// under byte pressure — its own instance of the "shape surprise"
				// class this fix closes. `limit` (capped at 200 by the arg schema)
				// plus `truncated` already give the caller an explicit, honest
				// truncation signal without changing the response shape.
				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = responsePayload;
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── create_task ─────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "createdBy" },
		"create_task",
		"Create a task assigned to an orchestrator with priority, status tracking, and optional mission link. " +
			"Returns { taskId, title, assignedTo, priority, status }; keep taskId for start_task, update_task and complete_task. " +
			"WHEN: use to delegate work, track a deliverable, or instantiate a step from a mission plan. " +
			"`project` is required: a task with no project is refused, because billing groups done tasks by project. " +
			"EXAMPLE: create_task title='Standardize tool descriptions' project='vantage-peers' assignedTo='beta' priority='high' createdBy='alpha'.",
		{
			title: z.string().describe("A short statement of the work, shown in every task list."),
			description: z.string().optional().describe("The brief: what to do, the context, and how completion will be verified. Omit for a title-only task."),
			project: z
				.string()
				.trim()
				.min(1)
				.describe(
					"The billing line the work belongs to, e.g. 'vantage-starter': billing_summary_by_project groups done tasks by this exact name (surrounding spaces trimmed), so spell it the same way on every task of a project.",
				),
			tags: flexArrayOptional.describe("Free labels for grouping and search, e.g. ['backend', 'p1']. Omit for none."),
			assignedTo: assigneeSchema.describe("The orchestrator who will do the work, by name, e.g. 'beta' or a client role; list_peers shows who exists."),
			assignedToAgentId: z
				.string()
				.min(1)
				.optional()
				.describe(
					"The agent who does the work, named by agent ID (the agentId list_peers returns): the task is in that agent's queue (list_tasks with assignedTo). " +
						"Given, the ID alone decides, and an ID that is not an active agent of your organisation is refused. Omit it to resolve the assignee from assignedTo.",
				),
			assignedToInstance: z
				.string()
				.optional()
				.describe(
					"A specific instance of the assignee, e.g. 'pi-vps', as list_peers shows it. " +
						"Omit to let any instance of that orchestrator pick it up.",
				),
			priority: prioritySchema.describe("How urgent the work is relative to the assignee's other tasks: urgent jumps the queue, low waits."),
			status: taskStatusSchema.default("todo").describe("The state the task starts in; set another one only when importing work already under way."),
			dependsOn: z
				.array(taskIdSchema)
				.optional()
				.describe("Tasks that must be done before this one can start: their taskIds as returned by create_task or list_tasks. " +
					"Omit for none."),
			missionId: missionIdSchema
				.optional()
				.describe("The mission this task belongs to: its missionId as returned by create_mission or list_missions. " +
					"Omit for a standalone task."),
			estimatedMinutes: z
				.number()
				.optional()
				.describe("Your estimate of the work, in minutes. Omit when unknown; billing never uses it."),
			dueDate: z
				.number()
				.optional()
				.describe("The moment the work is due (a millisecond timestamp, as Date.now() gives). Omit for no due date."),
			createdBy: creatorSchema
				.optional()
				.describe("The agent this call writes as, recorded as the task's author (e.g. 'sigma'). " +
					"Omit it when your credential resolves one agent: it is then that agent; a signed-in person omits it and is recorded under its own verified account. " +
					"Otherwise omitting it is refused."),
			deliverable: deliverableSchema.describe("The artifact the task delivers (today an npm export). " +
				"The backend checks the npm registry and get_task reports deliverableDivergence='delivered-but-open' when it is published while the task is still open. " +
				"Omit when the task ships no package."),
		},
		{
			outputSchema: createTaskServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Create task",
			personDoor: true,
		},
		async ({
			title,
			description,
			project,
			tags,
			assignedTo,
			assignedToAgentId,
			assignedToInstance,
			priority,
			status,
			dependsOn,
			missionId,
			estimatedMinutes,
			dueDate,
			createdBy,
			deliverable,
		}) => {
			try {
				const assigneeDenied = await guardDelegation(assignedTo);
				if (assigneeDenied) return assigneeDenied;

				// C2: normalize orchestrator-id fields at write time (B2 §6+§7).
				const taskId = await convex.mutation("tasks:create" as any, {
					title,
					description,
					project,
					tags: toArray(tags),
					assignedTo: normalizeOrchestratorId(assignedTo),
					...(assignedToAgentId !== undefined ? { assignedToAgentId } : {}),
					assignedToInstance,
					priority,
					status,
					dependsOn: toArray(dependsOn) as any,
					missionId: missionId as any,
					estimatedMinutes,
					dueDate,
					createdBy:
						createdBy === undefined
							? undefined
							: normalizeOrchestratorId(createdBy),
					...(deliverable !== undefined ? { deliverable } : {}),
					...doorScopeArgs("tasks:create", createdBy),
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { taskId, title, assignedTo, priority, status };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── list_tasks ──────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...) against createdBy (with assignedTo as an extra per-row grant): cross-scope task rows are removed AFTER the Convex read and BEFORE return. listTasksGate still validates the caller-supplied assignedTo/createdBy filter against fromAllowList, but scopeFilterList — not the gate — is what restricts the returned rows (k17fcxngeyrfpsh8xrp0fzz9xh8dfkq8)",
		},
		"list_tasks",
		LIST_TASKS_TOOL_DESCRIPTION,
		listTasksArgsSchema.shape,
		{
			outputSchema: listTasksServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List tasks",
		},
		async ({
			assignedTo,
			assignedToInstance,
			status,
			project,
			limit,
			fields,
			createdBy,
			updatedSince,
			cursor,
			excludeAutoGenerated,
		}) => {
			try {
				// Non-master: filter must name an identity in the bearer's
				// fromAllowList (case-insensitive). Using userId was wrong —
				// orchestrators identify as "Elan"/"Ada"/etc., never as the
				// profile name "elan-acme-hr". Fix mirrors check_messages
				// L1383-1399 pattern (commit 24b39c5). Regression: 28db616.
				{
					const gateErr = listTasksGate(oauthCtx, assignedTo, createdBy);
					if (gateErr !== null) return mcpError(gateErr);
				}

				// S3.3 B8 — decode opaque cursor → createdBefore anchor.
				let createdBefore: number | undefined;
				// updatedSince reads resume at the pair (updatedAt, _creationTime) of the
				// last row served; a token minted before that position existed carries
				// createdBefore alone and keeps its old meaning on the backend.
				let updatedCursor: number | undefined;
				if (cursor !== undefined && cursor !== "") {
					try {
						const decoded = decodeCursor(cursor);
						if (decoded && "createdBefore" in decoded) {
							createdBefore = decoded.createdBefore;
							if (updatedSince !== undefined) updatedCursor = decoded.updatedAt;
						}
					} catch (err: any) {
						return mcpError(err?.message ?? "invalid cursor");
					}
				}
				// Clamp caller limit through paging contract (zod already caps at 200).
				const effectiveLimit =
					limit === undefined ? undefined : clampLimit(limit);

				// k17fcxngeyrfpsh8xrp0fzz9xh8dfkq8 — cross-scope row leak fix.
				// Mirrors search_tasks_by_keyword (tools.ts ~4348): the "lite"
				// projection strips `createdBy`, the ONLY field scopeFilterList can
				// discriminate on, so a lite row would refuse every non-master
				// caller (owner included). Always request fields="full" from Convex
				// (internal transport only), apply scopeFilterList against the real
				// createdBy, then reproject to the tool's public lite shape when the
				// caller asked for lite (default) or didn't specify — the public
				// contract is unchanged.
				const wantsFull = fields === "full";
				// Tenant applied INSIDE the Convex read (`verifiedOrg`): the door
				// reads the caller's org-keyed index ranges only, so a foreign org's
				// task is never read, counted into the page or paged past. A bearer
				// whose org cannot be resolved is refused here, before any read.
				const orgDenied = unresolvedOrgDenial("list_tasks");
				if (orgDenied !== null) return orgDenied;
				const rawTasks = await convex.query("tasks:list" as any, {
					assignedTo,
					assignedToInstance,
					status,
					project,
					limit: effectiveLimit ?? 20,
					fields: "full",
					createdBy,
					updatedSince,
					createdBefore,
					updatedCursor,
					excludeAutoGenerated,
					...doorScopeArgs("tasks:list", undefined),
				});
				// `assignedTo` is a per-row grant (convex/tasks.ts L197-208 ORs
				// createdBy===caller || assignedTo===caller), so a non-creator
				// assignee must still see their own task in the list.
				// TENANT GATE, collection surface — applied BEFORE the roster/owner
				// filter, with the same predicate get_task applies to its one row.
				const scopedTasks = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					filterRowsToActorTenant(
						oauthCtx,
						Array.isArray(rawTasks)
							? (rawTasks as Array<Record<string, unknown>>)
							: [],
					),
					["assignedTo"],
				);
				const tasks = wantsFull
					? scopedTasks
					: scopedTasks.map((t) => ({
							_id: t._id,
							_creationTime: t._creationTime,
							title: t.title,
							status: t.status,
							priority: t.priority,
							assignedTo: t.assignedTo,
							...(t.missionId !== undefined ? { missionId: t.missionId } : {}),
							// Derived by the backend from stored fields; lite carries this one only.
							...(t.deliverableDivergence !== undefined
								? { deliverableDivergence: t.deliverableDivergence }
								: {}),
						}));

				// Build nextCursor from the SCOPED READ's page: the last row Convex
				// returned for this caller's tenant, when that page is full (heuristic
				// — caller can keep paging until empty). Never from what survives the
				// narrowing filters above: a full page whose rows the roster filter
				// then dropped still has more behind it.
				const requestedLimit = effectiveLimit ?? 20;
				const tasksArr = Array.isArray(tasks) ? tasks : [];
				const tasksPage = Array.isArray(rawTasks)
					? (rawTasks as Array<{ _creationTime?: number; updatedAt?: number }>)
					: [];
				let nextCursor: string | null = null;
				if (tasksPage.length >= requestedLimit && tasksPage.length > 0) {
					const last = tasksPage[tasksPage.length - 1];
					if (typeof last._creationTime === "number") {
						nextCursor =
							updatedSince !== undefined && typeof last.updatedAt === "number"
								? encodeCursor({
										v: 2,
										createdBefore: last._creationTime,
										updatedAt: last.updatedAt,
									})
								: encodeCursor({ createdBefore: last._creationTime });
					}
				}
				const tasksWithCursor =
					nextCursor !== null ? { items: tasksArr, nextCursor } : tasks;

				const capped = capListResponse(
					tasksWithCursor,
					JSON.stringify(tasksWithCursor, null, 2),
					"list_tasks",
				);
				const text = appendMarkerIfEnabled(capped.text, () => ({
					kind: "tasks-table",
					items: Array.isArray(tasks)
						? tasks.map((t: any) => ({
								_id: t._id,
								title: t.title,
								status: t.status,
								priority: t.priority,
								assignedTo: t.assignedTo,
								_creationTime: t._creationTime,
							}))
						: [],
				}));

				return {
					content: [{ type: "text", text }],
					structuredContent: pageStructured(tasksWithCursor, capped),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── bulk_complete_tasks ─────────────────────────────────────────────────────
	// PR-F — bulk close cron-spam tasks in one mutation. dryRun=true by default.

	// oracle-justified: bulk TRANSITION over a filtered set: each row is admitted individually by isRowVisibleToScope in
	//   tasks:bulkComplete (MCP scope `filtered`), where correct_task_segment targets one task by id and
	//   is actor-bound (`from`, assertTaskCallerAuthorized); both go through requireAuthenticatedCaller.
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"claimed callerOrchestrator identity is bound to the credential (bindActingNames) and narrowed by the roster (passesScopeFilter) MCP-side before dispatch; tasks:bulkComplete then scopes matched tasks against that verified identity",
		},
		BULK_COMPLETE_TASKS_TOOL_NAME,
		BULK_COMPLETE_TASKS_TOOL_DESCRIPTION,
		bulkCompleteTasksArgsSchema.shape,
		{
			readOnlyHint: false,
			idempotentHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Bulk complete tasks",
		},
		async ({ filter, dryRun, completionNoteTemplate, callerOrchestrator }) => {
			try {
				const orgDenied = unresolvedOrgDenial("bulk_complete_tasks");
				if (orgDenied) return orgDenied;
				// k179nrp3apj700pm0h1ckewm2h8b3nz7 — the "filtered" declaration above
				// claimed enforcement lives in tasks:bulkComplete, but that Convex
				// handler only checks ownership of MATCHED TASKS against a
				// client-SUPPLIED callerOrchestrator — it never verifies the caller
				// claiming that identity actually IS it. A scoped (non-master) OAuth
				// client could pass any other orchestrator's name and bulk-close
				// that orchestrator's tasks. The claim is bound to the credential by
				// defineTool (bindActingNames: callerOrchestrator is a declared acting
				// name) before this handler; a `filtered` tool gets no `from` scope
				// check, so the roster that narrows it is applied here, by the
				// package, before the mutation runs.
				if (callerOrchestrator) {
					if (!oauthCtx) return mcpError(NO_CONTEXT_REFUSAL);
					if (
						!passesScopeFilter(
							toPackageOAuthCtx(oauthCtx, { actingName: true }),
							{ createdBy: callerOrchestrator },
						)
					)
						return mcpError(
							fromNotOnRosterRefusal(oauthCtx, callerOrchestrator),
						);
				}

				const result = await convex.mutation("tasks:bulkComplete" as any, {
					filter,
					dryRun,
					completionNoteTemplate,
					callerOrchestrator,
					// The run's status row is stamped with this org (and a run is
					// readable only by it), never with a name.
					...doorScopeArgs("tasks:bulkComplete", callerOrchestrator),
				});
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(result, null, 2) },
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_bulk_complete_run ───────────────────────────────────────────────────
	// R-31 — the status row of a live bulk_complete_tasks run. Backed by Convex
	// `tasks:getBulkCompleteRun`. The MCP server reaches Convex as the fleet
	// service account, so the tenant and creator gates are applied HERE, on the
	// row, exactly as get_task does.
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		GET_BULK_COMPLETE_RUN_TOOL_NAME,
		GET_BULK_COMPLETE_RUN_TOOL_DESCRIPTION,
		getBulkCompleteRunArgsSchema.shape,
		{
			outputSchema: getBulkCompleteRunServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get bulk complete run status",
		},
		async ({ bulkRunId }) => {
			try {
				const row = await convex.query("tasks:getBulkCompleteRun" as any, {
					bulkRunId,
				});
				if (row === null || row === undefined) {
					return mcpError(`Bulk run not found: ${bulkRunId}`);
				}
				// TENANT GATE: a run is reachable by the organisation it was stamped
				// with and by nobody else. A non-master caller must resolve an org
				// (verified actor, else the token row's) and it must EQUAL the run's;
				// a run with no org (a fleet-master run) is not served to a
				// non-master caller at all — client isolation never rests on a name.
				if (!oauthCtx || !oauthCtx.isMaster) {
					const callerOrg = oauthCtx?.actor?.orgSlug ?? oauthCtx?.clerkOrgSlug;
					if (callerOrg === undefined || row.orgId !== callerOrg) {
						return mcpError(`Bulk run not found: ${bulkRunId}`);
					}
				}
				// CREATOR GATE, intersected with the tenant gate (never widening it):
				// the run's `createdBy` is the callerOrchestrator of the run; a
				// non-master caller must be that identity (fromAllowList).
				const filtered = scopeFilterGet(oauthCtx ?? DENIED_SCOPE_CTX, row, []);
				if (filtered === null) {
					return mcpError(`Bulk run not found: ${bulkRunId}`);
				}
				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = filtered;
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── search_tasks_by_keyword ────────────────────────────────────────────────
	// Day 102 v2.11.0 — CRUD baseline PR-C-bis option B (mission k575kc1r).
	// BM25 keyword search over task titles. Backed by Convex `tasks:searchTasksByKeyword`
	// which uses the `search_title` searchIndex. Filter axes: assignedTo, status,
	// project, missionId — all pushed into the index for sub-linear scan.

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"search_tasks_by_keyword",
		"BM25 full-text keyword search over task titles, ranked by relevance. " +
			"Returns { items }: the matching tasks, best match first; the text is the same items as a bare JSON array. " +
			"WHEN: use to find tasks by topic/keyword when list_tasks filters are too broad — e.g. " +
			"'find tasks about hook' across all assignees. " +
			"EXAMPLE: search_tasks_by_keyword query='hook PostToolUse' status='todo' limit=10.",
		{
			query: z.string().describe("The words to match against task titles; exact terms work best."),
			assignedTo: z.string().optional().describe("Keep only tasks assigned to this orchestrator. Omit for every assignee."),
			status: z
				.enum(["todo", "in_progress", "review", "blocked", "done"])
				.optional()
				.describe("Keep only tasks in this state. Omit for every state."),
			project: z.string().optional().describe("Keep only tasks of this project. Omit for every project."),
			missionId: missionIdSchema
				.optional()
				.describe("Keep only tasks of this mission: its missionId as returned by list_missions. Omit for every mission."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many of the best matches come back; weaker matches beyond it are not returned."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.meta({ default: "lite" })
				.describe("How much of each match comes back: lite is each task's ID, title, status, priority, assignee and mission; full is every stored field."),
		},
		{
			outputSchema: searchTasksByKeywordServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Search tasks by keyword",
		},
		async ({
			query,
			assignedTo,
			status,
			project,
			missionId,
			limit,
			fields,
		}) => {
			try {
				// k175j2jems5deccegp4p0fy4x98b4ypn — cross-tenant content leak fix.
				// Task rows DO carry `createdBy` (schema.ts:258) and the FULL
				// branch of tasks:searchTasksByKeyword renders it — but this
				// tool's default requested mode is "lite", and the lite
				// projection (tasks.ts:2119-2126) STRIPS createdBy before it
				// ever reaches this handler. Calling scopeFilterList on a lite
				// row would find no createdBy/namespace to discriminate on and
				// refuse every non-master caller, owner included (refus-total).
				//
				// Chosen remedy: always request fields="full" from Convex
				// (internal transport only), apply scopeFilterList against the
				// real createdBy, then reproject to the tool's public lite
				// shape when the caller asked for lite (default) or didn't
				// specify. This preserves the documented public tool shape —
				// callers relying on the existing lite payload see no schema
				// change. Rejected alternative: add createdBy to the lite
				// projection in tasks.ts — cheaper (no extra internal fields
				// transferred) but changes the PUBLIC shape of every lite
				// caller across the fleet (a breaking contract change reaching
				// every existing client of search_tasks_by_keyword, list_tasks
				// lite mode, etc.), for a benefit that is purely internal to
				// this one MCP-layer filter step.
				const wantsFull = fields === "full";
				// Tenant applied INSIDE the Convex read (`verifiedOrg`): the search
				// index is queried with the caller's org as an equality filter. See
				// list_tasks.
				const orgDenied = unresolvedOrgDenial("search_tasks_by_keyword");
				if (orgDenied !== null) return orgDenied;
				const results = await convex.query(
					"tasks:searchTasksByKeyword" as any,
					{
						query,
						assignedTo,
						status,
						project,
						missionId,
						limit: limit ?? 20,
						fields: "full",
						...doorScopeArgs("tasks:searchTasksByKeyword", undefined),
					},
				);
				// k174y9ra7pp8zed3bcczk6xaed8cpynp — mirror get_task/list_tasks:
				// `assignedTo` is a per-row grant (convex/tasks.ts L88-89 ORs
				// createdBy===caller || assignedTo===caller), so a non-creator
				// assignee must still see their own task in search results.
				// TENANT GATE, collection surface (same predicate as get_task).
				const filteredFull = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					filterRowsToActorTenant(
						oauthCtx,
						Array.isArray(results)
							? (results as Array<Record<string, unknown>>)
							: [],
					),
					["assignedTo"],
				);
				const projected = wantsFull
					? filteredFull
					: filteredFull.map((t) => ({
							_id: t._id,
							title: t.title,
							status: t.status,
							priority: t.priority,
							assignedTo: t.assignedTo,
							missionId: t.missionId,
						}));
				return {
					content: [{ type: "text", text: JSON.stringify(projected, null, 2) }],
					// The text stays the bare array; the object form of the same rows.
					structuredContent: arrayStructured(projected),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── billing_summary_by_project ─────────────────────────────────────────────
	// Day 130 (k17dhcmzqafve1ayzvh833kf558ae019) — refacturation base. Backed by
	// Convex `tasks:billingSummaryByProject`; sums machine-derived actualMinutes
	// grouped by project. `project` is passed straight through to the Convex
	// query args (Day-131 fix): the query itself pushes it into an
	// index-backed scan (by_status_project_completedAt), so a single-project
	// query is never a post-hoc filter over a truncated cross-project scan —
	// the same "bound applied after the fetch" disease as the period fix.

	// oracle-justified: MCP scope master (isMasterScope, global boundary) for a fleet-wide billing figure, narrower than
	//   the data door: tasks:billingSummaryByProject itself serves a member only its own org's done
	//   tasks (filterByOrgScope + requireScope view-own-tasks); checkout_task is an actor-bound `from`
	//   transition on one task; list_tasks pages with limit and cursor where the summary takes a date
	//   range and no cursor.
	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		BILLING_SUMMARY_BY_PROJECT_TOOL_NAME,
		BILLING_SUMMARY_BY_PROJECT_TOOL_DESCRIPTION,
		billingSummaryByProjectArgsSchema.shape,
		{
			outputSchema: billingSummaryByProjectServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Billing summary by project",
		},
		async ({ project, from, to, listNoDuration }) => {
			try {
				const result: any = await convex.query(
					"tasks:billingSummaryByProject" as any,
					{
						startDate: from ?? 0,
						endDate: to ?? Date.now(),
						...(project !== undefined ? { project } : {}),
						...(listNoDuration !== undefined ? { listNoDuration } : {}),
					},
				);
				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = {
						byProject: result.byProject,
						unattributedTaskCount: result.unattributedTaskCount,
						noProjectCount: result.noProjectCount,
						noDurationCount: result.noDurationCount,
						...(result.noDurationTasks !== undefined
							? {
									noDurationTasks: result.noDurationTasks,
									noDurationTasksTruncated: result.noDurationTasksTruncated,
								}
							: {}),
						invalidDurationTaskCount: result.invalidDurationTaskCount,
						truncated: result.truncated,
					};
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── update_task ─────────────────────────────────────────────────────────────
	// Reviewer-reclaim (task k17e1ar4s7pspb0rs74ms25hmd8dhv01, convex/schema.ts
	// `lastAssignedTo`): whenever this call CHANGES `assignedTo`, the backend
	// records the OLD assignee into `lastAssignedTo` (read-only, not an
	// update_task arg). On a `[REVIEW]`-titled or "review"-tagged task, the
	// PRIOR assignee (e.g. the reviewer who reassigned the task to its
	// author for a fix) may later reclaim it by calling update_task with
	// assignedTo=<itself> — RBAC now permits creator, current assignee, OR
	// the review task's lastAssignedTo, closing the no-blocked-limbo
	// hand-back gap. Non-review tasks are unaffected: a prior assignee still
	// cannot reclaim a plain task.

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"update_task",
		"Update any mutable field on a task; only provided fields are patched, updatedAt auto-set. " +
			"Returns { taskId, updated: true }. WHEN: use to reassign, reprioritize, or add context to an existing task without recreating it. " +
			"EXAMPLE: update_task taskId='k178d3ns...' status='review' callerOrchestrator='alpha'. " +
			"NOTE: on a [REVIEW] task, the orchestrator that most recently reassigned it away (lastAssignedTo) may reclaim it by setting assignedTo back to itself.",
		{
			taskId: taskIdSchema.describe("The task to update: its taskId as returned by create_task, list_tasks or get_task."),
			title: z.string().optional().describe("A new title. Omit to keep the current one."),
			description: z.string().optional().describe("A new brief, replacing the current one. Omit to keep it."),
			project: z.string().optional().describe("The billing line the task moves to: the same project name create_task took (surrounding spaces trimmed, an empty one refused), which billing_summary_by_project groups done tasks by. Omit to keep the current one."),
			tags: flexArrayOptional.describe("New tags, replacing the whole list. Omit to keep the current tags."),
			assignedTo: assigneeSchema.optional().describe("Reassign to this orchestrator by name. Omit to keep the assignee. " +
				"The previous assignee is remembered so a reviewer can reclaim a [REVIEW] task."),
			assignedToAgentId: z
				.string()
				.min(1)
				.optional()
				.describe(
					"The agent who does the work from now on, named by agent ID (the agentId list_peers returns); the previous assignee is remembered. " +
						"Given, the ID alone decides, and an ID that is not an active agent of the task's organisation is refused. Omit to resolve from assignedTo, or to keep the assignee.",
				),
			priority: prioritySchema.optional().describe("A new priority. Omit to keep the current one."),
			status: updateTaskStatusSchema.optional().describe("A new state. Omit to keep it. Blocking goes through block_task and failing through fail_task, each with its own evidence gate; setting done re-stamps completedAt."),
			dependsOn: z
				.array(taskIdSchema)
				.optional()
				.describe(
					"The complete new list of prerequisite taskIds (from list_tasks), replacing the current one; an empty list clears it. " +
						"Omit to keep it. To add without replacing, use add_task_dependency.",
				),
			missionId: missionIdSchema
				.optional()
				.describe("Link the task to this mission: its missionId from list_missions. Omit to keep the current link."),
			estimatedMinutes: z
				.number()
				.optional()
				.describe("A new estimate, in minutes. Omit to keep it."),
			actualMinutes: z
				.number()
				.optional()
				.describe("Recorded actual duration, in minutes. Omit to keep it; on done it is otherwise derived from the work segments."),
			startedAt: z.number().optional().describe("The moment work started (a millisecond timestamp, as Date.now() gives). Omit to keep it."),
			completedAt: z
				.number()
				.optional()
				.describe("The moment work completed (a millisecond timestamp, as Date.now() gives); billing counts the task in the period holding it. Omit to keep it (on done it is set to now)."),
			dueDate: z.number().optional().describe("The new moment the work is due (a millisecond timestamp, as Date.now() gives). Omit to keep it."),
			// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
			callerOrchestrator: creatorSchema
				.optional()
				.describe("The agent acting on this task; it must be the task's creator or assignee. " +
					"Omit it when your credential resolves one agent: the call then acts as that agent. " +
					"Without a resolved agent, omitting it is refused."),
			cancelReason: z
				.string()
				.optional()
				.describe(
					"Why the task is cancelled; required when status is cancelled, and only the task's creator (or 'system') may cancel. " +
						"Omit for any other change.",
				),
			deliverable: deliverableSchema.describe("The artifact the task delivers (today an npm export); setting it re-checks the npm registry. " +
				"Omit to keep the current one."),
		},
		{
			outputSchema: taskUpdatedServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Update task",
			personDoor: true,
		},
		async ({
			taskId,
			title,
			description,
			project,
			tags,
			assignedTo,
			assignedToAgentId,
			priority,
			status,
			dependsOn,
			missionId,
			estimatedMinutes,
			actualMinutes,
			startedAt,
			completedAt,
			dueDate,
			callerOrchestrator,
			cancelReason,
			deliverable,
		}) => {
			try {
				const orgDenied = unresolvedOrgDenial("update_task");
				if (orgDenied) return orgDenied;
				// The delegation guard below reads the assignee NAME, so an ID cannot
				// stand alone here: it would skip the guard.
				if (assignedToAgentId !== undefined && !assignedTo) {
					return mcpError(
						"INVALID_ASSIGNEE: assignedToAgentId needs assignedTo beside it — pass the assignee's name with its agent ID (the delegation guard reads the name).",
					);
				}
				if (assignedTo) {
					const assigneeDenied = await guardDelegation(assignedTo);
					if (assigneeDenied) return assigneeDenied;
				}

				await convex.mutation("tasks:update" as any, {
					taskId: taskId as any,
					title,
					description,
					project,
					tags: toArray(tags),
					assignedTo,
					...(assignedToAgentId !== undefined ? { assignedToAgentId } : {}),
					priority,
					status,
					dependsOn: toArray(dependsOn) as any,
					missionId: missionId as any,
					estimatedMinutes,
					actualMinutes,
					startedAt,
					completedAt,
					dueDate,
					callerOrchestrator,
					cancelReason,
					...(deliverable !== undefined ? { deliverable } : {}),
					...doorScopeArgs("tasks:update", callerOrchestrator),
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { taskId, updated: true };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── complete_task ───────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"complete_task",
		"Mark a task as done with a mandatory completionNote; always notify the creator via send_message after. " +
			"Returns { taskId, status: 'done' }. WHEN: call when all deliverables are committed or verified — never complete without a proof token in the note. " +
			"EXAMPLE: complete_task taskId='k178d3ns...' completionNote='PR #667 merged, 86 descriptions updated' callerOrchestrator='beta'.",
		{
			taskId: taskIdSchema.describe(
				"The task to complete: its taskId as returned by create_task, list_tasks or get_task.",
			),
			completionNote: z
				.string()
				.describe("What was actually done, with a verifiable proof (a PR, a commit SHA, a test count)."),
			// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
			callerOrchestrator: creatorSchema
				.optional()
				.describe("The agent acting on this task; it must be the task's creator or assignee. " +
					"Omit it when your credential resolves one agent: the call then acts as that agent. " +
					"Without a resolved agent, omitting it is refused. A signed-in person may omit it and acts in its own name."),
		},
		{
			outputSchema: taskClosedServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Complete task",
			personDoor: true,
		},
		async ({ taskId, completionNote, callerOrchestrator }) => {
			try {
				const orgDenied = unresolvedOrgDenial("complete_task");
				if (orgDenied) return orgDenied;
				await convex.mutation("tasks:complete" as any, {
					taskId: taskId as any,
					completionNote,
					callerOrchestrator,
					...doorScopeArgs("tasks:complete", callerOrchestrator),
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { taskId, status: "done" };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── fail_task ────────────────────────────────────────────────────────────────
	// T1 (PRD-evevantage-v1 §7.1) — the FAILED terminal, distinct from "done"
	// (succeeded) and "cancelled" (retired before/without attempting the
	// work). This is the ONLY way to record a failure: update_task refuses
	// status="failed" server-side. Never pass an "outcome" — the verb itself
	// is the choice, so there is nothing for a closer to default.

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"fail_task",
		"Mark a task as failed (a terminal state distinct from done/cancelled) with a mandatory failureNote describing how the work ended. " +
			"Returns { taskId, status: 'failed' }. WHEN: use when the work was genuinely attempted and did not succeed — never call complete_task to close out failed work, and never call update_task with status=\"failed\" (refused server-side; this tool is the only door). " +
			"A task already done/cancelled cannot be re-terminated as failed. " +
			"EXAMPLE: fail_task taskId='k178d3ns...' failureNote='Migration errored on row 4102, rolled back cleanly' callerOrchestrator='beta'.",
		{
			taskId: taskIdSchema.describe("The task to fail: its taskId as returned by create_task, list_tasks or get_task."),
			failureNote: z
				.string()
				.describe("How the work ended in failure: what was attempted and why it did not succeed."),
			// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
			callerOrchestrator: creatorSchema
				.optional()
				.describe("The agent acting on this task; it must be the task's creator or assignee. " +
					"Omit it when your credential resolves one agent: the call then acts as that agent. " +
					"Without a resolved agent, omitting it is refused."),
		},
		{
			outputSchema: taskClosedServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Fail task",
		},
		async ({ taskId, failureNote, callerOrchestrator }) => {
			try {
				const orgDenied = unresolvedOrgDenial("fail_task");
				if (orgDenied) return orgDenied;
				await convex.mutation("tasks:failTask" as any, {
					taskId: taskId as any,
					failureNote,
					callerOrchestrator,
					...doorScopeArgs("tasks:failTask", undefined),
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { taskId, status: "failed" };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── start_task ──────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"start_task",
		"Set a task to in_progress and record the startedAt timestamp for duration tracking. " +
			"Returns { taskId, status: 'in_progress' }. " +
			"WHEN: call as the first action when picking up a task to signal activity and enable metrics. " +
			"EXAMPLE: start_task taskId='k178d3ns...' callerOrchestrator='gamma'.",
		{
			taskId: taskIdSchema.describe("The task to start: its taskId as returned by create_task, list_tasks or get_task."),
			// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
			callerOrchestrator: creatorSchema
				.optional()
				.describe("The agent acting on this task; it must be the task's creator or assignee. " +
					"Omit it when your credential resolves one agent: the call then acts as that agent. " +
					"Without a resolved agent, omitting it is refused. A signed-in person may omit it and acts in its own name."),
		},
		{
			outputSchema: taskStatusServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Start task",
			personDoor: true,
		},
		async ({ taskId, callerOrchestrator }) => {
			try {
				const orgDenied = unresolvedOrgDenial("start_task");
				if (orgDenied) return orgDenied;
				await convex.mutation("tasks:start" as any, {
					taskId: taskId as any,
					callerOrchestrator,
					...doorScopeArgs("tasks:start", callerOrchestrator),
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { taskId, status: "in_progress" };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── pause_task ──────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"pause_task",
		"Close the task's open work segment and stop the duration clock, without ending the task. " +
			"Paused is not blocked: the task remains claimable work, just off the clock until resumed. " +
			"Returns { taskId, status: 'todo' }. WHEN: call before stepping away from an in_progress task so its billed duration doesn't keep accruing while idle. " +
			"EXAMPLE: pause_task taskId='b2v9k4x7p1m6q0z3w8n5r2t4y7c1u9df' callerOrchestrator='gamma'.",
		{
			taskId: taskIdSchema.describe("The task to pause: its taskId as returned by create_task, list_tasks or get_task."),
			// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
			callerOrchestrator: creatorSchema
				.optional()
				.describe("The agent acting on this task; it must be the task's creator or assignee. " +
					"Omit it when your credential resolves one agent: the call then acts as that agent. " +
					"Without a resolved agent, omitting it is refused."),
		},
		{
			outputSchema: taskStatusServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Pause task",
		},
		async ({ taskId, callerOrchestrator }) => {
			try {
				const orgDenied = unresolvedOrgDenial("pause_task");
				if (orgDenied) return orgDenied;
				await convex.mutation("tasks:pause" as any, {
					taskId: taskId as any,
					callerOrchestrator,
					...doorScopeArgs("tasks:pause", undefined),
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { taskId, status: "todo" };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── resume_task ─────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"resume_task",
		"Open a new work segment on a paused task and set it back to in_progress. " +
			"Returns { taskId, status: 'in_progress' }. WHEN: call after pause_task to resume the clock on the same task. " +
			"EXAMPLE: resume_task taskId='b2v9k4x7p1m6q0z3w8n5r2t4y7c1u9df' callerOrchestrator='gamma'.",
		{
			taskId: taskIdSchema.describe("The task to resume: its taskId as returned by create_task, list_tasks or get_task."),
			// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
			callerOrchestrator: creatorSchema
				.optional()
				.describe("The agent acting on this task; it must be the task's creator or assignee. " +
					"Omit it when your credential resolves one agent: the call then acts as that agent. " +
					"Without a resolved agent, omitting it is refused."),
		},
		{
			outputSchema: taskStatusServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Resume task",
		},
		async ({ taskId, callerOrchestrator }) => {
			try {
				const orgDenied = unresolvedOrgDenial("resume_task");
				if (orgDenied) return orgDenied;
				await convex.mutation("tasks:resume" as any, {
					taskId: taskId as any,
					callerOrchestrator,
					...doorScopeArgs("tasks:resume", undefined),
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { taskId, status: "in_progress" };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── correct_task_segment ────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"correct_task_segment",
		"Restate the real boundaries of ONE recorded work segment, when it grew across an unrecorded break (e.g. " +
			"a station's session ended without pause_task and the segment stayed open for days). " +
			"The original machine-recorded span is kept, never overwritten — the corrected segment carries the original bounds, the reason, and who corrected it. " +
			"A correction can only SHRINK a span to lie inside what the machine recorded; it can never extend it or move it outside that span, and the configured segment-duration cap still applies. " +
			"One correction per segment. Returns { taskId, segmentIndex, corrected: true }. " +
			"WHEN: call when complete_task/pause_task refuse a task because its trailing segment spans an implausible duration and the over-cap attestation marker doesn't fit (span exceeds 2x the cap, or the segment is still open) — correct the segment first, then complete_task or pause_task normally. " +
			"EXAMPLE: correct_task_segment taskId='k178d3ns...' segmentIndex=0 start=1767250800000 end=1767268800000 reason='unrecorded break, real work was 5 hours' callerOrchestrator='gamma'.",
		{
			taskId: taskIdSchema.describe(
				"The task to correct: its taskId as returned by create_task, list_tasks or get_task.",
			),
			segmentIndex: z
				.number()
				.int()
				.min(0)
				.describe(
					"Which work segment to correct: its position in the workSegments list get_task returns, the first listed being 0.",
				),
			start: z
				.number()
				.describe(
					"The moment the work in this segment really started (a millisecond timestamp, as Date.now() gives); it can only move later than the recorded start.",
				),
			end: z
				.number()
				.describe(
					"The moment the work in this segment really ended (a millisecond timestamp, as Date.now() gives); it can only move earlier than the recorded end (or now, if the segment is still open).",
				),
			reason: z
				.string()
				.describe(
					"The explanation a reviewer reads later, e.g. 'unrecorded break, real work was 5 hours'; it is stored on the segment beside the recorded and the corrected times. A reason under 12 non-space characters is refused.",
				),
			// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
			callerOrchestrator: creatorSchema
				.optional()
				.describe("The agent acting on this task; it must be the task's creator or assignee. " +
					"Omit it when your credential resolves one agent: the call then acts as that agent. " +
					"Without a resolved agent, omitting it is refused. It is recorded as who corrected the segment."),
		},
		{
			outputSchema: correctTaskSegmentServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Correct task segment",
		},
		async ({
			taskId,
			segmentIndex,
			start,
			end,
			reason,
			callerOrchestrator,
		}) => {
			try {
				const orgDenied = unresolvedOrgDenial("correct_task_segment");
				if (orgDenied) return orgDenied;
				await convex.mutation("tasks:correctSegment" as any, {
					taskId: taskId as any,
					segmentIndex,
					start,
					end,
					reason,
					callerOrchestrator,
					...doorScopeArgs("tasks:correctSegment", undefined),
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { taskId, segmentIndex, corrected: true };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── checkout_task ───────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"checkout_task",
		"Atomically claim a todo task, preventing race conditions when multiple orchestrators compete. " +
			"Returns { claimed: true } when the claim succeeds, or { claimed: false, reason } when the task is not claimable (not todo, paused, or carrying an open work segment); nothing is written then. " +
			"WHEN: use before start_task in multi-orchestrator queues to ensure exclusive ownership. " +
			"EXAMPLE: checkout_task taskId='k178d3ns...' callerOrchestrator='alpha' callerInstance='alpha-vps'.",
		{
			taskId: taskIdSchema.describe("The task to claim: its taskId as returned by create_task, list_tasks or get_task."),
			// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
			callerOrchestrator: creatorSchema.describe(
				"The agent claiming the task. Omit it when your credential resolves one agent: the claim is then checked as that agent. " +
					"Otherwise omitting it is refused.",
			),
			callerInstance: z
				.string()
				.optional()
				.describe("Your instance, e.g. 'sigma-vps', recorded as the claiming instance. Omit when you run as a single instance."),
		},
		{
			outputSchema: checkoutTaskServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Claim a task to work on",
		},
		async ({ taskId, callerOrchestrator, callerInstance }) => {
			try {
				const orgDenied = unresolvedOrgDenial("checkout_task");
				if (orgDenied) return orgDenied;
				const result = await convex.mutation("tasks:checkout" as any, {
					taskId: taskId as any,
					callerOrchestrator,
					callerInstance,
					...doorScopeArgs("tasks:checkout", undefined),
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = result;
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── delete_task ─────────────────────────────────────────────────────────────

	// oracle-justified: a hard DELETE where pause_task is a status TRANSITION on the same row; both doors
	//   read memberWriterRoles through resolveHumanActor (convex/lib/humanActor.ts), but deleteTask also
	//   requires org:admin for a human (adminOnly) and creator-or-system for an agent (convex/tasks.ts
	//   deleteTask), because a deleted row cannot be restored or carry its actor.
	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"delete_task",
		"Permanently delete a task; only the creator or system role may delete. Returns { deleted: true }. " +
			"WHEN: use to remove erroneously created tasks or test artifacts — prefer complete_task for real work. " +
			"EXAMPLE: delete_task taskId='k178d3ns...' callerOrchestrator='alpha'.",
		{
			taskId: taskIdSchema.describe("The task to delete: its taskId as returned by create_task, list_tasks or get_task."),
			// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
			callerOrchestrator: creatorSchema
				.optional()
				.describe("The agent deleting; it must be the task's creator (or 'system'). " +
					"Omit it when your credential resolves one agent: it is then that agent. " +
					"A signed-in organisation admin may also omit it; anyone else omitting it is refused."),
		},
		{
			outputSchema: deletedServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: true,
			title: "Delete task",
		},
		async ({ taskId, callerOrchestrator }) => {
			try {
				const orgDenied = unresolvedOrgDenial("delete_task");
				if (orgDenied) return orgDenied;
				const result = await convex.mutation("tasks:deleteTask" as any, {
					taskId: taskId as any,
					callerOrchestrator,
					...doorScopeArgs("tasks:deleteTask", undefined),
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = result;
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── block_task ──────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"block_task",
		"Mark a task as blocked with an optional reason and blocking task IDs, setting status to blocked. " +
			"Returns { taskId, status: 'blocked', reason, blockedOnTaskId, blockedCause, dependsOn? }; dependsOn is the full resulting list and appears only when blockedBy was given. " +
			"WHEN: use when external dependency or missing input prevents progress — record the specific blocker. " +
			"A block is a commitment, not just a journal entry: cite blockedOnTaskId (a live task owned by someone else) so the responder is charged to unblock you, OR mark the reason with '# blocked-on-nobody: <reason>' when nobody in the fleet owns the obstacle. " +
			"Pass blockedCause to say WHAT you are waiting on ('human' — an operator decision/answer; 'authorisation' — a merge/publish/approval gate; 'peer_task' — a plain upstream dependency; 'other' if none apply) so waiting-on state is derivable, never a free-text guess. " +
			"EXAMPLE: block_task taskId='k178d3ns...' blockedOnTaskId='k17bbbbb...' blockedCause='authorisation' reason='Waiting for B2 PR#667 merge' callerOrchestrator='beta'.",
		{
			taskId: taskIdSchema.describe("The task to block: its taskId as returned by create_task, list_tasks or get_task."),
			reason: z.string().optional().describe("Why the task is blocked. Omit it only when blockedOnTaskId is given; without a blocker it must carry the marker '# blocked-on-nobody: <reason>'."),
			blockedBy: z
				.array(taskIdSchema)
				.optional()
				.describe(
					"Prerequisite taskIds (from list_tasks) to add to the task's dependsOn; appended, de-duplicated, nothing removed. " +
						"Omit to leave dependsOn as it is.",
				),
			blockedOnTaskId: taskIdSchema
				.optional()
				.describe(
					"The live task, owned by someone else, that this one waits on: its taskId from list_tasks. " +
						"Omit it only when reason carries the '# blocked-on-nobody:' marker.",
				),
			blockedCause: blockedCauseSchema.meta({ default: "other" }).describe(
				"What is being waited on: peer_task (an upstream task), human (an operator decision), authorisation (a merge, publish or approval gate), or other.",
			),
			// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
			callerOrchestrator: creatorSchema
				.optional()
				.describe("The agent acting on this task; it must be the task's creator or assignee. " +
					"Omit it when your credential resolves one agent: the call then acts as that agent. " +
					"Without a resolved agent, omitting it is refused."),
		},
		{
			outputSchema: blockTaskServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: true,
			title: "Block task",
		},
		async ({
			taskId,
			reason,
			blockedBy,
			blockedOnTaskId,
			blockedCause,
			callerOrchestrator,
		}) => {
			try {
				const orgDenied = unresolvedOrgDenial("block_task");
				if (orgDenied) return orgDenied;
				const blockArgs: Record<string, any> = {
					taskId: taskId as any,
				};
				if (reason) blockArgs.reason = reason;
				if (blockedOnTaskId) blockArgs.blockedOnTaskId = blockedOnTaskId as any;
				if (blockedCause) blockArgs.blockedCause = blockedCause;
				if (callerOrchestrator)
					blockArgs.callerOrchestrator = callerOrchestrator;

				Object.assign(blockArgs, doorScopeArgs("tasks:blockTask", callerOrchestrator));
				await convex.mutation("tasks:blockTask" as any, blockArgs);

				let resultingDependsOn: string[] | undefined;
				if (blockedBy && blockedBy.length > 0) {
					// addDependsOn APPENDS (dedup, same-org, no self, no cycle) inside the
					// mutation's transaction; dependsOn would wipe earlier dependencies.
					await convex.mutation("tasks:update" as any, {
						taskId: taskId as any,
						addDependsOn: blockedBy.map((id: string) => id as any),
						...(callerOrchestrator ? { callerOrchestrator } : {}),
						...doorScopeArgs("tasks:update", callerOrchestrator),
					});
					// The door returns null; report the list it left on the row.
					const row = (await convex.query("tasks:getById" as any, {
						taskId,
					})) as { dependsOn?: string[] } | null;
					resultingDependsOn = row?.dependsOn ?? [];
				}

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = {
						taskId,
						status: "blocked",
						reason,
						blockedOnTaskId,
						blockedCause: blockedCause ?? "other",
						...(resultingDependsOn ? { dependsOn: resultingDependsOn } : {}),
					};
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── add_task_dependency ─────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"add_task_dependency",
		"Add dependency task IDs to a task so it cannot start until all listed tasks complete. " +
			"APPENDS: the new IDs are merged into the task's existing dependsOn (deduplicated, existing first) and the full resulting list is returned; nothing already there is removed. " +
			"Each ID must be an existing task of the same organisation; a self-dependency or a cycle is refused. " +
			"To REPLACE the whole list use update_task dependsOn. " +
			"Returns { taskId, dependsOn, updated: true } with the full resulting list. " +
			"WHEN: use when creating a task that depends on prior work not yet captured in dependsOn. " +
			"EXAMPLE: add_task_dependency taskId='k178d3ns...' dependsOn=['k17bbbbb...'] callerOrchestrator='alpha'.",
		{
			taskId: taskIdSchema.describe(
				"The task to make dependent: its taskId as returned by create_task, list_tasks or get_task.",
			),
			dependsOn: z
				.array(taskIdSchema)
				.describe("The prerequisite tasks to add: their taskIds as returned by create_task or list_tasks."),
			// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
			callerOrchestrator: creatorSchema
				.optional()
				.describe("The agent acting on this task; it must be the task's creator or assignee. " +
					"Omit it when your credential resolves one agent: the call then acts as that agent. " +
					"Without a resolved agent, omitting it is refused."),
		},
		{
			outputSchema: addTaskDependencyServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Add task dependency",
		},
		async ({ taskId, dependsOn, callerOrchestrator }) => {
			try {
				const orgDenied = unresolvedOrgDenial("add_task_dependency");
				if (orgDenied) return orgDenied;
				// addDependsOn APPENDS inside the mutation's transaction (dependsOn would
				// replace the list); the door validates every id.
				const updateArgs: Record<string, any> = {
					taskId: taskId as any,
					addDependsOn: dependsOn.map((id: string) => id as any),
				};
				if (callerOrchestrator)
					updateArgs.callerOrchestrator = callerOrchestrator;

				Object.assign(updateArgs, doorScopeArgs("tasks:update", callerOrchestrator));
				await convex.mutation("tasks:update" as any, updateArgs);
				// The door returns null; report the list it left on the row.
				const row = (await convex.query("tasks:getById" as any, { taskId })) as {
					dependsOn?: string[];
				} | null;
				const resulting = row?.dependsOn ?? [];

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { taskId, dependsOn: resulting, updated: true };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── list_tasks_by_mission ───────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"list_tasks_by_mission",
		"List all tasks linked to a mission, optionally filtered by status, newest first. " +
			"Returns { items, nextCursor, truncated, scopeFiltered? }: items are tasks, newest first; nextCursor is the next page's cursor, null on the last page; scopeFiltered counts rows withheld by scope; truncated is true when the 60 KB response cap cut the page (nextCursor is then null). The text is the bare JSON array of the tasks, or { items, nextCursor?, scopeFiltered? } when another page exists or rows were withheld. " +
			"WHEN: use to review mission progress or find blocked/open tasks within a specific mission. " +
			"EXAMPLE: list_tasks_by_mission missionId='k57a36y8...' status='in_progress' limit=20.",
		{
			missionId: missionIdSchema.describe("The mission to list: its missionId as returned by create_mission or list_missions."),
			status: taskStatusFilterSchema
				.optional()
				.describe("Narrows the result to tasks in any of the given states. A shorthand stands alone in the list: open keeps everything not finished, active only work not started or under way, all applies no filter. " +
					"Omit for every status."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page."),
			fields: fieldsSchema
				.optional()
				.meta({ default: "lite" })
				.describe("How much of each row comes back: lite is each task's ID, creation time, title, status, priority, assignee and mission, enough to pick a row for fewer tokens; full is every stored field."),
			createdBy: assigneeSchema.optional().describe("Keep only tasks created by this orchestrator. Omit for every creator."),
			updatedSince: updatedSinceSchema.optional().describe("The moment from which changes count: keep only tasks last updated at or after it (a millisecond timestamp, as Date.now() gives; Date.now() minus 86400000 for the last day). Omit for no time window."),
			cursor: z
				.string()
				.optional()
				.describe(
					"The nextCursor value a previous list_tasks_by_mission call returned, to fetch the following (older) page. " +
						"Omit for the first page.",
				),
		},
		{
			outputSchema: listTasksByMissionServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List tasks by mission",
		},
		async ({
			missionId,
			status,
			limit,
			fields,
			createdBy,
			updatedSince,
			cursor,
		}) => {
			try {
				// S3.3 B8 follow-up — decode opaque cursor → createdBefore anchor.
				let createdBefore: number | undefined;
				if (cursor !== undefined && cursor !== "") {
					try {
						const decoded = decodeCursor(cursor);
						if (decoded && "createdBefore" in decoded) {
							createdBefore = decoded.createdBefore;
						}
					} catch (err: any) {
						return mcpError(err?.message ?? "invalid cursor");
					}
				}
				const effectiveLimit =
					limit === undefined ? undefined : clampLimit(limit);

				// S3.1.C1 — scope-aware filter replaces guardMasterOnly.
				const tenantGated =
					oauthCtx?.actor !== undefined && !isMasterScope(oauthCtx);
				const tasks = await convex.query("tasks:listByMission" as any, {
					missionId: missionId as any,
					status,
					limit: effectiveLimit ?? 20,
					fields: tenantGated ? "full" : (fields ?? "lite"),
					createdBy,
					updatedSince,
					createdBefore,
				});

				// k174y9ra7pp8zed3bcczk6xaed8cpynp — mirror get_task: `assignedTo`
				// is a per-row grant (convex/tasks.ts L88-89 ORs createdBy||assignedTo).
				// TENANT GATE, collection surface (same predicate as get_task).
				// `tenantRows` is the page after the tenant gate: only these rows are
				// attributable to the caller's own organisation, so only their
				// removals by the allow-list below are counted as `scopeFiltered`.
				const tenantRows = filterRowsToActorTenant(
					oauthCtx,
					Array.isArray(tasks)
						? (tasks as Array<Record<string, unknown>>)
						: [],
				);
				const scopedRows = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					tenantRows,
					["assignedTo"],
				);
				// The gate needs `orgId`, which the lite projection strips, so a
				// gated caller is served full rows internally and reprojected to the
				// lite shape it asked for here — the public contract is unchanged.
				const filteredTasks =
					tenantGated && (fields ?? "lite") === "lite"
						? scopedRows.map((t) => ({
								_id: t._id,
								_creationTime: t._creationTime,
								title: t.title,
								status: t.status,
								priority: t.priority,
								assignedTo: t.assignedTo,
								...(t.missionId !== undefined
									? { missionId: t.missionId }
									: {}),
							}))
						: scopedRows;

				// S3.3 B8 follow-up — emit nextCursor when page is full.
				// Measured on the RAW page, before the scope filter narrowed it.
				const requestedLimit = effectiveLimit ?? 20;
				const { nextCursor, scopeFiltered } = scopedPageContinuation(
					Array.isArray(tasks) ? tasks : [],
					requestedLimit,
					filteredTasks.length,
					{
						inTenantCount: tenantRows.length,
						reportRemoved: oauthCtx?.clerkOrgSlug !== undefined,
					},
				);
				const tasksWithCursor =
					nextCursor !== null || scopeFiltered > 0
						? {
								items: filteredTasks,
								...(nextCursor !== null ? { nextCursor } : {}),
								...(scopeFiltered > 0 ? { scopeFiltered } : {}),
							}
						: filteredTasks;

				const capped = capListResponse(
					tasksWithCursor,
					JSON.stringify(tasksWithCursor, null, 2),
					"list_tasks_by_mission",
				);
				return {
					content: [{ type: "text", text: capped.text }],
					structuredContent: pageStructured(tasksWithCursor, capped),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── create_mission ──────────────────────────────────────────────────────────

	// oracle-justified: actor-bound `from` write (createdBy recorded) whose door stamps orgId from the verified scope
	//   (missions:create) and whose updates compare the stored orgId with the caller's org
	//   (isOrgAllowedForScope, convex/missions.ts); list_missions is an in-handler-filtered read.
	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "createdBy" },
		"create_mission",
		"Create a mission grouping related tasks under a project with a pilot orchestrator and agent list. " +
			"Returns { missionId, name, project, pilot, status }; pass missionId to create_task or instantiate_template_into_mission. " +
			"WHEN: use when starting a multi-task initiative that needs lifecycle tracking and progress reporting. " +
			"EXAMPLE: create_mission name='Day 92 C3' project='vantage-peers' pilot='alpha' agents=['beta','gamma'] priority='high' createdBy='alpha'.",
		{
			name: z.string().describe("A short name for the initiative, shown in mission lists."),
			description: z.string().optional().describe("What the mission is about. Omit for a name-only mission."),
			project: z
				.string()
				.describe("The project the mission belongs to, e.g. 'vantage-peers'."),
			status: missionStatusSchema.default("brainstorm").describe("The lifecycle stage the mission starts in."),
			priority: prioritySchema.describe("How urgent the mission is, a label list_missions and get_mission show; its tasks keep their own priority."),
			pilot: creatorSchema.describe("The orchestrator leading the mission, by name, e.g. 'alpha'; list_peers shows who exists."),
			agents: flexArray.describe("The orchestrators taking part, by name, e.g. ['beta', 'gamma']."),
			brief: z.string().optional().describe("The mission brief: goals, constraints, definition of done. Omit to add it later (a template can supply it)."),
			startDate: z.number().optional().describe("The moment work on the mission is planned to start (a millisecond timestamp, as Date.now() gives). Omit when not planned."),
			targetDate: z
				.number()
				.optional()
				.describe("The moment the mission is meant to be finished by (a millisecond timestamp, as Date.now() gives). Omit for no target."),
			progress: z.number().optional().describe("How far the mission is, as a percentage. Omit to start at none."),
			createdBy: creatorSchema
				.optional()
				.describe("The agent this call writes as, recorded as the mission's author (e.g. 'sigma'). " +
					"Omit it when your credential resolves one agent: it is then that agent; a signed-in person omits it and is recorded under its own verified account. " +
					"Otherwise omitting it is refused."),
		},
		{
			outputSchema: createMissionServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Create mission",
			personDoor: true,
		},
		async ({
			name,
			description,
			project,
			status,
			priority,
			pilot,
			agents,
			brief,
			startDate,
			targetDate,
			progress,
			createdBy,
		}) => {
			try {
				const pilotDenied = await guardAssignee("pilot", pilot);
				if (pilotDenied) return pilotDenied;

				const missionId = await convex.mutation("missions:create" as any, {
					name,
					description,
					project,
					status,
					priority,
					pilot,
					agents: toArray(agents) as string[],
					brief,
					startDate,
					targetDate,
					progress,
					createdBy,
					...doorScopeArgs("missions:create", createdBy),
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { missionId, name, project, pilot, status };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── list_missions ───────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason: "non-master restricted in-handler to pilot===oauthCtx.userId",
		},
		"list_missions",
		"List missions filtered by project, pilot, or status, newest first with cursor paging support. " +
			"Returns { items, nextCursor, truncated }: items are missions, newest first; nextCursor is the next page's cursor, null on the last page; truncated is true when the 60 KB response cap cut the page (nextCursor is then null). The text is the bare JSON array of the missions on the last page, else { items, nextCursor }. " +
			"WHEN: use to audit active missions, find missions by pilot, or check cross-project progress. " +
			"EXAMPLE: list_missions project='vantage-peers' status='execute' pilot='alpha' limit=20.",
		{
			project: z.string().optional().describe("Keep only missions of this project. Omit for every project."),
			pilot: creatorSchema.optional().describe("Keep only missions led by this orchestrator. Omit for every pilot."),
			status: missionStatusFilterSchema
				.optional()
				.describe("Which missions to keep, as a list of stages; an alias stands alone: 'open' keeps every mission not finished, 'active' only those being planned or executed, 'all' applies no filter. " +
					"Omit for every stage."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page."),
			fields: fieldsSchema
				.optional()
				.meta({ default: "lite" })
				.describe("How much of each row comes back: lite is each mission's ID, creation time, name, status, pilot, priority and project; full is every stored field."),
			updatedSince: updatedSinceSchema.optional().describe("The moment from which changes count: keep only missions last updated at or after it (a millisecond timestamp, as Date.now() gives; Date.now() minus 86400000 for the last day). Omit for no time window."),
			cursor: z
				.string()
				.optional()
				.describe(
					"The nextCursor value a previous list_missions call returned, to fetch the following (older) page. " +
						"Omit for the first page.",
				),
		},
		{
			outputSchema: listMissionsServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List missions",
		},
		async ({ project, pilot, status, limit, fields, updatedSince, cursor }) => {
			try {
				// Non-master: must pilot=<own-userId>. Otherwise the query spans
				// every tenant's missions.
				if (oauthCtx && !isMasterScope(oauthCtx)) {
					if (pilot !== oauthCtx.userId) {
						return mcpError(
							`Forbidden: list_missions requires pilot='${oauthCtx.userId}' for non-master scope (current: ${oauthCtx.scopeProfile}).`,
						);
					}
				}

				// S3.3 B8 follow-up — decode opaque cursor → createdBefore anchor.
				let createdBefore: number | undefined;
				if (cursor !== undefined && cursor !== "") {
					try {
						const decoded = decodeCursor(cursor);
						if (decoded && "createdBefore" in decoded) {
							createdBefore = decoded.createdBefore;
						}
					} catch (err: any) {
						return mcpError(err?.message ?? "invalid cursor");
					}
				}
				const effectiveLimit =
					limit === undefined ? undefined : clampLimit(limit);

				const missions = await convex.query("missions:list" as any, {
					project,
					pilot,
					status,
					limit: effectiveLimit ?? 20,
					fields: fields ?? "lite",
					updatedSince,
					createdBefore,
				});

				// S3.3 B8 follow-up — emit nextCursor when page is full.
				const requestedLimit = effectiveLimit ?? 20;
				const missionsArr = Array.isArray(missions) ? missions : [];
				let nextCursor: string | null = null;
				if (missionsArr.length >= requestedLimit && missionsArr.length > 0) {
					const last = missionsArr[missionsArr.length - 1] as {
						_creationTime?: number;
					};
					if (typeof last._creationTime === "number") {
						nextCursor = encodeCursor({ createdBefore: last._creationTime });
					}
				}
				const missionsWithCursor =
					nextCursor !== null ? { items: missionsArr, nextCursor } : missions;

				const capped = capListResponse(
					missionsWithCursor,
					JSON.stringify(missionsWithCursor, null, 2),
					"list_missions",
				);
				const text = appendMarkerIfEnabled(capped.text, () => ({
					kind: "mission-timeline",
					items: Array.isArray(missions)
						? missions.map((m: any) => ({
								_id: m._id,
								name: m.name,
								project: m.project,
								status: m.status,
								pilot: m.pilot,
								priority: m.priority,
								progress: m.progress,
							}))
						: [],
				}));

				return {
					content: [{ type: "text", text }],
					structuredContent: pageStructured(missionsWithCursor, capped),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_mission ─────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"get_mission",
		"Fetch a single mission by Convex ID with full details: status, pilot, agents, progress, and dates. " +
			"Returns the mission document as JSON (status, pilot, agents, progress, dates, brief), or null when it does not exist or is not visible to you. " +
			"WHEN: use before assigning tasks or reporting to get the canonical mission state. " +
			"EXAMPLE: get_mission missionId='k57a36y8w5t085bqr23dsmvb2d882506'.",
		{
			missionId: missionIdSchema.describe("The mission to fetch: its missionId as returned by create_mission or list_missions."),
		},
		{
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get mission",
		},
		async ({ missionId }) => {
			try {
				// S3.1.C1 — scope-aware filter replaces guardMasterOnly.
				// cloud-identity 0.5.0 — missions carry no createdBy/namespace; a
				// caller named as `pilot` or inside `agents` is a per-row grant
				// the filter now consults directly via grantFields, instead of the
				// caller being structurally invisible to createdBy/namespace-only
				// matching (k174y9ra7pp8zed3bcczk6xaed8cpynp).
				const mission = await convex.query("missions:get" as any, {
					missionId: missionId as any,
				});
				const filteredMission = scopeFilterGet(
					oauthCtx ?? DENIED_SCOPE_CTX,
					mission as any,
					["pilot", "agents"],
				);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(filteredMission, null, 2),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── update_mission ──────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		// The acting name is callerOrchestrator; `pilot` is an ASSIGNMENT, never
		// bound to (or derived from) the caller's credential.
		{ kind: "from", fromArg: "callerOrchestrator" },
		"update_mission",
		"Update any mutable field on a mission. Each given field overwrites the stored value (agents is replaced whole, never appended); omitted fields are kept and updatedAt is set. " +
			"Cancelling (status='cancelled') needs callerOrchestrator, the mission's creator or 'system', and a cancelReason; a complete mission cannot be cancelled. " +
			"Returns { missionId, updated: true }. WHEN: use to advance status, update progress percentage, or change pilot/agents mid-flight. " +
			"EXAMPLE: update_mission missionId='k57a36y8...' progress=75 status='validate'.",
		{
			missionId: missionIdSchema.describe(
				"The mission to update: its missionId as returned by create_mission or list_missions.",
			),
			name: z.string().optional().describe("The label list_missions and get_mission show; the mission keeps its missionId, so tasks and links to it are unaffected. Omit to keep it."),
			description: z.string().optional().describe("A new description, replacing the current one. Omit to keep it."),
			project: z.string().optional().describe("The project the mission files under: the same name create_mission took, which list_missions' project filter compares exactly; usually the billing line its tasks carry (billing reads each task's own project, not the mission's). Omit to keep it."),
			status: missionStatusSchema.optional().describe("Where the mission stands in its life, from first idea to closed; list_missions' status filter and its open and active shorthands read it. Moving it to cancelled needs callerOrchestrator and cancelReason. Omit to keep it."),
			priority: prioritySchema.optional().describe("How urgent the mission is, a label list_missions and get_mission show; nothing filters or orders by it and its tasks keep their own priority. Omit to keep it."),
			pilot: creatorSchema.optional().describe("A new lead orchestrator, by name. Omit to keep it."),
			agents: flexArrayOptional.describe("The complete new list of participating orchestrators, replacing the current one. Omit to keep it."),
			brief: z.string().optional().describe("A new brief, replacing the current one. Omit to keep it."),
			startDate: z.number().optional().describe("The new moment work on the mission is planned to start (a millisecond timestamp, as Date.now() gives). Omit to keep it."),
			targetDate: z.number().optional().describe("The new moment the mission is meant to be finished by (a millisecond timestamp, as Date.now() gives). Omit to keep it."),
			progress: z.number().optional().describe("The new progress percentage. Omit to keep it."),
			// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
			callerOrchestrator: creatorSchema
				.optional()
				.describe(
					"The agent making the change; to cancel it must be the mission's creator (or 'system'). " +
						"Omit it for any other change: a cancellation without it is refused unless a signed-in organisation admin makes it.",
				),
			cancelReason: z
				.string()
				.optional()
				.describe(
					"Why the mission is cancelled; required with status cancelled. Omit for any other change.",
				),
		},
		{
			outputSchema: missionUpdatedServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Update mission",
			personDoor: true,
		},
		async ({
			missionId,
			name,
			description,
			project,
			status,
			priority,
			pilot,
			agents,
			brief,
			startDate,
			targetDate,
			progress,
			callerOrchestrator,
			cancelReason,
		}) => {
			try {
				if (pilot) {
					const pilotDenied = await guardAssignee("pilot", pilot);
					if (pilotDenied) return pilotDenied;
				}
				await convex.mutation("missions:update" as any, {
					missionId: missionId as any,
					name,
					description,
					project,
					status,
					priority,
					pilot,
					agents: toArray(agents) as string[],
					brief,
					startDate,
					targetDate,
					progress,
					callerOrchestrator,
					cancelReason,
					...doorScopeArgs("missions:update", callerOrchestrator),
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { missionId, updated: true };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── update_mission_status ───────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		"update_mission_status",
		"Change a mission's lifecycle status in a single call without touching other fields. Served to the fleet master only: any other caller is refused. " +
			"Returns { missionId, status }. WHEN: only the status changes; update_mission changes the other fields and records a cancelReason. " +
			"EXAMPLE: update_mission_status missionId='k57a36y8...' status='complete'.",
		{
			missionId: missionIdSchema.describe("The mission to move: its missionId as returned by create_mission or list_missions."),
			status: missionStatusSchema.describe("The stage the mission moves to, read by list_missions' status filter. Every stage is accepted here, cancelled included, and no cancel reason is recorded; a reopened (no longer cancelled) mission is accepted too."),
		},
		{
			outputSchema: missionStatusServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Update mission status",
		},
		async ({ missionId, status }) => {
			// C0.4: mission lifecycle = infrastructure-level — master scope only.
			// No per-mission identity arg exists for fromAllowList delegation.
			const masterDenied = guardMasterOnly("update_mission_status");
			if (masterDenied) return masterDenied;
			try {
				await convex.mutation("missions:updateStatus" as any, {
					missionId: missionId as any,
					status,
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { missionId, status };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── write_diary ─────────────────────────────────────────────────────────────

	// oracle-justified: actor-bound upsert: MCP scope `from` (decideActingClaim + roster passesScopeFilter on `orchestrator`)
	//   and diary:write admits only orchestrators on the caller's roster (isOrchestratorAllowedForScope,
	//   convex/diary.ts); get_diary is a read filtered in-handler by the same roster predicate.
	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "orchestrator" },
		"write_diary",
		"Write or upsert a diary entry for a specific date and orchestrator with highlights and blockers. " +
			"Returns { diaryId, date, orchestrator }; writing the same date again replaces that entry's content, highlights and blockers. " +
			"WHEN: call at end of session to record what was accomplished, learned, and what blocked progress. " +
			"EXAMPLE: write_diary date='2026-06-06' orchestrator='gamma' content='Standardized 86 descriptions...'.",
		{
			date: z.string().describe("The day the entry covers, as an ISO date, e.g. '2026-03-25'."),
			orchestrator: creatorSchema.describe("Whose diary this is, e.g. 'gamma'. Omit it when your credential resolves one agent: it is then that agent. " +
				"Otherwise omitting it is refused."),
			content: z.string().describe("The entry: what was done, learned and decided that day."),
			highlights: flexArrayOptional.describe("The day's key points, one per item. Omit for none (an existing entry's list is cleared)."),
			blockers: flexArrayOptional.describe("What blocked progress, one per item. Omit for none (an existing entry's list is cleared)."),
		},
		{
			outputSchema: writeDiaryServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Write diary entry",
		},
		async ({ date, orchestrator, content, highlights, blockers }) => {
			let contentBytes = 0;
			try {
				contentBytes = assertContentSize(content, "write_diary");

				// v2.4.8: derive createdBy from auth context (oauthCtx.userId).
				// This is the anti-spoof authored-by — distinct from orchestrator
				// (writer-intent label, client-supplied). On the no-auth path
				// (master-scope bearer / local dev), oauthCtx is undefined and
				// createdBy gracefully degrades to undefined (transition period).
				const createdBy: string | undefined = oauthCtx?.userId;

				// The write is made for the bearer's verified org (`verifiedOrg`):
				// a seat reaches Convex as the service account, which would
				// otherwise store the entry fleet-owned. A bearer whose org cannot
				// be resolved is refused here, before any write.
				const orgDenied = unresolvedOrgDenial("write_diary");
				if (orgDenied !== null) return orgDenied;
				const diaryId = await convex.mutation("diary:write" as any, {
					date,
					orchestrator,
					content,
					highlights: toArray(highlights),
					blockers: toArray(blockers),
					createdBy,
					...doorScopeArgs("diary:write", undefined),
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { diaryId, date, orchestrator };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				if (error instanceof ProtocolError) throw error;
				console.error("[write_diary] mutation failed", {
					contentBytes,
					date,
					orchestrator,
					errorMessage: error?.message ?? String(error),
					// A ConvexError message is redacted to "[Request ID] Server Error"; its code is on .data.
					errorData: error?.data ?? null,
				});
				return mcpConvexError(error);
			}
		},
	);

	// ── get_diary ───────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"get_diary",
		"Fetch a diary entry for a specific date and orchestrator, returning null if none exists. " +
			"Returns the diary entry as JSON (content, highlights, blockers, author), or null when none exists for that date and orchestrator. " +
			"WHEN: use to review what an orchestrator did on a given day for recap or handoff briefing. " +
			"EXAMPLE: get_diary date='2026-06-06' orchestrator='alpha'.",
		{
			date: z.string().describe("The day to read, as an ISO date, e.g. '2026-03-25'."),
			orchestrator: creatorSchema.describe(
				"Whose diary to read, e.g. 'alpha'.",
			),
		},
		{
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get diary entry",
		},
		async ({ date, orchestrator }) => {
			try {
				// S3.1.C1 — scope-aware filter replaces guardMasterOnly.
				// Tenant applied INSIDE the Convex read (`verifiedOrg`): the door
				// reads the caller's org range only. scopeFilterGet below compares
				// names, which collide across organisations, so it cannot do this.
				const orgDenied = unresolvedOrgDenial("get_diary");
				if (orgDenied !== null) return orgDenied;
				const entry = await convex.query("diary:get" as any, {
					date,
					orchestrator,
					...doorScopeArgs("diary:get", undefined),
				});
				const filteredEntry = scopeFilterGet(
					oauthCtx ?? DENIED_SCOPE_CTX,
					entry as any,
				);

				const baseText = JSON.stringify(filteredEntry, null, 2);
				const text = appendMarkerIfEnabled(baseText, () => {
					if (!filteredEntry) return null;
					return {
						kind: "diary-entry",
						item: {
							_id: (filteredEntry as any)._id,
							date: (filteredEntry as any).date,
							orchestrator: (filteredEntry as any).orchestrator,
							content: (filteredEntry as any).content,
							highlights: (filteredEntry as any).highlights,
							blockers: (filteredEntry as any).blockers,
						},
					};
				});

				return {
					content: [{ type: "text", text }],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── list_diaries ────────────────────────────────────────────────────────────

	// oracle-justified: list vs get_diary differ by design on verb and on isolation: get_diary is a one-row
	//   `.unique()` on (orchestrator, date) (convex/diary.ts:142-145) behind requireResolvedCaller
	//   (diary.ts:138), while diary:list drains many rows, bounded per rostered orchestrator through
	//   by_orchestrator_date (`.take(fetchCap)`, diary.ts:236-265) and resolves its caller at diary.ts:224.
	//   The refusal gap (an anonymous caller answered an empty success, and the table taken before the
	//   roster filter) is closed by task k17066vn8kh5v1a8xkgsx0bnxs8fjre5; the remaining asymmetry is the
	//   many-row read and its signed-in-no-organisation refusal envelope, tested via isRefusedEnvelope.
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"non-master restricted in-handler to orchestrator/createdBy===oauthCtx.userId",
		},
		"list_diaries",
		"List diary entries filtered by orchestrator or author, newest first with cursor paging support. " +
			"Returns { items, nextCursor, truncated }: items are diary entries, newest first; nextCursor is the next page's cursor, null on the last page; truncated is true when the 60 KB response cap cut the page (nextCursor is then null). The text is the bare JSON array of the entries on the last page, else { items, nextCursor }. " +
			"WHEN: use to review recent history across sessions or audit a period of activity. " +
			"EXAMPLE: list_diaries orchestrator='beta' limit=10.",
		{
			orchestrator: creatorSchema
				.optional()
				.describe("Keep only this orchestrator's diary. Omit for every orchestrator."),
			createdBy: assigneeSchema
				.optional()
				.describe(
					"Keep only entries whose verified author is this agent (the orchestrator field is what the writer typed; this one is what the credential proved). " +
						"Omit for every author.",
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.meta({ deprecated: true })
				.describe("Has no effect on this tool: every row comes back whole, with every stored field, whichever value is sent. Accepted only so that a client which sends it is not refused; leave it out."),
			cursor: z
				.string()
				.optional()
				.describe(
					"The nextCursor value a previous list_diaries call returned, to fetch the following (older) page. " +
						"Omit for the first page.",
				),
		},
		{
			outputSchema: listDiariesServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List diary entries",
		},
		async ({ orchestrator, createdBy, limit, fields, cursor }) => {
			try {
				// v2.4.8: orchestrator (writer-intent) and createdBy (auth-derived
				// author) are separate filters — NOT aliases. Forward both independently.
				// Non-master: REQUIRE at least one explicit self-scope — undefined passes
				// through are forbidden. Mirrors v2.4.7 effectiveOrchestrator shortcircuit:
				// undefined !== myId → Forbidden. No silent fleet-read for non-master callers.
				if (oauthCtx && !isMasterScope(oauthCtx)) {
					const myId = oauthCtx.userId;
					const orchestratorScoped = orchestrator === myId;
					const createdByScoped = createdBy === myId;
					if (!orchestratorScoped && !createdByScoped) {
						return mcpError(
							`Forbidden: list_diaries requires orchestrator='${myId}' OR createdBy='${myId}' for non-master scope (current scope: ${oauthCtx.scopeProfile}).`,
						);
					}
				}

				// S3.3 B8 follow-up — decode opaque cursor → createdBefore anchor.
				let createdBefore: number | undefined;
				if (cursor !== undefined && cursor !== "") {
					try {
						const decoded = decodeCursor(cursor);
						if (decoded && "createdBefore" in decoded) {
							createdBefore = decoded.createdBefore;
						}
					} catch (err: any) {
						return mcpError(err?.message ?? "invalid cursor");
					}
				}
				const effectiveLimit =
					limit === undefined ? undefined : clampLimit(limit);

				// Tenant applied INSIDE the Convex read (`verifiedOrg`): the gate
				// above compares the userId to a NAME, and names collide across
				// organisations. A bearer whose org cannot be resolved is refused.
				const orgDenied = unresolvedOrgDenial("list_diaries");
				if (orgDenied !== null) return orgDenied;
				const entries = await convex.query("diary:list" as any, {
					orchestrator,
					createdBy,
					limit: effectiveLimit ?? 20,
					fields: fields ?? "lite",
					createdBefore,
					...doorScopeArgs("diary:list", undefined),
				});

				// A refusal is not an absence: say so BEFORE the `Array.isArray`
				// coalescing below turns the envelope into an empty array.
				if (isRefusedEnvelope(entries)) {
					return mcpRefused("list_diaries", "diary:list");
				}

				// S3.3 B8 follow-up — emit nextCursor when page is full.
				const requestedLimit = effectiveLimit ?? 20;
				const entriesArr = Array.isArray(entries) ? entries : [];
				let nextCursor: string | null = null;
				if (entriesArr.length >= requestedLimit && entriesArr.length > 0) {
					const last = entriesArr[entriesArr.length - 1] as {
						_creationTime?: number;
					};
					if (typeof last._creationTime === "number") {
						nextCursor = encodeCursor({ createdBefore: last._creationTime });
					}
				}
				const entriesWithCursor =
					nextCursor !== null ? { items: entriesArr, nextCursor } : entries;

				const capped = capListResponse(
					entriesWithCursor,
					JSON.stringify(entriesWithCursor, null, 2),
					"list_diaries",
				);
				return {
					content: [{ type: "text", text: capped.text }],
					structuredContent: pageStructured(entriesWithCursor, capped),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── create_briefing_note ────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "createdBy" },
		"create_briefing_note",
		"Create a briefing note that records one discussion: its title, topic, participants, full content, the decisions reached and the memories it builds on. " +
			"Returns { noteId, title, topic, createdBy }. " +
			"WHEN: use after key architectural, product, or operational discussions to record decisions durably. " +
			"EXAMPLE: create_briefing_note title='C3 desc standard' topic='architecture' participants=['alpha','beta'] content='...' createdBy='gamma'.",
		{
			title: z.string().describe("A short title naming the discussion."),
			topic: z
				.string()
				.describe("The category the note files under, e.g. 'architecture', 'revenue', 'product'; list_briefing_notes filters by it."),
			participants: stringListSchema.describe(
				"Who took part, as a list of names, e.g. ['pi', 'sigma'].",
			),
			content: z.string().describe("The full write-up of the discussion."),
			decisions: flexArrayOptional.describe(
				"The decisions reached, one per item. Omit when none were made.",
			),
			linkedMemoryIds: z
				.array(memoryIdSchema)
				.optional()
				.describe(
					"Memories this note builds on: their memoryId values as returned by store_memory or recall. " +
						"Only memories belong here: a briefing note's own ID is refused. Omit for none.",
				),
			createdBy: creatorSchema.describe(
				"The agent this call writes as, recorded as the note's author (e.g. 'sigma'). " +
					"Omit it when your credential resolves one agent: it is then that agent; a signed-in person omits it and is recorded under its own verified account. " +
					"Otherwise omitting it is refused.",
			),
		},
		{
			outputSchema: createBriefingNoteServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Create briefing note",
			personDoor: true,
		},
		async ({
			title,
			topic,
			participants,
			content,
			decisions,
			linkedMemoryIds,
			createdBy,
		}) => {
			let contentBytes = 0;
			try {
				contentBytes = assertContentSize(content, "create_briefing_note");

				// A seat reaches Convex as the fleet service account (no org on ctx.auth):
				// the note is stamped with the bearer's VERIFIED org, from the oauthContext
				// only. A non-master bearer whose org cannot be resolved is refused here,
				// never stored fleet-owned (its own seat could not read it back).
				const orgDenied = unresolvedOrgDenial("create_briefing_note");
				if (orgDenied) return orgDenied;

				const noteId = await convex.mutation("briefingNotes:create" as any, {
					title,
					topic,
					participants: toArray(participants) as string[],
					content,
					decisions: toArray(decisions),
					linkedMemoryIds: toArray(linkedMemoryIds) as string[],
					createdBy,
					// No createdBy: a person acting in its own name (verifiedPerson).
					...doorScopeArgs("briefingNotes:create", createdBy),
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = {
						noteId,
						title,
						topic,
						createdBy: createdBy ?? personActorOf(oauthCtx),
					};
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				if (error instanceof ProtocolError) throw error;
				console.error("[create_briefing_note] mutation failed", {
					contentBytes,
					fromOrchestrator: createdBy,
					topic,
					title,
					errorMessage: error?.message ?? String(error),
					// A ConvexError message is redacted to "[Request ID] Server Error"; its code is on .data.
					errorData: error?.data ?? null,
				});
				return mcpConvexError(error);
			}
		},
	);

	// ── update_briefing_note ────────────────────────────────────────────────────

	// oracle-justified: the boundary key differs from create_briefing_note only in the name of the actor argument:
	//   update binds the editing caller (callerOrchestrator), create binds the note's author
	//   (createdBy); both are `from` scope checked by decideActingClaim.
	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"update_briefing_note",
		updateBriefingNoteDescription,
		updateBriefingNoteSchema.shape,
		{
			outputSchema: briefingNoteUpdatedServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Update briefing note",
		},
		async ({
			noteId,
			callerOrchestrator,
			title,
			topic,
			participants,
			content,
			decisions,
			linkedMemoryIds,
		}) => {
			let contentBytes = 0;
			try {
				if (content !== undefined) {
					contentBytes = assertContentSize(content, "update_briefing_note");
				}

				await convex.mutation("briefingNotes:update" as any, {
					noteId: noteId as any,
					callerOrchestrator,
					title,
					topic,
					participants,
					content,
					decisions,
					linkedMemoryIds: linkedMemoryIds as any,
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { noteId, updated: true };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				if (error instanceof ProtocolError) throw error;
				console.error("[update_briefing_note] mutation failed", {
					contentBytes,
					callerOrchestrator,
					noteId,
					errorMessage: error?.message ?? String(error),
					// A ConvexError message is redacted to "[Request ID] Server Error"; its code is on .data.
					errorData: error?.data ?? null,
				});
				return mcpConvexError(error);
			}
		},
	);

	// ── get_briefing_note ───────────────────────────────────────────────────────
	// S3.1.C0 — single-row read with scope-aware filter (mirrors get_memory).
	// scopeFilterGet collapses cross-tenant rows to a non-leaky "not found".

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"get_briefing_note",
		"Fetch one briefing note by its noteId. " +
			"Returns the stored note as JSON with every field it holds (title, topic, participants, content, decisions, linkedMemoryIds, createdBy, createdAt); an ID you may not read returns 'Briefing note not found'. " +
			"WHEN: use when you have a specific noteId and need the full structured record for a handoff or recap. " +
			"EXAMPLE: get_briefing_note noteId='j57dy3049btafda9m2f5d2ggk987ph3f'.",
		{
			noteId: noteIdSchema.describe("The note to fetch: its noteId as returned by create_briefing_note or list_briefing_notes."),
		},
		{
			outputSchema: getBriefingNoteServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get briefing note",
		},
		async ({ noteId }) => {
			try {
				// Day 165 fix (task k175ga65p654z200ydj7s8qv5s8cnxfc): thread the
				// caller's identity into the Convex query itself, so a note
				// shared via `participants` (not just `createdBy`) is visible —
				// membership is resolved server-side via the by_participant_note
				// index, not this handler.
				// Absence is NOT master: an undefined oauthCtx must not resolve
				// `master=true` (which would send callerIdentities=undefined and let
				// Convex return the note unfiltered). isMasterScope(undefined) is
				// false, and a no-context caller falls to an EMPTY callerIdentities
				// list — the participant index then matches nothing (fail-closed).
				const master = isMasterScope(oauthCtx);
				const callerIdentities = master
					? undefined
					: (oauthCtx?.fromAllowList ?? []);
				// Tenant applied INSIDE the Convex read (`verifiedOrg`), as for
				// list_briefing_notes: the seat labels in `callerIdentities` are resolved
				// in the organisation the bearer was verified for, never in the note's.
				const orgDenied = unresolvedOrgDenial("get_briefing_note");
				if (orgDenied !== null) return orgDenied;
				const note = await convex.query("briefingNotes:get" as any, {
					noteId,
					master,
					callerIdentities,
					...doorScopeArgs("briefingNotes:get", undefined),
				});
				// scopeFilterGet only discriminates on createdBy/namespace — it
				// has no notion of `participants`. OR it with an independent
				// participants re-check (passesBriefingNoteParticipantScope) so a
				// note the caller is a participant on (but did not create) is
				// still visible, without trusting Convex's decision blindly —
				// this stays real defense-in-depth, same posture as before.
				const filtered = scopeFilterGet(oauthCtx ?? DENIED_SCOPE_CTX, note);
				const visible =
					filtered !== null ||
					passesBriefingNoteParticipantScope(oauthCtx, note as any);
				if (!visible) {
					return mcpError(`Briefing note not found: ${noteId}`);
				}
				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = note;
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── list_briefing_notes ─────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"list_briefing_notes",
		LIST_BRIEFING_NOTES_TOOL_DESCRIPTION,
		{
			topic: z
				.string()
				.optional()
				.describe("Keep only notes filed under this topic, e.g. 'architecture'. Omit for every topic."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page."),
			fields: fieldsSchema
				.optional()
				.meta({ default: "lite" })
				.describe("How much of each row comes back: lite is each note's ID, creation time, topic, title, participants and author, without its content; full is every stored field."),
			updatedSince: updatedSinceSchema.optional().describe("The moment from which changes count: keep only notes last updated at or after it (a millisecond timestamp, as Date.now() gives; Date.now() minus 86400000 for the last day). Omit for no time window."),
			cursor: z
				.string()
				.optional()
				.describe(
					"The nextCursor value a previous list_briefing_notes call returned, to fetch the following (older) page. " +
						"Omit for the first page.",
				),
		},
		{
			outputSchema: listBriefingNotesServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List briefing notes",
		},
		async ({ topic, limit, fields, updatedSince, cursor }) => {
			try {
				// S3.3 B8 — decode opaque cursor → createdBefore anchor.
				let createdBefore: number | undefined;
				if (cursor !== undefined && cursor !== "") {
					try {
						const decoded = decodeCursor(cursor);
						if (decoded && "createdBefore" in decoded) {
							createdBefore = decoded.createdBefore;
						}
					} catch (err: any) {
						return mcpError(err?.message ?? "invalid cursor");
					}
				}
				const effectiveLimit =
					limit === undefined ? undefined : clampLimit(limit);

				// S3.1.B Wave B — scope-aware filter replaces guardMasterOnly.
				// Master + legacy bearer pass through unchanged. Non-master clients
				// see only notes whose createdBy ∈ fromAllowList OR whose namespace
				// matches one of namespaceReadPrefixes (exact or '/' boundary) —
				// PLUS (Day 165, task k175ga65p654z200ydj7s8qv5s8cnxfc) notes they
				// are a `participants` member of, resolved server-side by the
				// Convex query via the by_participant_note index.
				// Absence is NOT master: an undefined oauthCtx must not resolve
				// `master=true` (which would send callerIdentities=undefined and let
				// Convex return the note unfiltered). isMasterScope(undefined) is
				// false, and a no-context caller falls to an EMPTY callerIdentities
				// list — the participant index then matches nothing (fail-closed).
				const master = isMasterScope(oauthCtx);
				const callerIdentities = master
					? undefined
					: (oauthCtx?.fromAllowList ?? []);
				// Tenant applied INSIDE the Convex read (`verifiedOrg`): the door reads
				// the caller's org-keyed index range only. A bearer whose org cannot
				// be resolved is refused here, before any read.
				const orgDenied = unresolvedOrgDenial("list_briefing_notes");
				if (orgDenied !== null) return orgDenied;
				const notes = await convex.query("briefingNotes:list" as any, {
					topic,
					limit: effectiveLimit ?? 20,
					fields: fields ?? "lite",
					updatedSince,
					createdBefore,
					master,
					callerIdentities,
					...doorScopeArgs("briefingNotes:list", undefined),
				});

				// scopeFilterList only discriminates on createdBy/namespace — it
				// has no notion of `participants`. OR it with an independent
				// participants re-check per row (passesBriefingNoteParticipantScope)
				// so notes the caller participates on but did not create stay
				// visible, without trusting Convex's decision blindly — real
				// defense-in-depth, same posture as before this fix.
				// A refusal is not an absence: say so BEFORE the `Array.isArray`
				// coalescing below turns the envelope into an empty array.
				if (isRefusedEnvelope(notes)) {
					return mcpRefused("list_briefing_notes", "briefingNotes:list");
				}
				const rawNotes = Array.isArray(notes) ? notes : [];
				const scopeFiltered = new Set(
					scopeFilterList(oauthCtx ?? DENIED_SCOPE_CTX, rawNotes as any[]),
				);
				const filteredNotes = rawNotes.filter(
					(n) =>
						scopeFiltered.has(n) ||
						passesBriefingNoteParticipantScope(oauthCtx, n as any),
				);

				// S3.3 B8 — emit nextCursor when the SCOPED READ's page is full (more
				// likely follows). Derived from the page Convex returned for this
				// caller's tenant (`rawNotes`), never from what survives the
				// narrowing filter above.
				const requestedLimit = effectiveLimit ?? 20;
				let nextCursor: string | null = null;
				if (rawNotes.length >= requestedLimit && rawNotes.length > 0) {
					const last = rawNotes[rawNotes.length - 1] as {
						_creationTime?: number;
					};
					if (typeof last._creationTime === "number") {
						nextCursor = encodeCursor({
							createdBefore: last._creationTime,
						});
					}
				}
				const notesWithCursor =
					nextCursor !== null
						? { items: filteredNotes, nextCursor }
						: filteredNotes;

				const capped = capListResponse(
					notesWithCursor,
					JSON.stringify(notesWithCursor, null, 2),
					"list_briefing_notes",
				);
				const text = appendMarkerIfEnabled(capped.text, () => {
					const items = filteredNotes;
					if (items.length === 0) return null;
					// Emit the first note as a briefing-note item for the primitive renderer.
					const first = items[0] as any;
					return {
						kind: "briefing-note",
						item: {
							_id: first._id,
							topic: first.topic,
							title: first.title,
							participants: first.participants,
							content: first.content,
							createdBy: first.createdBy,
						},
					};
				});

				return {
					content: [{ type: "text", text }],
					structuredContent: pageStructured(notesWithCursor, capped),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── search_briefing_notes_by_keyword ────────────────────────────────────────
	// Day 102 v2.11.0 — CRUD baseline PR-C-bis option B (mission k575kc1r).
	// BM25 keyword search over briefing note content. Backed by Convex
	// `briefingNotes:searchBriefingNotesByKeyword` using the `search_content` searchIndex.

	// oracle-justified: SEARCH vs list_briefing_notes' READ-LIST by design: this is a BM25 search_content searchIndex
	//   read with the tenant as an index predicate (convex/briefingNotes.ts:898-908) and an
	//   additional requireScope("view-own-tasks") gate (briefingNotes.ts:891), where
	//   briefingNotes:list drains the by_orgId / by_orgId_topic index range (briefingNotes.ts:598-607)
	//   with no requireScope. A keyword search is not a listing, so the verb, the retrieval mechanism and
	//   the extra gate are the real difference between the two tools.
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"search_briefing_notes_by_keyword",
		SEARCH_BRIEFING_NOTES_BY_KEYWORD_TOOL_DESCRIPTION,
		{
			query: z
				.string()
				.describe("The words to match against note content; exact terms work best."),
			topic: z.string().optional().describe("Keep only notes filed under this topic. Omit for every topic."),
			createdBy: z.string().optional().describe("Keep only notes written by this agent. Omit for every author."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many of the best matches come back; weaker matches beyond it are not returned."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.meta({ default: "lite" })
				.describe("How much of each match comes back: lite is each note's ID, title, topic, author, creation date and participants, without its content; full is every stored field."),
		},
		{
			outputSchema: searchBriefingNotesByKeywordServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Search briefing notes by keyword",
		},
		async ({ query, topic, createdBy, limit, fields }) => {
			try {
				// Day 165 (task k175ga65p654z200ydj7s8qv5s8cnxfc): thread caller
				// identity into the query so `participants` membership is honored
				// the same way as get_briefing_note/list_briefing_notes.
				// Absence is NOT master: an undefined oauthCtx must not resolve
				// `master=true` (which would send callerIdentities=undefined and let
				// Convex return the note unfiltered). isMasterScope(undefined) is
				// false, and a no-context caller falls to an EMPTY callerIdentities
				// list — the participant index then matches nothing (fail-closed).
				const master = isMasterScope(oauthCtx);
				const callerIdentities = master
					? undefined
					: (oauthCtx?.fromAllowList ?? []);
				// Tenant applied INSIDE the Convex read (`verifiedOrg`): the search
				// index is queried with the caller's org as an equality filter.
				const orgDenied = unresolvedOrgDenial("search_briefing_notes_by_keyword");
				if (orgDenied !== null) return orgDenied;
				const results = await convex.query(
					"briefingNotes:searchBriefingNotesByKeyword" as any,
					{
						query,
						topic,
						createdBy,
						limit: limit ?? 20,
						fields: fields ?? "lite",
						master,
						callerIdentities,
						...doorScopeArgs("briefingNotes:searchBriefingNotesByKeyword", undefined),
					},
				);
				// Day 141 fix (k17fyh3bqyh8ne1zd48sdee5958b2kk4): this query was
				// reached exclusively through the MCP server's fixed
				// service-account Clerk identity, which carries no per-caller
				// org — Convex's own withOrgScope() therefore resolves every
				// MCP call to the master branch and returns matches across
				// tenants. The MCP boundary must enforce isolation itself.
				// Mirrors the same scopeFilterList call already used by
				// list_briefing_notes (line ~5288) and scopeFilterGet used by
				// get_briefing_note (line ~5209) for this exact resource —
				// briefingNotes rows carry `createdBy`, which scopeFilterList
				// matches against oauthCtx.fromAllowList.
				//
				// Day 165: the Convex query now also authorizes `participants`
				// members within the tenant. scopeFilterList has no notion of
				// `participants`, so OR it with an independent per-row re-check
				// (passesBriefingNoteParticipantScope, using `participants` — kept
				// on lite results too, see convex/briefingNotes.ts) instead of
				// trusting Convex's decision blindly — real defense-in-depth,
				// same posture Day 141 relied on for tenant isolation here.
				const rawResults = Array.isArray(results) ? (results as any[]) : [];
				const scopeFiltered = new Set(
					scopeFilterList(oauthCtx ?? DENIED_SCOPE_CTX, rawResults),
				);
				const filteredResults = rawResults.filter(
					(r) =>
						scopeFiltered.has(r) ||
						passesBriefingNoteParticipantScope(oauthCtx, r),
				);
				return {
					content: [
						{ type: "text", text: JSON.stringify(filteredResults, null, 2) },
					],
					// The text stays the bare array; the object form of the same rows.
					structuredContent: arrayStructured(filteredResults),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── create_recurring_task ───────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "createdBy" },
		"create_recurring_task",
		"Create a recurring task template that auto-generates tasks on a cron schedule. " +
			"Returns { taskId, cronExpression }: taskId is the new template's ID (the recurringTaskId other recurring tools take). " +
			"WHEN: use for daily standups, weekly reviews, or any repeating work item pattern. " +
			"EXAMPLE: create_recurring_task title='Daily standup' assignedTo='alpha' priority='medium' cronExpression='0 9 * * *' createdBy='alpha'.",
		{
			title: z
				.string()
				.describe("The title every generated task gets."),
			description: z.string().optional().describe("The brief every generated task gets. Omit for title-only tasks."),
			assignedTo: assigneeSchema.describe("Who receives the generated tasks, by name; list_peers shows who exists."),
			priority: z
				.enum(["urgent", "high", "medium", "low"])
				.describe("How urgent each generated task is for its assignee: urgent work comes before low in their queue."),
			project: z.string().optional().describe("The project every generated task belongs to. Omit for none."),
			tags: flexArray.optional().describe("Labels copied onto each generated task, e.g. ['standup']; a 'review' tag lets a previous assignee reclaim the task. Omit for none."),
			cronExpression: z
				.string()
				.describe("When a task is generated, as a standard five-field cron (minute hour day-of-month month day-of-week), e.g. " +
					"'0 9 * * *' for 09:00 every day."),
			createdBy: creatorSchema.describe("The agent this call writes as, recorded as the template's author (e.g. 'sigma'). " +
				"Omit it when your credential resolves one agent: it is then that agent. Otherwise omitting it is refused."),
		},
		{
			outputSchema: createRecurringTaskServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Create recurring task",
		},
		async ({
			title,
			description,
			assignedTo,
			priority,
			project,
			tags,
			cronExpression,
			createdBy,
		}) => {
			try {
				const assigneeDenied = await guardDelegation(assignedTo);
				if (assigneeDenied) return assigneeDenied;

				const tagsArray = tags
					? Array.isArray(tags)
						? tags
						: [tags]
					: undefined;
				const taskId = await convex.mutation("recurringTasks:create" as any, {
					title,
					description,
					assignedTo,
					priority,
					project,
					tags: tagsArray,
					cronExpression,
					createdBy,
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { taskId, cronExpression };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── list_recurring_tasks ────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"list_recurring_tasks",
		"List recurring task templates filtered by assignee or active status, newest first. " +
			"Returns { items, nextCursor, truncated, scopeFiltered? }: items are recurring templates, newest first; nextCursor is the next page's cursor, null on the last page; scopeFiltered counts rows withheld by scope; truncated is true when the 60 KB response cap cut the page (nextCursor is then null). The text is the bare JSON array of the templates, or { items, nextCursor?, scopeFiltered? } when another page exists or rows were withheld. " +
			"WHEN: use to audit which schedules are active or find templates to pause/resume/update. " +
			"Each row also reports one-open-instance state: lastTaskId (task made by the last run), skippedRuns (consecutive ticks skipped because that task was still open), lastSkippedAt, lastSkipReason. " +
			"EXAMPLE: list_recurring_tasks assignedTo='beta' active=true limit=20.",
		{
			assignedTo: assigneeSchema.optional().describe("Keep only templates whose tasks go to this orchestrator. Omit for every assignee."),
			active: z.boolean().optional().describe("true keeps running templates, false keeps paused ones. Omit for both."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.meta({ deprecated: true })
				.describe("Has no effect on this tool: every row comes back whole, with every stored field, whichever value is sent. Accepted only so that a client which sends it is not refused; leave it out."),
			cursor: z
				.string()
				.optional()
				.describe(
					"The nextCursor value a previous list_recurring_tasks call returned, to fetch the following (older) page. " +
						"Omit for the first page.",
				),
		},
		{
			outputSchema: listRecurringTasksServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List recurring tasks",
		},
		async ({ assignedTo, active, limit, fields, cursor }) => {
			try {
				// S3.3 B8 follow-up — decode opaque cursor → createdBefore anchor.
				let createdBefore: number | undefined;
				if (cursor !== undefined && cursor !== "") {
					try {
						const decoded = decodeCursor(cursor);
						if (decoded && "createdBefore" in decoded) {
							createdBefore = decoded.createdBefore;
						}
					} catch (err: any) {
						return mcpError(err?.message ?? "invalid cursor");
					}
				}
				const effectiveLimit =
					limit === undefined ? undefined : clampLimit(limit);

				// S3.1.C2 — scope-aware filter replaces guardMasterOnly.
				const tasks = await convex.query("recurringTasks:list" as any, {
					assignedTo,
					active,
					limit: effectiveLimit ?? 20,
					fields: fields ?? "lite",
					createdBefore,
				});
				const filteredTasks = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					Array.isArray(tasks) ? tasks : [],
				);

				// S3.3 B8 follow-up — emit nextCursor when page is full.
				// Measured on the RAW page, before the scope filter narrowed it.
				const requestedLimit = effectiveLimit ?? 20;
				const { nextCursor, scopeFiltered } = scopedPageContinuation(
					Array.isArray(tasks) ? tasks : [],
					requestedLimit,
					filteredTasks.length,
					{ reportRemoved: oauthCtx?.clerkOrgSlug !== undefined },
				);
				const tasksWithCursor =
					nextCursor !== null || scopeFiltered > 0
						? {
								items: filteredTasks,
								...(nextCursor !== null ? { nextCursor } : {}),
								...(scopeFiltered > 0 ? { scopeFiltered } : {}),
							}
						: filteredTasks;

				const capped = capListResponse(
					tasksWithCursor,
					JSON.stringify(tasksWithCursor, null, 2),
					"list_recurring_tasks",
				);
				return {
					content: [{ type: "text", text: capped.text }],
					structuredContent: pageStructured(tasksWithCursor, capped),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── pause_recurring_task ────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "public",
			reason:
				"decided by its Convex door recurringTasks:pause (authorizeScheduleActor) on the acting agent resolved BY ID from the credential (verifiedActor, forwarded by the wrapped client): the schedule's creator or assignee, in the schedule's own organisation; the tool takes no acting name and relays the door's refusal unchanged (task k170ahhzv5dsczsgsh20mr4fah8hfbk4)",
		},
		"pause_recurring_task",
		"Pause a recurring task template to stop auto-creating tasks until explicitly resumed. " +
			"Returns { taskId, active: false }. WHEN: use during holidays, freezes, or when the assignee is unavailable for a period. " +
			"EXAMPLE: pause_recurring_task taskId='j57aaaaa...'.",
		{
			taskId: recurringTaskIdSchema.describe("The recurring template: its ID as returned by create_recurring_task or list_recurring_tasks."),
		},
		{
			outputSchema: pauseRecurringTaskServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Pause recurring task",
		},
		async ({ taskId }) => {
			// Who may act is the Convex door's decision, on the forwarded agent ID;
			// no MCP-side re-decision. Absence is never served.
			const unresolved = guardResolvedCaller("pause_recurring_task");
			if (unresolved) return unresolved;
			try {
				const result = await convex.mutation("recurringTasks:pause" as any, {
					taskId: taskId as any,
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = result;
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── resume_recurring_task ───────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "public",
			reason:
				"decided by its Convex door recurringTasks:resume (authorizeScheduleActor) on the acting agent resolved BY ID from the credential (verifiedActor, forwarded by the wrapped client): the schedule's creator or assignee, in the schedule's own organisation; the tool takes no acting name and relays the door's refusal unchanged (task k170ahhzv5dsczsgsh20mr4fah8hfbk4)",
		},
		"resume_recurring_task",
		"Resume a paused recurring task template and recalculate its next scheduled run time. " +
			"Returns { taskId, active: true, nextRunAt }. " +
			"WHEN: use after a pause period ends to re-enable automatic task generation. " +
			"EXAMPLE: resume_recurring_task taskId='j57aaaaa...'.",
		{
			taskId: recurringTaskIdSchema.describe("The recurring template: its ID as returned by create_recurring_task or list_recurring_tasks."),
		},
		{
			outputSchema: resumeRecurringTaskServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Resume recurring task",
		},
		async ({ taskId }) => {
			// Who may act is the Convex door's decision, on the forwarded agent ID;
			// no MCP-side re-decision. Absence is never served.
			const unresolved = guardResolvedCaller("resume_recurring_task");
			if (unresolved) return unresolved;
			try {
				const result = await convex.mutation("recurringTasks:resume" as any, {
					taskId: taskId as any,
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = result;
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── delete_recurring_task ───────────────────────────────────────────────────

	// oracle-justified: a hard DELETE where pause_recurring_task is an active=false TRANSITION on the same row;
	//   both doors read memberWriterRoles through resolveHumanActor (convex/lib/humanActor.ts), but
	//   recurringTasks:remove also requires org:admin for a human and, for an agent, the CREATOR by ID
	//   (adminOnly, authorizeScheduleActor), because a deleted schedule cannot be restored.
	defineTool(
		server,
		authCtx,
		{
			kind: "public",
			reason:
				"decided by its Convex door recurringTasks:remove (authorizeScheduleActor, adminOnly) on the acting agent resolved BY ID from the credential (verifiedActor, forwarded by the wrapped client): the schedule's creator only, in the schedule's own organisation; the tool takes no acting name and relays the door's refusal unchanged (task k170ahhzv5dsczsgsh20mr4fah8hfbk4)",
		},
		"delete_recurring_task",
		"Permanently delete a recurring task template, stopping all future scheduled task generation. " +
			"Returns { deleted: true }. WHEN: use when a recurring process is retired and should never generate tasks again. " +
			"EXAMPLE: delete_recurring_task taskId='j57aaaaa...'.",
		{
			taskId: recurringTaskIdSchema.describe("The recurring template: its ID as returned by create_recurring_task or list_recurring_tasks."),
		},
		{
			outputSchema: deletedServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: true,
			title: "Delete recurring task",
		},
		async ({ taskId }) => {
			// Who may act is the Convex door's decision, on the forwarded agent ID;
			// no MCP-side re-decision. Absence is never served.
			const unresolved = guardResolvedCaller("delete_recurring_task");
			if (unresolved) return unresolved;
			try {
				const result = await convex.mutation("recurringTasks:remove" as any, {
					taskId: taskId as any,
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = result;
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── update_recurring_task ───────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"target recurring-task row is fetched (recurringTasks:getById) and passed through scopeFilterGet(oauthCtx,...) BEFORE the mutation: a row outside the caller's scope collapses to null and the update is DENIED (cross-scope mutation refused). guardDelegation still gates any NEW assignee, but scopeFilterGet is what binds the mutation to the caller's own row (k17fcxngeyrfpsh8xrp0fzz9xh8dfkq8)",
		},
		"update_recurring_task",
		"Update a recurring task template's fields; cronExpression change auto-recalculates nextRunAt. " +
			"Returns { recurringTaskId, updated: true }. " +
			"WHEN: use to change assignee, schedule, or priority of an active recurring template. " +
			"EXAMPLE: update_recurring_task recurringTaskId='j57aaaaa...' cronExpression='0 10 * * 1' priority='high'.",
		{
			recurringTaskId: recurringTaskIdSchema.describe(
				"The recurring template: its ID as returned by create_recurring_task or list_recurring_tasks.",
			),
			title: z.string().optional().describe("A new title for future tasks. Omit to keep it."),
			description: z.string().optional().describe("A new brief for future tasks. Omit to keep it."),
			assignedTo: creatorSchema.optional().describe("Who receives the tasks generated from now on, by agent name as list_peers shows it under name (not an agent ID); tasks already generated keep their assignee. Omit to keep it."),
			priority: prioritySchema.optional().describe("A new priority for future tasks. Omit to keep it."),
			project: z.string().optional().describe("The billing line each task generated from now on carries: the project name create_recurring_task took, the same value create_task's project takes. Tasks already generated keep theirs. Omit to keep it."),
			tags: z.array(z.string()).optional().describe("The complete new tag list for future tasks, replacing the current one. Omit to keep it."),
			cronExpression: z
				.string()
				.optional()
				.describe("A new five-field cron schedule, e.g. '0 10 * * 1'; the next run time is recomputed. Omit to keep the schedule."),
		},
		{
			outputSchema: updateRecurringTaskServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Update recurring task",
		},
		async ({ recurringTaskId, ...fields }) => {
			try {
				// IDENTITY-FIRST ordering (Eta REVISE, ETA-M15). The scope guard
				// below (recurringTasks:getById then scopeFilterGet) must NEVER
				// answer ahead of identity resolution: a caller with no verified
				// identity must get the LOUD identity refusal ("cannot be resolved /
				// no verified Clerk session"), not a SCOPE outcome ("not found or
				// not in your scope") for a request that never had a resolvable
				// principal. So we resolve identity and refuse loudly FIRST -- the
				// same order list_tasks and the other filtered doors use -- THEN
				// fetch the row and apply the cross-scope mutation guard. Denial is
				// unchanged in both poles; only which refusal speaks first changes.
				if (fields.assignedTo) {
					const assigneeDenied = await guardDelegation(fields.assignedTo);
					if (assigneeDenied) return assigneeDenied;
				}

				// k17fcxngeyrfpsh8xrp0fzz9xh8dfkq8 — cross-scope mutation guard.
				// Before mutating, fetch the target recurring-task row and verify it
				// is within the caller's scope. Recurring rows carry `createdBy` and
				// `assignedTo` (convex/recurringTasks.ts), so a non-master caller
				// must own or be assigned the template. scopeFilterGet collapses an
				// out-of-scope row to null → we DENY with a non-leaky refusal rather
				// than let the mutation touch another scope's template.
				const existing = await convex.query("recurringTasks:getById" as any, {
					recurringTaskId,
				});
				if (existing == null) {
					return mcpError(
						`Forbidden: update_recurring_task target ${recurringTaskId} not found or not in your scope.`,
					);
				}
				const scoped = scopeFilterGet(
					oauthCtx ?? DENIED_SCOPE_CTX,
					existing as Record<string, unknown>,
					["assignedTo"],
				);
				if (scoped == null) {
					return mcpError(
						`Forbidden: update_recurring_task cannot modify ${recurringTaskId} — the recurring task is outside your scope (cross-scope mutation refused).`,
					);
				}

				// Ownership is decided by the Convex door on the forwarded agent ID
				// (recurringTasks:update, verifiedActor); the name allowlist above only
				// narrows what this tool dispatches.

				const result = await convex.mutation("recurringTasks:update" as any, {
					recurringTaskId: recurringTaskId as any,
					...fields,
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { recurringTaskId: result, updated: true };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── create_mandate ──────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "requestedBy" },
		"create_mandate",
		"Create a cross-orchestrator service mandate with agreed token budget and spending limits. " +
			"WHEN: use when one orchestrator commissions work from another with formal budget accountability. " +
			"EXAMPLE: create_mandate requestedBy='alpha' fulfilledBy='beta' service='code review' budget=5000.",
		{
			requestedBy: creatorSchema.describe("Orchestrator who needs the service"),
			fulfilledBy: creatorSchema.describe(
				"Orchestrator who will provide the service",
			),
			fulfilledByAgentId: z
				.string()
				.min(1)
				.optional()
				.describe(
					"The fulfiller BY AGENT ID (agent ID as returned by list_peers agentId). Optional, sent beside fulfilledBy: the ID alone decides, and an ID that is not an active agent of the operator organisation is refused.",
				),
			service: z.string().describe("Description of what service is needed"),
			budget: z.number().describe("Token budget allocated for this mandate"),
			spendingLimits: z
				.object({
					maxPerTransaction: z.number(),
					maxPerPeriod: z.number(),
					periodDays: z.number().optional(),
				})
				.optional()
				.describe("AP2 spending limits"),
			approvedCategories: z
				.array(z.string())
				.optional()
				.describe("Approved service categories"),
			mandateDocument: z
				.string()
				.optional()
				.describe("Signed authorization document or reference"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Create mandate",
		},
		async ({
			requestedBy,
			fulfilledBy,
			fulfilledByAgentId,
			service,
			budget,
			spendingLimits,
			approvedCategories,
			mandateDocument,
		}) => {
			try {
				const fulfillerDenied = await guardAssignee("fulfilledBy", fulfilledBy);
				if (fulfillerDenied) return fulfillerDenied;

				const mandateId = await convex.mutation("mandates:create" as any, {
					requestedBy,
					fulfilledBy,
					...(fulfilledByAgentId !== undefined ? { fulfilledByAgentId } : {}),
					service,
					budget,
					spendingLimits,
					approvedCategories,
					mandateDocument,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ mandateId, requestedBy, fulfilledBy, service, budget },
								null,
								2,
							),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── accept_mandate ──────────────────────────────────────────────────────────

	// oracle-justified: a state TRANSITION whose actor argument is callerOrchestrator (create_mandate binds
	//   requestedBy), actor-bound `from`; list_mandates is an in-handler-filtered read that serves the
	//   fleet master only and answers a member with a refused envelope; every mandate write is
	//   master-only at the Convex door (requireFleetMaster, convex/mandates.ts).
	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"accept_mandate",
		"Accept a mandate by the fulfilledBy orchestrator, advancing status from requested to accepted. " +
			"WHEN: call when the fulfiller confirms they can deliver the service within the agreed budget. " +
			"EXAMPLE: accept_mandate mandateId='j57aaaaa...' callerOrchestrator='beta'.",
		{
			mandateId: mandateIdSchema.describe(
				"Convex document ID of the mandate to accept",
			),
			// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
			callerOrchestrator: creatorSchema.describe(
				"Must be the fulfilledBy orchestrator or system",
			),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Accept mandate",
		},
		async ({ mandateId, callerOrchestrator }) => {
			try {
				await convex.mutation("mandates:accept" as any, {
					mandateId: mandateId as any,
					callerOrchestrator,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ mandateId, status: "accepted" }, null, 2),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── update_mandate ──────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"update_mandate",
		"Update a mandate's status, tokensCost, or linkedTaskIds; only fulfilledBy or system may update. " +
			"WHEN: use to record spend progress, link created tasks, or advance status to delivered. " +
			"EXAMPLE: update_mandate mandateId='j57aaaaa...' callerOrchestrator='beta' tokensCost=1200 status='delivered'.",
		{
			mandateId: mandateIdSchema.describe(
				"Convex document ID of the mandate to update",
			),
			// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
			callerOrchestrator: creatorSchema.describe(
				"Must be the fulfilledBy orchestrator or system",
			),
			status: mandateStatusSchema.optional().describe("New status"),
			tokensCost: z.number().optional().describe("Tokens consumed so far"),
			linkedTaskIds: z
				.array(z.string())
				.optional()
				.describe("Task IDs created to fulfill this mandate"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Update mandate",
		},
		async ({
			mandateId,
			callerOrchestrator,
			status,
			tokensCost,
			linkedTaskIds,
		}) => {
			try {
				await convex.mutation("mandates:update" as any, {
					mandateId: mandateId as any,
					callerOrchestrator,
					status,
					tokensCost,
					linkedTaskIds: linkedTaskIds as any,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ mandateId, updated: true }, null, 2),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── settle_mandate ──────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"settle_mandate",
		"Settle a mandate by confirming delivery and recording the final token cost; sets status to settled. " +
			"WHEN: call after verifying the delivered work meets the mandate scope — closes the billing cycle. " +
			"EXAMPLE: settle_mandate mandateId='j57aaaaa...' callerOrchestrator='alpha' finalCost=4800.",
		{
			mandateId: mandateIdSchema.describe(
				"Convex document ID of the mandate to settle",
			),
			// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
			callerOrchestrator: creatorSchema.describe(
				"Must be the requestedBy orchestrator or system",
			),
			finalCost: z.number().describe("Final actual token cost to record"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Settle mandate",
		},
		async ({ mandateId, callerOrchestrator, finalCost }) => {
			try {
				await convex.mutation("mandates:settle" as any, {
					mandateId: mandateId as any,
					callerOrchestrator,
					finalCost,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ mandateId, status: "settled", finalCost },
								null,
								2,
							),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── validate_mandate_spending ───────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "public",
			reason:
				"stateless spend-limit validation keyed on a caller-supplied mandateId; no cross-tenant enumeration",
		},
		"validate_mandate_spending",
		"Check whether a proposed token spend is within a mandate's AP2 spending limits. " +
			"WHEN: call before each service transaction to prevent over-spend and get within/exceeded status. " +
			"EXAMPLE: validate_mandate_spending mandateId='j57aaaaa...' proposedAmount=500.",
		{
			mandateId: mandateIdSchema.describe("Mandate ID to validate against"),
			proposedAmount: z
				.number()
				.describe("Proposed token spend amount to validate"),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Validate mandate spending",
		},
		async ({ mandateId, proposedAmount }) => {
			const orgDenied = unresolvedOrgDenial("validate_mandate_spending");
			if (orgDenied !== null) return orgDenied;
			try {
				const result = await convex.query("mandates:validateSpending" as any, {
					mandateId: mandateId as any,
					proposedAmount,
					...doorScopeArgs("mandates:validateSpending", undefined),
				});
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── debate_post_turn ────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "public",
			reason:
				"the caller is derived by Convex from the credential (verifiedActor, forwarded by the wrapped client) and judged against the room's own participant list at the door; the tool takes no acting name",
		},
		"debate_post_turn",
		"Post your answer to the debate-room turn you were asked for; the only way a turn enters a room. " +
			"Returns { accepted: true, turnSeq, closed, closeReason? } when the turn is recorded. " +
			"WHEN: the [DEBATE-TURN] message in your inbox asks for it, exactly once per turnSeq, then mark that message read. " +
			"EXAMPLE: debate_post_turn roomId='<roomId from the message>' turnSeq=3 text='...' done=false. " +
			"A refusal (not_your_turn, stale_turn, too_long, room_closed, ...) is returned as an error result, never as a success.",
		{
			roomId: debateRoomIdSchema.describe("The room: the roomId carried by the [DEBATE-TURN] message in your inbox."),
			turnSeq: z
				.number()
				.int()
				.min(1)
				.describe("The turn number the [DEBATE-TURN] message gives; a turn that has already moved on is refused."),
			text: z.string().describe("Your answer for this turn, within the character limit the message states."),
			done: z
				.boolean()
				.optional()
				.describe("Set true when you have nothing more to add; the room closes once every agent says so in one round. " +
					"Omit it (false) to keep the debate going."),
		},
		{
			readOnlyHint: false,
			idempotentHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Post a debate-room turn",
		},
		async ({ roomId, turnSeq, text, done }) => {
			try {
				const result = (await convex.mutation("debate:postTurn" as any, {
					roomId: roomId as any,
					turnSeq,
					text,
					...(done !== undefined ? { done } : {}),
				})) as
					| { refused: string; awaiting: string | null; turnSeq: number }
					| { accepted: true; turnSeq: number; closed: boolean };
				if ("refused" in result) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									`REFUSED (${result.refused}): the turn was not recorded. ` +
									`The room is at turnSeq ${result.turnSeq}, awaiting ${result.awaiting ?? "nobody"}.`,
							},
						],
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── debate_get_room ─────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "public",
			reason:
				"the caller is derived by Convex from the credential (verifiedActor) and served only a room it created or is a listed participant of; any other room answers like a missing one",
		},
		"debate_get_room",
		"Read a debate room: its subject, frozen template, pointer and the full transcript. Read-only. " +
			"Returns { room, turns }: the room (subject, frozen template, status, whose turn it is) and every turn in order; a room you are not part of returns a ROOM NOT AVAILABLE error, never an empty room. " +
			"WHEN: the [DEBATE-TURN] message says earlier turns were omitted, or you need the whole transcript. " +
			"EXAMPLE: debate_get_room roomId='<roomId from the message>'.",
		{
			roomId: debateRoomIdSchema.describe("The room: the roomId carried by the [DEBATE-TURN] message in your inbox."),
		},
		{
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get a debate room",
		},
		async ({ roomId }) => {
			try {
				const result = await convex.query("debate:getRoom" as any, {
					roomId: roomId as any,
				});
				if (result === null) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									"ROOM NOT AVAILABLE: no room with this id is visible to the caller " +
									"(it does not exist, or the caller is neither its operator nor a listed participant). This is not an empty room.",
							},
						],
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── list_mandates ───────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"list_mandates",
		"List mandates filtered by requestedBy, fulfilledBy, or status, newest first with cursor paging. " +
			"WHEN: use to audit active service agreements or track billing between orchestrator pairs. " +
			"EXAMPLE: list_mandates requestedBy='alpha' status='in_progress' limit=20. " +
			"Default limit 20. cap 200.",
		{
			requestedBy: creatorSchema
				.optional()
				.describe("Filter by the orchestrator who requested the service"),
			fulfilledBy: creatorSchema
				.optional()
				.describe("Filter by the orchestrator providing the service"),
			status: mandateStatusSchema
				.optional()
				.describe("Filter by mandate status"),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.describe("Max items to return. Default 20 (envelope-safe). Cap 200."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.describe(
					"How much of each row comes back: by default every stored field; with lite, a compact projection for fewer tokens. Omit for every field.",
				),
			cursor: z
				.string()
				.optional()
				.describe(
					"S3.3 B8 follow-up — opaque pagination cursor from a prior call's `nextCursor`. " +
						"Decoded to `createdBefore` (newest-first forward pagination).",
				),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List mandates",
		},
		async ({ requestedBy, fulfilledBy, status, limit, fields, cursor }) => {
			try {
				// S3.3 B8 follow-up — decode opaque cursor → createdBefore anchor.
				let createdBefore: number | undefined;
				if (cursor !== undefined && cursor !== "") {
					try {
						const decoded = decodeCursor(cursor);
						if (decoded && "createdBefore" in decoded) {
							createdBefore = decoded.createdBefore;
						}
					} catch (err: any) {
						return mcpError(err?.message ?? "invalid cursor");
					}
				}
				const effectiveLimit =
					limit === undefined ? undefined : clampLimit(limit);

				// S3.1.C2 — scope-aware filter replaces guardMasterOnly.
				const mandates = await convex.query("mandates:list" as any, {
					requestedBy,
					fulfilledBy,
					status,
					limit: effectiveLimit ?? 20,
					fields: fields ?? "lite",
					createdBefore,
				});
				// A refusal is not an absence: say so BEFORE the `Array.isArray`
				// coalescing below turns the envelope into an empty array.
				if (isRefusedEnvelope(mandates)) {
					return mcpRefused("list_mandates", "mandates:list");
				}
				// k177617dqg6z5c099p1rdp5rqn8b2rp0 / k174y9ra7pp8zed3bcczk6xaed8cpynp —
				// mandates rows carry `requestedBy` AND `fulfilledBy` (schema.ts
				// creatorValidator), NOT `createdBy`/`namespace`. cloud-identity
				// 0.5.0's `grantFields` declares both as per-row grants directly —
				// no createdBy-remap + union-by-_id workaround needed: either
				// party to the mandate is a named grantee, consulted in one pass.
				const mandateRows = Array.isArray(mandates) ? mandates : [];
				const filteredMandates = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					mandateRows as Array<Record<string, unknown>>,
					["requestedBy", "fulfilledBy"],
				);

				// S3.3 B8 follow-up — emit nextCursor when page is full.
				// Measured on the RAW page, before the scope filter narrowed it.
				const requestedLimit = effectiveLimit ?? 20;
				const { nextCursor, scopeFiltered } = scopedPageContinuation(
					mandateRows,
					requestedLimit,
					filteredMandates.length,
					{ reportRemoved: oauthCtx?.clerkOrgSlug !== undefined },
				);
				const mandatesWithCursor =
					nextCursor !== null || scopeFiltered > 0
						? {
								items: filteredMandates,
								...(nextCursor !== null ? { nextCursor } : {}),
								...(scopeFiltered > 0 ? { scopeFiltered } : {}),
							}
						: filteredMandates;

				return {
					content: [
						{
							type: "text",
							text: capListResponseBytes(
								mandatesWithCursor,
								JSON.stringify(mandatesWithCursor, null, 2),
								"list_mandates",
							),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── create_bu ───────────────────────────────────────────────────────────────

	// oracle-justified: business units are roster-scoped, not tenant-split: create, update and list admit a member only
	//   for orchestrators on its own client_org_mapping roster (isOrchestratorAllowedForScope in
	//   convex/businessUnits.ts); only businessUnits:remove (delete_bu) is master-only, which is why
	//   this table's write tiers are not one tier.
	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "orchestratorId" },
		"create_bu",
		"Create a new business unit with strategy, business model, team composition, and KPIs. " +
			"WHEN: use when launching a new revenue line or formalizing an existing product unit. " +
			"EXAMPLE: create_bu name='VantagePeers' orchestratorId='alpha' status='building' purpose='...' businessModel='...' targetCustomers='...' services=['MCP'] pricing='...' revenueProjections={y1:0,y2:50000,y3:200000} coreTeam={agents:['alpha'],skills:[],hooks:[],plugins:[]} coreProcesses=['...'] dependencies=[] kpis=['ARR'].",
		{
			name: z.string().describe("Business unit name — e.g. 'VantagePeers'"),
			description: z.string().describe("Short description of the BU"),
			purpose: z.string().describe("Why this BU exists — strategic purpose"),
			domain: z
				.string()
				.optional()
				.describe("Primary domain — e.g. 'vantagepeers.com'"),
			orchestratorId: z
				.string()
				.describe("Lead orchestrator managing this BU — e.g. 'sigma'"),
			status: buStatusSchema,
			businessModel: z.string().describe("How this BU makes money"),
			targetCustomers: z.string().describe("Who the customers are"),
			services: flexArray.describe("List of services offered"),
			pricing: z.string().describe("Pricing model description"),
			revenueProjections: revenueProjectionsSchema,
			coreTeam: coreTeamSchema,
			coreProcesses: flexArray.describe("Core operational processes"),
			dependencies: flexArray.describe("Other BU names this BU depends on"),
			kpis: flexArray.describe("Key performance indicators"),
			managementFee: z
				.number()
				.optional()
				.default(10)
				.describe("Management fee percentage (default 10)"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Create BU",
		},
		async ({
			name,
			description,
			purpose,
			domain,
			orchestratorId,
			status,
			businessModel,
			targetCustomers,
			services,
			pricing,
			revenueProjections,
			coreTeam,
			coreProcesses,
			dependencies,
			kpis,
			managementFee,
		}) => {
			try {
				// The door acts for the bearer's VERIFIED org (`verifiedOrg`), never as
				// the fleet; a bearer whose org cannot be resolved is refused here.
				const orgDenied = unresolvedOrgDenial("create_bu");
				if (orgDenied !== null) return orgDenied;
				const buId = await convex.mutation("businessUnits:create" as any, {
					...doorScopeArgs("businessUnits:create", undefined),
					name,
					description,
					purpose,
					domain,
					orchestratorId,
					status,
					businessModel,
					targetCustomers,
					services: toArray(services) as string[],
					pricing,
					revenueProjections,
					coreTeam,
					coreProcesses: toArray(coreProcesses) as string[],
					dependencies: toArray(dependencies) as string[],
					kpis: toArray(kpis) as string[],
					managementFee: managementFee ?? 10,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ buId, name, orchestratorId, status },
								null,
								2,
							),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── update_bu ───────────────────────────────────────────────────────────────

	// oracle-justified: business units are roster-scoped, not tenant-split: create, update and list admit a member only
	//   for orchestrators on its own client_org_mapping roster (isOrchestratorAllowedForScope in
	//   convex/businessUnits.ts); only businessUnits:remove (delete_bu) is master-only, which is why
	//   this table's write tiers are not one tier.
	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"update_bu",
		"Update any mutable field on a business unit; only provided fields are patched, updatedAt auto-set. " +
			"WHEN: use to update status, revenue projections, or team composition as the BU evolves. RBAC: caller must be the BU's owning orchestrator or 'system'. " +
			"EXAMPLE: update_bu buId='j57aaaaa...' callerOrchestrator='alpha' status='live' revenueProjections={y1:10000,y2:80000,y3:300000}.",
		{
			buId: buIdSchema.describe(
				"Convex document ID of the business unit to update",
			),
			// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
			callerOrchestrator: creatorSchema.describe(
				"Orchestrator identity making this call — must match the BU's owning orchestratorId or be 'system' (RBAC deny-by-default, checked against the target row, not the caller's claim alone)",
			),
			name: z.string().optional().describe("New name"),
			description: z.string().optional().describe("New description"),
			purpose: z.string().optional().describe("New purpose"),
			domain: z.string().optional().describe("New domain"),
			orchestratorId: z.string().optional().describe("New lead orchestrator"),
			status: buStatusSchema.optional().describe("New status"),
			businessModel: z.string().optional().describe("New business model"),
			targetCustomers: z.string().optional().describe("New target customers"),
			services: flexArrayOptional.describe("New services list"),
			pricing: z.string().optional().describe("New pricing model"),
			revenueProjections: revenueProjectionsSchema
				.optional()
				.describe("Updated revenue projections"),
			coreTeam: coreTeamSchema.optional().describe("Updated core team"),
			coreProcesses: flexArrayOptional.describe("New core processes"),
			dependencies: flexArrayOptional.describe("New dependencies"),
			kpis: flexArrayOptional.describe("New KPIs"),
			managementFee: z.number().optional().describe("New management fee %"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Update BU",
		},
		async ({
			buId,
			callerOrchestrator,
			name,
			description,
			purpose,
			domain,
			orchestratorId,
			status,
			businessModel,
			targetCustomers,
			services,
			pricing,
			revenueProjections,
			coreTeam,
			coreProcesses,
			dependencies,
			kpis,
			managementFee,
		}) => {
			try {
				const orgDenied = unresolvedOrgDenial("update_bu");
				if (orgDenied !== null) return orgDenied;
				if (orchestratorId) {
					const leadDenied = await guardAssignee(
						"orchestratorId",
						orchestratorId,
					);
					if (leadDenied) return leadDenied;
				}

				await convex.mutation("businessUnits:update" as any, {
					...doorScopeArgs("businessUnits:update", undefined),
					buId: buId as any,
					callerOrchestrator,
					name,
					description,
					purpose,
					domain,
					orchestratorId,
					status,
					businessModel,
					targetCustomers,
					services: toArray(services),
					pricing,
					revenueProjections,
					coreTeam,
					coreProcesses: toArray(coreProcesses),
					dependencies: toArray(dependencies),
					kpis: toArray(kpis),
					managementFee,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ buId, updated: true }, null, 2),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_bu ──────────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"get_bu",
		"Fetch a single business unit by Convex document ID, returning null if not found. " +
			"WHEN: use before updating or reporting on a BU to get the current canonical state. " +
			"EXAMPLE: get_bu buId='j57dy3049btafda9m2f5d2ggk987ph3f'.",
		{
			buId: buIdSchema.describe("Convex document ID of the business unit"),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get BU",
		},
		async ({ buId }) => {
			try {
				// S3.1.C2 — scope-aware filter replaces guardMasterOnly.
				// k177617dqg6z5c099p1rdp5rqn8b2rp0 — same remap as list_bus above:
				// businessUnits rows carry `orchestratorId`, not `createdBy`/
				// `namespace`; unmapped this refused the lead orchestrator too.
				const orgDenied = unresolvedOrgDenial("get_bu");
				if (orgDenied !== null) return orgDenied;
				const bu = (await convex.query("businessUnits:get" as any, {
					buId: buId as any,
					...doorScopeArgs("businessUnits:get", undefined),
				})) as (Record<string, unknown> & { orchestratorId?: string }) | null;
				const filteredBu = bu
					? scopeFilterGet(oauthCtx ?? DENIED_SCOPE_CTX, {
							...bu,
							createdBy: bu.orchestratorId,
						})
					: null;
				if (filteredBu) {
					delete (filteredBu as Record<string, unknown>).createdBy;
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(filteredBu, null, 2),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── list_bus ────────────────────────────────────────────────────────────────

	// oracle-justified: rows are filtered by the same isOrchestratorAllowedForScope roster predicate the create and
	//   update writes use (convex/businessUnits.ts); the only write a roster does not admit a member to
	//   is businessUnits:remove (delete_bu), which is master-only.
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"list_bus",
		LIST_BUS_TOOL_DESCRIPTION,
		{
			orchestratorId: z
				.string()
				.optional()
				.describe("Filter by lead orchestrator — e.g. 'sigma'"),
			status: buStatusSchema.optional().describe("Filter by status"),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.describe("Max items to return. Default 20 (envelope-safe). Cap 200."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.describe(
					"How much of each row comes back: by default every stored field; with lite, a compact projection for fewer tokens. Omit for every field.",
				),
			cursor: z
				.string()
				.optional()
				.describe(
					"Opaque pagination cursor from a prior call's `nextCursor` (newest-first forward pagination).",
				),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List BUs",
		},
		async ({ orchestratorId, status, limit, fields, cursor }) => {
			try {
				// Decode opaque cursor → createdBefore anchor (legacy paging.ts format).
				// Invalid cursor surfaces as user-facing error (no crash).
				let createdBefore: number | undefined;
				if (cursor !== undefined && cursor !== "") {
					try {
						const decoded = decodeCursor(cursor);
						if (decoded && "createdBefore" in decoded) {
							createdBefore = decoded.createdBefore;
						}
					} catch (err: any) {
						return mcpError(err?.message ?? "invalid cursor");
					}
				}
				const effectiveLimit = limit === undefined ? 20 : clampLimit(limit);

				// Scope applied INSIDE the Convex read (`verifiedOrg`): the door reads
				// only the index ranges of the orchestrators on the caller's org
				// roster, so a foreign unit never occupies a slot of the page. A
				// bearer whose org cannot be resolved is refused here, before any read.
				const orgDenied = unresolvedOrgDenial("list_bus");
				if (orgDenied !== null) return orgDenied;
				// S3.1.C2 — scope-aware filter replaces guardMasterOnly.
				// Convex query now returns { items, nextCursor } envelope (PR-A).
				const envelope = await convex.query("businessUnits:list" as any, {
					orchestratorId,
					status,
					limit: effectiveLimit,
					fields: fields ?? "full",
					createdBefore,
					...doorScopeArgs("businessUnits:list", undefined),
				});
				const rawItems = (
					envelope && typeof envelope === "object" && "items" in envelope
						? (envelope as { items: unknown[] }).items
						: Array.isArray(envelope)
							? envelope
							: []
				) as unknown[];
				const backendNextCursor =
					envelope && typeof envelope === "object" && "nextCursor" in envelope
						? (envelope as { nextCursor: string | null }).nextCursor
						: null;

				// k177617dqg6z5c099p1rdp5rqn8b2rp0 — businessUnits rows carry
				// `orchestratorId` (the BU's lead orchestrator), NOT `createdBy`
				// and NOT `namespace` — scopeFilterList discriminates on
				// `createdBy`/`namespace` only, so passing rows through unmapped
				// found no field to match against and refused EVERY non-master
				// caller, the lead orchestrator included (refus-total — same
				// defect class as list_broadcast_status pre-fix, tools.ts:~3502,
				// which established the sanctioned remedy: remap the tool's real
				// ownership field onto `createdBy` BEFORE calling scopeFilterList,
				// then strip the synthetic field back out of the response.
				const filteredBus = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					(rawItems as Array<Record<string, unknown>>).map((bu) => ({
						...bu,
						createdBy: bu.orchestratorId as string | undefined,
					})),
				).map(({ createdBy: _createdBy, ...rest }) => rest);

				// nextCursor is the SCOPED READ's own cursor (the door computed it over
				// the caller's roster ranges). It is NOT recomputed from the rows the
				// narrowing filter kept: a page the filter shrank, or emptied, still
				// has more behind it, and saying "exhausted" there hides real rows.
				const nextCursor: string | null = backendNextCursor;

				const busWithCursor = { items: filteredBus, nextCursor };

				return {
					content: [
						{
							type: "text",
							text: capListResponseBytes(
								filteredBus,
								JSON.stringify(busWithCursor, null, 2),
								"list_bus",
							),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── delete_bu ───────────────────────────────────────────────────────────────

	// oracle-justified: master-only by design: deleting a business unit is irreversible and restricted to the fleet
	//   master at both doors (MCP scope master; businessUnits:remove throws unless isMaster,
	//   convex/businessUnits.ts), so its verb, tier, isolation locus and global boundary differ from
	//   create, update and list, which admit a member by roster.
	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		"delete_bu",
		"Permanently delete a business unit by Convex document ID — this action is irreversible. " +
			"WHEN: use only for test BUs or entities created in error; prefer status update for real BUs. " +
			"EXAMPLE: delete_bu buId='j57aaaaa...'.",
		{
			buId: buIdSchema.describe(
				"Convex document ID of the business unit to delete",
			),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: true,
			title: "Delete BU",
		},
		async ({ buId }) => {
			// C0.3: permanent BU deletion — master scope only
			const masterDenied = guardMasterOnly("delete_bu");
			if (masterDenied) return masterDenied;
			try {
				// The fleet master forwards no org (none is verified for it): it deletes
				// the fleet's own units. A client unit is deleted only on a verified claim.
				const result = await convex.mutation("businessUnits:remove" as any, {
					buId: buId as any,
					...doorScopeArgs("businessUnits:remove", undefined),
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(result, null, 2),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── add_repo_mapping ────────────────────────────────────────────────────────

	// oracle-justified: githubRepoMapping rows carry an optional `orgId` (absent = fleet row), written
	//   server-side from the caller's verified scope (convex/githubRepoMapping.ts resolveWriteTenant) and
	//   never from an argument. The MCP layer therefore only refuses an unresolved caller; the Convex door
	//   decides: master writes a fleet row, an org member needs the "manage-repo-mappings" scope, writes only
	//   its own org's rows, and routes only to its own roster.
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"guardResolvedCaller() refuses an unresolved caller; tenant (orgId) derived server-side from the verified scope in githubRepoMapping:add; member needs manage-repo-mappings and a GitHub-verified owner binding",
		},
		"add_repo_mapping",
		"Register or update a GitHub repo to orchestrator mapping for webhook event routing. " +
			"Returns { id, repo, orchestrator, project, active, reviewer, fallbackReviewer }; calling again for the same repo updates the mapping. " +
			"WHEN: use when adding a new repo to monitoring or changing which orchestrator handles its events. " +
			"EXAMPLE: add_repo_mapping repo='vantageos-agency/vantage-peers' orchestrator='alpha' project='vantage-peers'.",
		{
			repo: z
				.string()
				.describe("The GitHub repository, as owner/name, e.g. 'vantageos-agency/vantage-peers'."),
			orchestrator: z
				.string()
				.describe("The orchestrator that receives the repo's webhook events, e.g. 'sigma'."),
			project: z
				.string()
				.describe("The project the repo's work is billed to, e.g. 'vantage-peers'."),
			active: z
				.boolean()
				.optional()
				.default(true)
				.describe("Whether the repo's webhook events are routed: false keeps the mapping but stops routing them."),
			reviewer: z
				.string()
				.optional()
				.describe(
					"Who reviews the repo's pull-request tasks. Omit to use the fleet default reviewer.",
				),
			fallbackReviewer: z
				.string()
				.optional()
				.describe(
					"Who reviews when the reviewer is stopped. Omit to use the fleet default.",
				),
		},
		{
			outputSchema: addRepoMappingServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Add repo mapping",
		},
		async ({ repo, orchestrator, project, active, reviewer, fallbackReviewer }) => {
			// Repo mappings are tenant-owned (orgId): an unresolved caller is refused
			// here, the Convex door decides master / org-member / own-rows.
			const unresolved = guardResolvedCaller("add_repo_mapping");
			if (unresolved) return unresolved;
			try {
				// The mapping is written IN the bearer's verified org, as its read
				// sibling list_repo_mappings reads it (task k176y0q5jcz3m8m673bf61kva98h49js).
				const orgDenied = unresolvedOrgDenial("add_repo_mapping");
				if (orgDenied) return orgDenied;
				const id = await convex.mutation("githubRepoMapping:add" as any, {
					repo,
					orchestrator,
					project,
					active,
					reviewer,
					fallbackReviewer,
					...doorScopeArgs("githubRepoMapping:add", undefined),
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { id, repo, orchestrator, project, active, reviewer, fallbackReviewer };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── list_repo_mappings ──────────────────────────────────────────────────────

	// oracle-justified: githubRepoMapping rows carry an optional `orgId` (absent = fleet row). The tenant is
	//   resolved at the Convex door githubRepoMapping:list from the verified caller (withOrgScope +
	//   requireResolvedCaller), never from an argument: a member is served only its own org's rows, the fleet
	//   master all of them. The MCP layer only refuses an unresolved caller.
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"list_repo_mappings",
		"List all GitHub repo to orchestrator webhook mappings, newest first with cursor paging support. " +
			"Returns { items, nextCursor, truncated }: items are mappings, newest first; nextCursor is null on the last page; truncated is true when the 60 KB response cap cut the page (nextCursor is then null). The text is the same page as JSON. " +
			"WHEN: use to audit which repos are monitored and verify routing before adding new mappings. " +
			"EXAMPLE: list_repo_mappings limit=20 fields='lite'.",
		{
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.meta({ default: "full" })
				.describe("How much of each row comes back: full is every stored field; lite is just the mapping's ID, creation time, repo, orchestrator and project."),
			cursor: z
				.string()
				.optional()
				.describe(
					"The nextCursor value a previous list_repo_mappings call returned, to fetch the following (older) page. " +
						"Omit for the first page.",
				),
		},
		{
			outputSchema: listRepoMappingsServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List repo mappings",
		},
		async ({ limit, fields, cursor }) => {
			try {
				const effectiveLimit = limit === undefined ? 20 : clampLimit(limit);

				// Hybrid cursor decode: supports old paging.ts format { createdBefore }
				// for back-compat, and new opaque format { time, id } passed directly to Convex.
				let createdBefore: number | undefined;
				let convexCursor: string | undefined;
				if (cursor !== undefined && cursor !== "") {
					try {
						const decoded = decodeCursor(cursor);
						if (decoded && "createdBefore" in decoded) {
							createdBefore = decoded.createdBefore;
						} else {
							// New-format cursor — pass directly to Convex
							convexCursor = cursor;
						}
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : "invalid cursor";
						return mcpError(msg);
					}
				}

				// S3.1.C2 — scope-aware filter replaces guardMasterOnly.
				// Convex query now returns { items, nextCursor } envelope (PR-C).
				// Tenant applied INSIDE the Convex read (`verifiedOrg`): the door reads
				// the caller's `by_org` index range only. A bearer whose org cannot be
				// resolved is refused here, before any read.
				const orgDenied = unresolvedOrgDenial("list_repo_mappings");
				if (orgDenied !== null) return orgDenied;
				const envelope = await convex.query("githubRepoMapping:list" as any, {
					limit: effectiveLimit,
					fields: fields ?? "full",
					cursor: convexCursor,
					createdBefore,
					...doorScopeArgs("githubRepoMapping:list", undefined),
				});
				const rawItems = (
					envelope && typeof envelope === "object" && "items" in envelope
						? (envelope as { items: unknown[] }).items
						: Array.isArray(envelope)
							? envelope
							: []
				) as unknown[];
				const backendNextCursor =
					envelope && typeof envelope === "object" && "nextCursor" in envelope
						? (envelope as { nextCursor: string | null }).nextCursor
						: null;

				// Class-sweep fix (mission vp-multitenant-zero-hole-v1, final 8):
				// githubRepoMapping rows (schema.ts:482) carry `orchestrator`, NOT
				// `createdBy` and NOT `namespace` -- scopeFilterList finds nothing
				// to discriminate on and refuses EVERY non-master caller,
				// including the owner (refus-total). Same remedy as
				// list_broadcast_status/list_messages: remap
				// orchestrator->createdBy before scopeFilterList, then strip the
				// synthetic field back out.
				const filteredMappings = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					(rawItems as Record<string, unknown>[]).map((r) => ({
						...r,
						createdBy: r.orchestrator as string | undefined,
					})),
				).map(({ createdBy: _createdBy, ...rest }) => rest);

				// nextCursor is the SCOPED READ's own cursor (the door computed it over
				// the caller's tenant range). It is NOT recomputed from the rows the
				// narrowing filter kept: a page the filter shrank, or emptied, still
				// has more behind it, and saying "exhausted" there hides real rows.
				const nextCursor: string | null = backendNextCursor;

				const mappingsWithCursor = { items: filteredMappings, nextCursor };

				const capped = capListResponse(
					filteredMappings,
					JSON.stringify(mappingsWithCursor, null, 2),
					"list_repo_mappings",
				);
				return {
					content: [{ type: "text", text: capped.text }],
					structuredContent: pageStructured(mappingsWithCursor, capped),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── remove_repo_mapping ─────────────────────────────────────────────────────

	// oracle-justified: githubRepoMapping rows carry an optional `orgId` (absent = fleet row). The tenant is
	//   resolved at the Convex door githubRepoMapping:remove from the verified caller (withOrgScope) and the
	//   row must belong to it (requireRowOwnedBy), never judged from an argument: a member removes only its
	//   own org's rows. The MCP layer only refuses an unresolved caller.
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"guardResolvedCaller() refuses an unresolved caller; tenant (orgId) derived server-side from the verified scope in githubRepoMapping:remove; member removes only its own org rows",
		},
		"remove_repo_mapping",
		"Delete a GitHub repo mapping by repo name, stopping webhook event routing for that repo. " +
			"Returns { repo, deleted }; deleted is false when no mapping existed for that repo. " +
			"WHEN: use when a repo is archived or its events should no longer generate VP notifications. " +
			"EXAMPLE: remove_repo_mapping repo='vantageos-agency/vantage-peers'.",
		{
			repo: z
				.string()
				.describe(
					"The repository whose mapping to delete, as owner/name, as list_repo_mappings shows it.",
				),
		},
		{
			outputSchema: removeRepoMappingServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: true,
			title: "Remove repo mapping",
		},
		async ({ repo }) => {
			const unresolved = guardResolvedCaller("remove_repo_mapping");
			if (unresolved) return unresolved;
			try {
				const orgDenied = unresolvedOrgDenial("remove_repo_mapping");
				if (orgDenied) return orgDenied;
				const result = await convex.mutation(
					"githubRepoMapping:remove" as any,
					{
						repo,
						...doorScopeArgs("githubRepoMapping:remove", undefined),
					},
				);

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { repo, ...result };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_github_owner_bindings ──────────────────────────────────────────────

	// oracle-disposition: CONSERVER — githubOwnerBindings is the proof an owner belongs to an org, the only basis on which a repo routes to it
	// oracle-justified: githubOwnerBindings rows carry the owning `orgId`. The tenant is resolved at the Convex
	//   doors githubOwnerBinding:listBindings and listUnprovenMappings from the verified caller (withOrgScope +
	//   requireResolvedCaller), never from an argument: a member sees only its own org's bindings, the unproven
	//   mappings are master-only. The MCP layer only refuses an unresolved caller.
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"guardResolvedCaller() refuses an unresolved caller; result set scoped by githubOwnerBinding:listBindings (own org for a member, all for master); unproven mappings are master-only at the Convex door",
		},
		"get_github_owner_bindings",
		"List the GitHub owners bound to your organisation (master: all), and for master the org-owned repo mappings that have no proof. " +
			"Returns { bindings, nextCursor, unprovenMappings, unprovenNextCursor }; the unproven fields are present for the fleet master only, and a null cursor means that list is exhausted. " +
			"WHEN: use to see which repos you may map, or to audit mappings created without GitHub proof. " +
			"EXAMPLE: get_github_owner_bindings limit=100. " +
			"Pages by cursor: pass `nextCursor` back as `cursor` (and `unprovenNextCursor` as `unprovenCursor`); null means exhausted.",
		{
			limit: z
				.number()
				.int()
				.min(1)
				.max(500)
				.default(100)
				.describe("At most this many rows come back in each of the two lists; when more exist, nextCursor (bindings) or unprovenNextCursor (unproven mappings) is the cursor for the next page."),
			cursor: z
				.string()
				.optional()
				.describe("The nextCursor a previous get_github_owner_bindings call returned. Omit for the first page of bindings."),
			unprovenCursor: z
				.string()
				.optional()
				.describe(
					"The unprovenNextCursor a previous get_github_owner_bindings call returned (fleet master only). " +
						"Omit for the first page of unproven mappings.",
				),
		},
		{
			outputSchema: getGithubOwnerBindingsServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List GitHub owner bindings",
		},
		async ({ limit, cursor, unprovenCursor }) => {
			const unresolved = guardResolvedCaller("get_github_owner_bindings");
			if (unresolved) return unresolved;
			// A bearer whose org cannot be resolved is refused before Convex: the
			// door narrows to the verified org, it never serves the whole table.
			const orgDenied = unresolvedOrgDenial("get_github_owner_bindings");
			if (orgDenied !== null) return orgDenied;
			try {
				// Both reads are cursor-paginated server-side and return { items,
				// nextCursor }: the cursors are passed on so a page never reads as the whole list.
				const bindingsPage = await convex.query("githubOwnerBinding:listBindings" as any, {
					limit,
					...doorScopeArgs("githubOwnerBinding:listBindings", undefined),
					...(cursor !== undefined ? { cursor } : {}),
				});
				const unprovenPage = isMasterScope(oauthCtx)
					? await convex.query("githubOwnerBinding:listUnprovenMappings" as any, {
							limit,
							...doorScopeArgs("githubOwnerBinding:listUnprovenMappings", undefined),
							...(unprovenCursor !== undefined ? { cursor: unprovenCursor } : {}),
						})
					: undefined;
				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = {
						bindings: bindingsPage.items,
						nextCursor: bindingsPage.nextCursor,
						unprovenMappings: unprovenPage?.items,
						unprovenNextCursor: unprovenPage?.nextCursor,
					};
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── list_issues ─────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		// Class-sweep fix (mission vp-multitenant-zero-hole-v1, final 8):
		// issues rows (schema.ts:421) carry NEITHER a client-owner field (no
		// `createdBy`-equivalent, no per-tenant namespace) NOR any conceivable
		// client owner -- `assignedOrchestrator`/`fixedBy`/`verifiedBy` are
		// fleet-operations routing fields, not tenant ownership. scopeFilterList
		// found nothing to discriminate on and refused EVERY non-master caller
		// (refus-total). This mirrors list_errors (tools.ts ~9002): the write
		// mutations on this same table (update_issue_status, link_commit_to_issue,
		// verify_issue) are already `{ kind: "master" }`, confirming issues is
		// fleet-internal GitHub tracking data, never client-scoped. Correct
		// remedy is structural removal from the client surface: master-only.
		// Intended behavior change -- non-master callers previously got a
		// silent empty list; they now get an explicit Forbidden error.
		{ kind: "master" },
		"list_issues",
		"List tracked GitHub issues filtered by project, status, or assigned orchestrator, newest first. " +
			"WHEN: use to triage open issues, find in-progress fixes, or review a project's bug backlog. " +
			"EXAMPLE: list_issues project='vantage-peers' status='open' limit=20. " +
			"Default limit 20. cap 200.",
		{
			project: z
				.string()
				.optional()
				.describe(
					"Filter by project name — e.g. 'myreeldream', 'vantage-starter'",
				),
			status: z
				.enum(["open", "in_progress", "fixed", "verified", "closed"])
				.optional()
				.describe("Filter by issue status"),
			assignedTo: z
				.string()
				.optional()
				.describe("Filter by assigned orchestrator — e.g. 'omega', 'sigma'"),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.describe("Max items to return. Default 20 (envelope-safe). Cap 200."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.describe(
					"How much of each row comes back: by default every stored field; with lite, a compact projection for fewer tokens. Omit for every field.",
				),
			cursor: z
				.string()
				.optional()
				.describe(
					"S3.3 B8 follow-up — opaque pagination cursor from a prior call's `nextCursor`. " +
						"Decoded to `createdBefore` (newest-first forward pagination).",
				),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List issues",
		},
		async ({ project, status, assignedTo, limit, fields, cursor }) => {
			try {
				// S3.3 B8 follow-up — decode opaque cursor → createdBefore anchor.
				let createdBefore: number | undefined;
				if (cursor !== undefined && cursor !== "") {
					try {
						const decoded = decodeCursor(cursor);
						if (decoded && "createdBefore" in decoded) {
							createdBefore = decoded.createdBefore;
						}
					} catch (err: any) {
						return mcpError(err?.message ?? "invalid cursor");
					}
				}
				const effectiveLimit =
					limit === undefined ? undefined : clampLimit(limit);
				const requestedLimit = effectiveLimit ?? 20;

				// S3.1.C2 — scope-aware filter replaces guardMasterOnly.
				let results: any;
				if (assignedTo) {
					results = await convex.query("issues:listByOrchestrator" as any, {
						assignedOrchestrator: assignedTo,
						status: status as any,
						limit: requestedLimit,
						fields: fields ?? "lite",
						createdBefore,
					});
				} else if (project) {
					results = await convex.query("issues:listByProject" as any, {
						project,
						status: status as any,
						limit: requestedLimit,
						fields: fields ?? "lite",
						createdBefore,
					});
				} else if (status) {
					results = await convex.query("issues:listByStatus" as any, {
						status: status as any,
						limit: requestedLimit,
						fields: fields ?? "lite",
						createdBefore,
					});
				} else {
					results = await convex.query("issues:listByProject" as any, {
						project: "",
						limit: requestedLimit,
						fields: fields ?? "lite",
						createdBefore,
					});
				}

				const filteredIssues = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					Array.isArray(results) ? results : [],
				);

				// S3.3 B8 follow-up — emit nextCursor when page is full.
				let nextCursor: string | null = null;
				if (
					filteredIssues.length >= requestedLimit &&
					filteredIssues.length > 0
				) {
					const last = filteredIssues[filteredIssues.length - 1] as {
						_creationTime?: number;
					};
					if (typeof last._creationTime === "number") {
						nextCursor = encodeCursor({ createdBefore: last._creationTime });
					}
				}
				const payload =
					nextCursor !== null
						? {
								count: filteredIssues.length,
								issues: filteredIssues,
								nextCursor,
							}
						: { count: filteredIssues.length, issues: filteredIssues };

				return {
					content: [
						{
							type: "text",
							text: capListResponseBytes(
								filteredIssues,
								JSON.stringify(payload, null, 2),
								"list_issues",
							),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_issue ───────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		// Class-sweep fix (mission vp-multitenant-zero-hole-v1, final 8):
		// same decision as list_issues immediately above -- issues rows carry no
		// conceivable client-owner field; this is fleet-internal GitHub tracking
		// data. Master-only, mirroring the sibling write mutations on this table.
		{ kind: "master" },
		"get_issue",
		"Fetch a single GitHub issue by repo name and issue number, returning full tracking details. " +
			"WHEN: use when routing a specific GitHub webhook event or verifying fix status on a known issue. " +
			"EXAMPLE: get_issue repo='vantageos-agency/vantage-peers' issueNumber=667.",
		{
			repo: z
				.string()
				.describe("Full repo name — e.g. 'myreeldream-ai/MyShortReel-beta'"),
			issueNumber: z.number().int().describe("GitHub issue number"),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get issue",
		},
		async ({ repo, issueNumber }) => {
			try {
				// S3.1.C3 — scope-aware filter replaces guardMasterOnly.
				const issue = await convex.query("issues:getByRepoNumber" as any, {
					repo,
					issueNumber,
				});
				const filteredIssue = scopeFilterGet(
					oauthCtx ?? DENIED_SCOPE_CTX,
					issue as any,
				);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								filteredIssue ?? { error: "Issue not found" },
								null,
								2,
							),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── update_issue_status ─────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		"update_issue_status",
		"Update the tracked status of a GitHub issue (open/in_progress/fixed/verified/closed). " +
			"WHEN: use when work begins, a fix is committed, or QA confirms resolution. " +
			"EXAMPLE: update_issue_status repo='vantageos-agency/vantage-peers' issueNumber=667 status='fixed'.",
		{
			repo: z
				.string()
				.describe("Full repo name — e.g. 'myreeldream-ai/MyShortReel-beta'"),
			issueNumber: z.number().int().describe("GitHub issue number"),
			status: z
				.enum(["open", "in_progress", "fixed", "verified", "closed"])
				.describe("New status for the issue"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Update issue status",
		},
		async ({ repo, issueNumber, status }) => {
			// C0.5: no orchestrator identity arg — master scope only
			const masterDenied = guardMasterOnly("update_issue_status");
			if (masterDenied) return masterDenied;
			try {
				await convex.mutation("issues:updateStatus" as any, {
					repo,
					issueNumber,
					status,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ repo, issueNumber, status, updated: true },
								null,
								2,
							),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── link_commit_to_issue ────────────────────────────────────────────────────

	// oracle-justified: master-only write through requireMasterScope (convex/issues.ts throws unless isMaster); the read
	//   side refuses through requireResolvedCaller masterOnly, so both are master-only with different
	//   resolver calls.
	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		"link_commit_to_issue",
		"Link a fix commit SHA to a GitHub issue, recording the fixer and time of resolution. " +
			"WHEN: use immediately after pushing a fix commit so the issue has an auditable commit reference. " +
			"EXAMPLE: link_commit_to_issue repo='vantageos-agency/vantage-peers' issueNumber=667 commitSha='abc1234' fixedBy='alpha'.",
		{
			repo: z
				.string()
				.describe("Full repo name — e.g. 'myreeldream-ai/MyShortReel-beta'"),
			issueNumber: z.number().int().describe("GitHub issue number"),
			commitSha: z.string().describe("Git commit SHA that fixes this issue"),
			fixedBy: z
				.string()
				.describe("Who fixed it — orchestrator name or person"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Link commit to issue",
		},
		async ({ repo, issueNumber, commitSha, fixedBy }) => {
			try {
				await convex.mutation("issues:linkCommit" as any, {
					repo,
					issueNumber,
					commitSha,
					fixedBy,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ repo, issueNumber, commitSha, fixedBy, linked: true },
								null,
								2,
							),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── verify_issue ────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		"verify_issue",
		"Mark a GitHub issue as verified, confirming the fix was tested and the issue is resolved. " +
			"WHEN: use after QA or the reporter confirms the fix works in the target environment. " +
			"EXAMPLE: verify_issue repo='vantageos-agency/vantage-peers' issueNumber=667 verifiedBy='gamma'.",
		{
			repo: z
				.string()
				.describe("Full repo name — e.g. 'myreeldream-ai/MyShortReel-beta'"),
			issueNumber: z.number().int().describe("GitHub issue number"),
			verifiedBy: z
				.string()
				.describe("Who verified the fix — orchestrator name or person"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Verify issue",
		},
		async ({ repo, issueNumber, verifiedBy }) => {
			try {
				await convex.mutation("issues:verify" as any, {
					repo,
					issueNumber,
					verifiedBy,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ repo, issueNumber, verifiedBy, verified: true },
								null,
								2,
							),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── issue_stats ─────────────────────────────────────────────────────────────

	// oracle-justified: an unpaged aggregate over the issues table (issues:getStats) that returns counts, not rows: no
	//   cursor and no limit argument, where get_issue reads one row and list_issues pages with a cursor
	//   (limit default 50, max 200).
	defineTool(
		server,
		authCtx,
		// Class-sweep fix (mission vp-multitenant-zero-hole-v1, final 8):
		// issue_stats returns an aggregate counts object (issues:getStats), not
		// per-row data -- there is no createdBy/namespace to discriminate on for
		// an aggregate, and fabricating one would misrepresent a fleet-wide
		// count as tenant-scoped. Same fleet-aggregate reasoning as list_errors;
		// master-only.
		{ kind: "master" },
		"issue_stats",
		"Get issue count statistics grouped by status, optionally scoped to a single project. " +
			"WHEN: use for daily health checks or project retrospectives to measure issue throughput. " +
			"EXAMPLE: issue_stats project='vantage-peers'.",
		{
			project: z
				.string()
				.optional()
				.describe("Filter stats to a specific project — omit for all projects"),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Issue statistics",
		},
		async ({ project }) => {
			try {
				// S3.1.C3 — scope-aware filter replaces guardMasterOnly.
				const stats = await convex.query("issues:getStats" as any, {
					project,
				});
				const filteredStats = scopeFilterGet(
					oauthCtx ?? DENIED_SCOPE_CTX,
					stats as any,
				);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(filteredStats, null, 2),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── create_fix_pattern ──────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "createdBy" },
		"create_fix_pattern",
		"Create a fix pattern in the knowledge base documenting symptom, root cause, and optional validated fix. " +
			"Returns { patternId, created: true }. WHEN: use after resolving a non-trivial bug so future agents can find and reuse the solution. " +
			"EXAMPLE: create_fix_pattern symptom='hydration mismatch' rootCause='SSR/CSR time skew' tags=['next.js'] stack=['next.js','convex'] sourceProject='vantage-starter' createdBy='alpha' severity='major'.",
		{
			symptom: z
				.string()
				.describe("What the bug looks like from the outside, as someone hitting it would describe it."),
			rootCause: z
				.string()
				.describe("Why the bug happens: the underlying technical cause."),
			tags: flexArray.describe(
				"Labels for finding the pattern, e.g. ['react-hydration'].",
			),
			stack: flexArray.describe(
				"The technologies involved, e.g. ['next.js', 'convex'].",
			),
			sourceProject: z
				.string()
				.describe("The project where the bug was found, e.g. 'myreeldream'."),
			createdBy: creatorSchema.describe("The agent this call writes as, recorded as the pattern's author (e.g. 'sigma'). " +
				"Omit it when your credential resolves one agent: it is then that agent. Otherwise omitting it is refused."),
			severity: severitySchema.describe("How far the lesson reaches: critical (every orchestrator should know it), major (changes how this kind of work is done), minor (a local note)."),
			validatedFix: z
				.string()
				.optional()
				.describe("The fix confirmed to work. Omit when not known yet; validate_fix sets it later."),
			files: flexArrayOptional.describe("The files the fix touched. Omit when not known."),
			linkedIssueIds: flexArrayOptional.describe(
				"Issues this pattern explains, by issue ID (get_fix_pattern shows the ones already linked; link_issue_to_pattern adds more later). " +
					"Omit for none.",
			),
		},
		{
			readOnlyHint: false,
			idempotentHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Create fix pattern",
		},
		async ({
			symptom,
			rootCause,
			tags,
			stack,
			sourceProject,
			createdBy,
			severity,
			validatedFix,
			files,
			linkedIssueIds,
		}) => {
			try {
				const patternId = await convex.mutation("fixPatterns:create" as any, {
					symptom,
					rootCause,
					tags: toArray(tags) ?? [],
					stack: toArray(stack) ?? [],
					sourceProject,
					createdBy,
					severity,
					validatedFix,
					files: toArray(files),
					linkedIssueIds: toArray(linkedIssueIds),
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ patternId, created: true }, null, 2),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── add_fix_attempt ─────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "createdBy" },
		"add_fix_attempt",
		"Record one attempt at fixing a known fix pattern: what was tried, whether it worked, why, and optionally its commit. " +
			"Returns { attemptId, patternId, worked }. " +
			"WHEN: use after each fix attempt (successful or not) to build a complete fix history. " +
			"EXAMPLE: add_fix_attempt patternId='j57aaaaa...' description='Added suppressHydrationWarning' worked=true why='Prevents mismatches' createdBy='beta'.",
		{
			patternId: patternIdSchema.describe("Which fix pattern: its patternId as create_fix_pattern, search_fix_patterns or list_fix_patterns returned it."),
			description: z.string().describe("What was tried: the fix approach."),
			worked: z.boolean().describe("Whether this attempt fixed the bug."),
			why: z.string().describe("Why it worked or did not: the reasoning a later reader needs."),
			createdBy: creatorSchema.describe("The agent this call writes as, recorded as the attempt's author (e.g. 'sigma'). " +
				"Omit it when your credential resolves one agent: it is then that agent. Otherwise omitting it is refused."),
			commit: z.string().optional().describe("The git commit of this attempt, as a SHA. Omit when it was not committed."),
		},
		{
			readOnlyHint: false,
			idempotentHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Add fix attempt",
		},
		async ({ patternId, description, worked, why, createdBy, commit }) => {
			try {
				const attemptId = await convex.mutation(
					"fixPatterns:addAttempt" as any,
					{
						patternId: patternId as never,
						description,
						worked,
						why,
						createdBy,
						commit,
					},
				);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ attemptId, patternId, worked }, null, 2),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── validate_fix ────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		"validate_fix",
		"Set or update the validated fix description on a fix pattern after confirming it works. Fleet master only. " +
			"Overwrites the pattern's validatedFix with the given text (the previous value is not kept) and re-indexes the pattern for search_fix_patterns. " +
			"Returns { patternId, validatedFix, validated: true }. " +
			"WHEN: use after a fix attempt succeeds to promote it as the canonical solution on the pattern. " +
			"EXAMPLE: validate_fix patternId='j57aaaaa...' validatedFix='Add suppressHydrationWarning to date elements'.",
		{
			patternId: patternIdSchema.describe("Which fix pattern: its patternId as create_fix_pattern, search_fix_patterns or list_fix_patterns returned it."),
			validatedFix: z.string().describe("The fix confirmed to work, replacing any earlier one."),
		},
		{
			outputSchema: validateFixServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Validate fix",
		},
		async ({ patternId, validatedFix }) => {
			// C0.5: no identity field — master scope only
			const masterDenied = guardMasterOnly("validate_fix");
			if (masterDenied) return masterDenied;
			try {
				await convex.mutation("fixPatterns:validate" as any, {
					patternId: patternId as never,
					validatedFix,
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { patternId, validatedFix, validated: true };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── search_fix_patterns ─────────────────────────────────────────────────────
	// ── search_fix_patterns ───────────────────────────────────────────────────
	// Canonical fix-pattern-search tool (fleet-primary). The former
	// `search_fix_patterns_by_semantic` twin was removed day159
	// (mission vp-mcp-alias-cleanup-v1, S2) — usage, not the code label, decides.

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"search_fix_patterns",
		// S3.3 B8 follow-up batch 3 FINAL — DOCTRINE EXCEPTION.
		// @cursorPagingException semantic-action-not-chronological
		// Rationale: backed by `convex.action("search:searchFixPatterns")` which
		// runs an embedding-similarity ranker; cursor paging by `createdBefore`
		// would corrupt relevance ordering. Same rationale as search_components.
		"Semantic search over fix patterns by symptom description, ranked by relevance. " +
			"Returns { items[{ patternId, score, symptom, rootCause, validatedFix?, tags, stack, sourceProject, severity }] }, best match first; the text is the same items as a bare JSON array. " +
			"WHEN: call BEFORE fixing any bug to check if a matching pattern exists and reuse the validated fix. " +
			"EXAMPLE: search_fix_patterns query='message disappears after sending on mobile' limit=5.",
		{
			query: z
				.string()
				.describe(
					"The problem in your own words, e.g. 'message disappears after sending'; matched by meaning.",
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many of the best matches come back; weaker matches beyond it are not returned."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.meta({ deprecated: true })
				.describe("Has no effect on this tool: every row comes back whole, with every stored field, whichever value is sent. Accepted only so that a client which sends it is not refused; leave it out."),
		},
		{
			outputSchema: searchFixPatternsServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Search fix patterns",
		},
		async ({ query, limit, fields }) => {
			try {
				// S3.1.C3 — scope-aware filter replaces guardMasterOnly.
				const results = await convex.action("search:searchFixPatterns" as any, {
					query,
					limit: limit ?? 20,
					fields: fields ?? "lite",
				});
				const filteredResults = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					Array.isArray(results) ? results : [],
				);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(filteredResults, null, 2),
						},
					],
					// The text stays the bare array; the object form of the same rows.
					structuredContent: arrayStructured(filteredResults),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── list_fix_patterns ───────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"list_fix_patterns",
		"List fix patterns filtered by source project, newest first with cursor paging support. " +
			"Returns { items, nextCursor, truncated }: items are fix patterns, newest first; nextCursor is the next page's cursor, null on the last page; truncated is true when the 60 KB response cap cut the page (nextCursor is then null). The text is the bare JSON array of the patterns on the last page, else { items, nextCursor }. " +
			"WHEN: use to audit the knowledge base or review all patterns for a specific project. " +
			"EXAMPLE: list_fix_patterns project='vantage-starter' limit=20.",
		{
			project: z
				.string()
				.optional()
				.describe("Keep only patterns found in this project. Omit for every project."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.meta({ default: 20 })
				.describe("At most this many rows come back; when more exist, the reply carries a nextCursor to pass as cursor for the next page."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.meta({ deprecated: true })
				.describe("Has no effect on this tool: every row comes back whole, with every stored field, whichever value is sent. Accepted only so that a client which sends it is not refused; leave it out."),
			cursor: z
				.string()
				.optional()
				.describe(
					"The nextCursor value a previous list_fix_patterns call returned, to fetch the following (older) page. " +
						"Omit for the first page.",
				),
		},
		{
			outputSchema: listFixPatternsServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List fix patterns",
		},
		async ({ project, limit, fields, cursor }) => {
			try {
				// S3.3 B8 follow-up — decode opaque cursor → createdBefore anchor.
				let createdBefore: number | undefined;
				if (cursor !== undefined && cursor !== "") {
					try {
						const decoded = decodeCursor(cursor);
						if (decoded && "createdBefore" in decoded) {
							createdBefore = decoded.createdBefore;
						}
					} catch (err: any) {
						return mcpError(err?.message ?? "invalid cursor");
					}
				}
				const effectiveLimit =
					limit === undefined ? undefined : clampLimit(limit);
				const requestedLimit = effectiveLimit ?? 20;

				const buildPayload = (rows: unknown[]) => {
					let nextCursor: string | null = null;
					if (rows.length >= requestedLimit && rows.length > 0) {
						const last = rows[rows.length - 1] as {
							_creationTime?: number;
						};
						if (typeof last._creationTime === "number") {
							nextCursor = encodeCursor({ createdBefore: last._creationTime });
						}
					}
					return nextCursor !== null ? { items: rows, nextCursor } : rows;
				};

				// S3.1.C3 — scope-aware filter replaces guardMasterOnly.
				if (project) {
					const results = await convex.query(
						"fixPatterns:listByProject" as any,
						{
							sourceProject: project,
							limit: requestedLimit,
							fields: fields ?? "lite",
							createdBefore,
						},
					);
					const filteredResults = scopeFilterList(
						oauthCtx ?? DENIED_SCOPE_CTX,
						Array.isArray(results) ? results : [],
					);
					const payload = buildPayload(filteredResults);
					const capped = capListResponse(
						payload,
						JSON.stringify(payload, null, 2),
						"list_fix_patterns",
					);
					return {
						content: [{ type: "text", text: capped.text }],
						structuredContent: pageStructured(payload, capped),
					};
				}

				const allResults = await convex.query("fixPatterns:listAll" as any, {
					limit: requestedLimit,
					fields: fields ?? "lite",
					createdBefore,
				});
				const filteredAll = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					Array.isArray(allResults) ? allResults : [],
				);
				const payload = buildPayload(filteredAll);
				const capped = capListResponse(
					payload,
					JSON.stringify(payload, null, 2),
					"list_fix_patterns",
				);
				return {
					content: [{ type: "text", text: capped.text }],
					structuredContent: pageStructured(payload, capped),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── link_issue_to_pattern ───────────────────────────────────────────────────

	// oracle-justified: create_fix_pattern is actor-bound (`from`, createdBy recorded on the row) whereas this tool
	//   mutates an existing pattern with no author argument and is master-scoped (global boundary);
	//   every fixPatterns write is master-only at the Convex door (requireFleetMaster,
	//   convex/fixPatterns.ts).
	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		"link_issue_to_pattern",
		"Link a VantagePeers issue to a fix pattern creating a bidirectional reference. " +
			"Returns { patternId, issueId, linked: true }; linking an issue already linked changes nothing. " +
			"WHEN: use after creating a fix pattern for an issue to connect the symptom record with the bug tracker. " +
			"EXAMPLE: link_issue_to_pattern patternId='j57aaaaa...' issueId='j57bbbbb...'.",
		{
			patternId: patternIdSchema.describe("Which fix pattern: its patternId as create_fix_pattern, search_fix_patterns or list_fix_patterns returned it."),
			issueId: z.string().describe("The issue to link, by issue ID; get_fix_pattern shows the issues already linked."),
		},
		{
			outputSchema: linkIssueToPatternServedOutputSchema,
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Link an issue to a known fix",
		},
		async ({ patternId, issueId }) => {
			// C0.5: no identity field — master scope only
			const masterDenied = guardMasterOnly("link_issue_to_pattern");
			if (masterDenied) return masterDenied;
			try {
				await convex.mutation("fixPatterns:linkIssue" as any, {
					patternId: patternId as never,
					issueId,
				});

				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = { patternId, issueId, linked: true };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_mission_template ────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"get_mission_template",
		"Fetch a mission template by name with all steps, or null if not found. " +
			"Returns the template as JSON (name, description, brief, steps, isDefault), or null when no visible template has that name. " +
			"WHEN: use before instantiate_template_into_mission to inspect steps and verify the template exists. " +
			"EXAMPLE: get_mission_template name='issue-resolution-v2'.",
		{
			name: z.string().describe("The template to fetch, by the unique name update_mission_template saved it under, e.g. 'issue-resolution-v2'."),
		},
		{
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get mission template",
		},
		async ({ name }) => {
			try {
				// S3.1.C3 — scope-aware filter replaces guardMasterOnly.
				const template = await convex.query(
					"missionTemplates:getByName" as any,
					{ name },
				);
				const filteredTemplate = scopeFilterGet(
					oauthCtx ?? DENIED_SCOPE_CTX,
					template as any,
				);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(filteredTemplate, null, 2),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── update_mission_template ─────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "createdBy" },
		"update_mission_template",
		"Create or upsert a mission template by name; existing templates are overwritten. " +
			"Fleet master only (the catalog is shared fleet-wide). " +
			"Steps and description are replaced whole (an omitted description is cleared); an omitted brief or isDefault keeps the stored value. " +
			"Missions already instantiated are not changed. Returns { templateId, name, stepCount }. " +
			"WHEN: use to define or refine reusable multi-step workflow blueprints for recurring mission types. " +
			"EXAMPLE: update_mission_template name='issue-resolution-v2' steps=[{title:'Triage',description:'...'}] createdBy='alpha'.",
		{
			name: z
				.string()
				.describe("The template's unique name, e.g. 'issue-resolution-v2'; an existing name is overwritten."),
			description: z
				.string()
				.optional()
				.describe("What the template is for. Omit it and an existing template's description is cleared."),
			brief: z
				.string()
				.optional()
				.describe(
					"The reusable mission brief; instantiate_template_into_mission copies it onto a mission that has none. " +
						"Omit to keep the stored brief.",
				),
			steps: z
				.array(
					z.object({
						title: z.string().describe("The task title this step produces."),
						description: z.string().describe("What to do in this step; {{key}} placeholders are filled from the instantiation context."),
						tags: z
							.array(z.string())
							.optional()
							.describe("Tags the step's task gets. Omit for none."),
						assignedTo: z
							.string()
							.optional()
							.describe(
								"Who does this step, by name, e.g. 'proxima'. Omit to assign it to the mission's pilot.",
							),
						assignedToInstance: z
							.string()
							.optional()
							.describe(
								"A specific instance for this step, e.g. 'proxima-vps'. Omit for any instance.",
							),
						dependsOn: z
							.array(z.number())
							.optional()
							.describe(
								"Earlier steps that must finish first, by position in this list counting from 0; they become task dependencies on instantiation. " +
									"Omit for none.",
							),
					}),
				)
				.describe(
					"The ordered steps, replacing any existing ones; each becomes one task when instantiated.",
				),
			createdBy: creatorSchema.describe(
				"The agent this call writes as, recorded as the template's author (e.g. 'sigma'). " +
					"Omit it when your credential resolves one agent: it is then that agent. Otherwise omitting it is refused.",
			),
			isDefault: z
				.boolean()
				.optional()
				.describe("Set true to make this the default template for its type. " +
					"Omit it and a new template is not the default, while an existing one keeps its current setting."),
		},
		{
			readOnlyHint: false,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Update mission template",
		},
		async ({ name, description, brief, steps, createdBy, isDefault }) => {
			try {
				const templateId = await convex.mutation(
					"missionTemplates:upsert" as any,
					{
						name,
						description,
						brief,
						steps,
						createdBy,
						isDefault,
					},
				);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ templateId, name, stepCount: steps.length },
								null,
								2,
							),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── instantiate_template_into_mission ───────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"instantiate_template_into_mission",
		"Create one task per template step inside a mission, pre-assigned to each step's declared orchestrator. " +
			"If the target mission has no brief yet, the template's own brief (if any) is copied onto it — the mission's brief, once set, is never overwritten. " +
			"Returns { taskIds, count }: the created task IDs, in step order. " +
			"WHEN: use after create_mission to fan out a standard workflow from a template in one call. " +
			"EXAMPLE: instantiate_template_into_mission templateName='issue-resolution-v2' missionId='k57a36y8...' callerOrchestrator='alpha'.",
		{
			templateName: z
				.string()
				.describe("The template to use, by name, as get_mission_template shows it."),
			missionId: missionIdSchema.describe(
				"The mission to fill: its missionId as returned by create_mission or list_missions.",
			),
			context: z
				.record(z.string(), z.string())
				.optional()
				.describe(
					"Values for the {{key}} placeholders in step descriptions, e.g. " +
						"{issue: '#282'}; a placeholder with no value is left as written. Omit when the steps have none.",
				),
			titlePrefix: z
				.string()
				.optional()
				.describe(
					"Text put in front of every task title, e.g. '[p25]'. Omit for none.",
				),
			// ACTING-NAME: a claim the credential-resolved actor verifies (defineTool -> bindActingNames), never an authority. Omitted => derived from the actor; a different agent name => AGENT_IDENTITY_MISMATCH.
			callerOrchestrator: z
				.string()
				.optional()
				.describe(
					"The agent instantiating, recorded as creator of the tasks. " +
						"Omit it when your credential resolves one agent: it is then that agent; otherwise the tasks are created by 'system' (the fleet master) or by your own signed-in account.",
				),
		},
		{
			readOnlyHint: false,
			idempotentHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Instantiate mission template",
		},
		async ({
			templateName,
			missionId,
			context,
			titlePrefix,
			callerOrchestrator,
		}) => {
			try {
				// S3.1.C3 — pre-mutation scope guard on target mission.
				// Fetch the mission first and ensure the caller's scope can see it
				// BEFORE running the instantiate mutation. Cross-tenant calls are
				// rejected with a non-leaky "not found" error rather than
				// silently producing tasks under another tenant's mission.
				const targetMission = await convex.query("missions:get" as any, {
					missionId: missionId as any,
				});
				const filteredMission = scopeFilterGet(
					oauthCtx ?? DENIED_SCOPE_CTX,
					targetMission as any,
				);
				if (filteredMission == null) {
					return mcpError(
						"Mission not found or not accessible to current scope",
					);
				}

				const result = await convex.mutation(
					"missionTemplates:instantiateTemplateIntoMission" as any,
					{
						templateName,
						missionId: missionId as any,
						context,
						titlePrefix,
						callerOrchestrator,
					},
				);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(result, null, 2),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── soft_delete_mission_template ────────────────────────────────────────────

	// oracle-justified: master-only: MCP scope master and missionTemplates:softDelete throws unless isMaster, the
	//   template catalog being shared fleet-wide and never per-org; the tool is absent from the `core`
	//   list of mcp-server/tool-exposure.json, so it is registered but masked (hors-MCP), where
	//   get_mission_template is advertised and in-handler-filtered.
	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		"soft_delete_mission_template",
		"Soft-delete a mission template so it stops appearing in reads (getByName, instantiate) while remaining in the audit log. " +
			"Mirrors soft_delete_memory's audit-preserving flag-patch motif — no hard delete. " +
			"WHEN: use to retire a verification-probe or obsolete template without permanent data loss. " +
			"EXAMPLE: soft_delete_mission_template name='_probe-1180-brief'.",
		{
			templateId: convexIdSchema("templateId")
				.optional()
				.describe(
					"Convex document ID of the template to soft-delete. Provide this or name.",
				),
			name: z
				.string()
				.optional()
				.describe(
					"Unique name of the template to soft-delete. Provide this or templateId.",
				),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: true,
			title: "Delete mission template (soft)",
		},
		async ({ templateId, name }) => {
			try {
				const denied = guardMasterOnly("soft_delete_mission_template");
				if (denied) return denied;

				if (templateId === undefined && name === undefined) {
					return mcpError("Provide either templateId or name");
				}

				await convex.mutation("missionTemplates:softDelete" as any, {
					templateId: templateId as any,
					name,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ deleted: true, templateId, name },
								null,
								2,
							),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── add_deployment ──────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		"add_deployment",
		"Register a Convex deployment for proactive error monitoring via 5-minute cron polling. " +
			"WHEN: use when setting up a new deployment that should auto-create GitHub issues on detected errors. " +
			"EXAMPLE: add_deployment name='vantage-prod' deploymentUrl='https://vantage-prod.convex.cloud' deployKeyEnvVar='DEPLOY_KEY_PROD' githubRepo='vantageos-agency/vantage-peers' orchestrator='alpha'.",
		{
			name: z
				.string()
				.describe(
					"Short unique name for this deployment — e.g. 'your-deployment-123'",
				),
			deploymentUrl: z
				.string()
				.describe(
					"Full Convex deployment URL — e.g. 'https://your-deployment-123.convex.cloud'",
				),
			deployKeyEnvVar: z
				.string()
				.describe(
					"Name of the Convex env var holding the admin deploy key — e.g. 'DEPLOY_KEY_GUINEAPIG'",
				),
			githubRepo: z
				.string()
				.describe(
					"GitHub repo in 'owner/repo' format where issues will be created — e.g. 'ElPiCorp/vantage-peers'",
				),
			orchestrator: z
				.string()
				.describe(
					"Orchestrator responsible for this deployment — e.g. 'sigma'",
				),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Add deployment",
		},
		async ({
			name,
			deploymentUrl,
			deployKeyEnvVar,
			githubRepo,
			orchestrator,
		}) => {
			// C0.1: infrastructure-level — master scope only
			const masterDenied = guardMasterOnly("add_deployment");
			if (masterDenied) return masterDenied;
			try {
				const id = await convex.mutation("errorMonitor:addDeployment" as any, {
					name,
					deploymentUrl,
					deployKeyEnvVar,
					githubRepo,
					orchestrator,
				});
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ id, name, deploymentUrl, githubRepo, orchestrator },
								null,
								2,
							),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── remove_deployment ───────────────────────────────────────────────────────

	// oracle-justified: sets active=false on the monitored-deployment row (a patch, the row is kept) rather than
	//   deleting it, so it derives UPDATE where add_deployment inserts or patches (UPSERT); both are
	//   master-only (requireMasterScope, convex/errorMonitor.ts).
	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		"remove_deployment",
		"Deactivate a monitored deployment, stopping cron polling while preserving the historical record. " +
			"WHEN: use when a deployment is retired or moved to a different monitoring config. " +
			"EXAMPLE: remove_deployment name='vantage-prod'.",
		{
			name: z
				.string()
				.describe(
					"Name of the deployment to deactivate — e.g. 'your-deployment-123'",
				),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: true,
			title: "Remove deployment",
		},
		async ({ name }) => {
			// C0.1: infrastructure-level — master scope only
			const masterDenied = guardMasterOnly("remove_deployment");
			if (masterDenied) return masterDenied;
			try {
				await convex.mutation("errorMonitor:removeDeployment" as any, { name });
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ removed: name }, null, 2),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── list_errors ─────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		// k177617dqg6z5c099p1rdp5rqn8b2rp0 — errorLogs rows (schema.ts) carry
		// NEITHER a client-owner field (no `createdBy`-equivalent, no per-tenant
		// namespace) NOR any conceivable client owner: they are fleet-operations
		// monitoring data (deployment/functionName/stackTrace across ALL
		// monitored deployments). scopeFilterList found nothing to discriminate
		// on and refused EVERY non-master caller (refus-total — dead
		// functionality, not isolation). Unlike list_bus/list_mandates there is
		// no ownership field to remap onto `createdBy` — inventing one would be
		// fabricating a tenant boundary that doesn't exist in the data. The
		// correct remedy is structural removal from the client surface: this
		// tool is now master-only. Intended behavior change — non-master
		// callers previously got a silent empty list; they now get an explicit
		// Forbidden error, and no longer see this tool's data at all.
		{ kind: "master" },
		"list_errors",
		"List detected errors from monitored deployments with dedup counts and linked GitHub issue numbers. " +
			"WHEN: use to triage production errors, identify recurring failures, or find the latest crash report. " +
			"EXAMPLE: list_errors deployment='vantage-prod' limit=20 fields='full'. " +
			"Default limit 20. cap 200.",
		{
			deployment: z
				.string()
				.optional()
				.describe(
					"Filter to a specific deployment name — omit to list errors across all deployments",
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.describe("Max items to return. Default 20 (envelope-safe). Cap 200."),
			fields: z
				.enum(["lite", "full"])
				.optional()
				.describe(
					"How much of each row comes back: by default every stored field; with lite, a compact projection for fewer tokens. Omit for every field.",
				),
			cursor: z
				.string()
				.optional()
				.describe(
					"S3.3 B8 follow-up — opaque pagination cursor from a prior call's `nextCursor`. " +
						"Decoded to `createdBefore` (newest-first forward pagination).",
				),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List errors",
		},
		async ({ deployment, limit, fields, cursor }) => {
			// k177617dqg6z5c099p1rdp5rqn8b2rp0 — errorLogs has no client-owner
			// field; the defineTool wrapper enforces master for oauthCtx callers,
			// this redundant in-handler check covers the legacy-bearer path the
			// same way delete_bu/guardMasterOnly already does elsewhere.
			const masterDenied = guardMasterOnly("list_errors");
			if (masterDenied) return masterDenied;
			try {
				// S3.3 B8 follow-up — decode opaque cursor → createdBefore anchor.
				let createdBefore: number | undefined;
				if (cursor !== undefined && cursor !== "") {
					try {
						const decoded = decodeCursor(cursor);
						if (decoded && "createdBefore" in decoded) {
							createdBefore = decoded.createdBefore;
						}
					} catch (err: any) {
						return mcpError(err?.message ?? "invalid cursor");
					}
				}
				const effectiveLimit =
					limit === undefined ? undefined : clampLimit(limit);

				// k177617dqg6z5c099p1rdp5rqn8b2rp0 — master-only tool now; no
				// per-row scope filter needed (errorLogs has no owner field).
				const errors = await convex.query("errorMonitor:listErrors" as any, {
					deployment,
					limit: effectiveLimit ?? 20,
					fields: fields ?? "lite",
					createdBefore,
				});
				const filteredErrors = Array.isArray(errors) ? errors : [];

				// S3.3 B8 follow-up — emit nextCursor when page is full.
				const requestedLimit = effectiveLimit ?? 20;
				let nextCursor: string | null = null;
				if (
					filteredErrors.length >= requestedLimit &&
					filteredErrors.length > 0
				) {
					const last = filteredErrors[filteredErrors.length - 1] as {
						_creationTime?: number;
					};
					if (typeof last._creationTime === "number") {
						nextCursor = encodeCursor({ createdBefore: last._creationTime });
					}
				}
				const errorsWithCursor =
					nextCursor !== null
						? { items: filteredErrors, nextCursor }
						: filteredErrors;

				return {
					content: [
						{
							type: "text",
							text: capListResponseBytes(
								errorsWithCursor,
								JSON.stringify(errorsWithCursor, null, 2),
								"list_errors",
							),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_error ───────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		// k177617dqg6z5c099p1rdp5rqn8b2rp0 — see list_errors above: errorLogs
		// has no client-owner field; master-only, same class fix.
		{ kind: "master" },
		"get_error",
		"Fetch a single error log entry by Convex document ID, including full stack trace and issue linkage. " +
			"WHEN: use after list_errors to retrieve the full stack trace for a specific error entry. " +
			"EXAMPLE: get_error errorId='j57dy3049btafda9m2f5d2ggk987ph3f'.",
		{
			errorId: errorIdSchema.describe(
				"Convex document ID of the errorLogs entry",
			),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get error",
		},
		async ({ errorId }) => {
			// k177617dqg6z5c099p1rdp5rqn8b2rp0 — redundant legacy-bearer guard,
			// same pattern as list_errors above.
			const masterDenied = guardMasterOnly("get_error");
			if (masterDenied) return masterDenied;
			try {
				// k177617dqg6z5c099p1rdp5rqn8b2rp0 — master-only tool now; no
				// per-row scope filter needed (errorLogs has no owner field).
				const error = await convex.query("errorMonitor:getError" as any, {
					errorId: errorId as any,
				});
				const filteredError = error;
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(filteredError, null, 2),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_tool_usage ──────────────────────────────────────────────────────────
	//
	// Which MCP tools a caller has called in its organisation: {tool, firstAt,
	// lastAt, count}[] (task k17cbr6y6da096t5e1k869kgb18hd0ht). The Convex door
	// (toolUsage:getToolUsage) decides who may read whom: the caller's own rows, any
	// caller of its organisation for an org admin or the fleet, a refusal otherwise.
	defineTool(
		server,
		authCtx,
		{
			kind: "public",
			reason:
				"the Convex door toolUsage:getToolUsage serves the caller's own rows, or any caller of its own organisation to an org admin / the fleet, and raises RBAC_DENIED for any other organisation",
		},
		"get_tool_usage",
		"List which MCP tools a caller has called, with the first call time, the last call time and the call count of each. " +
			"Returns { items[{ tool, firstAt, lastAt, count }] }, one row per tool the caller has called (times in Unix milliseconds); the text is the same items as a bare JSON array. " +
			"WHEN: use to see what a person or an agent seat has already tried, e.g. " +
			"to tell what an onboarding step still has to introduce. " +
			"EXAMPLE: get_tool_usage (your own usage) or get_tool_usage caller='agent:<agent id>' (an organisation admin reading a seat).",
		{
			caller: z
				.string()
				.optional()
				.describe(
					"Whose usage to read: 'user:<Clerk subject>' for a person or 'agent:<agent ID>' for an agent (list_peers returns agent IDs). " +
						"Omit it to read your own. Reading another caller needs an organisation admin role.",
				),
			orgSlug: z
				.string()
				.optional()
				.describe(
					"The organisation to read, by slug (fleet operators only). " +
						"Omit it to read your own organisation; naming another one is refused unless you are a fleet operator.",
				),
		},
		{
			outputSchema: getToolUsageServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get tool usage",
		},
		async ({ caller, orgSlug }) => {
			try {
				const reader = toolUsageReadArgs(
					oauthCtx,
					doorScopeArgs("toolUsage:getToolUsage", undefined),
					orgSlug,
				);
				if ("denied" in reader) return mcpError(reader.denied);
				const rows = await convex.query(
					// biome-ignore lint/suspicious/noExplicitAny: Convex string API
					"toolUsage:getToolUsage" as any,
					{
						...(caller !== undefined ? { caller } : {}),
						...reader.args,
					},
				);
				return {
					content: [
						{ type: "text", text: JSON.stringify(rows ?? [], null, 2) },
					],
					// The text stays the bare array; the object form of the same rows.
					structuredContent: arrayStructured(rows ?? []),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_owner_tool_usage ────────────────────────────────────────────────────
	//
	// The tools a PERSON has used across everything it owns in its organisation:
	// every agent whose owner it is (one per AI client) plus its own direct calls,
	// aggregated per tool (firstAt = min, lastAt = max, count = sum). The Convex door
	// (toolUsage:usageByOwner) decides who may read whom.
	defineTool(
		server,
		authCtx,
		{
			kind: "public",
			reason:
				"the Convex door toolUsage:usageByOwner serves the owner itself, or any member of the caller's own organisation to an org admin / the fleet, and raises RBAC_DENIED for an owner outside the organisation or another member without admin standing",
		},
		"get_owner_tool_usage",
		"List which MCP tools a person has used across all the agents it owns (one per AI client) and its own direct calls, summed per tool with the earliest first call and the latest last call. " +
			"Returns { items[{ tool, firstAt, lastAt, count }] }, summed across the person's agents and its own calls (times in Unix milliseconds); the text is the same items as a bare JSON array. " +
			"WHEN: use to tell what an onboarding step still has to introduce to a person, whichever AI client they used. " +
			"EXAMPLE: get_owner_tool_usage ownerUserId='user_2abc' (an organisation admin reading a member).",
		{
			ownerUserId: z
				.string()
				.describe("The person, by Clerk user ID (user_...): the same subject get_tool_usage takes after 'user:'. " +
					"Reading another member needs an organisation admin role."),
			orgSlug: z
				.string()
				.optional()
				.describe(
					"The organisation to read, by slug (fleet operators only). Omit it to read your own organisation.",
				),
		},
		{
			outputSchema: getOwnerToolUsageServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get a person's tool usage across their agents",
		},
		async ({ ownerUserId, orgSlug }) => {
			try {
				const reader = toolUsageReadArgs(
					oauthCtx,
					doorScopeArgs("toolUsage:usageByOwner", undefined),
					orgSlug,
				);
				if ("denied" in reader) return mcpError(reader.denied);
				const rows = await convex.query(
					// biome-ignore lint/suspicious/noExplicitAny: Convex string API
					"toolUsage:usageByOwner" as any,
					{ ownerUserId, ...reader.args },
				);
				return {
					content: [
						{ type: "text", text: JSON.stringify(rows ?? [], null, 2) },
					],
					// The text stays the bare array; the object form of the same rows.
					structuredContent: arrayStructured(rows ?? []),
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── whoami ──────────────────────────────────────────────────────────────────
	//
	// LECTURE (read-only, no DB mutation). Returns the orchestrator identity baked
	// into the current bearer's scope context. Use this on skill startup to avoid
	// asking the user for their orchestrator_id. Example: a fresh Claude.ai
	// connector calls whoami first, then uses suggested_orchestrator_id as `from`
	// on all subsequent send_message / create_task calls.
	//
	// Customer friction closed: Nadia Day 92 Acme RH skill had to ask the user
	// for orchestrator_id because no programmatic discovery path existed from
	// the bearer scope context. Mission k57a36y8w5t085bqr23dsmvb2d882506 A3.
	//
	// suggested_orchestrator_id derivation rule:
	//   - master scope → "master"
	//   - non-master with fromAllowList[0] present → fromAllowList[0] (case preserved)
	//   - non-master with empty fromAllowList → null
	//   - legacy bearer (no oauthCtx) → null

	defineTool(
		server,
		authCtx,
		{
			kind: "public",
			reason:
				"returns only the caller's own resolved scope; exposes no cross-tenant data",
		},
		"whoami",
		"Report who this connection acts as and what it may read and write, read from its own credential only. " +
			"Returns { agent_id, agent_name, agent_status, org_slug, role, suggested_orchestrator_id, acting_name, default_write_namespace, writableNamespaces, namespaceReadPrefixes, namespaceWritePrefixes, fromAllowList, scope_profile_name, actor, caller_id, agent_unresolved_reason }: agent_id is the permanent ID tools take as an agent ID, suggested_orchestrator_id the name to pass where a tool asks which orchestrator acts, default_write_namespace where a write lands when no namespace is given. " +
			"WHEN: use when a call needs your agent ID, orchestrator name or namespaces, instead of asking the user. " +
			"EXAMPLE: whoami (no arguments).",
		{},
		{
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Who am I",
			outputSchema: whoamiOutputSchema,
		},
		async () => {
			// Derive suggested_orchestrator_id:
			//   master scope → "master"
			//   non-master with fromAllowList[0] → fromAllowList[0] (case preserved)
			//   else → null
			let scopeProfileName: string;
			let fromAllowList: string[];
			let namespaceReadPrefixes: string[];
			let namespaceWritePrefixes: string[];
			let suggestedOrchestratorId: string | null;

			if (!oauthCtx) {
				// Misconfiguration fallback — every real auth path (master, OAuth,
				// Clerk JWT, stdio LOCAL_STDIO_TRUST_CTX) sets an oauthContext;
				// this branch only fires if that invariant is ever violated.
				scopeProfileName = "legacy";
				fromAllowList = [];
				namespaceReadPrefixes = [];
				namespaceWritePrefixes = [];
				suggestedOrchestratorId = null;
			} else if (isMasterScope(oauthCtx)) {
				// Master scope — expose neutral shape, suppress wildcard internals
				scopeProfileName = "master";
				fromAllowList = [];
				namespaceReadPrefixes = [];
				namespaceWritePrefixes = [];
				suggestedOrchestratorId = "master";
			} else {
				// Tenant-scoped OAuth bearer
				scopeProfileName = oauthCtx.scopeProfile;
				fromAllowList = oauthCtx.fromAllowList ?? [];
				namespaceReadPrefixes = oauthCtx.namespaceReadPrefixes ?? [];
				namespaceWritePrefixes = oauthCtx.namespaceWritePrefixes ?? [];
				// fromAllowList[0] is the canonical persona — case preserved per spec
				suggestedOrchestratorId =
					fromAllowList.length > 0 ? fromAllowList[0] : null;
			}

			const identity = resolveWhoamiIdentity(oauthCtx, process.env);
			const acting = resolveActingAgent(oauthCtx, verifiedActor);
			const result = {
				scope_profile_name: scopeProfileName,
				fromAllowList,
				namespaceReadPrefixes,
				namespaceWritePrefixes,
				writableNamespaces: writableNamespacesOf(writeSpace),
				default_write_namespace: defaultWriteNamespace(writeSpace) ?? null,
				suggested_orchestrator_id: suggestedOrchestratorId,
				// The acting agent by stored ID; identifiers only.
				actor: acting.actor,
				agent_id: acting.agent_id,
				// At top level, beside the workspace above: who acts, and when no
				// agent does, the one step that binds one.
				agent_name: acting.actor?.agentName ?? null,
				agent_status: agentStatusSentence(oauthCtx, acting.agent_id),
				agent_unresolved_reason: acting.agent_unresolved_reason,
				caller_id: identity.caller_id,
				org_slug: identity.org_slug,
				role: identity.role,
				acting_name: identity.acting_name,
			};

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(result, null, 2) },
				],
				structuredContent: result,
				// Profile block for ChatGPT-style hosts, beside the standard fields.
				// Same non-secret values as above, nothing more.
				_meta: {
					"openai/profile": {
						id: identity.caller_id,
						org_slug: identity.org_slug,
						role: identity.role,
						name: identity.acting_name,
					},
				},
			};
		},
	);

	// ── validate_task_payload ────────────────────────────────────────────────────
	//
	// LECTURE — pure lint, no DB write. Runs all VP write-path validation axes
	// at once and returns ALL failures in a single response. Orchestrators call
	// this before the real create_task / update_task / complete_task /
	// send_message to avoid the 2-3 sequential hook-rejection loops that
	// Laurent Day 92 diagnosed ("tu échoue 2 ou 3 fois à chaque fois").
	//
	// Axes covered (replaces 5 retired PreToolUse hooks):
	//   1. VERIFICATION: + TESTS: presence  → auto-inject-warn
	//   2. delegation-triplet completeness  → hard-block if partial
	//   3. evidence-bound completionNote    → hard-block on terminal status
	//   4. friction_observed declaration   → auto-inject-warn
	//   5. [STATUS]/task-ref on messages   → hard-block if missing
	//   6. time/effort estimates anywhere  → hard-block always
	//
	// Retired hooks: enforce-task-quality.py, enforce-task-delegation.py,
	//   enforce-no-task-in-message.py, enforce-evidence-bound-completion.py,
	//   enforce-friction-field.py
	//
	// Day 92 F1 — mission k57a36y8w5t085bqr23dsmvb2d882506

	defineTool(
		server,
		authCtx,
		{
			kind: "public",
			reason: "stateless payload linter; performs no data access",
		},
		"validate_task_payload",
		"Dry-run lint for VP write-path tools — checks all validation axes and returns failures with fix snippets. " +
			"WHEN: call before create_task / update_task / complete_task / send_message to catch all violations in one pass. " +
			"EXAMPLE: validate_task_payload tool_name='complete_task' payload={taskId:'k...',completionNote:'PR #667 merged SHA abc1234'}.",
		{
			tool_name: z
				.enum(["create_task", "update_task", "complete_task", "send_message"])
				.describe("The VP tool whose payload you want to validate."),
			payload: z
				.record(
					z.string(),
					// allow-union-input: the record holds another tool's argument values to be linted, each keeping the type that tool takes; the client copies them, it never chooses between a list and a scalar here
					z.union([
						z.string(),
						z.number(),
						z.boolean(),
						z.null(),
						z.array(z.string()),
					]),
				)
				.describe(
					"The tool_input object you intend to pass to tool_name. All values must be string, number, boolean, null, or string[].",
				),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Validate task payload (lint dry-run)",
		},
		({ tool_name, payload }) => {
			const result = validateTaskPayload(
				tool_name as Parameters<typeof validateTaskPayload>[0],
				payload as Record<string, unknown>,
			);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		},
	);

	// ── get_task ────────────────────────────────────────────────────────────────
	// Day 100 — Phase 1 get_by_id surface fix (task k172735brsw6bc3j2dkkkfxqrx88kkjq).
	// Pi reported get_<entity>_by_id surface incomplete. Convex tasks:getById exists.
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"get_task",
		"Fetch one task by its taskId. " +
			"Returns the stored task as JSON with every field it holds (title, description, status, priority, assignedTo, project, dependsOn, missionId, completionNote, workSegments, deliverableState), plus deliverableDivergence when a published deliverable is still open; an ID you may not read returns 'Task not found'. " +
			"WHEN: use when you hold a taskId and need the full record: the brief in description, its work segments and its completion note. " +
			"EXAMPLE: get_task taskId='k172735brsw6bc3j2dkkkfxqrx88kkjq'.",
		{
			taskId: taskIdSchema.describe("The task to fetch: its taskId as returned by create_task, list_tasks or search_tasks_by_keyword."),
		},
		{
			outputSchema: getTaskServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get task",
		},
		async ({ taskId }) => {
			try {
				const row = await convex.query("tasks:getById" as any, { taskId });
				// TENANT GATE, by-id surface: an agent of org A never reaches a row
				// stamped org B (nor an unstamped one). Same predicate as the
				// collection reads below (rowVisibleToActorTenant) — one boundary,
				// two surfaces, never one without the other.
				if (!rowVisibleToActorTenant(oauthCtx, row)) {
					return mcpError(`Task not found: ${taskId}`);
				}
				// k174y9ra7pp8zed3bcczk6xaed8cpynp — tasks carry `assignedTo` as a
				// per-row grant distinct from `createdBy` (convex/tasks.ts L88-89
				// ORs createdBy===caller || assignedTo===caller for task-scoped
				// mutations); mirror that OR here so a non-creator assignee can see
				// their own task via cloud-identity 0.5.0's grantFields, instead of
				// falling through createdBy/namespace-only matching to "not found".
				const filtered = scopeFilterGet(oauthCtx ?? DENIED_SCOPE_CTX, row, [
					"assignedTo",
				]);
				if (filtered === null) {
					return mcpError(`Task not found: ${taskId}`);
				}
				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = filtered;
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_fix_pattern ─────────────────────────────────────────────────────────
	// Day 100 — Phase 1 get_by_id surface fix. Convex fixPatterns:get exists.
	// oracle-justified: crud is `?` because fixPatterns:get loads one pattern by id and then lists its attempts
	//   (ctx.db.get plus an indexed take(100)), a get+list composite the closed verb set has no single
	//   value for; search_fix_patterns is a pure SEARCH.
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"get_fix_pattern",
		"Fetch a single fix pattern by its patternId, including all linked fix attempts. " +
			"Returns the fix pattern with its attempts as JSON; an ID you may not read is refused with RBAC_DENIED, and an ID that does not exist returns 'Fix pattern not found'. " +
			"WHEN: use when you have a patternId from list_fix_patterns/search_fix_patterns and need the full record with attempts history. " +
			"EXAMPLE: get_fix_pattern patternId='m9748paffd0emrbwyskj868e1x88kvhj'.",
		{
			patternId: patternIdSchema.describe("Which fix pattern: its patternId as create_fix_pattern, search_fix_patterns or list_fix_patterns returned it."),
		},
		{
			outputSchema: getFixPatternServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get fix pattern",
		},
		async ({ patternId }) => {
			try {
				// The creator gate is applied INSIDE the Convex read: a non-master
				// bearer forwards its verified roster (`callerIdentities`) and the door
				// answers null for a pattern that roster does not name, before its
				// attempts are read. Master forwards none.
				// The wrapped client forwards the acting agent's verifiedActor for a
				// non-master bearer only (verifiedActor.ts MASTER_UNNARROWED_DOORS): a
				// fleet-master seat lists every pattern, so it reads every pattern
				// (task k17a388w6d0cxmyw8gfk5tryp18hvw2k).
				const row = await convex.query("fixPatterns:get" as any, {
					patternId,
					...rosterClaimArgs(oauthCtx),
				});
				if (row === null || row === undefined) {
					return mcpError(`Fix pattern not found: ${patternId}`);
				}
				const filtered = scopeFilterGet(oauthCtx ?? DENIED_SCOPE_CTX, row);
				if (filtered === null) {
					// The row exists and this caller's roster does not name its creator:
					// a refusal, not an absence (refusal-is-distinguishable-from-absence.md).
					return mcpError(
						`REFUSED (RBAC_DENIED): fixPatterns:get refused fix pattern ${patternId} for this caller: it was created by an agent outside your roster. This is a refusal, NOT an absence.`,
					);
				}
				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = filtered;
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_mandate ─────────────────────────────────────────────────────────────
	// Day 100 — Phase 1 get_by_id surface fix. Convex mandates:get exists.
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"get_mandate",
		"Fetch a single spending mandate by its Convex document ID with limits, current spend, and approver chain. " +
			"WHEN: use when you have a mandateId from list_mandates and need the full record before validateSpending/settleMandate. " +
			"EXAMPLE: get_mandate mandateId='k57dy3049btafda9m2f5d2ggk987ph3f'.",
		{
			mandateId: mandateIdSchema.describe("Mandate document ID"),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get mandate",
		},
		async ({ mandateId }) => {
			try {
				// k177617dqg6z5c099p1rdp5rqn8b2rp0 / k174y9ra7pp8zed3bcczk6xaed8cpynp —
				// same carrier as list_mandates above: mandates rows carry
				// `requestedBy` AND `fulfilledBy`, not `createdBy`/`namespace`.
				// cloud-identity 0.5.0's `grantFields` consults both directly —
				// no createdBy-remap workaround needed.
				const row = (await convex.query("mandates:get" as any, {
					mandateId,
				})) as
					| (Record<string, unknown> & {
							createdBy?: string;
							namespace?: string;
							requestedBy?: string;
							fulfilledBy?: string;
					  })
					| null;
				const filtered = scopeFilterGet(oauthCtx ?? DENIED_SCOPE_CTX, row, [
					"requestedBy",
					"fulfilledBy",
				]);
				if (filtered === null) {
					return mcpError(`Mandate not found: ${mandateId}`);
				}
				return {
					content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_repo_mapping ────────────────────────────────────────────────────────
	// Day 100 — Phase 1 get_by_id surface fix. Convex githubRepoMapping:getByRepo exists.
	// Lookup key is `repo` (string e.g. "vantageos-agency/vantage-peers-plugin"), not a doc ID.

	// oracle-justified: a single-row lookup by repo key, so its verb (READ-GET) differs from
	//   list_repo_mappings (READ-LIST) by design; it is registered but not advertised in
	//   mcp-server/tool-exposure.json core (hors-MCP), whereas list_repo_mappings is advertised. Its isolation
	//   differs from remove_repo_mapping only in the tail of the guard: both scope by org in-handler
	//   (requireRowOwnedBy refuses a row the caller's org does not own); the read refuses an unresolved
	//   caller with requireResolvedCaller, the delete with requireScope("manage-repo-mappings").
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"get_repo_mapping",
		"Fetch a single GitHub repo→VP project mapping by repo slug (owner/name). " +
			"WHEN: use when you have a repo identifier (e.g. from a webhook or PR URL) and need the canonical VP project mapping. " +
			"EXAMPLE: get_repo_mapping repo='vantageos-agency/vantage-peers-plugin'.",
		{
			repo: z
				.string()
				.describe(
					"GitHub repo slug in owner/name form (e.g. 'vantageos-agency/vantage-peers-plugin')",
				),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get repo mapping",
		},
		async ({ repo }) => {
			try {
				const row = await convex.query("githubRepoMapping:getByRepo" as any, {
					repo,
				});
				// Class-sweep fix (mission vp-multitenant-zero-hole-v1, final 8):
				// githubRepoMapping rows (schema.ts:482) carry `orchestrator`, NOT
				// `createdBy` and NOT `namespace` -- scopeFilterGet finds nothing
				// to discriminate on and refuses EVERY non-master caller,
				// including the owner (refus-total). Remap orchestrator->createdBy
				// before scopeFilterGet, then strip the synthetic field back out.
				const rowWithCreatedBy =
					row == null
						? null
						: {
								...(row as Record<string, unknown>),
								createdBy: (row as Record<string, unknown>).orchestrator as
									| string
									| undefined,
							};
				const scoped = scopeFilterGet(
					oauthCtx ?? DENIED_SCOPE_CTX,
					rowWithCreatedBy as any,
				);
				const filtered =
					scoped == null
						? null
						: (() => {
								const { createdBy: _createdBy, ...rest } = scoped as Record<
									string,
									unknown
								>;
								return rest;
							})();
				if (filtered === null) {
					return mcpError(`Repo mapping not found: ${repo}`);
				}
				return {
					content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_message ─────────────────────────────────────────────────────────────
	// Day 100 — Phase 2b get_by_id surface fix (task k172735brsw6bc3j2dkkkfxqrx88kkjq).
	// Convex messages:getById landed in Phase 2a (PR #735, commit 2ebdaba).
	// Note: episodes were dropped from Phase 2b scope — episodes are stored as
	// memories with episode metadata (no separate table), use get_memory instead.
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"get_message",
		"Fetch a single peer message by its messageId: its full body, sender, channel, session day and organisation. " +
			"Returns the message row as JSON (content, from, fromInstanceId, channel, sessionDay, tenantId, createdAt): from is the sender, tenantId the organisation it was sent in; an ID you may not read returns 'Message not found'. " +
			"WHEN: use when you have a messageId from list_messages/check_messages and need the raw row (e.g. " +
			"for read-receipt audit, delete confirmation, or referencing in a fix pattern). " +
			"EXAMPLE: get_message messageId='jn7eg21wdaxzdcpdxwkvhaxqnh88jqg2'.",
		{
			messageId: messageIdSchema.describe("The message: its messageId as returned by send_message, list_messages or search_messages_by_keyword."),
		},
		{
			outputSchema: getMessageServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get message",
		},
		async ({ messageId }) => {
			try {
				// Tenant applied INSIDE the Convex read (`verifiedOrg`): a message of
				// another org is refused at the door and never reaches this process.
				const orgDenied = unresolvedOrgDenial("get_message");
				if (orgDenied !== null) return orgDenied;
				const row = await convex.query("messages:getById" as any, {
					messageId,
					...doorScopeArgs("messages:getById", undefined),
				});
				// Class-sweep fix (mission vp-multitenant-zero-hole-v1, final 8):
				// message rows (schema.ts:148) carry `from` (creatorValidator), NOT
				// `createdBy` and NOT `namespace` -- scopeFilterGet finds nothing to
				// discriminate on and refuses EVERY non-master caller, including
				// the sender (refus-total). Same remedy already applied to
				// list_messages/search_messages_by_keyword/list_broadcast_status,
				// but this single-row get was missed in that sweep: remap
				// from->createdBy before scopeFilterGet, then strip the synthetic
				// field back out.
				const rowWithCreatedBy =
					row == null
						? null
						: {
								...(row as Record<string, unknown>),
								createdBy: (row as Record<string, unknown>).from as
									| string
									| undefined,
							};
				const scoped = scopeFilterGet(
					oauthCtx ?? DENIED_SCOPE_CTX,
					rowWithCreatedBy as any,
				);
				const filtered =
					scoped == null
						? null
						: (() => {
								const { createdBy: _createdBy, ...rest } = scoped as Record<
									string,
									unknown
								>;
								return rest;
							})();
				if (filtered === null) {
					return mcpError(`Message not found: ${messageId}`);
				}
				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = filtered;
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_recurring_task ──────────────────────────────────────────────────────
	// Day 100 — Phase 2b get_by_id surface fix. Convex recurringTasks:getById
	// landed in Phase 2a (PR #735, commit 2ebdaba).
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"get_recurring_task",
		"Fetch one recurring task template by its ID. " +
			"Returns the stored template as JSON with every field it holds (title, description, assignedTo, priority, project, tags, cronExpression, active, nextRunAt, lastTaskId, skippedRuns, lastSkippedAt, lastSkipReason); an ID you may not read returns 'Recurring task not found'. " +
			"lastTaskId is the last task the schedule created; skippedRuns counts the consecutive runs that created nothing because that task was still open, and resets when a task is created. " +
			"WHEN: use when you hold a recurringTaskId and need its schedule, assignee and last run. " +
			"EXAMPLE: get_recurring_task recurringTaskId='k57dy3049btafda9m2f5d2ggk987ph3f'.",
		{
			recurringTaskId: recurringTaskIdSchema.describe(
				"The recurring template: its ID as returned by create_recurring_task or list_recurring_tasks.",
			),
		},
		{
			outputSchema: getRecurringTaskServedOutputSchema,
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get recurring task",
		},
		async ({ recurringTaskId }) => {
			try {
				const row = await convex.query("recurringTasks:getById" as any, {
					recurringTaskId,
				});
				const filtered = scopeFilterGet(oauthCtx ?? DENIED_SCOPE_CTX, row);
				if (filtered === null) {
					return mcpError(`Recurring task not found: ${recurringTaskId}`);
				}
				// The same object is the text (unchanged) and the structuredContent the
				// outputSchema validates (task k1793xkjhzh1xm23gmmwjgwfyx8htbv0).
				const structured: Record<string, unknown> = filtered;
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structured, null, 2) },
					],
					structuredContent: structured,
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── export_okf_bundle (T3 — OKF Phase 1) ────────────────────────────────────
	// Thin proxy to convex action `okfBundle:exportOkfBundle`. Registered last
	// so its argument schema does not pollute other tool handlers' closures.
	registerExportOkfBundle(server, convex, oauthCtx);

	// ── validate_okf_bundle (B1 — OKF Phase 2-A) ──────────────────────────────
	// Thin proxy to convex action `okfBundleNode:validateOkfBundle`. Read-only;
	// validates bundle conformance per RFC §3.5 without importing it. Mission
	// k5779qbxhwrfjmj02t31yvehns8911jp, task k1796g7g7y03gn9rd6z7psenk98910vt.
	registerValidateOkfBundle(server, convex);

	// ── import_okf_bundle (B2 — OKF Phase 2-B) ────────────────────────────────
	// Thin proxy to convex action `okfBundleNode:importOkfBundle`. Mutation;
	// imports memories+briefings+tasks into target namespace with dedup-by-content.
	// Mission k5779qbxhwrfjmj02t31yvehns8911jp, task k17fja9v7pgnf25yvzkwrj5ch5891bb3.
	registerImportOkfBundle(server, convex, oauthCtx);

	// ── store_document_chunked + soft_delete_document (B5 — KB ingest) ─────────
	// Thin proxies to convex actions `kb:storeDocumentChunked` and
	// `kb:softDeleteDocument`. Ingest pipeline: upload binary → text extract →
	// chunk → store at namespace team/<orgId>/<docId>. Requires Clerk JWT org_id.
	// Mission k5779qbxhwrfjmj02t31yvehns8911jp, task k17bdmhr2hffhz2t96p65j70nh891wcp.
	registerKbIngestTools(server, convex, oauthCtx);

	// ── improvisation_digest (PR-I — Bloc A T-GREEN) ──────────────────────────
	// Advisory scan of VP tasks+messages+memories for fleet/state claims without
	// source citation line (Eta heuristic, Pi-approved Option C).
	// Mission k571gcctka8mq5jbkgpj0a0b2n892ctg.
	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		IMPROVISATION_DIGEST_TOOL_NAME,
		IMPROVISATION_DIGEST_TOOL_DESCRIPTION,
		improvisationDigestArgsSchema.shape,
		{
			// readOnlyHint: true — improvisation_digest is a pure read query
			// (improvisationDigest:scanWindow — no mutations). ADVISORY-only.
			// READ_ONLY_TOOLS allowlist in chatgpt-tool-annotations.test.ts updated
			// in the same PR-I commit to include "improvisation_digest".
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Find uncited state claims",
		},
		async ({ windowDays, orchestrators }) => {
			try {
				const result = await convex.query(
					"improvisationDigest:scanWindow" as any,
					{ windowDays, orchestrators },
				);
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	const missingCoreNames = [...coreToolNames].filter(
		(name) => !allRegisteredNames.has(name),
	);
	if (missingCoreNames.length > 0) {
		throw new Error(
			`tool-exposure: core name(s) not found among registered tools: ${missingCoreNames.join(", ")}`,
		);
	}

	// The documents the linked tools name, on this same server, so every
	// `_meta.ui.resourceUri` advertised above resolves (HTTP and stdio alike).
	registerUiAppResources(server, options?.publicBaseUrl ?? null);
}
