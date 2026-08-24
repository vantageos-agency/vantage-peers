/**
 * list_errors / get_error — refus-total closed by structural removal from
 * the client surface (errorLogs has NO client-owner field).
 *
 * VP task k177617dqg6z5c099p1rdp5rqn8b2rp0.
 *
 * MEASURED (before fix): errorLogs rows (schema.ts:895) carry no
 * `createdBy`-equivalent and no per-tenant `namespace` — they are fleet-ops
 * monitoring data spanning ALL monitored deployments. scopeFilterList found
 * nothing to discriminate on and refused EVERY non-master caller
 * (refus-total — dead functionality, not isolation, since there is no client
 * owner to grant access back to). The fix declares both tools master-only
 * (`{ kind: "master" }`) — a structural removal from the client surface, not
 * an invented ownership field. Intended behavior change: non-master callers
 * previously got a silent empty list; they now get an explicit Forbidden
 * error.
 *
 * METHOD CONSTRAINT: a positive control on a known-guarded tool
 * (get_briefing_note) runs first so a pattern that returns zero on a guarded
 * tool is disqualified from being read as "denied".
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

function items(parsed: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
	const obj = parsed as { items?: Array<Record<string, unknown>> };
	return obj.items ?? [];
}

const CALLER_ALPHA: OAuthContext = {
	clientId: "client-fixture-alpha",
	userId: "user-fixture-alpha",
	scopes: ["mcp:full"],
	scopeProfile: "tenant",
	fromAllowList: ["alpha"],
	namespaceReadPrefixes: ["team/org-fixture-alpha"],
	namespaceWritePrefixes: ["team/org-fixture-alpha"],
	expiresAt: Date.now() + 3600_000,
	isMaster: false,
};

const MASTER_CALLER: OAuthContext = {
	clientId: "client-fixture-master",
	userId: "user-fixture-master",
	scopes: ["mcp:full"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3600_000,
	isMaster: true,
};

const ERROR_ROW = {
	_id: "error-fixture-001",
	_creationTime: 1780000000000,
	hash: "abc123",
	deployment: "vantage-prod",
	functionName: "messages:list",
	errorMessage: "boom",
	firstSeen: 1780000000000,
	lastSeen: 1780000000000,
	count: 3,
};

// ─────────────────────────────────────────────────────────────────────────────
// 0. POSITIVE CONTROL
// ─────────────────────────────────────────────────────────────────────────────

describe("POSITIVE CONTROL — get_briefing_note (known scopeFilterGet call site)", () => {
	it("tenant A is denied reading tenant B's note by ID — NON-ZERO evidence", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

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
		expect(isErrorResult(result)).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. RED — no non-master caller (owner included, since there IS no owner)
//    should get a silent empty list; that WAS the refus-total pre-fix.
// ─────────────────────────────────────────────────────────────────────────────

describe("RED — list_errors / get_error refus-total reproduction (pre-fix behavior)", () => {
	it("non-master caller gets an EXPLICIT Forbidden, not a silent empty list", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			ERROR_ROW,
		]);

		const handler = handlers.get("list_errors");
		expect(handler, "list_errors must be registered").toBeDefined();

		const result = await handler?.({});
		expect(
			isErrorResult(result),
			"pre-fix this silently returned [] (refus-total); post-fix it must be an explicit Forbidden",
		).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GREEN — four independent poles (no per-row owner pole; table has none)
// ─────────────────────────────────────────────────────────────────────────────

describe("GREEN — list_errors / get_error master-only (four independent poles)", () => {
	it("(ii) 'OWNER' pole — there is no client owner, so non-master gets a clean deny (not empty list)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			ERROR_ROW,
		]);

		const handler = handlers.get("list_errors");
		const result = await handler?.({});

		expect(isErrorResult(result)).toBe(true);
		const r = result as { content: Array<{ text: string }> };
		expect(r.content[0].text).toMatch(/master scope/i);
	});

	it("(iii) DENY pole alone — non-master never receives error rows", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			ERROR_ROW,
		]);

		const handler = handlers.get("list_errors");
		const result = await handler?.({});
		const r = result as { content: Array<{ text: string }> };
		expect(r.content[0].text).not.toContain(ERROR_ROW._id);
	});

	it("(iv) MASTER pole alone — master caller sees all rows", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, MASTER_CALLER);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			ERROR_ROW,
		]);

		const handler = handlers.get("list_errors");
		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(parsed.some((e) => e._id === ERROR_ROW._id)).toBe(true);
	});

	it("no-context (oauthCtx undefined) is REFUSED — absence is never master", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, undefined);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			ERROR_ROW,
		]);

		const handler = handlers.get("list_errors");
		const result = await handler?.({});

		// Master-only tool + absent identity → explicit Forbidden, no rows.
		expect(isErrorResult(result)).toBe(true);
	});
});

describe("get_error — master-only, same class fix", () => {
	it("non-master caller is denied (RED reproduction: pre-fix this returned a silent-filtered null)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ERROR_ROW);

		const handler = handlers.get("get_error");
		expect(handler, "get_error must be registered").toBeDefined();

		const result = await handler?.({ errorId: ERROR_ROW._id });
		expect(isErrorResult(result)).toBe(true);
	});

	it("master caller sees the row", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, MASTER_CALLER);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ERROR_ROW);

		const handler = handlers.get("get_error");
		const result = await handler?.({ errorId: ERROR_ROW._id });
		const parsed = parseResult(result) as { _id?: string };

		expect(parsed._id).toBe(ERROR_ROW._id);
	});
});
