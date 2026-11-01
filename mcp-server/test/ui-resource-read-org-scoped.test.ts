/**
 * resources/read of ui://vp/v1/<primitive> is PARTITIONED BY ORGANISATION,
 * exactly as the text tools are. VantagePeers Cloud (HTTP /mcp entry).
 * Task k17apssqnw2xcf72r27c83338s8hc180.
 *
 * Before: the read was fail-closed (PR #1636): a non-master OAuth bearer was
 * refused outright, because each primitive called its Convex door through the
 * fleet SERVICE-ACCOUNT client with no scope argument, which Convex serves
 * fleet-wide.
 *
 * Now: an OAuth bearer whose organisation resolved (verifiedOrgSlugOf) is
 * served, and every primitive builds its door arguments with THE resolver the
 * tools use (doorScope.ts) and applies the same MCP-side gate as its tool:
 *
 *   tasks-table      tasks:list            verifiedOrg + actor-tenant + roster filter (list_tasks)
 *   messages-feed    messages:listMessages verifiedOrg + roster filter on `from` (list_messages)
 *   memory-quote     memories:listMemories namespace read gate + roster filter (list_memories)
 *   mission-timeline missions:list         verifiedOrg + pilot = own userId (list_missions)
 *   diary-entry      diary:get / diary:list orchestrator|createdBy = own userId, row filter (get_diary / list_diaries)
 *   briefing-note    briefingNotes:get/list verifiedOrg + roster|participant filter (get/list_briefing_note)
 *
 * The backend here is a FAKE two-organisation Convex: a door that is handed
 * `verifiedOrg` serves only that org's rows; a door handed nothing serves
 * every org's rows, which is what the service account really receives. So a
 * primitive that forgets its scope shows org-b's rows, and these tests fail.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { DOOR_SCOPE } from "../src/doorScope.js";
import {
	registerUiResources,
	type UiResourceConvexClient,
} from "../src/ui-resources/register.js";

const ORG_A = "org-a";
const ORG_B = "org-b";

type Row = Record<string, unknown> & { org: string; marker: string };

// Every row carries a marker naming its org, so the rendered HTML says which
// organisation's data reached the caller.
const ROWS: Record<string, Row[]> = {
	tasks: [
		{
			org: ORG_A,
			marker: "A-TASK",
			_id: "t1",
			title: "A-TASK",
			status: "todo",
			assignedTo: "alice",
			createdBy: "alice",
			orgId: ORG_A,
		},
		{
			org: ORG_B,
			marker: "B-TASK",
			_id: "t2",
			title: "B-TASK",
			status: "todo",
			assignedTo: "mallory",
			createdBy: "mallory",
			orgId: ORG_B,
		},
	],
	messages: [
		{
			org: ORG_A,
			marker: "A-MSG",
			_id: "m1",
			from: "alice",
			channel: "broadcast",
			content: "A-MSG",
			createdAt: 1,
		},
		{
			org: ORG_B,
			marker: "B-MSG",
			_id: "m2",
			from: "mallory",
			channel: "broadcast",
			content: "B-MSG",
			createdAt: 2,
		},
	],
	memories: [
		{
			org: ORG_A,
			marker: "A-MEM",
			_id: "y1",
			namespace: "team/org-a",
			type: "fact",
			content: "A-MEM",
			createdBy: "alice",
		},
		{
			org: ORG_B,
			marker: "B-MEM",
			_id: "y2",
			namespace: "team/org-b",
			type: "fact",
			content: "B-MEM",
			createdBy: "mallory",
		},
	],
	missions: [
		{
			org: ORG_A,
			marker: "A-MISSION",
			_id: "s1",
			name: "A-MISSION",
			status: "execute",
			pilot: "alice",
		},
		{
			org: ORG_B,
			marker: "B-MISSION",
			_id: "s2",
			name: "B-MISSION",
			status: "execute",
			pilot: "mallory",
		},
		// org-b's own "alice": a same-named pilot of ANOTHER org (only the org
		// scope tells the two apart).
		{
			org: ORG_B,
			marker: "B-ALICE-MISSION",
			_id: "s3",
			name: "B-ALICE-MISSION",
			status: "execute",
			pilot: "alice",
		},
	],
	diary: [
		{
			org: ORG_A,
			marker: "A-DIARY",
			_id: "d1",
			date: "2026-11-01",
			orchestrator: "alice",
			createdBy: "alice",
			content: "A-DIARY",
		},
		{
			org: ORG_B,
			marker: "B-DIARY",
			_id: "d2",
			date: "2026-11-01",
			orchestrator: "mallory",
			createdBy: "mallory",
			content: "B-DIARY",
		},
	],
	briefingNotes: [
		{
			org: ORG_A,
			marker: "A-NOTE",
			_id: "n1",
			topic: "t",
			title: "A-NOTE",
			createdBy: "alice",
			participants: ["alice"],
		},
		{
			org: ORG_B,
			marker: "B-NOTE",
			_id: "n2",
			topic: "t",
			title: "B-NOTE",
			createdBy: "mallory",
			participants: ["mallory"],
		},
	],
};

type Call = { fn: string; args: Record<string, unknown> };

/** The fake service-account backend: `verifiedOrg` scopes, its absence does not. */
function fakeConvex(calls: Call[]): UiResourceConvexClient {
	const query = async (fn: unknown, rawArgs: unknown) => {
		const name = String(fn);
		const args = (rawArgs ?? {}) as Record<string, unknown>;
		calls.push({ fn: name, args });
		const org = (args.verifiedOrg as { orgSlug?: string } | undefined)?.orgSlug;
		const inOrg = (rows: Row[]) =>
			org === undefined ? rows : rows.filter((r) => r.org === org);
		switch (name) {
			case "tasks:list":
				return inOrg(ROWS.tasks);
			case "messages:listMessages":
				return inOrg(ROWS.messages);
			case "memories:listMemories":
				return {
					value: ROWS.memories.filter((r) => r.namespace === args.namespace),
					isDone: true,
					continueCursor: null,
				};
			case "missions:list":
				return inOrg(ROWS.missions).filter(
					(r) => args.pilot === undefined || r.pilot === args.pilot,
				);
			case "diary:list":
				return ROWS.diary.filter(
					(r) =>
						(args.orchestrator === undefined ||
							r.orchestrator === args.orchestrator) &&
						(args.createdBy === undefined || r.createdBy === args.createdBy),
				);
			case "diary:get":
				return (
					ROWS.diary.find(
						(r) => r.date === args.date && r.orchestrator === args.orchestrator,
					) ?? null
				);
			case "briefingNotes:list":
				return inOrg(ROWS.briefingNotes);
			case "briefingNotes:get":
				return (
					inOrg(ROWS.briefingNotes).find((r) => r._id === args.noteId) ?? null
				);
			default:
				throw new Error(`fake backend: no door ${name}`);
		}
	};
	return { query } as unknown as UiResourceConvexClient;
}

