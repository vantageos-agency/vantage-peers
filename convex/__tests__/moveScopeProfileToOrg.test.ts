/// <reference types="vite/client" />
/**
 * moveScopeProfileToOrg — the deliberate, named move of a seat profile from
 * one org to another (bindScopeProfileToOrg refuses that on purpose).
 *
 * Poles: MOVED (slug + id re-stamped, agentId cleared, live tokens revoked,
 * everything else untouched), IDEMPOTENT replay (no write), and one test per
 * refusal code, each asserting that nothing was written. Fixture orgs are
 * fictitious.
 */
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const REASON = "move test seat into the test org";

async function seedOrg(
	t: T,
	slug: string,
	opts: { isActive?: boolean; orgKind?: "operator" | "client"; clerkOrgId?: string } = {},
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			displayName: slug,
			allowedOrchestrators: [],
			scopes: ["view-own-tasks"],
			isActive: opts.isActive ?? true,
			createdAt: Date.now(),
			...(opts.orgKind ? { orgKind: opts.orgKind } : {}),
			...(opts.clerkOrgId ? { clerkOrgId: opts.clerkOrgId } : {}),
		});
	});
}

async function seedAgent(t: T, orgSlug: string): Promise<Id<"agents">> {
	return await t.run(async (ctx) =>
		ctx.db.insert("agents", { orgSlug, name: "seat-agent", isActive: true, createdAt: 1 }),
	);
}

async function seedProfile(
	t: T,
	profileId: string,
	clerkOrgSlug?: string,
	extra: { clerkOrgId?: string; agentId?: Id<"agents"> } = {},
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId,
			description: profileId,
			fromAllowList: ["a1"],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			createdAt: 1,
			updatedAt: 1,
			...(clerkOrgSlug !== undefined ? { clerkOrgSlug } : {}),
			...extra,
		});
	});
}

async function seedTokens(t: T, profileId: string, tag: string, revokedAt?: number) {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_access_tokens", {
			tokenHash: `acc-${tag}`,
			clientId: "c",
			userId: "u",
			scopes: [],
			scopeProfile: profileId,
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() + 3_600_000,
			createdAt: 1,
			...(revokedAt !== undefined ? { revokedAt } : {}),
		});
		await ctx.db.insert("oauth_refresh_tokens", {
			tokenHash: `ref-${tag}`,
			clientId: "c",
			userId: "u",
			scopeProfile: profileId,
			expiresAt: Date.now() + 3_600_000,
			createdAt: 1,
			...(revokedAt !== undefined ? { revokedAt } : {}),
		});
	});
}

const getProfile = (t: T, profileId: string) =>
	t.run(async (ctx) =>
		ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", profileId))
			.unique(),
	);

const snapshot = (t: T) =>
	t.run(async (ctx) => ({
		profiles: await ctx.db.query("oauth_scope_profiles").collect(),
		access: await ctx.db.query("oauth_access_tokens").collect(),
		refresh: await ctx.db.query("oauth_refresh_tokens").collect(),
	}));

const move = (
	t: T,
	over: Partial<{
		profileId: string;
		targetClerkOrgSlug: string;
		confirmProfileId: string;
		reason: string;
	}> = {},
) =>
	t.mutation(internal.tenantOrgSeed.moveScopeProfileToOrg, {
		profileId: "p1",
		targetClerkOrgSlug: "org-new",
		confirmProfileId: "p1",
		reason: REASON,
		...over,
	});

