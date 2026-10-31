/// <reference types="vite/client" />
/**
 * Membership revocation reaches the tokens (task k17fxe8feeq1k2rb1ggj76e97s8h7m7k).
 *
 * Pi decision B+A (design note js7a9f6th7mb983x9vzpbryeg58h7a66): a member removed
 * from an organisation loses that organisation's access within seconds (A: the
 * delete event revokes the member's tokens) and, when the event was missed, at
 * the next refresh (B: `oauth:rotateRefreshToken` refuses a person with no live
 * membership for the token's organisation).
 *
 * userId measurement: a token minted by the authorization_code flow carries
 * `userId = claims.sub`, the verified Clerk user id (mcp-server/server-http.ts
 * `createAccessToken({ userId: claims.sub, principal: "person", ... })`), the same
 * key as `orgMembership.clerkUserId`. Seat tokens carry the seat NAME as userId.
 *
 * Poles (each half): REVOKED/REFUSED (removed member), PRESENT (current member,
 * and the same user's tokens in ANOTHER org), ABSENT (a seat is untouched).
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const SERVICE_ACCOUNT_ID = "test-service-account-user-id";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT_ID });

const ORG = "acme-team";
const OTHER = "other-team";
const PERSON = "user_removedPerson";
const FAR = Date.now() + 30 * 86_400_000;

async function seedOrgs(t: T) {
	await t.run(async (ctx) => {
		for (const slug of [ORG, OTHER]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: ["seat"],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
}

const seedMember = (t: T, org: string, userId = PERSON, deletedAt?: number) =>
	t.run((ctx) =>
		ctx.db.insert("orgMembership", {
			clerkOrgSlug: org,
			clerkOrgId: testClerkOrgId(org),
			clerkUserId: userId,
			role: "member",
			createdAt: 1,
			updatedAt: 1,
			lastEventAt: 1,
			...(deletedAt !== undefined ? { deletedAt } : {}),
		}),
	);

/** A person access token, shaped as the authorization_code flow mints it. */
const seedPersonAccess = (t: T, raw: string, org: string, userId = PERSON) =>
	t.run((ctx) =>
		ctx.db.insert("oauth_access_tokens", {
			tokenHash: sha(raw),
			clientId: "dcr-client",
			userId,
			scopes: ["mcp:full"],
			scopeProfile: "person",
			fromAllowList: ["seat"],
			namespaceReadPrefixes: [`team/${org}`],
			namespaceWritePrefixes: [`team/${org}`],
			expiresAt: Date.now() + 3_600_000,
			createdAt: Date.now(),
			clerkOrgSlug: org,
			clerkOrgId: testClerkOrgId(org),
			principal: "person",
			orgRole: "org:member",
		}),
	);

const seedRefresh = (t: T, raw: string, userId: string, profile: string) =>
	t.run((ctx) =>
		ctx.db.insert("oauth_refresh_tokens", {
			tokenHash: sha(raw),
			clientId: "dcr-client",
			userId,
			scopeProfile: profile,
			expiresAt: FAR,
			createdAt: Date.now(),
		}),
	);

const seedProfile = (t: T, profileId: string, org: string) =>
	t.run((ctx) =>
		ctx.db.insert("oauth_scope_profiles", {
			profileId,
			description: "test",
			fromAllowList: ["seat"],
			namespaceReadPrefixes: [`team/${org}`],
			namespaceWritePrefixes: [`team/${org}`],
			createdAt: 1,
			updatedAt: 1,
			clerkOrgSlug: org,
			clerkOrgId: testClerkOrgId(org),
		}),
	);

const rotation = (presented: string, profile: string, org: string) => ({
	presentedHash: sha(presented),
	clientId: "dcr-client",
	scopeProfile: profile,
	scopes: ["mcp:full"],
	fromAllowList: ["seat"],
	namespaceReadPrefixes: [`team/${org}`],
	namespaceWritePrefixes: [`team/${org}`],
	clerkOrgSlug: org,
	accessExpiresAt: Date.now() + 3_600_000,
	refreshExpiresAt: FAR,
});

const deleteEvent = (t: T, org: string, userId = PERSON, eventAt = 1_000) =>
	t.mutation(internal.orgMembership.applyClerkMembershipEvent, {
		kind: "delete",
		clerkOrgId: testClerkOrgId(org),
		clerkOrgSlug: org,
		clerkUserId: userId,
		role: "member",
		eventAt,
	});

const accessServed = (t: T, raw: string) =>
	asService(t).query(api.oauth.getAccessTokenByHash, { tokenHash: sha(raw) });

afterEach(() => {
	vi.useRealTimers();
});