function baseCtx(over: Partial<OAuthContext>): OAuthContext {
	return {
		clientId: "client-a",
		userId: "alice",
		scopes: ["vantage:read"],
		scopeProfile: "team-member",
		fromAllowList: ["alice"],
		namespaceReadPrefixes: ["team/org-a"],
		namespaceWritePrefixes: ["team/org-a"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
		...over,
	};
}

/** An org-a member: an OAuth bearer whose access-token row resolved org-a. */
const MEMBER_A = baseCtx({
	accessTokenHash: "a".repeat(64),
	clerkOrgSlug: ORG_A,
});
/** An OAuth bearer whose organisation resolves to nothing. */
const UNRESOLVED = baseCtx({ accessTokenHash: "b".repeat(64) });
/** Clerk-JWT caller: its own token reaches Convex, which scopes it there. */
const CLERK_JWT = baseCtx({ clerkJwt: "eyJ.raw.clerk", clerkOrgSlug: ORG_A });
/** Master bearer. */
const MASTER = baseCtx({
	clientId: "master",
	userId: "master",
	scopeProfile: "master",
	scopes: ["vantage:read", "vantage:write"],
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	isMaster: true,
	viaMasterBearer: true,
});

async function readAs(oauthCtx: OAuthContext | undefined, uri: string) {
	const calls: Call[] = [];
	const server = new McpServer({ name: "t", version: "0.0.0" });
	registerUiResources(server, fakeConvex(calls), oauthCtx);
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "0.0.0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	try {
		const res = await client.readResource({ uri });
		const first = res.contents[0] as { text?: string };
		return { calls, html: first.text ?? "", err: undefined as unknown };
	} catch (err: unknown) {
		return { calls, html: "", err };
	} finally {
		await client.close();
	}
}

