/**
 * search_tasks_by_keyword — cross-tenant CONTENT leak / refus-total fix.
 *
 * VP task k175j2jems5deccegp4p0fy4x98b4ypn.
 *
 * MEASURED (before fix): task rows DO carry `createdBy` (schema.ts:258) and
 * the FULL Convex projection renders it, but this tool's DEFAULT requested
 * mode is "lite", and the lite projection (tasks.ts:2119-2126) strips
 * createdBy before it reaches this handler. A naive scopeFilterList(rows)
 * wrap over the default lite payload finds no createdBy/namespace to
 * discriminate on and refuses every non-master caller — owner included
 * (refus-total). The fix always requests fields="full" from Convex
 * internally, filters with scopeFilterList against the real createdBy, then
 * reprojects to the tool's public lite shape unless the caller explicitly
 * asked for fields="full".
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

const TASK_A_OWN_FULL = {
	_id: "task-fixture-alpha-001",
	_creationTime: 1780000001000,
	title: "Alpha's own task about hooks",
	status: "todo",
	priority: "medium",
	assignedTo: "alpha-role",
	createdBy: "alpha-role",
	missionId: undefined,
	createdAt: 1780000001000,
	updatedAt: 1780000001000,
};

const TASK_B_MARKER = "CANARY-BETA-task-fx55d2";

const TASK_B_OTHER_FULL = {
	_id: "task-fixture-beta-001",
	_creationTime: 1780000000000,
	title: `Beta confidential task ${TASK_B_MARKER}`,
	status: "todo",
	priority: "high",
	assignedTo: "beta-role",
	createdBy: "beta-role",
	missionId: undefined,
	createdAt: 1780000000000,
	updatedAt: 1780000000000,
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. RED (i) — reproduction: naive lite-mode wrap would refuse the OWNER too
// ─────────────────────────────────────────────────────────────────────────────

describe("RED — search_tasks_by_keyword refus-total on default lite mode", () => {
	it("caller A's own task must still be returned in default (lite) mode", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		// Convex is always called with fields:"full" internally per the fix —
		// the mock returns the full rows the handler requests.
		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			TASK_A_OWN_FULL,
			TASK_B_OTHER_FULL,
		]);

		const handler = handlers.get("search_tasks_by_keyword");
		expect(handler, "search_tasks_by_keyword must be registered").toBeDefined();

		const result = await handler?.({ query: "task" });
		const parsed = parseResult(result) as Array<{ _id?: string }>;

		expect(
			parsed.some((t) => t._id === TASK_A_OWN_FULL._id),
			"a guard that refuses everyone including the owner (default lite mode strips createdBy) is refus-total, not a targeted deny",
		).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GREEN — four independently-moving assertions
// ─────────────────────────────────────────────────────────────────────────────

describe("GREEN — search_tasks_by_keyword scoped correctly (four independent poles)", () => {
	it("(ii) OWNER pole alone — caller A's own task IS returned, in lite shape", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			TASK_A_OWN_FULL,
			TASK_B_OTHER_FULL,
		]);

		const handler = handlers.get("search_tasks_by_keyword");
		const result = await handler?.({ query: "task" });
		const parsed = parseResult(result) as Array<Record<string, unknown>>;

		const own = parsed.find((t) => t._id === TASK_A_OWN_FULL._id);
		expect(own).toBeDefined();
		// Public lite shape preserved: createdBy must not leak into the
		// default response even though it was used internally for the filter.
		expect(own).not.toHaveProperty("createdBy");
		expect(own).toHaveProperty("title", TASK_A_OWN_FULL.title);
	});

	it("(iii) DENY pole alone — caller B's task content is not rendered to caller A", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			TASK_A_OWN_FULL,
			TASK_B_OTHER_FULL,
		]);

		const handler = handlers.get("search_tasks_by_keyword");
		const result = await handler?.({ query: "task" });
		const parsed = parseResult(result) as Array<{ _id?: string; title?: string }>;

		expect(parsed.some((t) => t._id === TASK_B_OTHER_FULL._id)).toBe(false);
		const raw = JSON.stringify(parsed);
		expect(raw.includes(TASK_B_MARKER)).toBe(false);
	});

	it("(iv) MASTER pole alone — legacy/master callers see all rows unfiltered", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, undefined); // legacy/master path

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			TASK_A_OWN_FULL,
			TASK_B_OTHER_FULL,
		]);

		const handler = handlers.get("search_tasks_by_keyword");
		const result = await handler?.({ query: "task" });
		const parsed = parseResult(result) as Array<{ _id?: string }>;

		expect(parsed.length).toBe(2);
	});

	it("fields='full' request still filters by scope and preserves full shape", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			TASK_A_OWN_FULL,
			TASK_B_OTHER_FULL,
		]);

		const handler = handlers.get("search_tasks_by_keyword");
		const result = await handler?.({ query: "task", fields: "full" });
		const parsed = parseResult(result) as Array<Record<string, unknown>>;

		expect(parsed.length).toBe(1);
		expect(parsed[0]).toHaveProperty("createdBy", "alpha-role");
	});
});
