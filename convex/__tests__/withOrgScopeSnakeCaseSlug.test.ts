/// <reference types="vite/client" />
/**
 * P-T5 follow-up — withOrgScope snake_case org_slug/org_id fallback.
 *
 * Defect (IDENTITY-CLAIM CASING CLASS, sweep miss): the earlier casing-class
 * sweep grepped `identity\.(organizationSlug|...)` / `rec\.(...)` only, which
 * does NOT match the CAST-form read `(identity as Record<string,
 * unknown>).organizationSlug` that `withOrgScope` (convex/lib/auth.ts) uses.
 * withOrgScope resolved ONLY `organizationSlug ?? organizationId` — no
 * snake_case `org_slug`/`org_id` fallback — even though `requireOrgAdmin` in
 * the SAME file already carries the snake_case fallback (P-T1). A genuine
 * Clerk-native session JWT (no custom JWT template) delivers the org slug as
 * `org_slug`, so a real member was denied org scope by withOrgScope — the
 * same "denies real members, looks like a correct refusal" failure the whole
 * casing class exists to close.
 *
 * THE PROPERTY (both poles):
 *   ALLOW — an identity carrying ONLY snake_case `org_slug` (no camelCase
 *   claim at all) resolves org scope from `client_org_mapping` (no
 *   RBAC_DENIED, correct allowedOrchestrators/scopes returned).
 *   REGRESSION — the existing camelCase `organizationSlug` resolution keeps
 *   working, AND the documented precedence pole from #1224 item 4 stays
 *   intact: `organizationId` ALONE (no slug in either casing) still resolves
 *   via the id fallback (this is withOrgScope's own documented behaviour,
 *   distinct from requireOrgAdmin which deliberately excludes id fallback).
 *
 * Deletion probe: removing the snake_case fallback lines from withOrgScope
 * turns the ALLOW (snake-case-only) test RED — see PR description / diff for
 * the manual revert-and-rerun evidence.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { withOrgScope } from "../lib/auth";
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
	allowedOrchestrators: string[] = ["sigma"],
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

describe("withOrgScope — snake_case org_slug/org_id fallback", () => {
	test("POLE ALLOW: identity carrying ONLY snake_case org_slug resolves org scope", async () => {
		const t = createT();
		await seedOrgMapping(t, "snake-case-org", ["sigma-snake"]);

		const tSnake = t.withIdentity({
			subject: "user_snake_only",
			org_slug: "snake-case-org",
		} as Parameters<typeof t.withIdentity>[0]);

		await tSnake.run(async (ctx) => {
			const scope = await withOrgScope(ctx);
			expect(scope.isMaster).toBe(false);
			expect(scope.orgSlug).toBe("snake-case-org");
			expect(scope.allowedOrchestrators).toEqual(["sigma-snake"]);
		});
	});

	test("POLE ALLOW: identity carrying ONLY snake_case org_id (no slug at all) resolves org scope", async () => {
		const t = createT();
		await seedOrgMapping(t, "snake-case-org-by-id", ["sigma-snake-id"]);

		const tSnakeId = t.withIdentity({
			subject: "user_snake_id_only",
			org_id: "snake-case-org-by-id",
		} as Parameters<typeof t.withIdentity>[0]);

		await tSnakeId.run(async (ctx) => {
			const scope = await withOrgScope(ctx);
			expect(scope.isMaster).toBe(false);
			expect(scope.orgSlug).toBe("snake-case-org-by-id");
			expect(scope.allowedOrchestrators).toEqual(["sigma-snake-id"]);
		});
	});

	test("REGRESSION: existing camelCase organizationSlug resolution still works", async () => {
		const t = createT();
		await seedOrgMapping(t, "camel-case-org", ["sigma-camel"]);

		const tCamel = t.withIdentity({
			subject: "user_camel",
			organizationSlug: "camel-case-org",
		} as Parameters<typeof t.withIdentity>[0]);

		await tCamel.run(async (ctx) => {
			const scope = await withOrgScope(ctx);
			expect(scope.isMaster).toBe(false);
			expect(scope.orgSlug).toBe("camel-case-org");
			expect(scope.allowedOrchestrators).toEqual(["sigma-camel"]);
		});
	});

	test("REGRESSION: slug-first precedence intact — organizationSlug wins over organizationId when both present", async () => {
		const t = createT();
		await seedOrgMapping(t, "real-slug-wins", ["sigma-slug-wins"]);
		// A raw org id sitting in organizationId must NOT shadow a real slug.
		await seedOrgMapping(t, "org_raw_id_should_lose", ["sigma-should-not-win"]);

		const tBoth = t.withIdentity({
			subject: "user_both_claims",
			organizationSlug: "real-slug-wins",
			organizationId: "org_raw_id_should_lose",
		} as Parameters<typeof t.withIdentity>[0]);

		await tBoth.run(async (ctx) => {
			const scope = await withOrgScope(ctx);
			expect(scope.orgSlug).toBe("real-slug-wins");
			expect(scope.allowedOrchestrators).toEqual(["sigma-slug-wins"]);
		});
	});

	test("DENY: identity with no org claim at all (neither casing) is refused (RBAC_DENIED / no master)", async () => {
		const t = createT();
		const tNoOrg = t.withIdentity({
			subject: "user-no-org-claim-at-all",
		} as Parameters<typeof t.withIdentity>[0]);

		await tNoOrg.run(async (ctx) => {
			await expect(withOrgScope(ctx)).rejects.toThrow(/RBAC_DENIED/);
		});
	});
});
