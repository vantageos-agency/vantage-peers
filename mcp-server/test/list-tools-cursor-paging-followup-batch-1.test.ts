/**
 * S3.3 B8 follow-up batch 1 — additive cursor paging rollout to 6 more list_* tools.
 *
 * Parent PR #635 (merged main c91ab8a) wired list_tasks, list_memories,
 * list_briefing_notes to the shared `paging.ts` utility (DEFAULT_LIMIT=50,
 * MAX_LIMIT=200, ENVELOPE_TARGET_BYTES=50000, clampLimit / encodeCursor /
 * decodeCursor / enforceEnvelopeCap / buildPageResult). This follow-up batch
 * applies the same backward-compatible pattern to:
 *
 *   1. list_missions          (convex/missions.ts: list)
 *   2. list_diaries           (convex/diary.ts: list)
 *   3. list_components        (convex/components.ts: list)
 *   4. list_recurring_tasks   (convex/recurringTasks.ts: list)
 *   5. list_mandates          (convex/mandates.ts: list)
 *   6. list_bus               (convex/businessUnits.ts: list)
 *
 * Each tool gains a `cursor` arg + optional `createdBefore` forwarded to the
 * Convex query. The Convex queries gain a `createdBefore: v.optional(v.number())`
 * arg + a post-take filter `rows.filter(r => r._creationTime < before)` mirroring
 * the briefingNotes pattern (convex/briefingNotes.ts:96-134, GREEN of PR #635).
 *
 * RED expectation: tools today do NOT accept `cursor` nor emit `nextCursor` —
 * the cursor-roundtrip + paginate-tail assertions fail until GREEN ships.
 * GREEN expectation: per-tool wiring lands + Convex args extended.
 *
 * VP task k1794r6q329q1s36pz4zzjnpvd87zfbn, mission k57c7s478gw1a3e5gmhdeptg5n87z78n.
 */

import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import {
	DEFAULT_LIMIT,
	encodeCursor,
} from "../src/paging.js";
import { registerTools } from "../src/tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test infrastructure — fake McpServer + mock ConvexHttpClient (mirrors
// list-tools-cursor-paging.test.ts of the parent PR #635).
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

function buildRows(n: number, baseCreation = 1_780_000_000_000): unknown[] {
	const rows = [];
	for (let i = 0; i < n; i++) {
		rows.push({
			_id: `id${String(i).padStart(32, "0")}`.slice(0, 32),
			_creationTime: baseCreation - i * 1000,
			title: `row-${i}`,
			status: "active",
			payload: "x".repeat(200),
		});
	}
	return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared expectations factory — every tool follows the same pattern so we
// generate a uniform 5-test block per tool (default forward, explicit limit,
// cursor decode, full-page nextCursor, end-of-data, invalid cursor).
// ─────────────────────────────────────────────────────────────────────────────

interface ToolSpec {
	mcpName: string;
	convexFn: string;
	baseArgs: Record<string, unknown>;
}

const TOOLS: ToolSpec[] = [
	{ mcpName: "list_missions", convexFn: "missions:list", baseArgs: {} },
	{ mcpName: "list_diaries", convexFn: "diary:list", baseArgs: {} },
	{ mcpName: "list_components", convexFn: "components:list", baseArgs: {} },
	{
		mcpName: "list_recurring_tasks",
		convexFn: "recurringTasks:list",
		baseArgs: {},
	},
	{ mcpName: "list_mandates", convexFn: "mandates:list", baseArgs: {} },
	{ mcpName: "list_bus", convexFn: "businessUnits:list", baseArgs: {} },
];

for (const spec of TOOLS) {
	describe(`${spec.mcpName} — cursor paging wiring (S3.3 B8 follow-up)`, () => {
		it("accepts cursor arg and forwards createdBefore filter via decoded cursor", async () => {
			const { server, handlers } = buildFakeServer();
			const convex = buildMockConvex(buildRows(3));
			registerTools(server, convex);

			const handler = handlers.get(spec.mcpName);
			expect(
				handler,
				`${spec.mcpName} handler must be registered`,
			).toBeDefined();

			const cursor = encodeCursor({ createdBefore: 1_779_500_000_000 });
			await handler?.({ ...spec.baseArgs, cursor, limit: 25 });

			expect(convex.query).toHaveBeenCalledOnce();
			const [, queryArgs] = (convex.query as ReturnType<typeof vi.fn>).mock
				.calls[0] as [string, Record<string, unknown>];
			expect(queryArgs.limit).toBe(25);
			expect(queryArgs.createdBefore).toBe(1_779_500_000_000);
		});

		it("does not set createdBefore when no cursor provided (backward compat)", async () => {
			const { server, handlers } = buildFakeServer();
			const convex = buildMockConvex(buildRows(3));
			registerTools(server, convex);

			const handler = handlers.get(spec.mcpName);
			await handler?.({ ...spec.baseArgs });

			expect(convex.query).toHaveBeenCalledOnce();
			const [, queryArgs] = (convex.query as ReturnType<typeof vi.fn>).mock
				.calls[0] as [string, Record<string, unknown>];
			expect(queryArgs.createdBefore).toBeUndefined();
			// Result has content (no crash, no error envelope).
			const text = extractText(await handler?.({ ...spec.baseArgs }));
			expect(text.length).toBeGreaterThan(0);
			expect(text).not.toMatch(/Error:/);
		});

		it("returns nextCursor in payload when page is full (≥ limit rows returned)", async () => {
			const { server, handlers } = buildFakeServer();
			// Return exactly DEFAULT_LIMIT rows → full page → nextCursor must be set.
			const convex = buildMockConvex(buildRows(DEFAULT_LIMIT));
			registerTools(server, convex);

			const handler = handlers.get(spec.mcpName);
			const result = await handler?.({ ...spec.baseArgs, limit: DEFAULT_LIMIT });
			const text = extractText(result);
			expect(text).toMatch(/nextCursor/);
		});

		it("returns no nextCursor (null or absent) when rows < limit (end-of-data)", async () => {
			const { server, handlers } = buildFakeServer();
			const convex = buildMockConvex(buildRows(3));
			registerTools(server, convex);

			const handler = handlers.get(spec.mcpName);
			const result = await handler?.({ ...spec.baseArgs, limit: 50 });
			const text = extractText(result);
			const noCursor =
				!/nextCursor/.test(text) || /"nextCursor"\s*:\s*null/.test(text);
			expect(noCursor).toBe(true);
		});

		it("rejects invalid cursor with a typed error (no crash)", async () => {
			const { server, handlers } = buildFakeServer();
			const convex = buildMockConvex(buildRows(3));
			registerTools(server, convex);

			const handler = handlers.get(spec.mcpName);
			const result = await handler?.({
				...spec.baseArgs,
				cursor: "garbage-cursor-not-base64-json",
			});
			const text = extractText(result);
			expect(text).toMatch(/invalid cursor/i);
		});

		it(`forwards the convex function name ${spec.convexFn}`, async () => {
			const { server, handlers } = buildFakeServer();
			const convex = buildMockConvex(buildRows(2));
			registerTools(server, convex);

			const handler = handlers.get(spec.mcpName);
			await handler?.({ ...spec.baseArgs });
			const [fn] = (convex.query as ReturnType<typeof vi.fn>).mock.calls[0] as [
				string,
				unknown,
			];
			expect(fn).toBe(spec.convexFn);
		});
	});
}
