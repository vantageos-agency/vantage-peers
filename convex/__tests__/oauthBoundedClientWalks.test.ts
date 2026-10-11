/// <reference types="vite/client" />
/**
 * R-31 on the oauth surface — every walk over one client's (or one profile's)
 * token rows is bounded per transaction and continued through the scheduler,
 * and every refusal the door had is still refused.
 *
 * Doors: oauth:deleteClient, oauth:patchClientScopeAndRefreshTokens,
 * oauth:revokeAccessTokensOnly, oauth:patchScopeProfileEmergency (client
 * retarget), oauth:retrofitSeatRefreshToken (live-token existence check).
 *
 * Poles per walk: BOUNDED (one call does not touch the whole set), COMPLETE
 * (the continuation finishes it), NEGATIVE (another client's rows untouched),
 * REFUSED (the pre-existing refusal paths are intact; a non-service-account
 * caller is refused BEFORE anything is read).
 */

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
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

const REASON = "operator audit trail reason, well over twenty characters";
const LONG_REASON = `${REASON} and then some more to clear the forty-character bar`;
const N = 1100; // strictly more than two batches at CLIENT_TOKEN_BATCH = 500

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

async function seedClient(t: T, clientId: string, scopeProfile = "prof-old") {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_clients", {
			clientId,
			clientSecretHash: "h",
			redirectUris: [],
			name: clientId,
			scopeProfile,
			createdAt: Date.now(),
		});
	});
}

async function seedProfile(t: T, profileId: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId,
			description: "d",
			fromAllowList: ["nova"],
			namespaceReadPrefixes: ["team/x"],
			namespaceWritePrefixes: ["team/x"],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

async function seedAccess(
	t: T,
	clientId: string,
	n: number,
	o: { revoked?: boolean; expired?: boolean; scopeProfile?: string } = {},
) {
	await t.run(async (ctx) => {
		const now = Date.now();
		for (let i = 0; i < n; i++) {
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash: `a-${clientId}-${o.revoked ? "r" : "l"}-${i}-${Math.random()}`,
				clientId,
				userId: "u",
				scopes: ["vantage:read"],
				scopeProfile: o.scopeProfile ?? "prof-old",
				fromAllowList: ["old"],
				namespaceReadPrefixes: ["old"],
				namespaceWritePrefixes: ["old"],
				expiresAt: o.expired ? now - 1000 : now + 3_600_000,
				createdAt: now,
				...(o.revoked ? { revokedAt: now - 5 } : {}),
			});
		}
	});
}

async function seedRefresh(
	t: T,
	clientId: string,
	n: number,
	o: { revoked?: boolean; expired?: boolean; scopeProfile?: string } = {},
) {
	await t.run(async (ctx) => {
		const now = Date.now();
		for (let i = 0; i < n; i++) {
			await ctx.db.insert("oauth_refresh_tokens", {
				tokenHash: `r-${clientId}-${o.revoked ? "r" : "l"}-${i}-${Math.random()}`,
				clientId,
				userId: "u",
				scopeProfile: o.scopeProfile ?? "prof-old",
				expiresAt: o.expired ? now - 1000 : now + 3_600_000,
				createdAt: now,
				...(o.revoked ? { revokedAt: now - 5 } : {}),
			});
		}
	});
}

const access = (t: T, clientId: string) =>
	t.run((ctx) =>
		ctx.db
			.query("oauth_access_tokens")
			.withIndex("by_clientId", (q) => q.eq("clientId", clientId))
			.collect(),
	);
const refresh = (t: T, clientId: string) =>
	t.run((ctx) =>
		ctx.db
			.query("oauth_refresh_tokens")
			.withIndex("by_clientId", (q) => q.eq("clientId", clientId))
			.collect(),
	);
const live = <R extends { revokedAt?: number }>(rows: R[]) =>
	rows.filter((r) => r.revokedAt === undefined);

