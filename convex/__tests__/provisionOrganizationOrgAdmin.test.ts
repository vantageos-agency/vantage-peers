/// <reference types="vite/client" />
/**
 * D2 — provisionOrganization opened to an authenticated org-admin, scoped
 * to their OWN org (task k17awjxrj7ggwvw277cswh314d8cx7nr).
 *
 * Defect (live at 21297ec56a8e288b7a0de315b09420a5598e5375): the master
 * bearer secret was the ONLY key that could add an orchestrator/seat —
 * authority lived on a GLOBAL SECRET instead of on the authenticated
 * principal's organisation.
 *
 * THE PROPERTY (both poles):
 *   ALLOW — a verified Clerk org-admin of org X (organizationId == X,
 *   org-role claim normalizing to "admin") provisions a NEW seat into X.
 *   Succeeds; the seat lands in X's client_org_mapping/oauth_scope_profiles,
 *   scoped to X. Read back proves it landed in the RIGHT org.
 *   DENY — the SAME admin of X attempting to provision into Y (a
 *   caller-supplied clerkOrgSlug that is NOT their own org) is REFUSED.
 *   A non-admin MEMBER of X is refused. Master (callerToken) still works,
 *   byte-unchanged requireMasterAuth path.
 *
 * RED-first: this file is added on TOP of commit 13f498d (D1 Path-B
 * rewire). Before this D2 change, `provisionOrganization` required
 * `callerToken` to be a non-empty string matching BEARER_SECRET_MASTER for
 * EVERY caller — the org-admin (no callerToken) calls below would have
 * thrown "BEARER_SECRET_MASTER env var is not configured" /
 * "Unauthorized: invalid master token" instead of succeeding/refusing on
 * the ORG-SCOPING property this file actually tests. Reproduced via
 * `git stash` in the RETURN SHAPE section of the dispatching brief.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

async function seedOrgMapping(
	t: ReturnType<typeof createT>,
	clerkOrgSlug: string,
	allowedOrchestrators: string[] = ["existing-seat"],
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators,
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

// CORRECTNESS (item 4, D2 follow-up): requireOrgAdmin compares
// `identity.organizationSlug` — a SLUG — against `targetOrgSlug`, which is
// also a slug (client_org_mapping.clerkOrgSlug, the `by_clerk_slug` index
// key). `organizationId` is deliberately NOT set below to prove the compare
// does not depend on it (see the dedicated slug-vs-org-id test further
// down, which sets a MISMATCHED organizationId alongside the correct
// organizationSlug to prove the compare ignores organizationId entirely).
const orgAdminIdentity = (org: string) => ({
	subject: `admin-of-${org}`,
	organizationSlug: org,
	orgRole: "org:admin",
});

const orgMemberIdentity = (org: string) => ({
	subject: `member-of-${org}`,
	organizationSlug: org,
	orgRole: "org:member",
});

describe("D2 provisionOrganization — org-admin authority, scoped to own org", () => {
	test("POLE ALLOW: admin of X provisions the seat in X — succeeds, lands in X, reads back", async () => {
		// provisionOrganization's pre-existing (unmodified) semantics treat the
		// `orchestrators` array as the org's FULL desired seat set: an existing
		// mapping with a DIFFERENT name-set throws ("already mapped with a
		// different name set") — that all-or-nothing/idempotent-replay
		// behaviour is explicitly out of scope for D2 (kept byte-for-byte).
		// The org-admin ALLOW pole is demonstrated by an admin of an ALREADY
		// ACTIVE org X re-provisioning X's own matching seat set (the org-admin
		// path requires an existing active mapping — see the brand-new-org
		// DENY pole below) — the interesting property under test is
		// AUTHORIZATION (does an org-admin, not master, reach the mutation
		// body at all and land in the RIGHT org), not the provisioning
		// idempotency semantics themselves.
		const t = createT();
		await seedOrgMapping(t, "org-x", ["new-seat-x"]);

		const tAdminX = t.withIdentity(
			orgAdminIdentity("org-x") as Parameters<typeof t.withIdentity>[0],
		);

		const result = await tAdminX.mutation(api.oauth.provisionOrganization, {
			clerkOrgSlug: "org-x",
			displayName: "Org X",
			orchestrators: [{ name: "new-seat-x" }],
		});

		expect(result.clerkOrgSlug).toBe("org-x");
		expect(result.mappingId).toBeDefined();
		expect(result.orchestrators).toHaveLength(1);
		expect(result.orchestrators[0].name).toBe("new-seat-x");

		// Read back — the resolved mapping is org-x's OWN row, not some
		// other org's — mappingId round-trips to the exact row for "org-x".
		const mapping = await t.run(async (ctx) => ctx.db.get(result.mappingId));
		expect(mapping?.clerkOrgSlug).toBe("org-x");
		expect(mapping?.allowedOrchestrators).toContain("new-seat-x");
	});

	test("POLE DENY: admin of X provisioning into Y is refused (RBAC_DENIED)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-x");
		await seedOrgMapping(t, "org-y");

		const tAdminX = t.withIdentity(
			orgAdminIdentity("org-x") as Parameters<typeof t.withIdentity>[0],
		);

		await expect(
			tAdminX.mutation(api.oauth.provisionOrganization, {
				clerkOrgSlug: "org-y",
				displayName: "Org Y",
				orchestrators: [{ name: "sneaky-seat" }],
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		// Org Y must be untouched.
		const mapping = await t.run(async (ctx) => {
			return await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "org-y"))
				.first();
		});
		expect(mapping?.allowedOrchestrators).not.toContain("sneaky-seat");
	});

	test("POLE DENY: non-admin member of X is refused", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-x");

		const tMemberX = t.withIdentity(
			orgMemberIdentity("org-x") as Parameters<typeof t.withIdentity>[0],
		);

		await expect(
			tMemberX.mutation(api.oauth.provisionOrganization, {
				clerkOrgSlug: "org-x",
				displayName: "Org X",
				orchestrators: [{ name: "member-attempt-seat" }],
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("POLE DENY: no identity at all is refused", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-x");

		await expect(
			t.mutation(api.oauth.provisionOrganization, {
				clerkOrgSlug: "org-x",
				displayName: "Org X",
				orchestrators: [{ name: "anon-attempt-seat" }],
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("POLE DENY: org-admin cannot bootstrap a brand-new (unmapped) org", async () => {
		const t = createT();
		// No seedOrgMapping call — "org-brand-new" has no row at all.
		const tAdminNew = t.withIdentity(
			orgAdminIdentity("org-brand-new") as Parameters<
				typeof t.withIdentity
			>[0],
		);

		await expect(
			tAdminNew.mutation(api.oauth.provisionOrganization, {
				clerkOrgSlug: "org-brand-new",
				displayName: "Brand New Org",
				orchestrators: [{ name: "first-seat" }],
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("master path still works — byte-unchanged requireMasterAuth", async () => {
		const previous = process.env.BEARER_SECRET_MASTER;
		process.env.BEARER_SECRET_MASTER = "test-master-secret-d2";
		try {
			const t = createT();
			const result = await t.mutation(api.oauth.provisionOrganization, {
				callerToken: "test-master-secret-d2",
				clerkOrgSlug: "org-master-path",
				displayName: "Master Path Org",
				orchestrators: [{ name: "master-seat" }],
			});
			expect(result.replay).toBe(false);
			expect(result.orchestrators[0].name).toBe("master-seat");
		} finally {
			if (previous === undefined) {
				delete process.env.BEARER_SECRET_MASTER;
			} else {
				process.env.BEARER_SECRET_MASTER = previous;
			}
		}
	});

	test("CORRECTNESS (item 4): compare is slug-based — a MISMATCHED organizationId alongside the CORRECT organizationSlug still ALLOWS", async () => {
		// requireOrgAdmin (convex/lib/auth.ts) must compare
		// identity.organizationSlug (a SLUG) against targetOrgSlug (also a
		// SLUG — client_org_mapping.clerkOrgSlug, the by_clerk_slug index
		// key), never identity.organizationId. This identity carries an
		// organizationId that looks like a raw Clerk org id ("org_2abcXYZ",
		// NOT the slug "org-x") alongside the CORRECT organizationSlug
		// ("org-x") — if the compare ever read organizationId instead of (or
		// before) organizationSlug, this would fail closed
		// (RBAC_DENIED) even though the caller genuinely IS org-x's admin.
		const t = createT();
		await seedOrgMapping(t, "org-x", ["slug-correctness-seat"]);

		const tAdminX = t.withIdentity({
			subject: "admin-of-org-x-with-distinct-org-id",
			organizationId: "org_2abcXYZmismatchedClerkOrgId",
			organizationSlug: "org-x",
			orgRole: "org:admin",
		} as Parameters<typeof t.withIdentity>[0]);

		const result = await tAdminX.mutation(api.oauth.provisionOrganization, {
			clerkOrgSlug: "org-x",
			displayName: "Org X",
			orchestrators: [{ name: "slug-correctness-seat" }],
		});

		expect(result.clerkOrgSlug).toBe("org-x");
		const mapping = await t.run(async (ctx) => ctx.db.get(result.mappingId));
		expect(mapping?.clerkOrgSlug).toBe("org-x");
	});

	test("CORRECTNESS (item 4): organizationId alone (no organizationSlug) is NOT accepted as the compare value", async () => {
		// The inverse of the test above: an identity that carries ONLY
		// organizationId (no organizationSlug at all) must be refused —
		// proving the fallback to organizationId that used to exist has been
		// removed, not merely reordered.
		const t = createT();
		await seedOrgMapping(t, "org-x");

		const tAdminOrgIdOnly = t.withIdentity({
			subject: "admin-with-org-id-only",
			organizationId: "org-x",
			orgRole: "org:admin",
		} as Parameters<typeof t.withIdentity>[0]);

		await expect(
			tAdminOrgIdOnly.mutation(api.oauth.provisionOrganization, {
				clerkOrgSlug: "org-x",
				displayName: "Org X",
				orchestrators: [{ name: "org-id-only-seat" }],
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("master path with wrong token still refused — byte-unchanged requireMasterAuth", async () => {
		const previous = process.env.BEARER_SECRET_MASTER;
		process.env.BEARER_SECRET_MASTER = "test-master-secret-d2";
		try {
			const t = createT();
			await expect(
				t.mutation(api.oauth.provisionOrganization, {
					callerToken: "wrong-token",
					clerkOrgSlug: "org-master-path-2",
					displayName: "Master Path Org 2",
					orchestrators: [{ name: "master-seat-2" }],
				}),
			).rejects.toThrow(/Unauthorized: invalid master token/);
		} finally {
			if (previous === undefined) {
				delete process.env.BEARER_SECRET_MASTER;
			} else {
				process.env.BEARER_SECRET_MASTER = previous;
			}
		}
	});
});
