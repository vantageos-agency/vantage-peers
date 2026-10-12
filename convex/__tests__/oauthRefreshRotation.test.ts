/// <reference types="vite/client" />
/**
 * oauthRefreshRotation.test.ts - module M3 (VantagePeers Cloud, multi-tenant).
 *
 * The refresh grant is ONE mutation (`oauth:rotateRefreshToken`): it spends the
 * presented refresh token and mints the replacement pair in the same transaction.
 * A presentation of an already-spent token is a replay: the whole token FAMILY
 * (every access and refresh token descended from the same grant) is revoked, so a
 * thief who redeemed first loses the pair he was just given (RFC 6749 s10.4,
 * RFC 9700 s4.14). Mirrors the person-code path (`revokeAccessTokensForCode`).
 *
 * The door GENERATES the replacement pair and returns it once (`issued`): no caller sends
 * a token or a hash to be stored. Three poles: PRESENT (a live token rotates), REUSE (a spent token revokes the
 * family), DENY (expired / unknown / wrong client / unauthorised caller).
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
const asMemberOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `member-of-${org}`,
		org_id: testClerkOrgId(org),
		org_role: "org:member",
	} as Parameters<T["withIdentity"]>[0]);

const seedRefresh = (t: T, raw: string, expiresAt: number, clientId = "c1") =>
	t.run((ctx) =>
		ctx.db.insert("oauth_refresh_tokens", {
			tokenHash: sha(raw),
			clientId,
			userId: "seat",
			scopeProfile: "clio-org-a",
			expiresAt,
			createdAt: Date.now(),
		}),
	);

/** What server-http.ts hands the door: the presented hash, the client and the profile snapshot. */
const rotation = (presented: string, clientId = "c1") => ({
	presentedHash: sha(presented),
	clientId,
	scopeProfile: "clio-org-a",
	scopes: ["mcp:full"],
	fromAllowList: ["clio"],
	namespaceReadPrefixes: ["orchestrator/clio"],
	namespaceWritePrefixes: ["orchestrator/clio"],
	accessExpiresAt: Date.now() + 3_600_000,
	refreshExpiresAt: Date.now() + 30 * 86_400_000,
});

type Pair = { refresh: string; access: string };
/** Rotates and returns the outcome plus the pair the door generated (when ok). */
const rotate = async (t: T, presented: string, clientId = "c1") => {
	const out = await asService(t).mutation(api.oauth.rotateRefreshToken, rotation(presented, clientId));
	return { out, pair: out.status === "ok" ? (out.issued as Pair) : undefined };
};
const mustRotate = async (t: T, presented: string): Promise<Pair> => {
	const { out, pair } = await rotate(t, presented);
	expect(out.status).toBe("ok");
	return pair as Pair;
};

const liveRefresh = (t: T, raw: string) =>
	asService(t).query(api.oauth.getRefreshTokenByHash, { tokenHash: sha(raw) });
const liveAccess = (t: T, raw: string) =>
	asService(t).query(api.oauth.getAccessTokenByHash, { tokenHash: sha(raw) });

describe("PRESENT: a live refresh token rotates in one mutation", () => {
	test("the presented token is spent and the generated pair is live", async () => {
		const t = createT();
		await seedRefresh(t, "r1", Date.now() + 60_000);
		const pair = await mustRotate(t, "r1");
		expect(pair.refresh).not.toBe(pair.access);
		expect(pair.refresh).toMatch(/^[0-9a-f]{64}$/);
		expect(await liveRefresh(t, "r1")).toBeNull();
		expect(await liveRefresh(t, pair.refresh)).toMatchObject({ clientId: "c1", userId: "seat" });
		expect(await liveAccess(t, pair.access)).toMatchObject({ clientId: "c1", scopeProfile: "clio-org-a" });
	});

	test("two rotations never hand out the same pair", async () => {
		const t = createT();
		await seedRefresh(t, "r1", Date.now() + 60_000);
		await seedRefresh(t, "r1b", Date.now() + 60_000);
		const a = await mustRotate(t, "r1");
		const b = await mustRotate(t, "r1b");
		expect(a.refresh).not.toBe(b.refresh);
		expect(a.access).not.toBe(b.access);
	});

	test("a chain of honest rotations stays live end to end", async () => {
		const t = createT();
		await seedRefresh(t, "r1", Date.now() + 60_000);
		const p2 = await mustRotate(t, "r1");
		const p3 = await mustRotate(t, p2.refresh);
		expect(await liveRefresh(t, p3.refresh)).not.toBeNull();
		expect(await liveAccess(t, p3.access)).not.toBeNull();
	});
});

