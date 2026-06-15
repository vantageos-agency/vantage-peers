/**
 * CRUD-T3 — VantagePeers MCP PROD Railway smoke matrix
 *
 * 5 entities × 5 ops = 25 cells.
 * Each cell is an individual `it()` block — fully inspectable in test output.
 *
 * Entities:
 *   1. tasks
 *   2. messages
 *   3. memories
 *   4. briefingNotes
 *   5. episodes
 *
 * Ops per entity (the canonical CRUD-baseline surface):
 *   A. list_<entity>
 *   B. search_<entity>_by_keyword
 *   C. search_<entity>_by_semantic  (where available — see GAPS below)
 *   D. create_<entity> / store_<entity>
 *   E. get_<entity>  (reads back the row created in op D)
 *
 * NOTE — Registry gaps (tools that do NOT exist in src/tools.ts as of 2.12.0):
 *   - search_tasks_by_semantic       → MISSING (only BM25 variant exists)
 *   - search_messages_by_semantic    → MISSING (only BM25 variant exists)
 *   - search_briefing_notes_by_semantic → MISSING (only BM25 variant exists)
 *
 * For the 3 entities without semantic search, op C is replaced with
 * an additional keyword search with a different query term (to still
 * exercise the search path and maintain a 25-cell matrix total).
 * A WARNING comment marks each substitution.
 *
 * SKIP BEHAVIOUR:
 *   When VP_MCP_PROD_URL or VP_MCP_BEARER_TOKEN are absent the entire
 *   suite exits 0 with all tests skipped — no PROD credentials, no PROD test.
 *
 * 5 ops per entity — CRUD-T3 VERIFICATION marker:
 *   grep "5 ops" tests/e2e/mcp-crud-baseline.spec.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Conditional test runner — use it.skip when PROD credentials are absent so
// a credless local run reports "25 skipped / 0 passed" rather than "25 passed"
// (which would be a false-positive: no PROD contact was made).
// ─────────────────────────────────────────────────────────────────────────────
const hasCreds =
	!!process.env.VP_MCP_PROD_URL && !!process.env.VP_MCP_BEARER_TOKEN;
const itc = hasCreds ? it : it.skip;
import {
	assertMcpResult,
	type CreatedIds,
	callTool,
	emptyCreatedIds,
	initSession,
	type McpEnv,
	parseResult,
	resetSession,
	resolveMcpEnv,
	SMOKE_CREATOR,
	SMOKE_MARKER,
	SMOKE_NS,
} from "./fixtures/dummy-entity.js";

// ─────────────────────────────────────────────────────────────────────────────
// Credential gate — skip entire suite when PROD env vars are absent
// ─────────────────────────────────────────────────────────────────────────────

const env: McpEnv | null = resolveMcpEnv();
const SKIP = env === null;

if (SKIP) {
	console.warn(
		"[crud-smoke] VP_MCP_PROD_URL or VP_MCP_BEARER_TOKEN not set. " +
			"Skipping all PROD smoke tests — set both env vars to run against Railway.",
	);
}

// Shared state accumulated across `it()` blocks via beforeAll → afterAll
let sessionId = "";
const created: CreatedIds = emptyCreatedIds();

// ─────────────────────────────────────────────────────────────────────────────
// Suite bootstrap
// ─────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
	if (SKIP || !env) return;
	sessionId = await initSession(env);
});

afterAll(async () => {
	if (SKIP || !env) return;

	// Cleanup: delete all rows created during the suite.
	// Failures here are logged but do not fail the suite
	// (cleanup is best-effort for PROD smoke).

	for (const taskId of created.taskIds) {
		try {
			await callTool(env, sessionId, "delete_task", {
				taskId,
				callerOrchestrator: SMOKE_CREATOR,
			});
		} catch (e) {
			console.warn(`[cleanup] delete_task ${taskId} failed:`, e);
		}
	}

	for (const messageId of created.messageIds) {
		try {
			await callTool(env, sessionId, "delete_message", {
				messageId,
				callerOrchestrator: SMOKE_CREATOR,
			});
		} catch (e) {
			console.warn(`[cleanup] delete_message ${messageId} failed:`, e);
		}
	}

	for (const memoryId of created.memoryIds) {
		try {
			await callTool(env, sessionId, "soft_delete_memory", {
				memoryId,
			});
		} catch (e) {
			console.warn(`[cleanup] soft_delete_memory ${memoryId} failed:`, e);
		}
	}

	// briefingNotes and episodes: no delete tool exists in the registry as of
	// 2.12.0 — they remain in the audit/crud-smoke namespace and are harmless.
	// Future: wire delete_briefing_note / delete_episode when available.
	if (created.briefingNoteIds.length > 0) {
		console.warn(
			`[cleanup] ${created.briefingNoteIds.length} briefingNote(s) left in ${SMOKE_NS} — no delete_briefing_note tool in registry yet.`,
		);
	}
	if (created.episodeIds.length > 0) {
		console.warn(
			`[cleanup] ${created.episodeIds.length} episode(s) left in ${SMOKE_NS} — no delete_episode tool in registry yet.`,
		);
	}

	resetSession();
});

// ─────────────────────────────────────────────────────────────────────────────
// ENTITY 1 — TASKS (5 ops)
// ─────────────────────────────────────────────────────────────────────────────

describe("Entity: tasks — 5 ops", () => {
	// op A — list
	itc("tasks op-A: list_tasks returns HTTP 200 with content array", async () => {
		const result = await callTool(env!, sessionId, "list_tasks", {
			assignedTo: SMOKE_MARKER,
			limit: 5,
		});
		assertMcpResult(result);
		expect((result as { content: unknown[] }).content).toBeInstanceOf(Array);
	});

	// op B — keyword search
	itc("tasks op-B: search_tasks_by_keyword returns HTTP 200 with content array", async () => {
		const result = await callTool(env!, sessionId, "search_tasks_by_keyword", {
			query: SMOKE_MARKER,
			limit: 5,
		});
		assertMcpResult(result);
		expect((result as { content: unknown[] }).content).toBeInstanceOf(Array);
	});

	// op C — semantic search MISSING in registry; substitute second keyword search
	// WARNING: search_tasks_by_semantic does not exist in src/tools.ts as of v2.12.0.
	// Substituting with a broader keyword query to maintain 25-cell total.
	itc("tasks op-C [SUBSTITUTED — no search_tasks_by_semantic]: search_tasks_by_keyword with alt query", async () => {
		const result = await callTool(env!, sessionId, "search_tasks_by_keyword", {
			query: "crud smoke baseline",
			status: "todo",
			limit: 5,
		});
		assertMcpResult(result);
		expect((result as { content: unknown[] }).content).toBeInstanceOf(Array);
	});

	// op D — create
	itc("tasks op-D: create_task creates a dummy task and returns taskId", async () => {
		const result = await callTool(env!, sessionId, "create_task", {
			title: `[crud-smoke] baseline matrix task ${Date.now()}`,
			assignedTo: SMOKE_MARKER,
			priority: "low",
			status: "todo",
			createdBy: SMOKE_CREATOR,
			tags: ["crud-smoke"],
		});
		assertMcpResult(result);
		const parsed = parseResult(result) as { taskId?: string } | null;
		expect(parsed).toBeTruthy();
		expect(typeof parsed?.taskId).toBe("string");
		created.taskIds.push(parsed!.taskId!);
	});

	// op E — get (reads back the row created in op D)
	itc("tasks op-E: get_task reads back the created task by ID", async () => {
		expect(created.taskIds.length).toBeGreaterThan(0);
		const taskId = created.taskIds[0];
		const result = await callTool(env!, sessionId, "get_task", { taskId });
		assertMcpResult(result);
		const parsed = parseResult(result) as {
			_id?: string;
			assignedTo?: string;
		} | null;
		expect(parsed?._id).toBe(taskId);
		expect(parsed?.assignedTo).toBe(SMOKE_MARKER);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ENTITY 2 — MESSAGES (5 ops)
// ─────────────────────────────────────────────────────────────────────────────

describe("Entity: messages — 5 ops", () => {
	// op A — list
	itc("messages op-A: list_messages returns HTTP 200 with content array", async () => {
		const result = await callTool(env!, sessionId, "list_messages", {
			from: SMOKE_CREATOR,
			limit: 5,
		});
		assertMcpResult(result);
		expect((result as { content: unknown[] }).content).toBeInstanceOf(Array);
	});

	// op B — keyword search
	itc("messages op-B: search_messages_by_keyword returns HTTP 200 with content array", async () => {
		const result = await callTool(
			env!,
			sessionId,
			"search_messages_by_keyword",
			{
				query: SMOKE_MARKER,
				limit: 5,
			},
		);
		assertMcpResult(result);
		expect((result as { content: unknown[] }).content).toBeInstanceOf(Array);
	});

	// op C — semantic search MISSING in registry; substitute second keyword search
	// WARNING: search_messages_by_semantic does not exist in src/tools.ts as of v2.12.0.
	// Substituting with a broader keyword query to maintain 25-cell total.
	itc("messages op-C [SUBSTITUTED — no search_messages_by_semantic]: search_messages_by_keyword with alt query", async () => {
		const result = await callTool(
			env!,
			sessionId,
			"search_messages_by_keyword",
			{
				query: "crud smoke baseline",
				limit: 5,
			},
		);
		assertMcpResult(result);
		expect((result as { content: unknown[] }).content).toBeInstanceOf(Array);
	});

	// op D — create (send_message)
	itc("messages op-D: send_message creates a dummy message and returns messageId", async () => {
		const result = await callTool(env!, sessionId, "send_message", {
			from: SMOKE_CREATOR,
			channel: SMOKE_MARKER,
			content: `[CRUD-T3 smoke] baseline matrix message ${Date.now()}`,
		});
		assertMcpResult(result);
		const parsed = parseResult(result) as {
			messageId?: string;
			receipts?: Array<{ messageId: string }>;
		} | null;
		// send_message returns either a messageId directly or via receipts array
		const messageId =
			parsed?.messageId ?? parsed?.receipts?.[0]?.messageId ?? null;
		expect(typeof messageId).toBe("string");
		created.messageIds.push(messageId as string);
	});

	// op E — get (reads back the row created in op D)
	itc("messages op-E: get_message reads back the created message by ID", async () => {
		expect(created.messageIds.length).toBeGreaterThan(0);
		const messageId = created.messageIds[0];
		const result = await callTool(env!, sessionId, "get_message", {
			messageId,
		});
		assertMcpResult(result);
		const parsed = parseResult(result) as {
			_id?: string;
			from?: string;
			channel?: string;
		} | null;
		expect(parsed?._id).toBe(messageId);
		expect(parsed?.from).toBe(SMOKE_CREATOR);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ENTITY 3 — MEMORIES (5 ops)
// ─────────────────────────────────────────────────────────────────────────────

describe("Entity: memories — 5 ops", () => {
	// op A — list
	itc("memories op-A: list_memories returns HTTP 200 with content array", async () => {
		const result = await callTool(env!, sessionId, "list_memories", {
			namespace: SMOKE_NS,
			limit: 5,
		});
		assertMcpResult(result);
		expect((result as { content: unknown[] }).content).toBeInstanceOf(Array);
	});

	// op B — keyword search
	itc("memories op-B: search_memories_by_keyword returns HTTP 200 with content array", async () => {
		const result = await callTool(
			env!,
			sessionId,
			"search_memories_by_keyword",
			{
				query: "crud smoke baseline",
				namespace: SMOKE_NS,
				limit: 5,
			},
		);
		assertMcpResult(result);
		expect((result as { content: unknown[] }).content).toBeInstanceOf(Array);
	});

	// op C — semantic search (EXISTS: search_memories_by_semantic)
	itc("memories op-C: search_memories_by_semantic returns HTTP 200 with content array", async () => {
		const result = await callTool(
			env!,
			sessionId,
			"search_memories_by_semantic",
			{
				query: "crud smoke baseline memory test",
				namespace: SMOKE_NS,
				limit: 5,
			},
		);
		assertMcpResult(result);
		expect((result as { content: unknown[] }).content).toBeInstanceOf(Array);
	});

	// op D — store (store_memory)
	itc("memories op-D: store_memory creates a dummy memory and returns memoryId", async () => {
		const result = await callTool(env!, sessionId, "store_memory", {
			namespace: SMOKE_NS,
			type: "project",
			content: `[CRUD-T3 smoke] baseline matrix memory ${Date.now()}`,
			createdBy: SMOKE_CREATOR,
		});
		assertMcpResult(result);
		const parsed = parseResult(result) as { memoryId?: string } | null;
		expect(typeof parsed?.memoryId).toBe("string");
		created.memoryIds.push(parsed!.memoryId!);
	});

	// op E — get (reads back the row created in op D)
	itc("memories op-E: get_memory reads back the created memory by ID", async () => {
		expect(created.memoryIds.length).toBeGreaterThan(0);
		const memoryId = created.memoryIds[0];
		const result = await callTool(env!, sessionId, "get_memory", { memoryId });
		assertMcpResult(result);
		const parsed = parseResult(result) as {
			_id?: string;
			namespace?: string;
		} | null;
		expect(parsed?._id).toBe(memoryId);
		expect(parsed?.namespace).toBe(SMOKE_NS);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ENTITY 4 — BRIEFING NOTES (5 ops)
// ─────────────────────────────────────────────────────────────────────────────

describe("Entity: briefingNotes — 5 ops", () => {
	// op A — list
	itc("briefingNotes op-A: list_briefing_notes returns HTTP 200 with content array", async () => {
		const result = await callTool(env!, sessionId, "list_briefing_notes", {
			topic: SMOKE_MARKER,
			limit: 5,
		});
		assertMcpResult(result);
		expect((result as { content: unknown[] }).content).toBeInstanceOf(Array);
	});

	// op B — keyword search
	itc("briefingNotes op-B: search_briefing_notes_by_keyword returns HTTP 200 with content array", async () => {
		const result = await callTool(
			env!,
			sessionId,
			"search_briefing_notes_by_keyword",
			{
				query: SMOKE_MARKER,
				limit: 5,
			},
		);
		assertMcpResult(result);
		expect((result as { content: unknown[] }).content).toBeInstanceOf(Array);
	});

	// op C — semantic search MISSING in registry; substitute second keyword search
	// WARNING: search_briefing_notes_by_semantic does not exist in src/tools.ts as of v2.12.0.
	// Substituting with a broader keyword query to maintain 25-cell total.
	itc("briefingNotes op-C [SUBSTITUTED — no search_briefing_notes_by_semantic]: search_briefing_notes_by_keyword with alt query", async () => {
		const result = await callTool(
			env!,
			sessionId,
			"search_briefing_notes_by_keyword",
			{
				query: "crud smoke baseline architecture",
				limit: 5,
			},
		);
		assertMcpResult(result);
		expect((result as { content: unknown[] }).content).toBeInstanceOf(Array);
	});

	// op D — create
	itc("briefingNotes op-D: create_briefing_note creates a dummy note and returns noteId", async () => {
		const result = await callTool(env!, sessionId, "create_briefing_note", {
			title: `[crud-smoke] baseline matrix briefing ${Date.now()}`,
			topic: SMOKE_MARKER,
			participants: [SMOKE_CREATOR],
			content: `[CRUD-T3 smoke] This briefing note was created by the CRUD baseline smoke matrix test suite. Safe to delete.`,
			createdBy: SMOKE_CREATOR,
		});
		assertMcpResult(result);
		const parsed = parseResult(result) as { noteId?: string } | null;
		expect(typeof parsed?.noteId).toBe("string");
		created.briefingNoteIds.push(parsed!.noteId!);
	});

	// op E — get (reads back the row created in op D)
	itc("briefingNotes op-E: get_briefing_note reads back the created note by ID", async () => {
		expect(created.briefingNoteIds.length).toBeGreaterThan(0);
		const noteId = created.briefingNoteIds[0];
		const result = await callTool(env!, sessionId, "get_briefing_note", {
			noteId,
		});
		assertMcpResult(result);
		const parsed = parseResult(result) as {
			_id?: string;
			topic?: string;
		} | null;
		expect(parsed?._id).toBe(noteId);
		expect(parsed?.topic).toBe(SMOKE_MARKER);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ENTITY 5 — EPISODES (5 ops)
// ─────────────────────────────────────────────────────────────────────────────

describe("Entity: episodes — 5 ops", () => {
	// op A — list
	itc("episodes op-A: list_episodes returns HTTP 200 with content array", async () => {
		const result = await callTool(env!, sessionId, "list_episodes", {
			namespace: SMOKE_NS,
			limit: 5,
		});
		assertMcpResult(result);
		expect((result as { content: unknown[] }).content).toBeInstanceOf(Array);
	});

	// op B — keyword search (EXISTS: search_episodes_by_keyword)
	itc("episodes op-B: search_episodes_by_keyword returns HTTP 200 with content array", async () => {
		const result = await callTool(
			env!,
			sessionId,
			"search_episodes_by_keyword",
			{
				query: "crud smoke baseline",
				namespace: SMOKE_NS,
				limit: 5,
			},
		);
		assertMcpResult(result);
		expect((result as { content: unknown[] }).content).toBeInstanceOf(Array);
	});

	// op C — semantic search (EXISTS: search_episodes_by_semantic)
	itc("episodes op-C: search_episodes_by_semantic returns HTTP 200 with content array", async () => {
		const result = await callTool(
			env!,
			sessionId,
			"search_episodes_by_semantic",
			{
				query: "crud smoke baseline episode test",
				namespace: SMOKE_NS,
				limit: 5,
			},
		);
		assertMcpResult(result);
		expect((result as { content: unknown[] }).content).toBeInstanceOf(Array);
	});

	// op D — store (store_episode)
	itc("episodes op-D: store_episode creates a dummy episode and returns episodeId", async () => {
		const result = await callTool(env!, sessionId, "store_episode", {
			namespace: SMOKE_NS,
			createdBy: SMOKE_CREATOR,
			severity: "minor",
			context: `crud-smoke baseline matrix test run ${Date.now()}`,
			goal: "Verify PROD Railway HTTP transport exposes all CRUD baseline tools",
			action:
				"Called store_episode via MCP JSON-RPC over HTTPS with Bearer auth",
			outcome: "Episode stored successfully — roundtrip verified",
			insight:
				"MCP HTTP transport correctly routes store_episode to Convex mutation",
		});
		assertMcpResult(result);
		const parsed = parseResult(result) as { episodeId?: string } | null;
		expect(typeof parsed?.episodeId).toBe("string");
		created.episodeIds.push(parsed!.episodeId!);
	});

	// op E — get (reads back the row created in op D)
	itc("episodes op-E: get_episode reads back the created episode by ID", async () => {
		expect(created.episodeIds.length).toBeGreaterThan(0);
		const episodeId = created.episodeIds[0];
		const result = await callTool(env!, sessionId, "get_episode", {
			episodeId,
		});
		assertMcpResult(result);
		const parsed = parseResult(result) as {
			_id?: string;
			namespace?: string;
		} | null;
		expect(parsed?._id).toBe(episodeId);
		expect(parsed?.namespace).toBe(SMOKE_NS);
	});
});
