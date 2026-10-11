/**
 * PERSON_WRITES_OWN_NAME — a person signed in through /authorize (Claude.ai,
 * ChatGPT) writes in its OWN name, "user:<Clerk subject>", read from the token
 * row, never from an argument (task k176ch9tamzab3dnhye94kga1d8fkbhm).
 *
 * Before: a person token could read its org and could not write. Naming an
 * agent needed that agent's credential (strict), and naming nothing was
 * refused ("from='undefined' is not in this client's allowlist").
 *
 * The bridge: the MCP server reaches Convex as the service account, so the
 * Convex door cannot see the person on `ctx.auth`. On a covered tool, with no
 * acting name, the server forwards `verifiedPerson: { accessTokenHash }` (the
 * hash of the bearer the person presented). The Convex door believes it only
 * from the service account, re-reads the token row by that hash and builds the
 * person's scope from the row (subject, org, role) — then the dashboard's own
 * human door decides (`resolveHumanActor`: writer role, own org, actor).
 *
 * Harness: the real Hono app, the real authorize flow, the real bearer
 * middleware and the real Convex functions (convex-test).
 */

import { makeFunctionReference } from "convex/server";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../../convex/schema";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { app } from "../server-http.js";
import {
	_setInternalClientForTest,
	bearerAuthMiddleware,
	type OAuthContext,
	sha256Base64Url,
	sha256Hex,
} from "../src/auth.js";
import { registerTools } from "../src/tools.js";
import {
	authorizeAsPerson,
	type Harness,
	installAuthorizeHarness,
	membership,
} from "./lib/authorizeHarness.js";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../convex/**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill") &&
			!path.includes("__tests__") &&
			!path.endsWith(".test.ts"),
	),
);

const SERVICE_ACCOUNT_ID = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
const REDIRECT = "https://client.example/callback";
const CLIENT_ID = "client-claude";
const CLIENT_SECRET = "client-secret-raw";
const VERIFIER = "own-name-verifier-0123456789-0123456789-0123456789";

type T = ReturnType<typeof convexTest<typeof schema>>;
type ToolResult = { isError?: boolean; content: { text: string }[] };
type Tool = (args: Record<string, unknown>) => Promise<ToolResult>;

function bridge(t: T) {
	return {
		query: (name: string, args: Record<string, unknown>) =>
			t.query(makeFunctionReference<"query">(name) as never, args as never),
		mutation: (name: string, args: Record<string, unknown>) =>
			t.mutation(
				makeFunctionReference<"mutation">(name) as never,
				args as never,
			),
	};
}

let t: T;
let harness: Harness;
let challenge: string;

beforeEach(async () => {
	harness = await installAuthorizeHarness();
	challenge = await sha256Base64Url(VERIFIER);
	t = convexTest(schema, modules);
	_setInternalClientForTest(
		// biome-ignore lint/suspicious/noExplicitAny: test bridge
		bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })) as any,
	);
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_clients", {
			clientId: CLIENT_ID,
			clientSecretHash: await sha256Hex(CLIENT_SECRET),
			redirectUris: [REDIRECT],
			name: "Claude",
			scopeProfile: "client-generic",
			createdAt: now,
			tokenEndpointAuthMethod: "client_secret_basic",
		});
		for (const [slug, roster] of [
			["org-a", ["agent-a"]],
			["org-b", ["agent-b"]],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [...roster],
				scopes: ["vantage:read", "vantage:write"],
				displayName: slug,
				isActive: true,
				createdAt: now,
			});
		}
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: now,
		});
		// The recipient's profile, so a message to agent-a has a receipt to write.
		await ctx.db.insert("profiles", {
			orchestratorId: "agent-a",
			name: "agent-a",
			static: { role: "agent", workspace: "w", capabilities: [] },
			dynamic: { lastSeen: now, sessionCount: 0 },
		});
	});
	for (const [user, role] of [
		["user_viewer", "org:viewer"],
		["user_editor", "org:editor"],
		["user_admin", "org:admin"],
	] as const) {
		harness.setMemberships(user, [membership("org_A", "org-a", role)]);
	}
});

afterEach(() => {
	harness.restore();
	_setInternalClientForTest(null);
	vi.unstubAllEnvs();
});

async function personToken(userId: string): Promise<string> {
	const r = await authorizeAsPerson(app, {
		clientId: CLIENT_ID,
		redirectUri: REDIRECT,
		challenge,
		sessionToken: await harness.session(userId),
		orgId: "org_A",
	});
	expect(r.code).toBeTruthy();
	const res = await app.request("http://localhost:3000/token", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
		},
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code: r.code as string,
			code_verifier: VERIFIER,
			redirect_uri: REDIRECT,
			client_id: CLIENT_ID,
		}).toString(),
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { access_token: string }).access_token;
}

async function contextFor(
	token: string,
	credential?: string,
): Promise<OAuthContext> {
	const probe = new Hono();
	probe.use("*", bearerAuthMiddleware());
	probe.get("/ctx", (c) => c.json(c.get("oauthContext")));
	const headers: Record<string, string> = { authorization: `Bearer ${token}` };
	if (credential !== undefined)
		headers["x-vantage-agent-credential"] = credential;
	const res = await probe.request("http://localhost:3000/ctx", { headers });
	expect(res.status).toBe(200);
	return (await res.json()) as OAuthContext;
}

/** Tools wired to the REAL Convex functions, reached as the service account. */
function realTools(ctx: OAuthContext): Map<string, Tool> {
	const tools = new Map<string, Tool>();
	const server = {
		tool() {},
		registerTool: (name: string, _config: unknown, handler: Tool) => {
			tools.set(name, handler);
		},
	} as never;
	registerTools(
		server,
		// biome-ignore lint/suspicious/noExplicitAny: test bridge
		bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })) as any,
		ctx,
	);
	return tools;
}