describe("moveScopeProfileToOrg — the move", () => {
	test("re-stamps slug and id, clears agentId, reports the previous org and agent", async () => {
		const t = createT();
		await seedOrg(t, "org-old", { clerkOrgId: "org_old1" });
		await seedOrg(t, "org-new", { clerkOrgId: "org_new1" });
		const agentId = await seedAgent(t, "org-old");
		await seedProfile(t, "p1", "org-old", { clerkOrgId: "org_old1", agentId });

		const r = await move(t);

		expect(r).toEqual({
			profileId: "p1",
			previousOrgSlug: "org-old",
			targetOrgSlug: "org-new",
			moved: true,
			revokedAccessTokens: 0,
			revokedRefreshTokens: 0,
			previousAgentId: agentId,
		});
		const row = await getProfile(t, "p1");
		expect(row?.clerkOrgSlug).toBe("org-new");
		expect(row?.clerkOrgId).toBe("org_new1");
		expect(row?.agentId).toBeUndefined();
		expect(row?.updatedAt).toBeGreaterThan(1);
		// Nothing deleted.
		expect((await snapshot(t)).profiles).toHaveLength(1);
	});

	test("an unbound profile moves in with previousOrgSlug null and previousAgentId null", async () => {
		const t = createT();
		await seedOrg(t, "org-new");
		await seedProfile(t, "p1");
		const r = await move(t);
		expect(r.moved).toBe(true);
		expect(r.previousOrgSlug).toBeNull();
		expect(r.previousAgentId).toBeNull();
		expect((await getProfile(t, "p1"))?.clerkOrgSlug).toBe("org-new");
	});

	test("live access and refresh tokens are revoked; revoked and foreign-profile tokens are untouched", async () => {
		const t = createT();
		await seedOrg(t, "org-old");
		await seedOrg(t, "org-new");
		await seedProfile(t, "p1", "org-old");
		await seedProfile(t, "p2", "org-old");
		await seedTokens(t, "p1", "live-1");
		await seedTokens(t, "p1", "live-2");
		await seedTokens(t, "p1", "dead", 777);
		await seedTokens(t, "p2", "other");

		const r = await move(t);

		expect(r.revokedAccessTokens).toBe(2);
		expect(r.revokedRefreshTokens).toBe(2);
		const s = await snapshot(t);
		const byHash = (rows: { tokenHash: string; revokedAt?: number }[], h: string) =>
			rows.find((x) => x.tokenHash === h);
		for (const rows of [s.access, s.refresh]) {
			const pre = rows === s.access ? "acc-" : "ref-";
			expect(byHash(rows, `${pre}live-1`)?.revokedAt).toBeGreaterThan(0);
			expect(byHash(rows, `${pre}live-2`)?.revokedAt).toBeGreaterThan(0);
			expect(byHash(rows, `${pre}dead`)?.revokedAt).toBe(777);
			expect(byHash(rows, `${pre}other`)?.revokedAt).toBeUndefined();
		}
		expect(s.access).toHaveLength(4);
		expect(s.refresh).toHaveLength(4);
		// The other profile stays where it was.
		expect((await getProfile(t, "p2"))?.clerkOrgSlug).toBe("org-old");
	});
});

describe("moveScopeProfileToOrg — idempotent replay", () => {
	test("a profile already on the target slug returns moved:false and writes nothing", async () => {
		const t = createT();
		await seedOrg(t, "org-new");
		await seedProfile(t, "p1", "org-new");
		await seedTokens(t, "p1", "live");
		const before = await snapshot(t);

		const r = await move(t);

		expect(r.moved).toBe(false);
		expect(r.previousOrgSlug).toBe("org-new");
		expect(r.targetOrgSlug).toBe("org-new");
		expect(r.revokedAccessTokens).toBe(0);
		expect(r.revokedRefreshTokens).toBe(0);
		expect(await snapshot(t)).toEqual(before);
	});

	test("second identical call after a real move is a no-op", async () => {
		const t = createT();
		await seedOrg(t, "org-old");
		await seedOrg(t, "org-new");
		await seedProfile(t, "p1", "org-old");
		await seedTokens(t, "p1", "live");
		expect((await move(t)).moved).toBe(true);
		const mid = await snapshot(t);
		const r2 = await move(t);
		expect(r2.moved).toBe(false);
		expect(await snapshot(t)).toEqual(mid);
	});
});

describe("moveScopeProfileToOrg — refusals write nothing", () => {
	async function expectRefused(
		t: T,
		code: string,
		over: Parameters<typeof move>[1] = {},
	) {
		const before = await snapshot(t);
		const err = await move(t, over).then(
			() => "",
			(e: Error) => String(e),
		);
		expect(err).toMatch(new RegExp(code));
		expect(await snapshot(t)).toEqual(before);
	}

	async function seeded() {
		const t = createT();
		await seedOrg(t, "org-old");
		await seedOrg(t, "org-new");
		await seedProfile(t, "p1", "org-old");
		await seedTokens(t, "p1", "live");
		return t;
	}

	test("PROFILE_NOT_FOUND", async () => {
		const t = await seeded();
		await expectRefused(t, "PROFILE_NOT_FOUND", { profileId: "ghost", confirmProfileId: "ghost" });
	});

	test("ORG_NOT_FOUND", async () => {
		const t = await seeded();
		await expectRefused(t, "ORG_NOT_FOUND", { targetClerkOrgSlug: "no-such-org" });
	});

	test("ORG_INACTIVE", async () => {
		const t = await seeded();
		await seedOrg(t, "org-off", { isActive: false });
		await expectRefused(t, "ORG_INACTIVE", { targetClerkOrgSlug: "org-off" });
	});

	test("OPERATOR_ORG_OUT_OF_SCOPE", async () => {
		const t = await seeded();
		await seedOrg(t, "org-operator", { orgKind: "operator" });
		await expectRefused(t, "OPERATOR_ORG_OUT_OF_SCOPE", { targetClerkOrgSlug: "org-operator" });
	});

	test("MOVE_NOT_NAMED when confirmProfileId differs", async () => {
		const t = await seeded();
		await expectRefused(t, "MOVE_NOT_NAMED", { confirmProfileId: "p1 " });
	});

	test("MOVE_REASON_REQUIRED when the trimmed reason is under 10 characters", async () => {
		const t = await seeded();
		await expectRefused(t, "MOVE_REASON_REQUIRED", { reason: "  too short  " });
	});
});
