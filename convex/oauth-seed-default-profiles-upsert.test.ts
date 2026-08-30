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
 * Motivation: eliminate the bespoke catalog-drift migration pattern shown in
 * `convex/migrations/patch_marie_iris_rh_scope.ts` — future catalog edits
 * propagate cleanly on deploy via the seed mutation itself.
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
		// Catalog now contains 6 seed profiles (clio-iris-rh + helios-iris-rh added
		// for Marie's Iris RH trio). The 4 original profiles must all be present.
		const inserted = (summary.inserted as string[]).sort();
		expect(inserted).toContain("master");
		expect(inserted).toContain("marie-iris-rh");
		expect(inserted).toContain("client-generic");
		expect(inserted).toContain("public-readonly");
		expect(inserted.length).toBeGreaterThanOrEqual(4);
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
		// All catalog profiles must appear in skipped (≥4 originals).
		const skipped = (second.skipped as string[]).sort();
		expect(skipped).toContain("master");
		expect(skipped).toContain("marie-iris-rh");
		expect(skipped).toContain("client-generic");
		expect(skipped).toContain("public-readonly");
		expect(skipped.length).toBeGreaterThanOrEqual(4);
	});

	test("T3: existing row drifted from catalog → UPDATES the row (not skip)", async () => {
		const t = createTestConvex();

		// Seed an outdated `marie-iris-rh` row directly into the DB to simulate
		// a pre-catalog-edit production state (e.g. missing the Day 88 victor
		// orchestrator prefix).
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "marie-iris-rh",
				description: "old description",
				fromAllowList: ["marie"],
				namespaceReadPrefixes: ["orchestrator/marie", "global"],
				namespaceWritePrefixes: ["orchestrator/marie"],
				createdAt: now,
				updatedAt: now,
			});
		});

		const summary = await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});

		expect(summary.updated as string[]).toContain("marie-iris-rh");
		expect(summary.inserted as string[]).not.toContain("marie-iris-rh");

		// Verify the row now matches the catalog. Leak fix (task
		// k173wamy80xmz2z9761d616ybh87zhf7): the catalog no longer carries
		// orchestrator/victor or global for marie-iris-rh — bounded to her
		// own org (orchestrator/marie + project/marie) only.
		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: "marie-iris-rh",
		});
		expect(profile?.namespaceReadPrefixes).toContain("orchestrator/marie");
		expect(profile?.namespaceReadPrefixes).toContain("project/marie");
		expect(profile?.namespaceReadPrefixes).not.toContain("orchestrator/victor");
		expect(profile?.namespaceReadPrefixes).not.toContain("global");
		expect(profile?.namespaceWritePrefixes).not.toContain(
			"orchestrator/victor",
		);
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

		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});

		const custom = await t.query(api.oauth.getScopeProfile, {
			profileId: "operator-custom-tenant-x",
		});
		expect(custom).not.toBeNull();
		expect(custom?.fromAllowList).toEqual(["tenant-x"]);

		const renamed = await t.query(api.oauth.getScopeProfile, {
			profileId: "iris-rh",
		});
		expect(renamed).not.toBeNull();
		expect(renamed?.fromAllowList).toEqual(["marie", "victor"]);
	});

	test("T5: upsert preserves _creationTime and patches diff fields only", async () => {
		const t = createTestConvex();

		// Insert an outdated row with a known creation time.
		const originalCreationTime = await t.run(async (ctx) => {
			const id = await ctx.db.insert("oauth_scope_profiles", {
				profileId: "marie-iris-rh",
				description: "old description",
				fromAllowList: ["marie"],
				namespaceReadPrefixes: ["orchestrator/marie"],
				namespaceWritePrefixes: ["orchestrator/marie"],
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
				.withIndex("by_profileId", (q) => q.eq("profileId", "marie-iris-rh"))
				.unique();
		});

		expect(row).not.toBeNull();
		expect(row?._creationTime).toBe(originalCreationTime);
		// Catalog content propagated. Leak fix (task
		// k173wamy80xmz2z9761d616ybh87zhf7): marie-iris-rh no longer carries
		// orchestrator/victor or global — bounded to her own org.
		expect(row?.namespaceReadPrefixes).toContain("orchestrator/marie");
		expect(row?.namespaceReadPrefixes).not.toContain("orchestrator/victor");
		expect(row?.namespaceReadPrefixes).not.toContain("global");
		// updatedAt bumped to the patch wall-clock.
		expect(row?.updatedAt).toBeGreaterThan(1000);
	});

	test("T6: writes oauth_audit_log per UPDATE with seed_upsert eventType + before/after", async () => {
		const t = createTestConvex();

		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "marie-iris-rh",
				description: "drifted",
				fromAllowList: ["marie"],
				namespaceReadPrefixes: ["orchestrator/marie"],
				namespaceWritePrefixes: ["orchestrator/marie"],
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
		expect(row.targetProfileId).toBe("marie-iris-rh");
		const prev = row.previousState as Record<string, unknown>;
		const next = row.newState as Record<string, unknown>;
		expect(prev.namespaceReadPrefixes as string[]).toEqual([
			"orchestrator/marie",
		]);
		// Leak fix (task k173wamy80xmz2z9761d616ybh87zhf7): the catalog no
		// longer propagates orchestrator/victor or global for marie-iris-rh.
		expect(next.namespaceReadPrefixes as string[]).toContain(
			"orchestrator/marie",
		);
		expect(next.namespaceReadPrefixes as string[]).not.toContain(
			"orchestrator/victor",
		);
		expect(next.namespaceReadPrefixes as string[]).not.toContain("global");
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
				profileId: "marie-iris-rh",
				description: "drifted",
				fromAllowList: ["marie"],
				namespaceReadPrefixes: ["orchestrator/marie"],
				namespaceWritePrefixes: ["orchestrator/marie"],
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
