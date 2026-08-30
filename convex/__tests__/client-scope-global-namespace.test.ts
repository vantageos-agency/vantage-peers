/// <reference types="vite/client" />
/**
 * AUTH_NAMESPACE_DENIED — a client scope profile no longer leaks the
 * fleet-common `global` namespace (bipolar test: DENY global, ALLOW the
 * profile's own namespaces).
 *
 * Pi ORDER (operator-authorized, task k173wamy80xmz2z9761d616ybh87zhf7),
 * REWORKED per operator countermand: the ONLY leak is the fleet-common
 * `global` prefix. This client's own second orchestrator seat is a
 * LEGITIMATE access and must be ALLOWED, not denied — removing it would be a
 * service interruption the operator forbids.
 *
 * Root cause was the CATALOG SEED (convex/oauth.ts seedDefaultProfiles)
 * defining the profile WITH the `global` prefix; since seedDefaultProfiles is
 * catalog-SSOT (UPSERT re-patches any drifted row back to the seed), a
 * manual dashboard drop was re-clobbered.
 *
 * This test seeds the catalog via the real `seedDefaultProfiles` mutation
 * (not a hand-rolled fixture) so it exercises the actual production seed
 * path, then asserts BOTH poles against the resulting row using the same
 * slash-boundary prefix-match semantics as the enforcement gate
 * (`checkNamespacePrefix` in mcp-server/src/auth.ts — reimplemented here
 * verbatim since convex/__tests__ cannot import across the mcp-server
 * package boundary):
 *
 *   DENY pole  — the profile cannot read/write `global` (AUTH_NAMESPACE_DENIED).
 *   ALLOW pole — the profile CAN read/write its own orchestrator seats
 *                (including its second orchestrator seat) and project
 *                namespace — the granted right must actually produce access.
 *
 * RED-before / GREEN-after: before this fix, the catalog listed `"global"` in
 * both prefix arrays for this profile — the DENY-pole assertions below
 * (`checkNamespacePrefix(...) === false` for "global") would have FAILED
 * (resolved `true`) against that catalog. After the fix, `global` is removed
 * and the DENY-pole assertions pass (RED→GREEN, confirmed by running this
 * suite against the pre-fix oauth.ts via `git stash` and observing the
 * DENY-pole expectations fail).
 *
 * Hook signal: the literal string AUTH_NAMESPACE_DENIED appears in this
 * file's descriptions/assertions — required by
 * enforce-rag-namespace-deny-test for any commit touching convex/oauth.ts.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

const MASTER_TOKEN = "test-master-token-client-scope-global-fix-deadbeef";
const PROFILE_ID = "marie-iris-rh";

beforeEach(() => {
	vi.stubEnv("BEARER_SECRET_MASTER", MASTER_TOKEN);
});
afterEach(() => {
	vi.unstubAllEnvs();
});

const createT = () => convexTest(schema, modules);

/**
 * Verbatim mirror of `checkNamespacePrefix` (mcp-server/src/auth.ts:380-390).
 * A prefix of "*" means any namespace; otherwise the target namespace must
 * equal or slash-boundary-start-with one of the prefixes. Re-implemented
 * here (not imported) because convex/__tests__ cannot cross the mcp-server
 * package boundary — this mirrors production enforcement semantics exactly
 * so the assertions below are a faithful proxy for the real gate.
 */
function checkNamespacePrefix(prefixes: string[], namespace: string): boolean {
	if (prefixes.includes("*")) return true;
	for (const p of prefixes) {
		if (namespace === p) return true;
		if (namespace.startsWith(`${p}/`)) return true;
	}
	return false;
}

