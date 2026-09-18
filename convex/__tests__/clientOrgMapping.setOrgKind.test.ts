/// <reference types="vite/client" />
//
// clientOrgMapping.setOrgKind — the one instrument for marking a
// client_org_mapping row as the operator's own organisation ("operator") vs
// a customer ("client"). Run once in production via `npx convex run`. Never
// touches isActive, allowedOrchestrators or scopes — only `orgKind`.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")),
);

const createT = () => convexTest(schema, modules);

async function seedRow(
	t: ReturnType<typeof createT>,
	opts: {
		clerkOrgSlug: string;
		allowedOrchestrators: string[];
		scopes?: string[];
		isActive?: boolean;
		orgKind?: "operator" | "client";
	},
) {
	return await t.run(async (ctx) => {
		return await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: opts.clerkOrgSlug,
			allowedOrchestrators: opts.allowedOrchestrators,
			scopes: opts.scopes ?? ["view-own-tasks"],
			displayName: opts.clerkOrgSlug,
			isActive: opts.isActive ?? true,
			createdAt: Date.now(),
			...(opts.orgKind !== undefined ? { orgKind: opts.orgKind } : {}),
		});
	});
}

describe("setOrgKind", () => {
	test("marks a row 'operator'; previous is null when orgKind was absent; current is 'operator'", async () => {
		const t = createT();
		await seedRow(t, {
			clerkOrgSlug: "fleet-station",
			allowedOrchestrators: ["pi", "sigma"],
		});

		const result = await t.mutation(
			internal.clientOrgMapping.setOrgKind,
			{ clerkOrgSlug: "fleet-station", orgKind: "operator" },
		);

		expect(result).toEqual({
			clerkOrgSlug: "fleet-station",
			previous: null,
			current: "operator",
		});

		const row = await t.run(async (ctx) =>
			ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "fleet-station"))
				.unique(),
		);
		expect(row?.orgKind).toBe("operator");
	});

	test("a subsequent _listRealClientOrgs excludes the now-marked-operator row", async () => {
		const t = createT();
		await seedRow(t, {
			clerkOrgSlug: "fleet-station",
			allowedOrchestrators: ["pi", "sigma"],
		});
		await seedRow(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["victor"],
		});

		await t.mutation(internal.clientOrgMapping.setOrgKind, {
			clerkOrgSlug: "fleet-station",
			orgKind: "operator",
		});

		const orgs = await t.query(
			internal.receiptTenantBackfill._listRealClientOrgs,
			{},
		);
		expect(orgs.map((o) => o.clerkOrgSlug).sort()).toEqual(["acme-client"]);
	});

	test("unknown slug throws ORG_MAPPING_NOT_FOUND", async () => {
		const t = createT();
		await expect(
			t.mutation(internal.clientOrgMapping.setOrgKind, {
				clerkOrgSlug: "does-not-exist",
				orgKind: "operator",
			}),
		).rejects.toThrow(/ORG_MAPPING_NOT_FOUND/);
	});

	test("isActive, allowedOrchestrators and scopes are unchanged after the patch", async () => {
		const t = createT();
		const id = await seedRow(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["victor", "clio"],
			scopes: ["view-own-tasks", "view-own-missions"],
			isActive: true,
		});

		await t.mutation(internal.clientOrgMapping.setOrgKind, {
			clerkOrgSlug: "acme-client",
			orgKind: "operator",
		});

		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.isActive).toBe(true);
		expect(row?.allowedOrchestrators).toEqual(["victor", "clio"]);
		expect(row?.scopes).toEqual(["view-own-tasks", "view-own-missions"]);
	});

	test("setting back to 'client' re-includes the row in _listRealClientOrgs; previous reflects the prior mark", async () => {
		const t = createT();
		await seedRow(t, {
			clerkOrgSlug: "fleet-station",
			allowedOrchestrators: ["pi", "sigma"],
			orgKind: "operator",
		});

		const result = await t.mutation(internal.clientOrgMapping.setOrgKind, {
			clerkOrgSlug: "fleet-station",
			orgKind: "client",
		});

		expect(result).toEqual({
			clerkOrgSlug: "fleet-station",
			previous: "operator",
			current: "client",
		});

		const orgs = await t.query(
			internal.receiptTenantBackfill._listRealClientOrgs,
			{},
		);
		expect(orgs.map((o) => o.clerkOrgSlug)).toEqual(["fleet-station"]);
	});
});
