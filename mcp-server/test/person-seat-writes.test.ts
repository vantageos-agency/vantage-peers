/**
 * A PERSON seat writes (VantagePeers Cloud, task k177e8dyrnykk3c56yf2b0pgfs8hhz06).
 *
 * Measured on production (claude.ai, person seat, org immobiliere-pujol, a token
 * that designates no agent): whoami answered person-designates-no-agent;
 * create_briefing_note without an author answered PERSON_NO_HUMAN_DOOR, and so did
 * store_memory, although its own description says a signed-in person may omit the
 * author. A person seat read but could not write.
 *
 * Through the REAL /mcp route and the REAL Convex functions (test/lib/seatWorld.ts),
 * a person writes a memory, an episode, a briefing note, a task and a message
 * WITHOUT naming an author or a namespace:
 *   - with a bound personal agent, the write is authored by that agent (by ID);
 *   - with none, it is authored by the verified person ("user:<subject>"), in
 *     the person's own team space, stamped with its own organisation.
 * Deny poles: an agent-less person naming an agent is refused and nothing is
 * written; a namespace of another organisation is refused.
 *
 * whoami, on every seat, returns at top level the agent ID, the agent name and the
 * workspace (default_write_namespace + writableNamespaces); an agent-less seat
 * gets one plain sentence naming the fixing step.
 */

import { appendFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeWorld,
	connectAs,
	FREE,
	freshBackend,
	ORG_ID,
	type Seat,
	SLUG,
	type T,
	type ToolResult,
	tokenFor,
} from "./lib/seatWorld.js";

vi.mock("convex/browser", async () => ({
	ConvexHttpClient: (await import("./lib/forwardingConvex.js"))
		.ForwardingConvexHttpClient,
}));

type World = Awaited<ReturnType<typeof freshBackend>>;
let world: World | null = null;

afterEach(() => {
	if (world !== null) closeWorld(world.harness);
	world = null;
});

async function open(seat: Seat) {
	world = await freshBackend(seat);
	const client = await connectAs(await tokenFor(seat, world));
	const call = async (name: string, args: Record<string, unknown>) =>
		(await client.callTool({ name, arguments: args })) as ToolResult;
	return { world, client, call };
}

const text = (r: ToolResult) => r.content.map((c) => c.text).join(" ");

/** The newest row of a table, read straight from the backend. */
async function newest(t: T, table: string): Promise<Record<string, unknown>> {
	const rows = (await t.run((ctx) =>
		ctx.db
			.query(table as never)
			.order("desc")
			.take(1),
	)) as Record<string, unknown>[];
	return rows[0] as Record<string, unknown>;
}

async function count(t: T, table: string): Promise<number> {
	return (await t.run((ctx) => ctx.db.query(table as never).collect())).length;
}

const WRITES: {
	tool: string;
	table: string;
	args: (w: World) => Record<string, unknown>;
	author: string;
	authorId: string;
}[] = [
	{
		tool: "store_memory",
		table: "memories",
		args: () => ({ type: "project", content: "a person's memory" }),
		author: "createdBy",
		authorId: "createdById",
	},
	{
		tool: "store_episode",
		table: "memories",
		args: () => ({
			context: "c",
			goal: "g",
			action: "a",
			outcome: "o",
			insight: "i",
			severity: "minor",
		}),
		author: "createdBy",
		authorId: "createdById",
	},
	{
		tool: "create_briefing_note",
		table: "briefingNotes",
		args: () => ({
			title: "a person's note",
			topic: "t",
			participants: ["ulysse"],
			content: "note body",
		}),
		author: "createdBy",
		authorId: "createdById",
	},
	{
		tool: "create_task",
		table: "tasks",
		args: () => ({
			title: "a person's task",
			project: "seat-matrix",
			assignedTo: "ulysse",
			priority: "medium",
		}),
		author: "createdBy",
		authorId: "createdById",
	},
	{
		tool: "send_message",
		table: "messages",
		args: (w) => ({
			recipientAgentIds: [w.fixtures.strings.seatAgentId],
			content: "hello from a person",
		}),
		author: "from",
		authorId: "fromId",
	},
];

