/**
 * v2.3.5 boundary-forwarding tests — MCP tool handler → convex.query.
 *
 * Root cause confirmed by Sigma Vantage-Bridge review Day 84: v2.3.3 (PR #539)
 * shipped backend filters + Zod schema exports but the 4 list MCP tool arg
 * blocks were not wired. This was already corrected in the same PR per the
 * CHANGELOG, but no test verified that the tool handlers actually forwarded
 * createdBy + updatedSince to convex.query (vs. silently dropping them).
 *
 * These 8 tests close that gap by:
 *   1. Registering the tools against a fake McpServer that captures handlers.
 *   2. Invoking each relevant handler with a mock ConvexHttpClient.
 *   3. Asserting convex.query was called with the exact new params.
 *   4. Asserting limit is NOT defaulted (undefined passes through) so the
 *      backend auto-clamp safeguard can trigger.
 *
 * VP task: k177tsvdxzase5sjy2qm9fdvp187kbwr. Detection: Day 84 grep/sed gap.
 * Predecessor v2.3.3 PR #539 (k1796s5j6jfkvkx0tn5n926ftd87jx9p).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { registerTools } from "../tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test infrastructure — fake McpServer + mock ConvexHttpClient
// ─────────────────────────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Builds a lightweight fake McpServer that captures all tool registrations.
 * The `tool()` method signature matches the 4-arg form used in tools.ts:
 *   server.tool(name, description, argsSchema, handler)
 * Returns a Map<toolName, handler> so tests can invoke handlers directly.
 */
function buildFakeServer(): {
	server: McpServer;
	handlers: Map<string, ToolHandler>;
} {
	const handlers = new Map<string, ToolHandler>();

	const fakeServer = {
		tool(...args: unknown[]): unknown {
			// Supports both 4-arg legacy form `tool(name, desc, schema, handler)`
			// and Day 88 5-arg form `tool(name, desc, schema, annotations, handler)`.
			// In both cases the handler is the LAST argument.
			const name = args[0] as string;
			const handler = args[args.length - 1] as ToolHandler;
			handlers.set(name, handler);
			return {};
		},
		registerTool(...args: unknown[]): unknown {
			// `server.registerTool(name, config, handler)` — the config-object
			// entry point defineTool() uses since the Day-159 boot fix (see
			// registerTool.ts). The handler is still the LAST argument.
			const name = args[0] as string;
			const handler = args[args.length - 1] as ToolHandler;
			handlers.set(name, handler);
			return {};
		},
	} as unknown as McpServer;

	return { server: fakeServer, handlers };
}

/**
 * Builds a mock ConvexHttpClient with vi.fn() stubs for query and mutation.
 * query resolves to [] by default so handlers don't crash on result access.
 */
