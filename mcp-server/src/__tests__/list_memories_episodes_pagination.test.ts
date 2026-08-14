/**
 * list_memories_episodes_pagination.test.ts
 *
 * RED-before-GREEN tests for the Day-114 HIGH bug:
 *   list_memories + list_episodes silently return items: [] because the handler
 *   reads `memories?.page` (undefined) instead of `memories.value` from the
 *   actual Convex shape { value, continueCursor, isDone }.
 *
 * Mission: vp-mcp-pagination-fix-day114-v1 (k57bxpa2wcp7f8xdwne8g3dpfx89f27k)
 * Audit source: projects/vantage-peers/mcp-pagination-audit-day114.md
 * Tools fixed: tools.ts:2508-2523 (list_memories), tools.ts:2161-2175 (list_episodes)
 *
 * Test pattern mirrors list-queries-v2.3.5-wire-createdby-updatedsince.test.ts:
 *   buildFakeServer() captures registered handlers; buildMockConvex() provides
 *   per-test Convex responses via mockResolvedValueOnce.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { encodeCursor } from "../paging.js";
import { registerTools } from "../tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test infrastructure
// ─────────────────────────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Fake McpServer that captures all `tool()` registrations.
 * Supports the 4-arg form: tool(name, desc, schema, handler)
 * and the 5-arg form: tool(name, desc, schema, annotations, handler)
 * (handler is always the last argument).
 */
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

/**
 * Build a mock ConvexHttpClient.
 * `query` defaults to resolving with [] — override per-test with
 * `(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(...)`.
 */
