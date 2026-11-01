/**
 * resources/read of ui://vp/v1/<primitive> is PARTITIONED BY ORGANISATION,
 * exactly as the text tools are. VantagePeers Cloud (HTTP /mcp entry).
 * Task k179y0wpsd6fv7055f4p2w6b358hdrxe (scope addition). The two-organisation
 * fixture and the per-primitive cases are taken from branch
 * sigma/ui-resource-scope @a0137da5 (task k17apssqnw2xcf72r27c83338s8hc180);
 * that branch's per-primitive MCP post-filters are NOT taken.
 *
 * Before: PR #1636 refused every non-master OAuth bearer, because each
 * primitive reached Convex through the fleet service-account client, which
 * Convex serves fleet-wide.
 *
 * Now: an OAuth bearer whose organisation resolved is served. Its client is the
 * one `selectConvexClientForRequest` builds for it in production: the service
 * account with the bearer's verified org attached as `__actingOrg` to EVERY
 * call, which Convex answers as an ordinary member of that org
 * (convex/__tests__/actingOrgIsolation.test.ts proves the Convex side, door by
 * door). The primitives add no scope of their own.
 *
 * The backend here is a FAKE two-organisation Convex standing in for that
 * contract: a call carrying `__actingOrg` is served that org's rows only; a call
 * carrying nothing is served every org's rows, which is what the fleet service
 * account really receives. So a read that does not go through the wrapped
 * client shows org-b's rows, and these tests fail.
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it } from "vitest";
import { isMasterScope, type OAuthContext } from "../src/auth.js";
import { selectConvexClientForRequest } from "../src/authenticatedConvexClient.js";
import { registerUiResources } from "../src/ui-resources/register.js";

const ORG_A = "org-a";
const ORG_B = "org-b";
const ORG_ID: Record<string, string> = { [ORG_A]: "org_AAAA", [ORG_B]: "org_BBBB" };

type Row = Record<string, unknown> & { org: string; marker: string };

const ROWS: Record<string, Row[]> = {
	tasks: [
		{ org: ORG_A, marker: "A-TASK", _id: "t1", title: "A-TASK", status: "todo", assignedTo: "alice", createdBy: "alice", orgId: ORG_A },
		{ org: ORG_B, marker: "B-TASK", _id: "t2", title: "B-TASK", status: "todo", assignedTo: "mallory", createdBy: "mallory", orgId: ORG_B },
	],
	messages: [
		{ org: ORG_A, marker: "A-MSG", _id: "m1", from: "alice", channel: "broadcast", content: "A-MSG", createdAt: 1 },
		{ org: ORG_B, marker: "B-MSG", _id: "m2", from: "mallory", channel: "broadcast", content: "B-MSG", createdAt: 2 },
	],
	memories: [
		{ org: ORG_A, marker: "A-MEM", _id: "y1", namespace: "team/org-a", type: "fact", content: "A-MEM", createdBy: "alice" },
		{ org: ORG_B, marker: "B-MEM", _id: "y2", namespace: "team/org-b", type: "fact", content: "B-MEM", createdBy: "mallory" },
	],
	missions: [
		{ org: ORG_A, marker: "A-MISSION", _id: "s1", name: "A-MISSION", status: "execute", pilot: "alice" },
		{ org: ORG_B, marker: "B-MISSION", _id: "s2", name: "B-MISSION", status: "execute", pilot: "mallory" },
		// org-b's own "alice": a same-named pilot of ANOTHER org.
		{ org: ORG_B, marker: "B-ALICE-MISSION", _id: "s3", name: "B-ALICE-MISSION", status: "execute", pilot: "alice" },
	],
	diary: [
		{ org: ORG_A, marker: "A-DIARY", _id: "d1", date: "2026-11-01", orchestrator: "alice", createdBy: "alice", content: "A-DIARY" },
		{ org: ORG_B, marker: "B-DIARY", _id: "d2", date: "2026-11-01", orchestrator: "mallory", createdBy: "mallory", content: "B-DIARY" },
	],
	briefingNotes: [
		{ org: ORG_A, marker: "A-NOTE", _id: "n1", topic: "t", title: "A-NOTE", createdBy: "alice", participants: ["alice"] },
		{ org: ORG_B, marker: "B-NOTE", _id: "n2", topic: "t", title: "B-NOTE", createdBy: "mallory", participants: ["mallory"] },
	],
};

type Call = { fn: string; args: Record<string, unknown> };

/** The fake backend: `__actingOrg` scopes every door, its absence does not. */
function fakeServiceAccount(calls: Call[]): ConvexHttpClient {
	const query = async (fn: unknown, rawArgs: unknown) => {
		const name = String(fn);
		const args = (rawArgs ?? {}) as Record<string, unknown>;
		calls.push({ fn: name, args });
		const acting = args.__actingOrg as string | undefined;
		const org = acting === undefined ? undefined : Object.keys(ORG_ID).find((k) => ORG_ID[k] === acting);
		const inOrg = (rows: Row[]) => (acting === undefined ? rows : rows.filter((r) => r.org === org));
		switch (name) {
			case "tasks:list":
				return inOrg(ROWS.tasks);
			case "messages:listMessages":
				return inOrg(ROWS.messages);
			case "memories:listMemories":
				return { value: inOrg(ROWS.memories).filter((r) => r.namespace === args.namespace), isDone: true, continueCursor: null };
			case "missions:list":
				return inOrg(ROWS.missions).filter((r) => args.pilot === undefined || r.pilot === args.pilot);
			case "diary:list":
				return inOrg(ROWS.diary).filter(
					(r) =>
						(args.orchestrator === undefined || r.orchestrator === args.orchestrator) &&
						(args.createdBy === undefined || r.createdBy === args.createdBy),
				);
			case "diary:get":
				return inOrg(ROWS.diary).find((r) => r.date === args.date && r.orchestrator === args.orchestrator) ?? null;
			case "briefingNotes:list":
				return inOrg(ROWS.briefingNotes);
			case "briefingNotes:get":
				return inOrg(ROWS.briefingNotes).find((r) => r._id === args.noteId) ?? null;
			default:
				throw new Error(`fake backend: no door ${name}`);
		}
	};
	return { query, mutation: query, action: query, setAuth: () => undefined } as unknown as ConvexHttpClient;
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

/** An org-a seat: an OAuth bearer whose access-token row resolved org-a. */
const MEMBER_A = baseCtx({ accessTokenHash: "a".repeat(64), clerkOrgSlug: ORG_A, orgClerkId: ORG_ID[ORG_A] });
/** An OAuth bearer whose organisation resolves to no ID. */
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
	const fake = fakeServiceAccount(calls);
	// The production selection (server-http.ts /mcp), with the fake as both the
	// service-account and the plain client.
	const convex = selectConvexClientForRequest("https://t.convex.cloud", oauthCtx, {
		createServiceAccountClient: () => fake,
		createPlainClient: () => fakeServiceAccount(calls),
	});
	const master = oauthCtx === undefined || isMasterScope(oauthCtx);
	const server = new McpServer({ name: "t", version: "0.0.0" });
	registerUiResources(server, convex, oauthCtx, {
		master,
		callerIdentities: master ? undefined : oauthCtx?.fromAllowList,
	});
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
	ownUri: string;
	own: string[];
	foreign: string[];
	door: string;
	/** A read naming org-b's data: the acting org keeps it out. */
	foreignUri?: string;
};

