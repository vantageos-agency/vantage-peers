/**
 * A PERSON reads back what it writes (task k176y0q5jcz3m8m673bf61kva98h49js).
 *
 * Measured on production: a person (claude.ai connector, OAuth person token,
 * scope team-member) whose personal agent is "telemaque" called create_task
 * with createdBy="telemaque". The row was written with NO orgId and NO
 * clerkOrgId, so every org-scoped read (get_task, list_tasks) filtered it out:
 * write-only. The write door forwarded LESS scope than its read sibling.
 *
 * Harness: the real bearer middleware (a person token minted through
 * oauth:createAccessToken, the personal agent resolved by Convex) and the real
 * Convex functions (convex-test), reached as the fleet service account, exactly
 * as server-http.ts reaches them. Every pole runs under a SCOPED person
 * identity, never the master.
 */

import { makeFunctionReference } from "convex/server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import schema from "../../convex/schema";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import {
	_setInternalClientForTest,
	bearerAuthMiddleware,
	type OAuthContext,
	sha256Hex,
} from "../src/auth.js";
import { registerTools } from "../src/tools.js";

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
const STEPHANE = "user_2stephane";
const BRUNO = "user_2bruno";

type T = ReturnType<typeof convexTest<typeof schema>>;
type ToolResult = { isError?: boolean; content: { text: string }[] };
type Tool = (args: Record<string, unknown>) => Promise<ToolResult>;

let t: T;

function bridge(c: T) {
	return {
		query: (name: string, args: Record<string, unknown>) =>
			c.query(makeFunctionReference<"query">(name) as never, args as never),
		mutation: (name: string, args: Record<string, unknown>) =>
			c.mutation(
				makeFunctionReference<"mutation">(name) as never,
				args as never,
			),
	};
}

async function seedAgent(org: string, name: string, personalAgentOf?: string) {
	return await t.run((ctx) =>
		ctx.db.insert("agents", {
			orgSlug: org,
			clerkOrgId: testClerkOrgId(org),
			name,
			normalizedName: name,
			isActive: true,
			createdAt: Date.now(),
			...(personalAgentOf ? { personalAgentOf } : {}),
		}),
	);
}

// The person mint (server-http.ts /token) carries the org roster as fromAllowList.
async function mint(
	userId: string,
	org: string,
	roster: string[],
	raw: string,
): Promise<string> {
	await t.withIdentity({ subject: SERVICE_ACCOUNT_ID }).mutation(
		makeFunctionReference<"mutation">("oauth:createAccessToken") as never,
		{
			tokenHash: await sha256Hex(raw),
			clientId: "claude",
			userId,
			scopes: ["mcp:full"],
			scopeProfile: "team-member",
			fromAllowList: roster,
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() + 3_600_000,
			clerkOrgSlug: org,
			orgRole: "org:editor",
			principal: "person",
		} as never,
	);
	return raw;
}

async function contextOf(token: string): Promise<OAuthContext> {
	const probe = new Hono();
	probe.use("*", bearerAuthMiddleware());
	probe.get("/ctx", (c) => c.json(c.get("oauthContext")));
	const res = await probe.request("http://localhost:3000/ctx", {
		headers: { authorization: `Bearer ${token}` },
	});
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

function listedIds(result: ToolResult): string[] {
	const parsed = JSON.parse(result.content[0].text) as
		| { _id: string }[]
		| { items?: { _id: string }[]; tasks?: { _id: string }[] };
	const rows = Array.isArray(parsed)
		? parsed
		: (parsed.items ?? parsed.tasks ?? []);
	return rows.map((r) => r._id);
}

// The SDK applies zod defaults before a handler; this harness calls handlers
// directly, so the defaulted fields are spelled out.
const TASK = {
	title: "written by a person",
	assignedTo: "telemaque",
	priority: "high",
	status: "todo",
};
const MISSION = {
	name: "a person's mission",
	project: "p",
	status: "brainstorm",
	priority: "high",
	pilot: "telemaque",
	agents: ["telemaque"],
};

let stephane: Map<string, Tool>;
let bruno: Map<string, Tool>;

beforeEach(async () => {
	t = convexTest(schema, modules);
	_setInternalClientForTest(
		// biome-ignore lint/suspicious/noExplicitAny: test bridge
		bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })) as any,
	);
	const now = Date.now();
	await t.run(async (ctx) => {
		for (const [slug, roster] of [
			["org-a", ["telemaque"]],
			["org-b", ["mentor"]],
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
	});
	const tele = await seedAgent("org-a", "telemaque", STEPHANE);
	const mentor = await seedAgent("org-b", "mentor", BRUNO);
	await t.run(async (ctx) => {
		for (const [slug, id] of [
			["org-a", tele],
			["org-b", mentor],
		] as const) {
			const m = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", slug))
				.unique();
			if (m !== null) await ctx.db.patch(m._id, { allowedAgentIds: [id] });
		}
	});
	const sCtx = await contextOf(await mint(STEPHANE, "org-a", ["telemaque"], "raw-stephane"));
	expect(sCtx.actor?.agentName).toBe("telemaque");
	stephane = realTools(sCtx);
	const bCtx = await contextOf(await mint(BRUNO, "org-b", ["mentor"], "raw-bruno"));
	expect(bCtx.actor?.agentName).toBe("mentor");
	bruno = realTools(bCtx);
});

