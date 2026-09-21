/// <reference types="vite/client" />
// allow-missing-refs: new test file to be created
/**
 * SEC — DCR self-registration accepts only DATA-flagged profiles; client
 * lookup stops disclosing scopeProfile to anonymous/non-master callers.
 *
 * VERIFIED DEFECT (pre-fix): `registerPublicClient` (convex/oauth.ts) is a
 * PUBLIC mutation reachable by any caller holding the deployment URL — no
 * MCP server, no HTTP /register handler, no Clerk session required. Its
 * only refusal was a CODE denylist (`BLOCKED_PUBLIC_DCR_PROFILES = {"master"}`).
 * Any OTHER existing `oauth_scope_profiles` row — including a per-org SEAT
 * profile created by `provisionOrganization` and carrying that seat's full
 * `fromAllowList` — could be requested directly by an anonymous caller.
 * `getClientByClientId` (also PUBLIC) then disclosed `scopeProfile` to
 * anyone who asked, by clientId, with no auth check at all.
 *
 * TRACE (part a of the brief): mcp-server/server-http.ts's POST /token
 * handler resolves `client.scopeProfile` via `oauth:getClientByClientId`
 * and mints the access token with `profile.fromAllowList` copied verbatim
 * (server-http.ts ~L738, ~L770-771). A seat profile requested via a direct
 * anonymous `registerPublicClient` call — bypassing the HTTP /register
 * endpoint's hardcoded `DEFAULT_PUBLIC_DCR_PROFILE = "client-generic"`
 * entirely — would carry the SEAT's fromAllowList into the client row, and
 * `getClientByClientId` disclosed it to anyone. REACHABLE.
 *
 * THE FIX: `oauth_scope_profiles` gets an additive `selfRegistrable`
 * boolean (schema.ts). `registerPublicClient` accepts a profile ONLY when
 * `selfRegistrable === true` on that DATA row — the code denylist is
 * removed entirely (absence-is-deny, not enumeration-is-deny).
 * `getClientByClientId` resolves the caller via `withOrgScope` and refuses
 * (RBAC_DENIED) any non-master caller; the MCP server's internal client
 * always carries the service-account Clerk identity (master, via the
 * by-id carve-out in withOrgScope), so the real token-mint path is
 * unaffected — only a caller with NO identity (or a non-service-account,
 * non-master identity) is refused.
 *
 * RED (this file, run against pre-fix code): the first 3 tests below FAIL
 * — the vulnerable behaviour named in each title is exactly what the
 * pre-fix code allows.
 * GREEN (after the fix): all 7 tests pass, including the two positive
 * poles (a flagged generic profile still self-registers; master/service-
 * account getClientByClientId is unaffected).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
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

const createT = () => convexTest(schema, modules);

// The master service-account carve-out (vitest.config.ts sets
// CLERK_SERVICE_ACCOUNT_USER_ID to this exact subject) — this is the ONLY
// identity the real mcp-server internalClient() ever presents to Convex
// (mcp-server/src/auth.ts's createServiceAccountConvexClient), so it is the
// faithful proxy for "the real token-mint path caller".
function asServiceAccount(t: ReturnType<typeof createT>) {
	return t.withIdentity({ subject: "test-service-account-user-id" });
}

async function seedScopeProfile(
	t: ReturnType<typeof createT>,
	profileId: string,
	opts: { fromAllowList: string[]; selfRegistrable?: boolean },
) {
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId,
			description: `fixture profile ${profileId}`,
			fromAllowList: opts.fromAllowList,
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			...(opts.selfRegistrable !== undefined
				? { selfRegistrable: opts.selfRegistrable }
				: {}),
			createdAt: now,
			updatedAt: now,
		});
	});
}

async function registerClient(
	t: ReturnType<typeof createT>,
	clientId: string,
	scopeProfile: string,
) {
	return t.mutation(api.oauth.registerPublicClient, {
		clientId,
		clientSecretHash: `hash-${clientId}`,
		name: "anonymous-dcr-fixture",
		redirectUris: ["https://example.com/callback"],
		scopeProfile,
	});
}

describe("oauthDcrScope — DCR self-registration is data-flagged, not code-denylisted", () => {
	// ── RED-before-fix pole 1 ────────────────────────────────────────────────
	test("anonymous DCR with a seat profile is accepted", async () => {
		const t = createT();
		// org-a's real per-seat profile — carries org-a's own fromAllowList.
		// selfRegistrable intentionally NOT set (a seat profile must never be
		// self-registrable — it is provisioned via provisionOrganization only).
		await seedScopeProfile(t, "org-a-seat-a", {
			fromAllowList: ["org-a-seat-a"],
		});

		await expect(
			registerClient(t, "client-seat-a", "org-a-seat-a"),
		).rejects.toThrow(/ScopeViolation|self-registrable|not flagged/i);
	});

	// ── RED-before-fix pole 2 ────────────────────────────────────────────────
	test("anonymous DCR with a non-flagged profile is accepted", async () => {
		const t = createT();
		// A profile that exists, is not "master", but is also not flagged
		// self-registrable — must be refused even though the old code's only
		// gate (the "master" denylist) would have let it through.
		await seedScopeProfile(t, "org-b-generic-unflagged", {
			fromAllowList: [],
		});

		await expect(
			registerClient(t, "client-unflagged", "org-b-generic-unflagged"),
		).rejects.toThrow(/ScopeViolation|self-registrable|not flagged/i);
	});

	// ── RED-before-fix pole 3 ────────────────────────────────────────────────
	test("anonymous getClientByClientId returns scopeProfile", async () => {
		const t = createT();
		await seedScopeProfile(t, "client-generic", {
			fromAllowList: [],
			selfRegistrable: true,
		});
		await registerClient(t, "client-anon-lookup", "client-generic");

		// No .withIdentity() applied — models a direct anonymous caller
		// holding only the deployment URL, exactly like the reachability
		// doctrine in allowNoIdentityMaster-reachability.test.ts.
		await expect(
			t.query(api.oauth.getClientByClientId, {
				clientId: "client-anon-lookup",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	// ── GREEN positive pole 1 — the safe generic profile still works ────────
	test("a flagged generic profile still registers anonymously", async () => {
		const t = createT();
		await seedScopeProfile(t, "client-generic", {
			fromAllowList: [],
			selfRegistrable: true,
		});

		const id = await registerClient(t, "client-generic-ok", "client-generic");
		expect(id).toBeTruthy();
	});

	// ── GREEN positive pole 2 — master/service-account still works ──────────
	test("a master or service-account getClientByClientId still returns scopeProfile", async () => {
		const t = createT();
		await seedScopeProfile(t, "client-generic", {
			fromAllowList: [],
			selfRegistrable: true,
		});
		await registerClient(t, "client-service-lookup", "client-generic");

		const result = await asServiceAccount(t).query(api.oauth.getClientByClientId, {
			clientId: "client-service-lookup",
		});
		expect(result).not.toBeNull();
		expect(result?.scopeProfile).toBe("client-generic");
	});

	// ── Additional coverage — unknown profile still refused (unchanged) ─────
	test("unknown scope_profile is refused (unchanged pre-existing behaviour)", async () => {
		const t = createT();
		await expect(
			registerClient(t, "client-unknown-profile", "does-not-exist"),
		).rejects.toThrow(/Unknown scope_profile/);
	});

	// ── Additional coverage — the post-deploy operator mutation ─────────────
	test("setProfileSelfRegistrable flips the flag on an existing profile (operator path)", async () => {
		const t = createT();
		await seedScopeProfile(t, "client-generic", {
			fromAllowList: [],
			// Not flagged yet — models the pre-flag window right after deploy.
		});

		await expect(
			registerClient(t, "client-pre-flag", "client-generic"),
		).rejects.toThrow(/ScopeViolation|self-registrable|not flagged/i);

		await t.mutation(internal.oauth.setProfileSelfRegistrable, {
			profileId: "client-generic",
			value: true,
		});

		const id = await registerClient(t, "client-post-flag", "client-generic");
		expect(id).toBeTruthy();
	});
});
