/**
 * The byte cap bounds the WHOLE tool result, not the text alone (VantagePeers
 * Cloud, task k17592gg5t2tencwxks3kysghx8htqg8, Eta REVISE on #1714).
 *
 * A paged list now carries its rows twice: in the text and in
 * structuredContent. A cap measured on the text alone let the serialized
 * result reach about twice MAX_LIST_RESPONSE_BYTES (Eta: 100 task rows, text
 * 58 930 B, result 115 336 B), past the ~75 KB a client accepts. Here every
 * byte-capped tool (the 12 paged lists) is called through a real McpServer on
 * a full page of large rows, and the serialized CallToolResult must fit in
 * MAX_LIST_RESPONSE_BYTES, with the page cut (truncated: true, fewer rows,
 * nextCursor null) and the text and structuredContent showing the same rows.
 *
 * The rows each Convex door answers are shaped as its `returns:` validator
 * says, so the SDK's outputSchema validation passes on them.
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../auth.js";
import { MAX_LIST_RESPONSE_BYTES, registerTools } from "../tools.js";

const ROWS = 100;
const BIG = "x".repeat(1_500);
const id = (i: number) => `k${String(i).padStart(31, "0")}`;
const many = <T>(row: (i: number) => T): T[] =>
	Array.from({ length: ROWS }, (_, i) => row(i));
const base = (i: number) => ({ _id: id(i), _creationTime: 1_000 + i });

// What each Convex door answers: a FULL page (as many rows as the limit asked
// for), so the paged tools also announce a further page.
const DOORS: Record<string, unknown> = {
	"memories:listMemories": {
		value: many((i) => ({
			...base(i),
			namespace: "global",
			type: "reference",
			content: BIG,
			createdBy: "sigma",
			relations: [],
			isLatest: true,
			createdAt: 1,
			updatedAt: 1,
		})),
		continueCursor: "next",
		isDone: false,
	},
	"profiles:listProfiles": many((i) => ({
		...base(i),
		orchestratorId: `o${i}`,
		name: `o${i}`,
		static: { role: BIG, workspace: "/w", capabilities: [] },
		dynamic: { currentTask: "t", lastSeen: 1, sessionCount: 1 },
	})),
	"messages:listMessages": many((i) => ({
		...base(i),
		from: "pi",
		channel: "sigma",
		content: BIG,
		createdAt: 1,
	})),
	"tasks:list": many((i) => ({
		...base(i),
		title: BIG,
		status: "todo",
		priority: "low",
		assignedTo: "sigma",
		createdBy: "pi",
	})),
	"tasks:listByMission": many((i) => ({
		...base(i),
		title: BIG,
		status: "todo",
		priority: "low",
		assignedTo: "sigma",
		createdBy: "pi",
	})),
	"missions:list": many((i) => ({
		...base(i),
		name: BIG,
		status: "plan",
		pilot: "sigma",
		priority: "low",
		project: "p",
	})),
	"diary:list": many((i) => ({
		...base(i),
		date: "2026-01-01",
		orchestrator: "sigma",
		content: BIG,
		createdAt: 1,
	})),
	"briefingNotes:list": many((i) => ({
		...base(i),
		title: "t",
		topic: "x",
		participants: ["sigma"],
		createdBy: "sigma",
		content: BIG,
		createdAt: 1,
	})),
	"recurringTasks:list": many((i) => ({
		...base(i),
		title: BIG,
		assignedTo: "sigma",
		priority: "low",
		cronExpression: "0 9 * * 1",
		nextRunAt: 1,
		active: true,
		createdBy: "sigma",
	})),
	"githubRepoMapping:list": {
		items: many((i) => ({
			...base(i),
			repo: `owner/${BIG}${i}`,
			orchestrator: "sigma",
			project: "p",
		})),
		nextCursor: "next",
	},
	"fixPatterns:listAll": many((i) => ({
		...base(i),
		symptom: BIG,
		rootCause: "r",
		tags: [],
		stack: [],
		sourceProject: "p",
		createdBy: "sigma",
		severity: "minor",
		createdAt: 1,
		updatedAt: 1,
	})),
};

// tool -> the arguments of a full page (limit = ROWS)
const CAPPED: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
	["list_episodes", { namespace: "global", limit: ROWS }],
	["list_memories", { namespace: "global", limit: ROWS }],
	["list_peers", { limit: ROWS }],
	["list_messages", { limit: ROWS }],
	["list_tasks", { limit: ROWS }],
	["list_tasks_by_mission", { missionId: id(0), limit: ROWS }],
	["list_missions", { limit: ROWS }],
	["list_diaries", { limit: ROWS }],
	["list_briefing_notes", { limit: ROWS }],
	["list_recurring_tasks", { limit: ROWS }],
	["list_repo_mappings", { limit: ROWS }],
	["list_fix_patterns", { limit: ROWS }],
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

async function call(tool: string, args: Record<string, unknown>) {
	const convex = {
		query: async (name: string) => DOORS[name] ?? null,
		mutation: async () => null,
		action: async () => null,
	} as unknown as Parameters<typeof registerTools>[1];
	const server = new McpServer({ name: "t", version: "0.0.0" });
	registerTools(server, convex, masterCtx());
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "0.0.0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	const result = await client.callTool({ name: tool, arguments: args });
	await client.close();
	return result as {
		isError?: boolean;
		content: Array<{ type: string; text: string }>;
		structuredContent?: {
			items: unknown[];
			nextCursor: string | null;
			truncated: boolean;
		};
	};
}

describe("the byte cap bounds the whole serialized result of every capped list", () => {
	it("covers the 12 paged lists", () => {
		expect(CAPPED).toHaveLength(12);
	});

	for (const [tool, args] of CAPPED) {
		it(`${tool}: a page of ${ROWS} large rows fits in MAX_LIST_RESPONSE_BYTES, cut`, async () => {
			const r = await call(tool, args);
			expect(r.isError, r.content?.[0]?.text).not.toBe(true);
			const bytes = Buffer.byteLength(JSON.stringify(r), "utf8");
			expect(bytes).toBeLessThanOrEqual(MAX_LIST_RESPONSE_BYTES);
			const sc = r.structuredContent;
			expect(sc?.truncated).toBe(true);
			// list_messages is the one capped list whose cut page keeps a cursor
			// (the rows after the last one shown); every other tool still has none.
			if (tool === "list_messages") {
				expect(typeof sc?.nextCursor).toBe("string");
			} else {
				expect(sc?.nextCursor).toBeNull();
			}
			expect(sc?.items.length).toBeGreaterThan(0);
			expect(sc?.items.length).toBeLessThan(ROWS);
			const text = JSON.parse(r.content[0].text) as {
				_meta: { _truncated: boolean; _showing: number };
				items: unknown[];
			};
			expect(text._meta._truncated).toBe(true);
			expect(text.items).toEqual(sc?.items);
		});
	}
});
