/**
 * AUTHORIZE_ORG_BY_CLERK_ID (VantagePeers Cloud, task k1788jk9k6fprrvrmvhqagwsyx8hspmy).
 *
 * The consent picker offers a Clerk membership only when its organisation has an
 * ACTIVE `client_org_mapping` row. The row is found by the VERIFIED Clerk org id
 * (`organization.id` == `mapping.clerkOrgId`), never by a slug: the operator's own
 * organisation is keyed under a label (`perello-consulting-<digits>`) that is not
 * its Clerk slug (`perello-consulting`), so a slug lookup dropped it from the
 * picker while a client organisation (slug == key) was offered.
 *
 * Poles:
 *   1 PRESENT  member of the operator org (Clerk slug != mapping key) is offered it
 *   2 ORDER    member of operator + client: operator first, then client; nothing preselected
 *   3 DENY     member of a client org only never sees the operator org
 *   4 DENY     no mapping / inactive mapping is not offered
 *   5 DENY     a Clerk slug equal to ANOTHER org's mapping key (different id) is not offered
 *   6 PATH     pick -> code -> token: the token resolves to the SAME row at the bearer door
 *   7 PATH     the agent step reads the agents filed under the mapping key
 *   8 DENY     the by-id read is service-account only
 *
 * Harness: the REAL Hono app against the REAL Convex functions (convex-test).
 */

