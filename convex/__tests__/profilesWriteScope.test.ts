/// <reference types="vite/client" />
/**
 * profiles.upsertProfile / updateDynamic — write-scope enforcement.
 *
 * DEFECT (pre-fix, on main): both mutations took NO identity/scope check at
 * all — `profiles` carries no orgId/tenant field (schema.ts:137), it is the
 * fleet's own orchestrator-instance registry (pi/tau/sigma/…). Fix: REFUSE
 * any caller that is not the verified fleet master (convex/lib/auth.ts's
 * withOrgScope isMaster grant), including a verified Clerk-org (tenant)
 * caller. Defect class: .claude/rules/authority-attached-to-anonymous-object.md.
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

async function seedProfile(t: ReturnType<typeof createT>) {
	return await t.run(async (ctx) => {
		return await ctx.db.insert("profiles", {
			orchestratorId: "sigma",
			name: "Sigma",
			static: { role: "backend", workspace: "/root/coding/vantage-memory", capabilities: [] },
			dynamic: { lastSeen: Date.now(), sessionCount: 0 },
		});
	});
}

describe("profiles.upsertProfile — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		await expect(
			t.mutation(api.profiles.upsertProfile, {
				orchestratorId: "sigma",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		const all = await t.run((ctx) => ctx.db.query("profiles").collect());
		expect(all).toHaveLength(0);
	});

	test("a verified Clerk-org (tenant) caller is refused — profiles are fleet-internal", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);
		await expect(
			tA.mutation(api.profiles.upsertProfile, {
				orchestratorId: "sigma",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		const all = await t.run((ctx) => ctx.db.query("profiles").collect());
		expect(all).toHaveLength(0);
	});

	test("the master/service-account identity upserts a profile", async () => {
		const t = createT();
		const tMaster = asMaster(t);
		const profileId = await tMaster.mutation(api.profiles.upsertProfile, {
			orchestratorId: "sigma",
			name: "Sigma",
		});
		const profile = await t.run((ctx) => ctx.db.get(profileId));
		expect(profile?.name).toBe("Sigma");
	});
});

describe("profiles.updateDynamic — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused (existence oracle: master can still update the SAME row)", async () => {
		const t = createT();
		const profileId = await seedProfile(t);

		await expect(
			t.mutation(api.profiles.updateDynamic, {
				orchestratorId: "sigma",
				currentTask: "hijacked",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const untouched = await t.run((ctx) => ctx.db.get(profileId));
		expect(untouched?.dynamic.currentTask).toBeUndefined();

		const tMaster = asMaster(t);
		await tMaster.mutation(api.profiles.updateDynamic, {
			orchestratorId: "sigma",
			currentTask: "legit update",
		});
		const updated = await t.run((ctx) => ctx.db.get(profileId));
		expect(updated?.dynamic.currentTask).toBe("legit update");
	});

	test("a verified Clerk-org (tenant) caller is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const profileId = await seedProfile(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.profiles.updateDynamic, {
				orchestratorId: "sigma",
				currentTask: "cross-tenant write",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const untouched = await t.run((ctx) => ctx.db.get(profileId));
		expect(untouched?.dynamic.currentTask).toBeUndefined();
	});
});
