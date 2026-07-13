/// <reference types="vite/client" />
/**
 * T6/Day128 (mission k5775bf67eg4202ccy23m976q98aacnc) — two invariants:
 *
 * 1. PUBLIC CATALOG CONFIDENTIALITY: `convex/oauth.ts:seedDefaultProfiles`
 *    ships in the public repo (vantageos-agency/vantage-peers). It must
 *    contain ONLY generic, non-identifying profile ids — never a real
 *    client/tenant name. Prior to this fix, the catalog hardcoded named
 *    client profiles (tenant orchestrator personas) directly in source,
 *    leaking confidential client identifiers into the public repo.
 *
 * 2. PRIVATE CATALOG D4 ENFORCEMENT: named-tenant profiles are now
 *    provisioned via `seedPrivateScopeProfiles`, which reads a JSON catalog
 *    from the out-of-repo env var `OAUTH_PRIVATE_SCOPE_PROFILES_JSON`. Any
 *    non-master profile in that private catalog must NEVER carry `global`
 *    or `*` in namespaceReadPrefixes / namespaceWritePrefixes — `global`
 *    carries fleet-wide internal facts (rules, identity, internal feedback)
 *    that a tenant-scoped client must never read or write (Laurent doctrine,
 *    Day 128: tenant orchestrators must have access ONLY to their own org,
 *    NEVER to `global`).
 *
 * This test uses SYNTHETIC placeholder names ("acme-corp" style) — no real
 * client name appears anywhere in this file, keeping it safe for the public
 * repo while still exercising the real mutations end-to-end.
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

// The only profileIds allowed to ship in the PUBLIC seedDefaultProfiles
// catalog. Any profileId outside this set is a confidentiality leak.
const ALLOWED_PUBLIC_PROFILE_IDS = new Set([
	"master",
	"client-generic",
	"public-readonly",
]);

describe("Public catalog must never contain a named-tenant profile", () => {
	test("seedDefaultProfiles only inserts generic, non-identifying profileIds", async () => {
		const t = createTestConvex();
		const summary = await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});

		const allInsertedOrUpdated = [...summary.inserted, ...summary.updated];
		for (const profileId of allInsertedOrUpdated) {
			expect(ALLOWED_PUBLIC_PROFILE_IDS.has(profileId)).toBe(true);
		}

		const allProfiles = await t.run(async (ctx) => {
			return await ctx.db.query("oauth_scope_profiles").collect();
		});
		for (const profile of allProfiles) {
			expect(ALLOWED_PUBLIC_PROFILE_IDS.has(profile.profileId)).toBe(true);
		}
	});
});

describe("Private catalog (seedPrivateScopeProfiles) — D4 enforcement + round-trip", () => {
	test("rejects a private profile carrying `global` in namespaceReadPrefixes", async () => {
		const t = createTestConvex();
		vi.stubEnv(
			"OAUTH_PRIVATE_SCOPE_PROFILES_JSON",
			JSON.stringify([
				{
					profileId: "acme-corp-hr",
					description: "Synthetic test tenant — must be rejected.",
					fromAllowList: ["acme"],
					namespaceReadPrefixes: ["orchestrator/acme", "global"],
					namespaceWritePrefixes: ["orchestrator/acme"],
				},
			]),
		);

		await expect(
			t.mutation(api.oauth.seedPrivateScopeProfiles, {
				callerToken: MASTER_TOKEN,
			}),
		).rejects.toThrow(/D4 violation/);
	});

	test("rejects a private profile carrying `*` in namespaceWritePrefixes", async () => {
		const t = createTestConvex();
		vi.stubEnv(
			"OAUTH_PRIVATE_SCOPE_PROFILES_JSON",
			JSON.stringify([
				{
					profileId: "acme-corp-hr",
					description: "Synthetic test tenant — must be rejected.",
					fromAllowList: ["acme"],
					namespaceReadPrefixes: ["orchestrator/acme"],
					namespaceWritePrefixes: ["*"],
				},
			]),
		);

		await expect(
			t.mutation(api.oauth.seedPrivateScopeProfiles, {
				callerToken: MASTER_TOKEN,
			}),
		).rejects.toThrow(/D4 violation/);
	});

	test("provisions a valid private tenant profile and persists it without `global`/`*`", async () => {
		const t = createTestConvex();
		vi.stubEnv(
			"OAUTH_PRIVATE_SCOPE_PROFILES_JSON",
			JSON.stringify([
				{
					profileId: "acme-corp-hr",
					description:
						"Synthetic test tenant — tenant-scoped, no global access.",
					fromAllowList: ["acme"],
					namespaceReadPrefixes: ["orchestrator/acme", "project/acme"],
					namespaceWritePrefixes: ["orchestrator/acme", "project/acme"],
				},
				{
					profileId: "acme-corp-partner",
					description: "Synthetic second persona sharing acme's workspace.",
					fromAllowList: ["acme", "partner"],
					namespaceReadPrefixes: ["orchestrator/partner", "project/acme"],
					namespaceWritePrefixes: ["orchestrator/partner", "project/acme"],
				},
			]),
		);

		const summary = await t.mutation(api.oauth.seedPrivateScopeProfiles, {
			callerToken: MASTER_TOKEN,
		});
		expect(summary.inserted).toEqual(
			expect.arrayContaining(["acme-corp-hr", "acme-corp-partner"]),
		);

		const rows = await t.run(async (ctx) => {
			return await ctx.db.query("oauth_scope_profiles").collect();
		});
		const hr = rows.find((r) => r.profileId === "acme-corp-hr");
		const partner = rows.find((r) => r.profileId === "acme-corp-partner");
		expect(hr).toBeDefined();
		expect(partner).toBeDefined();

		for (const row of [hr, partner]) {
			for (const p of [
				...(row?.namespaceReadPrefixes ?? []),
				...(row?.namespaceWritePrefixes ?? []),
			]) {
				expect(p).not.toBe("global");
				expect(p).not.toBe("*");
			}
		}

		// Re-running is idempotent (patch-on-diff, no duplicate rows / audit noise).
		const secondRun = await t.mutation(api.oauth.seedPrivateScopeProfiles, {
			callerToken: MASTER_TOKEN,
		});
		expect(secondRun.skipped).toEqual(
			expect.arrayContaining(["acme-corp-hr", "acme-corp-partner"]),
		);
	});

	test("throws an actionable error when OAUTH_PRIVATE_SCOPE_PROFILES_JSON is not configured", async () => {
		const t = createTestConvex();
		await expect(
			t.mutation(api.oauth.seedPrivateScopeProfiles, {
				callerToken: MASTER_TOKEN,
			}),
		).rejects.toThrow(/OAUTH_PRIVATE_SCOPE_PROFILES_JSON/);
	});
});
