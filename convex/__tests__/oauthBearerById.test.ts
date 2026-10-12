/// <reference types="vite/client" />
/**
 * oauthBearerById.test.ts - module M3. VantagePeers Cloud (multi-tenant).
 *
 * A token is minted for, and resolved to, an AGENT ID. The codes, refresh tokens
 * and user bearers that lead to a token are single-use / revocable / bounded, and
 * no secret (or digest of one) is written where it can be read back.
 *
 *   AGENT ID     a seat profile carries the `agents` row ID of its agent; the token
 *                stamped at mint and the lookup both follow THAT ID. An ID that
 *                names an agent of ANOTHER org yields no agent (a same-named agent of
 *                the profile's own org is NOT substituted for it).
 *   CODES        an authorization code is stored as a digest, consumed once, and an
 *                expired or unknown one is refused (null).
 *   REFRESH      a refresh token is rotated on use and a replay revokes its family;
 *                see oauthRefreshRotation.test.ts.
 *   BEARERS      a user bearer minted from a Clerk JWT is revocable by its user, and a
 *                user holds at most one live bearer.
 *   AUDIT        the master secret leaves no digest of itself in oauth_audit_log.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
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
const asMemberOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `member-of-${org}`,
		org_id: testClerkOrgId(org),
		org_role: "org:member",
	} as Parameters<T["withIdentity"]>[0]);

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
			createdAt: Date.now(),
		}),
	);
}

async function seedProfile(
	t: T,
	profileId: string,
	clerkOrgSlug: string,
	agentId?: Id<"agents">,
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId,
			description: profileId,
			fromAllowList: ["clio"],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
			clerkOrgSlug,
			clerkOrgId: testClerkOrgId(clerkOrgSlug),
			...(agentId !== undefined ? { agentId } : {}),
		});
	});
}

let counter = 0;
async function mintSeatToken(
	t: T,
	profileId: string,
	clerkOrgSlug: string,
): Promise<string> {
	counter += 1;
	const tokenHash = `m3-hash-${counter}`;
	await asService(t).mutation(api.oauth.createAccessToken, {
		tokenHash,
		clientId: `client-${counter}`,
		userId: "seat",
		scopes: ["mcp:full"],
		scopeProfile: profileId,
		fromAllowList: ["clio"],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 3_600_000,
		clerkOrgSlug,
	});
	return tokenHash;
}

const lookup = (t: T, tokenHash: string) =>
	asService(t).query(api.oauth.getAccessTokenByHash, { tokenHash });

describe("a seat token is bound to the agent ID of its profile", () => {
	test("PRESENT: the token follows profile.agentId, and a rename changes the label, not the agent", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const clioA = await seedAgent(t, "org-a", "clio");
		await seedProfile(t, "clio-org-a", "org-a", clioA);
		const hash = await mintSeatToken(t, "clio-org-a", "org-a");
		const row = await t.run((ctx) =>
			ctx.db
				.query("oauth_access_tokens")
				.withIndex("by_tokenHash", (q) => q.eq("tokenHash", hash))
				.unique(),
		);
		expect(row?.agentId).toBe(clioA);
		await t.run((ctx) => ctx.db.patch(clioA, { name: "clio-renamed" }));
		expect((await lookup(t, hash))?.seatAgent).toEqual({
			agentId: clioA,
			orgId: "org-a",
			agentName: "clio-renamed",
		});
	});

	test("DENY: a profile whose agentId names ANOTHER org's agent yields no agent, even though the own org has a same-name agent", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await seedAgent(t, "org-a", "clio"); // same label, own org: must NOT be substituted
		const clioB = await seedAgent(t, "org-b", "clio");
		await seedProfile(t, "clio-org-a", "org-a", clioB);
		const hash = await mintSeatToken(t, "clio-org-a", "org-a");
		const row = await t.run((ctx) =>
			ctx.db
				.query("oauth_access_tokens")
				.withIndex("by_tokenHash", (q) => q.eq("tokenHash", hash))
				.unique(),
		);
		expect(row?.agentId).toBeUndefined();
		expect((await lookup(t, hash))?.seatAgent).toBeNull();
	});

	test("DENY: a stamp that now names an agent of another org stops resolving", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const clioA = await seedAgent(t, "org-a", "clio");
		await seedProfile(t, "clio-org-a", "org-a", clioA);
		const hash = await mintSeatToken(t, "clio-org-a", "org-a");
		expect((await lookup(t, hash))?.seatAgent?.agentId).toBe(clioA);
		await t.run((ctx) =>
			ctx.db.patch(clioA, {
				orgSlug: "org-b",
				clerkOrgId: testClerkOrgId("org-b"),
			}),
		);
		expect((await lookup(t, hash))?.seatAgent).toBeNull();
	});

	test("ABSENT: a profile with no agentId still resolves the single agent of its own org (expand phase) and the token is stamped", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const clioA = await seedAgent(t, "org-a", "clio");
		await seedProfile(t, "clio-org-a", "org-a");
		const hash = await mintSeatToken(t, "clio-org-a", "org-a");
		expect((await lookup(t, hash))?.seatAgent?.agentId).toBe(clioA);
	});

	test("provisionOrganization writes the agent ID of each seat onto its profile and its token", async () => {
		const t = createT();
		const res = await asService(t).mutation(api.oauth.provisionOrganization, {
			callerToken: "test-master-token",
			clerkOrgSlug: "org-new",
			clerkOrgId: testClerkOrgId("org-new"),
			displayName: "Org New",
			orchestrators: [{ name: "clio" }],
		});
		expect(res.orchestrators).toHaveLength(1);
		const state = await t.run(async (ctx) => {
			const agent = await ctx.db
				.query("agents")
				.withIndex("by_org", (q) => q.eq("orgSlug", "org-new"))
				.unique();
			const profile = await ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) => q.eq("profileId", "clio-org-new"))
				.unique();
			const token = await ctx.db.query("oauth_access_tokens").first();
			return { agent, profile, token };
		});
		expect(state.agent).not.toBeNull();
		expect(state.profile?.agentId).toBe(state.agent?._id);
		expect(state.token?.agentId).toBe(state.agent?._id);
	});
});

describe("authorization codes are stored hashed and spent once", () => {
	const codeArgs = (code: string, expiresAt: number) => ({
		code,
		clientId: "c1",
		redirectUri: "https://client.example/cb",
		codeChallenge: "challenge",
		scope: "mcp:full",
		userId: "u1",
		expiresAt,
	});

	test("PRESENT: the row holds a digest, the raw code redeems once, the second redemption is null", async () => {
		const t = createT();
		const svc = asService(t);
		await svc.mutation(
			api.oauth.createAuthorizationCode,
			codeArgs("raw-code-1", Date.now() + 60_000),
		);
		const rows = await t.run((ctx) =>
			ctx.db.query("oauth_authorization_codes").collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].code).toBe(sha("raw-code-1"));
		expect(rows[0].code).not.toBe("raw-code-1");
		const first = await svc.mutation(api.oauth.consumeAuthorizationCode, {
			code: "raw-code-1",
		});
		expect(first?.clientId).toBe("c1");
		expect(
			await svc.mutation(api.oauth.consumeAuthorizationCode, {
				code: "raw-code-1",
			}),
		).toBeNull();
	});

	test("DENY: the stored digest is not itself redeemable (a read of the table is not a code)", async () => {
		const t = createT();
		const svc = asService(t);
		await svc.mutation(
			api.oauth.createAuthorizationCode,
			codeArgs("raw-code-2", Date.now() + 60_000),
		);
		expect(
			await svc.mutation(api.oauth.consumeAuthorizationCode, {
				code: sha("raw-code-2"),
			}),
		).toBeNull();
	});

	test("DENY: an expired code and a garbled one are refused identically (null), and the expired row is spent", async () => {
		const t = createT();
		const svc = asService(t);
		await svc.mutation(
			api.oauth.createAuthorizationCode,
			codeArgs("raw-code-3", Date.now() - 1),
		);
		expect(
			await svc.mutation(api.oauth.consumeAuthorizationCode, {
				code: "raw-code-3",
			}),
		).toBeNull();
		expect(
			await svc.mutation(api.oauth.consumeAuthorizationCode, {
				code: "\u0000garbled",
			}),
		).toBeNull();
		const left = await t.run((ctx) =>
			ctx.db.query("oauth_authorization_codes").collect(),
		);
		expect(left).toHaveLength(0);
	});

	test("DENY: an ordinary org member cannot redeem", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await expect(
			asMemberOf(t, "org-a").mutation(api.oauth.consumeAuthorizationCode, {
				code: "x",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

describe("user bearers minted from a Clerk JWT are revocable and capped", () => {
	const mint = (t: T, clerkUserId: string, tokenHash: string) =>
		t.mutation(internal.credentials._issueToken, {
			tokenHash,
			clerkUserId,
			workspaceId: clerkUserId,
			extId: "ext-1",
			expiresAt: Date.now() + 86_400_000,
		});
	const live = (t: T, clerkUserId: string) =>
		t.run(async (ctx) =>
			(
				await ctx.db
					.query("userBearerTokens")
					.withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
					.collect()
			).filter((r) => !r.revoked && r.expiresAt > Date.now()).length,
		);

	test("CAP: three mints leave one live bearer; another user's bearer is untouched", async () => {
		const t = createT();
		await mint(t, "user_a", "h1");
		await mint(t, "user_a", "h2");
		await mint(t, "user_a", "h3");
		await mint(t, "user_b", "h4");
		expect(await live(t, "user_a")).toBe(1);
		expect(await live(t, "user_b")).toBe(1);
	});

	test("REVOKE: a signed-in user revokes their own bearers only", async () => {
		const t = createT();
		await mint(t, "user_a", "h1");
		await mint(t, "user_b", "h2");
		const res = await t
			.withIdentity({ subject: "user_a" })
			.mutation(api.credentials.revokeMyBearers, {});
		expect(res).toEqual({ revoked: 1 });
		expect(await live(t, "user_a")).toBe(0);
		expect(await live(t, "user_b")).toBe(1);
	});

	test("REVOKE: anonymous is refused (RBAC_DENIED) and revokes nothing", async () => {
		const t = createT();
		await mint(t, "user_a", "h1");
		await expect(t.mutation(api.credentials.revokeMyBearers, {})).rejects.toThrow(
			/RBAC_DENIED/,
		);
		expect(await live(t, "user_a")).toBe(1);
	});
});

describe("the master secret leaves no digest of itself in the audit log", () => {
	test("provisionOrganization by master token records an actor digest that is not sha256(secret)", async () => {
		const t = createT();
		await t.mutation(api.oauth.provisionOrganization, {
			callerToken: "test-master-token",
			clerkOrgSlug: "org-audit",
			clerkOrgId: testClerkOrgId("org-audit"),
			displayName: "Org Audit",
			orchestrators: [{ name: "clio" }],
		});
		const rows = await t.run((ctx) =>
			ctx.db
				.query("oauth_audit_log")
				.filter((q) => q.eq(q.field("eventType"), "organization_provision"))
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].actorTokenHash).toMatch(/^[0-9a-f]{64}$/);
		expect(rows[0].actorTokenHash).not.toBe(sha("test-master-token"));
	});
});
