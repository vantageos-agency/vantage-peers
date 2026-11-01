/// <reference types="vite/client" />
// allow-missing-refs: new test file created by the specialist
/**
 * The principal lookups handed `agents.orgSlug` to @vantageos/cloud-identity as the
 * agent's `orgId`. A slug is a renamable label another organisation can take
 * over, so after the takeover the new holder passed the PREVIOUS holder's agent
 * ID to a door that judges it with `requireAssigneeAgentActive` and the package
 * found "an active agent stamped with the org the credential names"
 * (task k178kcdj17bd0vmxce295aw19s8hdsq4; same class as the findAgentByName fix,
 * task k1768vtsgr0cg8jb6z5bkgnzts8hchbe).
 *
 * Modelling (as in findAgentByNameSlugTakeover.test.ts): no door renames a
 * `client_org_mapping.clerkOrgSlug`, so the release and the takeover are direct
 * database writes. Org A (clerkOrgId X) holds slug S and owns agent "nadia";
 * A's mapping is renamed (its agents rows keep orgSlug S); org B (clerkOrgId Y)
 * takes S.
 *
 * Doors:
 *   (i)  tasks:create assignedToAgentId   -> resolveAgentIdArg -> requireAssigneeAgentActive
 *   (ii) mandates:create fulfilledByAgentId (operator-slug variant: the fleet
 *        service account, whose assignee org is the operator org's slug)
 * Poles: REFUSE the new holder passing the old holder's agent ID; ALLOW the
 * old holder under its new slug and the new holder's own agents; LEGACY a row
 * with no clerkOrgId is refused, never matched by slug.
 */

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedFleetAgents } from "../../tests/lib/seedFleetAgents";
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
const createT = (): T =>
	convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;

const SLUG = "shared-slug";
const RENAMED = "renamed-a";
const ORG_A_ID = testClerkOrgId("org-a-permanent");
const ORG_B_ID = testClerkOrgId("org-b-permanent");

type World = { t: T; agentA: Id<"agents">; agentB: Id<"agents"> };

async function takeover(): Promise<World> {
	const t = createT();
	const ids = await t.run(async (ctx) => {
		const mappingA = await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: SLUG,
			clerkOrgId: ORG_A_ID,
			allowedOrchestrators: ["nadia"],
			scopes: ["view-own-tasks"],
			displayName: "A",
			isActive: true,
			createdAt: 1,
		});
		const agentA = await ctx.db.insert("agents", {
			orgSlug: SLUG,
			clerkOrgId: ORG_A_ID,
			name: "nadia",
			normalizedName: "nadia",
			isActive: true,
			createdAt: 1,
		});
		await ctx.db.patch(mappingA, { clerkOrgSlug: RENAMED });
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: SLUG,
			clerkOrgId: ORG_B_ID,
			// B's roster carries the labels as well: a label collision is how a
			// takeover reaches the identity layer past the roster.
			allowedOrchestrators: ["bruno", "nadia", "old"],
			scopes: ["view-own-tasks"],
			displayName: "B",
			isActive: true,
			createdAt: 2,
		});
		const agentB = await ctx.db.insert("agents", {
			orgSlug: SLUG,
			clerkOrgId: ORG_B_ID,
			name: "bruno",
			normalizedName: "bruno",
			isActive: true,
			createdAt: 2,
		});
		await ctx.db.insert("memberWriterRoles", { roles: ["org:admin", "org:member"], updatedAt: 1 });
		return { agentA, agentB };
	});
	return { t, ...ids };
}

const member = (w: World, slug: string, orgId: string, role = "org:admin") =>
	w.t.withIdentity({
		subject: `user_${role}_${slug}`,
		org_slug: slug,
		org_id: orgId,
		org_role: role,
	});

async function refusal(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "NO_ERROR";
	} catch (e) {
		return e instanceof ConvexError ? String(e.data) : String(e);
	}
}

const base = { title: "takeover", priority: "low" as const, status: "todo" as const };
const taskRows = (w: World) => w.t.run((ctx) => ctx.db.query("tasks").collect());

