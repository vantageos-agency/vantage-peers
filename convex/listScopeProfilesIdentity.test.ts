/// <reference types="vite/client" />
/**
 * oauth:listScopeProfiles — read-only, returns the permanent identities of a profile
 * (agentId, clerkOrgId) when stored, and omits them when the row has none.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("./**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const base = {
	description: "d",
	fromAllowList: ["alice"],
	namespaceReadPrefixes: ["project/x"],
	namespaceWritePrefixes: ["project/x"],
	createdAt: 1,
	updatedAt: 1,
};

describe("oauth:listScopeProfiles identity fields", () => {
	test("a profile with agentId + clerkOrgId returns both; one without omits them", async () => {
		const t = convexTest(schema, modules);
		const agentId = await t.run(async (ctx) =>
			ctx.db.insert("agents", {
				orgSlug: "acme",
				name: "alice",
				isActive: true,
				createdAt: 1,
			}),
		);
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_scope_profiles", {
				...base,
				profileId: "seat-a",
				clerkOrgSlug: "acme",
				clerkOrgId: "org_acme",
				agentId,
			});
			await ctx.db.insert("oauth_scope_profiles", {
				...base,
				profileId: "bare",
			});
		});
		const rows = await t.query(internal.oauth.listScopeProfiles, {});
		const seat = rows.find((r) => r.profileId === "seat-a");
		const bare = rows.find((r) => r.profileId === "bare");
		expect(seat?.agentId).toBe(agentId);
		expect(seat?.clerkOrgId).toBe("org_acme");
		expect(seat?.clerkOrgSlug).toBe("acme");
		expect(bare).toBeDefined();
		expect("agentId" in (bare ?? {})).toBe(false);
		expect("clerkOrgId" in (bare ?? {})).toBe(false);
	});
});
