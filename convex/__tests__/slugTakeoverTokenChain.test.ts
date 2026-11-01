/// <reference types="vite/client" />
// allow-missing-refs: new test file created by the specialist
/**
 * The token chain after an org-slug takeover (task k1783fk8r6p795x9fxrzyt9evd8hcxm7,
 * sweep sites A-1..A-5; same class as tokenMappingSlugTakeover.test.ts, #1619, #1622, #1624).
 *
 * Modelling: org A (clerkOrgId X) holds slug S; tokens/profiles/tasks are stamped
 * with S and X; A is renamed away by a direct db write; org B (clerkOrgId Y) takes S.
 *
 *   A-1 oauth:getAccessTokenByHash   resolves the token's org by row.clerkOrgId
 *   A-2 oauth:createAccessToken      never stamps an ID derived from a slug
 *   A-3 oauth:rotateRefreshToken     membership judged by the family's clerkOrgId
 *   A-4 verifiedOrg doors            the verified mapping is the org the token's ID names;
 *                                    the row gate compares IDs, not slug stamps
 *   A-5 orgRoster:getForAccessToken  keyed on token.clerkOrgId
 */

import { createHash } from "node:crypto";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedAgents } from "../../tests/lib/agentIdOf";
import { insertTaskRow } from "../../tests/lib/seedFleetAgents";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill"),
	),
);

type T = ReturnType<typeof convexTest>;
const createT = (): T =>
	convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

const SLUG = "shared-slug";
const RENAMED = "renamed-a";
const ORG_A = testClerkOrgId("org-a-permanent") as string;
const ORG_B = testClerkOrgId("org-b-permanent") as string;
const DAY = 86_400_000;

type World = { t: T };

/** A (X) held SLUG and was renamed; B (Y) now holds SLUG. */
async function takeover(): Promise<World> {
	const t = createT();
	await t.run(async (ctx) => {
		const mappingA = await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: SLUG,
			clerkOrgId: ORG_A,
			allowedOrchestrators: ["sigma", "nadia-a"],
			scopes: ["view-own-tasks"],
			displayName: "A",
			isActive: true,
			createdAt: 1,
		});
		await ctx.db.patch(mappingA, { clerkOrgSlug: RENAMED });
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: SLUG,
			clerkOrgId: ORG_B,
			allowedOrchestrators: ["sigma", "bruno-b"],
			scopes: ["view-own-tasks"],
			displayName: "B",
			isActive: true,
			createdAt: 2,
		});
	});
	return { t };
}

async function insertToken(
	t: T,
	tokenHash: string,
	org: { clerkOrgSlug?: string; clerkOrgId?: string },
	extra: Record<string, unknown> = {},
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_access_tokens", {
			tokenHash,
			clientId: "client-a",
			userId: "user-a",
			scopes: ["vantage:read"],
			scopeProfile: "team-member",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() + 3_600_000,
			createdAt: Date.now(),
			...org,
			...extra,
		});
	});
}

