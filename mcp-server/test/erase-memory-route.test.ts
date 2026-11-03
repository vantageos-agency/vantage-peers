/**
 * erase_memory through the REAL /mcp route, both poles, against the REAL Convex
 * doors (convex-test). VantagePeers Cloud.
 *
 * Person tokens are minted by the real /authorize + /token flow; the tool
 * forwards the bearer hash (verifiedPerson) and the client acts for the
 * bearer's org (__actingOrg); the route's Convex client is a bridge that runs
 * every call on the backend as the fleet service account, so the Convex door
 * (memories:redactMemoryContentAsPerson) is what decides and its typed refusal
 * is what the client reads.
 *
 *   SERVED   the AUTHOR (a plain member, not admin) erases the row it wrote;
 *            an org ADMIN who is not the author erases any row of its org;
 *   REFUSED  a same-org member who is not the author -> RBAC_DENIED relayed,
 *            the row unchanged; a caller of ANOTHER org (admin there) on org-a's
 *            row -> the door's typed refusal relayed, the row unchanged.
 */

import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../../convex/schema";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { app } from "../server-http.js";
import {
	_setInternalClientForTest,
	sha256Base64Url,
	sha256Hex,
} from "../src/auth.js";
import {
	_resetServiceAccountCacheForTest,
	_setServiceAccountDepsForTest,
} from "../src/serviceAccountAuth.js";
import {
	authorizeAsPerson,
	type Harness,
	installAuthorizeHarness,
	membership,
} from "./lib/authorizeHarness.js";

// The backend the route's per-request Convex client forwards to (set per test).
const backend = vi.hoisted(() => ({
	run: null as
		| null
		| ((kind: string, name: string, args: unknown) => Promise<unknown>),
}));

vi.mock("convex/browser", () => {
	class ForwardingConvexHttpClient {
		constructor(_url: string) {}
		setAuth(_token: string) {}
		clearAuth() {}
		async query(name: string, args: unknown) {
			return await (backend.run as NonNullable<typeof backend.run>)(
				"query",
				String(name),
				args,
			);
		}
		async mutation(name: string, args: unknown) {
			return await (backend.run as NonNullable<typeof backend.run>)(
				"mutation",
				String(name),
				args,
			);
		}
		async action(name: string, args: unknown) {
			return await (backend.run as NonNullable<typeof backend.run>)(
				"action",
				String(name),
				args,
			);
		}
	}
	return { ConvexHttpClient: ForwardingConvexHttpClient };
});

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
const SERVICE_ACCOUNT_JWT = "service-account-jwt-for-test";
const REDIRECT = "https://client.example/callback";
const CLIENT_ID = "client-claude";
const CLIENT_SECRET = "client-secret-raw";
const VERIFIER = "route-test-verifier-0123456789-0123456789-0123456789";
const SECRET = "fake-cred-marker-route-erase";
const REDACTIONS = [{ find: SECRET, replaceWith: "[REDACTED]" }];

type T = ReturnType<typeof convexTest<typeof schema>>;
type ToolResult = { isError?: boolean; content: { text: string }[] };

// Stand-in 32-char ids the client sends -> the real ids of the seeded rows.
const idMap = new Map<string, string>();

let t: T;
let harness: Harness;
let challenge: string;

beforeEach(async () => {
	harness = await installAuthorizeHarness();
	challenge = await sha256Base64Url(VERIFIER);
	vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });
	t = convexTest(schema, modules);
	const asService = t.withIdentity({ subject: SERVICE_ACCOUNT_ID });
	idMap.clear();
	backend.run = async (kind, name, rawArgs) => {
		const ref = makeFunctionReference<"mutation">(name) as never;
		// The tool validates a 32-char Convex id before any backend call; the
		// harness ids are not that shape, so the bridge swaps the stand-in id the
		// client sent for the real row id (the only translation it makes).
		const args = { ...(rawArgs as Record<string, unknown>) };
		const real = idMap.get(String(args.memoryId));
		if (real !== undefined) args.memoryId = real;
		if (kind === "query") {
			return await asService.query(ref, args as never);
		}
		return await asService.mutation(ref, args as never);
	};
	_setInternalClientForTest(
		// biome-ignore lint/suspicious/noExplicitAny: test bridge
		{
			query: (n: string, a: Record<string, unknown>) =>
				asService.query(makeFunctionReference<"query">(n) as never, a as never),
			mutation: (n: string, a: Record<string, unknown>) =>
				asService.mutation(
					makeFunctionReference<"mutation">(n) as never,
					a as never,
				),
		} as any,
	);
	_setServiceAccountDepsForTest({
		createSignInTicket: async () => "ticket",
		exchangeTicketForSession: async () => "session",
		getSessionToken: async () => ({
			jwt: SERVICE_ACCOUNT_JWT,
			exp: Date.now() + 3_600_000,
		}),
	});
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_clients", {
			clientId: CLIENT_ID,
			clientSecretHash: await sha256Hex(CLIENT_SECRET),
			redirectUris: [REDIRECT],
			name: "Claude",
			scopeProfile: "client-generic",
			createdAt: now,
			tokenEndpointAuthMethod: "client_secret_basic",
		});
		// The wrapper gates every write on the org's writer-role allowlist (data), as for store_memory.
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: now,
		});
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: ["agent"],
				scopes: ["vantage:read", "vantage:write"],
				displayName: slug,
				isActive: true,
				createdAt: now,
			});
		}
	});
	harness.setMemberships("user_author", [
		membership(testClerkOrgId("org-a") as string, "org-a", "org:editor"),
	]);
	harness.setMemberships("user_other", [
		membership(testClerkOrgId("org-a") as string, "org-a", "org:editor"),
	]);
	harness.setMemberships("user_admin", [
		membership(testClerkOrgId("org-a") as string, "org-a", "org:admin"),
	]);
	harness.setMemberships("user_admin_b", [
		membership(testClerkOrgId("org-b") as string, "org-b", "org:admin"),
	]);
});

