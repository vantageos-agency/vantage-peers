/**
 * The recurring-task doors receive the acting agent's ID (M10h client side).
 * VantagePeers Cloud (multi-tenant).
 *
 * convex/recurringTasks.ts (M10h) resolves the creator and the assignee BY ID
 * and, for a caller reaching Convex as the fleet service account, learns which
 * agent a seat or credential acts as from `verifiedActor` alone. Without it the
 * door resolves the assignee in the OPERATOR organisation, so an org seat could
 * neither name its own org's agent as assignee nor be recorded as the creator.
 *
 * Poles, each through the real tool:
 *   SEAT CREATES   a seat for clio-acme-hr creating a schedule: the door receives
 *                  clio's ID and org, and the creator name derived from the seat.
 *   CREDENTIAL     a master-scope bearer acting through a credential pauses /
 *                  resumes / deletes / updates: each door receives the agent ID.
 *   OTHER ORG      a seat of another org (stamp absent) naming clio is refused,
 *                  nothing dispatched; a seat stamped for ANOTHER agent forwards
 *                  ITS ID, never clio's.
 *   NO AGENT       a bearer that resolved no agent forwards nothing (reader-first).
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetUnattributedClaimsForTest,
	_setInternalClientForTest,
	ACTOR_CREDENTIAL_MODE_ENV,
	bearerAuthMiddleware,
	type OAuthContext,
	sha256Hex,
} from "../src/auth.js";
import { registerTools } from "../src/tools.js";
import { VERIFIED_ACTOR_DOORS } from "../src/verifiedActor.js";

const CLIO_ID = "agentclio0000000000000000000001";
const CLIO_OTHER_ORG_ID = "agentclio0000000000000000000002";
const RECURRING_ID = "j57aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const TOKENS = {
	clioSeat: "seat-clio-acme-hr",
	otherOrgSeat: "seat-clio-other-org",
	otherOrgStamped: "seat-clio-other-org-stamped",
	oldConvexSeat: "seat-old-convex",
} as const;

const ROWS: Record<string, Record<string, unknown>> = {};
// Each organisation's own roster, read from DATA by the delegation guard.
const ROSTERS: Record<string, string[]> = {
	"acme-hr": ["clio", "vera"],
	"other-org": ["clio"],
};

function installInternalClient(): void {
	const fake = {
		query: async (name: string, args: unknown) => {
			if (name === "oauth:getAccessTokenByHash") {
				return ROWS[(args as { tokenHash: string }).tokenHash] ?? null;
			}
			throw new Error(`unmocked query: ${name}`);
		},
		mutation: async (name: string) => {
			throw new Error(`unmocked mutation: ${name}`);
		},
	};
	// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	_setInternalClientForTest(fake as any);
}

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function fakeServer(): { server: McpServer; tools: Map<string, Handler> } {
	const tools = new Map<string, Handler>();
	const reg = (...a: unknown[]) => {
		tools.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	return {
		server: { tool: reg, registerTool: reg } as unknown as McpServer,
		tools,
	};
}

type Call = { name: string; args: Record<string, unknown> };

let storedRow: Record<string, unknown> = {};

function recordingConvex() {
	const calls: Call[] = [];
	const row = {
		_id: RECURRING_ID,
		createdBy: "clio",
		assignedTo: "clio",
		title: "standup",
		...storedRow,
	};
	return {
		calls,
		client: {
			query: vi.fn(async (name: string, args: Record<string, unknown>) => {
				calls.push({ name, args });
				if (name === "orgRoster:getForAccessToken") {
					const org = ROWS[String(args.tokenHash)]?.clerkOrgSlug as string;
					return ROSTERS[org] ?? [];
				}
				return name === "recurringTasks:getById" ? row : null;
			}),
			mutation: vi.fn(async (name: string, args: Record<string, unknown>) => {
				calls.push({ name, args });
				return { ok: true };
			}),
			action: vi.fn(async () => null),
		},
	};
}

function buildApp(convex: unknown): Hono {
	const app = new Hono();
	app.use("*", bearerAuthMiddleware());
	app.post("/tool/:name", async (c) => {
		const ctx = c.get("oauthContext") as OAuthContext;
		const { server, tools } = fakeServer();
		// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
		registerTools(server, convex as any, ctx);
		const tool = tools.get(c.req.param("name"));
		if (!tool) return c.json({ missing: true }, 404);
		return c.json({ result: await tool((await c.req.json()) as never) });
	});
	return app;
}

async function postAsSeat(tool: string, bearer: string, body: unknown) {
	const { calls, client } = recordingConvex();
	const res = await buildApp(client).request(`http://localhost/tool/${tool}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${bearer}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const json = (await res.json()) as Record<string, unknown>;
	const result = json.result as
		| { isError?: boolean; content?: Array<{ text?: string }> }
		| undefined;
	return {
		refused: result?.isError === true,
		text: result?.content?.[0]?.text ?? "",
		calls,
	};
}

async function callAsCtx(
	tool: string,
	ctx: OAuthContext,
	body: Record<string, unknown>,
) {
	const { calls, client } = recordingConvex();
	const { server, tools } = fakeServer();
	// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	registerTools(server, client as any, ctx);
	const handler = tools.get(tool);
	if (!handler) throw new Error(`tool ${tool} not registered`);
	const result = (await handler(body)) as {
		isError?: boolean;
		content?: Array<{ text?: string }>;
	};
	return {
		refused: result.isError === true,
		text: result.content?.[0]?.text ?? "",
		calls,
	};
}

const CREATE = {
	title: "standup",
	assignedTo: "vera",
	priority: "medium",
	cronExpression: "0 9 * * *",
};

let savedMode: string | undefined;
beforeEach(async () => {
	storedRow = {};
	savedMode = process.env[ACTOR_CREDENTIAL_MODE_ENV];
	delete process.env[ACTOR_CREDENTIAL_MODE_ENV];
	_resetUnattributedClaimsForTest();
	vi.spyOn(console, "error").mockImplementation(() => {});
	process.env.CONVEX_URL_INTERNAL = "https://internal.example.convex.cloud";
	const base = {
		userId: "user-x",
		scopes: ["vantage:read", "vantage:write"],
		expiresAt: Date.now() + 3_600_000,
	};
	const seat = (name: string, org: string) => ({
		...base,
		clientId: `client-${name}-${org}`,
		scopeProfile: `${name}-${org}`,
		fromAllowList: [name, "vera"],
		namespaceReadPrefixes: [`orchestrator/${name}`],
		namespaceWritePrefixes: [`orchestrator/${name}`],
		clerkOrgSlug: org,
	});
	ROWS[await sha256Hex(TOKENS.clioSeat)] = {
		...seat("clio", "acme-hr"),
		seatAgent: { agentId: CLIO_ID, orgId: "acme-hr", agentName: "clio" },
	};
	// The same name in another org, with NO agent of that name there: no stamp.
	ROWS[await sha256Hex(TOKENS.otherOrgSeat)] = {
		...seat("clio", "other-org"),
		seatAgent: null,
	};
	// The same name in another org, which DOES have a clio: its own ID and org.
	ROWS[await sha256Hex(TOKENS.otherOrgStamped)] = {
		...seat("clio", "other-org"),
		seatAgent: {
			agentId: CLIO_OTHER_ORG_ID,
			orgId: "other-org",
			agentName: "clio",
		},
	};
	ROWS[await sha256Hex(TOKENS.oldConvexSeat)] = seat("clio", "acme-hr");
	installInternalClient();
});

afterEach(() => {
	if (savedMode === undefined) delete process.env[ACTOR_CREDENTIAL_MODE_ENV];
	else process.env[ACTOR_CREDENTIAL_MODE_ENV] = savedMode;
	vi.restoreAllMocks();
	_resetUnattributedClaimsForTest();
	_setInternalClientForTest(null);
});

describe("create_recurring_task forwards the seat's agent", () => {
	it("a seat for clio-acme-hr: the door receives clio's ID and org, creator derived from the seat", async () => {
		const r = await postAsSeat("create_recurring_task", TOKENS.clioSeat, CREATE);
		expect(r.text).not.toContain("Forbidden");
		expect(r.refused, r.text).toBe(false);
		const create = r.calls.find((c) => c.name === "recurringTasks:create");
		expect(create).toBeDefined();
		expect(create?.args.createdBy).toBe("clio");
		expect(create?.args.verifiedActor).toEqual({
			agentId: CLIO_ID,
			orgSlug: "acme-hr",
		});
	});

	it("a seat of ANOTHER org with no agent of that name is refused, nothing dispatched", async () => {
		const r = await postAsSeat("create_recurring_task", TOKENS.otherOrgSeat, {
			...CREATE,
			createdBy: "clio",
		});
		expect(r.refused).toBe(true);
		expect(r.text).toContain("AGENT_CREDENTIAL_REQUIRED");
		expect(r.calls.filter((c) => c.name.startsWith("recurringTasks:"))).toEqual(
			[],
		);
	});

	it("an agent of another org cannot assign into acme-hr: vera is not on its roster, nothing dispatched", async () => {
		const r = await postAsSeat("create_recurring_task", TOKENS.otherOrgStamped, {
			...CREATE,
			assignedTo: "vera",
		});
		expect(r.refused).toBe(true);
		expect(r.text).toContain("not a member of the caller's organisation");
		expect(r.calls.filter((c) => c.name === "recurringTasks:create")).toEqual(
			[],
		);
	});

	it("the same name from another org that has its own clio forwards ITS ID, never acme-hr's", async () => {
		const r = await postAsSeat("create_recurring_task", TOKENS.otherOrgStamped, {
			...CREATE,
			assignedTo: "clio",
		});
		const create = r.calls.find((c) => c.name === "recurringTasks:create");
		expect(create?.args.verifiedActor).toEqual({
			agentId: CLIO_OTHER_ORG_ID,
			orgSlug: "other-org",
		});
		expect(create?.args.verifiedActor).not.toEqual({
			agentId: CLIO_ID,
			orgSlug: "acme-hr",
		});
	});

	it("reader-first: a provider that predates the stamp forwards no actor", async () => {
		// Before the stamp existed a typed name was served on the permissive cutover.
		process.env[ACTOR_CREDENTIAL_MODE_ENV] = "permissive";
		const r = await postAsSeat("create_recurring_task", TOKENS.oldConvexSeat, {
			...CREATE,
			createdBy: "clio",
		});
		const create = r.calls.find((c) => c.name === "recurringTasks:create");
		expect(create).toBeDefined();
		expect(create?.args).not.toHaveProperty("verifiedActor");
	});
});

describe("the schedule doors forward the acting agent of a credential-bearing bearer", () => {
	const masterWithCredential: OAuthContext = {
		clientId: "master",
		userId: "master",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "master",
		fromAllowList: ["*"],
		namespaceReadPrefixes: ["*"],
		namespaceWritePrefixes: ["*"],
		expiresAt: Date.now() + 3_600_000,
		isMaster: true,
		actor: { orgSlug: "acme-hr", agentName: "clio", agentId: CLIO_ID },
	};
	const expected = { agentId: CLIO_ID, orgSlug: "acme-hr" };

	for (const [tool, door, args] of [
		["pause_recurring_task", "recurringTasks:pause", { taskId: RECURRING_ID }],
		["resume_recurring_task", "recurringTasks:resume", { taskId: RECURRING_ID }],
		["delete_recurring_task", "recurringTasks:remove", { taskId: RECURRING_ID }],
		[
			"update_recurring_task",
			"recurringTasks:update",
			{ recurringTaskId: RECURRING_ID, title: "renamed" },
		],
	] as const) {
		it(`${tool} -> ${door} carries verifiedActor`, async () => {
			storedRow = { createdById: CLIO_ID };
			const r = await callAsCtx(tool, masterWithCredential, { ...args });
			expect(r.refused).toBe(false);
			const call = r.calls.find((c) => c.name === door);
			expect(call?.args.verifiedActor).toEqual(expected);
		});
	}

	it("a master bearer that resolved no agent forwards nothing", async () => {
		const { actor: _actor, ...noAgent } = masterWithCredential;
		const r = await callAsCtx("pause_recurring_task", noAgent, {
			taskId: RECURRING_ID,
		});
		const call = r.calls.find((c) => c.name === "recurringTasks:pause");
		expect(call).toBeDefined();
		expect(call?.args).not.toHaveProperty("verifiedActor");
	});

	it("the master-only gate on pause stays: a seat is still refused, nothing dispatched", async () => {
		const r = await postAsSeat("pause_recurring_task", TOKENS.clioSeat, {
			taskId: RECURRING_ID,
		});
		expect(r.refused).toBe(true);
		expect(r.text).toContain("Forbidden");
		expect(r.calls.filter((c) => c.name.startsWith("recurringTasks:"))).toEqual(
			[],
		);
	});
});

describe("the recurring doors are registered as verifiedActor doors", () => {
	it("all five", () => {
		for (const door of [
			"recurringTasks:create",
			"recurringTasks:update",
			"recurringTasks:pause",
			"recurringTasks:resume",
			"recurringTasks:remove",
		]) {
			expect(VERIFIED_ACTOR_DOORS.has(door), door).toBe(true);
		}
	});
});

describe("update_recurring_task decides no ownership: the Convex door does, on the forwarded agent ID", () => {
	const seatCtx = (agentId: string, orgId: string): OAuthContext => ({
		clientId: `client-clio-${orgId}`,
		userId: "user-x",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: `clio-${orgId}`,
		// The NAME allowlist matches the row's creator in BOTH orgs.
		fromAllowList: ["clio"],
		namespaceReadPrefixes: ["orchestrator/clio"],
		namespaceWritePrefixes: ["orchestrator/clio"],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		clerkOrgSlug: orgId,
		seatAgent: { agentId, orgId, agentName: "clio" },
	});
	const update = (ctx: OAuthContext) =>
		callAsCtx("update_recurring_task", ctx, {
			recurringTaskId: RECURRING_ID,
			title: "changed",
		});
	const wrote = (calls: Call[]) =>
		calls.some((c) => c.name === "recurringTasks:update");

	it("the same-name clio of ANOTHER org forwards ITS OWN agent ID, so the door can refuse it", async () => {
		storedRow = { createdById: CLIO_ID, orgId: "acme-hr" };
		const r = await update(seatCtx(CLIO_OTHER_ORG_ID, "other-org"));
		const call = r.calls.find((c) => c.name === "recurringTasks:update");
		expect(call?.args.verifiedActor).toEqual({
			agentId: CLIO_OTHER_ORG_ID,
			orgSlug: "other-org",
		});
	});

	it("the owner agent forwards its ID and org", async () => {
		storedRow = { createdById: CLIO_ID, orgId: "acme-hr" };
		const r = await update(seatCtx(CLIO_ID, "acme-hr"));
		expect(r.refused).toBe(false);
		const call = r.calls.find((c) => c.name === "recurringTasks:update");
		expect(call?.args.verifiedActor).toEqual({
			agentId: CLIO_ID,
			orgSlug: "acme-hr",
		});
	});

	it("the fleet master with no forwarded agent keeps its access", async () => {
		const { actor: _a, ...master } = {
			clientId: "master",
			userId: "master",
			scopes: ["vantage:read", "vantage:write"],
			scopeProfile: "master",
			fromAllowList: ["*"],
			namespaceReadPrefixes: ["*"],
			namespaceWritePrefixes: ["*"],
			expiresAt: Date.now() + 3_600_000,
			isMaster: true,
			actor: undefined,
		};
		const r = await update(master as OAuthContext);
		expect(r.refused).toBe(false);
		expect(wrote(r.calls)).toBe(true);
	});
});
