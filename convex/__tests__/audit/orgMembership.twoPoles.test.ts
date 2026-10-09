/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import schema from "../../schema";
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const NOW = 1_700_000_000_000;
const asService = (t: T) =>
	t.withIdentity({ subject: process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string });
const asMember = (t: T, org: string, role = "org:member") =>
	t.withIdentity({
		subject: `user-${org}-${role}`,
		organizationSlug: org,
		org_role: role,
	} as Parameters<T["withIdentity"]>[0]);
const mapping = (t: T, slug: string, names: string[], scopes: string[]) =>
	t.run((ctx) =>
		ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			allowedOrchestrators: names,
			scopes,
			displayName: slug,
			isActive: true,
			createdAt: NOW,
		}),
	);

// RED reproduction, group R5 — orgMembership:getMembership. Origin: dashboardSummaryTenant.test.ts harness.
describe("orgMembership:getMembership", () => {
	test("orgMembership:getMembership — a plain org:member cannot list all members of its org; only an admin can (identity: Clerk org:member of client-c; admin is the positive control)", async () => {
		const t = createT();
		await mapping(t, "client-c", ["x"], ["view-own-tasks"]);
		await t.run((ctx) =>
			ctx.db.insert("orgMembership", { clerkOrgSlug: "client-c", clerkUserId: "u-other", role: "admin", createdAt: NOW, updatedAt: NOW }),
		);
		const admin = await asMember(t, "client-c", "org:admin").query(api.orgMembership.getMembership, { clerkOrgSlug: "client-c" });
		expect(admin.length, "positive control: admin lists members").toBe(1);
		let served = 0;
		try {
			served = (await asMember(t, "client-c", "org:member").query(api.orgMembership.getMembership, { clerkOrgSlug: "client-c" })).length;
		} catch { served = 0; }
		expect(served).toBe(0);
	});

	test("orgMembership:getMembership — the claimless service account cannot list a client org's members by slug (identity: service account WITHOUT a claim)", async () => {
		const t = createT();
		await mapping(t, "client-c", ["x"], ["view-own-tasks"]);
		await t.run((ctx) =>
			ctx.db.insert("orgMembership", { clerkOrgSlug: "client-c", clerkUserId: "u-other", role: "admin", createdAt: NOW, updatedAt: NOW }),
		);
		let denied = false;
		try {
			await asService(t).query(api.orgMembership.getMembership, { clerkOrgSlug: "client-c" });
		} catch (e) { denied = String((e as { data?: unknown }).data ?? e).includes("RBAC_DENIED"); }
		expect(denied).toBe(true);
	});
});