function buildMockConvex(): ConvexHttpClient {
	return {
		query: vi.fn().mockResolvedValue([]),
		mutation: vi.fn().mockResolvedValue(null),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
}

/**
 * Build N fake memory documents.
 */
function makeMemories(n: number): Record<string, unknown>[] {
	return Array.from({ length: n }, (_, i) => ({
		_id: `mem${i.toString().padStart(6, "0")}`,
		_creationTime: 1780000000000 + i,
		namespace: "orchestrator/sigma",
		type: "project",
		content: `Memory content ${i}`,
		createdBy: "sigma",
		isLatest: true,
		createdAt: 1780000000000 + i,
		updatedAt: 1780000000000 + i,
	}));
}

/**
 * Build N fake episode documents (same shape, type='episode').
 */
function makeEpisodes(n: number): Record<string, unknown>[] {
	return Array.from({ length: n }, (_, i) => ({
		_id: `ep${i.toString().padStart(7, "0")}`,
		_creationTime: 1780000000000 + i,
		namespace: "orchestrator/sigma",
		type: "episode",
		content: `Episode content ${i}`,
		createdBy: "sigma",
		isLatest: true,
		createdAt: 1780000000000 + i,
		updatedAt: 1780000000000 + i,
	}));
}

/**
 * Parse the tool result text as JSON. The handler returns
 * `{ content: [{ type: "text", text: "<json>" }] }`.
 */
function parseResult(result: unknown): Record<string, unknown> {
	const r = result as { content: Array<{ type: string; text: string }> };
	return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// list_memories — pagination + envelope
// ─────────────────────────────────────────────────────────────────────────────

describe("list_memories pagination + envelope", () => {
	it("returns items.length == N when N memories seeded (no pagination)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex);

		const mems = makeMemories(15);
		// Convex returns { value, continueCursor: null, isDone: true }
		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			value: mems,
			continueCursor: null,
			isDone: true,
		});

		const handler = handlers.get("list_memories");
		expect(handler, "list_memories handler must be registered").toBeDefined();

		const result = await handler?.({
			namespace: "orchestrator/sigma",
			limit: 20,
		});

		const parsed = parseResult(result);
		// PRE-FIX: memories?.page is undefined → rawList = [] → items.length === 0
		// POST-FIX: memories.value is the array → items.length === 15
		expect(
			Array.isArray(parsed.items),
			"result must have an items array",
		).toBe(true);
		expect(
			(parsed.items as unknown[]).length,
			"items.length must equal seeded count (15), not 0",
		).toBe(15);
	});

	it("returns first page items + nextCursor when N > limit", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex);

		const mems = makeMemories(5);
		const backendToken = "convex-opaque-cursor-abc";
		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			value: mems,
			continueCursor: backendToken,
			isDone: false,
		});

		const handler = handlers.get("list_memories")!;
		const result = await handler({
			namespace: "orchestrator/sigma",
			limit: 5,
		});

		const parsed = parseResult(result);
		expect(
			(parsed.items as unknown[]).length,
			"first page must have 5 items",
		).toBe(5);
		expect(
			typeof parsed.nextCursor,
			"nextCursor must be a string when isDone=false",
		).toBe("string");
	});

	it("paginates fully via nextCursor token chain (3 pages of 5 = 15 total)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex);

		const allMems = makeMemories(15);
		const queryMock = convex.query as ReturnType<typeof vi.fn>;

		// Page 1: items 0-4, not done
		queryMock.mockResolvedValueOnce({
			value: allMems.slice(0, 5),
			continueCursor: "cursor-page-1",
			isDone: false,
		});
		// Page 2: items 5-9, not done
		queryMock.mockResolvedValueOnce({
			value: allMems.slice(5, 10),
			continueCursor: "cursor-page-2",
			isDone: false,
		});
		// Page 3: items 10-14, done
		queryMock.mockResolvedValueOnce({
			value: allMems.slice(10, 15),
			continueCursor: null,
			isDone: true,
		});

		const handler = handlers.get("list_memories")!;

		const accumulated: unknown[] = [];
		let cursor: string | undefined;

		for (let page = 0; page < 10; page++) {
			const result = await handler({
				namespace: "orchestrator/sigma",
				limit: 5,
				...(cursor !== undefined ? { cursor } : {}),
			});
			const parsed = parseResult(result);
			const pageItems = parsed.items as unknown[];
			accumulated.push(...pageItems);
			if (!parsed.nextCursor) break;
			cursor = parsed.nextCursor as string;
		}

		expect(
			accumulated.length,
			"all 15 items must be reachable via cursor chain",
		).toBe(15);
	});

	it("empty backend yields items=[] + no nextCursor", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			value: [],
			continueCursor: null,
			isDone: true,
		});

		const handler = handlers.get("list_memories")!;
		const result = await handler({
			namespace: "orchestrator/sigma",
			limit: 20,
		});

		const parsed = parseResult(result);
		expect(
			(parsed.items as unknown[]).length,
			"empty backend must yield empty items array",
		).toBe(0);
		expect(
			parsed.nextCursor == null || parsed.nextCursor === undefined,
			"nextCursor must be absent or null when backend is empty",
		).toBe(true);
	});

	it("decoded cursor is forwarded to Convex as paginationOpts.cursor", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex);

		const queryMock = convex.query as ReturnType<typeof vi.fn>;
		queryMock.mockResolvedValueOnce({
			value: makeMemories(3),
			continueCursor: null,
			isDone: true,
		});

		const handler = handlers.get("list_memories")!;
		const encodedCursor = encodeCursor({ backendCursor: "backend-cursor-xyz" });

		await handler({
			namespace: "orchestrator/sigma",
			limit: 10,
			cursor: encodedCursor,
		});

		expect(queryMock).toHaveBeenCalledOnce();
		const [, queryArgs] = queryMock.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(
			(queryArgs.paginationOpts as { cursor: string } | undefined)?.cursor,
			"backendCursor must be forwarded to Convex paginationOpts.cursor",
		).toBe("backend-cursor-xyz");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// list_episodes — pagination + envelope (mirrors list_memories)
// ─────────────────────────────────────────────────────────────────────────────