describe("(i) tasks:create assignedToAgentId -> requireAssigneeAgentActive", () => {
	test("REFUSE: the new holder of the slug passes the previous holder's agent ID", async () => {
		const w = await takeover();
		const out = await refusal(
			member(w, SLUG, ORG_B_ID).mutation(api.tasks.create, {
				...base,
				assignedToAgentId: w.agentA,
			} as never),
		);
		expect(out).toContain("ORG_MISMATCH");
		expect(await taskRows(w)).toHaveLength(0);
	});

	test("REFUSE: same, as an ordinary org member (not an admin)", async () => {
		const w = await takeover();
		const out = await refusal(
			member(w, SLUG, ORG_B_ID, "org:member").mutation(api.tasks.create, {
				...base,
				assignedToAgentId: w.agentA,
			} as never),
		);
		expect(out).toContain("ORG_MISMATCH");
		expect(await taskRows(w)).toHaveLength(0);
	});

	test("ALLOW: the new holder assigns its own agent by ID", async () => {
		const w = await takeover();
		await member(w, SLUG, ORG_B_ID).mutation(api.tasks.create, {
			...base,
			assignedToAgentId: w.agentB,
		} as never);
		const rows = await taskRows(w);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.assignedToId).toBe(w.agentB);
	});

	test("ALLOW: the previous holder, under its NEW slug, assigns its own agent by ID", async () => {
		const w = await takeover();
		await member(w, RENAMED, ORG_A_ID).mutation(api.tasks.create, {
			...base,
			assignedToAgentId: w.agentA,
		} as never);
		const rows = await taskRows(w);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.assignedToId).toBe(w.agentA);
	});

	test("LEGACY: an agent row with no clerkOrgId is refused, never matched by slug", async () => {
		const w = await takeover();
		const legacy = await w.t.run((ctx) =>
			ctx.db.insert("agents", {
				orgSlug: SLUG,
				name: "old",
				normalizedName: "old",
				isActive: true,
				createdAt: 1,
			}),
		);
		const out = await refusal(
			member(w, SLUG, ORG_B_ID).mutation(api.tasks.create, {
				...base,
				assignedToAgentId: legacy,
			} as never),
		);
		expect(out).not.toBe("NO_ERROR");
		expect(await taskRows(w)).toHaveLength(0);
	});
});

describe("(ii) mandates:create fulfilledByAgentId -> requireAssigneeAgentActive (operator slug)", () => {
	// The fleet's organisation holds the operator slug now; a former holder of
	// that slug (org A, ID X) still owns an agent stamped with it.
	async function operatorWorld() {
		const t = createT();
		const ids = await seedFleetAgents(t, ["sigma"]);
		const former = await t.run(async (ctx) => {
			const op = (await ctx.db.query("client_org_mapping").collect()).find(
				(m) => m.orgKind === "operator",
			);
			if (op === undefined) throw new Error("fixture: no operator org");
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: RENAMED,
				clerkOrgId: ORG_A_ID,
				allowedOrchestrators: [],
				scopes: [],
				displayName: "A",
				isActive: true,
				createdAt: 1,
			});
			return await ctx.db.insert("agents", {
				orgSlug: op.clerkOrgSlug, // the stamp from when A held the operator slug
				clerkOrgId: ORG_A_ID,
				name: "nadia",
				normalizedName: "nadia",
				isActive: true,
				createdAt: 1,
			});
		});
		return { t, sigma: ids.sigma as Id<"agents">, former };
	}
	const svc = (t: T) => t.withIdentity({ subject: "test-service-account-user-id" });
	const mandate = { requestedBy: "pi", service: "seo audit", budget: 10 };
	const mandateRows = (t: T) => t.run((ctx) => ctx.db.query("mandates").collect());

	test("REFUSE: a former holder of the operator slug is not a fulfiller", async () => {
		const w = await operatorWorld();
		const out = await refusal(
			svc(w.t).mutation(api.mandates.create, {
				...mandate,
				fulfilledByAgentId: w.former,
			} as never),
		);
		expect(out).toContain("ORG_MISMATCH");
		expect(await mandateRows(w.t)).toHaveLength(0);
	});

	test("ALLOW: an operator-org agent is a fulfiller", async () => {
		const w = await operatorWorld();
		await svc(w.t).mutation(api.mandates.create, {
			...mandate,
			fulfilledByAgentId: w.sigma,
		} as never);
		const rows = await mandateRows(w.t);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.fulfilledById).toBe(w.sigma);
	});
});
