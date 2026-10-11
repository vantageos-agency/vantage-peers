/// <reference types="vite/client" />
/**
 * closeDoorsOauth.test.ts
 *
 * Four OAuth protocol steps were public with no caller resolution:
 * registerPublicClient, consumeAuthorizationCode, getAccessTokenByHash,
 * getRefreshTokenByHash. Their only legitimate caller is the MCP server, which
 * reaches Convex through `internalClient()` — a client that ALWAYS carries the
 * MCP server's service-account identity (mcp-server/src/authenticatedConvexClient.ts
 * `createServiceAccountConvexClient`; it throws rather than send anonymously).
 * So the identity exists before the protocol step runs, and the four now admit
 * the service account only (`requireServiceAccount`), exactly like the seven
 * token-minting / admin registrations beside them.
 *
 * Three poles:
 *   - REFUSED  anonymous, signed in with no organisation, an ordinary org
 *              member, and an org member of ANOTHER org each raise
 *              RBAC_DENIED naming the door, and write / delete nothing.
 *   - PRESENT  the service account runs the whole flow end to end:
 *              register -> authorize(code) -> consume -> token -> lookup,
 *              and the refresh path, with the lookups returning no stored
 *              hash or secret.
 *   - ABSENT   for the service account, an unknown / revoked / expired /
 *              malformed hash is `null` (identical bytes), never a raise.
 *
 * A second block pins the seven already-gated admin / mint doors (createClient,
 * listClients, deleteClient, revokeAccessTokensOnly, createAuthorizationCode,
 * createAccessToken, createRefreshToken) against an anonymous and a cross-org
 * caller, so a regression of either group fails here.
 */
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
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

// Mirrors the root vitest.config.ts value of CLERK_SERVICE_ACCOUNT_USER_ID.
const SERVICE_ACCOUNT_ID = "test-service-account-user-id";

const makeT = () => convexTest(schema, modules);
type Base = ReturnType<typeof makeT>;
type T = {
	run: Base["run"];
	query(ref: never, args: never): Promise<unknown>;
	mutation(ref: never, args: never): Promise<unknown>;
	withIdentity(identity: { subject: string; [k: string]: unknown }): T;
};
const asT = (t: Base): T => t as unknown as T;
const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT_ID });

const TABLES = [
	"oauth_clients",
	"oauth_scope_profiles",
	"oauth_authorization_codes",
	"oauth_access_tokens",
	"oauth_refresh_tokens",
	"oauth_audit_log",
] as const;

async function counts(t: T): Promise<Record<string, number>> {
	return await t.run(async (ctx) => {
		const out: Record<string, number> = {};
		for (const table of TABLES) {
			out[table] = (await ctx.db.query(table).collect()).length;
		}
		return out;
	});
}

async function seed(t: T): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert("oauth_scope_profiles", {
			profileId: "open-profile",
			description: "self-registrable",
			fromAllowList: ["a"],
			namespaceReadPrefixes: ["ns/"],
			namespaceWritePrefixes: ["ns/"],
			selfRegistrable: true,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert("oauth_clients", {
			clientId: "c1",
			clientSecretHash: "hash-c1-secret",
			redirectUris: ["https://client.example/cb"],
			name: "client one",
			scopeProfile: "open-profile",
			createdAt: now,
		});
		await ctx.db.insert("oauth_authorization_codes", {
			code: "code-live",
			clientId: "c1",
			redirectUri: "https://client.example/cb",
			codeChallenge: "challenge",
			scope: "mcp:full",
			userId: "u1",
			expiresAt: now + 60_000,
		});
		await ctx.db.insert("oauth_access_tokens", {
			tokenHash: "access-live",
			clientId: "c1",
			userId: "u1",
			scopes: ["mcp:full"],
			scopeProfile: "open-profile",
			fromAllowList: ["a"],
			namespaceReadPrefixes: ["ns/"],
			namespaceWritePrefixes: ["ns/"],
			expiresAt: now + 3_600_000,
			createdAt: now,
		});
		await ctx.db.insert("oauth_refresh_tokens", {
			tokenHash: "refresh-live",
			clientId: "c1",
			userId: "u1",
			scopeProfile: "open-profile",
			expiresAt: now + 3_600_000,
			createdAt: now,
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "acme",
			allowedOrchestrators: ["seat"],
			scopes: ["view-own-tasks"],
			displayName: "Acme",
			isActive: true,
			createdAt: now,
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "globex",
			allowedOrchestrators: ["other"],
			scopes: ["view-own-tasks"],
			displayName: "Globex",
			isActive: true,
			createdAt: now,
		});
	});
}

const future = () => Date.now() + 60_000;

type Site = {
	name: string;
	kind: "query" | "mutation";
	args: () => Record<string, unknown>;
};