describe("list_episodes pagination + envelope", () => {
	it("returns items.length == N when N episodes seeded (no pagination)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex);

		const eps = makeEpisodes(15);
		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			value: eps,
			continueCursor: null,
			isDone: true,
		});

		const handler = handlers.get("list_episodes");
		expect(handler, "list_episodes handler must be registered").toBeDefined();

		const result = await handler?.({
			namespace: "orchestrator/sigma",
			limit: 20,
		});

		const parsed = parseResult(result);
		// PRE-FIX: memories?.page is undefined → rawList = [] → items.length === 0
		// POST-FIX: memories.value is the array → items.length === 15
		expect(
			Array.isArray(parsed.items),
			"result must have an items array",
		).toBe(true);
		expect(
			(parsed.items as unknown[]).length,
			"items.length must equal seeded count (15), not 0",
		).toBe(15);
	});

	it("returns first page items + nextCursor when N > limit", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex);

		const eps = makeEpisodes(5);
		const backendToken = "convex-episode-cursor-def";
		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			value: eps,
			continueCursor: backendToken,
			isDone: false,
		});

		const handler = handlers.get("list_episodes")!;
		const result = await handler({
			namespace: "orchestrator/sigma",
			limit: 5,
		});

		const parsed = parseResult(result);
		expect(
			(parsed.items as unknown[]).length,
			"first page must have 5 episodes",
		).toBe(5);
		expect(
			typeof parsed.nextCursor,
			"nextCursor must be a string when isDone=false",
		).toBe("string");
	});

	it("paginates fully via nextCursor token chain (3 pages of 5 = 15 total)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex);

		const allEps = makeEpisodes(15);
		const queryMock = convex.query as ReturnType<typeof vi.fn>;

		queryMock.mockResolvedValueOnce({
			value: allEps.slice(0, 5),
			continueCursor: "ep-cursor-page-1",
			isDone: false,
		});
		queryMock.mockResolvedValueOnce({
			value: allEps.slice(5, 10),
			continueCursor: "ep-cursor-page-2",
			isDone: false,
		});
		queryMock.mockResolvedValueOnce({
			value: allEps.slice(10, 15),
			continueCursor: null,
			isDone: true,
		});

		const handler = handlers.get("list_episodes")!;

		const accumulated: unknown[] = [];
		let cursor: string | undefined;

		for (let page = 0; page < 10; page++) {
			const result = await handler({
				namespace: "orchestrator/sigma",
				limit: 5,
				...(cursor !== undefined ? { cursor } : {}),
			});
			const parsed = parseResult(result);
			const pageItems = parsed.items as unknown[];
			accumulated.push(...pageItems);
			if (!parsed.nextCursor) break;
			cursor = parsed.nextCursor as string;
		}

		expect(
			accumulated.length,
			"all 15 episodes must be reachable via cursor chain",
		).toBe(15);
	});

	it("empty backend yields items=[] + no nextCursor", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			value: [],
			continueCursor: null,
			isDone: true,
		});

		const handler = handlers.get("list_episodes")!;
		const result = await handler({
			namespace: "orchestrator/sigma",
			limit: 20,
		});

		const parsed = parseResult(result);
		expect(
			(parsed.items as unknown[]).length,
			"empty backend must yield empty items array",
		).toBe(0);
		expect(
			parsed.nextCursor == null || parsed.nextCursor === undefined,
			"nextCursor must be absent or null when backend is empty",
		).toBe(true);
	});

	it("list_episodes forces type='episode' in Convex query args", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex);

		const queryMock = convex.query as ReturnType<typeof vi.fn>;
		queryMock.mockResolvedValueOnce({
			value: makeEpisodes(2),
			continueCursor: null,
			isDone: true,
		});

		const handler = handlers.get("list_episodes")!;
		await handler({
			namespace: "orchestrator/sigma",
			limit: 10,
		});

		expect(queryMock).toHaveBeenCalledOnce();
		const [, queryArgs] = queryMock.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(queryArgs.type).toBe("episode");
	});

	it("decoded cursor is forwarded to Convex as paginationOpts.cursor", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex);

		const queryMock = convex.query as ReturnType<typeof vi.fn>;
		queryMock.mockResolvedValueOnce({
			value: makeEpisodes(3),
			continueCursor: null,
			isDone: true,
		});

		const handler = handlers.get("list_episodes")!;
		const encodedCursor = encodeCursor({ backendCursor: "ep-backend-cursor-999" });

		await handler({
			namespace: "orchestrator/sigma",
			limit: 10,
			cursor: encodedCursor,
		});

		expect(queryMock).toHaveBeenCalledOnce();
		const [, queryArgs] = queryMock.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(
			(queryArgs.paginationOpts as { cursor: string } | undefined)?.cursor,
			"backendCursor must be forwarded to Convex paginationOpts.cursor",
		).toBe("ep-backend-cursor-999");
	});
});