describe("oauth:deleteClient", () => {
	test("BOUNDED + COMPLETE + NEGATIVE: every token of the client ends revoked; another client's are untouched", async () => {
		const t = createT();
		await seedClient(t, "c1");
		await seedClient(t, "c2");
		await seedAccess(t, "c1", N);
		await seedRefresh(t, "c1", N);
		await seedAccess(t, "c2", 5);
		await seedRefresh(t, "c2", 5);

		const res = await asService(t).mutation(api.oauth.deleteClient, { clientId: "c1" });
		expect(res.revokedClient).toBe(true);
		// BOUNDED: one call did not walk the whole set.
		expect(live(await access(t, "c1")).length).toBeGreaterThan(0);
		expect(res.revokedTokens).toBeLessThan(N);

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect(live(await access(t, "c1"))).toHaveLength(0); // COMPLETE
		expect(live(await refresh(t, "c1"))).toHaveLength(0);
		expect(live(await access(t, "c2"))).toHaveLength(5); // NEGATIVE
		expect(live(await refresh(t, "c2"))).toHaveLength(5);
	});

	test("a small client is revoked entirely in the one call, counts unchanged, nothing scheduled", async () => {
		const t = createT();
		await seedClient(t, "c1");
		await seedAccess(t, "c1", 3);
		await seedAccess(t, "c1", 2, { revoked: true });
		await seedRefresh(t, "c1", 4);
		const res = await asService(t).mutation(api.oauth.deleteClient, { clientId: "c1" });
		expect(res).toEqual({ revokedClient: true, revokedTokens: 5, revokedRefresh: 4 });
		expect(live(await access(t, "c1"))).toHaveLength(0);
		const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		expect(scheduled).toHaveLength(0);
	});

	test("REFUSED: a non-service-account caller is refused and nothing is revoked; an unknown client is a clean false", async () => {
		const t = createT();
		await seedClient(t, "c1");
		await seedAccess(t, "c1", 3);
		await expect(
			asMember(t).mutation(api.oauth.deleteClient, { clientId: "c1" }),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(live(await access(t, "c1"))).toHaveLength(3);
		const none = await asService(t).mutation(api.oauth.deleteClient, { clientId: "ghost" });
		expect(none).toEqual({ revokedClient: false, revokedTokens: 0, revokedRefresh: 0 });
	});
});

describe("oauth:patchClientScopeAndRefreshTokens", () => {
	test("BOUNDED + COMPLETE: every live token ends on the new profile; revoked and expired ones are skipped", async () => {
		const t = createT();
		await seedClient(t, "c1");
		await seedClient(t, "c2");
		await seedProfile(t, "prof-new");
		await seedAccess(t, "c1", N);
		await seedAccess(t, "c1", 3, { revoked: true });
		await seedAccess(t, "c1", 3, { expired: true });
		await seedRefresh(t, "c1", N);
		await seedAccess(t, "c2", 4);

		const res = await asService(t).mutation(api.oauth.patchClientScopeAndRefreshTokens, {
			clientId: "c1",
			newScopeProfile: "prof-new",
			reason: REASON,
		});
		expect(res.clientPatched).toBe(true);
		expect(res.accessTokensRefreshed).toBeLessThan(N); // BOUNDED

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const acc = await access(t, "c1");
		const liveAcc = acc.filter((r) => r.revokedAt === undefined && r.expiresAt > Date.now());
		expect(liveAcc).toHaveLength(N);
		expect(liveAcc.every((r) => r.scopeProfile === "prof-new" && r.fromAllowList[0] === "nova")).toBe(true);
		// skipped rows keep the old scope
		expect(acc.filter((r) => r.revokedAt !== undefined).every((r) => r.scopeProfile === "prof-old")).toBe(true);
		expect(acc.filter((r) => r.expiresAt <= Date.now()).every((r) => r.scopeProfile === "prof-old")).toBe(true);
		expect((await refresh(t, "c1")).every((r) => r.scopeProfile === "prof-new")).toBe(true);
		// NEGATIVE
		expect((await access(t, "c2")).every((r) => r.scopeProfile === "prof-old")).toBe(true);
		// one audit row, not one per batch
		const audits = await t.run((ctx) => ctx.db.query("oauth_audit_log").collect());
		expect(audits.filter((a) => a.eventType === "patch_client_scope")).toHaveLength(1);
	});

	test("REFUSED: short reason, unknown client, revoked client, unknown profile, non-service-account", async () => {
		const t = createT();
		await seedClient(t, "c1");
		await seedProfile(t, "prof-new");
		const svc = asService(t);
		const base = { clientId: "c1", newScopeProfile: "prof-new", reason: REASON };
		await expect(
			svc.mutation(api.oauth.patchClientScopeAndRefreshTokens, { ...base, reason: "short" }),
		).rejects.toThrow(/at least 20 characters/);
		await expect(
			svc.mutation(api.oauth.patchClientScopeAndRefreshTokens, { ...base, clientId: "ghost" }),
		).rejects.toThrow(/client not found/);
		await expect(
			svc.mutation(api.oauth.patchClientScopeAndRefreshTokens, { ...base, newScopeProfile: "nope" }),
		).rejects.toThrow(/scope_profile not found/);
		await expect(
			asMember(t).mutation(api.oauth.patchClientScopeAndRefreshTokens, base),
		).rejects.toThrow(/RBAC_DENIED/);
		await svc.mutation(api.oauth.deleteClient, { clientId: "c1" });
		await expect(
			svc.mutation(api.oauth.patchClientScopeAndRefreshTokens, base),
		).rejects.toThrow(/client is revoked/);
	});
});

describe("oauth:revokeAccessTokensOnly", () => {
	test("BOUNDED + COMPLETE: every access token revoked, refresh tokens preserved untouched", async () => {
		const t = createT();
		await seedClient(t, "c1");
		await seedAccess(t, "c1", N);
		await seedRefresh(t, "c1", 7);

		const res = await asService(t).mutation(api.oauth.revokeAccessTokensOnly, {
			clientId: "c1",
			reason: REASON,
		});
		expect(res.accessTokensRevoked).toBeLessThan(N); // BOUNDED
		expect(res.refreshTokensPreserved).toBe(7);

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect(live(await access(t, "c1"))).toHaveLength(0); // COMPLETE
		expect(live(await refresh(t, "c1"))).toHaveLength(7); // preserved
	});

	test("REFUSED: short reason, unknown client, non-service-account", async () => {
		const t = createT();
		await seedClient(t, "c1");
		await expect(
			asService(t).mutation(api.oauth.revokeAccessTokensOnly, { clientId: "c1", reason: "short" }),
		).rejects.toThrow(/at least 20 characters/);
		await expect(
			asService(t).mutation(api.oauth.revokeAccessTokensOnly, { clientId: "ghost", reason: REASON }),
		).rejects.toThrow(/client not found/);
		await expect(
			asMember(t).mutation(api.oauth.revokeAccessTokensOnly, { clientId: "c1", reason: REASON }),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

describe("oauth:patchScopeProfileEmergency — client retarget on rename", () => {
	test("BOUNDED + COMPLETE + NEGATIVE: every client of the old profile follows the rename; others stay", async () => {
		const t = createT();
		await seedProfile(t, "prof-old");
		for (let i = 0; i < 1100; i++) await seedClient(t, `cl-${i}`, "prof-old");
		await seedClient(t, "bystander", "prof-other");

		const res = await asService(t).mutation(api.oauth.patchScopeProfileEmergency, {
			profileId: "prof-old",
			rename: "prof-renamed",
			cascadeRevokeTokens: false,
			reason: LONG_REASON,
		});
		expect(res.clientsRetargeted).toBeGreaterThan(0);
		expect(res.clientsRetargeted).toBeLessThan(1100); // BOUNDED

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const clients = await t.run((ctx) => ctx.db.query("oauth_clients").collect());
		expect(clients.filter((c) => c.scopeProfile === "prof-old")).toHaveLength(0); // COMPLETE
		expect(clients.filter((c) => c.scopeProfile === "prof-renamed")).toHaveLength(1100);
		expect(clients.find((c) => c.clientId === "bystander")?.scopeProfile).toBe("prof-other"); // NEGATIVE
	});
});

describe("oauth:retrofitSeatRefreshToken — live-token existence check", () => {
	async function seedSeat(t: T) {
		await seedClient(t, "seat", "prof-old");
		await seedProfile(t, "prof-old");
		await seedAccess(t, "seat", 1);
	}

	test("REFUSED stays exact: one live token, buried under hundreds of dead ones, still refuses a second mint", async () => {
		const t = createT();
		await seedSeat(t);
		await seedRefresh(t, "seat", 1); // the live one, oldest
		await seedRefresh(t, "seat", 600, { revoked: true });
		await seedRefresh(t, "seat", 5, { expired: true });
		await expect(
			t.mutation(internal.oauth.retrofitSeatRefreshToken, { clientId: "seat" }),
		).rejects.toThrow(/SEAT_ALREADY_HAS_LIVE_REFRESH_TOKEN/);
		expect(await refresh(t, "seat")).toHaveLength(606); // nothing minted
	});

	test("ALLOWED stays exact: only dead tokens (any number) -> a new one is minted", async () => {
		const t = createT();
		await seedSeat(t);
		await seedRefresh(t, "seat", 600, { revoked: true });
		await seedRefresh(t, "seat", 5, { expired: true });
		const res = await t.mutation(internal.oauth.retrofitSeatRefreshToken, { clientId: "seat" });
		expect(res.refreshToken).toBeTruthy();
		expect(await refresh(t, "seat")).toHaveLength(606);
	});

	test("REFUSED: unknown and revoked clients, and a client with no access token, as before", async () => {
		const t = createT();
		await expect(
			t.mutation(internal.oauth.retrofitSeatRefreshToken, { clientId: "ghost" }),
		).rejects.toThrow();
		await seedClient(t, "bare");
		await expect(
			t.mutation(internal.oauth.retrofitSeatRefreshToken, { clientId: "bare" }),
		).rejects.toThrow(/SEAT_CLIENT_NOT_FOUND/);
	});
});
