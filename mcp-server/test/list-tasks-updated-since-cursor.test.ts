/**
 * list_tasks + updatedSince: the opaque cursor carries the updatedAt position.
 *
 * An updatedSince window is read in index order (updatedAt desc, _creationTime
 * desc), so the resume position is the PAIR of the last row served. The MCP
 * encodes it into the same opaque token as a plain createdBefore cursor
 * ({ v: 2, createdBefore, updatedAt }) and forwards it to tasks:list as
 * `updatedCursor`. A token minted before the position existed still decodes to
 * createdBefore alone.
 *
 * The Convex side of the contract is pinned in
 * convex/__tests__/tasks-list-date-index.test.ts (real index ranges, 2500-row
 * window). Here a stand-in backend applies the same position rule to prove the
 * MCP round trip: encode -> decode -> Convex -> encode, window complete.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_STDIO_TRUST_CTX } from "../src/auth.js";
import { decodeCursor, encodeCursor } from "../src/paging.js";
import { registerTools } from "../src/tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function buildFakeServer(): { server: McpServer; handlers: Map<string, ToolHandler> } {
	const handlers = new Map<string, ToolHandler>();
	const fakeServer = {
		tool(...args: unknown[]): unknown {
			handlers.set(args[0] as string, args[args.length - 1] as ToolHandler);
			return {};
		},
		registerTool(...args: unknown[]): unknown {
			handlers.set(args[0] as string, args[args.length - 1] as ToolHandler);
			return {};
		},
	} as unknown as McpServer;
	return { server: fakeServer, handlers };
}

type Row = { _id: string; _creationTime: number; updatedAt: number; title: string; status: string };

// 2500 rows; updatedAt tied in runs of 50 so every page boundary lands inside or at a tie.
const WINDOW = 2500;
const ROWS: Row[] = Array.from({ length: WINDOW }, (_, i) => ({
	_id: `id${i}`,
	_creationTime: 1_780_000_000_000 + i * 7,
	updatedAt: 1_000_000 + Math.floor(i / 50) * 1000,
	title: `t${i}`,
	status: "done",
}));

type QueryArgs = {
	updatedSince?: number;
	createdBefore?: number;
	updatedCursor?: number;
	limit: number;
};

/** The position rule tasks:list applies: strictly after (updatedCursor, createdBefore) in (updatedAt, _creationTime) desc. */
function backend(args: QueryArgs): Row[] {
	const since = args.updatedSince ?? 0;
	return ROWS.filter((r) => r.updatedAt >= since)
		.filter((r) => {
			if (args.updatedCursor === undefined || args.createdBefore === undefined) return true;
			return (
				r.updatedAt < args.updatedCursor ||
				(r.updatedAt === args.updatedCursor && r._creationTime < args.createdBefore)
			);
		})
		.sort((a, b) => b.updatedAt - a.updatedAt || b._creationTime - a._creationTime)
		.slice(0, args.limit);
}

function setup() {
	const { server, handlers } = buildFakeServer();
	const query = vi.fn().mockImplementation(async (_fn: string, args: QueryArgs) => backend(args));
	const convex = {
		query,
		mutation: vi.fn().mockResolvedValue(null),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
	registerTools(server, convex, LOCAL_STDIO_TRUST_CTX);
	const handler = handlers.get("list_tasks") as ToolHandler;
	return { handler, query };
}

function parse(result: unknown): { items: Array<{ _id: string }>; nextCursor?: string | null } {
	const text = (result as { content: Array<{ text: string }> }).content[0].text;
	const parsed = JSON.parse(text.split("\n<!--")[0]) as unknown;
	return Array.isArray(parsed)
		? { items: parsed as Array<{ _id: string }> }
		: (parsed as { items: Array<{ _id: string }>; nextCursor?: string | null });
}

describe("list_tasks updatedSince cursor", () => {
	it("a 2500-row window comes back complete across pages through the opaque cursor (no duplicate, no gap)", async () => {
		const { handler, query } = setup();
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 100; page++) {
			const out = parse(await handler({ updatedSince: 1, limit: 200, ...(cursor ? { cursor } : {}) }));
			seen.push(...out.items.map((r) => r._id));
			if (!out.nextCursor) break;
			cursor = out.nextCursor;
		}
		expect(seen).toHaveLength(WINDOW);
		expect(new Set(seen).size).toBe(WINDOW);
		// every continuation call carried the position half Convex needs
		const resumed = query.mock.calls.slice(1).map((c) => c[1] as QueryArgs);
		expect(resumed.length).toBeGreaterThan(0);
		for (const a of resumed) {
			expect(typeof a.updatedCursor).toBe("number");
			expect(typeof a.createdBefore).toBe("number");
		}
	});

	it("the token is versioned and carries the last row's pair; an old token decodes to createdBefore alone", () => {
		const t = encodeCursor({ v: 2, createdBefore: 5, updatedAt: 9 });
		expect(decodeCursor(t)).toEqual({ createdBefore: 5, v: 2, updatedAt: 9 });
		const old = Buffer.from(JSON.stringify({ createdBefore: 5 }), "utf8").toString("base64url");
		expect(decodeCursor(old)).toEqual({ createdBefore: 5 });
	});

	it("an old createdBefore-only cursor is forwarded as createdBefore with NO updatedCursor", async () => {
		const { handler, query } = setup();
		await handler({ updatedSince: 1, limit: 20, cursor: encodeCursor({ createdBefore: 1_780_000_005_000 }) });
		const args = query.mock.calls[0][1] as QueryArgs;
		expect(args.createdBefore).toBe(1_780_000_005_000);
		expect(args.updatedCursor).toBeUndefined();
	});

	it("without updatedSince the cursor stays a plain createdBefore (no updatedAt halves leak)", async () => {
		const { handler, query } = setup();
		const out = parse(await handler({ limit: 20 }));
		expect(out.nextCursor).toBeTruthy();
		expect(decodeCursor(out.nextCursor as string)).toEqual({ createdBefore: expect.any(Number) });
		await handler({ limit: 20, cursor: encodeCursor({ v: 2, createdBefore: 5, updatedAt: 9 }) });
		const args = query.mock.calls[1][1] as QueryArgs;
		expect(args.updatedCursor).toBeUndefined();
	});
});
