/// <reference types="vite/client" />
/**
 * Task k1700vs1d5v3a82cgph88n5jbs8g6p8p (M21 of the identity-by-id plan): the
 * doors of stats / improvisationDigest / issueStatsQueries act inside a
 * transport-verified identity, in BOTH directions, under SCOPED org identities.
 *
 * R-54  the fleet service account carrying NO claim is REFUSED (RBAC_DENIED),
 *       never served as master; with the operator agent's `verifiedActor` it is
 *       served; with an agent of another organisation it is refused.
 * R-55  a client org's window is narrowed INSIDE the index range before the
 *       bound, so a foreign or out-of-roster row cannot crowd a visible one out.
 *
 * Three poles per door: REFUSED / ABSENT / PRESENT
 * (.claude/rules/refusal-is-distinguishable-from-absence.md).
 */
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

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const OPERATOR = "fleet-operator";
const ACME = "acme";
const GLOBEX = "globex";
const STATS_SCOPE = "view-stats-aggregated";

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const human = (t: T, org: string, role: string, subject: string) =>
	t.withIdentity({
		subject,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: role,
	} as Identity);

async function seedOrg(
	t: T,
	slug: string,
	allowedOrchestrators: string[],
): Promise<Id<"agents">> {
	return await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators,
			scopes: [STATS_SCOPE],
			displayName: slug,
			isActive: true,
			createdAt: 1,
		});
		return await ctx.db.insert("agents", {
			orgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			name: "worker-a",
			normalizedName: "worker-a",
			isActive: true,
			createdAt: 1,
		});
	});
}

type TaskSeed = {
	orgId: string;
	assignedTo: string;
	status?: "todo" | "done";
	completionNote?: string;
};

async function insertTasks(t: T, seeds: TaskSeed[]): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		for (const s of seeds) {
			await ctx.db.insert("tasks", {
				title: "t",
				assignedTo: s.assignedTo,
				priority: "medium" as const,
				status: s.status ?? "todo",
				createdBy: s.assignedTo,
				createdAt: now,
				updatedAt: now,
				orgId: s.orgId,
				clerkOrgId: testClerkOrgId(s.orgId),
				...(s.completionNote !== undefined
					? { completionNote: s.completionNote }
					: {}),
			});
		}
	});
}

async function seedWorld(t: T) {
	const fleet = await seedFleetAgents(t, ["sigma"]);
	const acmeAgent = await seedOrg(t, ACME, ["worker-a"]);
	await seedOrg(t, GLOBEX, ["worker-a"]);
	return { sigma: fleet.sigma, acmeAgent };
}

const operatorActor = (agentId: string) =>
	({ agentId, orgSlug: OPERATOR }) as never;
const acmeActor = (agentId: string) => ({ agentId, orgSlug: ACME }) as never;

const FLAGGED_NOTE = "merged PR #4242 into main";

// ─── the five doors, each at its three poles ────────────────────────────────

describe("R-54: the claimless fleet service account is refused, never served as master", () => {
	test.each([
		["stats:orchestratorStats", (t: T, claim?: never) =>
			asService(t).query(api.stats.orchestratorStats, {
				window: "7d",
				...(claim !== undefined ? { verifiedActor: claim } : {}),
			} as never)],
		["stats:openTaskCountsByOrchestrator", (t: T, claim?: never) =>
			asService(t).query(
				api.stats.openTaskCountsByOrchestrator,
				(claim !== undefined ? { verifiedActor: claim } : {}) as never,
			)],
		["stats:fleetStats", (t: T, claim?: never) =>
			asService(t).query(
				api.stats.fleetStats,
				(claim !== undefined ? { verifiedActor: claim } : {}) as never,
			)],
		["improvisationDigest:scanWindow", (t: T, claim?: never) =>
			asService(t).query(api.improvisationDigest.scanWindow, {
				windowDays: 7,
				...(claim !== undefined ? { verifiedActor: claim } : {}),
			} as never)],
		["issueStatsQueries:getLatest", (t: T, claim?: never) =>
			asService(t).query(
				api.issueStatsQueries.getLatest,
				(claim !== undefined ? { verifiedActor: claim } : {}) as never,
			)],
	] as const)(
		"%s: REFUSED claimless / REFUSED with a client-org agent / PRESENT with the operator agent",
		async (door, call) => {
			const t = createT();
			const { sigma, acmeAgent } = await seedWorld(t);
			await insertTasks(t, [{ orgId: OPERATOR, assignedTo: "sigma" }]);

			// REFUSED pole: no claim. Said by RAISING with its code and its door.
			await expect(call(t)).rejects.toThrow(/RBAC_DENIED/);
			await expect(call(t)).rejects.toThrow(
				new RegExp(door.replace(":", ":")),
			);

			// REFUSED pole: a claim for an agent of ANOTHER organisation.
			await expect(call(t, acmeActor(acmeAgent))).rejects.toThrow(
				/ORG_MISMATCH|RBAC_DENIED/,
			);

			// PRESENT pole: the operator-organisation agent's verified ID.
			await expect(
				call(t, operatorActor(sigma)),
			).resolves.toBeDefined();
		},
	);

	test("PRESENT carries the real figure: a seeded operator task is counted under the operator claim", async () => {
		const t = createT();
		const { sigma } = await seedWorld(t);
		await insertTasks(t, [
			{ orgId: OPERATOR, assignedTo: "sigma" },
			{ orgId: OPERATOR, assignedTo: "sigma" },
		]);
		const rows = await asService(t).query(
			api.stats.openTaskCountsByOrchestrator,
			{ verifiedActor: operatorActor(sigma) } as never,
		);
		expect(rows.find((r) => r.orchestrator === "sigma")?.todo).toBe(2);
		const fleet = await asService(t).query(api.stats.fleetStats, {
			verifiedActor: operatorActor(sigma),
		} as never);
		expect(fleet.tasks.byStatus.todo).toBe(2);
	});
});

