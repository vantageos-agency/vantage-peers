/// <reference types="vite/client" />
/**
 * R-31 (backend-doctor) — renameAgent batches BOTH its reads and its writes.
 *
 * Before: the agent's `agent_relations` edges were read with an unbounded
 * `.collect()` per side and rewritten in the same transaction, so an agent with
 * a very large edge set loaded every row at once. After: one batch per side in
 * the public mutation, the remainder via `ctx.scheduler.runAfter(0, …)`.
 *
 * Poles (never one alone):
 *   RED/GREEN  more edges than one batch: the call alone does NOT rename them
 *              all (bounded), and after the continuations run every one is.
 *   NEGATIVE   another org's edges that name the same label are untouched, and
 *              so are this org's edges that name other agents.
 *   ABSENT     an agent with no edges renames cleanly and schedules nothing.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "../_generated/api";
import schema from "../schema";
import { agentIdOf } from "../../tests/lib/agentIdOf";

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

async function seedOrg(t: T, clerkOrgSlug: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators: ["existing-seat"],
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

// Strictly more than one batch per side at any plausible batch size (<= 200).
const PER_SIDE = 250;

async function seedEdges(t: T, orgSlug: string, name: string, n: number) {
	await t.run(async (ctx) => {
		for (let i = 0; i < n; i++) {
			await ctx.db.insert("agent_relations", {
				orgSlug,
				parentName: name,
				childName: `${orgSlug}-child-${i}`,
				createdAt: Date.now(),
			});
			await ctx.db.insert("agent_relations", {
				orgSlug,
				parentName: `${orgSlug}-parent-${i}`,
				childName: name,
				createdAt: Date.now(),
			});
		}
	});
}

const countNamed = (t: T, orgSlug: string, name: string) =>
	t.run(async (ctx) => {
		const rows = await ctx.db
			.query("agent_relations")
			.withIndex("by_org", (q) => q.eq("orgSlug", orgSlug))
			.collect();
		return rows.filter((r) => r.parentName === name || r.childName === name).length;
	});

describe("agents.renameAgent — bounded relation rewrite (R-31)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("more edges than one batch: one call is bounded, the continuations finish the rename", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const admin = t.withIdentity(adminOf("org-a"));
		await admin.mutation(api.agents.registerAgent, { orgSlug: "org-a", name: "ada" });
		await seedEdges(t, "org-a", "ada", PER_SIDE);
		// Another org holds edges naming the SAME label: must never move.
		await seedEdges(t, "org-b", "ada", 5);
		// Same org, other agent: must never move.
		await seedEdges(t, "org-a", "bob", 5);

		await admin.mutation(api.agents.renameAgent, {
			orgSlug: "org-a",
			agentId: await agentIdOf(admin, "org-a", "ada"),
			newName: "ada2",
		});

		// BOUNDED: the transaction of the public call did not rewrite every edge.
		const renamedAfterCall = await countNamed(t, "org-a", "ada2");
		expect(renamedAfterCall).toBeGreaterThan(0);
		expect(renamedAfterCall).toBeLessThan(2 * PER_SIDE);

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		// COMPLETE: every edge, both sides, carries the new label; none the old.
		expect(await countNamed(t, "org-a", "ada2")).toBe(2 * PER_SIDE);
		expect(await countNamed(t, "org-a", "ada")).toBe(0);
		// NEGATIVE: neighbours untouched.
		expect(await countNamed(t, "org-b", "ada")).toBe(10);
		expect(await countNamed(t, "org-b", "ada2")).toBe(0);
		expect(await countNamed(t, "org-a", "bob")).toBe(10);
	});

	test("ABSENT: an agent with no edges renames and nothing is left to run", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const admin = t.withIdentity(adminOf("org-a"));
		await admin.mutation(api.agents.registerAgent, { orgSlug: "org-a", name: "solo" });
		await admin.mutation(api.agents.renameAgent, {
			orgSlug: "org-a",
			agentId: await agentIdOf(admin, "org-a", "solo"),
			newName: "solo2",
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const agents = await admin.query(api.agents.listAgentsByOrg, { orgSlug: "org-a" });
		expect(agents.map((a) => a.name)).toEqual(["solo2"]);
		const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		expect(scheduled).toHaveLength(0);
	});
});