describe("REUSE: a spent token revokes the whole family", () => {
	test("attacker redeems first, victim replays: the attacker's access and refresh tokens are refused", async () => {
		const t = createT();
		await seedRefresh(t, "r1", Date.now() + 60_000);
		// The attacker redeems the stolen token FIRST and holds the pair.
		const attacker = await mustRotate(t, "r1");
		expect(await liveAccess(t, attacker.access)).not.toBeNull();
		// The victim presents the same (now spent) token.
		const replay = await rotate(t, "r1");
		expect(replay.out).toEqual({ status: "reused" });
		// The attacker's pair is dead; nothing was minted for the victim either.
		expect(await liveRefresh(t, attacker.refresh)).toBeNull();
		expect(await liveAccess(t, attacker.access)).toBeNull();
	});

	test("the family is the whole descent: a pair several rotations deep is revoked too", async () => {
		const t = createT();
		await seedRefresh(t, "r1", Date.now() + 60_000);
		const p2 = await mustRotate(t, "r1");
		const p3 = await mustRotate(t, p2.refresh);
		const p4 = await mustRotate(t, p3.refresh);
		// Replaying the ancestor p2 (already spent) kills p3/p4 and every access token.
		expect((await rotate(t, p2.refresh)).out).toEqual({ status: "reused" });
		for (const raw of [p3.refresh, p4.refresh]) expect(await liveRefresh(t, raw), raw).toBeNull();
		for (const raw of [p2.access, p3.access, p4.access]) expect(await liveAccess(t, raw), raw).toBeNull();
	});

	test("another family is untouched", async () => {
		const t = createT();
		await seedRefresh(t, "r1", Date.now() + 60_000);
		await seedRefresh(t, "other", Date.now() + 60_000);
		const other = await mustRotate(t, "other");
		await mustRotate(t, "r1");
		expect((await rotate(t, "r1")).out).toEqual({ status: "reused" });
		expect(await liveRefresh(t, other.refresh)).not.toBeNull();
		expect(await liveAccess(t, other.access)).not.toBeNull();
	});
});

describe("REUSE: the access token minted at code exchange is in the family", () => {
	test("a replay of the first refresh token revokes the access token issued beside it", async () => {
		const t = createT();
		const svc = asService(t);
		// What the authorization_code grant writes: a refresh row, then an access
		// token linked to it by refreshTokenHash (no familyId passed by the caller).
		await seedRefresh(t, "r1", Date.now() + 60_000);
		await svc.mutation(api.oauth.createAccessToken, {
			tokenHash: sha("a1"),
			clientId: "c1",
			userId: "seat",
			scopes: ["mcp:full"],
			scopeProfile: "clio-org-a",
			fromAllowList: ["clio"],
			namespaceReadPrefixes: ["orchestrator/clio"],
			namespaceWritePrefixes: ["orchestrator/clio"],
			expiresAt: Date.now() + 3_600_000,
			refreshTokenHash: sha("r1"),
		});
		expect(await liveAccess(t, "a1")).not.toBeNull();
		const p2 = await mustRotate(t, "r1");
		// Whoever replays r1 revokes the descent AND the access token issued with it.
		expect((await rotate(t, "r1")).out).toEqual({ status: "reused" });
		expect(await liveAccess(t, "a1")).toBeNull();
		expect(await liveAccess(t, p2.access)).toBeNull();
	});
});

describe("DENY: nothing is minted and nothing is spent on a refusal", () => {
	test("expired and unknown tokens answer invalid with no pair minted", async () => {
		const t = createT();
		await seedRefresh(t, "r-exp", Date.now() - 1);
		for (const raw of ["r-exp", "nobody"]) {
			const { out } = await rotate(t, raw);
			expect(out).toEqual({ status: "invalid" });
		}
		const rows = await t.run(async (ctx) => ({
			refresh: (await ctx.db.query("oauth_refresh_tokens").collect()).length,
			access: (await ctx.db.query("oauth_access_tokens").collect()).length,
		}));
		expect(rows).toEqual({ refresh: 1, access: 0 });
	});

	test("a client other than the token's own is refused and the token is NOT spent", async () => {
		const t = createT();
		await seedRefresh(t, "r1", Date.now() + 60_000);
		expect((await rotate(t, "r1", "someone-else")).out).toEqual({ status: "invalid" });
		expect(await liveRefresh(t, "r1")).not.toBeNull();
	});

	test("anonymous and ordinary members are refused and the token is not spent", async () => {
		const t = createT();
		await seedRefresh(t, "r1", Date.now() + 60_000);
		await expect(t.mutation(api.oauth.rotateRefreshToken, rotation("r1"))).rejects.toThrow(/RBAC_DENIED/);
		await expect(
			asMemberOf(t, "org-a").mutation(api.oauth.rotateRefreshToken, rotation("r1")),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await liveRefresh(t, "r1")).not.toBeNull();
	});

	test("the door no longer accepts a token or hash to store", async () => {
		const t = createT();
		await seedRefresh(t, "r1", Date.now() + 60_000);
		await expect(
			asService(t).mutation(api.oauth.rotateRefreshToken, {
				...rotation("r1"),
				newRefreshTokenHash: sha("chosen"),
				newAccessTokenHash: sha("chosen-a"),
			} as never),
		).rejects.toThrow();
		expect(await liveRefresh(t, "r1")).not.toBeNull();
		expect(await liveRefresh(t, "chosen")).toBeNull();
	});
});