describe("scoped org identities: own rows visible, other org invisible", () => {
	test("openTaskCountsByOrchestrator: acme sees acme's open tasks only (ABSENT stays an empty success)", async () => {
		const t = createT();
		await seedWorld(t);
		await insertTasks(t, [
			{ orgId: ACME, assignedTo: "worker-a" },
			{ orgId: GLOBEX, assignedTo: "worker-a" },
			{ orgId: GLOBEX, assignedTo: "worker-a" },
		]);
		const acme = await human(t, ACME, "org:admin", "acme-admin").query(
			api.stats.openTaskCountsByOrchestrator,
			{},
		);
		expect(acme).toHaveLength(1);
		expect(acme[0]).toMatchObject({ orchestrator: "worker-a", todo: 1 });

		const t2 = createT();
		await seedWorld(t2);
		const empty = await human(t2, ACME, "org:admin", "acme-admin").query(
			api.stats.openTaskCountsByOrchestrator,
			{},
		);
		expect(empty).toEqual([]);
	});

	test("fleetStats: an org member is refused by RAISING (never zeros)", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			human(t, ACME, "org:admin", "acme-admin").query(api.stats.fleetStats, {}),
		).rejects.toThrow(/RBAC_DENIED.*not-fleet-master/s);
	});

	test("issueStatsQueries:getLatest: an org member is refused by RAISING", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			human(t, ACME, "org:member", "acme-m").query(
				api.issueStatsQueries.getLatest,
				{},
			),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("R-55 orchestratorStats: an out-of-roster flood older than the cap cannot hide the member's own row", async () => {
		const t = createT();
		await seedWorld(t);
		// 5000 older acme rows assigned to an orchestrator NOT on acme's roster,
		// then ONE row for the rostered worker. A read that takes the oldest 5000
		// of the org first and narrows by roster after never sees the newest row.
		const flood: TaskSeed[] = Array.from({ length: 5000 }, () => ({
			orgId: ACME,
			assignedTo: "outsider",
		}));
		await insertTasks(t, flood);
		await insertTasks(t, [{ orgId: ACME, assignedTo: "worker-a" }]);
		await insertTasks(t, [{ orgId: GLOBEX, assignedTo: "worker-a" }]);
		const rows = await human(t, ACME, "org:admin", "acme-admin").query(
			api.stats.orchestratorStats,
			{ window: "7d" },
		);
		expect(rows.map((r) => r.orchestratorId)).toEqual(["worker-a"]);
		expect(rows[0].queueSize).toBe(1);
	}, 60_000);

	test("R-55 scanWindow: a client org's done task older than the 2000-row cap is still found, and another org's is not", async () => {
		const t = createT();
		const { sigma } = await seedWorld(t);
		// The flagged done task is the OLDEST acme row; 2000 newer todo rows follow.
		await insertTasks(t, [
			{
				orgId: ACME,
				assignedTo: "worker-a",
				status: "done",
				completionNote: FLAGGED_NOTE,
			},
		]);
		await insertTasks(
			t,
			Array.from({ length: 2000 }, () => ({
				orgId: ACME,
				assignedTo: "worker-a",
			})),
		);
		await insertTasks(t, [
			{
				orgId: GLOBEX,
				assignedTo: "worker-a",
				status: "done",
				completionNote: "merged PR #9999 into main",
			},
		]);
		const acme = await human(t, ACME, "org:admin", "acme-admin").query(
			api.improvisationDigest.scanWindow,
			{ windowDays: 7 },
		);
		expect(acme.countsByCategory.complete_task).toBe(1);
		expect(JSON.stringify(acme.samples)).toContain("4242");
		expect(JSON.stringify(acme.samples)).not.toContain("9999");

		// The operator agent's claim reads across tenants (fleet figure).
		const fleet = await asService(t).query(api.improvisationDigest.scanWindow, {
			windowDays: 7,
			verifiedActor: operatorActor(sigma),
		} as never);
		expect(fleet.countsByCategory.complete_task).toBe(2);
	}, 60_000);
});
