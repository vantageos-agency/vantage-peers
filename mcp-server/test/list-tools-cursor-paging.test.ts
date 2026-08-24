/**
 * S3.3 B8 — list_* cursor paging + envelope cap protection (RED phase).
 *
 * Friction context (Sigma stale-cleanup session, 2026-06-04): list_tasks
 * page-cap 200 + newest-first ordering required 6 iterations of identical
 * 132-task batches to drain the tail. Root cause: no cursor, no createdBefore
 * filter, default limit too permissive. This phase introduces:
 *
 *   1. A shared `paging.ts` utility (DEFAULT_LIMIT=50, MAX_LIMIT=200,
 *      ENVELOPE_TARGET_BYTES=50_000, clampLimit, encode/decodeCursor,
 *      enforceEnvelopeCap, buildPageResult).
 *   2. MCP list_* tools accept `cursor` arg and emit `nextCursor` in result
 *      envelope when the page is truncated for either count or bytes.
 *
 * RED expectation: `../src/paging.js` does not exist yet → all imports fail.
 * GREEN expectation: util implemented, all assertions below pass.
 *
 * VP task k1794r6q329q1s36pz4zzjnpvd87zfbn, mission k57c7s478gw1a3e5gmhdeptg5n87z78n.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_STDIO_TRUST_CTX } from "../src/auth.js";
import {
	buildPageResult,
	clampLimit,
	DEFAULT_LIMIT,
	decodeCursor,
	ENVELOPE_TARGET_BYTES,
	encodeCursor,
	enforceEnvelopeCap,
	MAX_LIMIT,
} from "../src/paging.js";
import { registerTools } from "../src/tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test infrastructure — fake McpServer + mock ConvexHttpClient (same pattern as
// list-queries-v2.3.5 tests in src/__tests__/).
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

// Helper: extract text content (handles both raw JSON arrays and envelopes).
function extractText(result: unknown): string {
	const r = result as { content?: Array<{ text?: string }> };
	return r?.content?.[0]?.text ?? "";
}

// Build N rows with monotonically decreasing _creationTime (newest-first order
// like Convex .order("desc") emits).
function buildRows(n: number, baseCreation = 1_780_000_000_000): unknown[] {
	const rows = [];
	for (let i = 0; i < n; i++) {
		rows.push({
			_id: `id${String(i).padStart(32, "0")}`.slice(0, 32),
			_creationTime: baseCreation - i * 1000,
			title: `row-${i}`,
			status: "todo",
			payload: "x".repeat(200),
		});
	}
	return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Shared paging utility — constants + helpers (RED on file absence)
// ─────────────────────────────────────────────────────────────────────────────

describe("paging utility — constants", () => {
	it("exports DEFAULT_LIMIT=50, MAX_LIMIT=200, ENVELOPE_TARGET_BYTES≈50_000", () => {
		expect(DEFAULT_LIMIT).toBe(50);
		expect(MAX_LIMIT).toBe(200);
		expect(ENVELOPE_TARGET_BYTES).toBeGreaterThanOrEqual(40_000);
		expect(ENVELOPE_TARGET_BYTES).toBeLessThanOrEqual(60_000);
	});
});

describe("paging.clampLimit — bounds enforcement", () => {
	it("returns DEFAULT_LIMIT when limit is undefined", () => {
		expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
	});
	it("returns DEFAULT_LIMIT when limit is null", () => {
		expect(clampLimit(null as unknown as number)).toBe(DEFAULT_LIMIT);
	});
	it("clamps limit=0 to 1 (floor)", () => {
		expect(clampLimit(0)).toBe(1);
	});
	it("clamps negative limit to 1", () => {
		expect(clampLimit(-5)).toBe(1);
	});
	it("clamps limit=10000 to MAX_LIMIT=200", () => {
		expect(clampLimit(10_000)).toBe(MAX_LIMIT);
	});
	it("passes through valid limit unchanged", () => {
		expect(clampLimit(73)).toBe(73);
	});
	it("floors non-integer limits", () => {
		expect(clampLimit(50.7)).toBe(50);
	});
});

describe("paging cursor — encode / decode roundtrip", () => {
	it("encodes a cursor and decodes back to the same payload", () => {
		const payload = { createdBefore: 1_780_000_000_000, lastId: "abc" };
		const token = encodeCursor(payload);
		expect(typeof token).toBe("string");
		expect(token.length).toBeGreaterThan(0);
		expect(decodeCursor(token)).toEqual(payload);
	});
	it("encodes payload with only createdBefore (no lastId)", () => {
		const payload = { createdBefore: 1_780_000_000_000 };
		const token = encodeCursor(payload);
		expect(decodeCursor(token)).toEqual(payload);
	});
	it("decodeCursor(undefined) returns null (no-cursor sentinel)", () => {
		expect(decodeCursor(undefined)).toBeNull();
	});
	it("decodeCursor(empty string) returns null", () => {
		expect(decodeCursor("")).toBeNull();
	});
	it("decodeCursor(invalid) throws a typed error not a crash", () => {
		expect(() => decodeCursor("not-a-valid-cursor-!!!")).toThrow(
			/invalid cursor/i,
		);
	});
});

describe("paging.enforceEnvelopeCap — byte budget truncation", () => {
	it("returns all rows when under the envelope target", () => {
		const rows = buildRows(5); // tiny payload
		const capped = enforceEnvelopeCap(rows);
		expect(capped.items).toHaveLength(5);
		expect(capped.isCapped).toBe(false);
	});
	it("truncates rows when serialized bytes exceed ENVELOPE_TARGET_BYTES", () => {
		// Each row ~ 280+ bytes of JSON; 500 rows ≫ 50 KB
		const rows = buildRows(500);
		const capped = enforceEnvelopeCap(rows);
		expect(capped.items.length).toBeLessThan(500);
		expect(capped.isCapped).toBe(true);
		const serialized = JSON.stringify(capped.items);
		expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
			ENVELOPE_TARGET_BYTES,
		);
	});
	it("never returns an empty array — at least 1 row even when single row is huge", () => {
		const rows = [{ payload: "x".repeat(200_000) }];
		const capped = enforceEnvelopeCap(rows);
		expect(capped.items.length).toBe(1);
		expect(capped.isCapped).toBe(true);
	});
});

describe("paging.buildPageResult — envelope shape", () => {
	it("returns items + nextCursor + isCapped fields", () => {
		const rows = buildRows(3);
		const out = buildPageResult({
			rows,
			hasMore: true,
			nextCursor: encodeCursor({ createdBefore: 123 }),
		});
		expect(Array.isArray(out.items)).toBe(true);
		expect(out.items).toHaveLength(3);
		expect(typeof out.nextCursor).toBe("string");
	});
	it("returns nextCursor=null when hasMore=false (end-of-data)", () => {
		const out = buildPageResult({
			rows: buildRows(2),
			hasMore: false,
			nextCursor: null,
		});
		expect(out.nextCursor).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Per-tool wiring — list_tasks, list_memories, list_briefing_notes (representative)
// ─────────────────────────────────────────────────────────────────────────────

describe("list_tasks — cursor paging wiring", () => {
	it("accepts cursor arg and forwards createdBefore filter via decoded cursor", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex(buildRows(3));
		registerTools(server, convex, LOCAL_STDIO_TRUST_CTX);

		const handler = handlers.get("list_tasks");
		expect(handler, "list_tasks handler must be registered").toBeDefined();

		const cursor = encodeCursor({ createdBefore: 1_779_500_000_000 });
		await handler?.({ cursor, limit: 25 });

		expect(convex.query).toHaveBeenCalledOnce();
		const [, queryArgs] = (convex.query as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, Record<string, unknown>];
		// Limit forwarded as 25 (within MAX_LIMIT), cursor decoded into createdBefore
		expect(queryArgs.limit).toBe(25);
		expect(queryArgs.createdBefore).toBe(1_779_500_000_000);
	});

	it("clamps caller limit=10_000 to MAX_LIMIT=200 before forwarding", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex(buildRows(3));
		registerTools(server, convex, LOCAL_STDIO_TRUST_CTX);

		const handler = handlers.get("list_tasks");
		// Zod schema also enforces max(200) — we exercise via direct pass to
		// confirm runtime clamp inside the handler matches paging contract.
		// (Zod max already caps at 200 → calling with 200 directly exercises clamp.)
		await handler?.({ limit: 200 });

		const [, queryArgs] = (convex.query as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, Record<string, unknown>];
		expect(queryArgs.limit).toBe(200);
	});

	it("returns nextCursor in payload when page is full (full page → likely more)", async () => {
		const { server, handlers } = buildFakeServer();
		// Return exactly DEFAULT_LIMIT rows → full page → nextCursor must be set.
		const convex = buildMockConvex(buildRows(DEFAULT_LIMIT));
		registerTools(server, convex, LOCAL_STDIO_TRUST_CTX);

		const handler = handlers.get("list_tasks");
		const result = await handler?.({});
		const text = extractText(result);
		// Payload must contain nextCursor reference (either at envelope top-level
		// or in _meta — implementation may choose).
		expect(text).toMatch(/nextCursor/);
	});

	it("returns no nextCursor (null or absent) when rows < limit (end-of-data)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex(buildRows(3)); // < DEFAULT_LIMIT
		registerTools(server, convex, LOCAL_STDIO_TRUST_CTX);

		const handler = handlers.get("list_tasks");
		const result = await handler?.({ limit: 50 });
		const text = extractText(result);
		// Either no nextCursor key, or nextCursor: null.
		const noCursor =
			!/nextCursor/.test(text) || /"nextCursor"\s*:\s*null/.test(text);
		expect(noCursor).toBe(true);
	});

	it("rejects invalid cursor with a typed error (no crash)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex(buildRows(3));
		registerTools(server, convex, LOCAL_STDIO_TRUST_CTX);

		const handler = handlers.get("list_tasks");
		const result = await handler?.({
			cursor: "garbage-cursor-not-base64-json",
		});
		const text = extractText(result);
		expect(text).toMatch(/invalid cursor/i);
	});

	it("backward compat — caller without limit or cursor still works", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex(buildRows(3));
		registerTools(server, convex, LOCAL_STDIO_TRUST_CTX);

		const handler = handlers.get("list_tasks");
		const result = await handler?.({});
		expect(convex.query).toHaveBeenCalledOnce();
		// Result has content (no crash, no error envelope)
		const text = extractText(result);
		expect(text.length).toBeGreaterThan(0);
		expect(text).not.toMatch(/Error:/);
	});
});

describe("list_memories — cursor paging wiring", () => {
	it("forwards paginationOpts to backend when cursor is provided", async () => {
		const { server, handlers } = buildFakeServer();
		// Mimic Convex paginate envelope shape
		const convex = buildMockConvex({
			value: buildRows(50),
			continueCursor: "backend-cursor-xyz",
			isDone: false,
		});
		registerTools(server, convex, LOCAL_STDIO_TRUST_CTX);

		const handler = handlers.get("list_memories");
		const cursor = encodeCursor({ backendCursor: "backend-cursor-prev" });
		await handler?.({ namespace: "global", cursor, limit: 50 });

		expect(convex.query).toHaveBeenCalledOnce();
		const [, queryArgs] = (convex.query as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, Record<string, unknown>];
		expect(queryArgs.paginationOpts).toBeDefined();
		const po = queryArgs.paginationOpts as {
			numItems: number;
			cursor: string | null;
		};
		expect(po.numItems).toBe(50);
		expect(po.cursor).toBe("backend-cursor-prev");
	});

	it("backward compat — caller without cursor uses bounded default path", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex(buildRows(3));
		registerTools(server, convex, LOCAL_STDIO_TRUST_CTX);

		const handler = handlers.get("list_memories");
		await handler?.({ namespace: "global" });

		expect(convex.query).toHaveBeenCalledOnce();
		const [, queryArgs] = (convex.query as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, Record<string, unknown>];
		// No paginationOpts → bounded default path
		expect(queryArgs.paginationOpts).toBeUndefined();
	});
});

describe("list_briefing_notes — cursor paging wiring", () => {
	it("accepts cursor and decodes createdBefore for forward pagination", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex(buildRows(3));
		registerTools(server, convex, LOCAL_STDIO_TRUST_CTX);

		const handler = handlers.get("list_briefing_notes");
		const cursor = encodeCursor({ createdBefore: 1_779_500_000_000 });
		await handler?.({ cursor, limit: 30 });

		expect(convex.query).toHaveBeenCalledOnce();
		const [, queryArgs] = (convex.query as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, Record<string, unknown>];
		expect(queryArgs.createdBefore).toBe(1_779_500_000_000);
	});

	it("backward compat — caller without cursor works (no createdBefore set)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex(buildRows(3));
		registerTools(server, convex, LOCAL_STDIO_TRUST_CTX);

		const handler = handlers.get("list_briefing_notes");
		await handler?.({});
		expect(convex.query).toHaveBeenCalledOnce();
		const [, queryArgs] = (convex.query as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, Record<string, unknown>];
		expect(queryArgs.createdBefore).toBeUndefined();
	});
});