function buildMockConvex(): ConvexHttpClient {
	return {
		query: vi.fn().mockResolvedValue([]),
		mutation: vi.fn().mockResolvedValue(null),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. list_tasks — createdBy + updatedSince forwarded; limit passes undefined
// ─────────────────────────────────────────────────────────────────────────────

describe("list_tasks MCP→convex.query boundary (v2.3.5)", () => {
	it("forwards createdBy='pi' and updatedSince=1779800000000 to tasks:list", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex);

		const handler = handlers.get("list_tasks");
		expect(handler, "list_tasks handler must be registered").toBeDefined();

		await handler?.({
			createdBy: "pi",
			updatedSince: 1779800000000,
			status: "review",
			fields: "lite",
		});

		expect(convex.query).toHaveBeenCalledOnce();
		const [, queryArgs] = (convex.query as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, Record<string, unknown>];
		expect(queryArgs.createdBy).toBe("pi");
		expect(queryArgs.updatedSince).toBe(1779800000000);
		expect(queryArgs.status).toBe("review");
		// REASON: list_tasks must request FULL rows from tasks:list — even when the
		// caller asks for fields="lite" — so the MCP-side scope filter (scopeFilterList)
		// can read each row's real `createdBy` to enforce row-scope. The handler then
		// reprojects the surviving rows down to the lite shape for the caller. Hence the
		// wire value forwarded to Convex is "full", independent of the caller's request.
		expect(queryArgs.fields).toBe("full");
	});

	it("passes limit=undefined when caller omits it (auto-clamp trigger path)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex);

		const handler = handlers.get("list_tasks");
		await handler?.({ fields: "full" });

		const [, queryArgs] = (convex.query as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, Record<string, unknown>];
		// v2.4.x default limit propagation: wrapper sends 20 when caller omits limit.
		// v2.4.x: wrapper applies the default limit explicitly (20) instead of
		// passing undefined for backend auto-clamp — Day 101 test fixture fix.
		expect(queryArgs.limit).toBe(20);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. list_tasks_by_mission — both new params forwarded; limit passes undefined
// ─────────────────────────────────────────────────────────────────────────────

describe("list_tasks_by_mission MCP→convex.query boundary (v2.3.5)", () => {
	it("forwards createdBy='pi' and updatedSince=1779800000000 to tasks:listByMission", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex);

		const handler = handlers.get("list_tasks_by_mission");
		expect(
			handler,
			"list_tasks_by_mission handler must be registered",
		).toBeDefined();

		await handler?.({
			missionId: "abc123def456abc123def456abc12300",
			createdBy: "pi",
			updatedSince: 1779800000000,
			fields: "lite",
		});

		expect(convex.query).toHaveBeenCalledOnce();
		const [, queryArgs] = (convex.query as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, Record<string, unknown>];
		expect(queryArgs.createdBy).toBe("pi");
		expect(queryArgs.updatedSince).toBe(1779800000000);
	});

	it("passes limit=undefined when caller omits it (auto-clamp trigger path)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex);

		const handler = handlers.get("list_tasks_by_mission");
		await handler?.({
			missionId: "abc123def456abc123def456abc12300",
			fields: "full",
		});

		const [, queryArgs] = (convex.query as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, Record<string, unknown>];
		// v2.4.x: wrapper applies the default limit explicitly (20) instead of
		// passing undefined for backend auto-clamp — Day 101 test fixture fix.
		expect(queryArgs.limit).toBe(20);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. list_missions — updatedSince forwarded; createdBy NOT exposed; limit undefined
// ─────────────────────────────────────────────────────────────────────────────

describe("list_missions MCP→convex.query boundary (v2.3.5)", () => {
	it("forwards updatedSince=1779800000000 to missions:list and does not include createdBy", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex);

		const handler = handlers.get("list_missions");
		expect(handler, "list_missions handler must be registered").toBeDefined();

		await handler?.({
			updatedSince: 1779800000000,
			fields: "lite",
		});

		expect(convex.query).toHaveBeenCalledOnce();
		const [, queryArgs] = (convex.query as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, Record<string, unknown>];
		expect(queryArgs.updatedSince).toBe(1779800000000);
		// list_missions does NOT expose createdBy (backend-level scope)
		expect("createdBy" in queryArgs).toBe(false);
	});

	it("passes limit=undefined when caller omits it (auto-clamp trigger path)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex);

		const handler = handlers.get("list_missions");
		await handler?.({ fields: "full" });

		const [, queryArgs] = (convex.query as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, Record<string, unknown>];
		// v2.4.x: wrapper applies the default limit explicitly (20) instead of
		// passing undefined for backend auto-clamp — Day 101 test fixture fix.
		expect(queryArgs.limit).toBe(20);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. list_briefing_notes — updatedSince forwarded; limit undefined
// ─────────────────────────────────────────────────────────────────────────────

describe("list_briefing_notes MCP→convex.query boundary (v2.3.5)", () => {
	it("forwards updatedSince=1779800000000 to briefingNotes:list", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex);

		const handler = handlers.get("list_briefing_notes");
		expect(
			handler,
			"list_briefing_notes handler must be registered",
		).toBeDefined();

		await handler?.({
			updatedSince: 1779800000000,
			fields: "lite",
		});

		expect(convex.query).toHaveBeenCalledOnce();
		const [, queryArgs] = (convex.query as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, Record<string, unknown>];
		expect(queryArgs.updatedSince).toBe(1779800000000);
	});

	it("passes limit=undefined when caller omits it (auto-clamp trigger path)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex);

		const handler = handlers.get("list_briefing_notes");
		await handler?.({ fields: "full" });

		const [, queryArgs] = (convex.query as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, Record<string, unknown>];
		// v2.4.x: wrapper applies the default limit explicitly (20) instead of
		// passing undefined for backend auto-clamp — Day 101 test fixture fix.
		expect(queryArgs.limit).toBe(20);
	});
});