import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import schema from "../../convex/schema";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { app } from "../server-http.js";
import {
	_setInternalClientForTest,
	sha256Base64Url,
	sha256Hex,
} from "../src/auth.js";
import {
	authorizeAsPerson,
	authorizeUrl,
	getAuthorize,
	type Harness,
	installAuthorizeHarness,
} from "./lib/authorizeHarness.js";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../convex/**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill") &&
			!path.includes("__tests__") &&
			!path.endsWith(".test.ts"),
	),
);

const SERVICE_ACCOUNT_ID = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
const REDIRECT = "https://client.example/callback";
const CLIENT_ID = "client-manufact";
const CLIENT_SECRET = "client-secret-raw";
const VERIFIER = "authorize-test-verifier-0123456789-0123456789-0123456789";

// The operator's own organisation: Clerk slug differs from the mapping key.
const OP_ID = "org_OPERATOR";
const OP_CLERK_SLUG = "op-consulting";
const OP_KEY = "op-consulting-1782214787064836324";
const OP_NAME = "Operator Consulting";
// A client organisation the person is a member of: slug == key.
const CL_ID = "org_CLIENT";
const CL_SLUG = "client-immo";
const CL_NAME = "Client Immo";
// An organisation with no mapping, and one with an inactive mapping.
const NOMAP_ID = "org_NOMAP";
const OFF_ID = "org_OFF";
const OFF_SLUG = "off-org";
// Holds the Clerk slug that equals the operator's mapping KEY, but is another org.
const SQUAT_ID = "org_SQUATTER";

const BOTH = "user_both";
const OP_ONLY = "user_op_only";
const CL_ONLY = "user_cl_only";
const NOISE = "user_noise";
const SQUATTER = "user_squatter";
const OP_ADMIN = "user_op_admin";

type T = ReturnType<typeof convexTest<typeof schema>>;

function bridge(t: T) {
	return {
		query: (name: string, args: Record<string, unknown>) =>
			t.query(makeFunctionReference<"query">(name) as never, args as never),
		mutation: (name: string, args: Record<string, unknown>) =>
			t.mutation(
				makeFunctionReference<"mutation">(name) as never,
				args as never,
			),
	};
}

const member = (
	id: string,
	slug: string | null,
	name: string,
	role = "org:member",
) => ({ role, organization: { id, slug, name } });

let t: T;
let harness: Harness;
let challenge: string;

beforeEach(async () => {
	harness = await installAuthorizeHarness();
	challenge = await sha256Base64Url(VERIFIER);
	t = convexTest(schema, modules);
	_setInternalClientForTest(
		// biome-ignore lint/suspicious/noExplicitAny: test bridge
		bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })) as any,
	);
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId: "tenant-profile",
			description: "client's own profile",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert("oauth_clients", {
			clientId: CLIENT_ID,
			clientSecretHash: await sha256Hex(CLIENT_SECRET),
			redirectUris: [REDIRECT],
			name: "Manufact Cloud",
			scopeProfile: "tenant-profile",
			createdAt: now,
			tokenEndpointAuthMethod: "client_secret_basic",
		});
		const row = (
			key: string,
			clerkOrgId: string,
			extra: Record<string, unknown> = {},
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: key,
				clerkOrgId,
				allowedOrchestrators: [],
				scopes: ["vantage:read", "vantage:write"],
				displayName: key,
				isActive: true,
				createdAt: now,
				...extra,
			});
		await row(OP_KEY, OP_ID, { orgKind: "operator" });
		await row(CL_SLUG, CL_ID, { orgKind: "client" });
		await row(OFF_SLUG, OFF_ID, { orgKind: "client", isActive: false });
		await ctx.db.insert("agents", {
			orgSlug: OP_KEY,
			clerkOrgId: OP_ID,
			name: "Operator Agent",
			normalizedName: "operator agent",
			isActive: true,
			createdAt: now,
		});
	});
	const opMember = (role = "org:admin") =>
		member(OP_ID, OP_CLERK_SLUG, OP_NAME, role);
	const clMember = () => member(CL_ID, CL_SLUG, CL_NAME);
	harness.setMemberships(BOTH, [clMember(), opMember()]);
	harness.setMemberships(OP_ONLY, [opMember()]);
	harness.setMemberships(OP_ADMIN, [opMember("org:admin")]);
	harness.setMemberships(CL_ONLY, [clMember()]);
	harness.setMemberships(NOISE, [
		clMember(),
		member(NOMAP_ID, "no-mapping", "No Mapping Org"),
		member(OFF_ID, OFF_SLUG, "Inactive Org"),
	]);
	harness.setMemberships(SQUATTER, [member(SQUAT_ID, OP_KEY, "Squatter Org")]);
});

afterEach(() => {
	harness.restore();
	_setInternalClientForTest(null);
});

async function picker(userId: string) {
	const session = await harness.session(userId);
	const r = await getAuthorize(
		app,
		authorizeUrl({
			clientId: CLIENT_ID,
			redirectUri: REDIRECT,
			challenge,
			state: "xyz",
		}),
		session,
	);
	const html = r.html ?? "";
	const offered = [
		...html.matchAll(/<input type="radio" name="orgId" value="([^"]*)"/g),
	].map((m) => m[1]);
	const names = [
		...html.matchAll(/<span class="name">([^<]*)<\/span><span class="role">/g),
	].map((m) => m[1]);
	return { status: r.status, html, offered, names };
}

describe("1. the operator's own organisation is offered although its Clerk slug is not its mapping key", () => {
	it("a member of the operator org only sees it", async () => {
		const p = await picker(OP_ONLY);
		expect(p.offered).toEqual([OP_ID]);
		expect(p.names).toEqual([OP_NAME]);
	});
});

describe("2. order and preselection", () => {
	it("operator organisation first, then the client organisation, nothing preselected", async () => {
		const p = await picker(BOTH);
		expect(p.offered).toEqual([OP_ID, CL_ID]);
		expect(p.html).not.toMatch(/name="orgId"[^>]*\schecked/);
	});

	it("a single offered organisation is not preselected either", async () => {
		const p = await picker(CL_ONLY);
		expect(p.html).not.toMatch(/name="orgId"[^>]*\schecked/);
	});
});

describe("3. a client-only member never sees the operator organisation", () => {
	it("offers only the client organisation", async () => {
		const p = await picker(CL_ONLY);
		expect(p.offered).toEqual([CL_ID]);
		expect(p.html).not.toContain(OP_ID);
		expect(p.html).not.toContain(OP_NAME);
	});
});

describe("4. a membership with no active mapping is not offered", () => {
	it("drops the unmapped and the inactive organisation, keeps the mapped one", async () => {
		const p = await picker(NOISE);
		expect(p.offered).toEqual([CL_ID]);
	});
});

describe("5. a slug is not an identity", () => {
	it("a Clerk org whose slug equals the operator's mapping KEY but whose id differs is not offered", async () => {
		const p = await picker(SQUATTER);
		expect(p.offered).toEqual([]);
		expect(p.html).not.toContain(SQUAT_ID);
	});
});

describe("6. pick -> code -> token resolves to the same mapping row", () => {
	it("the operator organisation's token is minted under the mapping key and resolves at the bearer door", async () => {
		const session = await harness.session(OP_ONLY);
		const r = await authorizeAsPerson(app, {
			clientId: CLIENT_ID,
			redirectUri: REDIRECT,
			challenge,
			sessionToken: session,
			orgId: OP_ID,
			extraFields: { [`agent_${OP_ID}`]: "" },
		});
		expect(r.status).toBe(302);
		expect(r.code).toBeTruthy();
		const res = await app.request("http://localhost:3000/token", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
			},
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: r.code as string,
				code_verifier: VERIFIER,
				redirect_uri: REDIRECT,
				client_id: CLIENT_ID,
			}).toString(),
		});
		expect(res.status).toBe(200);
		const { access_token } = (await res.json()) as { access_token: string };
		const resolved = (await bridge(
			t.withIdentity({ subject: SERVICE_ACCOUNT_ID }),
		).query("oauth:getAccessTokenByHash", {
			tokenHash: await sha256Hex(access_token),
		})) as {
			orgClerkId?: string;
			clerkOrgSlug?: string;
			namespaceWritePrefixes: string[];
		} | null;
		expect(resolved?.orgClerkId).toBe(OP_ID);
		expect(resolved?.clerkOrgSlug).toBe(OP_KEY);
		expect(resolved?.namespaceWritePrefixes).toEqual([`team/${OP_KEY}`]);
		// the copy stored at mint names the same key as the live derivation
		const stored = await t.run(async (ctx) =>
			(await ctx.db.query("oauth_access_tokens").collect()).find(
				(row) => row.clerkOrgId === OP_ID,
			),
		);
		expect(stored?.clerkOrgSlug).toBe(OP_KEY);
		expect(stored?.namespaceWritePrefixes).toEqual([`team/${OP_KEY}`]);
	});
});

describe("7. the agent step reads the agents filed under the mapping key", () => {
	it("an org admin of the operator organisation is offered its unbound agent", async () => {
		const p = await picker(OP_ADMIN);
		expect(p.html).toContain("Operator Agent");
	});
});

describe("8. the by-id mapping read is service-account only", () => {
	it("refuses an ordinary signed-in identity and an anonymous caller; answers the service account", async () => {
		const fn = "clientOrgMapping:getByClerkOrgId";
		await expect(
			bridge(t.withIdentity({ subject: CL_ONLY })).query(fn, {
				clerkOrgId: OP_ID,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(bridge(t).query(fn, { clerkOrgId: OP_ID })).rejects.toThrow(
			/RBAC_DENIED/,
		);
		const served = (await bridge(
			t.withIdentity({ subject: SERVICE_ACCOUNT_ID }),
		).query(fn, { clerkOrgId: OP_ID })) as {
			clerkOrgSlug: string;
			orgKind?: string;
		} | null;
		expect(served?.clerkOrgSlug).toBe(OP_KEY);
		expect(served?.orgKind).toBe("operator");
		expect(
			await bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })).query(fn, {
				clerkOrgId: "org_UNKNOWN",
			}),
		).toBeNull();
	});
});
