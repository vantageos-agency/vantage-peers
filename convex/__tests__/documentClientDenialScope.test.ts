/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// CIMD follow-up (Eta's APPROVED verdict on #1733, residues 1 and 3).
//
// 1. DENY BY HOST OR DOMAIN. The deny-list matched only the exact client_id URL, so
//    another path on a denied host passed. `oauth:deleteClient` takes `scope`
//    ("url" | "host" | "domain"); the shared helper (convex/lib/documentClientDenial.ts)
//    asks all three keys, so every reader of a token row obeys it.
//    rights-derivation: a token minted BEFORE the listing stops answering AFTER it
//    (.claude/rules/rights-change-migrates-live-connections.md), because the readers
//    derive the denial at request time.
// 3. DCR REFUSES URL-SHAPED CLIENT IDS. A registered id can never shadow a CIMD URL.
//
// REFUSED  anonymous / member callers RAISE RBAC_DENIED on the scoped write;
//          a URL-shaped client_id is refused by createClient and registerPublicClient.
// ABSENT   another host, another registrable domain, a sibling under a private suffix.
// PRESENT  the listing answers; a lift restores the host.
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

const APP = "https://app.example.com/oauth/client-metadata.json";
const APP_OTHER_PATH = "https://app.example.com/another/path.json";
const SIBLING = "https://api.example.com/oauth/client-metadata.json";
const ELSEWHERE = "https://app.example.org/oauth/client-metadata.json";
const EVIL = "https://evil.vercel.app/c.json";
const EVIL_SUB = "https://a.evil.vercel.app/c.json";
const VICTIM = "https://victim.vercel.app/c.json";
const REASON = "abuse report 2026-11-10, operator audit trail";
const OPERATOR = "laurent";

const list = (
	t: T,
	scope: "url" | "host" | "domain",
	clientId = APP,
	over: Record<string, unknown> = {},
) =>
	asService(t).mutation(api.oauth.deleteClient, {
		clientId,
		scope,
		reason: REASON,
		operator: OPERATOR,
		...over,
	});
const denial = (t: T, clientId: string) =>
	asService(t).query(api.oauth.getDocumentClientDenial, { clientId });
const lookup = (t: T, tokenHash: string) =>
	asService(t).query(api.oauth.getAccessTokenByHash, { tokenHash });

