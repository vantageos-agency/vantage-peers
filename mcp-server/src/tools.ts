/**
 * VantagePeers MCP Tool Registrations
 *
 * This module exports registerTools(server, convex) — a single function that
 * registers all 82 tools against any McpServer instance with a given
 * ConvexHttpClient. Both the stdio entry point (server.ts) and the HTTP entry
 * point (server-http.ts) call this function so tool definitions are never
 * duplicated.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { scopeFilterGet, scopeFilterList } from "@vantageos/cloud-identity";
import type { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
	checkDelegationAllowed,
	checkFromAllowed,
	checkNamespaceRead,
	checkNamespaceWrite,
	isMasterScope,
	type OAuthContext,
} from "./auth.js";
import { FreshStateGuardError, guardFreshState } from "./fresh-state-guard.js";
import { listTasksGate } from "./list-tasks-gate.js";
import { normalizeOrchestratorId } from "./normalizeOrchestratorId.js";
import { clampLimit, decodeCursor, encodeCursor } from "./paging.js";
import { defineTool, type ToolAuthContext } from "./registerTool.js";
import { resolveStateTokens, StateTokenError } from "./state-tokens.js";
import { registerExportOkfBundle } from "./tools/exportOkfBundle.js";
import { registerImportOkfBundle } from "./tools/importOkfBundle.js";
import { registerKbIngestTools } from "./tools/kbIngest.js";
import { registerValidateOkfBundle } from "./tools/validateOkfBundle.js";
import type { VpToolResult } from "./ui-resources/schemas.js";

import { wrapToolResult } from "./ui-resources/stream-marker.js";
import { validateTaskPayload } from "./validate-task-payload.js";

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
 * Measure a string's UTF-8 byte length and throw an McpError if it exceeds
 * MAX_CONTENT_BYTES. Returns the byte count on success so callers can reuse
 * it for observability in the catch path.
 *
 * @param content   The content string to measure.
 * @param toolName  Caller tool name (used only in the error message).
 */