type Case = {
	primitive: string;
	/** A read the org-a member is entitled to. */
	ownUri: string;
	/** The org-a markers that read must show. */
	own: string[];
	/** The org-b markers it must never show. */
	foreign: string[];
	/** The door the read reaches, and whether verifiedOrg rides it. */
	door: string;
	carriesVerifiedOrg: boolean;
	/** A read naming another org's data, stopped by the tool's MCP-side gate. */
	gatedUri?: string;
	/**
	 * How that gate stops it: refused before any Convex query (default), or the
	 * row withheld after the read (get_diary's scopeFilterGet, no pre-gate).
	 */
	gatedBy?: "refusal" | "row-filter";
};

const CASES: Case[] = [
	{
		primitive: "tasks-table",
		ownUri: "ui://vp/v1/tasks-table",
		own: ["A-TASK"],
		foreign: ["B-TASK"],
		door: "tasks:list",
		carriesVerifiedOrg: true,
	},
	{
		primitive: "messages-feed",
		ownUri: "ui://vp/v1/messages-feed",
		own: ["A-MSG"],
		foreign: ["B-MSG"],
		door: "messages:listMessages",
		carriesVerifiedOrg: true,
	},
	{
		primitive: "memory-quote",
		ownUri: "ui://vp/v1/memory-quote?namespace=team%2Forg-a",
		own: ["A-MEM"],
		foreign: ["B-MEM"],
		door: "memories:listMemories",
		carriesVerifiedOrg: false,
		gatedUri: "ui://vp/v1/memory-quote?namespace=team%2Forg-b",
	},
	{
		primitive: "mission-timeline",
		ownUri: "ui://vp/v1/mission-timeline?pilot=alice",
		own: ["A-MISSION"],
		foreign: ["B-MISSION", "B-ALICE-MISSION"],
		door: "missions:list",
		carriesVerifiedOrg: true,
		gatedUri: "ui://vp/v1/mission-timeline?pilot=mallory",
	},
	{
		primitive: "diary-entry (list)",
		ownUri: "ui://vp/v1/diary-entry?orchestrator=alice",
		own: ["A-DIARY"],
		foreign: ["B-DIARY"],
		door: "diary:list",
		carriesVerifiedOrg: false,
		gatedUri: "ui://vp/v1/diary-entry?orchestrator=mallory",
	},
	{
		primitive: "diary-entry (get)",
		ownUri: "ui://vp/v1/diary-entry?date=2026-11-01&orchestrator=alice",
		own: ["A-DIARY"],
		foreign: ["B-DIARY"],
		door: "diary:get",
		carriesVerifiedOrg: false,
		gatedUri: "ui://vp/v1/diary-entry?date=2026-11-01&orchestrator=mallory",
		gatedBy: "row-filter",
	},
	{
		primitive: "briefing-note (list)",
		ownUri: "ui://vp/v1/briefing-note",
		own: ["A-NOTE"],
		foreign: ["B-NOTE"],
		door: "briefingNotes:list",
		carriesVerifiedOrg: true,
	},
	{
		primitive: "briefing-note (get)",
		ownUri: "ui://vp/v1/briefing-note?noteId=n1",
		own: ["A-NOTE"],
		foreign: ["B-NOTE"],
		door: "briefingNotes:get",
		carriesVerifiedOrg: true,
	},
];

function expectRefused(err: unknown): void {
	expect(err).toBeInstanceOf(Error);
	const e = err as Error & { data?: unknown };
	expect(e.message).toContain("RBAC_DENIED");
	expect(e.data).toMatchObject({ code: "RBAC_DENIED" });
}

