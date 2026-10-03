/// <reference types="vite/client" />
/**
 * Client scope profiles are DATA, not product code.
 *
 *   1. IDENTITY: the grants resolved for every profile that existed in the
 *      pre-migration code catalog (frozen snapshot of origin/main d440b95,
 *      tests/fixtures/legacyScopeProfiles.ts) are byte-identical after the move:
 *      generic ones from code, client ones from rows seeded by
 *      migrations/seed_client_scope_profiles.
 *   2. MIGRATION poles: dry-run writes nothing, apply inserts, re-run is a
 *      no-op, drift is reported and kept unless overwriteDrift, every guard
 *      refuses before any write.
 *   3. GREP PROOF: no client name remains in non-test convex/ or
 *      mcp-server/src sources.
 *
 * AUTH_NAMESPACE_DENIED: the guard poles below assert that a client profile can
 * never be seeded with the shared `global` or wildcard namespace.
 */

import { execFileSync } from "node:child_process";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	LEGACY_CATALOG,
	LEGACY_CLIENT_PROFILES,
	LEGACY_GENERIC_PROFILES,
} from "../../tests/fixtures/legacyScopeProfiles";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

beforeEach(() => {
	vi.stubEnv("BEARER_SECRET_MASTER", "test-master-token-profiles-are-data");
});
afterEach(() => {
	vi.unstubAllEnvs();
});

const createT = () => convexTest(schema, modules);
const asServiceAccount = (t: ReturnType<typeof createT>) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

const seed =
	internal.migrations.seed_client_scope_profiles.seedClientScopeProfiles;

type Resolved = {
	profileId: string;
	description: string;
	fromAllowList: string[];
	namespaceReadPrefixes: string[];
	namespaceWritePrefixes: string[];
	selfRegistrable: boolean;
};

// Canonical, key-ordered projection of a grant: what a consumer resolves.
const canon = (p: {
	profileId: string;
	description: string;
	fromAllowList: string[];
	namespaceReadPrefixes: string[];
	namespaceWritePrefixes: string[];
	selfRegistrable?: boolean;
}): string =>
	JSON.stringify({
		profileId: p.profileId,
		description: p.description,
		fromAllowList: p.fromAllowList,
		namespaceReadPrefixes: p.namespaceReadPrefixes,
		namespaceWritePrefixes: p.namespaceWritePrefixes,
		selfRegistrable: p.selfRegistrable ?? false,
	} satisfies Resolved);

// Resolve what consumers read: the persisted row (selfRegistrable included),
// cross-checked against the public getScopeProfile read for the grant fields.
async function resolve(t: ReturnType<typeof createT>, profileId: string) {
	const row = await t.run(async (ctx) =>
		ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", profileId))
			.unique(),
	);
	if (!row) throw new Error(`profile ${profileId} not resolved`);
	const viaQuery = await asServiceAccount(t).query(api.oauth.getScopeProfile, {
		profileId,
	});
	expect(viaQuery?.fromAllowList).toEqual(row.fromAllowList);
	expect(viaQuery?.namespaceReadPrefixes).toEqual(row.namespaceReadPrefixes);
	expect(viaQuery?.namespaceWritePrefixes).toEqual(row.namespaceWritePrefixes);
	return row;
}