async function outcome<R>(p: Promise<R>): Promise<R | string> {
	try {
		return await p;
	} catch (e) {
		return e instanceof ConvexError ? String(e.data) : String(e);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// A-1
// ─────────────────────────────────────────────────────────────────────────────
describe("A-1 getAccessTokenByHash after a slug takeover", () => {
	test("REFUSE-OR-A: a token minted for A names A (id X), never B (id Y), and the label is A's CURRENT slug", async () => {
		const { t } = await takeover();
		await insertToken(t, "hash-a", { clerkOrgSlug: SLUG, clerkOrgId: ORG_A });
		const row = await asService(t).query(api.oauth.getAccessTokenByHash, {
			tokenHash: "hash-a",
		});
		expect(row?.orgClerkId).not.toBe(ORG_B);
		expect(row?.orgClerkId).toBe(ORG_A);
		expect(row?.clerkOrgSlug).toBe(RENAMED);
	});

	test("REFUSED: a token row with a slug and NO clerkOrgId is not served (re-deriving the ID from the slug is the takeover read)", async () => {
		const { t } = await takeover();
		await insertToken(t, "hash-legacy", { clerkOrgSlug: SLUG });
		expect(
			await asService(t).query(api.oauth.getAccessTokenByHash, {
				tokenHash: "hash-legacy",
			}),
		).toBeNull();
	});

	test("PRESENT: a token with no org at all is still served, with no org keys", async () => {
		const { t } = await takeover();
		await insertToken(t, "hash-noorg", {});
		const row = await asService(t).query(api.oauth.getAccessTokenByHash, {
			tokenHash: "hash-noorg",
		});
		expect(row).not.toBeNull();
		expect(row && "orgClerkId" in row).toBe(false);
		expect(row && "clerkOrgSlug" in row).toBe(false);
	});

	test("PRESENT: an untouched org (no rename) is served with its own label and id", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "plain-org",
				clerkOrgId: ORG_A,
				allowedOrchestrators: [],
				scopes: [],
				displayName: "P",
				isActive: true,
				createdAt: 1,
			});
		});
		await insertToken(t, "hash-p", { clerkOrgSlug: "plain-org", clerkOrgId: ORG_A });
		const row = await asService(t).query(api.oauth.getAccessTokenByHash, {
			tokenHash: "hash-p",
		});
		expect(row?.clerkOrgSlug).toBe("plain-org");
		expect(row?.orgClerkId).toBe(ORG_A);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// A-2
// ─────────────────────────────────────────────────────────────────────────────
describe("A-2 createAccessToken stamps the ID of its verified source, never a slug's current holder", () => {
	async function seatProfile(t: T) {
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "sigma-acme",
				description: "seat",
				fromAllowList: ["sigma"],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				createdAt: 1,
				updatedAt: 1,
				// stale label (A's old slug), permanent ID of A
				clerkOrgSlug: SLUG,
				clerkOrgId: ORG_A,
			});
		});
	}
	const mint = (t: T, over: Record<string, unknown> = {}) =>
		asService(t).mutation(api.oauth.createAccessToken, {
			tokenHash: "minted-hash",
			clientId: "c1",
			userId: "seat",
			scopes: ["mcp:full"],
			scopeProfile: "sigma-acme",
			fromAllowList: ["sigma"],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() + 3_600_000,
			clerkOrgSlug: SLUG,
			...over,
		});
	const stored = (t: T) =>
		t.run((ctx) =>
			ctx.db
				.query("oauth_access_tokens")
				.withIndex("by_tokenHash", (q) => q.eq("tokenHash", "minted-hash"))
				.unique(),
		);

	test("REFUSE-OR-A: a profile of A (stale label S, id X) mints a token stamped with X, never B's Y", async () => {
		const { t } = await takeover();
		await seatProfile(t);
		await mint(t);
		const row = await stored(t);
		expect(row?.clerkOrgId).not.toBe(ORG_B);
		expect(row?.clerkOrgId).toBe(ORG_A);
		expect(row?.clerkOrgSlug).toBe(RENAMED);
	});

	test("REFUSED: a mint with an organisation label and no ID-bearing source (no profile ID, no code) is refused, nothing stored", async () => {
		const { t } = await takeover();
		const out = await outcome(mint(t, { scopeProfile: "no-such-profile" }));
		expect(String(out)).toMatch(/MINT_ORG_ID_REQUIRED/);
		expect(await stored(t)).toBeNull();
	});

	test("PRESENT: a mint with no organisation at all is unchanged", async () => {
		const { t } = await takeover();
		await mint(t, { scopeProfile: "no-such-profile", clerkOrgSlug: undefined });
		const row = await stored(t);
		expect(row).not.toBeNull();
		expect(row?.clerkOrgId).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// A-3
// ─────────────────────────────────────────────────────────────────────────────
describe("A-3 rotateRefreshToken: a person family is judged by its own clerkOrgId", () => {
	const USER = "user_p";
	async function family(t: T, memberOf: string) {
		await t.run(async (ctx) => {
			await ctx.db.insert("orgMembership", {
				clerkOrgSlug: memberOf === ORG_A ? RENAMED : SLUG,
				clerkOrgId: memberOf,
				clerkUserId: USER,
				role: "member",
				createdAt: 1,
				updatedAt: 1,
				lastEventAt: 1,
			});
			await ctx.db.insert("oauth_refresh_tokens", {
				tokenHash: sha("refresh-seat"),
				clientId: "c1",
				userId: USER,
				scopeProfile: "sigma-acme",
				expiresAt: Date.now() + DAY,
				createdAt: Date.now(),
				familyId: "fam-1",
			});
		});
		await insertToken(
			t,
			sha("access-fam"),
			{ clerkOrgSlug: SLUG, clerkOrgId: ORG_A },
			{ userId: USER, principal: "person", familyId: "fam-1", orgRole: "org:member" },
		);
	}
	const rotate = (t: T) =>
		asService(t).mutation(api.oauth.rotateRefreshToken, {
			presentedHash: sha("refresh-seat"),
			clientId: "c1",
			scopeProfile: "sigma-acme",
			scopes: ["mcp:full"],
			fromAllowList: ["sigma"],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			clerkOrgSlug: SLUG,
			accessExpiresAt: Date.now() + 3_600_000,
			refreshExpiresAt: Date.now() + 30 * DAY,
		});
	async function profile(t: T) {
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "sigma-acme",
				description: "seat",
				fromAllowList: ["sigma"],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				createdAt: 1,
				updatedAt: 1,
				clerkOrgSlug: SLUG,
				clerkOrgId: ORG_A,
			});
		});
	}

	test("REFUSED: a person who is a member of B (the slug's holder) but not of A cannot refresh A's family", async () => {
		const { t } = await takeover();
		await profile(t);
		await family(t, ORG_B);
		const out = await outcome(rotate(t));
		expect(JSON.stringify(out)).not.toContain('"status":"ok"');
		const spent = await t.run((ctx) =>
			ctx.db
				.query("oauth_refresh_tokens")
				.withIndex("by_tokenHash", (q) => q.eq("tokenHash", sha("refresh-seat")))
				.unique(),
		);
		expect(spent?.revokedAt).toBeUndefined();
	});

	test("PRESENT: a person who is a member of A refreshes A's family", async () => {
		const { t } = await takeover();
		await profile(t);
		await family(t, ORG_A);
		const out = await rotate(t);
		expect(out.status).toBe("ok");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// A-4
// ─────────────────────────────────────────────────────────────────────────────
describe("A-4 verifiedOrg doors resolve and gate by permanent ID", () => {
	async function twoTasks(t: T) {
		await seedAgents(t, [
			[RENAMED, "sigma"],
			[SLUG, "sigma"],
		]);
		// A's task keeps A's STALE slug stamp (S) and A's id; B has no task.
		return await t.run(async (ctx) =>
			insertTaskRow(ctx, {
				title: "[REVIEW] a's task",
				assignedTo: "sigma",
				createdBy: "sigma",
				priority: "medium",
				status: "todo",
				orgId: SLUG,
				clerkOrgId: ORG_A,
				createdAt: 1,
				updatedAt: 1,
			}),
		);
	}
	const attach = (t: T, taskId: Id<"tasks">, orgSlug: string) =>
		asService(t).mutation(api.tasks.attachReviewArtifact, {
			taskId,
			callerOrchestrator: "sigma",
			artifactRef: "https://example.test/pr/1",
			verifiedOrg: { orgSlug },
		});

	test("REFUSE: B (verifiedOrg = S, the slug A used to hold) cannot touch A's task stamped S", async () => {
		const { t } = await takeover();
		const id = await twoTasks(t);
		await outcome(attach(t, id, SLUG));
		expect(
			(await t.run((ctx) => ctx.db.get(id)))?.reviewArtifactRef,
		).toBeUndefined();
	});

	test("CORRECT: A (verifiedOrg = A's current label) reaches its own task whose slug stamp is stale", async () => {
		const { t } = await takeover();
		const id = await twoTasks(t);
		await outcome(attach(t, id, RENAMED));
		expect(
			(await t.run((ctx) => ctx.db.get(id)))?.reviewArtifactRef,
		).toBe("https://example.test/pr/1");
	});

	test("CHAIN: the label getAccessTokenByHash hands the MCP resolves to A, not B", async () => {
		const { t } = await takeover();
		const id = await twoTasks(t);
		await insertToken(t, "hash-a", { clerkOrgSlug: SLUG, clerkOrgId: ORG_A });
		const ctxRow = await asService(t).query(api.oauth.getAccessTokenByHash, {
			tokenHash: "hash-a",
		});
		const label = ctxRow?.clerkOrgSlug ?? "";
		expect(label).toBe(RENAMED);
		await outcome(attach(t, id, label));
		expect((await t.run((ctx) => ctx.db.get(id)))?.reviewArtifactRef).toBe(
			"https://example.test/pr/1",
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// A-5
// ─────────────────────────────────────────────────────────────────────────────
describe("A-5 orgRoster:getForAccessToken is keyed on token.clerkOrgId", () => {
	const roster = (t: T, tokenHash: string) =>
		outcome(asService(t).query(api.orgRoster.getForAccessToken, { tokenHash }));

	test("REFUSE-OR-A: a token minted for A never returns B's roster", async () => {
		const { t } = await takeover();
		await insertToken(t, "hash-a", { clerkOrgSlug: SLUG, clerkOrgId: ORG_A });
		const out = await roster(t, "hash-a");
		expect(JSON.stringify(out)).not.toContain("bruno-b");
	});

	test("CORRECT: A's token after the rename returns A's roster", async () => {
		const { t } = await takeover();
		await insertToken(t, "hash-a", { clerkOrgSlug: SLUG, clerkOrgId: ORG_A });
		expect(await roster(t, "hash-a")).toEqual(["sigma", "nadia-a"]);
	});

	test("REFUSED: a token row with a slug and no clerkOrgId is refused", async () => {
		const { t } = await takeover();
		await insertToken(t, "hash-legacy", { clerkOrgSlug: SLUG });
		expect(String(await roster(t, "hash-legacy"))).toMatch(/RBAC_DENIED/);
	});
});
