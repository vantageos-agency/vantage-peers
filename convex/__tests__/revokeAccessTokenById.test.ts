/// <reference types="vite/client" />
/**
 * oauth:revokeAccessTokenById — revoke ONE access token by its row id.
 *
 * Poles: REVOKED (live token dies, the bearer lookup stops serving it),
 * NO-CLIENT-ROW (works with no oauth_clients row), REFRESH (the paired refresh
 * token dies with it), NEGATIVE (siblings of the same client untouched),
 * REFUSED (anonymous / org member / short reason / unknown id, row untouched),
 * IDEMPOTENT (second call changes nothing).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
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
const asMember = (t: T) =>
	t.withIdentity({
		subject: "ordinary-member",
		organizationId: "org-a",
		organizationSlug: "org-a",
	} as Identity);

const REASON = "operator revoke of one leaked token, well over twenty chars";

async function seedAccess(
	t: T,
	clientId: string,
	tokenHash: string,
	refreshTokenHash?: string,
): Promise<Id<"oauth_access_tokens">> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert("oauth_access_tokens", {
			tokenHash,
			clientId,
			userId: "u",
			scopes: ["vantage:read"],
			scopeProfile: "prof",
			fromAllowList: ["nova"],
			namespaceReadPrefixes: ["team/x"],
			namespaceWritePrefixes: ["team/x"],
			expiresAt: now + 3_600_000,
			createdAt: now,
			...(refreshTokenHash ? { refreshTokenHash } : {}),
		});
	});
}

async function seedRefresh(t: T, clientId: string, tokenHash: string) {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert("oauth_refresh_tokens", {
			tokenHash,
			clientId,
			userId: "u",
			scopeProfile: "prof",
			expiresAt: now + 3_600_000,
			createdAt: now,
		});
	});
}

const row = (t: T, id: Id<"oauth_access_tokens">) =>
	t.run((ctx) => ctx.db.get(id));
const refreshRow = (t: T, tokenHash: string) =>
	t.run((ctx) =>
		ctx.db
			.query("oauth_refresh_tokens")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
			.unique(),
	);

describe("oauth:revokeAccessTokenById", () => {
	test("service account revokes a live token; the bearer lookup stops serving it", async () => {
		const t = createT();
		const id = await seedAccess(t, "c1", "hash-live");
		expect(
			await asService(t).query(api.oauth.getAccessTokenByHash, {
				tokenHash: "hash-live",
			}),
		).not.toBeNull();

		const res = await asService(t).mutation(api.oauth.revokeAccessTokenById, {
			tokenId: id,
			reason: REASON,
		});
		expect(res.revoked).toBe(true);
		expect(res.tokenId).toBe(id);
		expect(res.clientId).toBe("c1");
		const after = await row(t, id);
		expect(after?.revokedAt).toBe(res.revokedAt);
		expect(
			await asService(t).query(api.oauth.getAccessTokenByHash, {
				tokenHash: "hash-live",
			}),
		).toBeNull();
	});

	test("a token whose clientId has NO oauth_clients row is revoked", async () => {
		const t = createT();
		const id = await seedAccess(t, "ghost-client", "hash-ghost");
		const clients = await t.run((ctx) => ctx.db.query("oauth_clients").take(1));
		expect(clients).toHaveLength(0);
		const res = await asService(t).mutation(api.oauth.revokeAccessTokenById, {
			tokenId: id,
			reason: REASON,
		});
		expect(res.revoked).toBe(true);
		expect((await row(t, id))?.revokedAt).toBeTypeOf("number");
	});

	test("the paired refresh token is revoked with it; an unrelated one is not", async () => {
		const t = createT();
		await seedRefresh(t, "c1", "refresh-paired");
		await seedRefresh(t, "c1", "refresh-other");
		const id = await seedAccess(t, "c1", "hash-a", "refresh-paired");
		await seedAccess(t, "c1", "hash-b", "refresh-other");
		await asService(t).mutation(api.oauth.revokeAccessTokenById, {
			tokenId: id,
			reason: REASON,
		});
		expect((await refreshRow(t, "refresh-paired"))?.revokedAt).toBeTypeOf(
			"number",
		);
		expect((await refreshRow(t, "refresh-other"))?.revokedAt).toBeUndefined();
	});

	test("other tokens of the same client are untouched", async () => {
		const t = createT();
		const id = await seedAccess(t, "c1", "hash-1");
		const sibling = await seedAccess(t, "c1", "hash-2");
		await asService(t).mutation(api.oauth.revokeAccessTokenById, {
			tokenId: id,
			reason: REASON,
		});
		expect((await row(t, sibling))?.revokedAt).toBeUndefined();
		expect(
			await asService(t).query(api.oauth.getAccessTokenByHash, {
				tokenHash: "hash-2",
			}),
		).not.toBeNull();
	});

	test("anonymous caller is refused RBAC_DENIED, row untouched", async () => {
		const t = createT();
		const id = await seedAccess(t, "c1", "hash-x");
		await expect(
			t.mutation(api.oauth.revokeAccessTokenById, {
				tokenId: id,
				reason: REASON,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect((await row(t, id))?.revokedAt).toBeUndefined();
	});

	test("ordinary org member is refused RBAC_DENIED naming the door, row untouched", async () => {
		const t = createT();
		const id = await seedAccess(t, "c1", "hash-y");
		await expect(
			asMember(t).mutation(api.oauth.revokeAccessTokenById, {
				tokenId: id,
				reason: REASON,
			}),
		).rejects.toThrow(/RBAC_DENIED.*oauth:revokeAccessTokenById/);
		expect((await row(t, id))?.revokedAt).toBeUndefined();
	});

	test("a reason under 20 characters is refused, row untouched", async () => {
		const t = createT();
		const id = await seedAccess(t, "c1", "hash-z");
		await expect(
			asService(t).mutation(api.oauth.revokeAccessTokenById, {
				tokenId: id,
				reason: "too short",
			}),
		).rejects.toThrow(/reason must be at least 20 characters/);
		expect((await row(t, id))?.revokedAt).toBeUndefined();
	});

	test("an unknown id is refused TOKEN_NOT_FOUND naming the door", async () => {
		const t = createT();
		const id = await seedAccess(t, "c1", "hash-gone");
		await t.run((ctx) => ctx.db.delete(id));
		await expect(
			asService(t).mutation(api.oauth.revokeAccessTokenById, {
				tokenId: id,
				reason: REASON,
			}),
		).rejects.toThrow(/TOKEN_NOT_FOUND.*oauth:revokeAccessTokenById/);
	});

	test("a second call is idempotent and keeps the first revokedAt", async () => {
		const t = createT();
		const id = await seedAccess(t, "c1", "hash-twice");
		const first = await asService(t).mutation(api.oauth.revokeAccessTokenById, {
			tokenId: id,
			reason: REASON,
		});
		const second = await asService(t).mutation(
			api.oauth.revokeAccessTokenById,
			{ tokenId: id, reason: REASON },
		);
		expect(second.revoked).toBe(false);
		expect(second.alreadyRevokedAt).toBe(first.revokedAt);
		expect((await row(t, id))?.revokedAt).toBe(first.revokedAt);
	});
});