describe("IDENTITY: resolved grants byte-identical before/after (every legacy profile)", () => {
	test("snapshot covers the 6 profiles of the old catalog", () => {
		expect(LEGACY_CATALOG.map((p) => p.profileId)).toHaveLength(6);
		expect(LEGACY_GENERIC_PROFILES.map((p) => p.profileId).sort()).toEqual([
			"client-generic",
			"master",
			"public-readonly",
		]);
		expect(LEGACY_CLIENT_PROFILES).toHaveLength(3);
	});

	test("seed (generic, from code) + migration apply (client, from data) resolves the old catalog exactly", async () => {
		const t = createT();
		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});
		const out = await t.mutation(seed, {
			profiles: LEGACY_CLIENT_PROFILES,
			apply: true,
		});
		expect(out.dryRun).toBe(false);
		expect(out.report.every((r) => r.action === "inserted")).toBe(true);

		for (const before of LEGACY_CATALOG) {
			const after = await resolve(t, before.profileId);
			expect(canon(after), before.profileId).toBe(canon(before));
		}
	});

	test("prod shape: rows already present (seeded by the old code) -> migration is a pure no-op and the new seed leaves them untouched", async () => {
		const t = createT();
		// State of production today: every legacy profile already a row.
		await t.run(async (ctx) => {
			const now = Date.now();
			for (const p of LEGACY_CATALOG) {
				await ctx.db.insert("oauth_scope_profiles", {
					...p,
					createdAt: now,
					updatedAt: now,
				});
			}
		});
		const before = await t.run(async (ctx) =>
			ctx.db.query("oauth_scope_profiles").collect(),
		);

		const audit = await t.mutation(seed, { profiles: LEGACY_CLIENT_PROFILES });
		expect(audit.dryRun).toBe(true);
		expect(audit.report.map((r) => r.status)).toEqual([
			"identical",
			"identical",
			"identical",
		]);

		const s = await asServiceAccount(t).mutation(
			api.oauth.seedDefaultProfiles,
			{},
		);
		expect(s.inserted).toEqual([]);
		expect(s.updated).toEqual([]);
		expect(s.skipped.sort()).toEqual([
			"client-generic",
			"master",
			"public-readonly",
		]);

		const after = await t.run(async (ctx) =>
			ctx.db.query("oauth_scope_profiles").collect(),
		);
		expect(after).toEqual(before); // _id, _creationTime, updatedAt: nothing written
		for (const p of LEGACY_CATALOG) {
			expect(canon(await resolve(t, p.profileId))).toBe(canon(p));
		}
	});

	test("seedDefaultProfiles no longer carries any client profile", async () => {
		const t = createT();
		const s = await asServiceAccount(t).mutation(
			api.oauth.seedDefaultProfiles,
			{},
		);
		expect(s.inserted.sort()).toEqual([
			"client-generic",
			"master",
			"public-readonly",
		]);
		const rows = await t.run(async (ctx) =>
			ctx.db.query("oauth_scope_profiles").collect(),
		);
		expect(rows).toHaveLength(3);
	});
});

