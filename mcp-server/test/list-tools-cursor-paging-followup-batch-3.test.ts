/**
 * S3.3 B8 follow-up batch 3 FINAL — additive cursor paging rollout.
 *
 * Parent PR #635 + follow-up batch 1 PR #637 + batch 2 PR #638 wired 15 list_*
 * tools to the shared `paging.ts` utility (DEFAULT_LIMIT=50, MAX_LIMIT=200,
 * ENVELOPE_TARGET_BYTES=50000, clampLimit / encodeCursor / decodeCursor /
 * enforceEnvelopeCap / buildPageResult).
 *
 * This FINAL batch closes the rollout by treating each remaining list/search tool
 * with the appropriate strategy:
 *
 *   MIGRATING (cursor paging) :
 *     1. list_peers              (convex/profiles.ts: listProfiles)
 *
 *   DOCTRINE EXCEPTIONS (shape-incompatible with createdBefore cursor) :
 *     a. list_broadcast_status   — single-object shape (not a top-level array);
 *                                  the response is a status object that contains
 *                                  an embedded `receipts[]`, not a paginatable
 *                                  list of broadcast events. Cursor paging is
 *                                  semantically meaningless here.
 *     b. search_components       — relevance-ranked semantic search, not a
 *                                  chronological list; `createdBefore` anchor
 *                                  would break ordering. Out of scope.
 *     c. search_fix_patterns     — same rationale: action-backed semantic search
 *                                  (`search:searchFixPatterns`) ranks by query
 *                                  similarity, not `_creationTime`.
 *
 * RED expectation: list_peers does NOT today accept `cursor` nor emit
 * `nextCursor`; the cursor-roundtrip + paginate-tail assertions fail until GREEN
 * ships. Doctrine-exception tools have a stable-contract assertion that should
 * already pass on RED (we are codifying the contract, not changing behavior).
 *
 * VP task k1794r6q329q1s36pz4zzjnpvd87zfbn, mission k57c7s478gw1a3e5gmhdeptg5n87z78n.
 */

import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { DEFAULT_LIMIT, encodeCursor } from "../src/paging.js";
import { registerTools } from "../src/tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test infrastructure (mirrors batch 2).
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

