/// <reference types="vite/client" />
/**
 * recurringTasks:create reached through the fleet service account stamps the
 * schedule with the VERIFIED agent's organisation (M10h; Eta's note on #1517).
 *
 *   CLIENT AGENT    verifiedActor of a client org's agent -> the row carries that
 *                   org's slug and Clerk org ID, lists in that tenant only, and the
 *                   generated tasks stay in it.
 *   OPERATOR AGENT  verifiedActor of an operator-org agent -> the row stays
 *                   unstamped (a fleet schedule), exactly as before.
 *   NO AGENT        the service account naming no agent keeps writing fleet rows.
 */

import { beforeEach, describe, expect, test } from "vitest";
import { agentIdOf } from "../../tests/lib/agentIdOf";
import { listRegisteredAgentsOnRoster } from "../../tests/lib/rosterSync";
import { seedFleetAgents } from "../../tests/lib/seedFleetAgents";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const adminOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:admin",
	} as Parameters<typeof t.withIdentity>[0]);

let t: T;
let svc: ReturnType<T["withIdentity"]>;

async function seedClientOrg(slug: string, roster: string[]) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: roster,
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

beforeEach(async () => {
	t = convexTest(schema, modules);
	svc = t.withIdentity({ subject: "test-service-account-user-id" });
	await seedFleetAgents(t, ["sigma", "pi"]);
	await seedClientOrg("org-a", ["clio", "vera"]);
	await seedClientOrg("org-b", ["clio"]);
	for (const [org, name] of [
		["org-a", "clio"],
		["org-a", "vera"],
		["org-b", "clio"],
	] as const) {
		await adminOf(t, org).mutation(api.agents.registerAgent, { orgSlug: org, name });
	}
	// The registered agents are on their org's stored ID roster.
	await listRegisteredAgentsOnRoster(t, ["org-a", "org-b"]);
});

const base = {
	title: "standup",
	priority: "medium" as const,
	cronExpression: "0 9 * * *",
};

describe("the schedule carries the verified agent's organisation", () => {
	test("CLIENT AGENT: stamped with org-a's slug and Clerk org ID, listed in org-a only", async () => {
		const clioA = await agentIdOf(t, "org-a", "clio");
		const id = await svc.mutation(api.recurringTasks.create, {
			...base,
			assignedTo: "vera",
			createdBy: "clio",
			verifiedActor: { agentId: clioA, orgSlug: "org-a" },
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.orgId).toBe("org-a");
		expect(row?.clerkOrgId).toBe(testClerkOrgId("org-a"));
		const mine = await adminOf(t, "org-a").query(api.recurringTasks.list, {});
		expect(mine.map((r) => r._id)).toContain(id);
		const theirs = await adminOf(t, "org-b").query(api.recurringTasks.list, {});
		expect(theirs.map((r) => r._id)).not.toContain(id);
	});

	test("OPERATOR AGENT: the schedule stays unstamped (fleet)", async () => {
		const sigma = await t.run(async (ctx) => {
			const row = await ctx.db
				.query("agents")
				.filter((q) => q.eq(q.field("name"), "sigma"))
				.first();
			return { id: row?._id, org: row?.orgSlug };
		});
		const id = await svc.mutation(api.recurringTasks.create, {
			...base,
			assignedTo: "pi",
			createdBy: "sigma",
			verifiedActor: { agentId: sigma.id as never, orgSlug: sigma.org as string },
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.orgId).toBeUndefined();
		expect(row?.clerkOrgId).toBeUndefined();
	});

	test("NO AGENT: the service account keeps writing fleet (unstamped) schedules", async () => {
		const id = await svc.mutation(api.recurringTasks.create, {
			...base,
			assignedTo: "pi",
			createdBy: "sigma",
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.orgId).toBeUndefined();
	});
});