describe("MIGRATION seed_client_scope_profiles: dry-run / apply poles", () => {
	test("DRY-RUN (default) writes nothing and reports would-insert", async () => {
		const t = createT();
		const out = await t.mutation(seed, { profiles: LEGACY_CLIENT_PROFILES });
		expect(out.dryRun).toBe(true);
		expect(out.report.map((r) => r.action)).toEqual([
			"would-insert",
			"would-insert",
			"would-insert",
		]);
		const n = await t.run(async (ctx) => ({
			p: (await ctx.db.query("oauth_scope_profiles").collect()).length,
			a: (await ctx.db.query("oauth_audit_log").collect()).length,
		}));
		expect(n).toEqual({ p: 0, a: 0 });
	});

	test("APPLY inserts the rows + one audit row each; a second apply is a no-op", async () => {
		const t = createT();
		await t.mutation(seed, { profiles: LEGACY_CLIENT_PROFILES, apply: true });
		const second = await t.mutation(seed, {
			profiles: LEGACY_CLIENT_PROFILES,
			apply: true,
		});
		expect(second.report.map((r) => r.action)).toEqual([
			"none",
			"none",
			"none",
		]);
		const n = await t.run(async (ctx) => ({
			p: (await ctx.db.query("oauth_scope_profiles").collect()).length,
			a: (await ctx.db.query("oauth_audit_log").collect()).filter(
				(r) => r.eventType === "seed_client_profile",
			).length,
		}));
		expect(n).toEqual({ p: 3, a: 3 });
	});

	test("DRIFT is reported, kept by apply, patched only with overwriteDrift (audited)", async () => {
		const t = createT();
		const target = LEGACY_CLIENT_PROFILES[0];
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("oauth_scope_profiles", {
				...target,
				namespaceReadPrefixes: ["orchestrator/someone-else"],
				createdAt: now,
				updatedAt: now,
			});
		});
		const audit = await t.mutation(seed, { profiles: [target] });
		expect(audit.report[0]).toMatchObject({
			status: "drift",
			action: "would-patch",
			driftedFields: ["namespaceReadPrefixes"],
		});

		const kept = await t.mutation(seed, { profiles: [target], apply: true });
		expect(kept.report[0].action).toBe("drift-kept");
		expect((await resolve(t, target.profileId)).namespaceReadPrefixes).toEqual([
			"orchestrator/someone-else",
		]);

		const patched = await t.mutation(seed, {
			profiles: [target],
			apply: true,
			overwriteDrift: true,
		});
		expect(patched.report[0].action).toBe("patched");
		expect(canon(await resolve(t, target.profileId))).toBe(canon(target));
		const audits = await t.run(async (ctx) =>
			ctx.db.query("oauth_audit_log").collect(),
		);
		expect(audits).toHaveLength(1);
		expect(audits[0].previousState.namespaceReadPrefixes).toEqual([
			"orchestrator/someone-else",
		]);
	});

	const base = LEGACY_CLIENT_PROFILES[0];
	const refused: Array<[string, Record<string, unknown>, RegExp]> = [
		["generic catalog id", { profileId: "master" }, /generic catalog profile/],
		[
			"AUTH_NAMESPACE_DENIED: global read prefix",
			{ namespaceReadPrefixes: ["global"] },
			/^AUTH_NAMESPACE_DENIED: seedClientScopeProfiles: D4 violation/,
		],
		[
			"AUTH_NAMESPACE_DENIED: wildcard write prefix",
			{ namespaceWritePrefixes: ["*"] },
			/^AUTH_NAMESPACE_DENIED: seedClientScopeProfiles: D4 violation/,
		],
		[
			"AUTH_SENDER_WILDCARD_DENIED: wildcard sender",
			{ fromAllowList: ["*"] },
			/^AUTH_SENDER_WILDCARD_DENIED: seedClientScopeProfiles: wildcard sender/,
		],
		["selfRegistrable", { selfRegistrable: true }, /selfRegistrable/],
		["empty profileId", { profileId: " " }, /empty profileId/],
	];
	test.each(refused)("refuses (%s) before any write", async (_n, over, re) => {
		const t = createT();
		await expect(
			t.mutation(seed, {
				profiles: [{ ...base, ...over }],
				apply: true,
			}),
		).rejects.toThrow(re);
		expect(
			await t.run(async (ctx) =>
				ctx.db.query("oauth_scope_profiles").collect(),
			),
		).toHaveLength(0);
	});

	test("all-or-nothing: a bad entry after a good one writes nothing; duplicates refused", async () => {
		const t = createT();
		await expect(
			t.mutation(seed, {
				profiles: [
					base,
					{ ...base, profileId: "x", namespaceReadPrefixes: ["global"] },
				],
				apply: true,
			}),
		).rejects.toThrow(
			/^AUTH_NAMESPACE_DENIED: seedClientScopeProfiles: D4 violation/,
		);
		await expect(
			t.mutation(seed, { profiles: [base, base], apply: true }),
		).rejects.toThrow(/duplicate/);
		expect(
			await t.run(async (ctx) =>
				ctx.db.query("oauth_scope_profiles").collect(),
			),
		).toHaveLength(0);
	});
});

describe("GREP PROOF: no client name in product code", () => {
	test("git grep over non-test convex/ + mcp-server/src finds nothing", () => {
		const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			encoding: "utf8",
		}).trim();
		let out = "";
		try {
			out = execFileSync(
				"git",
				[
					"grep",
					"-niE",
					"iris|hélios|helios|victor|marie|clio",
					"--",
					"convex",
					"mcp-server/src",
					":!**/__tests__/**",
					":!**/test/**",
					":!**/*.test.ts",
					":!convex/_generated/**",
				],
				{ cwd: root, encoding: "utf8" },
			);
		} catch (e) {
			// git grep exits 1 when there is no match: that is the pass.
			if ((e as { status?: number }).status !== 1) throw e;
		}
		expect(out).toBe("");
	});
});
