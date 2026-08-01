/**
 * list_messages — cross-tenant CONTENT leak / refus-total fix.
 *
 * VP task k1780azk7n8fdb7bpnx5n91sx18b5vjf (sibling of
 * k175j2jems5deccegp4p0fy4x98b4ypn).
 *
 * MEASURED (before fix): message rows carry `from` (schema.ts:149,
 * creatorValidator), NOT `createdBy` and NOT `namespace`. list_messages
 * called scopeFilterList(oauthCtx, rows) directly on rows shaped {_id, from,
 * channel, content, sessionDay, createdAt} with no remap — scopeFilterList
 * found no field to discriminate on and refused EVERY non-master caller,
 * sender included (refus-total, proven by the prior version of this file:
 * list-messages-refus-total-measurement.test.ts, superseded by this one).
 * The fix remaps `from` -> `createdBy` before scopeFilterList (identical
 * pattern to search_messages_by_keyword, tools.ts ~3399-3423; both trace to
 * the list_broadcast_status precedent, tools.ts:3502-3509), then strips the
 * synthetic field from the response.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../auth.js";
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

function rowsOf(parsed: unknown): Array<{ _id?: string; content?: string }> {
	if (Array.isArray(parsed)) return parsed;
	const withItems = parsed as { items?: Array<{ _id?: string; content?: string }> };
	return withItems.items ?? [];
}

// Non-wildcard fromAllowList — a real non-master, non-legacy caller.
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

const MSG_B_MARKER = "CANARY-BETA-msg-fx82e3";

const MSG_A_OWN = {
	_id: "message-fixture-alpha-003",
	_creationTime: 1780000001000,
	from: "alpha-role",
	channel: "sigma",
	content: "alpha's own message, no marker here",
	sessionDay: 141,
	createdAt: 1780000001000,
};

const MSG_B_OTHER = {
	_id: "message-fixture-beta-003",
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
			_id: "note-fixture-beta-003",
			_creationTime: 1780000000000,
			title: "Beta internal roadmap",
			topic: "planning",
			content: "Confidential beta content",
			createdBy: "org-fixture-beta",
			createdAt: 1780000000000,
		});

		const handler = handlers.get("get_briefing_note");
		expect(handler, "get_briefing_note must be registered").toBeDefined();

		const result = await handler?.({ noteId: "note-fixture-beta-003" });
		expect(
			isErrorResult(result),
			"positive control FAILED if this is not an error — instrument is inert",
		).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. RED (i) — reproduction that fails WITHOUT the fix
// ─────────────────────────────────────────────────────────────────────────────

describe("RED — list_messages refus-total on default (non-master) call", () => {
	it("caller A's own message must be returned, not dropped to zero", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			MSG_A_OWN,
		]);

		const handler = handlers.get("list_messages");
		expect(handler, "list_messages must be registered").toBeDefined();

		const result = await handler?.({ from: "alpha-role" });
		const rows = rowsOf(parseResult(result));

		expect(
			rows.some((m) => m._id === MSG_A_OWN._id),
			"a guard that refuses everyone including the owner is refus-total, not a targeted deny — this is the exact defect fixed here",
		).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GREEN — four independently-moving assertions
// ─────────────────────────────────────────────────────────────────────────────

describe("GREEN — list_messages scoped correctly (four independent poles)", () => {
	it("(ii) OWNER pole alone — non-master caller retrieves THEIR OWN messages", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			MSG_A_OWN,
			MSG_B_OTHER,
		]);

		const handler = handlers.get("list_messages");
		const result = await handler?.({});
		const rows = rowsOf(parseResult(result));

		expect(rows.some((m) => m._id === MSG_A_OWN._id)).toBe(true);
	});

	it("(iii) DENY pole alone — caller A does not receive caller B's messages", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			MSG_A_OWN,
			MSG_B_OTHER,
		]);

		const handler = handlers.get("list_messages");
		const result = await handler?.({});
		const rows = rowsOf(parseResult(result));

		expect(rows.some((m) => m._id === MSG_B_OTHER._id)).toBe(false);
		const raw = JSON.stringify(rows);
		expect(raw.includes(MSG_B_MARKER)).toBe(false);
	});

	it("(iv) MASTER pole alone — legacy/master callers see all rows unfiltered", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, undefined); // legacy/master path — oauthCtx undefined

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			MSG_A_OWN,
			MSG_B_OTHER,
		]);

		const handler = handlers.get("list_messages");
		const result = await handler?.({});
		const rows = rowsOf(parseResult(result));

		expect(rows.length).toBe(2);
	});

	it("does not leak the synthetic `createdBy` remap field into the response", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			MSG_A_OWN,
		]);

		const handler = handlers.get("list_messages");
		const result = await handler?.({});
		const rows = rowsOf(parseResult(result)) as Array<Record<string, unknown>>;

		expect(rows[0]).not.toHaveProperty("createdBy");
		expect(rows[0]).toHaveProperty("from", "alpha-role");
	});
});
