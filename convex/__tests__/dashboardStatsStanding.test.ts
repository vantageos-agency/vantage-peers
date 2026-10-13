/// <reference types="vite/client" />
/**
 * WHO IS THE FLEET, FOR THE DASHBOARD AND THE STATS READS (module M16).
 *
 * `dashboard:getDashboardSummary`, `dashboard:getProjectSummary` and
 * `stats:orchestratorStats` serve the whole fleet to the fleet and the caller's
 * own tenant to a member. Whether a caller IS the fleet is the package's
 * standing (lib/fleetStanding.ts), not a flag read off the resolved scope: the
 * fleet service account, and the verified `org:admin` of the OPERATOR org for
 * these READS. Nobody else is: not a plain member of the operator org, not an
 * admin of a client org.
 *
 * POLES
 *   PERMISSION  - the service account and the operator org's admin read every
 *                 tenant's rows; a client member with the scope reads its own.
 *   DENIED      - a client org's admin is not the fleet (own tenant only); the
 *                 operator org's plain member is not the fleet and, without the
 *                 scope, is refused; a member without the scope is refused; an
 *                 anonymous caller is refused by raising.
 *   ABSENT      - a client member of an org with no rows reads a genuine zero.
 */
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { seedRosterAgent } from "../../tests/fixtures/rosterAgent";
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
type Identity = Parameters<T["withIdentity"]>[0];

const OP = "fleet-op";
const A = "org-a";
const EMPTY = "org-empty";
const NOW = 1_700_000_000_000;

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asMember = (t: T, slug: string, role: string) =>
	t.withIdentity({
		subject: `user-${slug}-${role}`,
		organizationSlug: slug,
		org_id: testClerkOrgId(slug),
		org_role: role,
	} as Identity);

async function seedWorld(scopes: string[] = ["view-stats-aggregated"]) {
	const t = createT();
	await t.run(async (ctx) => {
		for (const [slug, kind, sc] of [
			[OP, "operator", []],
			[A, undefined, scopes],
			[EMPTY, undefined, ["view-stats-aggregated"]],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: slug === A ? ["seat-a"] : [],
				scopes: [...sc],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...(kind ? { orgKind: kind } : {}),
			});
		}
		const seatA = await seedRosterAgent(ctx, A, "seat-a");
		for (const [orgId, assignedTo, project] of [
			[A, "seat-a", "proj-a"],
			[undefined, "sigma", "proj-fleet"],
			[OP, "sigma", "proj-op"],
		] as const) {
			await ctx.db.insert("tasks", {
				title: `task-${orgId ?? "fleet"}`,
				project,
				assignedTo,
				priority: "medium",
				status: "in_progress",
				createdBy: assignedTo,
				createdAt: NOW,
				updatedAt: NOW,
				orgId,
				clerkOrgId: testClerkOrgId(orgId),
				...(assignedTo === "seat-a" ? { assignedToId: seatA } : {}),
			});
		}
	});
	return t;
}

const refusal = async (p: Promise<unknown>): Promise<string> => {
	try {
		await p;
	} catch (e) {
		const x = e as { data?: unknown; message?: string };
		return typeof x.data === "string" ? x.data : String(x.message);
	}
	return "SERVED";
};

describe("PERMISSION", () => {
	test("the service account and the operator org's admin read every tenant's rows", async () => {
		const t = await seedWorld();
		for (const caller of [asService(t), asMember(t, OP, "org:admin")]) {
			const summary = await caller.query(api.dashboard.getDashboardSummary, {});
			expect(summary.tasksInProgress).toBe(3);
			const projects = await caller.query(api.dashboard.getProjectSummary, {});
			expect(Array.isArray(projects) ? projects.map((p) => p.name).sort() : []).toEqual([
				"proj-a",
				"proj-fleet",
				"proj-op",
			]);
			const stats = await caller.query(api.stats.orchestratorStats, { window: "7d" });
			expect(stats.map((s) => s.orchestratorId).sort()).toEqual(["seat-a", "sigma"]);
		}
	});

	test("a client member with the scope reads its own tenant only", async () => {
		const t = await seedWorld();
		const m = asMember(t, A, "org:member");
		expect((await m.query(api.dashboard.getDashboardSummary, {})).tasksInProgress).toBe(1);
		const projects = await m.query(api.dashboard.getProjectSummary, {});
		expect(Array.isArray(projects) ? projects.map((p) => p.name) : []).toEqual(["proj-a"]);
		expect((await m.query(api.stats.orchestratorStats, { window: "7d" })).map((s) => s.orchestratorId)).toEqual([
			"seat-a",
		]);
	});
});

describe("DENIED", () => {
	test("a client org's ADMIN is not the fleet: it reads its own tenant only", async () => {
		const t = await seedWorld();
		const admin = asMember(t, A, "org:admin");
		expect((await admin.query(api.dashboard.getDashboardSummary, {})).tasksInProgress).toBe(1);
		expect((await admin.query(api.stats.orchestratorStats, { window: "7d" })).map((s) => s.orchestratorId)).toEqual([
			"seat-a",
		]);
	});

	test("the operator org's plain member is not the fleet: without the scope it is refused on all three reads", async () => {
		const t = await seedWorld();
		const m = asMember(t, OP, "org:member");
		expect(await refusal(m.query(api.dashboard.getDashboardSummary, {}))).toContain("RBAC_DENIED");
		expect(await refusal(m.query(api.dashboard.getProjectSummary, {}))).toContain("RBAC_DENIED");
		expect(await refusal(m.query(api.stats.orchestratorStats, { window: "7d" }))).toContain("RBAC_DENIED");
	});

	test("a client member WITHOUT the scope is refused with the coded refusal, never zeros", async () => {
		const t = await seedWorld([]);
		const m = asMember(t, A, "org:member");
		expect(await refusal(m.query(api.dashboard.getDashboardSummary, {}))).toContain("Missing scope");
		expect(await refusal(m.query(api.stats.orchestratorStats, { window: "7d" }))).toContain("Missing scope");
	});

	test("an anonymous caller is refused by raising on all three reads", async () => {
		const t = await seedWorld();
		expect(await refusal(t.query(api.dashboard.getDashboardSummary, {}))).toContain("RBAC_DENIED");
		expect(await refusal(t.query(api.dashboard.getProjectSummary, {}))).toContain("RBAC_DENIED");
		expect(await refusal(t.query(api.stats.orchestratorStats, { window: "7d" }))).toContain("RBAC_DENIED");
	});
});

describe("ABSENT", () => {
	test("a client member of an org with no rows reads a genuine zero, not a refusal", async () => {
		const t = await seedWorld();
		const m = asMember(t, EMPTY, "org:member");
		expect((await m.query(api.dashboard.getDashboardSummary, {})).tasksInProgress).toBe(0);
		expect(await m.query(api.dashboard.getProjectSummary, {})).toEqual([]);
		expect(await m.query(api.stats.orchestratorStats, { window: "7d" })).toEqual([]);
	});
});