// The four newly gated protocol steps.
const PROTOCOL: readonly Site[] = [
	{
		name: "registerPublicClient",
		kind: "mutation",
		args: () => ({
			clientId: "dcr-new",
			clientSecretHash: "hash-dcr-new",
			name: "dcr",
			redirectUris: ["https://client.example/cb"],
			scopeProfile: "open-profile",
		}),
	},
	{
		name: "consumeAuthorizationCode",
		kind: "mutation",
		args: () => ({ code: "code-live" }),
	},
	{
		name: "getAccessTokenByHash",
		kind: "query",
		args: () => ({ tokenHash: "access-live" }),
	},
	{
		name: "getRefreshTokenByHash",
		kind: "query",
		args: () => ({ tokenHash: "refresh-live" }),
	},
];

// The seven already-gated admin / mint doors.
const ADMIN: readonly Site[] = [
	{
		name: "createClient",
		kind: "mutation",
		args: () => ({
			clientId: "c-new",
			clientSecretHash: "hash-new",
			name: "new",
			redirectUris: ["https://client.example/cb"],
			scopeProfile: "open-profile",
		}),
	},
	{ name: "listClients", kind: "query", args: () => ({}) },
	{ name: "deleteClient", kind: "mutation", args: () => ({ clientId: "c1" }) },
	{
		name: "revokeAccessTokensOnly",
		kind: "mutation",
		args: () => ({
			clientId: "c1",
			reason: "operator audit trail reason, long enough",
		}),
	},
	{
		name: "createAuthorizationCode",
		kind: "mutation",
		args: () => ({
			code: "code-new",
			clientId: "c1",
			redirectUri: "https://client.example/cb",
			codeChallenge: "challenge",
			scope: "mcp:full",
			userId: "u1",
			expiresAt: future(),
		}),
	},
	{
		name: "createAccessToken",
		kind: "mutation",
		args: () => ({
			tokenHash: "access-new",
			clientId: "c1",
			userId: "u1",
			scopes: ["mcp:full"],
			scopeProfile: "open-profile",
			fromAllowList: ["a"],
			namespaceReadPrefixes: ["ns/"],
			namespaceWritePrefixes: ["ns/"],
			expiresAt: future(),
		}),
	},
	{
		name: "createRefreshToken",
		kind: "mutation",
		args: () => ({
			tokenHash: "refresh-new",
			clientId: "c1",
			userId: "u1",
			scopeProfile: "open-profile",
			expiresAt: future(),
		}),
	},
];

async function call(
	t: T,
	name: string,
	kind: "query" | "mutation",
	args: Record<string, unknown>,
): Promise<unknown> {
	const ref = (api.oauth as unknown as Record<string, unknown>)[name];
	return kind === "query"
		? await t.query(ref as never, args as never)
		: await t.mutation(ref as never, args as never);
}

const callers: ReadonlyArray<readonly [string, (t: T) => T]> = [
	["anonymous", (t) => t],
	["signed in with no organisation", (t) => t.withIdentity({ subject: "x" })],
	[
		"a member of org acme",
		(t) => t.withIdentity({ subject: "m1", organizationSlug: "acme" }),
	],
	[
		"a member of org globex (another tenant)",
		(t) => t.withIdentity({ subject: "m2", organizationSlug: "globex" }),
	],
];

async function refusalOf(p: Promise<unknown>): Promise<string | null> {
	try {
		await p;
		return null;
	} catch (e) {
		return String((e as { data?: unknown }).data ?? (e as Error).message ?? "");
	}
}

describe("REFUSED — the four protocol steps admit the service account only", () => {
	for (const site of PROTOCOL) {
		for (const [label, as] of callers) {
			test(`${site.name} refuses ${label}, naming its door, and changes nothing`, async () => {
				const t = asT(makeT());
				await seed(t);
				const before = await counts(t);
				const refusal = await refusalOf(
					call(as(t), site.name, site.kind, site.args()),
				);
				expect(refusal).not.toBeNull();
				expect(refusal).toContain("RBAC_DENIED");
				expect(refusal).toContain(`oauth:${site.name}`);
				expect(await counts(t)).toEqual(before);
			});
		}
	}

	test("a refused consumeAuthorizationCode leaves the single-use code unspent", async () => {
		const t = asT(makeT());
		await seed(t);
		await refusalOf(
			call(t, "consumeAuthorizationCode", "mutation", { code: "code-live" }),
		);
		const out = await call(
			asService(t),
			"consumeAuthorizationCode",
			"mutation",
			{ code: "code-live" },
		);
		expect(out).not.toBeNull();
	});
});

