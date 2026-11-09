/**
 * The bare-array tools (the searches and tool usage) bound their WHOLE
 * serialized result, and say so when they cut (VantagePeers Cloud, task
 * k17592gg5t2tencwxks3kysghx8htqg8, after the Eta REVISE on #1714).
 *
 * Their text is a bare JSON array and their structuredContent { items } carries
 * the same rows again, with no cap at all before. Over MAX_LIST_RESPONSE_BYTES
 * the cut is declared in both channels: the text becomes the { _meta, items }
 * envelope the paged lists use when cut, structuredContent { items,
 * truncated: true } with the same rows. Never a silently shorter bare array.
 *
 * Also measured here: a single-row read (get_memory) of a memory at the write
 * limit (MAX_CONTENT_BYTES). Single rows are not cut; its size is reported.
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../auth.js";
import {
	MAX_CONTENT_BYTES,
	MAX_LIST_RESPONSE_BYTES,
	registerTools,
} from "../tools.js";

const ROWS = 100;
const BIG = "x".repeat(1_500);
const id = (i: number) => `k${String(i).padStart(31, "0")}`;
const many = <T>(n: number, row: (i: number) => T): T[] =>
	Array.from({ length: n }, (_, i) => row(i));

const semantic = many(ROWS, (i) => ({
	memoryId: id(i),
	score: 0.9,
	namespace: "global",
	type: "reference",
	content: BIG,
}));
const keyword = semantic.map(({ score: _s, ...r }) => r);
const hybrid = semantic.map(({ score, ...r }) => ({ ...r, rrfScore: score }));
const usage = many(1_000, (i) => ({
	tool: `tool_${i}`,
	firstAt: 1,
	lastAt: 2,
	count: i,
}));

const DOORS: Record<string, unknown> = {
	"search:recall": semantic,
	"search:textSearch": keyword,
	"search:hybridSearch": hybrid,
	"messages:searchMessagesByKeyword": many(ROWS, (i) => ({
		_id: id(i),
		from: "pi",
		channel: "sigma",
		content: BIG,
		createdAt: 1,
	})),
	"tasks:searchTasksByKeyword": many(ROWS, (i) => ({
		_id: id(i),
		_creationTime: 1,
		title: BIG,
		status: "todo",
		priority: "low",
		assignedTo: "sigma",
		createdBy: "pi",
	})),
	"briefingNotes:searchBriefingNotesByKeyword": many(ROWS, (i) => ({
		_id: id(i),
		title: "t",
		topic: "x",
		participants: ["sigma"],
		createdBy: "sigma",
		createdAt: 1,
		content: BIG,
	})),
	"search:searchFixPatterns": many(ROWS, (i) => ({
		patternId: id(i),
		score: 0.9,
		symptom: BIG,
		rootCause: "r",
		tags: [],
		stack: [],
		sourceProject: "p",
		severity: "minor",
		createdBy: "sigma",
	})),
	"toolUsage:getToolUsage": usage,
	"toolUsage:usageByOwner": usage,
	"memories:getMemory": {
		_id: id(0),
		_creationTime: 1,
		namespace: "global",
		type: "reference",
		// The largest content store_memory accepts.
		content: "x".repeat(MAX_CONTENT_BYTES),
		createdBy: "sigma",
		relations: [],
		isLatest: true,
		createdAt: 1,
		updatedAt: 1,
	},
};

const BARE: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
	["recall", { query: "q", limit: 200 }],
	["text_search", { query: "q", limit: 200 }],
	["hybrid_search", { query: "q", limit: 200 }],
	["search_episodes_by_keyword", { query: "q", limit: 200 }],
	["search_episodes_by_semantic", { query: "q", limit: 200 }],
	["search_messages_by_keyword", { query: "q", limit: 200 }],
	["search_tasks_by_keyword", { query: "q", limit: 200, fields: "full" }],
	["search_briefing_notes_by_keyword", { query: "q", limit: 200 }],
	["search_fix_patterns", { query: "q", limit: 200 }],
	["get_tool_usage", {}],
	["get_owner_tool_usage", { ownerUserId: "user_x" }],
];

function masterCtx(): OAuthContext {
	return {
		clientId: "m",
		userId: "m",
		scopes: [],
		scopeProfile: "master",
		fromAllowList: ["*"],
		namespaceReadPrefixes: ["*"],
		namespaceWritePrefixes: ["*"],
		expiresAt: Date.now() + 3600_000,
		isMaster: true,
	} as OAuthContext;
}

type Result = {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
	structuredContent?: Record<string, unknown>;
};

async function call(tool: string, args: Record<string, unknown>) {
	const answer = async (name: string) => DOORS[name] ?? null;
	const convex = {
		query: answer,
		mutation: async () => null,
		action: answer,
	} as unknown as Parameters<typeof registerTools>[1];
	const server = new McpServer({ name: "t", version: "0.0.0" });
	registerTools(server, convex, masterCtx());
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "0.0.0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	const r = await client.callTool({ name: tool, arguments: args });
	await client.close();
	return r as Result;
}

describe("the bare-array tools bound their whole result, and declare the cut", () => {
	it("covers the 11 bare-array tools", () => {
		expect(BARE).toHaveLength(11);
	});

	for (const [tool, args] of BARE) {
		it(`${tool}: an answer over the cap fits, cut, the cut said in the text and in structuredContent`, async () => {
			const r = await call(tool, args);
			expect(r.isError, r.content?.[0]?.text).not.toBe(true);
			const bytes = Buffer.byteLength(JSON.stringify(r), "utf8");
			expect(bytes).toBeLessThanOrEqual(MAX_LIST_RESPONSE_BYTES);
			const sc = r.structuredContent as {
				items: unknown[];
				truncated?: boolean;
			};
			expect(sc.truncated).toBe(true);
			expect(sc.items.length).toBeGreaterThan(0);
			const text = JSON.parse(r.content[0].text) as {
				_meta?: { _truncated: boolean; _showing: number; _total: number };
				items: unknown[];
			};
			// Never a silently shorter bare array.
			expect(Array.isArray(text)).toBe(false);
			expect(text._meta?._truncated).toBe(true);
			expect(text._meta?._showing).toBe(sc.items.length);
			expect(text._meta?._showing).toBeLessThan(text._meta?._total ?? 0);
			expect(text.items).toEqual(sc.items);
		});
	}
});

describe("a single-row read is not cut: its size at the write limit, measured", () => {
	it("get_memory of a memory at MAX_CONTENT_BYTES answers the whole row twice (text and structuredContent)", async () => {
		const r = await call("get_memory", { memoryId: id(0) });
		expect(r.isError, r.content?.[0]?.text).not.toBe(true);
		const bytes = Buffer.byteLength(JSON.stringify(r), "utf8");
		// Not cut: the row is whole in both channels. Over the ~75 KB client
		// ceiling by construction (two copies of 900 000 bytes), reported, not
		// fixed here: a single row has no smaller page to fall back to.
		expect((r.structuredContent as { content: string }).content).toHaveLength(
			MAX_CONTENT_BYTES,
		);
		expect(bytes).toBeGreaterThan(2 * MAX_CONTENT_BYTES);
		expect(bytes).toBeLessThan(2 * MAX_CONTENT_BYTES + 2_000);
	});
});