afterEach(() => {
	vi.useRealTimers();
	harness.restore();
	backend.run = null;
	_setInternalClientForTest(null);
	_setServiceAccountDepsForTest(null);
	_resetServiceAccountCacheForTest();
});

async function personToken(userId: string, org: string): Promise<string> {
	const r = await authorizeAsPerson(app, {
		clientId: CLIENT_ID,
		redirectUri: REDIRECT,
		challenge,
		sessionToken: await harness.session(userId),
		orgId: testClerkOrgId(org) as string,
	});
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
	return ((await res.json()) as { access_token: string }).access_token;
}

async function connectAs(token: string) {
	const client = new Client({ name: "erase-route-test", version: "0.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
			fetch: async (url: string | URL, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				headers.set("Authorization", `Bearer ${token}`);
				return app.fetch(new Request(url, { ...init, headers }));
			},
		}),
	);
	return client;
}

async function memoryBy(createdBy: string): Promise<string> {
	const real = await t.run((ctx) =>
		ctx.db.insert("memories", {
			namespace: "team/org-a",
			clerkOrgId: testClerkOrgId("org-a"),
			type: "reference",
			content: `${SECRET} pasted`,
			contentHash: "original-hash",
			createdBy,
			relations: [],
			isLatest: true,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
	const standIn = `${"a".repeat(31)}${idMap.size}`;
	idMap.set(standIn, real);
	return standIn;
}

async function erase(userId: string, org: string, memoryId: string) {
	const client = await connectAs(await personToken(userId, org));
	const r = (await client.callTool({
		name: "erase_memory",
		arguments: { memoryId, redactions: REDACTIONS },
	})) as ToolResult;
	await client.close();
	return r;
}

const rowOf = (standIn: string) =>
	t.run((ctx) => ctx.db.get(idMap.get(standIn) as never)) as Promise<{
		content: string;
		contentHash?: string;
	} | null>;

describe("erase_memory through /mcp as a person bearer", () => {
	it("SERVED: the author, an editor and not an admin, erases the row it wrote", async () => {
		const id = await memoryBy("user:user_author");
		const r = await erase("user_author", "org-a", id);
		expect(r.isError, r.content[0].text).toBeFalsy();
		expect(JSON.parse(r.content[0].text)).toMatchObject({
			replacements: 1,
			contentHashChanged: true,
		});
		const row = await rowOf(id);
		expect(row?.content).not.toContain(SECRET);
		expect(row?.contentHash).not.toBe("original-hash");
	});

	it("SERVED: an org admin who is not the author erases any row of its org", async () => {
		const id = await memoryBy("user:user_author");
		const r = await erase("user_admin", "org-a", id);
		expect(r.isError, r.content[0].text).toBeFalsy();
		expect((await rowOf(id))?.content).not.toContain(SECRET);
	});

	it("REFUSED: a same-org member who is not the author gets the typed RBAC_DENIED text; the row is unchanged", async () => {
		const id = await memoryBy("user:user_author");
		const r = await erase("user_other", "org-a", id);
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("RBAC_DENIED");
		expect((await rowOf(id))?.content).toContain(SECRET);
	});

	it("REFUSED: a caller of ANOTHER org (admin there) on org-a's row gets the door's typed refusal; the row is unchanged", async () => {
		const id = await memoryBy("user:user_author");
		const r = await erase("user_admin_b", "org-b", id);
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/RBAC_DENIED|ORG_MISMATCH/);
		expect((await rowOf(id))?.content).toContain(SECRET);
	});
});
