/**
 * list_messages and its siblings — a call carrying two filters applies both,
 * and a partial page carries a cursor that continues it.
 *
 * DEFECT (measured on prod at 406c3994): `list_messages from='pi'
 * sessionDay=249 limit=200` returned 12 rows from other senders, oldest first,
 * `truncated: true`, `nextCursor: null`. Two faults: the Convex read dropped
 * `from` when `sessionDay` was present (convex/__tests__/listFiltersCompose.test.ts),
 * and the 60 KB cap cut the page and then threw the continuation away, so the
 * withheld rows were unreachable.
 *
 * Same class, MCP side: `list_issues assignedTo + project` selected the
 * `assignedTo` read and silently discarded `project`; `list_memories` /
 * `list_episodes` never asked Convex for a paginated page on the FIRST call, so
 * a full first page carried no cursor at all.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_STDIO_TRUST_CTX } from "../src/auth.js";
import { decodeCursor } from "../src/paging.js";
import { registerTools } from "../src/tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function buildFakeServer(): {
	server: McpServer;
	handlers: Map<string, ToolHandler>;
} {
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

function mockConvex(queryResult: unknown) {
	const query = vi.fn().mockResolvedValue(queryResult);
	const client = {
		query,
		mutation: vi.fn().mockResolvedValue(null),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
	return { client, query };
}

function structured(result: unknown): {
	items: Array<{ _creationTime: number }>;
	nextCursor: string | null;
	truncated: boolean;
} {
	return (result as { structuredContent: never }).structuredContent;
}

const BASE = 1_780_000_000_000;

function bigRows(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		_id: `m${String(i).padStart(31, "0")}`,
		_creationTime: BASE - i * 1000,
		from: "pi",
		channel: "fixture-channel",
		content: "x".repeat(2_000),
		sessionDay: 249,
		createdAt: BASE - i * 1000,
	}));
}

describe("list_messages", () => {
	it("forwards from and sessionDay together to the read, with the decoded cursor", async () => {
		const { server, handlers } = buildFakeServer();
		const { client, query } = mockConvex([]);
		registerTools(server, client, LOCAL_STDIO_TRUST_CTX);
		await handlers.get("list_messages")?.({
			from: "pi",
			sessionDay: 249,
			limit: 20,
		});
		const args = query.mock.calls[0][1] as Record<string, unknown>;
		expect(args.from).toBe("pi");
		expect(args.sessionDay).toBe(249);
	});

	it("a page the 60 KB cap cut carries a cursor that continues after the last row shown", async () => {
		const { server, handlers } = buildFakeServer();
		const rows = bigRows(200);
		const { client } = mockConvex(rows);
		registerTools(server, client, LOCAL_STDIO_TRUST_CTX);
		const result = await handlers.get("list_messages")?.({
			from: "pi",
			sessionDay: 249,
			limit: 200,
		});
		const page = structured(result);
		expect(page.truncated).toBe(true);
		expect(page.items.length).toBeGreaterThan(0);
		expect(page.items.length).toBeLessThan(200);
		expect(typeof page.nextCursor).toBe("string");
		const decoded = decodeCursor(page.nextCursor as string);
		const lastShown = page.items[page.items.length - 1];
		expect(decoded).toEqual({ createdBefore: lastShown._creationTime });
		// No gap: the next row to fetch is the one right after the last shown.
		const next = rows.find((r) => r._creationTime < lastShown._creationTime);
		expect(next?._creationTime).toBe(rows[page.items.length]._creationTime);
	});
});

describe("list_issues — assignedTo + project", () => {
	it("refuses the combination instead of dropping project", async () => {
		const { server, handlers } = buildFakeServer();
		const { client, query } = mockConvex([]);
		registerTools(server, client, LOCAL_STDIO_TRUST_CTX);
		const result = (await handlers.get("list_issues")?.({
			assignedTo: "sigma",
			project: "fixture-project",
		})) as { isError?: boolean; content: Array<{ text: string }> };
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/assignedTo/);
		expect(result.content[0].text).toMatch(/project/);
		expect(query).not.toHaveBeenCalled();
	});
});

describe("list_memories / list_episodes — a full first page has a cursor", () => {
	for (const tool of ["list_memories", "list_episodes"] as const) {
		it(`${tool} asks for a paginated first page and returns the continuation`, async () => {
			const { server, handlers } = buildFakeServer();
			const { client, query } = mockConvex({
				value: [],
				continueCursor: "backend-cursor-1",
				isDone: false,
			});
			registerTools(server, client, LOCAL_STDIO_TRUST_CTX);
			const result = await handlers.get(tool)?.({
				namespace: "global",
				type: "feedback",
				limit: 5,
			});
			const args = query.mock.calls[0][1] as {
				paginationOpts?: { numItems: number; cursor: string | null };
			};
			expect(args.paginationOpts).toEqual({ numItems: 5, cursor: null });
			expect(typeof structured(result).nextCursor).toBe("string");
		});
	}
});