describe("A - the delete event revokes the removed member's tokens", () => {
	test("REVOKED: after the delete event the member's access token is no longer served", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedMember(t, ORG);
		await seedPersonAccess(t, "acc-removed", ORG);
		expect(await accessServed(t, "acc-removed")).not.toBeNull();
		expect(await deleteEvent(t, ORG)).toBe("removed");
		expect(await accessServed(t, "acc-removed")).toBeNull();
	});

	test("REVOKED: the refresh tokens of the member's family are revoked too", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedMember(t, ORG);
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash: sha("acc-fam"),
				clientId: "dcr-client",
				userId: PERSON,
				scopes: ["mcp:full"],
				scopeProfile: "person",
				fromAllowList: ["seat"],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				expiresAt: Date.now() + 3_600_000,
				createdAt: Date.now(),
				clerkOrgSlug: ORG,
				clerkOrgId: testClerkOrgId(ORG),
				principal: "person",
				familyId: sha("ref-fam"),
				refreshTokenHash: sha("ref-fam"),
			});
		});
		await seedRefresh(t, "ref-fam", PERSON, "person");
		await deleteEvent(t, ORG);
		const refresh = await t.run((ctx) =>
			ctx.db
				.query("oauth_refresh_tokens")
				.withIndex("by_tokenHash", (q) => q.eq("tokenHash", sha("ref-fam")))
				.unique(),
		);
		expect(refresh?.revokedAt).toBeDefined();
	});

	test("PRESENT: the same person's token in ANOTHER org survives the removal", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedMember(t, ORG);
		await seedMember(t, OTHER);
		await seedPersonAccess(t, "acc-other-org", OTHER);
		await deleteEvent(t, ORG);
		expect(await accessServed(t, "acc-other-org")).not.toBeNull();
	});

	test("PRESENT: another member's token in the same org survives", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedMember(t, ORG);
		await seedMember(t, ORG, "user_stays");
		await seedPersonAccess(t, "acc-stays", ORG, "user_stays");
		await deleteEvent(t, ORG);
		expect(await accessServed(t, "acc-stays")).not.toBeNull();
	});

	test("ABSENT: a seat token (userId is a seat name) is untouched", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedMember(t, ORG);
		await t.run((ctx) =>
			ctx.db.insert("oauth_access_tokens", {
				tokenHash: sha("acc-seat"),
				clientId: "seat-client",
				userId: "clio",
				scopes: ["mcp:full"],
				scopeProfile: "clio-acme-team",
				fromAllowList: ["clio"],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				expiresAt: Date.now() + 3_600_000,
				createdAt: Date.now(),
				clerkOrgSlug: ORG,
				clerkOrgId: testClerkOrgId(ORG),
			}),
		);
		await deleteEvent(t, ORG);
		expect(await accessServed(t, "acc-seat")).not.toBeNull();
	});

	test("REVOKED: the reconcile tombstone path revokes as well", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedMember(t, ORG);
		await seedMember(t, ORG, "user_stays");
		await seedPersonAccess(t, "acc-recon", ORG);
		// Clerk's full member list no longer names PERSON.
		await t.mutation(internal.orgMembership.reconcileOrgFromClerk, {
			clerkOrgId: testClerkOrgId(ORG),
			clerkOrgSlug: ORG,
			members: [{ userId: "user_stays", role: "member" }],
			dryRun: false,
			eventAt: 5_000,
		});
		expect(await accessServed(t, "acc-recon")).toBeNull();
	});

	test("REVOKED: a member holding more tokens than one batch is fully revoked via the continuation", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedMember(t, ORG);
		vi.useFakeTimers();
		const N = 250;
		for (let i = 0; i < N; i++) await seedPersonAccess(t, `acc-bulk-${i}`, ORG);
		await deleteEvent(t, ORG);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const live = await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("oauth_access_tokens")
				.withIndex("by_tokenHash")
				.collect();
			return rows.filter((r) => r.userId === PERSON && r.revokedAt === undefined)
				.length;
		});
		expect(live).toBe(0);
	});
});

describe("B - rotateRefreshToken refuses a person with no live membership", () => {
	test("REFUSED: a tombstoned member cannot refresh (explicit RBAC_DENIED, nothing minted)", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedProfile(t, "member-profile", ORG);
		await seedMember(t, ORG, PERSON, 500);
		await seedRefresh(t, "ref-tomb", PERSON, "member-profile");
		await expect(
			asService(t).mutation(
				api.oauth.rotateRefreshToken,
				rotation("ref-tomb", "member-profile", ORG),
			),
		).rejects.toThrow(/RBAC_DENIED/);
		const spent = await t.run((ctx) =>
			ctx.db
				.query("oauth_refresh_tokens")
				.withIndex("by_tokenHash", (q) => q.eq("tokenHash", sha("ref-tomb")))
				.unique(),
		);
		expect(spent?.revokedAt).toBeUndefined();
	});

	test("REFUSED: a person with NO membership row for the org (absent) cannot refresh", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedProfile(t, "member-profile", ORG);
		// The person is a member of ANOTHER org only: known as a person, absent here.
		await seedMember(t, OTHER);
		await seedRefresh(t, "ref-absent", PERSON, "member-profile");
		await expect(
			asService(t).mutation(
				api.oauth.rotateRefreshToken,
				rotation("ref-absent", "member-profile", ORG),
			),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("PRESENT: a current member refreshes normally", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedProfile(t, "member-profile", ORG);
		await seedMember(t, ORG);
		await seedRefresh(t, "ref-live", PERSON, "member-profile");
		const out = await asService(t).mutation(
			api.oauth.rotateRefreshToken,
			rotation("ref-live", "member-profile", ORG),
		);
		expect(out.status).toBe("ok");
	});

	test("ABSENT: a seat (userId is a seat name, no membership rows) refreshes normally", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedProfile(t, "clio-acme-team", ORG);
		await seedRefresh(t, "ref-seat", "clio", "clio-acme-team");
		const out = await asService(t).mutation(
			api.oauth.rotateRefreshToken,
			rotation("ref-seat", "clio-acme-team", ORG),
		);
		expect(out.status).toBe("ok");
	});
});