async function mint(t: T, tokenHash: string, clientId: string) {
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

describe("residue 1 — deny by host", () => {
	test("another path on a denied host is denied; another host is not", async () => {
		const t = createT();
		await list(t, "host");
		expect(await denial(t, APP)).not.toBeNull();
		expect(await denial(t, APP_OTHER_PATH)).not.toBeNull();
		expect(await denial(t, SIBLING)).toBeNull();
		expect(await denial(t, ELSEWHERE)).toBeNull();
	});

	test("a token minted BEFORE the host listing stops answering AFTER it; a token of another host is untouched", async () => {
		const t = createT();
		await mint(t, "tok-other-path", APP_OTHER_PATH);
		await mint(t, "tok-sibling", SIBLING);
		expect(await lookup(t, "tok-other-path")).not.toBeNull();
		await list(t, "host");
		expect(await lookup(t, "tok-other-path")).toBeNull();
		expect(await lookup(t, "tok-sibling")).not.toBeNull();
	});

	test("the lift goes through the same door and restores the host; both events are audited", async () => {
		const t = createT();
		await list(t, "host");
		expect(await list(t, "host", APP, { lift: true })).toMatchObject({
			unlisted: true,
		});
		expect(await denial(t, APP_OTHER_PATH)).toBeNull();
		const events = await t.run((ctx) =>
			ctx.db.query("oauth_document_client_events").collect(),
		);
		expect(events.map((e) => e.action)).toEqual(["listed", "unlisted"]);
	});

	test("a host entry and a url entry are independent: lifting the URL does not lift the host", async () => {
		const t = createT();
		await list(t, "host");
		await list(t, "url");
		await list(t, "url", APP, { lift: true });
		expect(await denial(t, APP_OTHER_PATH)).not.toBeNull();
	});
});

describe("residue 1 — deny by registrable domain", () => {
	test("every subdomain of the registrable domain is denied; another domain is not", async () => {
		const t = createT();
		await list(t, "domain");
		expect(await denial(t, APP)).not.toBeNull();
		expect(await denial(t, SIBLING)).not.toBeNull();
		expect(await denial(t, ELSEWHERE)).toBeNull();
	});

	test("under a private suffix the domain is evil.vercel.app, never vercel.app: the victim is not denied", async () => {
		const t = createT();
		await list(t, "domain", EVIL);
		expect(await denial(t, EVIL_SUB)).not.toBeNull();
		expect(await denial(t, VICTIM)).toBeNull();
	});

	test("a host with no registrable domain cannot be listed by domain", async () => {
		const t = createT();
		await expect(
			list(t, "domain", "https://vercel.app/c.json"),
		).rejects.toThrow(/DOMAIN_UNRESOLVABLE/);
	});

	test("a token minted before a domain listing stops answering at every subdomain", async () => {
		const t = createT();
		await mint(t, "tok-sibling", SIBLING);
		await list(t, "domain");
		expect(await lookup(t, "tok-sibling")).toBeNull();
	});
});

describe("residue 1 — refused", () => {
	test("anonymous and member callers RAISE RBAC_DENIED on a host listing", async () => {
		const t = createT();
		const args = {
			clientId: APP,
			scope: "host" as const,
			reason: REASON,
			operator: OPERATOR,
		};
		await expect(t.mutation(api.oauth.deleteClient, args)).rejects.toThrow(
			/RBAC_DENIED/,
		);
		await expect(
			asMember(t).mutation(api.oauth.deleteClient, args),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("a scoped listing keeps the reason and operator rules", async () => {
		const t = createT();
		await expect(list(t, "host", APP, { reason: "short" })).rejects.toThrow(
			/REASON_TOO_SHORT/,
		);
		await expect(list(t, "domain", APP, { operator: " " })).rejects.toThrow(
			/OPERATOR_REQUIRED/,
		);
	});
});

describe("residue 3 — DCR refuses URL-shaped client ids", () => {
	const base = {
		clientSecretHash: "h",
		name: "n",
		redirectUris: ["https://app.example.com/cb"],
		scopeProfile: "generic",
	};
	async function profile(t: T) {
		await t.run((ctx) =>
			ctx.db.insert("oauth_scope_profiles", {
				profileId: "generic",
				description: "self-registrable",
				fromAllowList: [],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				selfRegistrable: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
	}

	test("createClient and registerPublicClient refuse any URL-shaped client_id, and write no row", async () => {
		const t = createT();
		await profile(t);
		for (const clientId of [
			APP,
			"http://app.example.com/c.json",
			"HTTPS://App.example.com/c.json",
		]) {
			await expect(
				asService(t).mutation(api.oauth.createClient, { ...base, clientId }),
			).rejects.toThrow(/URL_CLIENT_ID_REFUSED/);
			await expect(
				asService(t).mutation(api.oauth.registerPublicClient, {
					...base,
					clientId,
				}),
			).rejects.toThrow(/URL_CLIENT_ID_REFUSED/);
		}
		const rows = await t.run((ctx) => ctx.db.query("oauth_clients").collect());
		expect(rows).toHaveLength(0);
	});

	test("a server-generated UUID is still registered by both doors", async () => {
		const t = createT();
		await profile(t);
		const id = "0b0f2a52-6d1c-4d0e-9a53-7a4f0d2c1a11";
		await asService(t).mutation(api.oauth.createClient, {
			...base,
			clientId: id,
		});
		await asService(t).mutation(api.oauth.registerPublicClient, {
			...base,
			clientId: "1b0f2a52-6d1c-4d0e-9a53-7a4f0d2c1a11",
		});
		const rows = await t.run((ctx) => ctx.db.query("oauth_clients").collect());
		expect(rows).toHaveLength(2);
	});
});
