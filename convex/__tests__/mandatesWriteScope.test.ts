/// <reference types="vite/client" />
/**
 * mandates.create / accept / update / settle — write-scope enforcement.
 *
 * DEFECT (pre-fix, on main): all four mutations authorized SOLELY on the
 * client-supplied `callerOrchestrator` STRING ARGUMENT (or, for `create`,
 * NOTHING at all) — never a verified identity. `mandates` carries no
 * orgId/tenant field (schema.ts:660) — it is a fleet-internal commercial
 * object between orchestrators (requestedBy/fulfilledBy), so the only sound
 * fix is: REFUSE any caller that is not the verified fleet master (the real
 * master secret / recognized CLERK_SERVICE_ACCOUNT_USER_ID carve-out —
 * convex/lib/auth.ts's withOrgScope), including a verified Clerk-org
 * (tenant) caller. This is the defect class
 * .claude/rules/authority-attached-to-anonymous-object.md describes.
 *
 * This suite proves all four mutations now require `withOrgScope`'s
 * `isMaster` grant, both poles, while keeping the pre-existing
 * `callerOrchestrator` narrowing check intact for the legitimate path.
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

function asOrgA(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asMaster(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

async function seedOrgAMapping(t: ReturnType<typeof createT>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["seat-a"],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedMandate(t: ReturnType<typeof createT>) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert("mandates", {
			requestedBy: "pi",
			fulfilledBy: "tau",
			service: "seo audit",
			budget: 1000,
			status: "requested",
			createdAt: now,
			updatedAt: now,
		});
	});
}

// ── existence oracle ─────────────────────────────────────────────────────────
// Proves a refusal is a REFUSAL, not a "row missing" miss — the master
// (legitimate) path can act on the very same seeded row the anonymous/org
// poles were refused against.

describe("mandates.create — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		await expect(
			t.mutation(api.mandates.create, {
				requestedBy: "pi",
				fulfilledBy: "tau",
				service: "seo audit",
				budget: 1000,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		const all = await t.run((ctx) => ctx.db.query("mandates").collect());
		expect(all).toHaveLength(0);
	});

	test("a verified Clerk-org (tenant) caller is refused — mandates are fleet-internal", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);
		await expect(
			tA.mutation(api.mandates.create, {
				requestedBy: "pi",
				fulfilledBy: "tau",
				service: "seo audit",
				budget: 1000,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		const all = await t.run((ctx) => ctx.db.query("mandates").collect());
		expect(all).toHaveLength(0);
	});

	test("the master/service-account identity creates a mandate", async () => {
		const t = createT();
		const tMaster = asMaster(t);
		const mandateId = await tMaster.mutation(api.mandates.create, {
			requestedBy: "pi",
			fulfilledBy: "tau",
			service: "seo audit",
			budget: 1000,
		});
		const mandate = await t.run((ctx) => ctx.db.get(mandateId));
		expect(mandate?.status).toBe("requested");
	});
});

describe("mandates.accept — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused (existence oracle: master can still accept the SAME row)", async () => {
		const t = createT();
		const mandateId = await seedMandate(t);

		await expect(
			t.mutation(api.mandates.accept, {
				mandateId,
				callerOrchestrator: "tau",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const untouched = await t.run((ctx) => ctx.db.get(mandateId));
		expect(untouched?.status).toBe("requested");

		const tMaster = asMaster(t);
		await tMaster.mutation(api.mandates.accept, {
			mandateId,
			callerOrchestrator: "tau",
		});
		const accepted = await t.run((ctx) => ctx.db.get(mandateId));
		expect(accepted?.status).toBe("accepted");
	});

	test("a verified Clerk-org (tenant) caller is refused even with the correct callerOrchestrator", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const mandateId = await seedMandate(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.mandates.accept, {
				mandateId,
				callerOrchestrator: "tau",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const untouched = await t.run((ctx) => ctx.db.get(mandateId));
		expect(untouched?.status).toBe("requested");
	});
});

describe("mandates.update — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused (existence oracle: master can still update the SAME row)", async () => {
		const t = createT();
		const mandateId = await seedMandate(t);

		await expect(
			t.mutation(api.mandates.update, {
				mandateId,
				callerOrchestrator: "tau",
				tokensCost: 42,
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const untouched = await t.run((ctx) => ctx.db.get(mandateId));
		expect(untouched?.tokensCost).toBeUndefined();

		const tMaster = asMaster(t);
		await tMaster.mutation(api.mandates.update, {
			mandateId,
			callerOrchestrator: "tau",
			tokensCost: 42,
		});
		const updated = await t.run((ctx) => ctx.db.get(mandateId));
		expect(updated?.tokensCost).toBe(42);
	});
});

describe("mandates.settle — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused (existence oracle: master can still settle the SAME row)", async () => {
		const t = createT();
		const mandateId = await seedMandate(t);

		await expect(
			t.mutation(api.mandates.settle, {
				mandateId,
				callerOrchestrator: "pi",
				finalCost: 900,
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const untouched = await t.run((ctx) => ctx.db.get(mandateId));
		expect(untouched?.status).toBe("requested");

		const tMaster = asMaster(t);
		await tMaster.mutation(api.mandates.settle, {
			mandateId,
			callerOrchestrator: "pi",
			finalCost: 900,
		});
		const settled = await t.run((ctx) => ctx.db.get(mandateId));
		expect(settled?.status).toBe("settled");
		expect(settled?.tokensCost).toBe(900);
	});
});
