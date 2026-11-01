/// <reference types="vite/client" />
/**
 * oauthInactiveOrgToken.test.ts - VantagePeers Cloud (multi-tenant).
 * task k17fhnxz9sbqptg0tesxktv7es8hd360.
 *
 * Rule http-boundary-derives-from-principal.md, rule 2: a mapping lookup miss or
 * `isActive === false` is a DENY, never a degraded grant. A live access token that
 * carries an organisation (by permanent ID) must stop resolving once that org's
 * mapping is inactive or gone; before the fix it still resolved to a populated
 * context with only the org fields dropped. A token that never carried an org
 * (fleet / catalog) is untouched.
 *
 *   PRESENT  active org -> served; fleet token without org -> served
 *   DENY     inactive org -> null; mapping deleted -> null
 *   REFRESH  a seat family of an inactive org is refused and revoked
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
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

async function seedOrg(t: T, slug: string): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: ["clio"],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedProfile(t: T, profileId: string, slug: string): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId,
			description: profileId,
			fromAllowList: ["clio"],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
		});
	});
}

const mint = (
	t: T,
	raw: string,
	profileId: string,
	opts: { slug?: string; refreshRaw?: string } = {},
) =>
	asService(t).mutation(api.oauth.createAccessToken, {
		tokenHash: sha(raw),
		clientId: "client-1",
		userId: "seat",
		scopes: ["mcp:full"],
		scopeProfile: profileId,
		fromAllowList: ["clio"],
		namespaceReadPrefixes: [`team/${opts.slug ?? "none"}`],
		namespaceWritePrefixes: [`team/${opts.slug ?? "none"}`],
		expiresAt: Date.now() + 3_600_000,
		...(opts.slug !== undefined ? { clerkOrgSlug: opts.slug } : {}),
		...(opts.refreshRaw !== undefined ? { refreshTokenHash: sha(opts.refreshRaw) } : {}),
	});

const lookup = (t: T, raw: string) =>
	asService(t).query(api.oauth.getAccessTokenByHash, { tokenHash: sha(raw) });

const setActive = (t: T, slug: string, isActive: boolean) =>
	t.mutation(internal.clientOrgMapping.setActive, {
		clerkOrgSlug: slug,
		isActive,
		force: true,
	});

describe("getAccessTokenByHash: an org token needs an ACTIVE mapping read by ID", () => {
	test("PRESENT: active org -> served with its org fields", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedProfile(t, "p-a", "org-a");
		await mint(t, "tok-a", "p-a", { slug: "org-a" });
		expect(await lookup(t, "tok-a")).toMatchObject({
			clientId: "client-1",
			orgClerkId: testClerkOrgId("org-a"),
			clerkOrgSlug: "org-a",
		});
	});

	test("DENY: the org switched inactive -> null, not a degraded context", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedProfile(t, "p-a", "org-a");
		await mint(t, "tok-a", "p-a", { slug: "org-a" });
		expect(await lookup(t, "tok-a")).not.toBeNull();
		await setActive(t, "org-a", false);
		expect(await lookup(t, "tok-a")).toBeNull();
	});

	test("DENY: the mapping row deleted -> null", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedProfile(t, "p-a", "org-a");
		await mint(t, "tok-a", "p-a", { slug: "org-a" });
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("client_org_mapping")
				.filter((q) => q.eq(q.field("clerkOrgSlug"), "org-a"))
				.unique();
			if (row) await ctx.db.delete(row._id);
		});
		expect(await lookup(t, "tok-a")).toBeNull();
	});

	test("PRESENT: a fleet token that never carried an org is served unchanged", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await setActive(t, "org-a", false);
		await mint(t, "tok-fleet", "fleet-profile");
		const got = await lookup(t, "tok-fleet");
		expect(got).toMatchObject({ clientId: "client-1", scopeProfile: "fleet-profile" });
		expect(got).not.toHaveProperty("orgClerkId");
	});

	test("ISOLATION: deactivating org-a leaves org-b's token served", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await seedProfile(t, "p-a", "org-a");
		await seedProfile(t, "p-b", "org-b");
		await mint(t, "tok-a", "p-a", { slug: "org-a" });
		await mint(t, "tok-b", "p-b", { slug: "org-b" });
		await setActive(t, "org-a", false);
		expect(await lookup(t, "tok-a")).toBeNull();
		expect(await lookup(t, "tok-b")).not.toBeNull();
	});
});

describe("rotateRefreshToken: a seat family of an inactive org is refused", () => {
	const seedFamily = async (t: T, slug: string) => {
		await seedOrg(t, slug);
		await seedProfile(t, `p-${slug}`, slug);
		await t.run((ctx) =>
			ctx.db.insert("oauth_refresh_tokens", {
				tokenHash: sha("r1"),
				clientId: "client-1",
				userId: "seat",
				scopeProfile: `p-${slug}`,
				expiresAt: Date.now() + 60_000,
				createdAt: Date.now(),
			}),
		);
		await mint(t, "tok-a", `p-${slug}`, { slug, refreshRaw: "r1" });
	};
	const rotate = (t: T, slug: string) =>
		asService(t).mutation(api.oauth.rotateRefreshToken, {
			presentedHash: sha("r1"),
			clientId: "client-1",
			scopeProfile: `p-${slug}`,
			scopes: ["mcp:full"],
			fromAllowList: ["clio"],
			namespaceReadPrefixes: [`team/${slug}`],
			namespaceWritePrefixes: [`team/${slug}`],
			clerkOrgSlug: slug,
			accessExpiresAt: Date.now() + 3_600_000,
			refreshExpiresAt: Date.now() + 86_400_000,
		});

	test("PRESENT: active org rotates", async () => {
		const t = createT();
		await seedFamily(t, "org-a");
		expect((await rotate(t, "org-a")).status).toBe("ok");
	});

	test("DENY: inactive org -> refused, nothing minted, family revoked", async () => {
		const t = createT();
		await seedFamily(t, "org-a");
		await setActive(t, "org-a", false);
		expect(await rotate(t, "org-a")).toEqual({
			status: "refused",
			reason: "organisation-inactive",
		});
		const refreshRows = await t.run((ctx) => ctx.db.query("oauth_refresh_tokens").collect());
		expect(refreshRows).toHaveLength(1);
		expect(refreshRows[0]?.revokedAt).toBeDefined();
	});
});
