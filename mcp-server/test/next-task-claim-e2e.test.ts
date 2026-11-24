/**
 * next_task end to end through the real tool handler into the real Convex door
 * tasks:nextForAssignee (convex-test, as the fleet service account, the way MCP
 * reaches Convex) -- task k178q6x954qeh4mxh0b4x6sss98jtarn, VantagePeers Cloud + Self-host.
 *
 *   D1  a master-scope caller is served: the assignee's next task, or an explicit
 *       found:false, never RBAC_DENIED claimless-service-account;
 *   D2  a scoped (non-master) seat is served for an assignee of its OWN organisation
 *       and refused for another organisation's assignee: what the MCP sends never
 *       widens a scoped seat to the master's reach;
 *   a master with no agent ID is still refused by the door (nothing true to claim).
 */

import type { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { beforeEach, describe, expect, it } from "vitest";
import schema from "../../convex/schema.js";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { agentIdOf, seedAgents } from "../../tests/lib/agentIdOf.js";
import {
	insertTaskRow,
	seedFleetAgents,
} from "../../tests/lib/seedFleetAgents.js";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

const modules = Object.fromEntries(
	Object.entries(
		import.meta.glob<Record<string, unknown>>("../../convex/**/*.ts"),
	).filter(([path]) => !path.includes("ragSync") && !path.includes("backfill")),
);

type T = ReturnType<typeof convexTest>;
type Handler = (args: Record<string, unknown>) => Promise<{
	isError?: boolean;
	content: Array<{ text: string }>;
}>;

function resolveRef(dotted: string) {
	const [mod, fn] = dotted.split(":");
	return (anyApi as Record<string, Record<string, unknown>>)[mod][fn];
}
function bridge(t: T): ConvexHttpClient {
	return {
		query: (name: string, args: unknown) =>
			t.query(resolveRef(name) as never, args as never),
		mutation: (name: string, args: unknown) =>
			t.mutation(resolveRef(name) as never, args as never),
		action: (name: string, args: unknown) =>
			t.action(resolveRef(name) as never, args as never),
	} as unknown as ConvexHttpClient;
}
function nextTaskHandler(t: T, ctx: OAuthContext): Handler {
	const handlers = new Map<string, Handler>();
	const reg = (...a: unknown[]) => {
		handlers.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	registerTools({ tool: reg, registerTool: reg } as never, bridge(t), ctx);
	return handlers.get("next_task") as Handler;
}

const FUTURE = Date.now() + 3_600_000;
const baseCtx: OAuthContext = {
	clientId: "c",
	userId: "u",
	scopes: ["mcp:full"],
	scopeProfile: "tenant",
	fromAllowList: ["eta"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: FUTURE,
	isMaster: false,
	accessTokenHash: "hash-e2e",
};

let t: T;
let FLEET_ETA: string;
let A_ETA: string;
let B_ETA: string;
let FLEET_SLUG: string;

async function seedTodo(
	orgId: string | undefined,
	assignedToId: string,
	title: string,
) {
	await t.run(async (ctx) => {
		const now = Date.now();
		await insertTaskRow(ctx, {
			title,
			assignedTo: "eta",
			assignedToId: assignedToId as never,
			createdBy: "eta",
			priority: "low",
			status: "todo",
			...(orgId !== undefined
				? { orgId, clerkOrgId: testClerkOrgId(orgId) }
				: {}),
			createdAt: now,
			updatedAt: now,
		});
	});
}

beforeEach(async () => {
	t = convexTest(schema as never, modules as never).withIdentity({
		subject: "test-service-account-user-id",
	} as never);
	await t.run(async (ctx) => {
		await ctx.db.insert("taskClosureConfig", {
			key: "billableProjects",
			value: [],
			updatedAt: Date.now(),
		});
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: ["eta"],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
	const fleet = await seedFleetAgents(t, ["eta"]);
	await seedAgents(t as never, [
		["org-a", "eta"],
		["org-b", "eta"],
	]);
	FLEET_ETA = String(fleet.eta);
	A_ETA = String(await agentIdOf(t as never, "org-a", "eta"));
	B_ETA = String(await agentIdOf(t as never, "org-b", "eta"));
	FLEET_SLUG = await t.run(async (ctx) => {
		const m = (await ctx.db.query("client_org_mapping").collect()).find(
			(x) => x.orgKind === "operator",
		);
		return m?.clerkOrgSlug as string;
	});
	// The fixture's operator mapping grants no scope; a real operator org grants the read scope list_tasks needs.
	await t.run(async (ctx) => {
		const m = (await ctx.db.query("client_org_mapping").collect()).find(
			(x) => x.orgKind === "operator",
		);
		if (m) await ctx.db.patch(m._id, { scopes: ["view-own-tasks"] });
	});
	await seedTodo(undefined, FLEET_ETA, "fleet task");
	await seedTodo("org-a", A_ETA, "org-a task");
	await seedTodo("org-b", B_ETA, "org-b task");
});

const masterAgent = (): OAuthContext => ({
	...baseCtx,
	scopeProfile: "master",
	isMaster: true,
	actor: { orgSlug: FLEET_SLUG, agentName: "eta", agentId: FLEET_ETA },
});
const seat = (org: string, agentId: string): OAuthContext => ({
	...baseCtx,
	clerkOrgSlug: org,
	orgClerkId: testClerkOrgId(org),
	seatAgent: { agentId, orgId: org, agentName: "eta" },
});
const titleOf = (r: { content: Array<{ text: string }> }) => {
	// A refusal is an error text, not JSON: it carries no task.
	if (!r.content[0].text.startsWith("{")) return null;
	const body = JSON.parse(r.content[0].text) as {
		found: boolean;
		task?: { title: string };
	};
	return body.found ? body.task?.title : null;
};

describe("D1: a master-scope caller is served by next_task", () => {
	it("master bearer with a verified agent ID gets the assignee's next task", async () => {
		const r = await nextTaskHandler(
			t,
			masterAgent(),
		)({ assignedToAgentId: FLEET_ETA });
		expect(r.isError, r.content[0].text).not.toBe(true);
		expect(titleOf(r)).toBe("fleet task");
	});
	it("master bearer with a verified agent ID gets an explicit found:false for an empty queue", async () => {
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query("tasks").collect())
				await ctx.db.delete(row._id);
		});
		const r = await nextTaskHandler(
			t,
			masterAgent(),
		)({ assignedToAgentId: FLEET_ETA });
		expect(r.isError, r.content[0].text).not.toBe(true);
		expect(JSON.parse(r.content[0].text)).toMatchObject({ found: false });
	});
	it("master-profile operator seat is served, as list_tasks serves it", async () => {
		const ctx: OAuthContext = {
			...seat(FLEET_SLUG, FLEET_ETA),
			scopeProfile: "master",
		};
		const r = await nextTaskHandler(t, ctx)({ assignedToAgentId: FLEET_ETA });
		expect(r.isError, r.content[0].text).not.toBe(true);
		expect(r.content[0].text).not.toMatch(/claimless-service-account/);
	});
	it("master bearer with NO agent ID is still refused by the door (no claim to send)", async () => {
		const ctx: OAuthContext = { ...masterAgent(), actor: undefined };
		const r = await nextTaskHandler(t, ctx)({ assignedToAgentId: FLEET_ETA });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/claimless-service-account/);
	});
});

describe("D2: a scoped seat is not widened to the master's reach", () => {
	it("ALLOW: an org-a seat is served for an assignee of org-a", async () => {
		const r = await nextTaskHandler(
			t,
			seat("org-a", A_ETA),
		)({ assignedToAgentId: A_ETA });
		expect(r.isError, r.content[0].text).not.toBe(true);
		expect(titleOf(r)).toBe("org-a task");
	});
	it("REFUSE: the same org-a seat does not get org-b's assignee or its task", async () => {
		const r = await nextTaskHandler(
			t,
			seat("org-a", A_ETA),
		)({ assignedToAgentId: B_ETA });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(
			/RBAC_DENIED.*assignee-not-an-agent-of-org/,
		);
		expect(titleOf(r)).not.toBe("org-b task");
	});
	it("REFUSE: the org-a seat does not get the fleet operator's assignee or its task", async () => {
		const r = await nextTaskHandler(
			t,
			seat("org-a", A_ETA),
		)({ assignedToAgentId: FLEET_ETA });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/RBAC_DENIED/);
		expect(titleOf(r)).not.toBe("fleet task");
	});
	it("the org-a seat sends no actor: the master claim is not forwarded to a scoped seat", async () => {
		const r = await nextTaskHandler(
			t,
			seat("org-a", A_ETA),
		)({ assignedToAgentId: A_ETA });
		expect(r.content[0].text).not.toMatch(/verified-actor|not-operator/);
	});
});
