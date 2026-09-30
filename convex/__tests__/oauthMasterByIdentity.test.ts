/// <reference types="vite/client" />
/**
 * oauthMasterByIdentity.test.ts
 *
 * Ten public OAuth registrations used to authorise their caller by a shared
 * secret carried in the request body (`callerToken`, compared against the fleet
 * master secret). They stay PUBLIC — the MCP server reaches Convex through a
 * `ConvexHttpClient` that carries a service-account JWT and cannot call an
 * `internal.*` function — but they authorise by IDENTITY now: the caller must
 * resolve, through `withOrgScope`, to the recognised service account (a named
 * by-id grant on CLERK_SERVICE_ACCOUNT_USER_ID), and there is no argument left
 * through which a token could be supplied.
 *
 * Three poles per site:
 *   - SHAPE    the registration is still public and takes no `callerToken`.
 *   - LEAK     a caller that is not the service account is REFUSED, and a
 *              refused call writes nothing. Four such callers: anonymous,
 *              signed in with no organisation, an ordinary organisation
 *              member, and the service account's own subject presented WITH an
 *              organisation claim (the by-id grant is for the org-less
 *              identity only).
 *   - WITHHELD the service account is served, so the OAuth endpoints and the
 *              admin routes keep working.
 *
 * The fleet secret's VALUE never appears here. The fixture below is a
 * throw-away string used only to prove that supplying a token no longer opens
 * anything.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import * as oauthModule from "../oauth";
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
const FIXTURE_TOKEN = "fixture-token-not-a-real-secret";
const REASON = "operator audit trail reason, long enough for every gate";

beforeEach(() => {
	vi.stubEnv("BEARER_SECRET_MASTER", FIXTURE_TOKEN);
});
afterEach(() => {
	vi.unstubAllEnvs();
});

const makeT = () => convexTest(schema, modules);
type Base = ReturnType<typeof makeT>;
// A convex-test handle, with or without an identity. `withIdentity` returns the
// same API under a differently-parameterised type, so the helpers below take
// the narrow structural shape they actually use.
type T = {
	run: Base["run"];
	query(ref: never, args: never): Promise<unknown>;
	mutation(ref: never, args: never): Promise<unknown>;
	withIdentity(identity: { subject: string; [k: string]: unknown }): T;
};
const asT = (t: Base): T => t as unknown as T;

async function seed(t: T): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		for (const profileId of ["p1", "p2"]) {
			await ctx.db.insert("oauth_scope_profiles", {
				profileId,
				description: `profile ${profileId}`,
				fromAllowList: ["a"],
				namespaceReadPrefixes: ["ns/"],
				namespaceWritePrefixes: ["ns/"],
				createdAt: now,
				updatedAt: now,
			});
		}
		await ctx.db.insert("oauth_clients", {
			clientId: "c1",
			clientSecretHash: "hash-c1",
			redirectUris: ["https://client.example/cb"],
			name: "client one",
			scopeProfile: "p1",
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
	});
}

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

type Site = {
	id: string;
	kind: "query" | "mutation";
	fn: unknown;
	args: Record<string, unknown>;
};

const future = () => Date.now() + 60_000;

const SITES: readonly Site[] = [
	{
		id: "oauth:seedDefaultProfiles",
		kind: "mutation",
		fn: oauthModule.seedDefaultProfiles,
		args: {},
	},
	{
		id: "oauth:createClient",
		kind: "mutation",
		fn: oauthModule.createClient,
		args: {
			clientId: "c-new",
			clientSecretHash: "hash-new",
			name: "new client",
			redirectUris: ["https://client.example/cb"],
			scopeProfile: "p1",
		},
	},
	{
		id: "oauth:listClients",
		kind: "query",
		fn: oauthModule.listClients,
		args: {},
	},
	{
		id: "oauth:deleteClient",
		kind: "mutation",
		fn: oauthModule.deleteClient,
		args: { clientId: "c1" },
	},
	{
		id: "oauth:patchClientScopeAndRefreshTokens",
		kind: "mutation",
		fn: oauthModule.patchClientScopeAndRefreshTokens,
		args: { clientId: "c1", newScopeProfile: "p2", reason: REASON },
	},
	{
		id: "oauth:revokeAccessTokensOnly",
		kind: "mutation",
		fn: oauthModule.revokeAccessTokensOnly,
		args: { clientId: "c1", reason: REASON },
	},
	{
		id: "oauth:createAuthorizationCode",
		kind: "mutation",
		fn: oauthModule.createAuthorizationCode,
		args: {
			code: "code-1",
			clientId: "c1",
			redirectUri: "https://client.example/cb",
			codeChallenge: "challenge",
			scope: "mcp:full",
			userId: "p1",
			expiresAt: future(),
		},
	},
	{
		id: "oauth:createAccessToken",
		kind: "mutation",
		fn: oauthModule.createAccessToken,
		args: {
			tokenHash: "access-hash-1",
			clientId: "c1",
			userId: "p1",
			scopes: ["mcp:full"],
			scopeProfile: "p1",
			fromAllowList: ["a"],
			namespaceReadPrefixes: ["ns/"],
			namespaceWritePrefixes: ["ns/"],
			expiresAt: future(),
		},
	},
	{
		id: "oauth:createRefreshToken",
		kind: "mutation",
		fn: oauthModule.createRefreshToken,
		args: {
			tokenHash: "refresh-hash-1",
			clientId: "c1",
			userId: "p1",
			scopeProfile: "p1",
			expiresAt: future(),
		},
	},
	{
		id: "oauth:patchScopeProfileEmergency",
		kind: "mutation",
		fn: oauthModule.patchScopeProfileEmergency,
		args: {
			profileId: "p1",
			fromAllowList: ["a", "b"],
			cascadeRevokeTokens: false,
			reason: `${REASON} - and then some more words to pass the forty character floor`,
		},
	},
];

/** Calls a site with its own arguments plus any `extra` (e.g. a token). */
async function call(
	t: T,
	site: Site,
	extra: Record<string, unknown> = {},
): Promise<unknown> {
	const ref = (api.oauth as unknown as Record<string, unknown>)[
		site.id.split(":")[1]
	];
	const args = { ...site.args, ...extra };
	if (site.kind === "query") return await t.query(ref as never, args as never);
	return await t.mutation(ref as never, args as never);
}

