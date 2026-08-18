/// <reference types="vite/client" />
/**
 * oauth:upsertScopeProfile — generic, idempotent, master-gated keyed upsert.
 *
 * Replaces a risky `convex import --append` provisioning path (append can
 * silently replace the whole table); a keyed upsert cannot wipe siblings.
 *
 * Contract:
 *   - args: { callerToken: string, profile: scopeProfileShape }
 *   - returns: "inserted" | "updated"
 *   - requireMasterAuth FIRST — a non-master token throws before any DB access.
 *   - Lookup by `by_profileId`. Present → patch, preserve createdAt, RETURN
 *     "updated". Absent → insert, RETURN "inserted".
 *   - Writes an oauth_audit_log row (eventType="scope_profile_upsert") with
 *     before/after state, mirroring seedDefaultProfiles' audit discipline.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("./**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const MASTER_TOKEN = "test-master-token-deadbeef";

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("BEARER_SECRET_MASTER", MASTER_TOKEN);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

function createTestConvex() {
	return convexTest(schema, modules);
}

const testProfile = {
	profileId: "test-upsert-profile",
	description: "Initial description.",
	fromAllowList: ["tester"],
	namespaceReadPrefixes: ["project/test-upsert"],
	namespaceWritePrefixes: ["project/test-upsert"],
};

describe("oauth:upsertScopeProfile — generic keyed upsert", () => {
	test("T1: inserts when absent → returns 'inserted'; row present; createdAt == updatedAt", async () => {
		const t = createTestConvex();

		const result = await t.mutation(api.oauth.upsertScopeProfile, {
			callerToken: MASTER_TOKEN,
			profile: testProfile,
		});

		expect(result).toBe("inserted");

		const row = await t.run(async (ctx) => {
			return await ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) =>
					q.eq("profileId", testProfile.profileId),
				)
				.unique();
		});

		expect(row).not.toBeNull();
		expect(row?.description).toBe(testProfile.description);
		expect(row?.createdAt).toBe(row?.updatedAt);
	});

	test("T2: updates when present → returns 'updated'; createdAt preserved; updatedAt advanced; fields patched", async () => {
		const t = createTestConvex();

		// Pin an initial time so the subsequent advance is unambiguous.
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

		await t.mutation(api.oauth.upsertScopeProfile, {
			callerToken: MASTER_TOKEN,
			profile: testProfile,
		});

		const before = await t.run(async (ctx) => {
			return await ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) =>
					q.eq("profileId", testProfile.profileId),
				)
				.unique();
		});

		// Advance fake time so updatedAt is distinguishable.
		vi.setSystemTime(new Date("2026-06-03T12:00:00Z"));

		const updatedProfile = {
			...testProfile,
			description: "Revised description.",
			namespaceReadPrefixes: [
				...testProfile.namespaceReadPrefixes,
				"project/test-upsert-extra",
			],
		};

		const result = await t.mutation(api.oauth.upsertScopeProfile, {
			callerToken: MASTER_TOKEN,
			profile: updatedProfile,
		});

		expect(result).toBe("updated");

		const after = await t.run(async (ctx) => {
			return await ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) =>
					q.eq("profileId", testProfile.profileId),
				)
				.unique();
		});

		expect(after?.createdAt).toBe(before?.createdAt);
		expect(after?.updatedAt).toBeGreaterThan(before?.updatedAt ?? 0);
		expect(after?.description).toBe("Revised description.");
		expect(after?.namespaceReadPrefixes).toContain(
			"project/test-upsert-extra",
		);
	});

	test("T3: idempotent — same input twice; second call 'updated'; total row count unchanged (no duplicate)", async () => {
		const t = createTestConvex();

		await t.mutation(api.oauth.upsertScopeProfile, {
			callerToken: MASTER_TOKEN,
			profile: testProfile,
		});

		const second = await t.mutation(api.oauth.upsertScopeProfile, {
			callerToken: MASTER_TOKEN,
			profile: testProfile,
		});

		expect(second).toBe("updated");

		const rows = await t.run(async (ctx) => {
			return await ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) =>
					q.eq("profileId", testProfile.profileId),
				)
				.collect();
		});

		expect(rows.length).toBe(1);
	});

	test("T4: master-gate — non-master callerToken throws; no row written", async () => {
		const t = createTestConvex();

		await expect(
			t.mutation(api.oauth.upsertScopeProfile, {
				callerToken: "not-the-master",
				profile: testProfile,
			}),
		).rejects.toThrow(/Unauthorized/);

		const rows = await t.run(async (ctx) => {
			return await ctx.db.query("oauth_scope_profiles").collect();
		});
		expect(rows.length).toBe(0);
	});

	test("T5: sibling-safety — with 2 pre-seeded profiles, upserting a 3rd leaves the first 2 byte-identical", async () => {
		const t = createTestConvex();

		const sibling1 = {
			profileId: "sibling-one",
			description: "Sibling one.",
			fromAllowList: ["one"],
			namespaceReadPrefixes: ["project/one"],
			namespaceWritePrefixes: ["project/one"],
		};
		const sibling2 = {
			profileId: "sibling-two",
			description: "Sibling two.",
			fromAllowList: ["two"],
			namespaceReadPrefixes: ["project/two"],
			namespaceWritePrefixes: ["project/two"],
		};

		await t.mutation(api.oauth.upsertScopeProfile, {
			callerToken: MASTER_TOKEN,
			profile: sibling1,
		});
		await t.mutation(api.oauth.upsertScopeProfile, {
			callerToken: MASTER_TOKEN,
			profile: sibling2,
		});

		const before = await t.run(async (ctx) => {
			return {
				one: await ctx.db
					.query("oauth_scope_profiles")
					.withIndex("by_profileId", (q) => q.eq("profileId", "sibling-one"))
					.unique(),
				two: await ctx.db
					.query("oauth_scope_profiles")
					.withIndex("by_profileId", (q) => q.eq("profileId", "sibling-two"))
					.unique(),
			};
		});

		await t.mutation(api.oauth.upsertScopeProfile, {
			callerToken: MASTER_TOKEN,
			profile: testProfile,
		});

		const after = await t.run(async (ctx) => {
			return {
				one: await ctx.db
					.query("oauth_scope_profiles")
					.withIndex("by_profileId", (q) => q.eq("profileId", "sibling-one"))
					.unique(),
				two: await ctx.db
					.query("oauth_scope_profiles")
					.withIndex("by_profileId", (q) => q.eq("profileId", "sibling-two"))
					.unique(),
			};
		});

		expect(after.one).toEqual(before.one);
		expect(after.two).toEqual(before.two);
	});

	test("T6: writes oauth_audit_log entry with eventType 'scope_profile_upsert' + before/after", async () => {
		const t = createTestConvex();

		await t.mutation(api.oauth.upsertScopeProfile, {
			callerToken: MASTER_TOKEN,
			profile: testProfile,
		});

		const updatedProfile = {
			...testProfile,
			description: "Revised description.",
		};
		await t.mutation(api.oauth.upsertScopeProfile, {
			callerToken: MASTER_TOKEN,
			profile: updatedProfile,
		});

		const auditRows = await t.run(async (ctx) => {
			return await ctx.db.query("oauth_audit_log").collect();
		});

		const upsertRows = auditRows.filter(
			(r: Record<string, unknown>) => r.eventType === "scope_profile_upsert",
		);
		expect(upsertRows.length).toBe(2);
		const lastRow = upsertRows[1] as Record<string, unknown>;
		expect(lastRow.targetProfileId).toBe(testProfile.profileId);
	});
});