async function call(
	tools: Map<string, Tool>,
	name: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const tool = tools.get(name);
	expect(tool, name).toBeDefined();
	return (await tool?.(args)) as ToolResult;
}

function idFrom(result: ToolResult, key: string): string {
	return (JSON.parse(result.content[0].text) as Record<string, string>)[key];
}

async function agentCredential(): Promise<string> {
	const admin = bridge(
		t.withIdentity({
			subject: "admin-of-org-a",
			org_slug: "org-a",
			org_id: testClerkOrgId("org-a"),
			org_role: "org:admin",
		} as never),
	);
	const agentId = (await admin.mutation("agents:registerAgent", {
		orgSlug: "org-a",
		name: "agent-a",
	})) as string;
	const minted = (await admin.mutation("agentCredentials:mintAgentCredential", {
		orgSlug: "org-a",
		agentId,
	})) as { secret: string };
	return minted.secret;
}

// The SDK applies zod defaults before a handler; this harness calls handlers
// directly, so the defaulted fields are spelled out.
const TASK = {
	title: "from a person",
	assignedTo: "agent-a",
	priority: "high",
	status: "todo",
};
const MISSION = {
	name: "m",
	project: "p",
	status: "brainstorm",
	priority: "high",
	pilot: "agent-a",
	agents: ["agent-a"],
};

const rows = (table: "tasks" | "missions" | "messages") =>
	t.run(async (ctx) => ctx.db.query(table).collect());

