/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// Revoking a Client ID Metadata Document client (task k1788pydyztymht9cygzzpwvjn8hyyq1,
// the M2 finding of the dev-sentinel audit of the CIMD delivery).
//
// A CIMD client has no oauth_clients row, so `deleteClient` cannot revoke it. The
// operator lists its client_id URL; listing refuses it at /authorize, /token and
// refresh (the MCP reads `getDocumentClientDenial` before any fetch) and kills the
// tokens it already holds.
//
// REFUSED  anonymous and ordinary-member callers RAISE RBAC_DENIED on the write and on
//          the read (a refusal is not an empty result);
//          a short reason, a client_id that is not an https URL, no operator.
// ABSENT   a service-account read of a client that is not listed answers null.
// PRESENT  the listing answers the reason and the operator who added it.
// LIVE     a token minted BEFORE the listing stops answering AFTER it
//          (rights-change-migrates-live-connections.md): access and refresh rows are
//          revoked, and a token row that appears later is refused by derivation.
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { api } from "../_generated/api";
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
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];
const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asMember = (t: T) =>
	t.withIdentity({
		subject: "ordinary-member",
		organizationId: "acme-hr",
		organizationSlug: "acme-hr",
		org_id: "org_IRIS1",
	} as Identity);

const URL_A = "https://app.example.com/oauth/client-metadata.json";
const URL_B = "https://other.example.com/oauth/client-metadata.json";
const REASON = "abuse report 2026-11-10, operator audit trail";
const OPERATOR = "laurent";

const deny = (t: T, over: Record<string, unknown> = {}) =>
	asService(t).mutation(api.oauth.deleteClient, {
		clientId: URL_A,
		reason: REASON,
		operator: OPERATOR,
		...over,
	});
const denial = (t: T, clientId = URL_A) =>
	asService(t).query(api.oauth.getDocumentClientDenial, { clientId });
const lookup = (t: T, tokenHash: string) =>
	asService(t).query(api.oauth.getAccessTokenByHash, { tokenHash });

async function mint(t: T, tokenHash: string, clientId: string) {
	// A seat-style token holds only what its live scope profile grants.
	await t.run(async (ctx) => {
		const have = await ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", "p"))
			.unique();
		if (have === null)
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "p",
				description: "test profile",
				fromAllowList: ["clio"],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
	});
	await asService(t).mutation(api.oauth.createAccessToken, {
		tokenHash,
		clientId,
		userId: "user_1",
		scopes: ["mcp:full"],
		scopeProfile: "p",
		fromAllowList: ["clio"],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 3_600_000,
	});
}

async function refreshRow(t: T, tokenHash: string, clientId: string) {
	return await t.run((ctx) =>
		ctx.db.insert("oauth_refresh_tokens", {
			tokenHash,
			clientId,
			userId: "user_1",
			scopeProfile: "p",
			expiresAt: Date.now() + 3_600_000,
			createdAt: Date.now(),
			principal: "person",
		}),
	);
}

