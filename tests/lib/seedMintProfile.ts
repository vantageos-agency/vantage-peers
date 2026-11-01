import type { MutationCtx } from "../../convex/_generated/server";
import { testClerkOrgId } from "../fixtures/testClerkOrgId";

type Runner = {
	run: <R>(fn: (ctx: MutationCtx) => Promise<R>) => Promise<R>;
};

/**
 * oauth:createAccessToken stamps a token's permanent org ID from an ID-bearing
 * source (consent code, scope profile, refreshed family), never from a slug
 * (task k1783fk8r6p795x9fxrzyt9evd8hcxm7). A test that mints a token for an
 * organisation by its slug alone names the profile the token is minted from here,
 * carrying the ID `testClerkOrgId(slug)` that the test's own mapping row carries.
 * An existing profile row is pointed at that organisation, nothing else on it moves.
 */
export async function seedMintProfile(
	t: Runner,
	profileId: string,
	slug: string,
): Promise<void> {
	const clerkOrgId = testClerkOrgId(slug) as string;
	await t.run(async (ctx) => {
		const existing = await ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", profileId))
			.unique();
		if (existing !== null) {
			if (existing.clerkOrgId !== clerkOrgId || existing.clerkOrgSlug !== slug) {
				await ctx.db.patch(existing._id, { clerkOrgSlug: slug, clerkOrgId });
			}
			return;
		}
		await ctx.db.insert("oauth_scope_profiles", {
			profileId,
			description: "test mint profile",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			createdAt: 1,
			updatedAt: 1,
			clerkOrgSlug: slug,
			clerkOrgId,
		});
	});
}