export function assertContentSize(content: string, toolName: string): number {
	const contentBytes = new TextEncoder().encode(content).length;
	if (contentBytes > MAX_CONTENT_BYTES) {
		throw new McpError(
			ErrorCode.InvalidParams,
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
	const byteLen = Buffer.byteLength(rawText, "utf8");
	if (byteLen <= maxBytes) return rawText;
	if (!Array.isArray(items) || items.length === 0) return rawText;

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
	return JSON.stringify(envelope, null, 2);
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

const memoryTypeSchema = z
	.enum(["user", "feedback", "project", "reference", "episode"])
	.describe("Memory classification type");

export const creatorSchema = z
	.string()
	.describe(
		"Orchestrator role name (e.g. pi, tau, phi, sigma, omega, zeta, eta, kappa, alpha, lambda, victor, epsilon, omicron, upsilon, laurent, or any custom client role (lowercase string)). " +
			"New internal orchestrators use Greek letters (lowercase); external client orchestrators use free lowercase strings.",
	);

export const severitySchema = z
	.enum(["critical", "major", "minor"])
	.describe("Episode severity — critical = cross-orchestrator lesson");

export const flexArray = z.union([z.array(z.string()), z.string()]);
const flexArrayOptional = flexArray.optional();

// ─────────────────────────────────────────────────────────────────────────────
// list_components — exported description + args schema (PR-B envelope safety)
// ─────────────────────────────────────────────────────────────────────────────

export const LIST_COMPONENTS_TOOL_DESCRIPTION =
	"List registered components with optional filters and pagination. " +
	"Defaults: limit default 20, cap 200, fields=lite|full (default full). " +
	"Pagination via cursor (opaque token returned as nextCursor). " +
	"Use fields=lite to get compact projection {_id, name, type, team, _creationTime} (~3KB for 100 components). " +
	"EXAMPLE: list_components type='skill' team='development' limit=20 fields='lite'.";

export const listComponentsArgsSchema = z.object({
	type: z.enum(["agent", "skill", "hook", "plugin"]).optional(),
	team: z.string().optional(),
	limit: z.number().int().min(1).max(200).optional(),
	cursor: z.string().optional(),
	fields: z.enum(["lite", "full"]).optional(),
});

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
	"WHEN: use to check the backlog, review in-progress items, or audit a specific project's tasks. " +
	"EXAMPLE: list_tasks assignedTo='gamma' status='in_progress' project='vantage-peers' limit=20. " +
	"excludeAutoGenerated: when true, filters out cron-spawned tasks " +
	"(createdBy starts with `cron-` OR title matches the `/check-messages` polling pattern). " +
	"Use to keep Pi's queue clean from scheduler noise. " +
	"Default limit 20. cap 200.";

export const listTasksArgsSchema = z.object({
	assignedTo: z.string().optional().describe("Filter by assignee"),
	assignedToInstance: z
		.string()
		.optional()
		.describe(
			"Filter by instance — e.g. 'pi-vps'. Returns only tasks assigned to that instance.",
		),
	status: z
		.union([
			z.enum([
				"todo",
				"in_progress",
				"review",
				"blocked",
				"done",
				"cancelled",
				"open",
				"active",
				"all",
			]),
			z
				.array(
					z.enum([
						"todo",
						"in_progress",
						"review",
						"blocked",
						"done",
						"cancelled",
					]),
				)
				.min(1),
		])
		.optional()
		.describe("Filter by status (single, alias, or array)"),
	project: z.string().optional().describe("Filter by project name"),
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
		.describe('Field projection ("lite"|"full"). Default "lite" (v2.4.9+).'),
	createdBy: z
		.string()
		.optional()
		.describe("Filter by task creator (e.g. 'pi' to find Pi-dispatched tasks)"),
	updatedSince: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			"Unix timestamp (ms) — return only rows whose updatedAt >= this value.",
		),
	cursor: z
		.string()
		.optional()
		.describe(
			"S3.3 B8 — opaque pagination cursor from a prior call's `nextCursor`. " +
				"When set, fetches tasks strictly older than the cursor anchor (forward, newest-first).",
		),
	excludeAutoGenerated: z
		.boolean()
		.optional()
		.describe(
			"When true, filters out cron-spawned tasks " +
				"(createdBy starts with `cron-` OR title matches the `/check-messages` polling pattern). " +
				"Use to keep Pi's queue clean from scheduler noise.",
		),
});

// bulk_complete_tasks — exported name, description, and args schema (PR-F)
// ─────────────────────────────────────────────────────────────────────────────

export const BULK_COMPLETE_TASKS_TOOL_NAME = "bulk_complete_tasks";

export const BULK_COMPLETE_TASKS_TOOL_DESCRIPTION =
	"Bulk-close tasks that match a filter in one atomic mutation. " +
	"SAFETY: dryRun defaults to true — always preview first, then call again with dryRun=false to commit. " +
	"CAP + DRAIN (Day 163): maximum 500 tasks closed per call. If more than 500 match, the live call (dryRun=false) " +
	"closes the first 500 and returns `remaining: true` + `cappedAt: 500` instead of throwing — it does NOT refuse. " +
	"Because the scan only looks at NON-DONE tasks, the just-closed batch drops out of the next call's candidate " +
	"set automatically: RE-CALL WITH THE SAME FILTER repeatedly until the response has no `remaining` field " +
	"(count < 500, or 0) to drain the whole pile. No external purge script needed. " +
	"REDUCTIVE FILTER REQUIRED: at least one of autoGeneratedOnly=true, assignedTo=<name>, or status=<one open status> " +
	"must be set — an empty filter throws BULK_FILTER_TOO_BROAD. " +
	"STATUS FILTER: filter.status narrows the scan to a single open status ('todo'|'in_progress'|'review'|'blocked') " +
	"instead of sweeping all four — use it alongside autoGeneratedOnly/assignedTo to narrow further, or alone as its " +
	"own reductive predicate. " +
	"CALLER REQUIRED ON LIVE RUN: callerOrchestrator must be provided when dryRun=false — omitting it throws BULK_CALLER_REQUIRED. " +
	"PRIMARY USE CASE: cron-spam cleanup — marks auto-generated check-messages polling tasks as done so the backlog stays clean. " +
	"Cron detection (same contract as list_tasks excludeAutoGenerated): " +
	"createdBy starts with `cron-` (dash required — 'cronus'/'cron' pass through) OR title matches /^\\/?check-messages$/i (exact whole-string match). " +
	"EXAMPLE (preview): bulk_complete_tasks filter={autoGeneratedOnly:true} callerOrchestrator='system'. " +
	"EXAMPLE (commit): bulk_complete_tasks filter={autoGeneratedOnly:true} dryRun=false callerOrchestrator='system'. " +
	"EXAMPLE (narrow by status): bulk_complete_tasks filter={status:'todo'} dryRun=false callerOrchestrator='system'. " +
	"EXAMPLE (drain a > 500 pile): call bulk_complete_tasks filter={autoGeneratedOnly:true} dryRun=false callerOrchestrator='system' " +
	"repeatedly — each call closes up to 500 and reports `remaining: true` until the pile is gone. " +
	"Returns {count, sampleIds, bulkRunId, executedAt?, cappedAt?, remaining?} — bulkRunId is the Day-76 evidence token; " +
	"cappedAt + remaining:true are present together whenever the match count exceeded 500 on that call (dry-run preview " +
	"or live drain alike) — count is exact when neither field is present.";

export const bulkCompleteTasksArgsSchema = z.object({
	filter: z.object({
		autoGeneratedOnly: z.boolean().optional(),
		assignedTo: z.string().optional(),
		// Day 163 (k171rbm2txe42jxzddyqakbg7n8ch7zr) — mirrors the Convex
		// `bulkComplete` filter.status contract EXACTLY: the same four-value
		// open-status set the scan iterates over (todo/in_progress/review/
		// blocked — "done"/"cancelled" are terminal and never in-scope for a
		// close operation). Without this field the nested `filter` object
		// (not itself `.strict()` — only the TOP-LEVEL args object is, via
		// registerTool's buildStrictInputSchema) SILENTLY STRIPS an unknown
		// `status` key before the Convex mutation ever sees it.
		status: z.enum(["todo", "in_progress", "review", "blocked"]).optional(),
	}),
	dryRun: z.boolean().default(true),
	completionNoteTemplate: z.string().optional(),
	callerOrchestrator: z.string().optional(),
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
	"from/to are optional Unix ms bounds — omit both for an effectively unbounded window (defaults to epoch..now). " +
	"NEVER hides truncation: if the underlying scan hit its cap, `truncated: true` is returned — treat that as a signal to narrow the period and re-query, not as a complete total. " +
	"EXAMPLE: billing_summary_by_project project='vantage-immo' from=1783000000000 to=1783949200149. " +
	"Returns {byProject: [{project, totalMinutes, taskCount}], unattributedTaskCount, truncated}.";

export const billingSummaryByProjectArgsSchema = z.object({
	project: z
		.string()
		.optional()
		.describe(
			"Filter the result to a single project. Omit to return every project's totals.",
		),
	from: z
		.number()
		.int()
		.optional()
		.describe("Unix ms, inclusive period start. Omit for epoch (0)."),
	to: z
		.number()
		.int()
		.optional()
		.describe("Unix ms, inclusive period end. Omit for now (Date.now())."),
});

// ─────────────────────────────────────────────────────────────────────────────
// VP-Sources doctrine — search/recall tool descriptions (PR-H T-GREEN)
//
// Each of the 5 search/recall tools embeds both VP-Sources doctrine substrings
// so that client LLMs read the citation requirement inline at tool-list time.
// ─────────────────────────────────────────────────────────────────────────────

export const RECALL_TOOL_DESCRIPTION =
	"Semantic vector search over VantagePeers memories, ranked by cosine similarity. " +
	"WHEN: use at session start or before decisions — prefer over text_search for intent-based queries. " +
	"EXAMPLE: recall query='Pi feedback rules' namespace='global' type='feedback' limit=20.\n\n" +
	"VP-Sources doctrine: MUST be called before any factual claim about fleet state, audits, dette tooling, mission/task/client status, incident history, doctrine references.\n\n" +
	"Cite returned ids in the answer footer as 'VP-Sources: recall(\"<q>\")→[ids] | none-needed:<reason>'.";

export const HYBRID_SEARCH_TOOL_DESCRIPTION =
	"Combined vector + BM25 search via Reciprocal Rank Fusion for best semantic and keyword coverage. " +
	"WHEN: use when neither recall nor text_search alone yields good results — highest recall quality. " +
	"EXAMPLE: hybrid_search query='onboarding customer flow' namespace='project/vantage-peers' limit=20.\n\n" +
	"VP-Sources doctrine: MUST be called before any factual claim about fleet state, audits, dette tooling, mission/task/client status, incident history, doctrine references.\n\n" +
	"Cite returned ids in the answer footer as 'VP-Sources: recall(\"<q>\")→[ids] | none-needed:<reason>'.";

export const TEXT_SEARCH_TOOL_DESCRIPTION =
	"BM25 full-text keyword search over VantagePeers memories for exact term matching. " +
	"WHEN: use when recall returns too-broad results and you need a specific exact phrase or ID. " +
	"EXAMPLE: text_search query='Day 92 C3 descriptions' namespace='project/vantage-peers' limit=10.\n\n" +
	"VP-Sources doctrine: MUST be called before any factual claim about fleet state, audits, dette tooling, mission/task/client status, incident history, doctrine references.\n\n" +
	"Cite returned ids in the answer footer as 'VP-Sources: recall(\"<q>\")→[ids] | none-needed:<reason>'.";

export const LIST_BRIEFING_NOTES_TOOL_DESCRIPTION =
	"List briefing notes filtered by topic, newest first, with cursor paging support. " +
	"WHEN: use to review recent discussions on a topic or audit the full briefing history. " +
	"EXAMPLE: list_briefing_notes topic='architecture' limit=10 fields='lite'. " +
	"Default limit 20. cap 200.\n\n" +
	"VP-Sources doctrine: MUST be called before any factual claim about fleet state, audits, dette tooling, mission/task/client status, incident history, doctrine references.\n\n" +
	"Cite returned ids in the answer footer as 'VP-Sources: recall(\"<q>\")→[ids] | none-needed:<reason>'.";

export const SEARCH_BRIEFING_NOTES_BY_KEYWORD_TOOL_DESCRIPTION =
	"BM25 full-text keyword search over briefing note content, ranked by relevance. " +
	"WHEN: use to recall briefings about a topic/decision when list_briefing_notes filters are too coarse — e.g. 'find briefings about migration plan'. " +
	"EXAMPLE: search_briefing_notes_by_keyword query='migration plan' topic='daily' limit=10.\n\n" +
	"VP-Sources doctrine: MUST be called before any factual claim about fleet state, audits, dette tooling, mission/task/client status, incident history, doctrine references.\n\n" +
	"Cite returned ids in the answer footer as 'VP-Sources: recall(\"<q>\")→[ids] | none-needed:<reason>'.";

// ─────────────────────────────────────────────────────────────────────────────
// improvisation_digest — Zod schema + description (PR-I T-GREEN)
//
// Advisory-only read tool. Scans recent VP tasks + messages + memories for
// durable artifacts that carry fleet/state tokens (SHA / PR# / VP id /
// decisive verb) but NO VP-Sources footer — Eta heuristic proxy for
// "claimed fleet state without recall upstream".
//
// Pi-approved Option C (msg jn779tfjpg68v01db67b4ht20c189c8yw-class).
// Mission k571gcctka8mq5jbkgpj0a0b2n892ctg — Bloc A PR-I.
// ─────────────────────────────────────────────────────────────────────────────

export const IMPROVISATION_DIGEST_TOOL_NAME = "improvisation_digest";

export const IMPROVISATION_DIGEST_TOOL_DESCRIPTION =
	"Scan a rolling time window of VP tasks, messages, and memories for durable artifacts that carry fleet/state tokens (commit SHA, PR#, VP id, or decisive verb such as merged/deployed/approved) but have NO VP-Sources footer — Eta heuristic proxy for 'made a fleet-state claim without a recall upstream'. " +
	"Returns aggregated counts by orchestrator and category plus up to 50 sample snippets. " +
	"ADVISORY only — never blocks any action. " +
	"WHEN: use to audit a sprint window, review an orchestrator's improvisation rate, or calibrate VP-Sources compliance. " +
	"EXAMPLE: improvisation_digest windowDays=7 orchestrators=['sigma','pi'].";

export const improvisationDigestArgsSchema = z.object({
	windowDays: z
		.number()
		.default(7)
		.describe("Number of days to look back (default 7)"),
	orchestrators: z
		.array(z.string())
		.optional()
		.describe(
			"Scope to these orchestrator roles only — e.g. ['sigma','pi']. Omit for all.",
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
	"WHEN: use to add decisions, fix content, or relink memories — RBAC: caller must be createdBy or system. " +
	"EXAMPLE: update_briefing_note noteId='j57aaaaa...' callerOrchestrator='alpha' decisions=['Use hybrid_search first'].";

export const updateBriefingNoteSchema = z.object({
	noteId: noteIdSchema.describe(
		"Convex document ID of the briefing note to update",
	),
	callerOrchestrator: creatorSchema.describe(
		"Orchestrator role making the update — must match createdBy or be 'system' (RBAC deny-by-default)",
	),
	title: z.string().optional().describe("Optional new title — full replace"),
	topic: z.string().optional().describe("Optional new topic — full replace"),
	participants: z
		.array(z.string())
		.optional()
		.describe("Optional new participants array — full replace, not append"),
	content: z
		.string()
		.optional()
		.describe("Optional new content — full replace"),
	decisions: z
		.array(z.string())
		.optional()
		.describe("Optional new decisions array — full replace, not append"),
	linkedMemoryIds: z
		.array(memoryIdSchema)
		.optional()
		.describe(
			"Optional new linkedMemoryIds array — full replace, not append. " +
				"DISCLAIMER: Memory IDs only — NOT briefingNotes IDs or any other table. " +
				"Passing a briefingNotes ID causes ArgumentValidationError at path .linkedMemoryIds[N].",
		),
});

const assigneeSchema = z
	.string()
	.describe(
		"Orchestrator to assign to (e.g. pi, tau, phi, sigma, omega, zeta, eta, kappa, alpha, lambda, victor, epsilon, omicron, upsilon, laurent, or any custom client role (lowercase string)). " +
			"New internal orchestrators use Greek letters (lowercase); external client orchestrators use free lowercase strings.",
	);

const prioritySchema = z
	.enum(["urgent", "high", "medium", "low"])
	.describe("Task priority level");

const componentTypeSchema = z
	.enum(["agent", "skill", "hook", "plugin"])
	.describe("Component type");

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

// v2.3.2 — filter-only schemas: expose status aliases ("open"/"active"/"all")
// AND multi-status arrays to the MCP client. Backend (convex/tasks.ts +
// convex/missions.ts) handles alias expansion + array validation.
// Aliases NOT allowed inside arrays (matches backend rejection).
export const taskStatusFilterSchema = z
	.union([
		z.enum([...taskStatusValues, ...taskStatusAliases]),
		z.array(z.enum(taskStatusValues)).min(1),
	])
	.describe(
		'Task status filter. Single status ("todo"|"in_progress"|"review"|"blocked"|"done"|"cancelled"|"failed"), ' +
			'alias ("open" = todo+in_progress+review+blocked, "active" = todo+in_progress, "all" = no filter), ' +
			"or array of direct statuses (no aliases inside array).",
	);

export const missionStatusFilterSchema = z
	.union([
		z.enum([...missionStatusValues, ...missionStatusAliases]),
		z.array(z.enum(missionStatusValues)).min(1),
	])
	.describe(
		'Mission status filter. Single status ("brainstorm"|"plan"|"execute"|"validate"|"complete"), ' +
			'alias ("open" = brainstorm+plan+execute+validate, "active" = plan+execute, "all" = no filter), ' +
			"or array of direct statuses (no aliases inside array).",
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

export const whoamiOutputSchema = z.object({
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
	suggested_orchestrator_id: z
		.string()
		.nullable()
		.describe(
			"The canonical orchestrator ID to use as `from` in send_message / create_task / create_mission. " +
				"Derived from fromAllowList[0] (case preserved). " +
				"Null when no fromAllowList is configured (DCR client-generic or legacy bearer). " +
				"'master' for master-scope bearers (internal orchestrators only).",
		),
});

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
	namespace: z.string(),
	type: z.enum(["user", "feedback", "project", "reference", "episode"]),
	content: z.string(),
});

// soft_delete_memory
export const softDeleteMemoryOutputSchema = z.object({
	deleted: z.literal(true),
	memoryId: z.string(),
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
 * new capped object `{entries,total,truncated}`. Never throw on `.length`.
 */
export function asCappedStuckList(value: unknown): {
	entries: Array<{ taskId: string; title: string; age: number }>;
	total: number;
	truncated: boolean;
} {
	if (value == null) return { entries: [], total: 0, truncated: false };
	if (Array.isArray(value)) {
		return {
			entries: value as Array<{ taskId: string; title: string; age: number }>,
			total: value.length,
			truncated: false,
		};
	}
	if (typeof value === "object") {
		const o = value as Record<string, unknown>;
		const entries = Array.isArray(o.entries)
			? (o.entries as Array<{ taskId: string; title: string; age: number }>)
			: [];
		const total = typeof o.total === "number" ? o.total : entries.length;
		const truncated = o.truncated === true;
		return { entries, total, truncated };
	}
	return { entries: [], total: 0, truncated: false };
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
		nextCursor: z.string().nullable(),
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
		nextCursor: z.string().nullable(),
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

// register_component
export const registerComponentOutputSchema = z.record(z.string(), z.unknown());

// list_components
export const listComponentsOutputSchema = z.union([
	z.array(z.record(z.string(), z.unknown())),
	z.object({
		items: z.array(z.record(z.string(), z.unknown())),
		nextCursor: z.string().nullable(),
	}),
]);

// get_component
export const getComponentOutputSchema = z
	.record(z.string(), z.unknown())
	.nullable();

// update_component
export const updateComponentOutputSchema = z.object({
	componentId: z.string(),
	updated: z.literal(true),
});

// delete_component
export const deleteComponentOutputSchema = z.record(z.string(), z.unknown());

// search_components
export const searchComponentsOutputSchema = z.array(
	z.record(z.string(), z.unknown()),
);

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
		nextCursor: z.string().nullable(),
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
		nextCursor: z.string().nullable(),
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

export function registerTools(
	server: McpServer,
	convex: ConvexHttpClient,
	oauthCtx?: OAuthContext,
): void {
	// Intercept EVERY server.tool(...) / server.registerTool(...) call made
	// below (directly or through defineTool()/registerExportOkfBundle()/
	// registerImportOkfBundle()/registerKbIngestTools()/
	// registerValidateOkfBundle() — they all receive this same `server`
	// instance) so only CORE names are actually advertised.
	//
	// Both entry points are intercepted because defineTool() registers
	// through `server.registerTool(name, config, cb)` (the config-object API,
	// not the deprecated positional `server.tool(...)` overload) — this is
	// the Day-159 incident fix: a `.strict()` Zod schema instance fails the
	// legacy `tool()` overload's raw-shape/annotations disambiguation and
	// crashes the server at boot (see registerTool.ts `defineTool` doc
	// comment). `registerTool` accepts a schema instance directly. Any
	// call site still using the legacy `.tool(...)` overload is masked too,
	// so this interception layer holds regardless of which entry point a
	// given registration helper uses.
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
	const realTool = server.tool.bind(server);
	// biome-ignore lint/suspicious/noExplicitAny: narrowing the overloaded McpServer#tool signature for interception.
	(server as any).tool = (name: string, ...rest: unknown[]) => {
		// @ts-expect-error — forwarding to the real overloaded signature.
		const registered = realTool(name, ...rest);
		return maskIfNotCore(name, registered);
	};
	const realRegisterTool = server.registerTool.bind(server);
	// biome-ignore lint/suspicious/noExplicitAny: narrowing the overloaded McpServer#registerTool signature for interception.
	(server as any).registerTool = (name: string, ...rest: unknown[]) => {
		// @ts-expect-error — forwarding to the real overloaded signature.
		const registered = realRegisterTool(name, ...rest);
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
	const guardFrom = (from: string) => {
		const err = checkFromAllowed(oauthCtx, from);
		return err ? mcpError(err) : null;
	};
	// Delegation guard — distinct question from guardFrom (identity CLAIM).
	// Applies ONLY to the ASSIGNEE (delegation target): is `assignedTo` a
	// member of the CALLER's own organisation? Membership is read from DATA
	// (convex/orgRoster.ts getMyOrgRoster for Clerk JWT, getForAccessToken
	// for a provisioned OAuth token — org derived from the token row, never
	// an org argument), never a list hard-coded here. Master scope
	// short-circuits inside checkDelegationAllowed without querying Convex.
	const guardDelegation = async (assignedTo: string) => {
		const err = await checkDelegationAllowed(oauthCtx, assignedTo, async () => {
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
		});
		return err ? mcpError(err) : null;
	};
	const guardRead = (namespace: string | undefined) => {
		const err = checkNamespaceRead(oauthCtx, namespace);
		return err ? mcpError(err) : null;
	};
	const guardWrite = (namespace: string) => {
		const err = checkNamespaceWrite(oauthCtx, namespace);
		return err ? mcpError(err) : null;
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

	// Auth context threaded into every defineTool registration. The wrapper reads
	// the declared scope and applies the SAME shared predicates the in-handler
	// guards use (checkNamespace*/checkFromAllowed/isMasterScope), so migrated
	// tools are behavior-identical — the pre-check duplicates a gate the handler
	// still runs. See registerTool.ts.
	const authCtx: ToolAuthContext = { oauthCtx };

	// ── store_memory ────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "createdBy" },
		"store_memory",
		"Store a typed memory entry (user/feedback/project/reference) in VantagePeers with optional graph relations. " +
			"WHEN: use after any decision, rule, or lesson that must persist across sessions. " +
			"EXAMPLE: store_memory namespace='global' type='feedback' content='Alpha prefers concise replies' createdBy='beta'.",
		{
			namespace: z
				.string()
				.describe(
					"Memory namespace — e.g. 'global', 'orchestrator/pi', 'project/vantage-starter'",
				),
			type: memoryTypeSchema,
			content: z
				.string()
				.describe("Human-readable memory content — what the memory says"),
			createdBy: creatorSchema,
			relatesTo: z
				.object({
					targetId: memoryIdSchema.describe(
						"ID of the memory this relates to (Convex document ID)",
					),
					type: z
						.enum(["updates", "extends", "derives"])
						.describe(
							"Relation type: updates=supersedes, extends=adds detail, derives=inference",
						),
				})
				.optional()
				.describe("Optional graph relation to another memory"),
			ttl: z
				.string()
				.optional()
				.describe("Optional expiry ISO timestamp e.g. '2026-06-01T00:00:00Z'"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Store memory",
		},
		async ({ namespace, type, content, createdBy, relatesTo, ttl }) => {
			let contentBytes = 0;
			try {
				contentBytes = assertContentSize(content, "store_memory");

				const fromDenied = guardFrom(createdBy);
				if (fromDenied) return fromDenied;
				const nsDenied = guardWrite(namespace);
				if (nsDenied) return nsDenied;

				const relations = relatesTo
					? [{ targetId: relatesTo.targetId as any, type: relatesTo.type }]
					: [];

				const memoryId = await convex.mutation("memories:storeMemory" as any, {
					namespace,
					type,
					content,
					createdBy,
					relations,
					ttl,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ memoryId, namespace, type, content },
								null,
								2,
							),
						},
					],
				};
			} catch (error: any) {
				if (error instanceof McpError) throw error;
				console.error("[store_memory] mutation failed", {
					contentBytes,
					namespace,
					type,
					createdBy,
					errorMessage: error?.message ?? String(error),
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
			"WHEN: use to retire an outdated fact or superseded rule without permanent data loss. " +
			"EXAMPLE: soft_delete_memory memoryId='j57dy3049btafda9m2f5d2ggk987ph3f'.",
		{
			memoryId: memoryIdSchema.describe(
				"Convex document ID of the memory to soft-delete",
			),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: true,
			title: "Delete memory (soft)",
		},
		async ({ memoryId }) => {
			try {
				const denied = guardMasterOnly("soft_delete_memory");
				if (denied) return denied;

				await convex.mutation("memories:softDeleteMemory" as any, {
					memoryId,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ deleted: true, memoryId }, null, 2),
						},
					],
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
		"Fetch a single memory by its Convex document ID, including relations and episode metadata. " +
			"WHEN: use when you have a specific memoryId from a prior recall/store and need the full record. " +
			"EXAMPLE: get_memory memoryId='j57dy3049btafda9m2f5d2ggk987ph3f'.",
		{
			memoryId: memoryIdSchema.describe("Memory document ID"),
		},
		{
			readOnlyHint: true,
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
				return {
					content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
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
				.describe("Natural language query to search for relevant memories"),
			namespace: z
				.string()
				.optional()
				.describe("Filter to a specific namespace — omit to search all"),
			type: memoryTypeSchema
				.optional()
				.describe("Filter to a specific memory type — omit to search all"),
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
					"'lite' returns compact payload (less tokens), 'full' is default. v2.4.9+.",
				),
		},
		{
			readOnlyHint: true,
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
			query: z.string().describe("Search query text"),
			namespace: z
				.string()
				.optional()
				.describe("Namespace filter (e.g. 'global', 'project/my-project')"),
			type: memoryTypeSchema.optional().describe("Filter by memory type"),
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
					"'lite' returns compact payload (less tokens), 'full' is default. v2.4.9+.",
				),
		},
		{
			readOnlyHint: true,
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
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── hybrid_search ───────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "read", namespaceArg: "namespace" },
		"hybrid_search",
		HYBRID_SEARCH_TOOL_DESCRIPTION,
		{
			query: z.string().describe("Search query text"),
			namespace: z.string().optional().describe("Namespace filter"),
			type: memoryTypeSchema.optional().describe("Filter by memory type"),
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
					"'lite' returns compact payload (less tokens), 'full' is default. v2.4.9+.",
				),
			vectorWeight: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.describe("Weight for vector results in RRF (default: 0.5)"),
			textWeight: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.describe("Weight for text results in RRF (default: 0.5)"),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Search memories (hybrid)",
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
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── store_episode ───────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "createdBy" },
		"store_episode",
		"Store a structured episodic memory capturing context, goal, action, outcome, and insight from a past event. " +
			"WHEN: use after completing a non-trivial task or encountering an unexpected failure or success. " +
			"EXAMPLE: store_episode namespace='orchestrator/alpha' createdBy='alpha' severity='major' context='...' goal='...' action='...' outcome='...' insight='...'.",
		{
			namespace: z
				.string()
				.describe("Memory namespace — e.g. 'orchestrator/pi'"),
			createdBy: creatorSchema,
			context: z
				.string()
				.describe("Situation that triggered this episode — what was the setup"),
			goal: z.string().describe("What was being attempted"),
			action: z.string().describe("What was actually done"),
			outcome: z.string().describe("What happened — success or failure"),
			insight: z
				.string()
				.describe(
					"The lesson extracted — procedural memory, what to do differently",
				),
			severity: severitySchema,
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Store episode",
		},
		async ({
			namespace,
			createdBy,
			context,
			goal,
			action,
			outcome,
			insight,
			severity,
		}) => {
			try {
				const fromDenied = guardFrom(createdBy);
				if (fromDenied) return fromDenied;
				const nsDenied = guardWrite(namespace);
				if (nsDenied) return nsDenied;

				const memoryId = await convex.mutation("episodes:storeEpisode" as any, {
					namespace,
					createdBy,
					context,
					goal,
					action,
					outcome,
					insight,
					severity,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ memoryId, type: "episode", severity, namespace },
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
		"Fetch a single episode by its memory document ID. Episodes are memories with type='episode' carrying context/goal/action/outcome/insight + severity. " +
			"WHEN: use when you have an episodeId from store_episode or a prior search and need the full record. " +
			"EXAMPLE: get_episode episodeId='j57dy3049btafda9m2f5d2ggk987ph3f'.",
		{
			episodeId: episodeIdSchema.describe("Episode (memory) document ID"),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get episode",
		},
		async ({ episodeId }) => {
			try {
				const memory = await convex.query("memories:getMemory" as any, {
					memoryId: episodeId,
				});
				const filtered = scopeFilterGet(oauthCtx ?? DENIED_SCOPE_CTX, memory);
				if (filtered === null) {
					return mcpError(`Episode not found: ${episodeId}`);
				}
				if ((filtered as any)?.type !== "episode") {
					return mcpError(`Episode not found: ${episodeId}`);
				}
				return {
					content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
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
			"WHEN: use to enumerate episodes by namespace or creator before recall/audit. " +
			"EXAMPLE: list_episodes namespace='orchestrator/sigma' limit=20. " +
			"Default limit 20. cap 200.",
		{
			namespace: z
				.string()
				.optional()
				.describe("Filter to a specific namespace — omit to list across all"),
			createdBy: z
				.string()
				.optional()
				.describe("Filter by creator role (e.g. 'sigma', 'pi')"),
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
					"'lite' returns compact payload (less tokens), 'full' is default.",
				),
			cursor: z
				.string()
				.optional()
				.describe(
					"S3.3 B8 — opaque pagination cursor from a prior call's `nextCursor`.",
				),
		},
		{
			readOnlyHint: true,
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

				const text = capListResponseBytes(
					filteredList,
					JSON.stringify(envelope, null, 2),
					"list_episodes",
				);

				return {
					content: [{ type: "text", text }],
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
			"WHEN: use when search_episodes_by_semantic returns too-broad results and you need an exact phrase or ID inside an episode field. " +
			"EXAMPLE: search_episodes_by_keyword query='convex deploy schema' namespace='orchestrator/sigma' limit=10.",
		{
			query: z.string().describe("Search query text"),
			namespace: z
				.string()
				.optional()
				.describe("Namespace filter (e.g. 'orchestrator/sigma')"),
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
					"'lite' returns compact payload (less tokens), 'full' is default.",
				),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Search episodes by keyword (BM25)",
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
			"WHEN: use to recall structured past events by intent — failure modes, lessons, similar contexts. " +
			"EXAMPLE: search_episodes_by_semantic query='hook false positive blocked publish' namespace='orchestrator/sigma' limit=20.",
		{
			query: z
				.string()
				.describe("Natural language query to search for relevant episodes"),
			namespace: z
				.string()
				.optional()
				.describe("Filter to a specific namespace — omit to search all"),
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
					"'lite' returns compact payload (less tokens), 'full' is default.",
				),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Search episodes by semantic (vector cosine)",
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
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_profile ─────────────────────────────────────────────────────────────

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
			"WHEN: use to check peer status, capabilities, or current task before assigning work. " +
			"EXAMPLE: get_profile orchestratorId='gamma'.",
		{
			orchestratorId: z.string().describe("Orchestrator identifier"),
		},
		{
			readOnlyHint: true,
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

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "orchestratorId" },
		"update_profile",
		"Create or update an orchestrator profile with static identity facts and dynamic session state. " +
			"WHEN: call on each session start to update lastSeen/sessionCount, or when role/capabilities change. " +
			"EXAMPLE: update_profile orchestratorId='alpha' dynamic={lastSeen: Date.now(), sessionCount: 5}.",
		{
			orchestratorId: z.string().describe("Orchestrator identifier"),
			name: z.string().optional().describe("Human-readable orchestrator name"),
			static: z
				.object({
					role: z.string().describe("Orchestrator role description"),
					workspace: z.string().describe("Primary working directory"),
					capabilities: z
						.array(z.string())
						.describe("List of capability keywords"),
				})
				.optional()
				.describe("Stable identity facts — infrequently updated"),
			dynamic: z
				.object({
					currentTask: z
						.string()
						.optional()
						.describe("Current task or goal in progress"),
					lastSeen: z
						.number()
						.describe("Unix timestamp (ms) of last session start"),
					sessionCount: z.number().int().describe("Total sessions to date"),
				})
				.optional()
				.describe("Mutable session state — updated each session"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Update orchestrator profile",
		},
		async ({ orchestratorId, name, static: staticFields, dynamic }) => {
			try {
				const fromDenied = guardFrom(orchestratorId);
				if (fromDenied) return fromDenied;

				const profileId = await convex.mutation(
					"profiles:upsertProfile" as any,
					{
						orchestratorId,
						name,
						static: staticFields,
						dynamic,
					},
				);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ profileId, orchestratorId, name },
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

	// ── list_memories ───────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "read", namespaceArg: "namespace" },
		"list_memories",
		"List active (isLatest=true) memories for a namespace, ordered newest first. " +
			"WHEN: use to audit what a namespace contains or to paginate all entries without a query. " +
			"EXAMPLE: list_memories namespace='project/vantage-peers' type='project' limit=20. " +
			"Default limit 20. cap 200.",
		{
			namespace: z
				.string()
				.describe(
					"Namespace to list memories from — e.g. 'global', 'orchestrator/pi'",
				),
			type: memoryTypeSchema
				.optional()
				.describe("Filter to a specific type — omit to return all types"),
			createdBy: assigneeSchema
				.optional()
				.describe(
					"Filter by creator/orchestrator role — mirrors list_tasks pattern for cross-tool consistency.",
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
					"'lite' returns compact payload (less tokens), 'full' is default. v2.4.9+.",
				),
			cursor: z
				.string()
				.optional()
				.describe(
					"S3.3 B8 — opaque pagination cursor from a prior call's `nextCursor`. " +
						"When set, forwards Convex `paginationOpts.cursor` to fetch the next page.",
				),
		},
		{
			readOnlyHint: true,
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

				const baseText = capListResponseBytes(
					filteredList,
					JSON.stringify(filteredEnvelope, null, 2),
					"list_memories",
				);
				const text = appendMarkerIfEnabled(baseText, () => ({
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
		"Send a message to one, many, or all orchestrators via channel routing (broadcast / role DM / instance DM). " +
			"WHEN: use to notify peers of task completion, handoff, or decision; creates one receipt per recipient. " +
			"EXAMPLE: send_message from='alpha' channel='beta' content='C3 descriptions PR ready for review'.",
		{
			from: creatorSchema.describe(
				"Sender role (e.g. pi, tau, phi, sigma, omega, zeta, eta, kappa, alpha, lambda, victor, epsilon, omicron, upsilon, or any custom role)",
			),
			fromInstanceId: z
				.string()
				.optional()
				.describe("Sender instance ID — e.g. 'pi-chromebook', 'tau-vps-1'"),
			channel: z
				.string()
				.describe(
					"Recipients: 'broadcast' | 'tau' | 'pi-vps' | 'tau,phi' (comma-separated)",
				),
			content: z.string().describe("Message content"),
			sessionDay: z
				.number()
				.int()
				.optional()
				.describe(
					"Day number (e.g. 88 for Day 88). If omitted, auto-derived from project epoch " +
						"(Day 1 = 2026-03-06 UTC). Pass explicitly to override.",
				),
			tenantId: z
				.string()
				.optional()
				.describe("Tenant identifier for multi-tenant isolation"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Send message",
		},
		async ({
			from,
			fromInstanceId,
			channel,
			content,
			sessionDay,
			tenantId,
		}) => {
			let contentBytes = 0;
			try {
				const fromDenied = guardFrom(from);
				if (fromDenied) return fromDenied;

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
						throw new McpError(
							ErrorCode.InvalidParams,
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
						throw new McpError(
							ErrorCode.InvalidParams,
							`ÉTAT PÉRIMÉ — send_message aborted, nothing was sent: ${guardError.message}`,
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
				const normFrom = normalizeOrchestratorId(from);
				const normChannel =
					channel === "broadcast" || channel.includes(",")
						? channel
						: normalizeOrchestratorId(channel);
				const messageId = await convex.mutation("messages:sendMessage" as any, {
					from: normFrom,
					fromInstanceId,
					channel: normChannel,
					content: resolvedContent,
					sessionDay: derivedSessionDay,
					tenantId,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								unverified.length > 0
									? { messageId, from, channel, stateUnverified: unverified }
									: { messageId, from, channel },
								null,
								2,
							),
						},
					],
				};
			} catch (error: any) {
				if (error instanceof McpError) throw error;
				console.error("[send_message] mutation failed", {
					contentBytes,
					from,
					channel,
					errorMessage: error?.message ?? String(error),
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
			"WHEN: call at session start and after long pauses to drain the inbox before starting work. " +
			"EXAMPLE: check_messages recipient='gamma' recipientInstanceId='gamma-vps'.",
		{
			recipient: creatorSchema.describe(
				"Orchestrator role (e.g. pi, tau, phi, sigma, omega, zeta, eta, kappa, alpha, lambda, victor, epsilon, omicron, upsilon, or any custom role)",
			),
			recipientInstanceId: z
				.string()
				.optional()
				.describe(
					"Instance ID — e.g. 'pi-chromebook'. Gets instance + role messages.",
				),
			tenantId: z
				.string()
				.optional()
				.describe("Filter messages to this tenant only"),
			since: z
				.number()
				.int()
				.optional()
				.describe(
					"Unix timestamp (ms). If provided, only messages with _creationTime > since are returned. Use for incremental polling — pass the timestamp of your last check to get only new messages. Omit for full unread backlog. Pair with the `nextSince` value returned in a previous truncated reply to page the backlog.",
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(50)
				.optional()
				.describe(
					"Max messages per call (1-50, default 20). Pair with `since=nextSince` from a previous truncated reply to page the backlog without hitting Claude Code's tool-response cap.",
				),
		},
		{
			readOnlyHint: true,
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
					// Raw .includes() was exact-match only, rejecting "HELIOS" when
					// fromAllowList contained "Helios". Now both sides are normalized.
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

				const result = await convex.query(
					"messages:checkNewMessagesEnvelope" as any,
					{
						recipient,
						recipientInstanceId,
						tenantId,
						since,
						limit,
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

	// ── mark_as_read ────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"mark_as_read",
		"Mark one or more message receipts as read using receiptIds from check_messages. " +
			"WHEN: call immediately after processing each batch of messages returned by check_messages. " +
			"EXAMPLE: mark_as_read receiptIds=['j57aaaaa...', 'j57bbbbb...'] callerOrchestrator='pi'.",
		{
			receiptIds: z
				.union([z.array(receiptIdSchema).min(1), receiptIdSchema])
				.describe("Receipt IDs to mark as read — array or single string"),
			callerOrchestrator: creatorSchema
				.optional()
				.describe(
					"Orchestrator marking its own receipts as read — required for scoped (non-master) OAuth clients; enforced fleet-wide against each receipt's recipient in messages:markAsRead",
				),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Mark messages as read",
		},
		async ({ receiptIds, callerOrchestrator }) => {
			try {
				let receiptIdsArray: string[];
				if (Array.isArray(receiptIds)) {
					receiptIdsArray = receiptIds;
				} else if (
					typeof receiptIds === "string" &&
					receiptIds.startsWith("[")
				) {
					try {
						receiptIdsArray = JSON.parse(receiptIds);
					} catch {
						receiptIdsArray = [receiptIds];
					}
				} else {
					receiptIdsArray = [receiptIds as string];
				}
				const count = await convex.mutation("messages:markAsRead" as any, {
					receiptIds: receiptIdsArray,
					callerOrchestrator,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ markedAsRead: count }, null, 2),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── delete_message ──────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"delete_message",
		"Delete a message and all its receipts; only the original sender or system may delete. " +
			"WHEN: use to retract a mistaken broadcast or sensitive content before recipients read it. " +
			"EXAMPLE: delete_message messageId='j57dy3049btafda9m2f5d2ggk987ph3f' callerOrchestrator='alpha'.",
		{
			messageId: messageIdSchema.describe(
				"Convex document ID of the message to delete",
			),
			callerOrchestrator: creatorSchema
				.optional()
				.describe("Optional RBAC — must be the sender or system"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: true,
			title: "Delete message",
		},
		async ({ messageId, callerOrchestrator }) => {
			try {
				if (callerOrchestrator) {
					const fromDenied = guardFrom(callerOrchestrator);
					if (fromDenied) return fromDenied;
				}

				const result = await convex.mutation("messages:deleteMessage" as any, {
					messageId: messageId as any,
					callerOrchestrator,
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

	// ── set_summary ─────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "orchestratorId" },
		"set_summary",
		"Update the current-work summary for an orchestrator instance, visible via list_peers. " +
			"WHEN: call at the start of each session and after major context switches to keep peers informed. " +
			"EXAMPLE: set_summary orchestratorId='alpha' instanceId='alpha-vps' summary='Standardizing 86 tool descriptions for B2'.",
		{
			orchestratorId: z.string().describe("Orchestrator role"),
			instanceId: z
				.string()
				.optional()
				.describe("Instance ID — e.g. 'pi-chromebook', 'pi-vps', 'tau-vps-1'"),
			summary: z.string().describe("1-2 sentence summary of current work"),
			endOfDayIndex: z
				.string()
				.optional()
				.describe(
					"Durable end-of-day index (close-day step 9 only) — kept separate " +
						"from `summary` so the next daily-start's live-status write does " +
						"not clobber it. Omit for normal live-status updates.",
				),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Set instance summary",
		},
		async ({ orchestratorId, instanceId, summary, endOfDayIndex }) => {
			try {
				const fromDenied = guardFrom(orchestratorId);
				if (fromDenied) return fromDenied;

				await convex.mutation("profiles:updateDynamic" as any, {
					orchestratorId,
					instanceId,
					currentTask: summary,
					endOfDayIndex,
					lastSeen: Date.now(),
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ orchestratorId, instanceId, summary },
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

	// ── list_peers ──────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"list_peers",
		"List all orchestrator profiles with current status, summary, and session info, newest first. " +
			"WHEN: use before assigning work or sending a DM to confirm who is active and what they are doing. " +
			"EXAMPLE: list_peers limit=20 fields='lite'. " +
			"Default limit 20. cap 200.",
		{
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
					"'lite' returns compact payload (less tokens), 'full' is default. v2.4.9+.",
				),
			cursor: z
				.string()
				.optional()
				.describe(
					"S3.3 B8 follow-up — opaque pagination cursor from a prior call's `nextCursor`. " +
						"Decoded to `createdBefore` (newest-first forward pagination over profiles._creationTime).",
				),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List peers",
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

				// S3.1.B Wave B — scope-aware filter replaces guardMasterOnly.
				// Master + legacy bearer pass through unchanged. Non-master clients
				// see only profiles whose createdBy ∈ fromAllowList OR whose namespace
				// matches one of namespaceReadPrefixes (exact or '/' boundary).
				const profiles = await convex.query("profiles:listProfiles" as any, {
					limit: effectiveLimit ?? 20,
					fields: fields ?? "lite",
					createdBefore,
				});

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
				const requestedLimit = effectiveLimit ?? 20;
				let nextCursor: string | null = null;
				if (peers.length >= requestedLimit && peers.length > 0) {
					const last = peers[peers.length - 1] as {
						_creationTime?: number;
					};
					if (typeof last._creationTime === "number") {
						nextCursor = encodeCursor({ createdBefore: last._creationTime });
					}
				}
				const peersWithCursor =
					nextCursor !== null ? { items: peers, nextCursor } : peers;

				return {
					content: [
						{
							type: "text",
							text: capListResponseBytes(
								peersWithCursor,
								JSON.stringify(peersWithCursor, null, 2),
								"list_peers",
							),
						},
					],
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
			"WHEN: use for audit, recap, or debugging a specific day's message traffic. " +
			"EXAMPLE: list_messages sessionDay=92 from='alpha' limit=20.",
		{
			sessionDay: z
				.number()
				.int()
				.optional()
				.describe("Filter to a specific day"),
			from: creatorSchema.optional().describe("Filter by sender"),
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
					"'lite' returns compact payload (less tokens), 'full' is default. v2.4.9+.",
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

				// S3.1.B Wave B — scope-aware filter replaces guardMasterOnly.
				// Master + legacy bearer pass through unchanged. Non-master clients
				// see only messages whose createdBy ∈ fromAllowList OR whose namespace
				// matches one of namespaceReadPrefixes (exact or '/' boundary).
				const messages = await convex.query("messages:listMessages" as any, {
					sessionDay,
					from,
					limit: effectiveLimit ?? 20,
					fields: fields ?? "lite",
					createdBefore,
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

				// S3.3 B8 follow-up — emit nextCursor when page is full.
				const requestedLimit = effectiveLimit ?? 20;
				let nextCursor: string | null = null;
				if (
					filteredMessages.length >= requestedLimit &&
					filteredMessages.length > 0
				) {
					const last = filteredMessages[filteredMessages.length - 1] as {
						_creationTime?: number;
					};
					if (typeof last._creationTime === "number") {
						nextCursor = encodeCursor({ createdBefore: last._creationTime });
					}
				}
				const messagesWithCursor =
					nextCursor !== null
						? { items: filteredMessages, nextCursor }
						: filteredMessages;

				const baseText = capListResponseBytes(
					messagesWithCursor,
					JSON.stringify(messagesWithCursor, null, 2),
					"list_messages",
				);
				const text = appendMarkerIfEnabled(baseText, () => ({
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
			"WHEN: use for post-incident audit or to find peer DMs by topic — e.g. 'find messages about deploy' across the recent sessionDay window. " +
			"EXAMPLE: search_messages_by_keyword query='convex deploy' from='pi' sessionDay=102 limit=10.",
		{
			query: z
				.string()
				.describe("Search term to match against message content"),
			from: z.string().optional().describe("Filter by sender role"),
			channel: z
				.string()
				.optional()
				.describe("Filter by channel — e.g. 'sigma', 'broadcast'"),
			sessionDay: z
				.number()
				.int()
				.optional()
				.describe("Filter to a specific session day"),
			tenantId: z.string().optional().describe("Filter by tenant id"),
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
					"'lite' returns compact payload (less tokens), 'full' is default.",
				),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Search messages by keyword (BM25)",
		},
		async ({ query, from, channel, sessionDay, tenantId, limit, fields }) => {
			try {
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
			"WHEN: use after send_message to confirm all recipients acknowledged a critical announcement. " +
			"EXAMPLE: list_broadcast_status messageId='j57dy3049btafda9m2f5d2ggk987ph3f'. " +
			"Default limit 20. cap 200.",
		{
			messageId: messageIdSchema.describe(
				"Convex document ID of the broadcast message",
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
					"'lite' returns compact payload (less tokens), 'full' is default. v2.4.9+.",
				),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "List broadcast status",
		},
		async ({ messageId, limit, fields }) => {
			try {
				// S3.1.C1 — scope-aware filter replaces guardMasterOnly.
				const status = await convex.query(
					"messages:listBroadcastStatus" as any,
					{
						messageId,
						limit: limit ?? 20,
						fields: fields ?? "lite",
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

				const responsePayload = {
					...envelope,
					receipts: filteredReceipts,
				};

				// Deliberately NOT routed through capListResponseBytes: that helper
				// truncates a bare array and rewraps it as `{_meta, items}`, which
				// would silently swap this tool's envelope shape for a different one
				// under byte pressure — its own instance of the "shape surprise"
				// class this fix closes. `limit` (capped at 200 by the arg schema)
				// plus `truncated` already give the caller an explicit, honest
				// truncation signal without changing the response shape.
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(responsePayload, null, 2),
						},
					],
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
			"WHEN: use to delegate work, track a deliverable, or instantiate a step from a mission plan. " +
			"EXAMPLE: create_task title='Standardize tool descriptions' assignedTo='beta' priority='high' createdBy='alpha'.",
		{
			title: z.string().describe("Task title"),
			description: z.string().optional().describe("Detailed task description"),
			project: z
				.string()
				.optional()
				.describe("Project name — e.g. 'vantage-starter', 'perfect-ai-agent'"),
			tags: flexArrayOptional.describe("Optional tags for categorization"),
			assignedTo: assigneeSchema,
			assignedToInstance: z
				.string()
				.optional()
				.describe(
					"Instance-level assignment — e.g. 'pi-vps', 'tau-chromebook'. Optional.",
				),
			priority: prioritySchema,
			status: taskStatusSchema.default("todo"),
			dependsOn: z
				.array(taskIdSchema)
				.optional()
				.describe("Task IDs that must be completed before this task can start"),
			missionId: missionIdSchema
				.optional()
				.describe("Convex document ID of the parent mission"),
			estimatedMinutes: z
				.number()
				.optional()
				.describe("Estimated duration in minutes"),
			dueDate: z
				.number()
				.optional()
				.describe("Optional due date as Unix timestamp (ms)"),
			createdBy: creatorSchema,
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Create task",
		},
		async ({
			title,
			description,
			project,
			tags,
			assignedTo,
			assignedToInstance,
			priority,
			status,
			dependsOn,
			missionId,
			estimatedMinutes,
			dueDate,
			createdBy,
		}) => {
			try {
				const fromDenied = guardFrom(createdBy);
				if (fromDenied) return fromDenied;
				const assigneeDenied = await guardDelegation(assignedTo);
				if (assigneeDenied) return assigneeDenied;

				// C2: normalize orchestrator-id fields at write time (B2 §6+§7).
				const taskId = await convex.mutation("tasks:create" as any, {
					title,
					description,
					project,
					tags: toArray(tags),
					assignedTo: normalizeOrchestratorId(assignedTo),
					assignedToInstance,
					priority,
					status,
					dependsOn: toArray(dependsOn) as any,
					missionId: missionId as any,
					estimatedMinutes,
					dueDate,
					createdBy: normalizeOrchestratorId(createdBy),
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ taskId, title, assignedTo, priority, status },
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

	// ── list_tasks ──────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"no in-handler row scoping yet — listTasksGate validates a caller-supplied assignedTo/createdBy against fromAllowList but does NOT restrict returned rows (returns all rows when no filter is passed); row scoping tracked in k17fcxngeyrfpsh8xrp0fzz9xh8dfkq8",
		},
		"list_tasks",
		LIST_TASKS_TOOL_DESCRIPTION,
		listTasksArgsSchema.shape,
		{
			readOnlyHint: true,
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
				// orchestrators identify as "Helios"/"Clio"/etc., never as the
				// profile name "helios-acme-hr". Fix mirrors check_messages
				// L1383-1399 pattern (commit 24b39c5). Regression: 28db616.
				{
					const gateErr = listTasksGate(oauthCtx, assignedTo, createdBy);
					if (gateErr !== null) return mcpError(gateErr);
				}

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
				// Clamp caller limit through paging contract (zod already caps at 200).
				const effectiveLimit =
					limit === undefined ? undefined : clampLimit(limit);

				const tasks = await convex.query("tasks:list" as any, {
					assignedTo,
					assignedToInstance,
					status,
					project,
					limit: effectiveLimit ?? 20,
					fields: fields ?? "lite",
					createdBy,
					updatedSince,
					createdBefore,
					excludeAutoGenerated,
				});

				// Build nextCursor from the last row's _creationTime when the
				// page is full (heuristic — caller can keep paging until empty).
				const requestedLimit = effectiveLimit ?? 20;
				const tasksArr = Array.isArray(tasks) ? tasks : [];
				let nextCursor: string | null = null;
				if (tasksArr.length >= requestedLimit && tasksArr.length > 0) {
					const last = tasksArr[tasksArr.length - 1] as {
						_creationTime?: number;
					};
					if (typeof last._creationTime === "number") {
						nextCursor = encodeCursor({ createdBefore: last._creationTime });
					}
				}
				const tasksWithCursor =
					nextCursor !== null ? { items: tasksArr, nextCursor } : tasks;

				const baseText = capListResponseBytes(
					tasksWithCursor,
					JSON.stringify(tasksWithCursor, null, 2),
					"list_tasks",
				);
				const text = appendMarkerIfEnabled(baseText, () => ({
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
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── bulk_complete_tasks ─────────────────────────────────────────────────────
	// PR-F — bulk close cron-spam tasks in one mutation. dryRun=true by default.

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"claimed callerOrchestrator identity is guarded MCP-side (guardFrom) before dispatch; tasks:bulkComplete then scopes matched tasks against that verified identity",
		},
		BULK_COMPLETE_TASKS_TOOL_NAME,
		BULK_COMPLETE_TASKS_TOOL_DESCRIPTION,
		bulkCompleteTasksArgsSchema.shape,
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Bulk complete tasks",
		},
		async ({ filter, dryRun, completionNoteTemplate, callerOrchestrator }) => {
			try {
				// k179nrp3apj700pm0h1ckewm2h8b3nz7 — the "filtered" declaration above
				// claimed enforcement lives in tasks:bulkComplete, but that Convex
				// handler only checks ownership of MATCHED TASKS against a
				// client-SUPPLIED callerOrchestrator — it never verifies the caller
				// claiming that identity actually IS it. A scoped (non-master) OAuth
				// client could pass any other orchestrator's name and bulk-close
				// that orchestrator's tasks. Mirrors delete_message (tools.ts
				// ~3157-3181): guard the claimed identity against the caller's own
				// fromAllowList before the mutation runs.
				if (callerOrchestrator) {
					const fromDenied = guardFrom(callerOrchestrator);
					if (fromDenied) return fromDenied;
				}

				const result = await convex.mutation("tasks:bulkComplete" as any, {
					filter,
					dryRun,
					completionNoteTemplate,
					callerOrchestrator,
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
			"WHEN: use to find tasks by topic/keyword when list_tasks filters are too broad — e.g. 'find tasks about hook' across all assignees. " +
			"EXAMPLE: search_tasks_by_keyword query='hook PostToolUse' status='todo' limit=10.",
		{
			query: z.string().describe("Search term to match against task title"),
			assignedTo: z.string().optional().describe("Filter by assignee role"),
			status: z
				.enum(["todo", "in_progress", "review", "blocked", "done"])
				.optional()
				.describe("Filter by status"),
			project: z.string().optional().describe("Filter by project name"),
			missionId: missionIdSchema
				.optional()
				.describe("Filter by mission Convex ID"),
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
					"'lite' returns compact payload (less tokens), 'full' is default.",
				),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Search tasks by keyword (BM25)",
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
					},
				);
				// k174y9ra7pp8zed3bcczk6xaed8cpynp — mirror get_task/list_tasks:
				// `assignedTo` is a per-row grant (convex/tasks.ts L88-89 ORs
				// createdBy===caller || assignedTo===caller), so a non-creator
				// assignee must still see their own task in search results.
				const filteredFull = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					Array.isArray(results)
						? (results as Array<Record<string, unknown>>)
						: [],
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

	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		BILLING_SUMMARY_BY_PROJECT_TOOL_NAME,
		BILLING_SUMMARY_BY_PROJECT_TOOL_DESCRIPTION,
		billingSummaryByProjectArgsSchema.shape,
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Billing summary by project",
		},
		async ({ project, from, to }) => {
			try {
				const result: any = await convex.query(
					"tasks:billingSummaryByProject" as any,
					{
						startDate: from ?? 0,
						endDate: to ?? Date.now(),
						...(project !== undefined ? { project } : {}),
					},
				);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									byProject: result.byProject,
									unattributedTaskCount: result.unattributedTaskCount,
									invalidDurationTaskCount: result.invalidDurationTaskCount,
									truncated: result.truncated,
								},
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

	// ── update_task ─────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"update_task",
		"Update any mutable field on a task; only provided fields are patched, updatedAt auto-set. " +
			"WHEN: use to reassign, reprioritize, or add context to an existing task without recreating it. " +
			"EXAMPLE: update_task taskId='k178d3ns...' status='review' callerOrchestrator='alpha'.",
		{
			taskId: taskIdSchema.describe("Convex document ID of the task to update"),
			title: z.string().optional().describe("New title"),
			description: z.string().optional().describe("New description"),
			project: z.string().optional().describe("New project"),
			tags: flexArrayOptional.describe("New tags"),
			assignedTo: assigneeSchema.optional().describe("Reassign to"),
			priority: prioritySchema.optional().describe("New priority"),
			status: updateTaskStatusSchema.optional(),
			dependsOn: z
				.array(taskIdSchema)
				.optional()
				.describe("Task IDs that must be completed before this task can start"),
			missionId: missionIdSchema
				.optional()
				.describe("Link to a mission (Convex document ID)"),
			estimatedMinutes: z
				.number()
				.optional()
				.describe("Estimated duration in minutes"),
			actualMinutes: z
				.number()
				.optional()
				.describe("Actual duration in minutes"),
			startedAt: z.number().optional().describe("When work started (Unix ms)"),
			completedAt: z
				.number()
				.optional()
				.describe("When work completed (Unix ms)"),
			dueDate: z.number().optional().describe("New due date (Unix ms)"),
			callerOrchestrator: creatorSchema
				.optional()
				.describe("Optional RBAC — if provided, must be creator or assignee"),
			cancelReason: z
				.string()
				.optional()
				.describe(
					"Mandatory when status='cancelled': non-empty reason. Only the task's " +
						"creator (or 'system') may set status='cancelled'; callerOrchestrator " +
						"must be the creator.",
				),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Update task",
		},
		async ({
			taskId,
			title,
			description,
			project,
			tags,
			assignedTo,
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
		}) => {
			try {
				if (callerOrchestrator) {
					const fromDenied = guardFrom(callerOrchestrator);
					if (fromDenied) return fromDenied;
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
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ taskId, updated: true }, null, 2),
						},
					],
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
			"WHEN: call when all deliverables are committed or verified — never complete without a proof token in the note. " +
			"EXAMPLE: complete_task taskId='k178d3ns...' completionNote='PR #667 merged, 86 descriptions updated' callerOrchestrator='beta'.",
		{
			taskId: taskIdSchema.describe(
				"Convex document ID of the task to complete",
			),
			completionNote: z
				.string()
				.describe("What was actually done — summary of work completed"),
			callerOrchestrator: creatorSchema
				.optional()
				.describe("Optional RBAC — if provided, must be creator or assignee"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Complete task",
		},
		async ({ taskId, completionNote, callerOrchestrator }) => {
			try {
				if (callerOrchestrator) {
					const fromDenied = guardFrom(callerOrchestrator);
					if (fromDenied) return fromDenied;
				}

				await convex.mutation("tasks:complete" as any, {
					taskId: taskId as any,
					completionNote,
					callerOrchestrator,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ taskId, status: "done" }, null, 2),
						},
					],
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
		"Mark a task as failed (a terminal state distinct from done/cancelled) with a mandatory failureNote " +
			"describing how the work ended. WHEN: use when the work was genuinely attempted and did not succeed " +
			'— never call complete_task to close out failed work, and never call update_task with status="failed" ' +
			"(refused server-side; this tool is the only door). A task already done/cancelled cannot be re-terminated as failed. " +
			"EXAMPLE: fail_task taskId='k178d3ns...' failureNote='Migration errored on row 4102, rolled back cleanly' callerOrchestrator='beta'.",
		{
			taskId: taskIdSchema.describe("Convex document ID of the task to fail"),
			failureNote: z
				.string()
				.describe("How the work ended in failure — mandatory, non-empty"),
			callerOrchestrator: creatorSchema
				.optional()
				.describe("Optional RBAC — if provided, must be creator or assignee"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Fail task",
		},
		async ({ taskId, failureNote, callerOrchestrator }) => {
			try {
				if (callerOrchestrator) {
					const fromDenied = guardFrom(callerOrchestrator);
					if (fromDenied) return fromDenied;
				}

				await convex.mutation("tasks:failTask" as any, {
					taskId: taskId as any,
					failureNote,
					callerOrchestrator,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ taskId, status: "failed" }, null, 2),
						},
					],
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
			"WHEN: call as the first action when picking up a task to signal activity and enable metrics. " +
			"EXAMPLE: start_task taskId='k178d3ns...' callerOrchestrator='gamma'.",
		{
			taskId: taskIdSchema.describe("Convex document ID of the task to start"),
			callerOrchestrator: creatorSchema
				.optional()
				.describe("Optional RBAC — if provided, must be creator or assignee"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Start task",
		},
		async ({ taskId, callerOrchestrator }) => {
			try {
				if (callerOrchestrator) {
					const fromDenied = guardFrom(callerOrchestrator);
					if (fromDenied) return fromDenied;
				}

				await convex.mutation("tasks:start" as any, {
					taskId: taskId as any,
					callerOrchestrator,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ taskId, status: "in_progress" }, null, 2),
						},
					],
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
			"WHEN: use before start_task in multi-orchestrator queues to ensure exclusive ownership. " +
			"EXAMPLE: checkout_task taskId='k178d3ns...' callerOrchestrator='alpha' callerInstance='alpha-vps'.",
		{
			taskId: taskIdSchema.describe("Convex document ID of the task to claim"),
			callerOrchestrator: creatorSchema.describe(
				"Orchestrator claiming the task (e.g. sigma, pi)",
			),
			callerInstance: z
				.string()
				.optional()
				.describe("Instance identifier, e.g. 'sigma-vps'"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Checkout task",
		},
		async ({ taskId, callerOrchestrator, callerInstance }) => {
			try {
				const fromDenied = guardFrom(callerOrchestrator);
				if (fromDenied) return fromDenied;

				const result = await convex.mutation("tasks:checkout" as any, {
					taskId: taskId as any,
					callerOrchestrator,
					callerInstance,
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

	// ── delete_task ─────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"delete_task",
		"Permanently delete a task; only the creator or system role may delete. " +
			"WHEN: use to remove erroneously created tasks or test artifacts — prefer complete_task for real work. " +
			"EXAMPLE: delete_task taskId='k178d3ns...' callerOrchestrator='alpha'.",
		{
			taskId: taskIdSchema.describe("Convex document ID of the task to delete"),
			callerOrchestrator: creatorSchema
				.optional()
				.describe("Optional RBAC — must be creator or system"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: true,
			title: "Delete task",
		},
		async ({ taskId, callerOrchestrator }) => {
			try {
				if (callerOrchestrator) {
					const fromDenied = guardFrom(callerOrchestrator);
					if (fromDenied) return fromDenied;
				}

				const result = await convex.mutation("tasks:deleteTask" as any, {
					taskId: taskId as any,
					callerOrchestrator,
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

	// ── block_task ──────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"block_task",
		"Mark a task as blocked with an optional reason and blocking task IDs, setting status to blocked. " +
			"WHEN: use when external dependency or missing input prevents progress — record the specific blocker. " +
			"A block is a commitment, not just a journal entry: cite blockedOnTaskId (a live task owned by " +
			"someone else) so the responder is charged to unblock you, OR mark the reason with " +
			"'# blocked-on-nobody: <reason>' when nobody in the fleet owns the obstacle. " +
			"Pass blockedCause to say WHAT you are waiting on ('human' — an operator decision/answer; " +
			"'authorisation' — a merge/publish/approval gate; 'peer_task' — a plain upstream dependency; " +
			"'other' if none apply) so waiting-on state is derivable, never a free-text guess. " +
			"EXAMPLE: block_task taskId='k178d3ns...' blockedOnTaskId='k17bbbbb...' blockedCause='authorisation' reason='Waiting for B2 PR#667 merge' callerOrchestrator='beta'.",
		{
			taskId: taskIdSchema.describe("Convex document ID of the task to block"),
			reason: z.string().optional().describe("Why the task is blocked"),
			blockedBy: z
				.array(taskIdSchema)
				.optional()
				.describe("Task IDs that are blocking this task"),
			blockedOnTaskId: taskIdSchema
				.optional()
				.describe(
					"The live task (assigned to someone else) this task waits on. Required unless " +
						"reason contains an explicit '# blocked-on-nobody: <reason>' marker.",
				),
			blockedCause: blockedCauseSchema.describe(
				"WHAT is being waited on — 'peer_task' | 'human' | 'authorisation' | 'other'. " +
					"Optional; omission defaults to 'other' server-side. This is the structured signal " +
					"the waiting-on state is derived from — never pass a state string directly.",
			),
			callerOrchestrator: creatorSchema
				.optional()
				.describe("Optional RBAC — must be creator or assignee"),
		},
		{
			readOnlyHint: false,
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
				if (callerOrchestrator) {
					const fromDenied = guardFrom(callerOrchestrator);
					if (fromDenied) return fromDenied;
				}

				const blockArgs: Record<string, any> = {
					taskId: taskId as any,
				};
				if (reason) blockArgs.reason = reason;
				if (blockedOnTaskId) blockArgs.blockedOnTaskId = blockedOnTaskId as any;
				if (blockedCause) blockArgs.blockedCause = blockedCause;
				if (callerOrchestrator)
					blockArgs.callerOrchestrator = callerOrchestrator;

				await convex.mutation("tasks:blockTask" as any, blockArgs);

				if (blockedBy && blockedBy.length > 0) {
					await convex.mutation("tasks:update" as any, {
						taskId: taskId as any,
						dependsOn: blockedBy.map((id: string) => id as any),
						...(callerOrchestrator ? { callerOrchestrator } : {}),
					});
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									taskId,
									status: "blocked",
									reason,
									blockedOnTaskId,
									blockedCause: blockedCause ?? "other",
								},
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

	// ── add_task_dependency ─────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"add_task_dependency",
		"Add dependency task IDs to a task so it cannot start until all listed tasks complete. " +
			"WHEN: use when creating a task that depends on prior work not yet captured in dependsOn. " +
			"EXAMPLE: add_task_dependency taskId='k178d3ns...' dependsOn=['k17bbbbb...'] callerOrchestrator='alpha'.",
		{
			taskId: taskIdSchema.describe(
				"Convex document ID of the task that depends on others",
			),
			dependsOn: z
				.array(taskIdSchema)
				.describe("Task IDs that must complete first"),
			callerOrchestrator: creatorSchema
				.optional()
				.describe("Optional RBAC — must be creator or assignee"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Add task dependency",
		},
		async ({ taskId, dependsOn, callerOrchestrator }) => {
			try {
				if (callerOrchestrator) {
					const fromDenied = guardFrom(callerOrchestrator);
					if (fromDenied) return fromDenied;
				}

				const updateArgs: Record<string, any> = {
					taskId: taskId as any,
					dependsOn: dependsOn.map((id: string) => id as any),
				};
				if (callerOrchestrator)
					updateArgs.callerOrchestrator = callerOrchestrator;

				await convex.mutation("tasks:update" as any, updateArgs);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ taskId, dependsOn, updated: true },
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
			"WHEN: use to review mission progress or find blocked/open tasks within a specific mission. " +
			"EXAMPLE: list_tasks_by_mission missionId='k57a36y8...' status='in_progress' limit=20. " +
			"Default limit 20. cap 200.",
		{
			missionId: missionIdSchema.describe("Convex document ID of the mission"),
			status: taskStatusFilterSchema
				.optional()
				.describe("Filter by task status (single, alias, or array)"),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.describe("Max items to return. Default 20 (envelope-safe). Cap 200."),
			fields: fieldsSchema
				.optional()
				.describe('Field projection ("lite"|"full")'),
			createdBy: assigneeSchema.optional().describe("Filter by task creator"),
			updatedSince: updatedSinceSchema.optional(),
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
				const tasks = await convex.query("tasks:listByMission" as any, {
					missionId: missionId as any,
					status,
					limit: effectiveLimit ?? 20,
					fields: fields ?? "lite",
					createdBy,
					updatedSince,
					createdBefore,
				});

				// k174y9ra7pp8zed3bcczk6xaed8cpynp — mirror get_task: `assignedTo`
				// is a per-row grant (convex/tasks.ts L88-89 ORs createdBy||assignedTo).
				const filteredTasks = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					Array.isArray(tasks) ? tasks : [],
					["assignedTo"],
				);

				// S3.3 B8 follow-up — emit nextCursor when page is full.
				const requestedLimit = effectiveLimit ?? 20;
				let nextCursor: string | null = null;
				if (
					filteredTasks.length >= requestedLimit &&
					filteredTasks.length > 0
				) {
					const last = filteredTasks[filteredTasks.length - 1] as {
						_creationTime?: number;
					};
					if (typeof last._creationTime === "number") {
						nextCursor = encodeCursor({ createdBefore: last._creationTime });
					}
				}
				const tasksWithCursor =
					nextCursor !== null
						? { items: filteredTasks, nextCursor }
						: filteredTasks;

				return {
					content: [
						{
							type: "text",
							text: capListResponseBytes(
								tasksWithCursor,
								JSON.stringify(tasksWithCursor, null, 2),
								"list_tasks_by_mission",
							),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── create_mission ──────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "createdBy" },
		"create_mission",
		"Create a mission grouping related tasks under a project with a pilot orchestrator and agent list. " +
			"WHEN: use when starting a multi-task initiative that needs lifecycle tracking and progress reporting. " +
			"EXAMPLE: create_mission name='Day 92 C3' project='vantage-peers' pilot='alpha' agents=['beta','gamma'] priority='high' createdBy='alpha'.",
		{
			name: z.string().describe("Mission name"),
			description: z.string().optional().describe("Mission description"),
			project: z
				.string()
				.describe("Project name — e.g. 'my-project', 'shared'"),
			status: missionStatusSchema.default("brainstorm"),
			priority: prioritySchema,
			pilot: creatorSchema.describe("Lead orchestrator for this mission"),
			agents: flexArray.describe("List of agent names involved"),
			brief: z.string().optional().describe("Mission brief / instructions"),
			startDate: z.number().optional().describe("Planned start date (Unix ms)"),
			targetDate: z
				.number()
				.optional()
				.describe("Target completion date (Unix ms)"),
			progress: z.number().optional().describe("Progress percentage (0-100)"),
			createdBy: creatorSchema,
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Create mission",
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
				const fromDenied = guardFrom(createdBy);
				if (fromDenied) return fromDenied;
				const pilotDenied = guardFrom(pilot);
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
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ missionId, name, project, pilot, status },
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
			"WHEN: use to audit active missions, find missions by pilot, or check cross-project progress. " +
			"EXAMPLE: list_missions project='vantage-peers' status='execute' pilot='alpha' limit=20. " +
			"Default limit 20. cap 200.",
		{
			project: z.string().optional().describe("Filter by project name"),
			pilot: creatorSchema.optional().describe("Filter by pilot orchestrator"),
			status: missionStatusFilterSchema
				.optional()
				.describe("Filter by status (single, alias, or array)"),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.describe("Max items to return. Default 20 (envelope-safe). Cap 200."),
			fields: fieldsSchema
				.optional()
				.describe(
					'Field projection ("lite"|"full"). Default "lite" (v2.4.9+).',
				),
			updatedSince: updatedSinceSchema.optional(),
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

				const baseText = capListResponseBytes(
					missionsWithCursor,
					JSON.stringify(missionsWithCursor, null, 2),
					"list_missions",
				);
				const text = appendMarkerIfEnabled(baseText, () => ({
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
			"WHEN: use before assigning tasks or reporting to get the canonical mission state. " +
			"EXAMPLE: get_mission missionId='k57a36y8w5t085bqr23dsmvb2d882506'.",
		{
			missionId: missionIdSchema.describe("Convex document ID of the mission"),
		},
		{
			readOnlyHint: true,
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
		{ kind: "from", fromArg: "pilot" },
		"update_mission",
		"Update any mutable field on a mission; only provided fields are patched, updatedAt auto-set. " +
			"WHEN: use to advance status, update progress percentage, or change pilot/agents mid-flight. " +
			"EXAMPLE: update_mission missionId='k57a36y8...' progress=75 status='validate'.",
		{
			missionId: missionIdSchema.describe(
				"Convex document ID of the mission to update",
			),
			name: z.string().optional().describe("New name"),
			description: z.string().optional().describe("New description"),
			project: z.string().optional().describe("New project"),
			status: missionStatusSchema.optional().describe("New status"),
			priority: prioritySchema.optional().describe("New priority"),
			pilot: creatorSchema.optional().describe("New pilot"),
			agents: flexArrayOptional.describe("New agents list"),
			brief: z.string().optional().describe("New brief"),
			startDate: z.number().optional().describe("New start date (Unix ms)"),
			targetDate: z.number().optional().describe("New target date (Unix ms)"),
			progress: z.number().optional().describe("New progress (0-100)"),
			callerOrchestrator: creatorSchema
				.optional()
				.describe(
					"Required when status='cancelled': must be the mission's creator (or 'system').",
				),
			cancelReason: z
				.string()
				.optional()
				.describe(
					"Mandatory when status='cancelled': non-empty reason. Only the mission's " +
						"creator (or 'system') may set status='cancelled'.",
				),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Update mission",
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
					const pilotDenied = guardFrom(pilot);
					if (pilotDenied) return pilotDenied;
				}
				if (callerOrchestrator) {
					const fromDenied = guardFrom(callerOrchestrator);
					if (fromDenied) return fromDenied;
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
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ missionId, updated: true }, null, 2),
						},
					],
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
		"Change a mission's lifecycle status in a single call without touching other fields. " +
			"WHEN: use as a lightweight alternative to update_mission when only the status changes. " +
			"EXAMPLE: update_mission_status missionId='k57a36y8...' status='complete'.",
		{
			missionId: missionIdSchema.describe("Convex document ID of the mission"),
			status: missionStatusSchema.describe("New status"),
		},
		{
			readOnlyHint: false,
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

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ missionId, status }, null, 2),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── write_diary ─────────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "orchestrator" },
		"write_diary",
		"Write or upsert a diary entry for a specific date and orchestrator with highlights and blockers. " +
			"WHEN: call at end of session to record what was accomplished, learned, and what blocked progress. " +
			"EXAMPLE: write_diary date='2026-06-06' orchestrator='gamma' content='Standardized 86 descriptions...'.",
		{
			date: z.string().describe("ISO date string — e.g. '2026-03-25'"),
			orchestrator: creatorSchema.describe("Which orchestrator is writing"),
			content: z.string().describe("Full diary entry content"),
			highlights: flexArrayOptional.describe("Key highlights of the day"),
			blockers: flexArrayOptional.describe("Blockers encountered"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Write diary entry",
		},
		async ({ date, orchestrator, content, highlights, blockers }) => {
			let contentBytes = 0;
			try {
				contentBytes = assertContentSize(content, "write_diary");

				const fromDenied = guardFrom(orchestrator);
				if (fromDenied) return fromDenied;

				// v2.4.8: derive createdBy from auth context (oauthCtx.userId).
				// This is the anti-spoof authored-by — distinct from orchestrator
				// (writer-intent label, client-supplied). On the no-auth path
				// (master-scope bearer / local dev), oauthCtx is undefined and
				// createdBy gracefully degrades to undefined (transition period).
				const createdBy: string | undefined = oauthCtx?.userId;

				const diaryId = await convex.mutation("diary:write" as any, {
					date,
					orchestrator,
					content,
					highlights: toArray(highlights),
					blockers: toArray(blockers),
					createdBy,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ diaryId, date, orchestrator }, null, 2),
						},
					],
				};
			} catch (error: any) {
				if (error instanceof McpError) throw error;
				console.error("[write_diary] mutation failed", {
					contentBytes,
					date,
					orchestrator,
					errorMessage: error?.message ?? String(error),
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
			"WHEN: use to review what an orchestrator did on a given day for recap or handoff briefing. " +
			"EXAMPLE: get_diary date='2026-06-06' orchestrator='alpha'.",
		{
			date: z.string().describe("ISO date string — e.g. '2026-03-25'"),
			orchestrator: creatorSchema.describe(
				"Which orchestrator's diary to fetch",
			),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get diary entry",
		},
		async ({ date, orchestrator }) => {
			try {
				// S3.1.C1 — scope-aware filter replaces guardMasterOnly.
				const entry = await convex.query("diary:get" as any, {
					date,
					orchestrator,
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
			"WHEN: use to review recent history across sessions or audit a period of activity. " +
			"EXAMPLE: list_diaries orchestrator='beta' limit=10 fields='lite'. " +
			"Default limit 20. cap 200.",
		{
			orchestrator: creatorSchema
				.optional()
				.describe("Filter to a specific orchestrator — omit for all"),
			createdBy: assigneeSchema
				.optional()
				.describe(
					"Filter by auth-derived author (v2.4.8+, anti-spoof). Distinct from `orchestrator` which is the writer-intent label. Pre-v2.4.8 entries are backfilled with orchestrator as best-guess.",
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
					"'lite' returns compact payload (less tokens), 'full' is default. v2.4.9+.",
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

				const entries = await convex.query("diary:list" as any, {
					orchestrator,
					createdBy,
					limit: effectiveLimit ?? 20,
					fields: fields ?? "lite",
					createdBefore,
				});

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

				return {
					content: [
						{
							type: "text",
							text: capListResponseBytes(
								entriesWithCursor,
								JSON.stringify(entriesWithCursor, null, 2),
								"list_diaries",
							),
						},
					],
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
		"Create a structured briefing note capturing a topic discussion with participants, decisions, and memory links. " +
			"WHEN: use after key architectural, product, or operational discussions to record decisions durably. " +
			"EXAMPLE: create_briefing_note title='C3 desc standard' topic='architecture' participants=['alpha','beta'] content='...' createdBy='gamma'.",
		{
			title: z.string().describe("Briefing note title"),
			topic: z
				.string()
				.describe("Topic category — e.g. 'architecture', 'revenue', 'product'"),
			participants: z
				.union([z.array(z.string()), z.string()])
				.describe("Who participated — e.g. ['pi', 'sigma'] or 'pi'"),
			content: z.string().describe("Full briefing content"),
			decisions: flexArrayOptional.describe(
				"Decisions made during the briefing",
			),
			linkedMemoryIds: z
				.array(memoryIdSchema)
				.optional()
				.describe(
					"Convex document IDs of related memories — each must be a 32-char ID from the memories table, NOT briefingNotes or any other table. " +
						"DISCLAIMER: Memory IDs only. Do NOT pass briefingNotes IDs here — they share the same 32-char alphanumeric format but belong to a different table. " +
						"Passing a briefingNotes ID will fail with ArgumentValidationError at path .linkedMemoryIds[N]. " +
						"If cross-linking briefings is needed, request the linkedBriefingIds feature instead.",
				),
			createdBy: creatorSchema,
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Create briefing note",
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

				const fromDenied = guardFrom(createdBy);
				if (fromDenied) return fromDenied;

				const noteId = await convex.mutation("briefingNotes:create" as any, {
					title,
					topic,
					participants: toArray(participants) as string[],
					content,
					decisions: toArray(decisions),
					linkedMemoryIds: toArray(linkedMemoryIds) as string[],
					createdBy,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ noteId, title, topic, createdBy },
								null,
								2,
							),
						},
					],
				};
			} catch (error: any) {
				if (error instanceof McpError) throw error;
				console.error("[create_briefing_note] mutation failed", {
					contentBytes,
					fromOrchestrator: createdBy,
					topic,
					title,
					errorMessage: error?.message ?? String(error),
				});
				return mcpConvexError(error);
			}
		},
	);

	// ── update_briefing_note ────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "callerOrchestrator" },
		"update_briefing_note",
		updateBriefingNoteDescription,
		updateBriefingNoteSchema.shape,
		{
			readOnlyHint: false,
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

				const fromDenied = guardFrom(callerOrchestrator);
				if (fromDenied) return fromDenied;

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

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ noteId, updated: true }, null, 2),
						},
					],
				};
			} catch (error: any) {
				if (error instanceof McpError) throw error;
				console.error("[update_briefing_note] mutation failed", {
					contentBytes,
					callerOrchestrator,
					noteId,
					errorMessage: error?.message ?? String(error),
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
		"Fetch a single briefing note by ID with all fields: title, topic, participants, content, decisions, and links. " +
			"WHEN: use when you have a specific noteId and need the full structured record for a handoff or recap. " +
			"EXAMPLE: get_briefing_note noteId='j57dy3049btafda9m2f5d2ggk987ph3f'.",
		{
			noteId: noteIdSchema.describe("Briefing note document ID"),
		},
		{
			readOnlyHint: true,
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
				const note = await convex.query("briefingNotes:get" as any, {
					noteId,
					master,
					callerIdentities,
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
				return {
					content: [{ type: "text", text: JSON.stringify(note, null, 2) }],
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
				.describe("Filter to a specific topic — omit for all"),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.describe("Max items to return. Default 20 (envelope-safe). Cap 200."),
			fields: fieldsSchema
				.optional()
				.describe(
					'Field projection ("lite"|"full"). Default "lite" (v2.4.9+).',
				),
			updatedSince: updatedSinceSchema.optional(),
			cursor: z
				.string()
				.optional()
				.describe(
					"S3.3 B8 — opaque pagination cursor from a prior call's `nextCursor`. " +
						"Decoded to `createdBefore` (newest-first forward pagination).",
				),
		},
		{
			readOnlyHint: true,
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
				const notes = await convex.query("briefingNotes:list" as any, {
					topic,
					limit: effectiveLimit ?? 20,
					fields: fields ?? "lite",
					updatedSince,
					createdBefore,
					master,
					callerIdentities,
				});

				// scopeFilterList only discriminates on createdBy/namespace — it
				// has no notion of `participants`. OR it with an independent
				// participants re-check per row (passesBriefingNoteParticipantScope)
				// so notes the caller participates on but did not create stay
				// visible, without trusting Convex's decision blindly — real
				// defense-in-depth, same posture as before this fix.
				const rawNotes = Array.isArray(notes) ? notes : [];
				const scopeFiltered = new Set(
					scopeFilterList(oauthCtx ?? DENIED_SCOPE_CTX, rawNotes as any[]),
				);
				const filteredNotes = rawNotes.filter(
					(n) =>
						scopeFiltered.has(n) ||
						passesBriefingNoteParticipantScope(oauthCtx, n as any),
				);

				// S3.3 B8 — emit nextCursor when page is full (more likely follows).
				const requestedLimit = effectiveLimit ?? 20;
				let nextCursor: string | null = null;
				if (
					filteredNotes.length >= requestedLimit &&
					filteredNotes.length > 0
				) {
					const last = filteredNotes[filteredNotes.length - 1] as {
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

				const baseText = capListResponseBytes(
					notesWithCursor,
					JSON.stringify(notesWithCursor, null, 2),
					"list_briefing_notes",
				);
				const text = appendMarkerIfEnabled(baseText, () => {
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
				.describe("Search term to match against briefing note content"),
			topic: z.string().optional().describe("Filter by topic"),
			createdBy: z.string().optional().describe("Filter by creator role"),
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
					"'lite' returns compact payload (less tokens), 'full' is default.",
				),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Search briefing notes by keyword (BM25)",
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
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── register_component ──────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "from", fromArg: "createdBy" },
		"register_component",
		"Register or upsert a component (agent/skill/hook/plugin) in the VantagePeers registry by name+type. " +
			"WHEN: use when publishing a new version of an agent skill or hook so peers can discover and use it. " +
			"EXAMPLE: register_component name='check-tasks' type='skill' version='1.2.0' createdBy='alpha' content='...'.",
		{
			name: z
				.string()
				.describe("Component name — e.g. 'copywriter', 'check-tasks'"),
			type: componentTypeSchema,
			team: z
				.string()
				.optional()
				.describe(
					"Team this component belongs to — e.g. 'marketing', 'development'",
				),
			content: z.string().describe("Full file content of the component"),
			version: z.string().optional().describe("Version string — e.g. '1.0.0'"),
			project: z
				.string()
				.optional()
				.describe("Project this component belongs to"),
			createdBy: creatorSchema,
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Register component",
		},
		async ({ name, type, team, content, version, project, createdBy }) => {
			let contentBytes = 0;
			try {
				contentBytes = assertContentSize(content, "register_component");

				const fromDenied = guardFrom(createdBy);
				if (fromDenied) return fromDenied;

				const result = await convex.mutation("components:register" as any, {
					name,
					type,
					team,
					content,
					version,
					project,
					createdBy,
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
				if (error instanceof McpError) throw error;
				console.error("[register_component] mutation failed", {
					contentBytes,
					name,
					type,
					createdBy,
					errorMessage: error?.message ?? String(error),
				});
				return mcpConvexError(error);
			}
		},
	);

	// ── list_components ─────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"list_components",
		LIST_COMPONENTS_TOOL_DESCRIPTION,
		{
			type: componentTypeSchema.optional().describe("Filter by component type"),
			team: z.string().optional().describe("Filter by team"),
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
					"'lite' returns compact projection {_id, name, type, team, _creationTime} (less tokens), 'full' is default. v2.4.9+.",
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
			title: "List components",
		},
		async ({ type, team, limit, fields, cursor }) => {
			try {
				const effectiveLimit = limit === undefined ? 20 : clampLimit(limit);

				// Decode cursor: supports old paging.ts format { createdBefore } for
				// back-compat, and new opaque format { time, id } passed directly to Convex.
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

				// Convex query now returns { items, nextCursor } envelope (PR-B).
				const envelope = await convex.query("components:list" as any, {
					type,
					team,
					limit: effectiveLimit,
					fields: fields ?? "full",
					cursor: convexCursor,
					createdBefore,
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

				const filteredComponents = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					rawItems as any,
				);

				// Re-compute nextCursor from filtered set (scope filter may shrink page)
				let nextCursor: string | null = backendNextCursor;
				if (
					filteredComponents.length < rawItems.length &&
					filteredComponents.length > 0
				) {
					const last = filteredComponents[filteredComponents.length - 1] as {
						_creationTime?: number;
					};
					if (typeof last._creationTime === "number") {
						nextCursor = encodeCursor({ createdBefore: last._creationTime });
					}
				}
				if (filteredComponents.length === 0) {
					nextCursor = null;
				}

				const componentsWithCursor = { items: filteredComponents, nextCursor };

				return {
					content: [
						{
							type: "text",
							text: capListResponseBytes(
								filteredComponents,
								JSON.stringify(componentsWithCursor, null, 2),
								"list_components",
							),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_component ───────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"get_component",
		"Fetch a single component by name and type, returning the full source content and metadata. " +
			"WHEN: use before invoking a skill to read its interface, version, and implementation. " +
			"EXAMPLE: get_component name='check-tasks' type='skill'.",
		{
			name: z.string().describe("Component name"),
			type: componentTypeSchema,
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get component",
		},
		async ({ name, type }) => {
			try {
				// S3.1.C1 — scope-aware filter replaces guardMasterOnly.
				const component = await convex.query("components:get" as any, {
					name,
					type,
				});
				const filteredComponent = scopeFilterGet(
					oauthCtx ?? DENIED_SCOPE_CTX,
					component as any,
				);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(filteredComponent, null, 2),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── update_component ────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		"update_component",
		"Update a component's content, version, or team; only provided fields are patched. " +
			"WHEN: use to bump a skill version or fix content without re-registering from scratch. " +
			"EXAMPLE: update_component componentId='j57aaaaa...' version='1.3.0' content='...'.",
		{
			componentId: componentIdSchema.describe(
				"Convex document ID of the component",
			),
			name: z.string().optional().describe("New component name"),
			team: z.string().optional().describe("New team name"),
			content: z.string().optional().describe("New content/source code"),
			version: z.string().optional().describe("New version string"),
			project: z.string().optional().describe("New project name"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Update component",
		},
		async ({ componentId, ...fields }) => {
			// C0.2: no per-component identity field — master scope only
			const masterDenied = guardMasterOnly("update_component");
			if (masterDenied) return masterDenied;
			let contentBytes = 0;
			try {
				if (typeof fields.content === "string") {
					contentBytes = assertContentSize(fields.content, "update_component");
				}

				const result = await convex.mutation("components:update" as any, {
					componentId: componentId as any,
					...fields,
				});
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ componentId: result, updated: true },
								null,
								2,
							),
						},
					],
				};
			} catch (error: any) {
				if (error instanceof McpError) throw error;
				console.error("[update_component] mutation failed", {
					contentBytes,
					componentId,
					errorMessage: error?.message ?? String(error),
				});
				return mcpConvexError(error);
			}
		},
	);

	// ── delete_component ────────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		"delete_component",
		"Permanently delete a component from the registry by Convex document ID. " +
			"WHEN: use to remove deprecated or test components that should no longer be discoverable. " +
			"EXAMPLE: delete_component componentId='j57aaaaa...'.",
		{
			componentId: componentIdSchema.describe(
				"Convex document ID of the component to delete",
			),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: true,
			title: "Delete component",
		},
		async ({ componentId }) => {
			// C0.2: no per-component identity field — master scope only
			const masterDenied = guardMasterOnly("delete_component");
			if (masterDenied) return masterDenied;
			try {
				const result = await convex.mutation("components:remove" as any, {
					componentId: componentId as any,
				});
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── search_components ───────────────────────────────────────────────────────
	// ── search_components ─────────────────────────────────────────────────────
	// Canonical component-search tool (fleet-primary). The former
	// `search_components_by_keyword` twin was removed day159
	// (mission vp-mcp-alias-cleanup-v1, S2) — usage, not the code label, decides.

	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"search_components",
		// S3.3 B8 follow-up batch 3 FINAL — DOCTRINE EXCEPTION.
		// @cursorPagingException relevance-ranked-not-chronological
		// Rationale: results are scored by query similarity; a `createdBefore`
		// anchor would skip high-relevance older matches in favor of newer
		// low-relevance ones, breaking the search contract. Pagination on
		// semantic search should be score-based (offset / topK), not time-based.
		"Search components by name or team substring with optional type filter. " +
			"WHEN: use before register_component to check if a similar component already exists in the registry. " +
			"EXAMPLE: search_components query='check-tasks' type='skill' limit=10.",
		{
			query: z
				.string()
				.describe("Search term to match against component name or team"),
			type: componentTypeSchema.optional().describe("Filter by component type"),
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
					"'lite' returns compact payload (less tokens), 'full' is default. v2.4.9+.",
				),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Search components",
		},
		async ({ query, type, limit, fields }) => {
			try {
				// S3.1.C2 — scope-aware filter replaces guardMasterOnly.
				const results = await convex.query("components:search" as any, {
					query,
					type,
					limit: limit ?? 20,
					fields: fields ?? "lite",
				});
				const filteredResults = scopeFilterList(
					oauthCtx ?? DENIED_SCOPE_CTX,
					Array.isArray(results) ? results : [],
				);
				return {
					content: [
						{ type: "text", text: JSON.stringify(filteredResults, null, 2) },
					],
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
			"WHEN: use for daily standups, weekly reviews, or any repeating work item pattern. " +
			"EXAMPLE: create_recurring_task title='Daily standup' assignedTo='alpha' priority='medium' cronExpression='0 9 * * *' createdBy='alpha'.",
		{
			title: z
				.string()
				.describe("Task title — created each time the cron fires"),
			description: z.string().optional().describe("Task description"),
			assignedTo: assigneeSchema.describe("Who gets the created tasks"),
			priority: z
				.enum(["urgent", "high", "medium", "low"])
				.describe("Priority of created tasks"),
			project: z.string().optional().describe("Project name"),
			tags: flexArray.optional().describe("Tags for created tasks"),
			cronExpression: z
				.string()
				.describe("5-field cron: minute hour day-of-month month day-of-week"),
			createdBy: creatorSchema,
		},
		{
			readOnlyHint: false,
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
				const fromDenied = guardFrom(createdBy);
				if (fromDenied) return fromDenied;
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

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ taskId, cronExpression }, null, 2),
						},
					],
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
			"WHEN: use to audit which schedules are active or find templates to pause/resume/update. " +
			"EXAMPLE: list_recurring_tasks assignedTo='beta' active=true limit=20. " +
			"Default limit 20. cap 200.",
		{
			assignedTo: assigneeSchema.optional().describe("Filter by assignee"),
			active: z.boolean().optional().describe("Filter by active status"),
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
					"'lite' returns compact payload (less tokens), 'full' is default. v2.4.9+.",
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
				const requestedLimit = effectiveLimit ?? 20;
				let nextCursor: string | null = null;
				if (
					filteredTasks.length >= requestedLimit &&
					filteredTasks.length > 0
				) {
					const last = filteredTasks[filteredTasks.length - 1] as {
						_creationTime?: number;
					};
					if (typeof last._creationTime === "number") {
						nextCursor = encodeCursor({ createdBefore: last._creationTime });
					}
				}
				const tasksWithCursor =
					nextCursor !== null
						? { items: filteredTasks, nextCursor }
						: filteredTasks;

				return {
					content: [
						{
							type: "text",
							text: capListResponseBytes(
								tasksWithCursor,
								JSON.stringify(tasksWithCursor, null, 2),
								"list_recurring_tasks",
							),
						},
					],
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
		{ kind: "master" },
		"pause_recurring_task",
		"Pause a recurring task template to stop auto-creating tasks until explicitly resumed. " +
			"WHEN: use during holidays, freezes, or when the assignee is unavailable for a period. " +
			"EXAMPLE: pause_recurring_task taskId='j57aaaaa...'.",
		{
			taskId: recurringTaskIdSchema.describe("Recurring task ID"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Pause recurring task",
		},
		async ({ taskId }) => {
			// C0.6: cron infrastructure — master scope only
			const masterDenied = guardMasterOnly("pause_recurring_task");
			if (masterDenied) return masterDenied;
			try {
				const result = await convex.mutation("recurringTasks:pause" as any, {
					taskId: taskId as any,
				});

				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
		{ kind: "master" },
		"resume_recurring_task",
		"Resume a paused recurring task template and recalculate its next scheduled run time. " +
			"WHEN: use after a pause period ends to re-enable automatic task generation. " +
			"EXAMPLE: resume_recurring_task taskId='j57aaaaa...'.",
		{
			taskId: recurringTaskIdSchema.describe("Recurring task ID"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Resume recurring task",
		},
		async ({ taskId }) => {
			// C0.6: cron infrastructure — master scope only
			const masterDenied = guardMasterOnly("resume_recurring_task");
			if (masterDenied) return masterDenied;
			try {
				const result = await convex.mutation("recurringTasks:resume" as any, {
					taskId: taskId as any,
				});

				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── delete_recurring_task ───────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		"delete_recurring_task",
		"Permanently delete a recurring task template, stopping all future scheduled task generation. " +
			"WHEN: use when a recurring process is retired and should never generate tasks again. " +
			"EXAMPLE: delete_recurring_task taskId='j57aaaaa...'.",
		{
			taskId: recurringTaskIdSchema.describe("Recurring task ID"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: true,
			title: "Delete recurring task",
		},
		async ({ taskId }) => {
			// C0.6: cron infrastructure — master scope only
			const masterDenied = guardMasterOnly("delete_recurring_task");
			if (masterDenied) return masterDenied;
			try {
				const result = await convex.mutation("recurringTasks:remove" as any, {
					taskId: taskId as any,
				});

				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
				"from identity resolved from a nested arg; enforced in-handler by guardFrom",
		},
		"update_recurring_task",
		"Update a recurring task template's fields; cronExpression change auto-recalculates nextRunAt. " +
			"WHEN: use to change assignee, schedule, or priority of an active recurring template. " +
			"EXAMPLE: update_recurring_task recurringTaskId='j57aaaaa...' cronExpression='0 10 * * 1' priority='high'.",
		{
			recurringTaskId: recurringTaskIdSchema.describe(
				"Convex document ID of the recurring task",
			),
			title: z.string().optional().describe("New title"),
			description: z.string().optional().describe("New description"),
			assignedTo: creatorSchema.optional().describe("New assignee"),
			priority: prioritySchema.optional().describe("New priority"),
			project: z.string().optional().describe("New project name"),
			tags: z.array(z.string()).optional().describe("New tags array"),
			cronExpression: z
				.string()
				.optional()
				.describe("New cron expression (5-field)"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Update recurring task",
		},
		async ({ recurringTaskId, ...fields }) => {
			try {
				if (fields.assignedTo) {
					const assigneeDenied = await guardDelegation(fields.assignedTo);
					if (assigneeDenied) return assigneeDenied;
				}

				const result = await convex.mutation("recurringTasks:update" as any, {
					recurringTaskId: recurringTaskId as any,
					...fields,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ recurringTaskId: result, updated: true },
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
			service,
			budget,
			spendingLimits,
			approvedCategories,
			mandateDocument,
		}) => {
			try {
				const fromDenied = guardFrom(requestedBy);
				if (fromDenied) return fromDenied;
				const fulfillerDenied = guardFrom(fulfilledBy);
				if (fulfillerDenied) return fulfillerDenied;

				const mandateId = await convex.mutation("mandates:create" as any, {
					requestedBy,
					fulfilledBy,
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
				const fromDenied = guardFrom(callerOrchestrator);
				if (fromDenied) return fromDenied;

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
				const fromDenied = guardFrom(callerOrchestrator);
				if (fromDenied) return fromDenied;

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
				const fromDenied = guardFrom(callerOrchestrator);
				if (fromDenied) return fromDenied;

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
			try {
				const result = await convex.query("mandates:validateSpending" as any, {
					mandateId: mandateId as any,
					proposedAmount,
				});
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
					"'lite' returns compact payload (less tokens), 'full' is default. v2.4.9+.",
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
				const requestedLimit = effectiveLimit ?? 20;
				let nextCursor: string | null = null;
				if (
					filteredMandates.length >= requestedLimit &&
					filteredMandates.length > 0
				) {
					const last = filteredMandates[filteredMandates.length - 1] as {
						_creationTime?: number;
					};
					if (typeof last._creationTime === "number") {
						nextCursor = encodeCursor({ createdBefore: last._creationTime });
					}
				}
				const mandatesWithCursor =
					nextCursor !== null
						? { items: filteredMandates, nextCursor }
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
				const fromDenied = guardFrom(orchestratorId);
				if (fromDenied) return fromDenied;

				const buId = await convex.mutation("businessUnits:create" as any, {
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
				const callerDenied = guardFrom(callerOrchestrator);
				if (callerDenied) return callerDenied;
				if (orchestratorId) {
					const fromDenied = guardFrom(orchestratorId);
					if (fromDenied) return fromDenied;
				}

				await convex.mutation("businessUnits:update" as any, {
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
				const bu = (await convex.query("businessUnits:get" as any, {
					buId: buId as any,
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
					"'lite' returns compact payload (less tokens), 'full' is default. v2.4.9+.",
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

				// S3.1.C2 — scope-aware filter replaces guardMasterOnly.
				// Convex query now returns { items, nextCursor } envelope (PR-A).
				const envelope = await convex.query("businessUnits:list" as any, {
					orchestratorId,
					status,
					limit: effectiveLimit,
					fields: fields ?? "full",
					createdBefore,
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

				// Re-compute nextCursor from filtered set (scope filter may shrink page)
				let nextCursor: string | null = backendNextCursor;
				if (filteredBus.length < rawItems.length && filteredBus.length > 0) {
					// Scope filter dropped rows — recompute from last surviving row
					const last = filteredBus[filteredBus.length - 1] as {
						_creationTime?: number;
					};
					if (typeof last._creationTime === "number") {
						nextCursor = encodeCursor({ createdBefore: last._creationTime });
					}
				}
				if (filteredBus.length === 0) {
					nextCursor = null;
				}

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
				const result = await convex.mutation("businessUnits:remove" as any, {
					buId: buId as any,
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

	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		"add_repo_mapping",
		"Register or update a GitHub repo to orchestrator mapping for webhook event routing. " +
			"WHEN: use when adding a new repo to monitoring or changing which orchestrator handles its events. " +
			"EXAMPLE: add_repo_mapping repo='vantageos-agency/vantage-peers' orchestrator='alpha' project='vantage-peers'.",
		{
			repo: z
				.string()
				.describe("Full repo name — e.g. 'vantageos-agency/vantage-peers'"),
			orchestrator: z
				.string()
				.describe("Target orchestrator — e.g. 'sigma', 'omega', 'tau'"),
			project: z
				.string()
				.describe("Project name — e.g. 'vantage-peers', 'myreeldream'"),
			active: z
				.boolean()
				.optional()
				.default(true)
				.describe("Whether this mapping is active (default true)"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Add repo mapping",
		},
		async ({ repo, orchestrator, project, active }) => {
			// C0.3: infra webhook routing config — master scope only
			const masterDenied = guardMasterOnly("add_repo_mapping");
			if (masterDenied) return masterDenied;
			try {
				const id = await convex.mutation("githubRepoMapping:add" as any, {
					repo,
					orchestrator,
					project,
					active,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ id, repo, orchestrator, project, active },
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

	// ── list_repo_mappings ──────────────────────────────────────────────────────

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
			"WHEN: use to audit which repos are monitored and verify routing before adding new mappings. " +
			"EXAMPLE: list_repo_mappings limit=20 fields='lite'. " +
			"Default limit 20. cap 200.",
		{
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
					"'lite' returns compact payload (less tokens), 'full' is default. v2.4.9+.",
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
				const envelope = await convex.query("githubRepoMapping:list" as any, {
					limit: effectiveLimit,
					fields: fields ?? "full",
					cursor: convexCursor,
					createdBefore,
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

				// Re-compute nextCursor from filtered set (scope filter may shrink page)
				let nextCursor: string | null = backendNextCursor;
				if (
					filteredMappings.length < rawItems.length &&
					filteredMappings.length > 0
				) {
					const last = filteredMappings[filteredMappings.length - 1] as {
						_creationTime?: number;
					};
					if (typeof last._creationTime === "number") {
						nextCursor = encodeCursor({ createdBefore: last._creationTime });
					}
				}
				if (filteredMappings.length === 0) {
					nextCursor = null;
				}

				const mappingsWithCursor = { items: filteredMappings, nextCursor };

				return {
					content: [
						{
							type: "text",
							text: capListResponseBytes(
								filteredMappings,
								JSON.stringify(mappingsWithCursor, null, 2),
								"list_repo_mappings",
							),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── remove_repo_mapping ─────────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		"remove_repo_mapping",
		"Delete a GitHub repo mapping by repo name, stopping webhook event routing for that repo. " +
			"WHEN: use when a repo is archived or its events should no longer generate VP notifications. " +
			"EXAMPLE: remove_repo_mapping repo='vantageos-agency/vantage-peers'.",
		{
			repo: z
				.string()
				.describe(
					"Full repo name to remove — e.g. 'vantageos-agency/vantage-peers'",
				),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: true,
			title: "Remove repo mapping",
		},
		async ({ repo }) => {
			// C0.3: infra webhook routing config — master scope only
			const masterDenied = guardMasterOnly("remove_repo_mapping");
			if (masterDenied) return masterDenied;
			try {
				const result = await convex.mutation(
					"githubRepoMapping:remove" as any,
					{
						repo,
					},
				);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ repo, ...result }, null, 2),
						},
					],
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
					"'lite' returns compact payload (less tokens), 'full' is default. v2.4.9+.",
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
			"WHEN: use after resolving a non-trivial bug so future agents can find and reuse the solution. " +
			"EXAMPLE: create_fix_pattern symptom='hydration mismatch' rootCause='SSR/CSR time skew' tags=['next.js'] stack=['next.js','convex'] sourceProject='vantage-starter' createdBy='alpha' severity='major'.",
		{
			symptom: z
				.string()
				.describe("What the bug looks like — the user-visible problem"),
			rootCause: z
				.string()
				.describe("Why the bug happens — the underlying technical cause"),
			tags: flexArray.describe(
				"Tags for categorization — e.g. 'react-hydration', 'convex-subscription'",
			),
			stack: flexArray.describe(
				"Tech stack involved — e.g. 'next.js', 'convex', 'clerk'",
			),
			sourceProject: z
				.string()
				.describe("Project where this was discovered — e.g. 'myreeldream'"),
			createdBy: creatorSchema,
			severity: severitySchema,
			validatedFix: z
				.string()
				.optional()
				.describe("The fix that worked — set later if not known yet"),
			files: flexArrayOptional.describe("Files involved in the fix"),
			linkedIssueIds: flexArrayOptional.describe(
				"VantagePeers issue IDs linked to this pattern",
			),
		},
		{
			readOnlyHint: false,
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
				const fromDenied = guardFrom(createdBy);
				if (fromDenied) return fromDenied;

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
		"Add a fix attempt record to a pattern with description, outcome, and optional commit reference. " +
			"WHEN: use after each fix attempt (successful or not) to build a complete fix history. " +
			"EXAMPLE: add_fix_attempt patternId='j57aaaaa...' description='Added suppressHydrationWarning' worked=true why='Prevents mismatches' createdBy='beta'.",
		{
			patternId: patternIdSchema.describe("ID of the fix pattern"),
			description: z.string().describe("What was tried — the fix approach"),
			worked: z.boolean().describe("Did this fix the issue?"),
			why: z.string().describe("Why it worked or didn't — the reasoning"),
			createdBy: creatorSchema,
			commit: z.string().optional().describe("Git commit hash of this attempt"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Add fix attempt",
		},
		async ({ patternId, description, worked, why, createdBy, commit }) => {
			try {
				const fromDenied = guardFrom(createdBy);
				if (fromDenied) return fromDenied;

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
		"Set or update the validated fix description on a fix pattern after confirming it works. " +
			"WHEN: use after a fix attempt succeeds to promote it as the canonical solution on the pattern. " +
			"EXAMPLE: validate_fix patternId='j57aaaaa...' validatedFix='Add suppressHydrationWarning to date elements'.",
		{
			patternId: patternIdSchema.describe("ID of the fix pattern"),
			validatedFix: z.string().describe("Description of the validated fix"),
		},
		{
			readOnlyHint: false,
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

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ patternId, validatedFix, validated: true },
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
			"WHEN: call BEFORE fixing any bug to check if a matching pattern exists and reuse the validated fix. " +
			"EXAMPLE: search_fix_patterns query='message disappears after sending on mobile' limit=5.",
		{
			query: z
				.string()
				.describe(
					"Describe the problem — e.g. 'message disappears after sending'",
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
					"'lite' returns compact payload (less tokens), 'full' is default. v2.4.9+.",
				),
		},
		{
			readOnlyHint: true,
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
			"WHEN: use to audit the knowledge base or review all patterns for a specific project. " +
			"EXAMPLE: list_fix_patterns project='vantage-starter' limit=20. " +
			"Default limit 20. cap 200.",
		{
			project: z
				.string()
				.optional()
				.describe("Filter by source project — omit for all"),
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
					"'lite' returns compact payload (less tokens), 'full' is default. v2.4.9+.",
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
					return {
						content: [
							{
								type: "text",
								text: capListResponseBytes(
									payload,
									JSON.stringify(payload, null, 2),
									"list_fix_patterns",
								),
							},
						],
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
				return {
					content: [
						{
							type: "text",
							text: capListResponseBytes(
								payload,
								JSON.stringify(payload, null, 2),
								"list_fix_patterns",
							),
						},
					],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── link_issue_to_pattern ───────────────────────────────────────────────────

	defineTool(
		server,
		authCtx,
		{ kind: "master" },
		"link_issue_to_pattern",
		"Link a VantagePeers issue to a fix pattern creating a bidirectional reference. " +
			"WHEN: use after creating a fix pattern for an issue to connect the symptom record with the bug tracker. " +
			"EXAMPLE: link_issue_to_pattern patternId='j57aaaaa...' issueId='j57bbbbb...'.",
		{
			patternId: patternIdSchema.describe("ID of the fix pattern"),
			issueId: z.string().describe("VantagePeers issue ID to link"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Link issue to fix pattern",
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

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ patternId, issueId, linked: true },
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
			"WHEN: use before instantiate_template_into_mission to inspect steps and verify the template exists. " +
			"EXAMPLE: get_mission_template name='issue-resolution-v2'.",
		{
			name: z.string().describe("Template name — e.g. 'issue-resolution-v2'"),
		},
		{
			readOnlyHint: true,
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
			"WHEN: use to define or refine reusable multi-step workflow blueprints for recurring mission types. " +
			"EXAMPLE: update_mission_template name='issue-resolution-v2' steps=[{title:'Triage',description:'...'}] createdBy='alpha'.",
		{
			name: z
				.string()
				.describe("Template name — must be unique, e.g. 'issue-resolution-v2'"),
			description: z
				.string()
				.optional()
				.describe("Human-readable description of the template"),
			brief: z
				.string()
				.optional()
				.describe(
					"Reusable mission brief carried by the template. Copied onto a mission's own `brief` at instantiate_template_into_mission time when that mission has none — avoids retyping the same cadrage at every instantiation.",
				),
			steps: z
				.array(
					z.object({
						title: z.string().describe("Step title"),
						description: z.string().describe("What to do in this step"),
						tags: z
							.array(z.string())
							.optional()
							.describe("Optional tags for the step"),
						assignedTo: z
							.string()
							.optional()
							.describe(
								"Orchestrator role assigned to this step — e.g. 'proxima'. Falls back to mission.pilot when unset during instantiation.",
							),
						assignedToInstance: z
							.string()
							.optional()
							.describe(
								"Instance-level assignment for this step — e.g. 'proxima-vps'. Optional.",
							),
						dependsOn: z
							.array(z.number())
							.optional()
							.describe(
								"0-based indexes of steps that must complete before this step. Resolved to task IDs on instantiation.",
							),
					}),
				)
				.describe(
					"Ordered list of steps — each becomes one task when instantiated",
				),
			createdBy: creatorSchema.describe(
				"Who is creating/updating the template",
			),
			isDefault: z
				.boolean()
				.optional()
				.describe("Mark as the default template for its type"),
		},
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Update mission template",
		},
		async ({ name, description, brief, steps, createdBy, isDefault }) => {
			try {
				const fromDenied = guardFrom(createdBy);
				if (fromDenied) return fromDenied;

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
			"WHEN: use after create_mission to fan out a standard workflow from a template in one call. " +
			"EXAMPLE: instantiate_template_into_mission templateName='issue-resolution-v2' missionId='k57a36y8...' callerOrchestrator='alpha'.",
		{
			templateName: z
				.string()
				.describe("Name of the mission template to instantiate"),
			missionId: missionIdSchema.describe(
				"Convex document ID of the target mission",
			),
			context: z
				.record(z.string(), z.string())
				.optional()
				.describe(
					"Key-value map for {{key}} interpolation in step descriptions. Non-matching placeholders are left intact.",
				),
			titlePrefix: z
				.string()
				.optional()
				.describe(
					"String prepended to every task title — e.g. '[p25]'. Optional.",
				),
			callerOrchestrator: z
				.string()
				.optional()
				.describe(
					"Orchestrator making this call — used as createdBy on tasks. Defaults to 'system'.",
				),
		},
		{
			readOnlyHint: false,
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
					"'lite' returns compact payload (less tokens), 'full' is default. v2.4.9+.",
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
		"Returns the orchestrator identity baked into the current bearer's scope context. " +
			"WHEN: call this on skill startup to avoid asking the user for their orchestrator_id. " +
			"EXAMPLE: a fresh Claude.ai connector calls whoami first, then uses suggested_orchestrator_id " +
			"as `from` on all subsequent send_message / create_task calls.",
		{},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Who am I (identity introspection)",
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
				// Legacy bearer (pre-OAuth mcpTenants path) — no scope profile
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

			const result = {
				scope_profile_name: scopeProfileName,
				fromAllowList,
				namespaceReadPrefixes,
				namespaceWritePrefixes,
				suggested_orchestrator_id: suggestedOrchestratorId,
			};

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(result, null, 2) },
				],
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
		"Fetch a single task by its Convex document ID with all fields: title, description, status, priority, assignment, dependencies, mission link, completion note. " +
			"WHEN: use when you have a specific taskId from list_tasks/create_task and need the full record (brief, VERIFICATION block, completionNote). " +
			"EXAMPLE: get_task taskId='k172735brsw6bc3j2dkkkfxqrx88kkjq'.",
		{
			taskId: taskIdSchema.describe("Task document ID"),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get task",
		},
		async ({ taskId }) => {
			try {
				const row = await convex.query("tasks:getById" as any, { taskId });
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
				return {
					content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
				};
			} catch (error: any) {
				return mcpConvexError(error);
			}
		},
	);

	// ── get_fix_pattern ─────────────────────────────────────────────────────────
	// Day 100 — Phase 1 get_by_id surface fix. Convex fixPatterns:get exists.
	defineTool(
		server,
		authCtx,
		{
			kind: "filtered",
			reason:
				"result set scoped in-handler via scopeFilterList(oauthCtx,...)/scopeFilterGet(oauthCtx,...)",
		},
		"get_fix_pattern",
		"Fetch a single fix pattern by its Convex document ID, including all linked fix attempts. " +
			"WHEN: use when you have a patternId from list_fix_patterns/search_fix_patterns and need the full record with attempts history. " +
			"EXAMPLE: get_fix_pattern patternId='m9748paffd0emrbwyskj868e1x88kvhj'.",
		{
			patternId: patternIdSchema.describe("Fix pattern document ID"),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get fix pattern",
		},
		async ({ patternId }) => {
			try {
				const row = await convex.query("fixPatterns:get" as any, { patternId });
				const filtered = scopeFilterGet(oauthCtx ?? DENIED_SCOPE_CTX, row);
				if (filtered === null) {
					return mcpError(`Fix pattern not found: ${patternId}`);
				}
				return {
					content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
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
		"Fetch a single peer message by its Convex document ID with full body, channel, sender, sessionDay, and tenant scope. " +
			"WHEN: use when you have a messageId from list_messages/check_messages and need the raw row (e.g. for read-receipt audit, delete confirmation, or referencing in a fix pattern). " +
			"EXAMPLE: get_message messageId='jn7eg21wdaxzdcpdxwkvhaxqnh88jqg2'.",
		{
			messageId: messageIdSchema.describe("Message document ID"),
		},
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Get message",
		},
		async ({ messageId }) => {
			try {
				const row = await convex.query("messages:getById" as any, {
					messageId,
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
				return {
					content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
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
		"Fetch a single recurring task definition by its Convex document ID with cron schedule, prompt, assignee, and last-fire metadata. " +
			"WHEN: use when you have a recurringTaskId from list_recurring_tasks and need the full row before pause_recurring_task / update_recurring_task / delete_recurring_task. " +
			"EXAMPLE: get_recurring_task recurringTaskId='k57dy3049btafda9m2f5d2ggk987ph3f'.",
		{
			recurringTaskId: recurringTaskIdSchema.describe(
				"Recurring task document ID",
			),
		},
		{
			readOnlyHint: true,
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
				return {
					content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
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
	// VP-Sources footer (Eta heuristic, Pi-approved Option C).
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
			openWorldHint: false,
			destructiveHint: false,
			title: "Improvisation digest",
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
}