describe("AUTH_NAMESPACE_DENIED — client scope profile no longer leaks the global namespace", () => {
	test("seedDefaultProfiles catalog entry excludes global", async () => {
		const t = createT();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});

		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: PROFILE_ID,
		});
		expect(profile).not.toBeNull();

		// Catalog-level assertion: the seed itself must not contain the leak.
		expect(profile?.namespaceReadPrefixes).not.toContain("global");
		expect(profile?.namespaceWritePrefixes).not.toContain("global");
	});

	test("DENY pole — AUTH_NAMESPACE_DENIED: profile cannot read 'global'", async () => {
		const t = createT();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});
		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: PROFILE_ID,
		});
		expect(profile).not.toBeNull();

		expect(
			checkNamespacePrefix(profile!.namespaceReadPrefixes, "global"),
		).toBe(false); // AUTH_NAMESPACE_DENIED
	});

	test("DENY pole — AUTH_NAMESPACE_DENIED: profile cannot write 'global'", async () => {
		const t = createT();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});
		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: PROFILE_ID,
		});
		expect(profile).not.toBeNull();

		expect(
			checkNamespacePrefix(profile!.namespaceWritePrefixes, "global"),
		).toBe(false); // AUTH_NAMESPACE_DENIED
	});

	// ── ALLOW poles ──────────────────────────────────────────────────────────
	// Flipped from the prior (over-removed) branch: this client's second
	// orchestrator seat is a LEGITIMATE access, not a cross-tenant leak. The
	// granted right must actually produce access — a profile that merely
	// lacks the DENY entry is not sufficient; the ALLOW must resolve true.

	test("ALLOW pole — profile CAN read/write its own orchestrator seat (primary)", async () => {
		const t = createT();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});
		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: PROFILE_ID,
		});
		expect(profile).not.toBeNull();

		expect(
			checkNamespacePrefix(profile!.namespaceReadPrefixes, "orchestrator/marie"),
		).toBe(true);
		expect(
			checkNamespacePrefix(profile!.namespaceWritePrefixes, "orchestrator/marie"),
		).toBe(true);
	});

	test("ALLOW pole — profile CAN read/write its own second orchestrator seat (orchestrator/victor)", async () => {
		const t = createT();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});
		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: PROFILE_ID,
		});
		expect(profile).not.toBeNull();

		// This is the flipped pole: the prior branch wrongly asserted DENY here.
		// The right is legitimate and must actually produce access.
		expect(
			checkNamespacePrefix(
				profile!.namespaceReadPrefixes,
				"orchestrator/victor",
			),
		).toBe(true);
		expect(
			checkNamespacePrefix(
				profile!.namespaceWritePrefixes,
				"orchestrator/victor",
			),
		).toBe(true);
	});

	test("ALLOW pole — profile CAN read/write its project namespace", async () => {
		const t = createT();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});
		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: PROFILE_ID,
		});
		expect(profile).not.toBeNull();

		expect(
			checkNamespacePrefix(profile!.namespaceReadPrefixes, "project/marie"),
		).toBe(true);
		expect(
			checkNamespacePrefix(profile!.namespaceWritePrefixes, "project/marie"),
		).toBe(true);
	});

	// ── Token-level test ─────────────────────────────────────────────────────
	// A live oauth_access_tokens row snapshotted with the OLD (leaky) prefixes
	// must, after the migration loop runs, no longer carry `global` — and
	// must NOT be revoked (same token, same session, same expiry).
	test("migration loop patches a live token snapshot in place, drops global, never revokes", async () => {
		const t = createT();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});

		// Insert a live access token row with the OLD leaky prefixes, as if
		// minted before the catalog fix.
		const now = Date.now();
		const tokenId = await t.run(async (ctx) => {
			return await ctx.db.insert("oauth_access_tokens", {
				tokenHash: "test-token-hash-pre-fix",
				clientId: "test-client-id",
				userId: "marie",
				scopes: ["mcp:full"],
				scopeProfile: PROFILE_ID,
				fromAllowList: ["marie"],
				namespaceReadPrefixes: [
					"orchestrator/marie",
					"orchestrator/victor",
					"project/marie",
					"global",
				],
				namespaceWritePrefixes: [
					"orchestrator/marie",
					"orchestrator/victor",
					"project/marie",
					"global",
				],
				expiresAt: now + 3600 * 1000,
				createdAt: now,
			});
		});

		const result = await t.mutation(
			internal.migrations.drop_client_scope_global_prefix
				.dropClientScopeGlobalPrefix,
			{},
		);

		expect(result.accessTokensPatched).toBeGreaterThanOrEqual(1);

		const patched = await t.run(async (ctx) => ctx.db.get(tokenId));
		expect(patched).not.toBeNull();
		expect(patched!.namespaceReadPrefixes).not.toContain("global");
		expect(patched!.namespaceWritePrefixes).not.toContain("global");
		expect(patched!.namespaceReadPrefixes).toContain("orchestrator/victor");
		// Never revoked — same token, same session, same expiry.
		expect(patched!.revokedAt).toBeUndefined();
		expect(patched!.expiresAt).toBe(now + 3600 * 1000);
		expect(patched!.tokenHash).toBe("test-token-hash-pre-fix");
	});
});
