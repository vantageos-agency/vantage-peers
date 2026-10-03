/// <reference types="vite/client" />
/**
 * backend-doctor R-6 (task k17ef2apnjp0gh8w4zzgzyw3ed8ffpj9): a write takes its
 * org / acting-identity boundary from a VERIFIED principal, never from a caller
 * argument.
 *
 * Two families, each pinned at both poles under an ORDINARY (non-master)
 * identity. A proof obtained under master exercises the bypass and proves
 * nothing.
 *
 *  A. The `requireOrgAdmin(ctx, args.orgSlug)` doors. The org slug IS an
 *     argument, but `requireOrgAdmin` refuses unless it equals the verified
 *     org claim, so the write is bound. The doctor does not recognise that
 *     guard, so these are pinned here: an admin of org A naming org B is
 *     refused and B is untouched; the same admin on its own org is served.
 *     (linkChild/unlinkChild: agentRelations.test.ts; deactivateAgent,
 *     reactivateAgent, revokeAgentCredential: agentRetireSurface.test.ts
 *     POLE 5.)
 *
 *  B. `recurringTasks.create` wrote `createdBy: args.createdBy` with the roster
 *     bind switched off (`requireAuthenticatedCaller(ctx, undefined, ...)`), so
 *     a member of org A could author a schedule as another tenant's
 *     orchestrator, and every task the schedule later spawns inherits that
 *     author. `tasks.create` binds the same field; the schedule now does too.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const adminOf = (org: string) =>
	({ subject: `admin-of-${org}`, org_slug: org, org_role: "org:admin" }) as Identity;
const memberOf = (org: string) =>
	({ subject: `member-of-${org}`, organizationId: org, org_slug: org }) as Identity;

async function seedOrg(t: T, clerkOrgSlug: string, roster: string[]) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators: roster,
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function twoOrgs() {
	const t = createT();
	await seedOrg(t, "org-a", ["alice"]);
	await seedOrg(t, "org-b", ["bob"]);
	const adminA = t.withIdentity(adminOf("org-a"));
	const adminB = t.withIdentity(adminOf("org-b"));
	await adminB.mutation(api.agents.registerAgent, { orgSlug: "org-b", name: "bob" });
	return { t, adminA, adminB };
}

const agentsOf = (t: T, org: string) =>
	t.run((ctx) =>
		ctx.db
			.query("agents")
			.withIndex("by_org", (q) => q.eq("orgSlug", org))
			.collect(),
	);

describe("A. requireOrgAdmin doors: a write names an org only if the verified claim equals it", () => {
	test("registerAgent: admin of A naming org B is refused and B gains no agent; own org is served", async () => {
		const { t, adminA } = await twoOrgs();
		await expect(
			adminA.mutation(api.agents.registerAgent, { orgSlug: "org-b", name: "intruder" }),
		).rejects.toThrow(/RBAC_DENIED/);
		expect((await agentsOf(t, "org-b")).map((a) => a.name)).toEqual(["bob"]);

		await adminA.mutation(api.agents.registerAgent, { orgSlug: "org-a", name: "alice" });
		expect((await agentsOf(t, "org-a")).map((a) => a.name)).toEqual(["alice"]);
	});

	test("setAgentAddress: admin of A cannot rewrite B's agent address; own org is served", async () => {
		const { t, adminA } = await twoOrgs();
		await expect(
			adminA.mutation(api.agents.setAgentAddress, {
				orgSlug: "org-b",
				name: "bob",
				address: "https://evil.example/hook",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect((await agentsOf(t, "org-b"))[0].address).toBeUndefined();

		await adminA.mutation(api.agents.registerAgent, { orgSlug: "org-a", name: "alice" });
		await adminA.mutation(api.agents.setAgentAddress, {
			orgSlug: "org-a",
			name: "alice",
			address: "https://a.example/hook",
		});
		expect((await agentsOf(t, "org-a"))[0].address).toBe("https://a.example/hook");
	});

	test("renameAgent: admin of A cannot rename B's agent; own org is served", async () => {
		const { t, adminA } = await twoOrgs();
		await expect(
			adminA.mutation(api.agents.renameAgent, {
				orgSlug: "org-b",
				name: "bob",
				newName: "mallory",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect((await agentsOf(t, "org-b")).map((a) => a.name)).toEqual(["bob"]);

		await adminA.mutation(api.agents.registerAgent, { orgSlug: "org-a", name: "alice" });
		await adminA.mutation(api.agents.renameAgent, {
			orgSlug: "org-a",
			name: "alice",
			newName: "alicia",
		});
		expect((await agentsOf(t, "org-a")).map((a) => a.name)).toEqual(["alicia"]);
	});

	test("mintAgentCredential: admin of A cannot mint a credential for B's agent; own org is served", async () => {
		const { t, adminA } = await twoOrgs();
		await expect(
			adminA.mutation(api.agentCredentials.mintAgentCredential, {
				orgSlug: "org-b",
				agentName: "bob",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await t.run((ctx) => ctx.db.query("agent_credentials").collect())).toHaveLength(0);

		await adminA.mutation(api.agents.registerAgent, { orgSlug: "org-a", name: "alice" });
		const minted = await adminA.mutation(api.agentCredentials.mintAgentCredential, {
			orgSlug: "org-a",
			agentName: "alice",
		});
		expect(minted.secret).toMatch(/^[0-9a-f]{64}$/);
		const rows = await t.run((ctx) => ctx.db.query("agent_credentials").collect());
		expect(rows.map((r) => r.orgSlug)).toEqual(["org-a"]);
	});
});

describe("B. recurringTasks.create: createdBy is bound to the caller's roster", () => {
	const args = (createdBy: string) => ({
		title: "r6 schedule",
		assignedTo: "alice",
		priority: "medium" as const,
		cronExpression: "0 9 * * *",
		createdBy,
	});

	test("DENY: a member of org A authoring the schedule as org B's orchestrator is refused and nothing is written", async () => {
		const { t } = await twoOrgs();
		const memberA = t.withIdentity(memberOf("org-a"));
		await expect(
			memberA.mutation(api.recurringTasks.create, args("bob")),
		).rejects.toThrow(/CALLER_IDENTITY_MISMATCH/);
		expect(await t.run((ctx) => ctx.db.query("recurringTasks").collect())).toHaveLength(0);
	});

	test("ALLOW: the same member authoring as its own orchestrator is served, stamped with its own org", async () => {
		const { t } = await twoOrgs();
		const memberA = t.withIdentity(memberOf("org-a"));
		await memberA.mutation(api.recurringTasks.create, args("alice"));
		const rows = await t.run((ctx) => ctx.db.query("recurringTasks").collect());
		expect(rows).toHaveLength(1);
		expect(rows[0].createdBy).toBe("alice");
		expect(rows[0].orgId).toBe("org-a");
	});
});
