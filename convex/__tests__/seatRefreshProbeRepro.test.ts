/// <reference types="vite/client" />
/**
 * seatRefreshProbeRepro.test.ts - VantagePeers Cloud (multi-tenant).
 * task k175gb5yzb6p7y46n63t9x987d8hes7f.
 *
 * Replays the prod probe (refresh-probe.mjs): a refresh row created by
 * oauth:createRefreshToken with NO first access token, rotated with the args
 * server-http.ts builds from oauth:getScopeProfile, then the new access token
 * read back through oauth:getAccessTokenByHash (the lookup the bearer path uses).
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill"),
	),
);

const SERVICE_ACCOUNT_ID = "test-service-account-user-id";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT_ID });
const SLUG = "probe-tenant-a";
const PROFILE = "probe-a-probe-tenant-a";

async function seed(t: T, withOrgId: boolean): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: SLUG,
			clerkOrgId: testClerkOrgId(SLUG),
			allowedOrchestrators: ["probe-a"],
			scopes: ["view-own-tasks"],
			displayName: SLUG,
			isActive: true,
			createdAt: Date.now(),
		});
		await ctx.db.insert("oauth_scope_profiles", {
			profileId: PROFILE,
			description: PROFILE,
			fromAllowList: ["probe-a"],
			namespaceReadPrefixes: [`team/${SLUG}`],
			namespaceWritePrefixes: [`team/${SLUG}`],
			createdAt: Date.now(),
			updatedAt: Date.now(),
			clerkOrgSlug: SLUG,
			...(withOrgId ? { clerkOrgId: testClerkOrgId(SLUG) } : {}),
		});
	});
	await asService(t).mutation(api.oauth.createRefreshToken, {
		tokenHash: sha("r1"),
		clientId: "probe-client",
		userId: "probe-a",
		scopeProfile: PROFILE,
		expiresAt: Date.now() + 3_600_000,
	});
}

/** The call server-http.ts makes: args from getScopeProfile, no org ID among them. */
async function seatRefresh(t: T) {
	const profile = await asService(t).query(api.oauth.getScopeProfile, {
		profileId: PROFILE,
	});
	if (profile === null) throw new Error("profile missing");
	return await asService(t).mutation(api.oauth.rotateRefreshToken, {
		presentedHash: sha("r1"),
		clientId: "probe-client",
		scopeProfile: profile.profileId,
		scopes: ["mcp:full"],
		fromAllowList: profile.fromAllowList,
		namespaceReadPrefixes: profile.namespaceReadPrefixes,
		namespaceWritePrefixes: profile.namespaceWritePrefixes,
		accessExpiresAt: Date.now() + 3_600_000,
		refreshExpiresAt: Date.now() + 86_400_000,
		...(profile.clerkOrgSlug !== undefined
			? { clerkOrgSlug: profile.clerkOrgSlug }
			: {}),
	});
}

/** A real seat: its first access token sits beside its first refresh token (createAccessToken with refreshTokenHash). */
const seedLineage = (t: T) =>
	t.run((ctx) =>
		ctx.db.insert("oauth_access_tokens", {
			tokenHash: sha("a1"),
			clientId: "probe-client",
			userId: "probe-a",
			scopes: ["mcp:full"],
			scopeProfile: PROFILE,
			fromAllowList: ["probe-a"],
			namespaceReadPrefixes: [`team/${SLUG}`],
			namespaceWritePrefixes: [`team/${SLUG}`],
			expiresAt: Date.now() + 3_600_000,
			createdAt: Date.now(),
			refreshTokenHash: sha("r1"),
			familyId: sha("r1"),
			clerkOrgSlug: SLUG,
			clerkOrgId: testClerkOrgId(SLUG),
		}),
	);

describe("prod probe replay (refresh-probe.mjs)", () => {
	test("the probe sequence: rotate, then replay the spent R1 -> the rotated access token is revoked (oauth.ts getAccessTokenByHash revokedAt line)", async () => {
		const t = createT();
		await seed(t, true);
		await seedLineage(t);
		const res = await seatRefresh(t);
		expect(res.status).toBe("ok");
		if (res.status !== "ok") return;
		const rotated = await t.run((ctx) =>
			ctx.db
				.query("oauth_access_tokens")
				.withIndex("by_tokenHash", (q) => q.eq("tokenHash", sha(res.issued.access)))
				.unique(),
		);
		expect(rotated?.clerkOrgId).toBe(testClerkOrgId(SLUG));
		const lookup = () =>
			asService(t).query(api.oauth.getAccessTokenByHash, {
				tokenHash: sha(res.issued.access),
			});
		expect(await lookup()).not.toBeNull();
		// The probe's next step: present the SPENT R1 again (RFC 9700 s4.14).
		const replay = await asService(t).mutation(api.oauth.rotateRefreshToken, {
			presentedHash: sha("r1"),
			clientId: "probe-client",
			accessExpiresAt: Date.now() + 3_600_000,
			refreshExpiresAt: Date.now() + 86_400_000,
		});
		expect(replay.status).toBe("reused");
		// The replay revoked the whole family, the rotated access token included.
		expect(await lookup()).toBeNull();
	});

	for (const withOrgId of [true, false]) {
		test(`no first access token (the probe's shape), profile ${withOrgId ? "with" : "without"} clerkOrgId: refused and revoked, nothing minted`, async () => {
			const t = createT();
			await seed(t, withOrgId);
			expect(await seatRefresh(t)).toEqual({
				status: "refused",
				reason: "organisation-id-missing",
			});
			const rows = await t.run((ctx) => ctx.db.query("oauth_access_tokens").collect());
			expect(rows).toHaveLength(0);
		});
	}
});
