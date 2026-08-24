/**
 * search_messages_by_keyword — cross-tenant CONTENT leak / refus-total fix.
 *
 * VP task k175j2jems5deccegp4p0fy4x98b4ypn.
 *
 * MEASURED (before fix): message rows carry `from` (schema.ts:149,
 * creatorValidator), NOT `createdBy` and NOT `namespace`. Both Convex handler
 * branches (full + lite) expose only {_id, from, channel, content,
 * sessionDay, createdAt}. Passing such rows through scopeFilterList unmapped
 * finds no field to discriminate on and refuses EVERY non-master caller —
 * sender included (refus-total), not a targeted cross-tenant leak like the
 * briefing-notes case. The fix remaps `from` -> `createdBy` before calling
 * scopeFilterList (same pattern already used by list_broadcast_status,
 * tools.ts:3502-3509), then strips the synthetic field from the response.
 *
 * METHOD CONSTRAINT: same audit-instrument proof as
 * search-briefing-notes-cross-tenant-scope.test.ts — a positive control on a
 * known-guarded tool (get_briefing_note) runs first so a pattern that
 * returns zero on a guarded tool is disqualified from being read as "denied".
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../auth.js";
import { registerTools } from "../tools.js";

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

// Invented fixtures.
const CALLER_A: OAuthContext = {
	clientId: "client-fixture-alpha",
	userId: "user-fixture-alpha",
	scopes: ["mcp:full"],
	scopeProfile: "tenant",
	fromAllowList: ["alpha-role"],
	namespaceReadPrefixes: ["team/org-fixture-alpha"],
	namespaceWritePrefixes: ["team/org-fixture-alpha"],
	expiresAt: Date.now() + 3600_000,
	isMaster: false,
};

const MSG_B_MARKER = "CANARY-BETA-msg-fx77c1";

const MSG_A_OWN = {
	_id: "message-fixture-alpha-001",
	_creationTime: 1780000001000,
	from: "alpha-role",
	channel: "sigma",
	content: "Alpha's own content, no marker here",
	sessionDay: 141,
	createdAt: 1780000001000,
};

const MSG_B_OTHER = {
	_id: "message-fixture-beta-001",
	_creationTime: 1780000000000,
	from: "beta-role",
	channel: "sigma",
	content: `Confidential beta content containing ${MSG_B_MARKER}`,
	sessionDay: 141,
	createdAt: 1780000000000,
};

// ─────────────────────────────────────────────────────────────────────────────
// 0. POSITIVE CONTROL — prove the instrument on a known-guarded tool
// ─────────────────────────────────────────────────────────────────────────────

describe("POSITIVE CONTROL — get_briefing_note (known scopeFilterGet call site)", () => {
	it("tenant A is denied reading tenant B's note by ID — NON-ZERO evidence", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			_id: "note-fixture-beta-001",
			_creationTime: 1780000000000,
			title: "Beta internal roadmap",
			topic: "planning",
			content: "Confidential beta content",
			createdBy: "org-fixture-beta",
			createdAt: 1780000000000,
		});

		const handler = handlers.get("get_briefing_note");
		expect(handler, "get_briefing_note must be registered").toBeDefined();

		const result = await handler?.({ noteId: "note-fixture-beta-001" });
		expect(
			isErrorResult(result),
			"positive control FAILED if this is not an error — scopeFilterGet is not actually enforced here",
		).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. RED (i) — cross-tenant content leak reproduction, pre-remap
// ─────────────────────────────────────────────────────────────────────────────

describe("RED — search_messages_by_keyword cross-tenant content leak", () => {
	it("caller A searching a term present ONLY in B's message must never receive B's content", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			MSG_B_OTHER,
		]);

		const handler = handlers.get("search_messages_by_keyword");
		expect(
			handler,
			"search_messages_by_keyword must be registered",
		).toBeDefined();

		const result = await handler?.({ query: MSG_B_MARKER });
		const parsed = parseResult(result) as Array<{ content?: string }>;

		expect(
			parsed.some((m) => m.content?.includes(MSG_B_MARKER)),
			"caller A must not receive caller B's message content",
		).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GREEN — four independently-moving assertions
// ─────────────────────────────────────────────────────────────────────────────

describe("GREEN — search_messages_by_keyword scoped correctly (four independent poles)", () => {
	it("(ii) OWNER pole alone — caller A's own message IS returned", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			MSG_A_OWN,
			MSG_B_OTHER,
		]);

		const handler = handlers.get("search_messages_by_keyword");
		const result = await handler?.({ query: "content" });
		const parsed = parseResult(result) as Array<{ _id?: string }>;

		expect(
			parsed.some((m) => m._id === MSG_A_OWN._id),
			"a guard that refuses everyone including the owner is a different (refus-total) defect",
		).toBe(true);
	});

	it("(iii) DENY pole alone — caller B's message is not rendered to caller A", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			MSG_A_OWN,
			MSG_B_OTHER,
		]);

		const handler = handlers.get("search_messages_by_keyword");
		const result = await handler?.({ query: "content" });
		const parsed = parseResult(result) as Array<{ _id?: string }>;

		expect(parsed.some((m) => m._id === MSG_B_OTHER._id)).toBe(false);
	});

	it("(iv) MASTER pole alone — legacy/master callers see all rows unfiltered", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, LOCAL_STDIO_TRUST_CTX); // legacy/master path — oauthCtx undefined

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			MSG_A_OWN,
			MSG_B_OTHER,
		]);

		const handler = handlers.get("search_messages_by_keyword");
		const result = await handler?.({ query: "content" });
		const parsed = parseResult(result) as Array<{ _id?: string }>;

		expect(parsed.length).toBe(2);
	});

	it("does not leak the synthetic `createdBy` remap field into the response", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			MSG_A_OWN,
		]);

		const handler = handlers.get("search_messages_by_keyword");
		const result = await handler?.({ query: "content" });
		const parsed = parseResult(result) as Array<Record<string, unknown>>;

		expect(parsed[0]).not.toHaveProperty("createdBy");
		expect(parsed[0]).toHaveProperty("from", "alpha-role");
	});
});