describe("an agent-less person writes in its own name, with no author and no namespace", () => {
	for (const write of WRITES) {
		it(`${write.tool}: served, authored by user:<subject>, stamped with its own org`, async () => {
			const { world: w, call } = await open("person-agentless");
			const r = await call(write.tool, write.args(w));
			expect(r.isError, text(r)).toBeFalsy();
			const row = await newest(w.t, write.table);
			expect(row[write.author]).toBe(`user:${FREE}`);
			expect(row[write.authorId]).toBe(`user:${FREE}`);
			if (write.table === "memories") {
				expect(row.namespace).toBe(`team/${SLUG}`);
				expect(row.clerkOrgId).toBe(ORG_ID);
			}
			if (write.table === "tasks" || write.table === "briefingNotes") {
				expect(row.orgId).toBe(SLUG);
				expect(row.clerkOrgId).toBe(ORG_ID);
			}
		});
	}
});

describe("a person with a bound personal agent writes as that agent, with no author", () => {
	for (const write of WRITES) {
		it(`${write.tool}: served, authored by ulysse by ID`, async () => {
			const { world: w, call } = await open("person-bound");
			const r = await call(write.tool, write.args(w));
			expect(r.isError, text(r)).toBeFalsy();
			const row = await newest(w.t, write.table);
			expect(row[write.author]).toBe("ulysse");
			expect(row[write.authorId]).toBe(w.ids.toBackend(w.ulysse));
		});
	}
});

describe("deny poles: a person never widens", () => {
	it("an agent-less person naming an agent as the author is refused and nothing is written", async () => {
		const { world: w, call } = await open("person-agentless");
		for (const [tool, args] of [
			["store_memory", { type: "project", content: "x", createdBy: "ulysse" }],
			[
				"create_briefing_note",
				{
					title: "x",
					topic: "t",
					participants: ["ulysse"],
					content: "x",
					createdBy: "ulysse",
				},
			],
		] as const) {
			const before = await count(
				w.t,
				tool === "store_memory" ? "memories" : "briefingNotes",
			);
			const r = await call(tool, args as Record<string, unknown>);
			expect(r.isError).toBe(true);
			expect(text(r)).toContain("AGENT_CREDENTIAL_REQUIRED");
			expect(
				await count(
					w.t,
					tool === "store_memory" ? "memories" : "briefingNotes",
				),
			).toBe(before);
		}
	});

	it("an agent-less person writing to another organisation's namespace is refused", async () => {
		const { world: w, call } = await open("person-agentless");
		const before = await count(w.t, "memories");
		const r = await call("store_memory", {
			type: "project",
			content: "x",
			namespace: "team/another-org",
		});
		expect(r.isError).toBe(true);
		expect(await count(w.t, "memories")).toBe(before);
	});
});

describe("whoami names the agent and the workspace on every seat", () => {
	const expected: Record<
		Seat,
		{ agentName: string | null; ns: (w: World) => string }
	> = {
		"person-bound": { agentName: "ulysse", ns: () => `team/${SLUG}` },
		"person-agentless": { agentName: null, ns: () => `team/${SLUG}` },
		"agent-seat": {
			agentName: "seatbot",
			ns: (w) => `orchestrator/${w.fixtures.strings.seatAgentId}`,
		},
	};
	for (const seat of Object.keys(expected) as Seat[]) {
		it(`${seat}: agent_id, agent_name, default_write_namespace, writableNamespaces at top level`, async () => {
			const { world: w, call } = await open(seat);
			const r = await call("whoami", {});
			expect(r.isError, text(r)).toBeFalsy();
			const who = JSON.parse(r.content[0]?.text ?? "{}") as Record<
				string,
				unknown
			>;
			if (process.env.CLIENT_SEAT_WHOAMI_OUT) {
				// The whoami each seat sees, kept for the report (scripts read the file).
				appendFileSync(
					process.env.CLIENT_SEAT_WHOAMI_OUT,
					`${JSON.stringify({ seat, whoami: who })}\n`,
				);
			}
			const want = expected[seat];
			expect(who.agent_name).toBe(want.agentName);
			expect(who.default_write_namespace).toBe(want.ns(w));
			expect(who.writableNamespaces).toContain(want.ns(w));
			expect("agent_id" in who).toBe(true);
			if (want.agentName === null) {
				expect(who.agent_id).toBeNull();
				expect(String(who.agent_status)).toMatch(/no agent is bound/i);
				expect(String(who.agent_status)).toMatch(/consent page/i);
			} else {
				expect(typeof who.agent_id).toBe("string");
				expect(who.agent_status).toBeNull();
			}
		});
	}
});
