/// <reference types="vite/client" />
/**
 * T6 (mission k5775bf67eg4202ccy23m976q98aacnc) — invariant: Marie / Iris RH /
 * Victor / persona (Clio, Hélios) oauth_scope_profiles rows must NEVER carry
 * `global` or `*` in namespaceReadPrefixes / namespaceWritePrefixes.
 *
 * Laurent verbatim (Day 128 follow-up): "Marie et ses orchestrateurs ne
 * doivent avoir accès QU'À leur org, PAS global". `global` carries fleet-wide
 * internal facts (rules, Laurent identity, internal feedback) — an external
 * client (Iris RH) must never read or write it.
 *
 * ROOT CAUSE (measured, not assumed): the `convex/oauth.ts:seedDefaultProfiles`
 * catalog is the SSOT (S3.4 B4 doctrine — patch-on-diff upsert re-applies the
 * catalog on every run). The `marie-iris-rh` catalog entry STILL lists
 * `"global"` in both namespaceReadPrefixes and namespaceWritePrefixes. Even
 * though `convex/migrations/patch_marie_iris_rh_scope.ts` (Day 90) removes
 * `global` from an already-migrated row and renames it to `iris-rh`, any
 * subsequent `seedDefaultProfiles` run (redeploy, admin re-seed) will
 * RE-INSERT a fresh `marie-iris-rh` row carrying `global` again, because the
 * old profileId no longer exists in the DB after the rename. The migration
 * alone does not close the gap — the catalog itself must stop seeding
 * `global` for Marie/Iris-RH profiles.
 *
 * This test seeds the CURRENT catalog (via the real seedDefaultProfiles
 * mutation, in-memory convex-test — no prod) and asserts the invariant on
 * every persisted profile whose profileId or fromAllowList references
 * marie / iris-rh / victor / clio / hélios.
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

const MARIE_PERSONA_TOKENS = [
	"marie",
	"iris-rh",
	"iris rh",
	"irisrh",
	"victor",
	"clio",
	"helios",
	"hélios",
];

function isMariePersonaProfile(profile: {
	profileId: string;
	fromAllowList: string[];
}): boolean {
	const haystack = [profile.profileId, ...profile.fromAllowList]
		.join(" ")
		.toLowerCase();
	return MARIE_PERSONA_TOKENS.some((token) => haystack.includes(token));
}

describe("T6 — Marie/Iris-RH/Victor/persona profiles must never carry global or *", () => {
	test("seedDefaultProfiles catalog: no marie/iris-rh/victor/persona profile contains global or * in read/write prefixes", async () => {
		const t = createTestConvex();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});

		const allProfiles = await t.run(async (ctx) => {
			return await ctx.db.query("oauth_scope_profiles").collect();
		});

		const marieProfiles = allProfiles.filter(isMariePersonaProfile);

		// Sanity: we must actually be exercising at least the known Marie/Iris-RH
		// profiles seeded by the catalog, otherwise this assertion is vacuous.
		expect(marieProfiles.length).toBeGreaterThanOrEqual(3);

		const violations: Array<{
			profileId: string;
			field: "namespaceReadPrefixes" | "namespaceWritePrefixes";
			value: string;
		}> = [];

		for (const profile of marieProfiles) {
			for (const p of profile.namespaceReadPrefixes) {
				if (p === "global" || p === "*") {
					violations.push({
						profileId: profile.profileId,
						field: "namespaceReadPrefixes",
						value: p,
					});
				}
			}
			for (const p of profile.namespaceWritePrefixes) {
				if (p === "global" || p === "*") {
					violations.push({
						profileId: profile.profileId,
						field: "namespaceWritePrefixes",
						value: p,
					});
				}
			}
		}

		expect(violations).toEqual([]);
	});
});
