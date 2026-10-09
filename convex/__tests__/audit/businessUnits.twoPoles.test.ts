/// <reference types="vite/client" />
/**
 * RED reproduction, group R5 — businessUnits doors (create, update, remove, get, list).
 * Harness origin: convex/__tests__/businessUnits.list_bus.test.ts conventions, inboxByAgentId.test.ts
 * (Clerk member identity), convex/memberWriterRoles.ts (writer roles are DATA: a viewer is not a writer).
 * Orgs A and B carry the SAME roster name "pi" (the cross-org class only shows on same-name rows).
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const A = "org-a";
const B = "org-b";
const NOW = 1_700_000_000_000;

const asService = (t: T) =>
	t.withIdentity({ subject: process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string });
const asMember = (t: T, org: string, role: string) =>
	t.withIdentity({
		subject: `user-${org}-${role}`,
		organizationSlug: org,
		org_role: role,
	} as Parameters<T["withIdentity"]>[0]);

const buFields = (orchestratorId: string, name: string) => ({
	name,
	description: "d",
	purpose: "p",
	orchestratorId,
	status: "idea" as const,
	businessModel: "m",
	targetCustomers: "c",
	services: [],
	pricing: "SECRET-PRICING",
	revenueProjections: { y1: 1, y2: 2, y3: 3 },
	coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
	coreProcesses: [],
	dependencies: [],
	kpis: [],
	managementFee: 10,
});

async function seed() {
	const t = createT();
	const w = await t.run(async (ctx) => {
		for (const slug of [A, B]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: ["pi"],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
			});
		}
		// writer roles are data: members write, viewers do not (fleet default row).
		await ctx.db.insert("memberWriterRoles", { roles: ["org:admin", "org:member"], updatedAt: NOW });
		const buA: Id<"businessUnits"> = await ctx.db.insert("businessUnits", {
			...buFields("pi", "A-unit"),
			createdAt: NOW,
			updatedAt: NOW,
			orgId: A,
		});
		return { buA };
	});
	return { t, ...w };
}

async function refusalOf(p: Promise<unknown>): Promise<string | null> {
	try {
		await p;
		return null;
	} catch (e) {
		return String((e as { data?: unknown }).data ?? (e as Error).message);
	}
}

describe("businessUnits writes", () => {
	test("businessUnits:create — a viewer member (not a writer role) of org A cannot create a BU for its roster's 'pi' (identity: Clerk org:viewer of org-a)", async () => {
		const { t } = await seed();
		const r = await refusalOf(
			asMember(t, A, "org:viewer").mutation(api.businessUnits.create, buFields("pi", "viewer-made")),
		);
		expect(r ?? "NO REFUSAL (the write succeeded)", "a non-writer role must be refused").toContain("RBAC_DENIED");
	});

	test("businessUnits:update — a viewer member of org A cannot rewrite its own org's BU by typing the owner's name (identity: Clerk org:viewer of org-a)", async () => {
		const { t, buA } = await seed();
		const r = await refusalOf(
			asMember(t, A, "org:viewer").mutation(api.businessUnits.update, {
				buId: buA,
				callerOrchestrator: "pi",
				status: "live",
			}),
		);
		expect(r ?? "NO REFUSAL (the write succeeded)", "a non-writer role must be refused").toContain("RBAC_DENIED");
	});

	test("businessUnits:remove — the claimless service account cannot delete a tenant's BU by id (identity: service account WITHOUT a claim)", async () => {
		const { t, buA } = await seed();
		const r = await refusalOf(asService(t).mutation(api.businessUnits.remove, { buId: buA }));
		expect(r ?? "NO REFUSAL (the write succeeded)", "a claimless caller must not delete a client-org-stamped BU").toContain("RBAC_DENIED");
		const still = await t.run((ctx) => ctx.db.get(buA));
		expect(still).not.toBeNull();
	});
});

describe("businessUnits reads", () => {
	test("businessUnits:get — org B (same roster name 'pi') cannot read org A's BU by id (identity: Clerk org:member of org-b); org A can (positive control)", async () => {
		const { t, buA } = await seed();
		const own = await asMember(t, A, "org:member").query(api.businessUnits.get, { buId: buA });
		expect(own?.pricing, "positive control: A reads its own unit").toBe("SECRET-PRICING");
		const foreign = await asMember(t, B, "org:member").query(api.businessUnits.get, { buId: buA });
		expect(foreign).toBeNull();
	});

	test("businessUnits:list — org B (same roster name 'pi') does not list org A's BU (identity: Clerk org:member of org-b); org A does (positive control)", async () => {
		const { t } = await seed();
		const own = await asMember(t, A, "org:member").query(api.businessUnits.list, {});
		expect(own.items.length, "positive control: A lists its own unit").toBe(1);
		const foreign = await asMember(t, B, "org:member").query(api.businessUnits.list, {});
		expect(foreign.items).toHaveLength(0);
	});

	test("businessUnits:list — a member's own unit is not hidden behind other tenants' newer rows (roster filter inside the read, not after take(limit+1)) (identity: Clerk org:member of org-b)", async () => {
		const { t } = await seed();
		await t.run(async (ctx) => {
			// B's own unit is OLDEST; three newer units led by 'zz' (not on B's roster) sit above it.
			await ctx.db.insert("businessUnits", { ...buFields("pi", "B-unit"), createdAt: NOW, updatedAt: NOW, orgId: B });
			for (const n of ["z1", "z2", "z3"]) {
				await ctx.db.insert("businessUnits", { ...buFields("zz", n), createdAt: NOW, updatedAt: NOW, orgId: "org-z" });
			}
		});
		const page = await asMember(t, B, "org:member").query(api.businessUnits.list, { limit: 1 });
		expect(page.items.map((b) => b.name)).toEqual(["B-unit"]);
	});
});