const CASES: Case[] = [
	{ primitive: "tasks-table", ownUri: "ui://vp/v1/tasks-table", own: ["A-TASK"], foreign: ["B-TASK"], door: "tasks:list" },
	{ primitive: "messages-feed", ownUri: "ui://vp/v1/messages-feed", own: ["A-MSG"], foreign: ["B-MSG"], door: "messages:listMessages" },
	{ primitive: "memory-quote", ownUri: "ui://vp/v1/memory-quote?namespace=team%2Forg-a", own: ["A-MEM"], foreign: ["B-MEM"], door: "memories:listMemories", foreignUri: "ui://vp/v1/memory-quote?namespace=team%2Forg-b" },
	{ primitive: "mission-timeline", ownUri: "ui://vp/v1/mission-timeline?pilot=alice", own: ["A-MISSION"], foreign: ["B-MISSION", "B-ALICE-MISSION"], door: "missions:list", foreignUri: "ui://vp/v1/mission-timeline?pilot=mallory" },
	{ primitive: "diary-entry (list)", ownUri: "ui://vp/v1/diary-entry?orchestrator=alice", own: ["A-DIARY"], foreign: ["B-DIARY"], door: "diary:list", foreignUri: "ui://vp/v1/diary-entry?orchestrator=mallory" },
	{ primitive: "diary-entry (get)", ownUri: "ui://vp/v1/diary-entry?date=2026-11-01&orchestrator=alice", own: ["A-DIARY"], foreign: ["B-DIARY"], door: "diary:get", foreignUri: "ui://vp/v1/diary-entry?date=2026-11-01&orchestrator=mallory" },
	{ primitive: "briefing-note (list)", ownUri: "ui://vp/v1/briefing-note", own: ["A-NOTE"], foreign: ["B-NOTE"], door: "briefingNotes:list" },
	{ primitive: "briefing-note (get)", ownUri: "ui://vp/v1/briefing-note?noteId=n1", own: ["A-NOTE"], foreign: ["B-NOTE"], door: "briefingNotes:get", foreignUri: "ui://vp/v1/briefing-note?noteId=n2" },
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
			it("org-a seat is served org-a rows only, its call carrying org-a as __actingOrg", async () => {
				const { html, err, calls } = await readAs(MEMBER_A, c.ownUri);
				expect(err).toBeUndefined();
				for (const own of c.own) expect(html).toContain(own);
				for (const foreign of c.foreign) expect(html).not.toContain(foreign);
				const call = calls.find((k) => k.fn === c.door);
				expect(call, `the read reaches ${c.door}`).toBeDefined();
				expect(call?.args.__actingOrg).toBe(ORG_ID[ORG_A]);
				expect(calls.every((k) => k.args.__actingOrg === ORG_ID[ORG_A])).toBe(true);
			});

			if (c.foreignUri !== undefined) {
				const foreignUri = c.foreignUri;
				it("org-a seat naming org-b's data never sees an org-b row", async () => {
					const { html } = await readAs(MEMBER_A, foreignUri);
					for (const foreign of c.foreign) expect(html).not.toContain(foreign);
				});
			}

			it("a seat whose organisation resolves to nothing is still REFUSED, no Convex query", async () => {
				const { err, calls } = await readAs(UNRESOLVED, c.ownUri);
				expectRefused(err);
				expect(calls).toEqual([]);
			});

			it("master is unchanged: no __actingOrg forwarded, its rows served", async () => {
				const { err, calls, html } = await readAs(MASTER, c.ownUri);
				expect(err).toBeUndefined();
				const call = calls.find((k) => k.fn === c.door);
				expect(call).toBeDefined();
				expect(call?.args).not.toHaveProperty("__actingOrg");
				for (const own of c.own) expect(html).toContain(own);
			});

			it("Clerk-JWT caller is unchanged: served, no __actingOrg (its own token scopes it in Convex)", async () => {
				const { err, calls } = await readAs(CLERK_JWT, c.ownUri);
				expect(err).toBeUndefined();
				const call = calls.find((k) => k.fn === c.door);
				expect(call).toBeDefined();
				expect(call?.args).not.toHaveProperty("__actingOrg");
			});
		});
	}

	it("master reads every org through the unscoped door (the fake's no-org pole is real)", async () => {
		const { html } = await readAs(MASTER, "ui://vp/v1/tasks-table");
		expect(html).toContain("A-TASK");
		expect(html).toContain("B-TASK");
	});

	it("no oauthContext at all is REFUSED, no Convex query", async () => {
		const { err, calls } = await readAs(undefined, "ui://vp/v1/tasks-table");
		expectRefused(err);
		expect(calls).toEqual([]);
	});
});
