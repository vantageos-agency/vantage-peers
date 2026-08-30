/// <reference types="vite/client" />
/**
 * AUTH_NAMESPACE_DENIED — marie-iris-rh cross-tenant / global namespace leak
 * fix (bipolar deny test).
 *
 * Pi ORDER (operator-authorized, task k173wamy80xmz2z9761d616ybh87zhf7):
 * the `marie-iris-rh` scope_profile granted read AND write on `global` and
 * `orchestrator/victor` — VantagePeers is sold multi-organisation and this
 * breaks that promise. Root cause was the CATALOG SEED
 * (convex/oauth.ts seedDefaultProfiles) defining marie-iris-rh WITH those
 * prefixes; since seedDefaultProfiles is catalog-SSOT (UPSERT re-patches any
 * drifted row back to the seed), a manual dashboard drop was re-clobbered.
 *
 * This test seeds the catalog via the real `seedDefaultProfiles` mutation
 * (not a hand-rolled fixture) so it exercises the actual production seed
 * path, then asserts BOTH poles against the resulting marie-iris-rh row
 * using the same slash-boundary prefix-match semantics as the enforcement
 * gate (`checkNamespacePrefix` in mcp-server/src/auth.ts — reimplemented
 * here verbatim since convex/__tests__ cannot import across the mcp-server
 * package boundary):
 *
 *   DENY pole  — marie-iris-rh cannot read/write `global` or
 *                `orchestrator/victor` (AUTH_NAMESPACE_DENIED / cross-tenant
 *                deny).
 *   ALLOW pole — marie-iris-rh CAN read/write its own `orchestrator/marie`
 *                and `project/marie` namespaces.
 *
 * RED-before / GREEN-after: before this fix, convex/oauth.ts:118..134 listed
 * `namespaceReadPrefixes: ["orchestrator/marie","orchestrator/victor",
 * "project/marie","global"]` (and the same for write) — the DENY-pole
 * assertions below (`checkNamespacePrefix(...) === false` for "global" and
 * "orchestrator/victor") would have FAILED (both resolved `true`) against
 * that catalog. After the fix (this PR), those prefixes are removed from
 * the marie-iris-rh entry and the DENY-pole assertions pass (RED→GREEN,
 * confirmed by running this suite against the pre-fix oauth.ts via
 * `git stash` and observing the two DENY-pole expectations fail).
 *
 * Hook signal: the literal string AUTH_NAMESPACE_DENIED appears in this
 * file's descriptions/assertions — required by
 * enforce-rag-namespace-deny-test for any commit touching convex/oauth.ts.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const MASTER_TOKEN = "test-master-token-marie-iris-rh-leak-fix-deadbeef";

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

describe("AUTH_NAMESPACE_DENIED — marie-iris-rh catalog no longer leaks global/victor", () => {
	test("seedDefaultProfiles catalog entry for marie-iris-rh excludes global and orchestrator/victor", async () => {
		const t = createT();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});

		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: "marie-iris-rh",
		});
		expect(profile).not.toBeNull();

		// Catalog-level assertion: the seed itself must not contain the leak.
		expect(profile?.namespaceReadPrefixes).not.toContain("global");
		expect(profile?.namespaceReadPrefixes).not.toContain("orchestrator/victor");
		expect(profile?.namespaceWritePrefixes).not.toContain("global");
		expect(profile?.namespaceWritePrefixes).not.toContain(
			"orchestrator/victor",
		);
	});

	test("DENY pole — AUTH_NAMESPACE_DENIED: marie-iris-rh cannot read 'global'", async () => {
		const t = createT();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});
		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: "marie-iris-rh",
		});
		expect(profile).not.toBeNull();

		expect(
			checkNamespacePrefix(profile!.namespaceReadPrefixes, "global"),
		).toBe(false); // AUTH_NAMESPACE_DENIED
	});

	test("DENY pole — AUTH_NAMESPACE_DENIED: marie-iris-rh cannot write 'global'", async () => {
		const t = createT();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});
		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: "marie-iris-rh",
		});
		expect(profile).not.toBeNull();

		expect(
			checkNamespacePrefix(profile!.namespaceWritePrefixes, "global"),
		).toBe(false); // AUTH_NAMESPACE_DENIED
	});

	test("DENY pole — AUTH_NAMESPACE_DENIED: marie-iris-rh cannot read another org's orchestrator/victor namespace", async () => {
		const t = createT();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});
		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: "marie-iris-rh",
		});
		expect(profile).not.toBeNull();

		expect(
			checkNamespacePrefix(
				profile!.namespaceReadPrefixes,
				"orchestrator/victor",
			),
		).toBe(false); // AUTH_NAMESPACE_DENIED — cross-tenant deny
	});

	test("DENY pole — AUTH_NAMESPACE_DENIED: marie-iris-rh cannot write another org's orchestrator/victor namespace", async () => {
		const t = createT();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});
		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: "marie-iris-rh",
		});
		expect(profile).not.toBeNull();

		expect(
			checkNamespacePrefix(
				profile!.namespaceWritePrefixes,
				"orchestrator/victor",
			),
		).toBe(false); // AUTH_NAMESPACE_DENIED — cross-tenant deny
	});

	test("ALLOW pole — marie-iris-rh CAN read/write its own orchestrator/marie namespace", async () => {
		const t = createT();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});
		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: "marie-iris-rh",
		});
		expect(profile).not.toBeNull();

		expect(
			checkNamespacePrefix(profile!.namespaceReadPrefixes, "orchestrator/marie"),
		).toBe(true);
		expect(
			checkNamespacePrefix(
				profile!.namespaceWritePrefixes,
				"orchestrator/marie",
			),
		).toBe(true);
	});

	test("ALLOW pole — marie-iris-rh CAN read/write its own project/marie namespace", async () => {
		const t = createT();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: MASTER_TOKEN,
		});
		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: "marie-iris-rh",
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