afterEach(() => {
	_setInternalClientForTest(null);
});

describe("create_task: a person reads back the task it created", () => {
	for (const [label, extra] of [
		["acting as its agent (createdBy=telemaque)", { createdBy: "telemaque" }],
		["without createdBy", {}],
	] as const) {
		it(`person reads back the task it created — ${label}`, async () => {
			const created = await call(stephane, "create_task", {
				...TASK,
				...extra,
			});
			expect(created.isError, created.content[0].text).toBeUndefined();
			const taskId = idFrom(created, "taskId");

			const got = await call(stephane, "get_task", { taskId });
			expect(got.isError, got.content[0].text).toBeUndefined();
			expect(idFrom(got, "_id")).toBe(taskId);

			const listed = await call(stephane, "list_tasks", {});
			expect(listed.isError, listed.content[0].text).toBeUndefined();
			expect(listedIds(listed)).toContain(taskId);

			const row = await t.run((ctx) =>
				ctx.db.get(taskId as never),
			) as { orgId?: string; clerkOrgId?: string } | null;
			expect(row?.orgId).toBe("org-a");
			expect(row?.clerkOrgId).toBe(testClerkOrgId("org-a"));
		});
	}

	it("DENY: a person of ANOTHER org does not see it", async () => {
		const created = await call(stephane, "create_task", {
			...TASK,
			createdBy: "telemaque",
		});
		expect(created.isError, created.content[0].text).toBeUndefined();
		const taskId = idFrom(created, "taskId");

		const got = await call(bruno, "get_task", { taskId });
		expect(got.isError).toBe(true);
		const listed = await call(bruno, "list_tasks", {});
		if (listed.isError !== true) expect(listedIds(listed)).not.toContain(taskId);
	});
});

describe("create_mission: a person reads back the mission it created", () => {
	it("person reads back the mission it created — acting as its agent (createdBy=telemaque)", async () => {
		const created = await call(stephane, "create_mission", {
			...MISSION,
			createdBy: "telemaque",
		});
		expect(created.isError, created.content[0].text).toBeUndefined();
		const missionId = idFrom(created, "missionId");

		const row = await t.run((ctx) => ctx.db.get(missionId as never)) as {
			orgId?: string;
			clerkOrgId?: string;
		} | null;
		expect(row?.orgId).toBe("org-a");
		expect(row?.clerkOrgId).toBe(testClerkOrgId("org-a"));

		const got = await call(stephane, "get_mission", { missionId });
		expect(got.isError, got.content[0].text).toBeUndefined();
		expect(idFrom(got, "_id")).toBe(missionId);

		const updated = await call(stephane, "update_mission", {
			missionId,
			progress: 40,
			callerOrchestrator: "telemaque",
		});
		expect(updated.isError, updated.content[0].text).toBeUndefined();
	});

	it("DENY: a person of ANOTHER org does not see it", async () => {
		const created = await call(stephane, "create_mission", {
			...MISSION,
			createdBy: "telemaque",
		});
		expect(created.isError, created.content[0].text).toBeUndefined();
		const missionId = idFrom(created, "missionId");
		const got = await call(bruno, "get_mission", { missionId });
		const text = got.content[0].text;
		expect(got.isError === true || text === "null").toBe(true);
	});
});