type Registration = { isPublic?: boolean; exportArgs: () => string };

describe("SHAPE — the ten stay public and take no token argument", () => {
	test("the population is ten registrations", () => {
		expect(SITES).toHaveLength(10);
		expect(new Set(SITES.map((s) => s.id)).size).toBe(10);
	});
	for (const site of SITES) {
		test(`${site.id} is public and carries no callerToken`, () => {
			const reg = site.fn as Registration;
			expect(reg.isPublic).toBe(true);
			expect(reg.exportArgs()).not.toMatch(/callerToken/);
		});
	}
});

describe("LEAK — a caller that is not the service account is refused, and writes nothing", () => {
	const callers: ReadonlyArray<readonly [string, (t: T) => T, RegExp | null]> =
		[
			["anonymous", (t) => t, null],
			[
				"signed in with no organisation",
				(t) => t.withIdentity({ subject: "somebody-else" }),
				null,
			],
			[
				"an ordinary organisation member",
				(t) =>
					t.withIdentity({ subject: "member-1", organizationSlug: "acme" }),
				null,
			],
			[
				"the service account's subject presented WITH an organisation",
				(t) =>
					t.withIdentity({
						subject: SERVICE_ACCOUNT_ID,
						organizationSlug: "acme",
					}),
				null,
			],
		];
	for (const site of SITES) {
		for (const [label, as] of callers) {
			test(`${site.id} refuses ${label}`, async () => {
				const t = asT(makeT());
				await seed(t);
				const before = await counts(t);
				let raised: unknown = null;
				try {
					await call(as(t), site);
				} catch (e) {
					raised = e;
				}
				expect(raised).not.toBeNull();
				const data = String(
					(raised as { data?: unknown }).data ??
						(raised as Error).message ??
						"",
				);
				expect(data).toContain("RBAC_DENIED");
				expect(data).toContain(site.id);
				expect(await counts(t)).toEqual(before);
			});
		}

		test(`${site.id} is not opened by presenting a token any more`, async () => {
			const t = asT(makeT());
			await seed(t);
			const before = await counts(t);
			// The fixture equals the stubbed BEARER_SECRET_MASTER: on the old
			// surface this exact call was served to an anonymous caller.
			let raised: unknown = null;
			try {
				await call(t, site, { callerToken: FIXTURE_TOKEN });
			} catch (e) {
				raised = e;
			}
			expect(raised).not.toBeNull();
			expect(await counts(t)).toEqual(before);
		});
	}
});

describe("WITHHELD — the service account is served at every site", () => {
	const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT_ID });

	for (const site of SITES) {
		test(`${site.id} serves the service account`, async () => {
			const t = asT(makeT());
			await seed(t);
			await expect(call(asService(t), site)).resolves.toBeDefined();
		});
	}

	test("createAccessToken, createRefreshToken and createAuthorizationCode write their rows", async () => {
		const t = asT(makeT());
		await seed(t);
		const s = asService(t);
		const bySite = Object.fromEntries(SITES.map((x) => [x.id, x]));
		await call(s, bySite["oauth:createAuthorizationCode"]);
		await call(s, bySite["oauth:createAccessToken"]);
		await call(s, bySite["oauth:createRefreshToken"]);
		const after = await counts(t);
		expect(after.oauth_authorization_codes).toBe(1);
		expect(after.oauth_access_tokens).toBe(1);
		expect(after.oauth_refresh_tokens).toBe(1);
	});

	test("listClients returns the seeded client to the service account", async () => {
		const t = asT(makeT());
		await seed(t);
		const site = SITES.find((x) => x.id === "oauth:listClients") as Site;
		const rows = (await call(asService(t), site)) as { clientId: string }[];
		expect(rows.map((r) => r.clientId)).toEqual(["c1"]);
	});

	test("the audit row of a service-account write is attributed to an identity hash, never blank", async () => {
		const t = asT(makeT());
		await seed(t);
		const site = SITES.find(
			(x) => x.id === "oauth:patchClientScopeAndRefreshTokens",
		) as Site;
		await call(asService(t), site);
		const rows = await t.run(async (ctx) =>
			ctx.db.query("oauth_audit_log").collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].actorTokenHash).toMatch(/^[0-9a-f]{64}$/);
		expect(rows[0].actorTokenHash).not.toBe(FIXTURE_TOKEN);
	});
});
