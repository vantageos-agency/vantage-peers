/// <reference types="vite/client" />
/**
 * P-T1 — requireOrgAdmin snake_case org_slug fallback (task: Sigma P-T1
 * allow-pole close).
 *
 * Defect: `requireOrgAdmin` (convex/lib/auth.ts) read the caller's org slug
 * ONLY as camelCase `identity.organizationSlug`, with NO snake_case
 * `org_slug` fallback — even though its own ROLE read already falls back to
 * `org_role`, and `withOrgScope` (same file) resolves slug as
 * `organizationSlug ?? organizationId`. A real Clerk-native session JWT
 * (no custom JWT template — the ONLY path that mints `aud:"convex"` +
 * `org_role`/`org_slug` together for a scoped, non-master identity) carries
 * the org slug as `org_slug` (snake_case), so a genuine org:admin was
 * refused with RBAC_DENIED at this exact read.
 *
 * THE PROPERTY (both poles), scoped to THIS function only:
 *   ALLOW — an identity carrying ONLY snake_case `org_slug` (no camelCase
 *   `organizationSlug` at all) + `org_role: "org:admin"`, for an org that is
 *   an ACTIVE row in client_org_mapping, is ACCEPTED (no throw).
 *   DENY  — an identity with NO org claim at all (neither camelCase nor
 *   snake_case, in either slug spelling) is STILL refused (RBAC_DENIED) —
 *   proving the fix is additive, not a blanket allow.
 *
 * Does NOT touch requireMasterAuth, the master/service-account branches, or
 * organizationId (that fallback remains deliberately absent from this
 * function per PR #1224 item 4 — see
 * provisionOrganizationOrgAdmin.test.ts's "organizationId alone ... is NOT
 * accepted" pole, which this change must NOT break).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { requireOrgAdmin } from "../lib/auth";
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
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators: ["existing-seat"],
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

describe("P-T1 requireOrgAdmin — snake_case org_slug fallback", () => {
	test("POLE ALLOW: identity carrying ONLY snake_case org_slug + org:admin is accepted", async () => {
		const t = createT();
		await seedOrgMapping(t, "perello-consulting-1782214787064836324");

		const tSnakeAdmin = t.withIdentity({
			subject: "user_3FXI326OF3bgUd6OnOgUcAYY9ip",
			org_slug: "perello-consulting-1782214787064836324",
			org_role: "org:admin",
		} as Parameters<typeof t.withIdentity>[0]);

		await tSnakeAdmin.run(async (ctx) => {
			await expect(
				requireOrgAdmin(ctx, "perello-consulting-1782214787064836324"),
			).resolves.toBeUndefined();
		});
	});

	test("POLE DENY: identity with no org claim at all is still refused (RBAC_DENIED)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-no-claim-target");

		const tNoOrg = t.withIdentity({
			subject: "user-with-no-org-claim",
		} as Parameters<typeof t.withIdentity>[0]);

		await tNoOrg.run(async (ctx) => {
			await expect(
				requireOrgAdmin(ctx, "org-no-claim-target"),
			).rejects.toThrow(/RBAC_DENIED/);
		});
	});
});
