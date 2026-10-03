/// <reference types="vite/client" />
/**
 * S3.4 B4 — seedDefaultProfiles upsert semantics (catalog-SSOT doctrine).
 *
 * Replaces the legacy skip-on-exists behavior in convex/oauth.ts:77-153 with
 * a patch-on-diff upsert that:
 *   - Inserts seed profiles missing from the DB (baseline behavior).
 *   - Patches existing rows whose persisted fields differ from the catalog,
 *     writing an oauth_audit_log entry per actual UPDATE.
 *   - Stays a no-op (no writes, no audit row) when DB content already matches.
 *   - PRESERVES rows that exist in the DB but are NOT in the catalog
 *     (operator-created profiles, post-D9 renamed rows, etc.).
 *   - Returns a structured summary `{ inserted, updated, skipped }` for caller
 *     visibility (previously returned a flat string array of inserted IDs).
 *
 * Motivation: eliminate bespoke catalog-drift migrations — future catalog
 * edits propagate cleanly on deploy via the seed mutation itself. The code
 * catalog holds ONLY generic profiles (master, client-generic, public-readonly);
 * client profiles are data rows (see migrations/seed_client_scope_profiles).
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// Mirror the loader pattern used by convex/oauth.test.ts so cross-module API
// references resolve identically.
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

// getScopeProfile now requires master/service-account scope (SEC fix,
// task-local to convex/__tests__/oauthScopeProfileRead.test.ts) -- this
// fixture mirrors the mcp-server internalClient() service-account identity
// (vitest.config.ts sets CLERK_SERVICE_ACCOUNT_USER_ID to this exact
// subject) so pre-existing test infrastructure that reads a profile's
// fromAllowList/prefixes keeps working without going through anonymous
// access.
function asServiceAccount(t: ReturnType<typeof createTestConvex>) {
	return t.withIdentity({ subject: "test-service-account-user-id" });
}

describe("S3.4 B4 — seedDefaultProfiles upsert semantics", () => {
	test("T1: empty DB → inserts all seed profiles (baseline)", async () => {
		const t = createTestConvex();
		const summary = await asServiceAccount(t).mutation(
			api.oauth.seedDefaultProfiles,
			{},
		);

		expect(summary).toEqual(
			expect.objectContaining({
				inserted: expect.any(Array),
				updated: expect.any(Array),
				skipped: expect.any(Array),
			}),
		);
		const inserted = (summary.inserted as string[]).sort();
		expect(inserted).toEqual(["client-generic", "master", "public-readonly"]);
		expect(summary.updated).toEqual([]);
		expect(summary.skipped).toEqual([]);
	});

	test("T2: re-run with no catalog drift → idempotent, no writes, empty diff", async () => {
		const t = createTestConvex();
		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});

		const second = await asServiceAccount(t).mutation(
			api.oauth.seedDefaultProfiles,
			{},
		);

		expect(second.inserted).toEqual([]);
		expect(second.updated).toEqual([]);
		const skipped = (second.skipped as string[]).sort();
		expect(skipped).toEqual(["client-generic", "master", "public-readonly"]);
	});

	test("T3: existing row drifted from catalog → UPDATES the row (not skip)", async () => {
		const t = createTestConvex();

		// Drifted generic row: a stale pre-catalog-edit production state.
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "client-generic",
				description: "old description",
				fromAllowList: ["someone"],
				namespaceReadPrefixes: ["orchestrator/leak", "global"],
				namespaceWritePrefixes: ["orchestrator/leak"],
				createdAt: now,
				updatedAt: now,
			});
		});

		const summary = await asServiceAccount(t).mutation(
			api.oauth.seedDefaultProfiles,
			{},
		);

		expect(summary.updated as string[]).toContain("client-generic");
		expect(summary.inserted as string[]).not.toContain("client-generic");

		const profile = await asServiceAccount(t).query(api.oauth.getScopeProfile, {
			profileId: "client-generic",
		});
		expect(profile?.fromAllowList).toEqual([]);
		expect(profile?.namespaceReadPrefixes).toEqual([]);
		expect(profile?.namespaceWritePrefixes).toEqual([]);
	});

	test("T4: preserves rows NOT in catalog (no destructive sync)", async () => {
		const t = createTestConvex();

		// Operator-created profile, unrelated to the seed catalog.
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "operator-custom-tenant-x",
				description: "Hand-crafted by operator for tenant X.",
				fromAllowList: ["tenant-x"],
				namespaceReadPrefixes: ["project/tenant-x"],
				namespaceWritePrefixes: ["project/tenant-x"],
				createdAt: now,
				updatedAt: now,
			});
			// Also seed a post-D9-rename row (`iris-rh`) that would normally
			// be re-shadowed by `marie-iris-rh` if the upsert were destructive.
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "iris-rh",
				description: "Renamed post-D9, must survive seed re-runs.",
				fromAllowList: ["marie", "victor"],
				namespaceReadPrefixes: ["orchestrator/marie", "orchestrator/victor"],
				namespaceWritePrefixes: ["orchestrator/marie", "orchestrator/victor"],
				createdAt: now,
				updatedAt: now,
			});
		});

		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});

		const custom = await asServiceAccount(t).query(api.oauth.getScopeProfile, {
			profileId: "operator-custom-tenant-x",
		});
		expect(custom).not.toBeNull();
		expect(custom?.fromAllowList).toEqual(["tenant-x"]);

		const renamed = await asServiceAccount(t).query(api.oauth.getScopeProfile, {
			profileId: "iris-rh",
		});
		expect(renamed).not.toBeNull();
		expect(renamed?.fromAllowList).toEqual(["marie", "victor"]);
	});

	test("T5: upsert preserves _creationTime and patches diff fields only", async () => {
		const t = createTestConvex();

		const originalCreationTime = await t.run(async (ctx) => {
			const id = await ctx.db.insert("oauth_scope_profiles", {
				profileId: "client-generic",
				description: "old description",
				fromAllowList: [],
				namespaceReadPrefixes: ["orchestrator/leak"],
				namespaceWritePrefixes: [],
				createdAt: 1000,
				updatedAt: 1000,
			});
			const row = await ctx.db.get(id);
			return row?._creationTime;
		});

		// Advance fake time so updatedAt is distinguishable.
		vi.setSystemTime(new Date("2026-06-03T12:00:00Z"));

		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});

		const row = await t.run(async (ctx) => {
			return await ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) => q.eq("profileId", "client-generic"))
				.unique();
		});

		expect(row).not.toBeNull();
		expect(row?._creationTime).toBe(originalCreationTime);
		expect(row?.namespaceReadPrefixes).toEqual([]);
		// updatedAt bumped to the patch wall-clock.
		expect(row?.updatedAt).toBeGreaterThan(1000);
	});

	test("T6: writes oauth_audit_log per UPDATE with seed_upsert eventType + before/after", async () => {
		const t = createTestConvex();

		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "client-generic",
				description: "drifted",
				fromAllowList: [],
				namespaceReadPrefixes: ["orchestrator/leak"],
				namespaceWritePrefixes: [],
				createdAt: now,
				updatedAt: now,
			});
		});

		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});

		const auditRows = await t.run(async (ctx) => {
			return await ctx.db.query("oauth_audit_log").collect();
		});

		const seedUpsertRows = auditRows.filter(
			(r: Record<string, unknown>) => r.eventType === "seed_upsert",
		);
		expect(seedUpsertRows).toHaveLength(1);
		const row = seedUpsertRows[0] as Record<string, unknown>;
		expect(row.targetProfileId).toBe("client-generic");
		const prev = row.previousState as Record<string, unknown>;
		const next = row.newState as Record<string, unknown>;
		expect(prev.namespaceReadPrefixes as string[]).toEqual([
			"orchestrator/leak",
		]);
		expect(next.namespaceReadPrefixes as string[]).toEqual([]);
	});

	test("T6b: no audit log entry for no-op idempotent runs", async () => {
		const t = createTestConvex();
		// First run inserts.
		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});
		// Second run should be a pure no-op.
		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});

		const auditRows = await t.run(async (ctx) => {
			return await ctx.db.query("oauth_audit_log").collect();
		});
		const seedUpsertRows = auditRows.filter(
			(r: Record<string, unknown>) => r.eventType === "seed_upsert",
		);
		expect(seedUpsertRows).toHaveLength(0);
	});

	test("T7: still admin gated (rejects an anonymous caller)", async () => {
		const t = createTestConvex();
		await expect(t.mutation(api.oauth.seedDefaultProfiles, {})).rejects.toThrow(
			/RBAC_DENIED/,
		);
	});

	test("T8: idempotency — running upsert twice yields same DB state + same audit count", async () => {
		const t = createTestConvex();
		// Seed an outdated row so the first run produces ONE update.
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "client-generic",
				description: "drifted",
				fromAllowList: [],
				namespaceReadPrefixes: ["orchestrator/leak"],
				namespaceWritePrefixes: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});

		const afterFirst = await t.run(async (ctx) => {
			return {
				profiles: await ctx.db.query("oauth_scope_profiles").collect(),
				audits: (await ctx.db.query("oauth_audit_log").collect()).filter(
					(r: Record<string, unknown>) => r.eventType === "seed_upsert",
				).length,
			};
		});

		const second = await asServiceAccount(t).mutation(
			api.oauth.seedDefaultProfiles,
			{},
		);

		expect(second.inserted).toEqual([]);
		expect(second.updated).toEqual([]);

		const afterSecond = await t.run(async (ctx) => {
			return {
				profiles: await ctx.db.query("oauth_scope_profiles").collect(),
				audits: (await ctx.db.query("oauth_audit_log").collect()).filter(
					(r: Record<string, unknown>) => r.eventType === "seed_upsert",
				).length,
			};
		});

		expect(afterSecond.profiles.length).toBe(afterFirst.profiles.length);
		expect(afterSecond.audits).toBe(afterFirst.audits);
	});
});