describe("pole 1 — an editor writes as itself: served, actor user:<sub>, own org", () => {
	it("create_task / start_task / update_task / complete_task", async () => {
		const tools = realTools(await contextFor(await personToken("user_editor")));
		const created = await call(tools, "create_task", TASK);
		expect(created.isError, created.content[0].text).toBeUndefined();
		const taskId = idFrom(created, "taskId");

		const [row] = await rows("tasks");
		expect(row.createdBy).toBe("user:user_editor");
		expect(row.lastActedBy).toBe("user:user_editor");
		expect(row.orgId).toBe("org-a");

		for (const [name, args] of [
			["start_task", { taskId }],
			["update_task", { taskId, priority: "low" }],
			["complete_task", { taskId, completionNote: "done by a person, 1 row" }],
		] as const) {
			const r = await call(tools, name, args);
			expect(r.isError, `${name}: ${r.content[0].text}`).toBeUndefined();
		}
		const [after] = await rows("tasks");
		expect(after.status).toBe("done");
		expect(after.priority).toBe("low");
		expect(after.lastActedBy).toBe("user:user_editor");
	});

	it("send_message: the sender is user:<sub> and the tenant is the token's org", async () => {
		const tools = realTools(await contextFor(await personToken("user_editor")));
		const r = await call(tools, "send_message", {
			channel: "agent-a",
			content: "hello from a person",
		});
		expect(r.isError, r.content[0].text).toBeUndefined();
		const [msg] = await rows("messages");
		expect(msg.from).toBe("user:user_editor");
		expect(msg.tenantId).toBe("org-a");
	});

	it("send_message: a tenantId argument naming another org never moves the message there", async () => {
		const tools = realTools(await contextFor(await personToken("user_editor")));
		const r = await call(tools, "send_message", {
			channel: "agent-a",
			content: "hello",
			tenantId: "org-b",
		});
		const stored = await rows("messages");
		expect(stored.filter((m) => m.tenantId === "org-b")).toEqual([]);
		if (r.isError === undefined) expect(stored[0].tenantId).toBe("org-a");
	});

	it("create_mission / update_mission", async () => {
		const tools = realTools(await contextFor(await personToken("user_editor")));
		const created = await call(tools, "create_mission", MISSION);
		expect(created.isError, created.content[0].text).toBeUndefined();
		const missionId = idFrom(created, "missionId");
		const updated = await call(tools, "update_mission", {
			missionId,
			progress: 40,
		});
		expect(updated.isError, updated.content[0].text).toBeUndefined();
		const [m] = await rows("missions");
		expect(m.createdBy).toBe("user:user_editor");
		expect(m.lastActedBy).toBe("user:user_editor");
		expect(m.orgId).toBe("org-a");
		expect(m.progress).toBe(40);
	});

	it("naming ITSELF (user:<own sub>) restates the token and is served as itself", async () => {
		const tools = realTools(await contextFor(await personToken("user_editor")));
		const r = await call(tools, "create_task", {
			...TASK,
			createdBy: "user:user_editor",
		});
		expect(r.isError, r.content[0].text).toBeUndefined();
		const [row] = await rows("tasks");
		expect(row.createdBy).toBe("user:user_editor");
	});
});

describe("pole 2 — a viewer's write is refused role-not-writer", () => {
	it("create_task and send_message write nothing", async () => {
		const tools = realTools(await contextFor(await personToken("user_viewer")));
		for (const [name, args] of [
			["create_task", TASK],
			["send_message", { channel: "agent-a", content: "x" }],
			["create_mission", MISSION],
		] as const) {
			const r = await call(tools, name, args);
			expect(r.isError, name).toBe(true);
			expect(r.content[0].text, name).toContain("role-not-writer");
		}
		expect(await rows("tasks")).toEqual([]);
		expect(await rows("messages")).toEqual([]);
		expect(await rows("missions")).toEqual([]);
	});
});

describe("pole 3 — a person naming an agent without its credential is refused", () => {
	it("createdBy / from / callerOrchestrator = agent-a", async () => {
		const tools = realTools(await contextFor(await personToken("user_editor")));
		for (const [name, args] of [
			["create_task", { ...TASK, createdBy: "agent-a" }],
			["send_message", { from: "agent-a", channel: "agent-a", content: "x" }],
			["create_mission", { ...MISSION, createdBy: "agent-a" }],
		] as const) {
			const r = await call(tools, name, args);
			expect(r.isError, name).toBe(true);
			expect(r.content[0].text, name).toContain("AGENT_CREDENTIAL_REQUIRED");
		}
		expect(await rows("tasks")).toEqual([]);
		expect(await rows("messages")).toEqual([]);
		expect(await rows("missions")).toEqual([]);
	});
});

describe("pole 4 — a person naming ANOTHER user is refused", () => {
	it("createdBy / from = user:other writes nothing", async () => {
		const tools = realTools(await contextFor(await personToken("user_editor")));
		for (const [name, args] of [
			["create_task", { ...TASK, createdBy: "user:other" }],
			[
				"send_message",
				{ from: "user:other", channel: "agent-a", content: "x" },
			],
			["create_mission", { ...MISSION, createdBy: "user:other" }],
		] as const) {
			const r = await call(tools, name, args);
			expect(r.isError, name).toBe(true);
			expect(r.content[0].text, name).toContain("PERSON_ACTS_AS_ITSELF");
		}
		expect(await rows("tasks")).toEqual([]);
		expect(await rows("messages")).toEqual([]);
		expect(await rows("missions")).toEqual([]);
	});
});