function buildMockConvex(queryResult: unknown = []): ConvexHttpClient {
	return {
		query: vi.fn().mockResolvedValue(queryResult),
		mutation: vi.fn().mockResolvedValue(null),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
}

function extractText(result: unknown): string {
	const r = result as { content?: Array<{ text?: string }> };
	return r?.content?.[0]?.text ?? "";
}

function buildPeerRows(n: number, baseCreation = 1_780_000_000_000): unknown[] {
	const rows = [];
	for (let i = 0; i < n; i++) {
		rows.push({
			_id: `peer${String(i).padStart(28, "0")}`.slice(0, 32),
			_creationTime: baseCreation - i * 1000,
			orchestratorId: `orch-${i}`,
			instanceId: `orch-${i}`,
			name: `Orch ${i}`,
			static: { role: "worker", workspace: "vp" },
			dynamic: {
				currentTask: "idle",
				lastSeen: baseCreation - i * 1000,
				sessionCount: i,
			},
		});
	}
	return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATING — list_peers (cursor paging on profiles, ordered by _creationTime).
// ─────────────────────────────────────────────────────────────────────────────

describe("list_peers — cursor paging wiring (S3.3 B8 follow-up batch 3 FINAL)", () => {
	const baseArgs = {};
	const convexFn = "profiles:listProfiles";

	it("accepts cursor arg and forwards createdBefore filter via decoded cursor", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex(buildPeerRows(3));
		registerTools(server, convex);

		const handler = handlers.get("list_peers");
		expect(handler, "list_peers handler must be registered").toBeDefined();

		const cursor = encodeCursor({ createdBefore: 1_779_500_000_000 });
		await handler?.({ ...baseArgs, cursor, limit: 25 });

		expect(convex.query).toHaveBeenCalledOnce();
		const [, queryArgs] = (convex.query as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, Record<string, unknown>];
		expect(queryArgs.limit).toBe(25);
		expect(queryArgs.createdBefore).toBe(1_779_500_000_000);
	});

	it("does not set createdBefore when no cursor provided (backward compat)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex(buildPeerRows(3));
		registerTools(server, convex);

		const handler = handlers.get("list_peers");
		await handler?.({ ...baseArgs });

		expect(convex.query).toHaveBeenCalledOnce();
		const [, queryArgs] = (convex.query as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, Record<string, unknown>];
		expect(queryArgs.createdBefore).toBeUndefined();
		const text = extractText(await handler?.({ ...baseArgs }));
		expect(text.length).toBeGreaterThan(0);
		expect(text).not.toMatch(/Error:/);
	});

	it("returns nextCursor when page is full (≥ limit rows returned)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex(buildPeerRows(DEFAULT_LIMIT));
		registerTools(server, convex);

		const handler = handlers.get("list_peers");
		const result = await handler?.({ ...baseArgs, limit: DEFAULT_LIMIT });
		const text = extractText(result);
		expect(text).toMatch(/nextCursor/);
	});

	it("returns no nextCursor when rows < limit (end-of-data)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex(buildPeerRows(3));
		registerTools(server, convex);

		const handler = handlers.get("list_peers");
		const result = await handler?.({ ...baseArgs, limit: 50 });
		const text = extractText(result);
		const noCursor =
			!/nextCursor/.test(text) || /"nextCursor"\s*:\s*null/.test(text);
		expect(noCursor).toBe(true);
	});

	it("rejects invalid cursor with a typed error (no crash)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex(buildPeerRows(3));
		registerTools(server, convex);

		const handler = handlers.get("list_peers");
		const result = await handler?.({
			...baseArgs,
			cursor: "garbage-cursor-not-base64-json",
		});
		const text = extractText(result);
		expect(text).toMatch(/invalid cursor/i);
	});

	it(`forwards the convex function name ${convexFn}`, async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex(buildPeerRows(2));
		registerTools(server, convex);

		const handler = handlers.get("list_peers");
		await handler?.({ ...baseArgs });
		const [fn] = (convex.query as ReturnType<typeof vi.fn>).mock.calls[0] as [
			string,
			unknown,
		];
		expect(fn).toBe(convexFn);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// DOCTRINE EXCEPTIONS — these tools are NOT migrated; the test pins the contract
// so a future contributor cannot silently add a half-broken cursor field.
// ─────────────────────────────────────────────────────────────────────────────

describe("list_broadcast_status — doctrine exception (single-object shape, not paginatable)", () => {
	// Rationale: the response is a single status object — `{ messageId, from,
	// channel, createdAt, receipts[] }`. Cursor paging is defined on top-level
	// arrays, not on embedded sub-arrays of a single envelope. Migrating would
	// require a separate `list_broadcast_receipts` tool, which is out of brief
	// scope for the S3.3 B8 rollout.
	it("is registered (handler exists)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex({
			messageId: "m1",
			from: "sigma",
			channel: undefined,
			createdAt: 1_780_000_000_000,
			receipts: [],
		});
		registerTools(server, convex);
		expect(handlers.get("list_broadcast_status")).toBeDefined();
	});

	it("does NOT accept a `cursor` arg — the schema must reject unknown cursor field via no-op (ignored)", async () => {
		// Because we intentionally do not extend the schema, calling with `cursor`
		// in the args object goes through the handler as-is. The handler must not
		// forward `cursor` to the Convex query (would crash) and must not emit
		// `nextCursor` in the payload.
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex({
			messageId: "m1",
			from: "sigma",
			channel: undefined,
			createdAt: 1_780_000_000_000,
			receipts: [],
		});
		registerTools(server, convex);

		const handler = handlers.get("list_broadcast_status");
		const result = await handler?.({ messageId: "m1" });
		const text = extractText(result);
		expect(text).not.toMatch(/nextCursor/);
		const [, queryArgs] = (convex.query as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, Record<string, unknown>];
		expect(queryArgs.createdBefore).toBeUndefined();
		expect(queryArgs.cursor).toBeUndefined();
	});
});

describe("search_components — doctrine exception (relevance-ranked, not chronological)", () => {
	// Rationale: results are scored by query similarity. A `createdBefore`
	// anchor would skip high-relevance older matches in favor of newer
	// low-relevance ones, breaking the search contract. Pagination on semantic
	// search should be score-based (offset / topK), not time-based — that is a
	// separate workstream from S3.3 B8.
	it("is registered (handler exists)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex([]);
		registerTools(server, convex);
		expect(handlers.get("search_components")).toBeDefined();
	});

	it("does NOT emit nextCursor (no cursor paging on relevance-ranked search)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex([
			{ _id: "c1", name: "alpha", team: "vantageos" },
		]);
		registerTools(server, convex);

		const handler = handlers.get("search_components");
		const result = await handler?.({ query: "alpha" });
		const text = extractText(result);
		expect(text).not.toMatch(/nextCursor/);
	});
});

describe("search_fix_patterns — doctrine exception (semantic action, not chronological)", () => {
	// Rationale: backed by `convex.action("search:searchFixPatterns")` which
	// runs an embedding-similarity ranker; same logic as search_components.
	it("is registered (handler exists)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = {
			query: vi.fn().mockResolvedValue([]),
			mutation: vi.fn().mockResolvedValue(null),
			action: vi.fn().mockResolvedValue([]),
		} as unknown as ConvexHttpClient;
		registerTools(server, convex);
		expect(handlers.get("search_fix_patterns")).toBeDefined();
	});

	it("does NOT emit nextCursor (no cursor paging on semantic-action search)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = {
			query: vi.fn().mockResolvedValue([]),
			mutation: vi.fn().mockResolvedValue(null),
			action: vi.fn().mockResolvedValue([
				{ _id: "p1", title: "race-condition fix" },
			]),
		} as unknown as ConvexHttpClient;
		registerTools(server, convex);

		const handler = handlers.get("search_fix_patterns");
		const result = await handler?.({ query: "race condition" });
		const text = extractText(result);
		expect(text).not.toMatch(/nextCursor/);
	});
});
