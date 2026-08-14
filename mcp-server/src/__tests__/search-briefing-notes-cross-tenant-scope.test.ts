/**
 * search_briefing_notes_by_keyword — cross-tenant CONTENT leak (Day 141).
 *
 * VP task k17fyh3bqyh8ne1zd48sdee5958b2kk4.
 *
 * MEASURED: a caller scoped to tenant A (fromAllowList=["tenant-a"]) calling
 * search_briefing_notes_by_keyword with a term present ONLY in a tenant-B
 * note received tenant B's note CONTENT back. All fixtures below are
 * invented (no real client/tenant/profileId).
 *
 * METHOD CONSTRAINT: before trusting any "guarded" claim about this path, we
 * first prove the AUDIT INSTRUMENT — `scopeFilterList`/`scopeFilterGet` from
 * `@vantageos/cloud-identity` — actually enforces isolation on a tool we can
 * see calls it directly in source: `get_briefing_note` (tools.ts calls
 * `scopeFilterGet(oauthCtx, note)` at the line documented below). A grep for
 * "guardRead"/"scopeFilter" is NOT itself the instrument — calling the real
 * tool handler with a real OAuthContext and reading its real output is.
 *
 * Positive-control test group runs FIRST and must produce NON-ZERO evidence
 * (an actual denial) on get_briefing_note before the target-path tests are
 * trusted.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../auth.js";
import { registerTools } from "../tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test infrastructure (mirrors list_memories_episodes_pagination.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function buildFakeServer(): {
	server: McpServer;
	handlers: Map<string, ToolHandler>;
} {
	const handlers = new Map<string, ToolHandler>();
	const fakeServer = {
		tool(...args: unknown[]): unknown {
			const name = args[0] as string;
			const handler = args[args.length - 1] as ToolHandler;
			handlers.set(name, handler);
			return {};
		},
		registerTool(...args: unknown[]): unknown {
			const name = args[0] as string;
			const handler = args[args.length - 1] as ToolHandler;
			handlers.set(name, handler);
			return {};
		},
	} as unknown as McpServer;
	return { server: fakeServer, handlers };
}

function buildMockConvex(): ConvexHttpClient {
	return {
		query: vi.fn().mockResolvedValue([]),
		mutation: vi.fn().mockResolvedValue(null),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
}

function parseResult(result: unknown): unknown {
	const r = result as {
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
	};
	return JSON.parse(r.content[0].text);
}

function isErrorResult(result: unknown): boolean {
	const r = result as { isError?: boolean };
	return r?.isError === true;
}

// Invented fixtures — org-fixture-alpha / org-fixture-beta, never a real tenant.
const CALLER_A: OAuthContext = {
	clientId: "client-fixture-alpha",
	userId: "user-fixture-alpha",
	scopes: ["mcp:full"],
	scopeProfile: "tenant",
	fromAllowList: ["org-fixture-alpha"],
	namespaceReadPrefixes: ["team/org-fixture-alpha"],
	namespaceWritePrefixes: ["team/org-fixture-alpha"],
	expiresAt: Date.now() + 3600_000,
	isMaster: false,
};

const NOTE_B_MARKER = "CANARY-BETA-fx91a2";

const NOTE_B_FULL = {
	_id: "note-fixture-beta-001",
	_creationTime: 1780000000000,
	title: "Beta internal roadmap",
	topic: "planning",
	participants: ["org-fixture-beta"],
	content: `Confidential beta content containing ${NOTE_B_MARKER}`,
	createdBy: "org-fixture-beta",
	createdAt: 1780000000000,
};

const NOTE_A_FULL = {
	_id: "note-fixture-alpha-001",
	_creationTime: 1780000001000,
	title: "Alpha internal roadmap",
	topic: "planning",
	participants: ["org-fixture-alpha"],
	content: "Alpha's own content, no marker here",
	createdBy: "org-fixture-alpha",
	createdAt: 1780000001000,
};

// ─────────────────────────────────────────────────────────────────────────────
// 0. POSITIVE CONTROL — prove the instrument on a tool we can see is guarded
//    (get_briefing_note calls scopeFilterGet(oauthCtx, note) — tools.ts:5209)
// ─────────────────────────────────────────────────────────────────────────────

describe("POSITIVE CONTROL — get_briefing_note (known scopeFilterGet call site)", () => {
	it("tenant A is denied (not-found) reading tenant B's note by ID — NON-ZERO evidence", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			NOTE_B_FULL,
		);

		const handler = handlers.get("get_briefing_note");
		expect(handler, "get_briefing_note must be registered").toBeDefined();

		const result = await handler?.({ noteId: NOTE_B_FULL._id });

		// Non-zero, concrete evidence: an error result, and the raw B content
		// must not appear anywhere in the tool output.
		expect(
			isErrorResult(result),
			"positive control FAILED if this is not an error — scopeFilterGet is not actually enforced here",
		).toBe(true);
		const raw = JSON.stringify(result);
		expect(raw.includes(NOTE_B_MARKER)).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. RED reproduction — search_briefing_notes_by_keyword leaks tenant B content
// ─────────────────────────────────────────────────────────────────────────────

describe("RED — search_briefing_notes_by_keyword cross-tenant content leak", () => {
	it("tenant A searching a term present ONLY in tenant B's note receives its CONTENT (tools.ts:5352)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		// Convex's own searchBriefingNotesByKeyword is reached through the MCP
		// server's fixed service-account identity (no per-caller org on
		// ctx.auth), so in production it resolves the master branch and
		// returns matches across tenants. The mock reproduces exactly that
		// observed shape: an unfiltered match set containing tenant B's row.
		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			NOTE_B_FULL,
		]);

		const handler = handlers.get("search_briefing_notes_by_keyword");
		expect(
			handler,
			"search_briefing_notes_by_keyword must be registered",
		).toBeDefined();

		const result = await handler?.({ query: NOTE_B_MARKER });
		const parsed = parseResult(result) as Array<{ content?: string }>;

		// Assertion states the FIX contract: tenant A must never receive
		// tenant B's row. Fails RED against current code (no scopeFilterList
		// call at tools.ts:5380-5394) because parsed still contains NOTE_B.
		expect(
			parsed.some((n) => n.content?.includes(NOTE_B_MARKER)),
			"tenant A must not receive tenant B's note content",
		).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GREEN — both poles: leak closed AND owner still finds their own notes
// ─────────────────────────────────────────────────────────────────────────────

describe("GREEN — search_briefing_notes_by_keyword scoped correctly", () => {
	it("(a) tenant A never receives tenant B's note via the same call", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			NOTE_B_FULL,
		]);

		const handler = handlers.get("search_briefing_notes_by_keyword");
		const result = await handler?.({ query: NOTE_B_MARKER });
		const parsed = parseResult(result) as Array<{ content?: string }>;

		expect(parsed.some((n) => n.content?.includes(NOTE_B_MARKER))).toBe(
			false,
		);
	});

	// Split into two independent tests (not one compound assertion): the
	// owner-access pole must be able to fail on its own, distinctly from the
	// cross-tenant-deny pole. A single `it` with two `expect`s would let
	// vitest halt on the first failing assertion and hide the second —
	// indistinguishable in the report from "both poles fine". This is the
	// exact defect class already seen 9 times in this codebase: a guard that
	// refuses everyone, owner included, must be able to show up as its own
	// distinct RED, not be masked by (or conflated with) the deny-pole.

	it("(b1) tenant A's own note IS returned — owner-access pole, asserted alone", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		// Convex returns a mixed match set: A's own note + B's note (as it
		// would when the underlying query itself isn't tenant-scoped).
		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			NOTE_A_FULL,
			NOTE_B_FULL,
		]);

		const handler = handlers.get("search_briefing_notes_by_keyword");
		const result = await handler?.({ query: "roadmap" });
		const parsed = parseResult(result) as Array<{ _id?: string }>;

		expect(
			parsed.some((n) => n._id === NOTE_A_FULL._id),
			"tenant A's own note must still be returned — a guard that refuses everyone including the owner is a different defect",
		).toBe(true);
	});

	it("(b2) tenant B's note is NOT returned to A — cross-tenant-deny pole, asserted alone", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			NOTE_A_FULL,
			NOTE_B_FULL,
		]);

		const handler = handlers.get("search_briefing_notes_by_keyword");
		const result = await handler?.({ query: "roadmap" });
		const parsed = parseResult(result) as Array<{ _id?: string }>;

		expect(parsed.some((n) => n._id === NOTE_B_FULL._id)).toBe(false);
	});

	it("master scope sees both notes unfiltered (no regression on internal/admin callers)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, undefined); // legacy/master path — oauthCtx undefined

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			NOTE_A_FULL,
			NOTE_B_FULL,
		]);

		const handler = handlers.get("search_briefing_notes_by_keyword");
		const result = await handler?.({ query: "roadmap" });
		const parsed = parseResult(result) as Array<{ _id?: string }>;

		expect(parsed.length).toBe(2);
	});
});
