/// <reference types="vite/client" />
/**
 * [P-T3] convex/agentRelations.ts — the parent-child EDGE on top of P-T2's
 * `agents` entity. Task le-cap.md @ e3c1ffd6 §6 VP.2 (edge half): the layer
 * does not know that one agent is another's child, nor that a child can be
 * shared by two parents. This table/functions ARE that graph.
 *
 * THE PROPERTY (both poles, per VERIFICATION 4 — one assertion is half a
 * spec):
 *   ALLOW — org:admin of org A links parent1→child and parent2→child;
 *   parentsOf(child) returns BOTH (shared-child proven by two rows);
 *   graphByOrg(A) returns 3 nodes + 2 edges.
 *   DENY (direction 1) — a non-admin identity of org A is refused linkChild.
 *   DENY (direction 2) — an identity of org B does NOT see org A's edges via
 *   graphByOrg/childrenOf/parentsOf — RBAC_DENIED, not silently emptied.
 *
 * MASTER note: a master-authed call is the BYPASS, not proof — there is no
 * master carve-out on these mutations/queries; requireOrgAdmin demands a real
 * org:admin identity of an active mapped org every time.
 *
 * DELETION PROBE (documented, not committed as a code change): removing the
 * `requireOrgAdmin(ctx, args.orgSlug)` line from `linkChild`'s handler makes
 * the "POLE DENY: non-admin member of A is refused linkChild" test below go
 * RED (mutation succeeds instead of throwing RBAC_DENIED) — proving the DENY
 * test measures the authorization code, not something else. Ratio recorded
 * in the dispatching brief's RETURN section, run manually via a single-line
 * removal + `npm test` from the worktree root, then restored.
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

async function seedOrgMapping(
	t: ReturnType<typeof createT>,
	clerkOrgSlug: string,
	allowedOrchestrators: string[] = ["existing-seat"],
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators,
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

// Identities named per measurement — none is master, none is the row's
// creator where that matters.
const orgAdminIdentity = (org: string) => ({
	subject: `admin-of-${org}`,
	org_slug: org,
	org_role: "org:admin",
});

const orgMemberIdentity = (org: string) => ({
	subject: `member-of-${org}`,
	org_slug: org,
	org_role: "org:member",
});

describe("[P-T3] agent_relations — the parent-child edge graph", () => {
	test("POLE ALLOW: org:admin of A links two parents to one shared child — parentsOf returns both, graphByOrg returns 3 nodes + 2 edges", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		const tAdminA = t.withIdentity(
			orgAdminIdentity("org-a") as Parameters<typeof t.withIdentity>[0],
		);

		await tAdminA.mutation(api.agentRelations.linkChild, {
			orgSlug: "org-a",
			parentName: "parent1",
			childName: "child",
		});
		await tAdminA.mutation(api.agentRelations.linkChild, {
			orgSlug: "org-a",
			parentName: "parent2",
			childName: "child",
		});

		const parents = await tAdminA.query(api.agentRelations.parentsOf, {
			orgSlug: "org-a",
			childName: "child",
		});
		expect(parents).toHaveLength(2);
		expect(parents.map((p) => p.parentName).sort()).toEqual([
			"parent1",
			"parent2",
		]);

		const children = await tAdminA.query(api.agentRelations.childrenOf, {
			orgSlug: "org-a",
			parentName: "parent1",
		});
		expect(children).toHaveLength(1);
		expect(children[0].childName).toBe("child");

		const graph = await tAdminA.query(api.agentRelations.graphByOrg, {
			orgSlug: "org-a",
		});
		expect(graph.nodes).toHaveLength(3);
		expect(graph.nodes.map((n) => n.name).sort()).toEqual([
			"child",
			"parent1",
			"parent2",
		]);
		expect(graph.edges).toHaveLength(2);
	});

	test("linkChild is idempotent on (orgSlug, parentName, childName) — a second identical call does not duplicate the row", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		const tAdminA = t.withIdentity(
			orgAdminIdentity("org-a") as Parameters<typeof t.withIdentity>[0],
		);

		await tAdminA.mutation(api.agentRelations.linkChild, {
			orgSlug: "org-a",
			parentName: "parent1",
			childName: "child",
		});
		await tAdminA.mutation(api.agentRelations.linkChild, {
			orgSlug: "org-a",
			parentName: "parent1",
			childName: "child",
		});

		const children = await tAdminA.query(api.agentRelations.childrenOf, {
			orgSlug: "org-a",
			parentName: "parent1",
		});
		expect(children).toHaveLength(1);
	});

	test("unlinkChild removes the edge; is a no-op when the edge does not exist", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		const tAdminA = t.withIdentity(
			orgAdminIdentity("org-a") as Parameters<typeof t.withIdentity>[0],
		);

		await tAdminA.mutation(api.agentRelations.linkChild, {
			orgSlug: "org-a",
			parentName: "parent1",
			childName: "child",
		});
		await tAdminA.mutation(api.agentRelations.unlinkChild, {
			orgSlug: "org-a",
			parentName: "parent1",
			childName: "child",
		});

		const children = await tAdminA.query(api.agentRelations.childrenOf, {
			orgSlug: "org-a",
			parentName: "parent1",
		});
		expect(children).toHaveLength(0);

		// No-op deletion on an already-absent edge does not throw.
		await expect(
			tAdminA.mutation(api.agentRelations.unlinkChild, {
				orgSlug: "org-a",
				parentName: "parent1",
				childName: "child",
			}),
		).resolves.toBeNull();
	});

	test("POLE DENY (direction 1): non-admin member of A is refused linkChild (RBAC_DENIED)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		const tMemberA = t.withIdentity(
			orgMemberIdentity("org-a") as Parameters<typeof t.withIdentity>[0],
		);

		await expect(
			tMemberA.mutation(api.agentRelations.linkChild, {
				orgSlug: "org-a",
				parentName: "parent1",
				childName: "sneaky-child",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		// Org A's graph must remain untouched by the refused attempt.
		const rows = await t.run(async (ctx) => {
			return await ctx.db
				.query("agent_relations")
				.withIndex("by_org", (q) => q.eq("orgSlug", "org-a"))
				.collect();
		});
		expect(rows).toHaveLength(0);
	});

	test("POLE DENY (direction 2): identity of org B does not see org A's edges via graphByOrg/childrenOf/parentsOf", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");

		const tAdminA = t.withIdentity(
			orgAdminIdentity("org-a") as Parameters<typeof t.withIdentity>[0],
		);
		await tAdminA.mutation(api.agentRelations.linkChild, {
			orgSlug: "org-a",
			parentName: "parent-a",
			childName: "child-a",
		});

		const tAdminB = t.withIdentity(
			orgAdminIdentity("org-b") as Parameters<typeof t.withIdentity>[0],
		);

		// Positive control first: prove the instrument can tell present from
		// absent — B legitimately sees ITS OWN (empty) graph, not a swallowed
		// grant of A's graph.
		const graphForB = await tAdminB.query(api.agentRelations.graphByOrg, {
			orgSlug: "org-b",
		});
		expect(graphForB.nodes).toHaveLength(0);
		expect(graphForB.edges).toHaveLength(0);

		// B attempting to read A's graph by passing A's slug is refused, not
		// silently emptied — the scoping wrapper binds orgSlug to the caller's
		// OWN identity, a caller-supplied arg never substitutes for it.
		await expect(
			tAdminB.query(api.agentRelations.graphByOrg, { orgSlug: "org-a" }),
		).rejects.toThrow(/RBAC_DENIED/);

		await expect(
			tAdminB.query(api.agentRelations.childrenOf, {
				orgSlug: "org-a",
				parentName: "parent-a",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		await expect(
			tAdminB.query(api.agentRelations.parentsOf, {
				orgSlug: "org-a",
				childName: "child-a",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("POLE DENY: no identity at all is refused linkChild", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await expect(
			t.mutation(api.agentRelations.linkChild, {
				orgSlug: "org-a",
				parentName: "parent1",
				childName: "child",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("MASTER note (bypass, not proof): there is no master carve-out on linkChild — an unmapped org is refused even with no client_org_mapping row", async () => {
		const t = createT();
		await expect(
			t.mutation(api.agentRelations.linkChild, {
				orgSlug: "org-master-bypass",
				parentName: "parent1",
				childName: "child",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});
