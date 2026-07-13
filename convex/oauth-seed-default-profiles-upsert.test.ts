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
 * Motivation: eliminate bespoke catalog-drift migrations for one-off
 * named-profile remediation — future catalog edits propagate cleanly on
 * deploy via the seed mutation itself.
 *
 * Day 128 (mission k5775bf67eg4202ccy23m976q98aacnc): the seedDefaultProfiles
 * PUBLIC catalog now contains ONLY generic, non-identifying profiles
 * (master, client-generic, public-readonly). These tests exercise the
 * drift-detection/patch mechanics against `public-readonly` — the mechanism
 * is identical for any catalog entry, generic or (separately, via
 * seedPrivateScopeProfiles) private tenant profiles.
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

describe("S3.4 B4 — seedDefaultProfiles upsert semantics", () => {
	test("T1: empty DB → inserts all seed profiles (baseline)", async () => {
		const t = createTestConvex();
		const summary = await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});

		expect(summary).toEqual(
			expect.objectContaining({
				inserted: expect.any(Array),
				updated: expect.any(Array),
				skipped: expect.any(Array),
			}),
		);
		// Public catalog: exactly 3 generic, non-identifying profiles.
		const inserted = (summary.inserted as string[]).sort();
		expect(inserted).toEqual(["client-generic", "master", "public-readonly"]);
		expect(summary.updated).toEqual([]);
		expect(summary.skipped).toEqual([]);
	});

	test("T2: re-run with no catalog drift → idempotent, no writes, empty diff", async () => {
		const t = createTestConvex();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});

		const second = await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});

		expect(second.inserted).toEqual([]);
		expect(second.updated).toEqual([]);
		const skipped = (second.skipped as string[]).sort();
		expect(skipped).toEqual(["client-generic", "master", "public-readonly"]);
	});

	test("T3: existing row drifted from catalog → UPDATES the row (not skip)", async () => {
		const t = createTestConvex();

		// Seed an outdated `public-readonly` row directly into the DB to
		// simulate a pre-catalog-edit production state (missing the
		// `global` read prefix and the `external` allow-list entry).
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "public-readonly",
				description: "old description",
				fromAllowList: [],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				createdAt: now,
				updatedAt: now,
			});
		});

		const summary = await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});

		expect(summary.updated as string[]).toContain("public-readonly");
		expect(summary.inserted as string[]).not.toContain("public-readonly");

		// Verify the row now matches the catalog.
		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: "public-readonly",
		});
		expect(profile?.namespaceReadPrefixes).toContain("global");
		expect(profile?.fromAllowList).toContain("external");
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
			// Also seed a renamed private-tenant profile that would normally be
			// re-shadowed by a stale public-catalog entry if the upsert were
			// destructive (Day 90/128 rename-survivor regression class).
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "tenant-workspace-renamed",
				description: "Renamed post-D9, must survive seed re-runs.",
				fromAllowList: ["tenant-alias", "tenant-peer"],
				namespaceReadPrefixes: [
					"orchestrator/tenant-alias",
					"orchestrator/tenant-peer",
				],
				namespaceWritePrefixes: [
					"orchestrator/tenant-alias",
					"orchestrator/tenant-peer",
				],
				createdAt: now,
				updatedAt: now,
			});
		});

		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});

		const custom = await t.query(api.oauth.getScopeProfile, {
			profileId: "operator-custom-tenant-x",
		});
		expect(custom).not.toBeNull();
		expect(custom?.fromAllowList).toEqual(["tenant-x"]);

		const renamed = await t.query(api.oauth.getScopeProfile, {
			profileId: "tenant-workspace-renamed",
		});
		expect(renamed).not.toBeNull();
		expect(renamed?.fromAllowList).toEqual(["tenant-alias", "tenant-peer"]);
	});

	test("T5: upsert preserves _creationTime and patches diff fields only", async () => {
		const t = createTestConvex();

		// Insert an outdated row with a known creation time.
		const originalCreationTime = await t.run(async (ctx) => {
			const id = await ctx.db.insert("oauth_scope_profiles", {
				profileId: "public-readonly",
				description: "old description",
				fromAllowList: [],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				createdAt: 1000,
				updatedAt: 1000,
			});
			const row = await ctx.db.get(id);
			return row?._creationTime;
		});

		// Advance fake time so updatedAt is distinguishable.
		vi.setSystemTime(new Date("2026-06-03T12:00:00Z"));

		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});

		const row = await t.run(async (ctx) => {
			return await ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) => q.eq("profileId", "public-readonly"))
				.unique();
		});

		expect(row).not.toBeNull();
		expect(row?._creationTime).toBe(originalCreationTime);
		// Catalog content propagated.
		expect(row?.namespaceReadPrefixes).toContain("global");
		// updatedAt bumped to the patch wall-clock.
		expect(row?.updatedAt).toBeGreaterThan(1000);
	});

	test("T6: writes oauth_audit_log per UPDATE with seed_upsert eventType + before/after", async () => {
		const t = createTestConvex();

		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "public-readonly",
				description: "drifted",
				fromAllowList: [],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				createdAt: now,
				updatedAt: now,
			});
		});

		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});

		const auditRows = await t.run(async (ctx) => {
			return await ctx.db.query("oauth_audit_log").collect();
		});

		const seedUpsertRows = auditRows.filter(
			(r: Record<string, unknown>) => r.eventType === "seed_upsert",
		);
		expect(seedUpsertRows).toHaveLength(1);
		const row = seedUpsertRows[0] as Record<string, unknown>;
		expect(row.targetProfileId).toBe("public-readonly");
		const prev = row.previousState as Record<string, unknown>;
		const next = row.newState as Record<string, unknown>;
		expect(prev.namespaceReadPrefixes as string[]).toEqual([]);
		expect(next.namespaceReadPrefixes as string[]).toContain("global");
	});

	test("T6b: no audit log entry for no-op idempotent runs", async () => {
		const t = createTestConvex();
		// First run inserts.
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});
		// Second run should be a pure no-op.
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});

		const auditRows = await t.run(async (ctx) => {
			return await ctx.db.query("oauth_audit_log").collect();
		});
		const seedUpsertRows = auditRows.filter(
			(r: Record<string, unknown>) => r.eventType === "seed_upsert",
		);
		expect(seedUpsertRows).toHaveLength(0);
	});

	test("T7: still admin-master-token gated (rejects invalid token)", async () => {
		const t = createTestConvex();
		await expect(
			t.mutation(api.oauth.seedDefaultProfiles, {
				callerToken: "not-the-master",
			}),
		).rejects.toThrow(/Unauthorized/);
	});

	test("T8: idempotency — running upsert twice yields same DB state + same audit count", async () => {
		const t = createTestConvex();
		// Seed an outdated row so the first run produces ONE update.
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "public-readonly",
				description: "drifted",
				fromAllowList: [],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});

		const afterFirst = await t.run(async (ctx) => {
			return {
				profiles: await ctx.db.query("oauth_scope_profiles").collect(),
				audits: (await ctx.db.query("oauth_audit_log").collect()).filter(
					(r: Record<string, unknown>) => r.eventType === "seed_upsert",
				).length,
			};
		});

		const second = await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});

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
