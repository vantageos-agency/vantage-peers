/// <reference types="vite/client" />
// allow-missing-refs: new file
/**
 * seatBoundById.test.ts - batch C, module M3 residue. VantagePeers Cloud.
 *
 * Operator ruling 2026-10-13: "identify by id, not by name".
 *
 *   resolveSeatAgent never matches on a label. A seat profile names its agent
 *   by `agentId` or names none. A profile that is shaped like a one-agent seat
 *   (an organisation, exactly one allowlisted entry) and carries no `agentId`
 *   REFUSES, loudly, at mint (SEAT_PROFILE_UNBOUND) and never guesses a
 *   same-named agent. The idempotent migration
 *   `agentIdentityRows:bindSeatProfileAgentIds` binds every profile whose single
 *   label resolved before this change, reports the ones it could not, and
 *   writes nothing in dry-run.
 *
 *   REFUSED   an unbound one-agent seat profile; the same label in ANOTHER org
 *   ABSENT    an org-level profile (several entries, or none, or no org) is not
 *             a seat: it mints an org-level token and never refuses
 *   PRESENT   a bound profile mints a token stamped with the agent
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { resolveSeatAgent } from "../lib/seatAgent";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);

const NOW = 1_700_000_000_000;

async function seedOrg(t: T, slug: string): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: [],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: NOW,
		});
	});
}

async function seedAgent(
	t: T,
	orgSlug: string,
	name: string,
	isActive = true,
): Promise<Id<"agents">> {
	return await t.run(async (ctx) =>
		ctx.db.insert("agents", {
			orgSlug,
			clerkOrgId: testClerkOrgId(orgSlug),
			name,
			normalizedName: name.toLowerCase(),
			isActive,
			createdAt: NOW,
		}),
	);
}

async function seedProfile(
	t: T,
	profileId: string,
	fromAllowList: string[],
	clerkOrgSlug: string | undefined,
	agentId?: Id<"agents">,
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId,
			description: profileId,
			fromAllowList,
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			createdAt: NOW,
			updatedAt: NOW,
			...(clerkOrgSlug !== undefined
				? { clerkOrgSlug, clerkOrgId: testClerkOrgId(clerkOrgSlug) }
				: {}),
			...(agentId !== undefined ? { agentId } : {}),
		});
	});
}

let counter = 0;
async function mint(
	t: T,
	scopeProfile: string,
	fromAllowList: string[],
	clerkOrgSlug?: string,
): Promise<string> {
	counter += 1;
	const tokenHash = `seat-by-id-${counter}`;
	await asService(t).mutation(api.oauth.createAccessToken, {
		tokenHash,
		clientId: `client-${counter}`,
		userId: "seat",
		scopes: ["mcp:full"],
		scopeProfile,
		fromAllowList,
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 3_600_000,
		...(clerkOrgSlug !== undefined ? { clerkOrgSlug } : {}),
	});
	return tokenHash;
}

const tokenRow = (t: T, tokenHash: string) =>
	t.run((ctx) =>
		ctx.db
			.query("oauth_access_tokens")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
			.unique(),
	);

const seatToken = (profile: string, org: string) => ({
	scopeProfile: profile,
	clerkOrgSlug: org,
	clerkOrgId: testClerkOrgId(org),
});

describe("resolveSeatAgent follows the profile's agent ID and nothing else", () => {
	test("PRESENT: a bound profile resolves the agent it names", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const clio = await seedAgent(t, "org-a", "clio");
		await seedProfile(t, "clio-org-a", ["clio"], "org-a", clio);
		const agent = await t.run((ctx) =>
			resolveSeatAgent(ctx, seatToken("clio-org-a", "org-a")),
		);
		expect(agent?._id).toBe(clio);
	});

	test("REFUSED: an unbound one-agent profile resolves no agent although a same-named active agent sits in its own org", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedAgent(t, "org-a", "clio");
		await seedProfile(t, "clio-org-a", ["clio"], "org-a");
		const agent = await t.run((ctx) =>
			resolveSeatAgent(ctx, seatToken("clio-org-a", "org-a")),
		);
		expect(agent).toBeNull();
	});

	test("DENY (cross-org): the same label in another org is never chosen for an unbound profile", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await seedAgent(t, "org-b", "clio");
		await seedProfile(t, "clio-org-a", ["clio"], "org-a");
		const agent = await t.run((ctx) =>
			resolveSeatAgent(ctx, seatToken("clio-org-a", "org-a")),
		);
		expect(agent).toBeNull();
	});

	test("the source carries no label branch: no by-name lookup and no name normaliser", () => {
		const source = readFileSync(
			new URL("../lib/seatAgent.ts", import.meta.url),
			"utf8",
		);
		expect(source).not.toMatch(/findAgentByName/);
		expect(source).not.toMatch(/normalizeOrchestratorId/);
	});
});

describe("minting for a seat profile that names no agent refuses loudly", () => {
	test("REFUSED: createAccessToken on an unbound one-agent profile raises SEAT_PROFILE_UNBOUND and writes no token", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedAgent(t, "org-a", "clio");
		await seedProfile(t, "clio-org-a", ["clio"], "org-a");
		await expect(mint(t, "clio-org-a", ["clio"], "org-a")).rejects.toThrow(
			/SEAT_PROFILE_UNBOUND/,
		);
		const rows = await t.run((ctx) => ctx.db.query("oauth_access_tokens").collect());
		expect(rows).toHaveLength(0);
	});

	test("REFUSED: the refresh path is the same door, so a refresh against an unbound profile refuses too", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedAgent(t, "org-a", "clio");
		await seedProfile(t, "clio-org-a", ["clio"], "org-a");
		await t.run((ctx) =>
			ctx.db.insert("oauth_refresh_tokens", {
				tokenHash: "refresh-1",
				clientId: "client-r",
				userId: "clio",
				scopeProfile: "clio-org-a",
				expiresAt: Date.now() + 3_600_000,
				createdAt: Date.now(),
			}),
		);
		await expect(
			asService(t).mutation(api.oauth.rotateRefreshToken, {
				presentedHash: "refresh-1",
				clientId: "client-r",
				scopeProfile: "clio-org-a",
				scopes: ["mcp:full"],
				fromAllowList: ["clio"],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				clerkOrgSlug: "org-a",
				accessExpiresAt: Date.now() + 3_600_000,
				refreshExpiresAt: Date.now() + 7_200_000,
			}),
		).rejects.toThrow(/SEAT_PROFILE_UNBOUND/);
	});

	test("ABSENT: an org-level profile (several entries) is not a seat and mints an org-level token", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedAgent(t, "org-a", "clio");
		await seedAgent(t, "org-a", "iris");
		await seedProfile(t, "duo-org-a", ["clio", "iris"], "org-a");
		const hash = await mint(t, "duo-org-a", ["clio", "iris"], "org-a");
		expect((await tokenRow(t, hash))?.agentId).toBeUndefined();
	});

	test("ABSENT: a profile with no organisation (public-readonly shape) is not a seat and mints", async () => {
		const t = createT();
		await seedProfile(t, "public-readonly", ["external"], undefined);
		const hash = await mint(t, "public-readonly", ["external"]);
		expect((await tokenRow(t, hash))?.agentId).toBeUndefined();
	});

	test("PRESENT: a bound profile mints a token stamped with its agent", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const clio = await seedAgent(t, "org-a", "clio");
		await seedProfile(t, "clio-org-a", ["clio"], "org-a", clio);
		const hash = await mint(t, "clio-org-a", ["clio"], "org-a");
		expect((await tokenRow(t, hash))?.agentId).toBe(clio);
	});

	test("DENY (cross-org): a bound profile whose agent belongs to another org stamps nothing, and the own org's same label is not substituted", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await seedAgent(t, "org-a", "clio");
		const clioB = await seedAgent(t, "org-b", "clio");
		await seedProfile(t, "clio-org-a", ["clio"], "org-a", clioB);
		const hash = await mint(t, "clio-org-a", ["clio"], "org-a");
		expect((await tokenRow(t, hash))?.agentId).toBeUndefined();
	});
});

const bind = (t: T, dryRun: boolean, cursor: string | null = null) =>
	t.mutation(internal.migrations.agentIdentityRows.bindSeatProfileAgentIds, {
		dryRun,
		cursor,
	});

const profileOf = (t: T, profileId: string) =>
	t.run((ctx) =>
		ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", profileId))
			.unique(),
	);

describe("migrations/agentIdentityRows:bindSeatProfileAgentIds", () => {
	async function seedFleet(t: T) {
		await seedOrg(t, "iris-rh");
		await seedOrg(t, "org-b");
		const clio = await seedAgent(t, "iris-rh", "clio");
		await seedAgent(t, "org-b", "ghost"); // another org: never a candidate
		const retired = await seedAgent(t, "iris-rh", "retired", false);
		await seedAgent(t, "iris-rh", "hélios");
		await seedProfile(t, "clio-iris-rh", ["clio"], "iris-rh"); // resolves today
		await seedProfile(t, "ghost-iris-rh", ["ghost"], "iris-rh"); // label only in org-b
		await seedProfile(t, "retired-iris-rh", ["retired"], "iris-rh"); // inactive agent
		await seedProfile(t, "helios-iris-rh", ["hélios"], "iris-rh"); // accent: never resolved by the label branch
		await seedProfile(t, "duo-iris-rh", ["clio", "retired"], "iris-rh"); // org-level, not a seat
		await seedProfile(t, "master", ["*"], undefined); // wildcard, not a seat
		await seedProfile(t, "public-readonly", ["external"], undefined); // no org, not a seat
		await seedProfile(t, "bound-iris-rh", ["clio"], "iris-rh", clio); // already bound
		return { clio, retired };
	}

	test("dry-run reports what a real run would do and writes nothing", async () => {
		const t = createT();
		await seedFleet(t);
		const dry = await bind(t, true);
		expect(dry).toMatchObject({
			dryRun: true,
			updated: 1,
			alreadyBound: 1,
			notSeat: 3,
			isDone: true,
		});
		expect((await profileOf(t, "clio-iris-rh"))?.agentId).toBeUndefined();
	});

	test("PRESENT: a real run binds the profile whose single label resolved before, and only that one", async () => {
		const t = createT();
		const { clio } = await seedFleet(t);
		const res = await bind(t, false);
		expect(res.updated).toBe(1);
		expect((await profileOf(t, "clio-iris-rh"))?.agentId).toBe(clio);
		expect((await profileOf(t, "ghost-iris-rh"))?.agentId).toBeUndefined();
		expect((await profileOf(t, "retired-iris-rh"))?.agentId).toBeUndefined();
		expect((await profileOf(t, "helios-iris-rh"))?.agentId).toBeUndefined();
		expect((await profileOf(t, "duo-iris-rh"))?.agentId).toBeUndefined();
	});

	test("REPORT: every one-agent profile it could not bind is listed with the reason, other orgs' agents are never chosen", async () => {
		const t = createT();
		await seedFleet(t);
		const res = await bind(t, false);
		const byProfile = Object.fromEntries(
			res.unbound.map((u: { profileId: string; reason: string }) => [
				u.profileId,
				u.reason,
			]),
		);
		expect(byProfile).toEqual({
			"ghost-iris-rh": "agent-not-found",
			"retired-iris-rh": "agent-inactive",
			"helios-iris-rh": "profile-id-mismatch",
		});
	});

	test("IDEMPOTENT: a second run changes nothing and binds nothing new", async () => {
		const t = createT();
		await seedFleet(t);
		await bind(t, false);
		const again = await bind(t, false);
		expect(again).toMatchObject({ updated: 0, alreadyBound: 2 });
	});

	test("after the bind, the seat mints and its stamped token resolves; an unbound sibling still refuses", async () => {
		const t = createT();
		const { clio } = await seedFleet(t);
		await bind(t, false);
		const hash = await mint(t, "clio-iris-rh", ["clio"], "iris-rh");
		expect((await tokenRow(t, hash))?.agentId).toBe(clio);
		await expect(
			mint(t, "ghost-iris-rh", ["ghost"], "iris-rh"),
		).rejects.toThrow(/SEAT_PROFILE_UNBOUND/);
	});

	test("an unstamped live token follows its profile once the profile is bound (token backfill after profile bind)", async () => {
		const t = createT();
		const { clio } = await seedFleet(t);
		await t.run((ctx) =>
			ctx.db.insert("oauth_access_tokens", {
				tokenHash: "legacy",
				clientId: "c",
				userId: "clio",
				scopes: ["mcp:full"],
				scopeProfile: "clio-iris-rh",
				fromAllowList: ["clio"],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				expiresAt: Date.now() + 3_600_000,
				createdAt: Date.now(),
				clerkOrgSlug: "iris-rh",
				clerkOrgId: testClerkOrgId("iris-rh"),
			}),
		);
		const before = await t.mutation(
			internal.migrations.agentIdentityRows.backfillSeatTokenAgentIds,
			{ dryRun: true, cursor: null },
		);
		expect(before.undecidable).toBe(1);
		await bind(t, false);
		await t.mutation(
			internal.migrations.agentIdentityRows.backfillSeatTokenAgentIds,
			{ dryRun: false, cursor: null },
		);
		expect((await tokenRow(t, "legacy"))?.agentId).toBe(clio);
	});
});