describe("REFUSED — the seven admin / mint doors still refuse anonymous and cross-org callers", () => {
	for (const site of ADMIN) {
		for (const [label, as] of callers) {
			test(`${site.name} refuses ${label}`, async () => {
				const t = asT(makeT());
				await seed(t);
				const before = await counts(t);
				const refusal = await refusalOf(
					call(as(t), site.name, site.kind, site.args()),
				);
				expect(refusal).toContain("RBAC_DENIED");
				expect(refusal).toContain(`oauth:${site.name}`);
				expect(await counts(t)).toEqual(before);
			});
		}
	}
});

describe("PRESENT — the service account runs the whole OAuth flow", () => {
	test("register -> authorize -> consume -> token -> lookup, then refresh", async () => {
		const t = asT(makeT());
		await seed(t);
		const s = asService(t);

		await call(s, "registerPublicClient", "mutation", {
			clientId: "dcr-flow",
			clientSecretHash: "hash-flow-secret",
			name: "flow",
			redirectUris: ["https://flow.example/cb"],
			scopeProfile: "open-profile",
		});
		await call(s, "createAuthorizationCode", "mutation", {
			code: "code-flow",
			clientId: "dcr-flow",
			redirectUri: "https://flow.example/cb",
			codeChallenge: "challenge",
			scope: "mcp:full",
			userId: "u-flow",
			expiresAt: future(),
		});

		const consumed = (await call(s, "consumeAuthorizationCode", "mutation", {
			code: "code-flow",
		})) as Record<string, unknown> | null;
		expect(consumed).not.toBeNull();
		expect(consumed?.clientId).toBe("dcr-flow");
		// Single use: the second consumption finds nothing.
		expect(
			await call(s, "consumeAuthorizationCode", "mutation", {
				code: "code-flow",
			}),
		).toBeNull();

		await call(s, "createAccessToken", "mutation", {
			tokenHash: "access-flow",
			clientId: "dcr-flow",
			userId: "u-flow",
			scopes: ["mcp:full"],
			scopeProfile: "open-profile",
			fromAllowList: ["a"],
			namespaceReadPrefixes: ["ns/"],
			namespaceWritePrefixes: ["ns/"],
			expiresAt: future(),
			clerkOrgSlug: "acme",
		});
		await call(s, "createRefreshToken", "mutation", {
			tokenHash: "refresh-flow",
			clientId: "dcr-flow",
			userId: "u-flow",
			scopeProfile: "open-profile",
			expiresAt: future(),
		});

		const access = (await call(s, "getAccessTokenByHash", "query", {
			tokenHash: "access-flow",
		})) as Record<string, unknown> | null;
		expect(access?.clientId).toBe("dcr-flow");
		expect(access?.clerkOrgSlug).toBe("acme");

		const refresh = (await call(s, "getRefreshTokenByHash", "query", {
			tokenHash: "refresh-flow",
		})) as Record<string, unknown> | null;
		expect(refresh?.clientId).toBe("dcr-flow");
	});

	test("the lookups return no stored hash or client secret", async () => {
		const t = asT(makeT());
		await seed(t);
		const s = asService(t);
		const access = await call(s, "getAccessTokenByHash", "query", {
			tokenHash: "access-live",
		});
		const refresh = await call(s, "getRefreshTokenByHash", "query", {
			tokenHash: "refresh-live",
		});
		for (const row of [access, refresh]) {
			const text = JSON.stringify(row);
			expect(text).not.toMatch(/tokenHash|clientSecretHash|hash-c1-secret/);
			expect(text).not.toContain("access-live");
			expect(text).not.toContain("refresh-live");
		}
	});
});

describe("ABSENT — an absence is an absence for the admitted caller", () => {
	test("unknown, malformed, empty, revoked and expired hashes all answer null", async () => {
		const t = asT(makeT());
		await seed(t);
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash: "access-revoked",
				clientId: "c1",
				userId: "u1",
				scopes: [],
				scopeProfile: "open-profile",
				fromAllowList: [],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				expiresAt: now + 60_000,
				createdAt: now,
				revokedAt: now,
			});
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash: "access-expired",
				clientId: "c1",
				userId: "u1",
				scopes: [],
				scopeProfile: "open-profile",
				fromAllowList: [],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				expiresAt: now - 1,
				createdAt: now - 10,
			});
		});
		const s = asService(t);
		for (const h of [
			"never-issued",
			"not hex at all !!",
			"",
			"access-revoked",
			"access-expired",
		]) {
			expect(
				await call(s, "getAccessTokenByHash", "query", { tokenHash: h }),
			).toBeNull();
			expect(
				await call(s, "getRefreshTokenByHash", "query", { tokenHash: h }),
			).toBeNull();
		}
		expect(
			await call(s, "consumeAuthorizationCode", "mutation", {
				code: "never-issued",
			}),
		).toBeNull();
	});
});
