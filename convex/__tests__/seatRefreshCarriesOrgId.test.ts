/// <reference types="vite/client" />
/**
 * seatRefreshCarriesOrgId.test.ts - VantagePeers Cloud (multi-tenant).
 * task k17eer2yreed4mcraq85we28z18he21p (hardening).
 *
 * A seat refresh took the rotated token's org ID from the PROFILE's current
 * row, which can be re-pointed or lose its ID after the family was minted. The
 * rotated token is now bound to the FAMILY's own permanent ID
 * (lineage[0].clerkOrgId), never the profile's and never derived from a slug
 * (#1624 slug-takeover rule); a family that cannot prove an ID is refused.
 *
 *   PRESENT  seat family with an ID-bearing lineage -> rotated token carries the ID and is served
 *   PRESENT  a family with neither slug nor ID -> profile-only token, as before
 *   PRESENT  the profile lost its ID, or no slug is sent -> the family's ID still stamps the token
 *   DENY     inactive org -> refused, family revoked (unchanged)
 *   DENY     slug sent, lineage carries no ID -> refused, family revoked, nothing minted
 *   DENY     the profile now names another ID -> refused organisation-mismatch
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

async function seedProfile(t: T, profileId: string, slug?: string): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId,
			description: profileId,
			fromAllowList: ["clio"],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
			...(slug !== undefined
				? { clerkOrgSlug: slug, clerkOrgId: testClerkOrgId(slug) }
				: {}),
		});
	});
}

async function seedRefresh(t: T, profileId: string): Promise<void> {
	await t.run((ctx) =>
		ctx.db.insert("oauth_refresh_tokens", {
			tokenHash: sha("r1"),
			clientId: "client-1",
			userId: "seat",
			scopeProfile: profileId,
			expiresAt: Date.now() + 60_000,
			createdAt: Date.now(),
		}),
	);
}

const mint = (t: T, profileId: string, slug?: string) =>
	asService(t).mutation(api.oauth.createAccessToken, {
		tokenHash: sha("tok-1"),
		clientId: "client-1",
		userId: "seat",
		scopes: ["mcp:full"],
		scopeProfile: profileId,
		fromAllowList: ["clio"],
		namespaceReadPrefixes: [`team/${slug ?? "none"}`],
		namespaceWritePrefixes: [`team/${slug ?? "none"}`],
		expiresAt: Date.now() + 3_600_000,
		refreshTokenHash: sha("r1"),
		...(slug !== undefined ? { clerkOrgSlug: slug } : {}),
	});

const rotate = (t: T, profileId: string, slug?: string) =>
	asService(t).mutation(api.oauth.rotateRefreshToken, {
		presentedHash: sha("r1"),
		clientId: "client-1",
		scopeProfile: profileId,
		scopes: ["mcp:full"],
		fromAllowList: ["clio"],
		namespaceReadPrefixes: [`team/${slug ?? "none"}`],
		namespaceWritePrefixes: [`team/${slug ?? "none"}`],
		...(slug !== undefined ? { clerkOrgSlug: slug } : {}),
		accessExpiresAt: Date.now() + 3_600_000,
		refreshExpiresAt: Date.now() + 86_400_000,
	});

const lookup = (t: T, raw: string) =>
	asService(t).query(api.oauth.getAccessTokenByHash, { tokenHash: sha(raw) });

const accessRows = (t: T) => t.run((ctx) => ctx.db.query("oauth_access_tokens").collect());

describe("seat refresh: the rotated access token carries the family's permanent org ID", () => {
	test("PRESENT: rotated token has clerkOrgId and is served by getAccessTokenByHash", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedProfile(t, "p-a", "org-a");
		await seedRefresh(t, "p-a");
		await mint(t, "p-a", "org-a");
		expect(await lookup(t, "tok-1")).not.toBeNull();

		const res = await rotate(t, "p-a", "org-a");
		expect(res.status).toBe("ok");
		if (res.status !== "ok") return;
		const rows = await accessRows(t);
		const rotated = rows.find((r) => r.tokenHash === sha(res.issued.access));
		expect(rotated?.clerkOrgId).toBe(testClerkOrgId("org-a"));
		expect(await lookup(t, res.issued.access)).toMatchObject({
			clientId: "client-1",
			orgClerkId: testClerkOrgId("org-a"),
			clerkOrgSlug: "org-a",
		});
	});

	test("PRESENT: a family with neither slug nor ID keeps its profile-only token", async () => {
		const t = createT();
		await seedProfile(t, "p-fleet");
		await seedRefresh(t, "p-fleet");
		await mint(t, "p-fleet");
		const res = await rotate(t, "p-fleet");
		expect(res.status).toBe("ok");
		if (res.status !== "ok") return;
		const rows = await accessRows(t);
		const rotated = rows.find((r) => r.tokenHash === sha(res.issued.access));
		expect(rotated?.clerkOrgId).toBeUndefined();
		expect(rotated?.clerkOrgSlug).toBeUndefined();
		expect(await lookup(t, res.issued.access)).toMatchObject({ scopeProfile: "p-fleet" });
	});

	test("DENY: inactive org is still refused and the family revoked", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedProfile(t, "p-a", "org-a");
		await seedRefresh(t, "p-a");
		await mint(t, "p-a", "org-a");
		await t.mutation(internal.clientOrgMapping.setActive, {
			clerkOrgSlug: "org-a",
			isActive: false,
			force: true,
		});
		expect(await rotate(t, "p-a", "org-a")).toEqual({
			status: "refused",
			reason: "organisation-inactive",
		});
		expect(await accessRows(t)).toHaveLength(1);
	});

	test("DENY: slug sent but the lineage carries no ID -> refused, family revoked, nothing minted", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedProfile(t, "p-a", "org-a");
		await seedRefresh(t, "p-a");
		await mint(t, "p-a", "org-a");
		// A pre-ID family: the first access token names its org by label only.
		await t.run(async (ctx) => {
			const row = await ctx.db.query("oauth_access_tokens").first();
			if (row) await ctx.db.patch(row._id, { clerkOrgId: undefined });
		});
		expect(await rotate(t, "p-a", "org-a")).toEqual({
			status: "refused",
			reason: "organisation-id-missing",
		});
		expect(await accessRows(t)).toHaveLength(1);
		const refresh = await t.run((ctx) => ctx.db.query("oauth_refresh_tokens").collect());
		expect(refresh).toHaveLength(1);
		expect(refresh[0]?.revokedAt).toBeDefined();
	});

	test("PRESENT: the profile lost its ID after mint -> the family's own ID still stamps the rotated token", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedProfile(t, "p-a", "org-a");
		await seedRefresh(t, "p-a");
		await mint(t, "p-a", "org-a");
		await t.run(async (ctx) => {
			const p = await ctx.db.query("oauth_scope_profiles").first();
			if (p) await ctx.db.patch(p._id, { clerkOrgId: undefined });
		});
		const res = await rotate(t, "p-a", "org-a");
		expect(res.status).toBe("ok");
		if (res.status !== "ok") return;
		const rows = await accessRows(t);
		const rotated = rows.find((r) => r.tokenHash === sha(res.issued.access));
		expect(rotated?.clerkOrgId).toBe(testClerkOrgId("org-a"));
		expect(await lookup(t, res.issued.access)).not.toBeNull();
	});

	test("PRESENT: an org-bound family stays org-bound when the transport sends no slug", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedProfile(t, "p-a", "org-a");
		await seedRefresh(t, "p-a");
		await mint(t, "p-a", "org-a");
		const res = await rotate(t, "p-a");
		expect(res.status).toBe("ok");
		if (res.status !== "ok") return;
		const rows = await accessRows(t);
		const rotated = rows.find((r) => r.tokenHash === sha(res.issued.access));
		expect(rotated?.clerkOrgId).toBe(testClerkOrgId("org-a"));
	});

	test("PRESENT: the scope profile row was DELETED -> the family's own ID still stamps the rotated token", async () => {
		// Pinned on purpose: nothing contradicts the family's ID (the "profile ID
		// equal or absent" row of the case table), and the door's grant comes from
		// the snapshot args, not from the row. The /token transport itself answers
		// a missing profile 500 before it ever calls this door (server-http.ts
		// loadScopeProfile), so the door is not the layer that refuses it.
		const t = createT();
		await seedOrg(t, "org-a");
		await seedProfile(t, "p-a", "org-a");
		await seedRefresh(t, "p-a");
		await mint(t, "p-a", "org-a");
		await t.run(async (ctx) => {
			const p = await ctx.db.query("oauth_scope_profiles").first();
			if (p) await ctx.db.delete(p._id);
		});
		const res = await rotate(t, "p-a", "org-a");
		expect(res.status).toBe("ok");
		if (res.status !== "ok") return;
		const rows = await accessRows(t);
		const rotated = rows.find((r) => r.tokenHash === sha(res.issued.access));
		expect(rotated?.clerkOrgId).toBe(testClerkOrgId("org-a"));
		expect(await lookup(t, res.issued.access)).not.toBeNull();
	});

	test("DENY: the profile now names ANOTHER org by ID -> refused, family revoked, never re-pointed", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await seedProfile(t, "p-a", "org-a");
		await seedRefresh(t, "p-a");
		await mint(t, "p-a", "org-a");
		await t.run(async (ctx) => {
			const p = await ctx.db.query("oauth_scope_profiles").first();
			if (p) {
				await ctx.db.patch(p._id, {
					clerkOrgSlug: "org-b",
					clerkOrgId: testClerkOrgId("org-b"),
				});
			}
		});
		expect(await rotate(t, "p-a", "org-b")).toEqual({
			status: "refused",
			reason: "organisation-mismatch",
		});
		expect(await accessRows(t)).toHaveLength(1);
	});
});