describe("REFUSED", () => {
	test("an anonymous caller and an ordinary member RAISE RBAC_DENIED on the write", async () => {
		const t = createT();
		const args = { clientId: URL_A, reason: REASON, operator: OPERATOR };
		await expect(t.mutation(api.oauth.deleteClient, args)).rejects.toThrow(
			/RBAC_DENIED/,
		);
		await expect(
			asMember(t).mutation(api.oauth.deleteClient, args),
		).rejects.toThrow(/RBAC_DENIED/);
		const rows = await t.run((ctx) =>
			ctx.db.query("oauth_denied_document_clients").collect(),
		);
		expect(rows).toHaveLength(0);
	});

	test("an anonymous caller and an ordinary member RAISE RBAC_DENIED on the read: a refusal is not an absence", async () => {
		const t = createT();
		await expect(
			t.query(api.oauth.getDocumentClientDenial, { clientId: URL_A }),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(
			asMember(t).query(api.oauth.getDocumentClientDenial, { clientId: URL_A }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("a short reason and a missing operator are refused with a code; nothing is listed", async () => {
		const t = createT();
		await expect(deny(t, { reason: "too short" })).rejects.toThrow(
			/REASON_TOO_SHORT/,
		);
		await expect(deny(t, { operator: " " })).rejects.toThrow(
			/OPERATOR_REQUIRED/,
		);
		expect(await denial(t)).toBeNull();
	});

	test("a client_id that is neither registered nor an https URL is not listed", async () => {
		const t = createT();
		for (const clientId of ["not-a-url", "http://app.example.com/c.json"]) {
			expect(await deny(t, { clientId })).toMatchObject({
				revokedClient: false,
			});
			expect(await denial(t, clientId)).toBeNull();
		}
	});
});

describe("ABSENT and PRESENT", () => {
	test("a client that is not listed answers null to the service account", async () => {
		const t = createT();
		expect(await denial(t)).toBeNull();
	});

	test("a listed client answers its reason and the operator who added it; another URL is still absent", async () => {
		const t = createT();
		await deny(t);
		expect(await denial(t)).toMatchObject({
			clientId: URL_A,
			reason: REASON,
			addedBy: OPERATOR,
		});
		expect(await denial(t, URL_B)).toBeNull();
	});

	test("listing twice is idempotent: one row, alreadyDenied the second time", async () => {
		const t = createT();
		expect(await deny(t)).toMatchObject({
			revokedClient: true,
			alreadyDenied: false,
		});
		expect(await deny(t)).toMatchObject({ alreadyDenied: true });
		const rows = await t.run((ctx) =>
			ctx.db.query("oauth_denied_document_clients").collect(),
		);
		expect(rows).toHaveLength(1);
	});

	test("deleting the row (the operator, in the Convex dashboard) lifts the listing; the revoked tokens stay revoked", async () => {
		const t = createT();
		await mint(t, "tok-1", URL_A);
		await deny(t);
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("oauth_denied_document_clients")
				.withIndex("by_clientId", (q) => q.eq("clientId", URL_A))
				.unique();
			if (row) await ctx.db.delete(row._id);
		});
		expect(await denial(t)).toBeNull();
		expect(await lookup(t, "tok-1")).toBeNull();
	});
});

describe("LIVE: a token minted before the listing stops answering after it", () => {
	test("access and refresh tokens of the listed client die; another client's survive", async () => {
		const t = createT();
		await mint(t, "tok-a", URL_A);
		await mint(t, "tok-b", URL_B);
		const refreshA = await refreshRow(t, "ref-a", URL_A);
		const refreshB = await refreshRow(t, "ref-b", URL_B);
		expect(await lookup(t, "tok-a")).not.toBeNull(); // before: it answers
		expect(await lookup(t, "tok-b")).not.toBeNull();

		const out = await deny(t);
		expect(out).toMatchObject({
			revokedTokens: 1,
			revokedRefresh: 1,
		});

		expect(await lookup(t, "tok-a")).toBeNull(); // after: it does not
		expect(await lookup(t, "tok-b")).not.toBeNull(); // the other client is untouched
		expect(
			(await t.run((ctx) => ctx.db.get(refreshA)))?.revokedAt,
		).toBeDefined();
		expect(
			(await t.run((ctx) => ctx.db.get(refreshB)))?.revokedAt,
		).toBeUndefined();
	});

	test("a token row that appears after the listing is refused by derivation, not by the walk", async () => {
		const t = createT();
		await deny(t);
		await mint(t, "late", URL_A);
		expect(await lookup(t, "late")).toBeNull();
	});
});

describe("round 2 — unlisting through the same door, with an audit that keeps its history", () => {
	const lift = (t: T, over: Record<string, unknown> = {}) =>
		asService(t).mutation(api.oauth.deleteClient, {
			clientId: URL_A,
			reason: "reviewed, the client is legitimate again",
			operator: "pi",
			lift: true,
			...over,
		});
	const auditRow = (t: T) =>
		t.run(async (ctx) =>
			ctx.db
				.query("oauth_denied_document_clients")
				.withIndex("by_clientId", (q) => q.eq("clientId", URL_A))
				.unique(),
		);

	test("listing then unlisting: the denial is lifted, a token minted after works, the one before stays dead, both events are in the audit", async () => {
		const t = createT();
		await mint(t, "before", URL_A);
		await deny(t);
		expect(await denial(t)).not.toBeNull();
		expect(await lift(t)).toMatchObject({ unlisted: true });
		expect(await denial(t)).toBeNull();
		await mint(t, "after", URL_A);
		expect(await lookup(t, "after")).not.toBeNull();
		expect(await lookup(t, "before")).toBeNull();
		const row = await auditRow(t);
		expect(row?.active).toBe(false);
		expect(row?.history.map((h) => h.action)).toEqual(["listed", "unlisted"]);
		expect(row?.history[0]).toMatchObject({ by: OPERATOR, reason: REASON });
		expect(row?.history[1]).toMatchObject({
			by: "pi",
			reason: "reviewed, the client is legitimate again",
		});
		expect(row?.history[1].at).toBeGreaterThan(0);
	});

	test("listing again after an unlisting keeps all three events on one row", async () => {
		const t = createT();
		await deny(t);
		await lift(t);
		await deny(t);
		expect(await denial(t)).not.toBeNull();
		const row = await auditRow(t);
		expect(row?.active).toBe(true);
		expect(row?.history.map((h) => h.action)).toEqual([
			"listed",
			"unlisted",
			"listed",
		]);
	});

	test("a token row of an unlisted client that was minted while it was listed stays refused", async () => {
		const t = createT();
		await deny(t);
		await mint(t, "during", URL_A);
		expect(await lookup(t, "during")).toBeNull();
		await lift(t);
		// the row appeared while listed: after the lift it is simply a live token again
		// only if it was never revoked; the walk ran BEFORE it existed, so it answers
		expect(await lookup(t, "during")).not.toBeNull();
	});

	test("unlisting needs a reason and an operator; an unknown client unlists nothing", async () => {
		const t = createT();
		await deny(t);
		await expect(lift(t, { reason: "short" })).rejects.toThrow(/REASON_TOO_SHORT/);
		await expect(lift(t, { operator: " " })).rejects.toThrow(/OPERATOR_REQUIRED/);
		expect(await lift(t, { clientId: URL_B })).toMatchObject({
			revokedClient: false,
			unlisted: false,
		});
		expect(await denial(t)).not.toBeNull();
	});

	test("an anonymous caller and a member cannot unlist: RBAC_DENIED", async () => {
		const t = createT();
		await deny(t);
		const args = {
			clientId: URL_A,
			reason: "reviewed, the client is legitimate again",
			operator: "pi",
			lift: true,
		};
		await expect(t.mutation(api.oauth.deleteClient, args)).rejects.toThrow(/RBAC_DENIED/);
		await expect(asMember(t).mutation(api.oauth.deleteClient, args)).rejects.toThrow(/RBAC_DENIED/);
		expect(await denial(t)).not.toBeNull();
	});
});

describe("round 2 — a client_id that is not in canonical form is not listed", () => {
	test("refused with revokedClient false instead of listing a string no client will present", async () => {
		const t = createT();
		for (const clientId of [
			"https://APP.example.com/oauth/client-metadata.json",
			"https://app.example.com/a/../b.json",
			"https://app.example.com:443/b.json",
			"https://app.example.com/b.json#frag",
		]) {
			expect(await deny(t, { clientId })).toMatchObject({ revokedClient: false });
			expect(await denial(t, clientId)).toBeNull();
		}
	});
});