describe("ui://vp/v1/* resources/read is partitioned by organisation", () => {
	for (const c of CASES) {
		describe(c.primitive, () => {
			it("org-a member is served org-a rows only, never an org-b row", async () => {
				const { html, err, calls } = await readAs(MEMBER_A, c.ownUri);
				expect(err).toBeUndefined();
				for (const own of c.own) expect(html).toContain(own);
				for (const foreign of c.foreign) expect(html).not.toContain(foreign);
				const call = calls.find((k) => k.fn === c.door);
				expect(call, `the read reaches ${c.door}`).toBeDefined();
				if (c.carriesVerifiedOrg) {
					expect(call?.args.verifiedOrg).toEqual({ orgSlug: ORG_A });
				} else {
					expect(call?.args).not.toHaveProperty("verifiedOrg");
				}
			});

			if (c.gatedUri !== undefined && c.gatedBy === "row-filter") {
				const gatedUri = c.gatedUri;
				it("org-a member naming org-b's data has the row WITHHELD by the tool's row filter", async () => {
					const { err, html } = await readAs(MEMBER_A, gatedUri);
					expect(err).toBeUndefined();
					for (const foreign of c.foreign) expect(html).not.toContain(foreign);
				});
			} else if (c.gatedUri !== undefined) {
				const gatedUri = c.gatedUri;
				it("org-a member naming org-b's data is REFUSED by the tool's gate, before any Convex query", async () => {
					const { err, calls } = await readAs(MEMBER_A, gatedUri);
					expectRefused(err);
					expect(calls).toEqual([]);
				});
			}

			it("a caller whose organisation resolves to nothing is still REFUSED, no Convex query", async () => {
				const { err, calls } = await readAs(UNRESOLVED, c.ownUri);
				expectRefused(err);
				expect(calls).toEqual([]);
			});

			it("master is unchanged: no verifiedOrg forwarded, every org's rows served", async () => {
				const { err, calls, html } = await readAs(MASTER, c.ownUri);
				expect(err).toBeUndefined();
				const call = calls.find((k) => k.fn === c.door);
				expect(call).toBeDefined();
				expect(call?.args).not.toHaveProperty("verifiedOrg");
				for (const own of c.own) expect(html).toContain(own);
			});

			it("Clerk-JWT caller is unchanged: served, no verifiedOrg forwarded (its own token scopes it in Convex)", async () => {
				const { err, calls } = await readAs(CLERK_JWT, c.ownUri);
				expect(err).toBeUndefined();
				const call = calls.find((k) => k.fn === c.door);
				expect(call).toBeDefined();
				expect(call?.args).not.toHaveProperty("verifiedOrg");
			});
		});
	}

	it("master reads every org through the unscoped door (the fake's no-claim pole is real)", async () => {
		const { html } = await readAs(MASTER, "ui://vp/v1/tasks-table");
		expect(html).toContain("A-TASK");
		expect(html).toContain("B-TASK");
	});

	it("mission-timeline: a non-master omitting pilot is REFUSED, as list_missions refuses it", async () => {
		const { err, calls } = await readAs(
			MEMBER_A,
			"ui://vp/v1/mission-timeline",
		);
		expectRefused(err);
		expect(calls).toEqual([]);
	});

	it("diary-entry: a non-master listing every orchestrator is REFUSED, as list_diaries refuses it", async () => {
		const { err, calls } = await readAs(MEMBER_A, "ui://vp/v1/diary-entry");
		expectRefused(err);
		expect(calls).toEqual([]);
	});
});

// Static pin: a primitive cannot call a scope-taking door without the tools'
// resolver. A door in DOOR_SCOPE must be handed `scope.doorArgs("<door>")` in
// the primitive that calls it; a door outside DOOR_SCOPE must be one of the
// doors whose tool scopes on the MCP side only, listed here on purpose. When a
// door of that list enters DOOR_SCOPE (the diary tenant fix,
// sigma/diary-tenant-scope), the first assertion fails until the primitive
// spreads its door arguments.
const MCP_SIDE_GATED_DOORS = new Set([
	"memories:listMemories",
	"diary:get",
	"diary:list",
]);

describe("every primitive door call goes through the tools' resolver", () => {
	const dir = resolve(
		dirname(fileURLToPath(import.meta.url)),
		"../src/ui-resources/primitives",
	);
	const sites = readdirSync(dir)
		.filter((f) => f.endsWith(".ts"))
		.flatMap((file) => {
			const src = readFileSync(resolve(dir, file), "utf8");
			return [...src.matchAll(/fetchConvex\(\s*"([A-Za-z]+:[A-Za-z]+)"/g)].map(
				(m) => ({ file, door: m[1], src }),
			);
		});

	it("finds the eight door calls of the six primitives", () => {
		expect(sites.length).toBe(8);
	});

	it("a DOOR_SCOPE door is handed scope.doorArgs of that door", () => {
		const missing = sites
			.filter((s) => DOOR_SCOPE[s.door] !== undefined)
			.filter((s) => !s.src.includes(`scope.doorArgs("${s.door}")`))
			.map((s) => `${s.file}:${s.door}`);
		expect(missing).toEqual([]);
	});

	it("any other door is a declared MCP-side-gated door", () => {
		const undeclared = sites
			.filter((s) => DOOR_SCOPE[s.door] === undefined)
			.filter((s) => !MCP_SIDE_GATED_DOORS.has(s.door))
			.map((s) => `${s.file}:${s.door}`);
		expect(undeclared).toEqual([]);
	});
});
