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
 * The client profile is DATA (a row of oauth_scope_profiles), seeded here by
 * the operator migration `migrations/seed_client_scope_profiles` from the
 * frozen snapshot in tests/fixtures/legacyScopeProfiles.ts, after the real
 * `seedDefaultProfiles` mutation, then asserts BOTH poles against the resulting row using the same
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

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { seedLegacyClientProfiles } from "../../tests/fixtures/legacyScopeProfiles";
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

// getScopeProfile now requires master/service-account scope (SEC fix,
// task-local to convex/__tests__/oauthScopeProfileRead.test.ts) -- this
// fixture mirrors the mcp-server internalClient() service-account identity
// (vitest.config.ts sets CLERK_SERVICE_ACCOUNT_USER_ID to this exact
// subject) so pre-existing test infrastructure that reads a profile's
// fromAllowList/prefixes keeps working without going through anonymous
// access.
function asServiceAccount(t: ReturnType<typeof createT>) {
	return t.withIdentity({ subject: "test-service-account-user-id" });
}

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
		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});
		await seedLegacyClientProfiles(t);

		const profile = await asServiceAccount(t).query(api.oauth.getScopeProfile, {
			profileId: PROFILE_ID,
		});
		expect(profile).not.toBeNull();

		// Catalog-level assertion: the seed itself must not contain the leak.
		expect(profile?.namespaceReadPrefixes).not.toContain("global");
		expect(profile?.namespaceWritePrefixes).not.toContain("global");
	});

	test("DENY pole — AUTH_NAMESPACE_DENIED: profile cannot read 'global'", async () => {
		const t = createT();
		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});
		await seedLegacyClientProfiles(t);
		const profile = await asServiceAccount(t).query(api.oauth.getScopeProfile, {
			profileId: PROFILE_ID,
		});
		expect(profile).not.toBeNull();

		expect(checkNamespacePrefix(profile!.namespaceReadPrefixes, "global")).toBe(
			false,
		); // AUTH_NAMESPACE_DENIED
	});

	test("DENY pole — AUTH_NAMESPACE_DENIED: profile cannot write 'global'", async () => {
		const t = createT();
		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});
		await seedLegacyClientProfiles(t);
		const profile = await asServiceAccount(t).query(api.oauth.getScopeProfile, {
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
		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});
		await seedLegacyClientProfiles(t);
		const profile = await asServiceAccount(t).query(api.oauth.getScopeProfile, {
			profileId: PROFILE_ID,
		});
		expect(profile).not.toBeNull();

		expect(
			checkNamespacePrefix(
				profile!.namespaceReadPrefixes,
				"orchestrator/marie",
			),
		).toBe(true);
		expect(
			checkNamespacePrefix(
				profile!.namespaceWritePrefixes,
				"orchestrator/marie",
			),
		).toBe(true);
	});

	test("ALLOW pole — profile CAN read/write its own second orchestrator seat (orchestrator/victor)", async () => {
		const t = createT();
		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});
		await seedLegacyClientProfiles(t);
		const profile = await asServiceAccount(t).query(api.oauth.getScopeProfile, {
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
		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});
		await seedLegacyClientProfiles(t);
		const profile = await asServiceAccount(t).query(api.oauth.getScopeProfile, {
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
});
