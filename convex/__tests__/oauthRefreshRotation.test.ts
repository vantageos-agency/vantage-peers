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
 * Three poles: PRESENT (a live token rotates), REUSE (a spent token revokes the
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

/** What server-http.ts hands the door: hashes of the pair to mint, plus the profile snapshot. */
const rotation = (presented: string, nextRefresh: string, nextAccess: string, clientId = "c1") => ({
	presentedHash: sha(presented),
	clientId,
	newRefreshTokenHash: sha(nextRefresh),
	newAccessTokenHash: sha(nextAccess),
	scopeProfile: "clio-org-a",
	scopes: ["mcp:full"],
	fromAllowList: ["clio"],
	namespaceReadPrefixes: ["orchestrator/clio"],
	namespaceWritePrefixes: ["orchestrator/clio"],
	accessExpiresAt: Date.now() + 3_600_000,
	refreshExpiresAt: Date.now() + 30 * 86_400_000,
});

const liveRefresh = (t: T, raw: string) =>
	asService(t).query(api.oauth.getRefreshTokenByHash, { tokenHash: sha(raw) });
const liveAccess = (t: T, raw: string) =>
	asService(t).query(api.oauth.getAccessTokenByHash, { tokenHash: sha(raw) });

describe("PRESENT: a live refresh token rotates in one mutation", () => {
	test("the presented token is spent and the new pair is live", async () => {
		const t = createT();
		await seedRefresh(t, "r1", Date.now() + 60_000);
		const out = await asService(t).mutation(
			api.oauth.rotateRefreshToken,
			rotation("r1", "r2", "a2"),
		);
		expect(out).toEqual({ status: "ok" });
		expect(await liveRefresh(t, "r1")).toBeNull();
		expect(await liveRefresh(t, "r2")).toMatchObject({ clientId: "c1", userId: "seat" });
		expect(await liveAccess(t, "a2")).toMatchObject({ clientId: "c1", scopeProfile: "clio-org-a" });
	});

	test("a chain of honest rotations stays live end to end", async () => {
		const t = createT();
		await seedRefresh(t, "r1", Date.now() + 60_000);
		const svc = asService(t);
		expect(await svc.mutation(api.oauth.rotateRefreshToken, rotation("r1", "r2", "a2"))).toEqual({ status: "ok" });
		expect(await svc.mutation(api.oauth.rotateRefreshToken, rotation("r2", "r3", "a3"))).toEqual({ status: "ok" });
		expect(await liveRefresh(t, "r3")).not.toBeNull();
		expect(await liveAccess(t, "a3")).not.toBeNull();
	});
});

describe("REUSE: a spent token revokes the whole family", () => {
	test("attacker redeems first, victim replays: the attacker's access and refresh tokens are refused", async () => {
		const t = createT();
		await seedRefresh(t, "r1", Date.now() + 60_000);
		const svc = asService(t);
		// The attacker redeems the stolen token FIRST and holds the pair (r2, a2).
		expect(await svc.mutation(api.oauth.rotateRefreshToken, rotation("r1", "r2", "a2"))).toEqual({ status: "ok" });
		expect(await liveAccess(t, "a2")).not.toBeNull();
		// The victim presents the same (now spent) token.
		const replay = await svc.mutation(api.oauth.rotateRefreshToken, rotation("r1", "r3", "a3"));
		expect(replay).toEqual({ status: "reused" });
		// The attacker's pair is dead; nothing was minted for the victim either.
		expect(await liveRefresh(t, "r2")).toBeNull();
		expect(await liveAccess(t, "a2")).toBeNull();
		expect(await liveRefresh(t, "r3")).toBeNull();
		expect(await liveAccess(t, "a3")).toBeNull();
	});

	test("the family is the whole descent: a pair several rotations deep is revoked too", async () => {
		const t = createT();
		await seedRefresh(t, "r1", Date.now() + 60_000);
		const svc = asService(t);
		await svc.mutation(api.oauth.rotateRefreshToken, rotation("r1", "r2", "a2"));
		await svc.mutation(api.oauth.rotateRefreshToken, rotation("r2", "r3", "a3"));
		await svc.mutation(api.oauth.rotateRefreshToken, rotation("r3", "r4", "a4"));
		// Replaying the ancestor r2 (already spent) kills r3/r4 and a2..a4.
		expect(await svc.mutation(api.oauth.rotateRefreshToken, rotation("r2", "r5", "a5"))).toEqual({ status: "reused" });
		for (const raw of ["r3", "r4"]) expect(await liveRefresh(t, raw), raw).toBeNull();
		for (const raw of ["a2", "a3", "a4"]) expect(await liveAccess(t, raw), raw).toBeNull();
	});

	test("another family is untouched", async () => {
		const t = createT();
		await seedRefresh(t, "r1", Date.now() + 60_000);
		await seedRefresh(t, "other", Date.now() + 60_000);
		const svc = asService(t);
		await svc.mutation(api.oauth.rotateRefreshToken, rotation("other", "other2", "oa2"));
		await svc.mutation(api.oauth.rotateRefreshToken, rotation("r1", "r2", "a2"));
		await svc.mutation(api.oauth.rotateRefreshToken, rotation("r1", "r3", "a3"));
		expect(await liveRefresh(t, "other2")).not.toBeNull();
		expect(await liveAccess(t, "oa2")).not.toBeNull();
	});
});

describe("DENY: nothing is minted and nothing is spent on a refusal", () => {
	test("expired and unknown tokens answer invalid with no pair minted", async () => {
		const t = createT();
		await seedRefresh(t, "r-exp", Date.now() - 1);
		const svc = asService(t);
		for (const raw of ["r-exp", "nobody"]) {
			expect(
				await svc.mutation(api.oauth.rotateRefreshToken, rotation(raw, `${raw}-n`, `${raw}-a`)),
			).toEqual({ status: "invalid" });
			expect(await liveRefresh(t, `${raw}-n`)).toBeNull();
			expect(await liveAccess(t, `${raw}-a`)).toBeNull();
		}
	});

	test("a client other than the token's own is refused and the token is NOT spent", async () => {
		const t = createT();
		await seedRefresh(t, "r1", Date.now() + 60_000);
		const svc = asService(t);
		expect(
			await svc.mutation(api.oauth.rotateRefreshToken, rotation("r1", "r2", "a2", "someone-else")),
		).toEqual({ status: "invalid" });
		expect(await liveRefresh(t, "r1")).not.toBeNull();
	});

	test("anonymous and ordinary members are refused and the token is not spent", async () => {
		const t = createT();
		await seedRefresh(t, "r1", Date.now() + 60_000);
		await expect(
			t.mutation(api.oauth.rotateRefreshToken, rotation("r1", "r2", "a2")),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(
			asMemberOf(t, "org-a").mutation(api.oauth.rotateRefreshToken, rotation("r1", "r2", "a2")),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await liveRefresh(t, "r1")).not.toBeNull();
	});
});