describe("pole 5 — seat tokens and agent credentials are unchanged", () => {
	it("a person presenting agent-a's credential, naming agent-a, acts as agent-a", async () => {
		const tools = realTools(
			await contextFor(
				await personToken("user_editor"),
				await agentCredential(),
			),
		);
		const r = await call(tools, "create_task", {
			...TASK,
			createdBy: "agent-a",
		});
		expect(r.isError, r.content[0].text).toBeUndefined();
		const [row] = await rows("tasks");
		expect(row.createdBy).toBe("agent-a");
	});

	it("a single-name seat acting as itself creates as that seat, never as a person", async () => {
		const token = "seat-token-raw-agent-a";
		// The seat is an agent BY ID: its profile (<agent>-<org>) names one agent and
		// that agent exists in the profile's own org (the stamp is resolved from it).
		await t.run(async (ctx) => {
			await ctx.db.insert("agents", {
				orgSlug: "org-a",
				clerkOrgId: testClerkOrgId("org-a"),
				name: "agent-a",
				normalizedName: "agent-a",
				isActive: true,
				createdAt: Date.now(),
			});
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "agent-a-org-a",
				description: "Seat agent-a in org org-a",
				fromAllowList: ["agent-a"],
				namespaceReadPrefixes: ["team/org-a"],
				namespaceWritePrefixes: ["team/org-a"],
				createdAt: Date.now(),
				updatedAt: Date.now(),
				clerkOrgSlug: "org-a",
				clerkOrgId: testClerkOrgId("org-a"),
			});
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash: await sha256Hex(token),
				clientId: "seat-client",
				userId: "seat-user",
				scopes: ["vantage:read", "vantage:write"],
				scopeProfile: "agent-a-org-a",
				fromAllowList: ["agent-a"],
				namespaceReadPrefixes: ["team/org-a"],
				namespaceWritePrefixes: ["team/org-a"],
				expiresAt: Date.now() + 3_600_000,
				createdAt: Date.now(),
				clerkOrgSlug: "org-a",
				clerkOrgId: testClerkOrgId("org-a"),
			});
		});
		const tools = realTools(await contextFor(token));
		const r = await call(tools, "create_task", {
			...TASK,
			createdBy: "agent-a",
		});
		expect(r.isError, r.content[0].text).toBeUndefined();
		const [row] = await rows("tasks");
		expect(row.createdBy).toBe("agent-a");

		// A seat that omits the name acts as its resolved agent: never as a person.
		const omitted = await call(tools, "create_task", TASK);
		expect(omitted.isError, omitted.content[0].text).toBeUndefined();
		const all = await rows("tasks");
		expect(all).toHaveLength(2);
		expect(all.every((r2) => r2.createdBy === "agent-a")).toBe(true);
	});

	it("an org-level seat (its profile resolves no agent of its own org) naming an agent is refused", async () => {
		const token = "seat-token-raw-orglevel";
		await t.run(async (ctx) => {
			// The profile exists, but org-a has no agent "agent-a" registered.
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "agent-a-org-a",
				description: "Seat agent-a in org org-a",
				fromAllowList: ["agent-a"],
				namespaceReadPrefixes: ["team/org-a"],
				namespaceWritePrefixes: ["team/org-a"],
				createdAt: Date.now(),
				updatedAt: Date.now(),
				clerkOrgSlug: "org-a",
				clerkOrgId: testClerkOrgId("org-a"),
			});
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash: await sha256Hex(token),
				clientId: "seat-client",
				userId: "seat-user",
				scopes: ["vantage:read", "vantage:write"],
				scopeProfile: "agent-a-org-a",
				fromAllowList: ["agent-a"],
				namespaceReadPrefixes: ["team/org-a"],
				namespaceWritePrefixes: ["team/org-a"],
				expiresAt: Date.now() + 3_600_000,
				createdAt: Date.now(),
				clerkOrgSlug: "org-a",
				clerkOrgId: testClerkOrgId("org-a"),
			});
		});
		const tools = realTools(await contextFor(token));
		const r = await call(tools, "create_task", {
			...TASK,
			createdBy: "agent-a",
		});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("AGENT_CREDENTIAL_REQUIRED");
		expect(await rows("tasks")).toHaveLength(0);
	});
});

describe("the declared set: a write tool with an acting name and no human door refuses a person", () => {
	it("fail_task / delete_task / create_briefing_note refuse PERSON_NO_HUMAN_DOOR", async () => {
		const tools = realTools(await contextFor(await personToken("user_editor")));
		for (const name of ["fail_task", "delete_task", "create_briefing_note"]) {
			const r = await call(tools, name, {});
			expect(r.isError, name).toBe(true);
			expect(r.content[0].text, name).toContain("PERSON_NO_HUMAN_DOOR");
		}
	});
});
