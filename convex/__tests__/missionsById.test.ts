/// <reference types="vite/client" />
// allow-missing-refs: new file
/**
 * MISSIONS DECIDE ON AGENT IDs, NEVER ON NAMES (module M10e).
 *
 * A mission's pilot, participants and creator are agents-row IDs of the
 * mission's own organisation (`pilotId`, `agentIds`, `createdById`). Two
 * organisations that both employ an orchestrator labelled "eta" employ two
 * different agents; a label that names no agent of the caller's org names
 * nobody. Every pole runs under an ORDINARY org-scoped identity (never master,
 * never the service account) except the one master read, which goes through the
 * internal webhook query.
 *
 * POLES
 *   PERMISSION  - an agent of the caller's own roster, by ID, is served; after a
 *                 RENAME the stale label of the row names nobody and the new
 *                 label of the same agent still reaches it.
 *   DENIED      - a same-NAME pilot of another org (no agent of this org) is
 *                 refused on create, update (pilot / participants); a different
 *                 agent that merely carries the creator's label cannot cancel;
 *                 another org never reads the row.
 *   ABSENT      - a pilot label that names no agent is an empty success on a
 *                 read; an org with no missions reads [].
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const ORG_A = "org-a";
const ORG_B = "org-b";
const OPERATOR = "fleet-op";

type World = {
	etaA: Id<"agents">;
	piA: Id<"agents">;
	zetaA: Id<"agents">;
	etaB: Id<"agents">;
	etaOp: Id<"agents">;
};

/**
 * Org A: agents eta, pi, zeta; the ID roster lists eta and pi (NOT zeta) while
 * the legacy NAME roster lists all three. Org B: agent eta only, name roster
 * eta + pi (B has no agent "pi"; A does). Operator org: its own agent eta.
 */
async function seedWorld(t: T): Promise<World> {
	return await t.run(async (ctx) => {
		const agent = (orgSlug: string, name: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId: testClerkOrgId(orgSlug),
				name,
				normalizedName: name,
				isActive: true,
				createdAt: Date.now(),
			});
		const etaA = await agent(ORG_A, "eta");
		const piA = await agent(ORG_A, "pi");
		const zetaA = await agent(ORG_A, "zeta");
		const etaB = await agent(ORG_B, "eta");
		const etaOp = await agent(OPERATOR, "eta");
		const mapping = (
			slug: string,
			names: string[],
			ids: Id<"agents">[],
			orgKind?: "operator",
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: names,
				allowedAgentIds: ids,
				scopes: ["view-own-missions", "view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
				...(orgKind ? { orgKind } : {}),
			});
		await mapping(ORG_A, ["eta", "pi", "zeta"], [etaA, piA]);
		await mapping(ORG_B, ["eta", "pi"], [etaB]);
		await mapping(OPERATOR, [], [etaOp], "operator");
		return { etaA, piA, zetaA, etaB, etaOp };
	});
}

function asOrg(t: T, slug: string) {
	return t.withIdentity({
		subject: `user-${slug}`,
		organizationId: slug,
		org_id: testClerkOrgId(slug),
	} as Parameters<T["withIdentity"]>[0]);
}

const base = {
	project: "p",
	status: "execute" as const,
	priority: "high" as const,
};

async function createAs(
	t: T,
	slug: string,
	over: { name?: string; pilot: string; createdBy: string; agents?: string[] },
) {
	return await asOrg(t, slug).mutation(api.missions.create, {
		...base,
		name: over.name ?? "m",
		pilot: over.pilot,
		agents: over.agents ?? [over.pilot],
		createdBy: over.createdBy,
	});
}

describe("PERMISSION poles - the roster is read by agent ID", () => {
	test("a member creates with agents of its own roster: the IDs are stored", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const id = await createAs(t, ORG_A, {
			pilot: "eta",
			createdBy: "pi",
			agents: ["eta", "pi"],
		});
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.pilotId).toBe(w.etaA);
		expect(row?.createdById).toBe(w.piA);
		expect(row?.agentIds).toEqual([w.etaA, w.piA]);
	});

	test("after a RENAME the stale label names nobody and the agent is still served by ID", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const id = await createAs(t, ORG_A, { pilot: "eta", createdBy: "eta" });
		await t.run(async (ctx) => {
			await ctx.db.patch(w.etaA, {
				name: "eta-renamed",
				normalizedName: "eta-renamed",
			});
			const mapping = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", ORG_A))
				.unique();
			if (mapping)
				await ctx.db.patch(mapping._id, {
					allowedOrchestrators: ["eta-renamed", "pi", "zeta"],
				});
		});
		const a = asOrg(t, ORG_A);
		expect((await a.query(api.missions.get, { missionId: id }))?._id).toBe(id);
		expect(await a.query(api.missions.list, {})).toHaveLength(1);
		expect(await a.query(api.missions.list, { pilot: "eta-renamed" })).toHaveLength(1);
		// the old label names no agent of org A any more: an absence
		expect(await a.query(api.missions.list, { pilot: "eta" })).toEqual([]);
	});

	test("the creator, renamed, still cancels its mission (cancel decides on createdById)", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const id = await createAs(t, ORG_A, { pilot: "eta", createdBy: "eta" });
		await t.run(async (ctx) => {
			await ctx.db.patch(w.etaA, {
				name: "eta-renamed",
				normalizedName: "eta-renamed",
			});
		});
		await asOrg(t, ORG_A).mutation(api.missions.update, {
			missionId: id,
			status: "cancelled",
			cancelReason: "scope dropped",
			callerOrchestrator: "eta-renamed",
		});
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.status).toBe("cancelled");
		expect(row?.cancelledById).toBe(w.etaA);
	});
});

