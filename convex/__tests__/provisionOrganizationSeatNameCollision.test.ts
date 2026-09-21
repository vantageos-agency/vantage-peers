/// <reference types="vite/client" />
/**
 * Seat-name collision — provisionOrganization must refuse a seat name that
 * ANOTHER org (or the operator's own fleet) already holds.
 *
 * Defect: `provisionOrganization` (convex/oauth.ts) checks orchestrator-name
 * uniqueness only WITHIN one call and one clerkOrgSlug (the `seen` Set and
 * the per-slug `existing` row). Nothing consults any OTHER org's
 * `client_org_mapping.allowedOrchestrators` or any other org's
 * `oauth_scope_profiles.fromAllowList` before minting
 * `namespaceReadPrefixes`/`namespaceWritePrefixes` = [`orchestrator/<name>`,
 * `project/<slug>`]. `orchestrator/<name>` is NOT org-qualified, so two
 * different orgs provisioning the same seat name both receive read/write on
 * the identical namespace prefix.
 *
 * THE PROPERTY (both poles):
 *   DENY — a seat name already used by another org's mapping/profile (or by
 *   a reserved fleet name) is refused with SEAT_NAME_TAKEN, before any row
 *   for the new org is written (all-or-nothing).
 *   ALLOW — a brand-new org with fresh names succeeds; two different orgs
 *   administered by the same admin succeed with DISTINCT names each; same
 *   org + same name set stays idempotent (replay unaffected).
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

const MASTER = "test-master-token-seat-collision";

beforeEach(() => {
	vi.stubEnv("BEARER_SECRET_MASTER", MASTER);
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

const orgAdminIdentity = (org: string) => ({
	subject: `admin-of-${org}`,
	organizationSlug: org,
	orgRole: "org:admin",
});

describe("provisionOrganization — cross-org seat-name collision", () => {
	test("POLE DENY: org Y provisions 'alpha' first; org X provisioning the same name is REFUSED", async () => {
		const t = createT();
		const yResult = await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "org-y",
			displayName: "Org Y",
			orchestrators: [{ name: "alpha" }],
		});
		expect(yResult.orchestrators[0].name).toBe("alpha");

		// Collision proof: had X been allowed, it would mint the IDENTICAL
		// orchestrator/alpha prefix already granted to Y's seat.
		const yProfile = await asServiceAccount(t).query(api.oauth.getScopeProfile, {
			profileId: "alpha-org-y",
		});
		expect(yProfile?.namespaceReadPrefixes).toContain("orchestrator/alpha");

		await expect(
			t.mutation(api.oauth.provisionOrganization, {
				callerToken: MASTER,
				clerkOrgSlug: "org-x",
				displayName: "Org X",
				orchestrators: [{ name: "alpha" }],
			}),
		).rejects.toThrow(/SEAT_NAME_TAKEN/);

		// Org X must be untouched — refusal happens before any write.
		const xMapping = await t.run(async (ctx) =>
			ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "org-x"))
				.unique(),
		);
		expect(xMapping).toBeNull();
		const xProfile = await asServiceAccount(t).query(api.oauth.getScopeProfile, {
			profileId: "alpha-org-x",
		});
		expect(xProfile).toBeNull();
	});

	test("POLE DENY: a reserved fleet name (already used by the operator's own org) is refused", async () => {
		const t = createT();
		// Represent the operator's own fleet as an existing client_org_mapping
		// row (orgKind "operator") whose allowedOrchestrators already includes
		// a fleet orchestrator name.
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "vantagepeers-operator",
				allowedOrchestrators: ["pi", "sigma"],
				scopes: ["view-own-tasks"],
				displayName: "VantagePeers operator",
				isActive: true,
				createdAt: Date.now(),
				orgKind: "operator",
			});
		});

		await expect(
			t.mutation(api.oauth.provisionOrganization, {
				callerToken: MASTER,
				clerkOrgSlug: "org-client-1",
				displayName: "Org client 1",
				orchestrators: [{ name: "sigma" }],
			}),
		).rejects.toThrow(/SEAT_NAME_TAKEN/);
	});

	test("POLE DENY: a name already in another org's oauth_scope_profiles.fromAllowList (no matching mapping row) is refused", async () => {
		const t = createT();
		// A legacy/catalog-style profile with no client_org_mapping row at all
		// (e.g. seedDefaultProfiles-style rows) still counts as taken.
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "legacy-catalog-profile",
				description: "legacy catalog profile",
				fromAllowList: ["legacyseat"],
				namespaceReadPrefixes: ["orchestrator/legacyseat"],
				namespaceWritePrefixes: ["orchestrator/legacyseat"],
				createdAt: now,
				updatedAt: now,
			});
		});

		await expect(
			t.mutation(api.oauth.provisionOrganization, {
				callerToken: MASTER,
				clerkOrgSlug: "org-client-2",
				displayName: "Org client 2",
				orchestrators: [{ name: "legacyseat" }],
			}),
		).rejects.toThrow(/SEAT_NAME_TAKEN/);
	});

	test("POLE ALLOW: same org, same name set — replay stays idempotent (master path)", async () => {
		const t = createT();
		const first = await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "org-replay",
			displayName: "Org replay",
			orchestrators: [{ name: "beta" }],
		});
		expect(first.replay).toBe(false);

		const second = await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "org-replay",
			displayName: "Org replay",
			orchestrators: [{ name: "beta" }],
		});
		expect(second.replay).toBe(true);
		expect(second.mappingId).toBe(first.mappingId);
	});

	test("POLE ALLOW: same org, same name set — replay stays idempotent via org-admin path", async () => {
		const t = createT();
		const first = await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "org-replay-admin",
			displayName: "Org replay admin",
			orchestrators: [{ name: "beta-admin" }],
		});

		const tAdmin = t.withIdentity(
			orgAdminIdentity("org-replay-admin") as Parameters<
				typeof t.withIdentity
			>[0],
		);
		const second = await tAdmin.mutation(api.oauth.provisionOrganization, {
			clerkOrgSlug: "org-replay-admin",
			displayName: "Org replay admin",
			orchestrators: [{ name: "beta-admin" }],
		});
		expect(second.replay).toBe(true);
		expect(second.mappingId).toBe(first.mappingId);
	});

	test("POLE ALLOW: two distinct orgs, administered by the same admin subject, both succeed with DISTINCT names", async () => {
		const t = createT();
		await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "org-gamma",
			displayName: "Org gamma",
			orchestrators: [{ name: "gamma-seat" }],
		});
		await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "org-delta",
			displayName: "Org delta",
			orchestrators: [{ name: "delta-seat" }],
		});

		const tAdminGamma = t.withIdentity({
			subject: "same-admin-subject",
			organizationSlug: "org-gamma",
			orgRole: "org:admin",
		} as Parameters<typeof t.withIdentity>[0]);
		const gammaResult = await tAdminGamma.mutation(
			api.oauth.provisionOrganization,
			{
				clerkOrgSlug: "org-gamma",
				displayName: "Org gamma",
				orchestrators: [{ name: "gamma-seat" }],
			},
		);
		expect(gammaResult.replay).toBe(true);

		const tAdminDelta = t.withIdentity({
			subject: "same-admin-subject",
			organizationSlug: "org-delta",
			orgRole: "org:admin",
		} as Parameters<typeof t.withIdentity>[0]);
		const deltaResult = await tAdminDelta.mutation(
			api.oauth.provisionOrganization,
			{
				clerkOrgSlug: "org-delta",
				displayName: "Org delta",
				orchestrators: [{ name: "delta-seat" }],
			},
		);
		expect(deltaResult.replay).toBe(true);
	});

	test("POLE ALLOW: a regular new org with fresh names succeeds", async () => {
		const t = createT();
		const result = await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "org-brand-new-fresh",
			displayName: "Org brand new fresh",
			orchestrators: [{ name: "epsilon" }, { name: "zeta-fresh" }],
		});
		expect(result.orchestrators).toHaveLength(2);
		expect(result.orchestrators.map((o) => o.name)).toEqual([
			"epsilon",
			"zeta-fresh",
		]);
	});
});
