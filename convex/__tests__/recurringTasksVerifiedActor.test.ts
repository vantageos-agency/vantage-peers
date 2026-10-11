/// <reference types="vite/client" />
/**
 * recurringTasks:create reached through the MCP (the fleet service account) learns
 * which agent a seat acts as from `verifiedActor` alone (M10h client side).
 *
 *   WITHOUT   a service-account call naming an org agent resolves its creator and
 *             assignee in the OPERATOR organisation and is refused: the regression
 *             the MCP forwarding closes.
 *   WITH      verifiedActor { agentId, orgSlug } of clio-A: the assignee resolves in
 *             org-a, createdById is clio-A's ID.
 *   OTHER ORG verifiedActor of clio-B naming org-a's vera is refused; the same name
 *             never resolves to the other org's agent.
 */

import { beforeEach, describe, expect, test } from "vitest";
import { agentIdOf } from "../../tests/lib/agentIdOf";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

type T = ReturnType<typeof convexTest>;

const adminOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:admin",
	} as Parameters<typeof t.withIdentity>[0]);

let t: T;
let svc: ReturnType<T["withIdentity"]>;
let clioA: Id<"agents">;
let veraA: Id<"agents">;
let clioB: Id<"agents">;

async function seedOrg(slug: string, roster: string[]) {
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
	await seedOrg("org-a", ["clio", "vera"]);
	await seedOrg("org-b", ["clio"]);
	for (const [org, name] of [
		["org-a", "clio"],
		["org-a", "vera"],
		["org-b", "clio"],
	] as const) {
		await adminOf(t, org).mutation(api.agents.registerAgent, {
			orgSlug: org,
			name,
		});
	}
	clioA = await agentIdOf(t, "org-a", "clio");
	veraA = await agentIdOf(t, "org-a", "vera");
	clioB = await agentIdOf(t, "org-b", "clio");
});

const args = {
	title: "standup",
	assignedTo: "vera",
	priority: "medium" as const,
	cronExpression: "0 9 * * *",
	createdBy: "clio",
};
const rowCount = () =>
	t.run(async (ctx) => (await ctx.db.query("recurringTasks").collect()).length);

describe("a seat reaching Convex as the service account", () => {
	test("WITHOUT verifiedActor the assignee is looked up in the operator org and refused", async () => {
		const err = await svc.mutation(api.recurringTasks.create, args).then(
			() => null,
			(e: Error) => e,
		);
		expect(err).not.toBeNull();
		expect(String((err as { data?: unknown }).data ?? err)).toContain(
			"assignee-not-an-agent-of-org",
		);
		expect(await rowCount()).toBe(0);
	});

	test("WITH verifiedActor the assignee resolves in the agent's org, the creator is its ID", async () => {
		const id = await svc.mutation(api.recurringTasks.create, {
			...args,
			verifiedActor: { agentId: clioA, orgSlug: "org-a" },
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.createdById).toBe(clioA);
		expect(row?.assignedToId).toBe(veraA);
	});

	test("a clio of ANOTHER org cannot assign to org-a's vera", async () => {
		const err = await svc
			.mutation(api.recurringTasks.create, {
				...args,
				verifiedActor: { agentId: clioB, orgSlug: "org-b" },
			})
			.then(
				() => null,
				(e: Error) => e,
			);
		expect(err).not.toBeNull();
		expect(String((err as { data?: unknown }).data ?? err)).toContain(
			"assignee-not-an-agent-of-org",
		);
		expect(await rowCount()).toBe(0);
	});

	test("a verifiedActor claiming org-a for org-b's clio is refused ORG_MISMATCH", async () => {
		const err = await svc
			.mutation(api.recurringTasks.create, {
				...args,
				verifiedActor: { agentId: clioB, orgSlug: "org-a" },
			})
			.then(
				() => null,
				(e: Error) => e,
			);
		expect(String((err as { data?: unknown }).data ?? err)).toContain(
			"ORG_MISMATCH",
		);
		expect(await rowCount()).toBe(0);
	});
});