describe("DENIED poles - a same-NAME pilot of another org is nobody here", () => {
	test("create: org B names pilot 'pi' (an agent of org A only) -> refused, nothing written", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			createAs(t, ORG_B, { pilot: "pi", createdBy: "eta" }),
		).rejects.toThrow(/RBAC_DENIED/);
		const rows = await t.run(async (ctx) => ctx.db.query("missions").collect());
		expect(rows).toHaveLength(0);
	});

	test("create: org B lists 'pi' as a participant (an agent of org A only) -> refused", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			createAs(t, ORG_B, { pilot: "eta", createdBy: "eta", agents: ["eta", "pi"] }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("create: an agent of the org but NOT on its ID roster cannot be the pilot", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			createAs(t, ORG_A, { pilot: "zeta", createdBy: "eta" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("update: reassigning the pilot to a label only another org holds -> refused, pilot unchanged", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const id = await createAs(t, ORG_B, { pilot: "eta", createdBy: "eta" });
		await expect(
			asOrg(t, ORG_B).mutation(api.missions.update, {
				missionId: id,
				pilot: "pi",
				callerOrchestrator: "eta",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.pilot).toBe("eta");
		expect(row?.pilotId).toBe(w.etaB);
	});

	test("cancel: a DIFFERENT agent that now carries the creator's label cannot cancel", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const id = await createAs(t, ORG_A, { pilot: "eta", createdBy: "eta" });
		await t.run(async (ctx) => {
			await ctx.db.patch(w.etaA, {
				name: "eta-renamed",
				normalizedName: "eta-renamed",
			});
			const impostor = await ctx.db.insert("agents", {
				orgSlug: ORG_A,
				clerkOrgId: testClerkOrgId(ORG_A),
				name: "eta",
				normalizedName: "eta",
				isActive: true,
				createdAt: Date.now(),
			});
			const mapping = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", ORG_A))
				.unique();
			if (mapping)
				await ctx.db.patch(mapping._id, {
					allowedAgentIds: [w.etaA, w.piA, impostor],
				});
		});
		await expect(
			asOrg(t, ORG_A).mutation(api.missions.update, {
				missionId: id,
				status: "cancelled",
				cancelReason: "not mine",
				callerOrchestrator: "eta",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.status).toBe("execute");
	});

	test("read: org B never reads org A's mission (get, list, list by the shared label)", async () => {
		const t = createT();
		await seedWorld(t);
		const id = await createAs(t, ORG_A, { pilot: "eta", createdBy: "eta" });
		const b = asOrg(t, ORG_B);
		expect(await b.query(api.missions.get, { missionId: id })).toBeNull();
		expect(await b.query(api.missions.list, {})).toEqual([]);
		expect(await b.query(api.missions.list, { pilot: "eta" })).toEqual([]);
	});

	test("read: a pilot filter by label never crosses orgs through the fleet master read", async () => {
		const t = createT();
		await seedWorld(t);
		const own = await createAs(t, ORG_B, { pilot: "eta", createdBy: "eta" });
		const seen = (await t.query(internal.missions.listForWebhook, {
			pilot: "eta",
		})) as { _id: string }[];
		// "eta" names the OPERATOR org's agent for the master read, not org B's.
		expect(seen.map((m) => m._id)).not.toContain(own);
	});
});

describe("ABSENT poles - an absence stays an empty success", () => {
	test("a pilot label that names no agent of the org reads []", async () => {
		const t = createT();
		await seedWorld(t);
		await createAs(t, ORG_B, { pilot: "eta", createdBy: "eta" });
		const b = asOrg(t, ORG_B);
		expect(await b.query(api.missions.list, { pilot: "pi" })).toEqual([]);
		expect(await b.query(api.missions.list, { pilot: "nobody" })).toEqual([]);
	});

	test("an org with no missions reads [] (never a refusal)", async () => {
		const t = createT();
		await seedWorld(t);
		expect(await asOrg(t, ORG_A).query(api.missions.list, {})).toEqual([]);
	});

	test("the own org still lists its own missions by pilot label", async () => {
		const t = createT();
		await seedWorld(t);
		const id = await createAs(t, ORG_B, { pilot: "eta", createdBy: "eta" });
		const rows = await asOrg(t, ORG_B).query(api.missions.list, { pilot: "eta" });
		expect(rows.map((m) => m._id)).toEqual([id]);
	});
});
