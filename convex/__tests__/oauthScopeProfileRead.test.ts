/// <reference types="vite/client" />
// allow-missing-refs: new test file to be created
/**
 * SEC — `oauth:getScopeProfile` refuses anonymous and org-scoped callers;
 * only master/service-account scope may read a profile's `fromAllowList`
 * and namespace prefixes.
 *
 * VERIFIED DEFECT (pre-fix): `getScopeProfile` (convex/oauth.ts) is a
 * PUBLIC query with no auth check at all. Per-seat profiles minted by
 * `provisionOrganization` are named `<seat>-<org>` (see fromAllowList,
 * namespaceReadPrefixes/namespaceWritePrefixes on that seat profile row),
 * so ANY anonymous caller holding the deployment URL could enumerate an
 * organisation's seats and namespaces by requesting profileId strings —
 * guessed or brute-forced — with zero auth.
 *
 * TRACE: mcp-server/server-http.ts's `loadScopeProfile` is the ONLY
 * production caller, reached exclusively through `internalClient()` (the
 * MCP server's service-account Clerk identity — see
 * mcp-server/src/auth.ts's `buildInternalClient`/`createServiceAccountConvexClient`),
 * which `withOrgScope` resolves to `isMaster=true` via the by-id
 * `CLERK_SERVICE_ACCOUNT_USER_ID` carve-out. No org-scoped (non-master)
 * caller of this query exists anywhere in this repo — confirmed by
 * `grep -rn "oauth:getScopeProfile|getScopeProfile" mcp-server/ --include=*.ts | grep -v dist`,
 * which surfaces only `server-http.ts`'s `loadScopeProfile` and its own
 * test double.
 *
 * THE FIX: `getScopeProfile` resolves the caller via `withOrgScope` and
 * refuses (RBAC_DENIED) any caller that does not resolve to master scope —
 * the same refusal shape #1317 applied to `getClientByClientId`. Org-scoped
 * callers are refused ENTIRELY (not narrowed to "their own org's
 * profiles"): there is no real org-scoped consumer today, so narrowing
 * would open a surface with zero legitimate callers.
 *
 * RED (this file, run against pre-fix code — md5 faf0ee5cfe56d8308768c0733f1086f6):
 * the first 2 tests below FAIL — the vulnerable behaviour named in each
 * title is exactly what the pre-fix code allows.
 * GREEN (after the fix — md5 d8b30e02ec44e7397558328be5ec0a09): all 4 tests
 * pass, including the master/service-account positive pole.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const MASTER_TOKEN = "test-master-token-oauth-scope-profile-read-deadbeef";

beforeEach(() => {
	vi.stubEnv("BEARER_SECRET_MASTER", MASTER_TOKEN);
});
afterEach(() => {
	vi.unstubAllEnvs();
});

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

// The master service-account carve-out (vitest.config.ts sets
// CLERK_SERVICE_ACCOUNT_USER_ID to this exact subject) — this is the ONLY
// identity the real mcp-server internalClient() ever presents to Convex
// (mcp-server/src/auth.ts's createServiceAccountConvexClient), so it is the
// faithful proxy for "the real getScopeProfile caller" (loadScopeProfile).
function asServiceAccount(t: ReturnType<typeof createT>) {
	return t.withIdentity({ subject: "test-service-account-user-id" });
}

// org-a — an org-scoped, NON-master Clerk identity (client_org_mapping row
// required for withOrgScope to resolve it instead of RBAC_DENYing on an
// unmapped org). Fictitious identifier, mirrors oauthDcrScope.test.ts's
// asOrgA pattern.
async function seedOrgAMapping(t: ReturnType<typeof createT>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["seat-a"],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

function asOrgA(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
	} as Parameters<typeof t.withIdentity>[0]);
}

async function seedSeatProfile(
	t: ReturnType<typeof createT>,
	profileId: string,
	opts: { fromAllowList: string[]; clerkOrgSlug: string },
) {
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId,
			description: `fixture seat profile ${profileId}`,
			fromAllowList: opts.fromAllowList,
			namespaceReadPrefixes: [`orchestrator/${opts.fromAllowList[0]}`],
			namespaceWritePrefixes: [`orchestrator/${opts.fromAllowList[0]}`],
			clerkOrgSlug: opts.clerkOrgSlug,
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe("oauthScopeProfileRead — getScopeProfile requires master or service-account scope", () => {
	// ── RED-before-fix pole 1 ────────────────────────────────────────────────
	test("anonymous getScopeProfile is refused", async () => {
		const t = createT();
		// org-b's real per-seat profile — carries org-b's own fromAllowList +
		// namespace prefixes, exactly the seat data an anonymous enumeration
		// attack would harvest.
		await seedSeatProfile(t, "seat-b-org-b", {
			fromAllowList: ["seat-b"],
			clerkOrgSlug: "org-b",
		});

		// No .withIdentity() applied — models a direct anonymous caller
		// holding only the deployment URL.
		await expect(
			t.query(api.oauth.getScopeProfile, { profileId: "seat-b-org-b" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	// ── RED-before-fix pole 2 ────────────────────────────────────────────────
	test("org-a reading org-b's seat profile is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedSeatProfile(t, "seat-b-org-b", {
			fromAllowList: ["seat-b"],
			clerkOrgSlug: "org-b",
		});

		await expect(
			asOrgA(t).query(api.oauth.getScopeProfile, {
				profileId: "seat-b-org-b",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	// ── GREEN positive pole — master/service-account still works ────────────
	test("a master or service-account caller still reads fromAllowList", async () => {
		const t = createT();
		await seedSeatProfile(t, "seat-a-org-a", {
			fromAllowList: ["seat-a"],
			clerkOrgSlug: "org-a",
		});

		const result = await asServiceAccount(t).query(api.oauth.getScopeProfile, {
			profileId: "seat-a-org-a",
		});
		expect(result).not.toBeNull();
		expect(result?.fromAllowList).toEqual(["seat-a"]);
	});

	// ── Additional coverage — unknown profile still returns null (unchanged) ─
	test("master caller reading an unknown profileId gets null, not an error", async () => {
		const t = createT();
		const result = await asServiceAccount(t).query(api.oauth.getScopeProfile, {
			profileId: "does-not-exist",
		});
		expect(result).toBeNull();
	});

	// ── O1 mutant kill — org-a reading its OWN seat profile must ALSO be
	// refused (this query is master-only, full stop — not "master or own
	// org"). A mutant that widens the refusal to "deny only cross-org reads"
	// would let this test's caller through; it must go RED under that mutant.
	test("org-a reading its OWN seat profile is refused (master-only, not own-org-allowed)", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedSeatProfile(t, "seat-a-org-a", {
			fromAllowList: ["seat-a"],
			clerkOrgSlug: "org-a",
		});

		await expect(
			asOrgA(t).query(api.oauth.getScopeProfile, {
				profileId: "seat-a-org-a",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});
