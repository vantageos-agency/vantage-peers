/**
 * erase_row through the REAL /mcp route, both poles, per table family, against the REAL
 * Convex door erase:eraseRow (convex-test). VantagePeers Cloud. Task
 * k170t9bg650dyw6hxjj627p9fx8hhpeq.
 *
 * Person tokens are minted by the real /authorize + /token flow; the tool forwards the
 * bearer hash (verifiedPerson) and the client acts for the bearer's org (__actingOrg); the
 * route's Convex client is a bridge that runs every call on the backend as the fleet
 * service account, so the Convex door is what decides and its typed refusal is what the
 * client reads. The seat (agent) poles of the same door are in
 * convex/__tests__/eraseRow.test.ts (every covered table) and, through the real tool
 * handlers, in src/__tests__/seat-two-pole-sweep.test.ts.
 *
 *   SERVED   the AUTHOR (a plain member, not admin) erases the row it wrote; an org ADMIN
 *            who is not the author erases any row of its org;
 *   REFUSED  a same-org member who is not the author -> RBAC_DENIED relayed, the row
 *            unchanged; a caller of ANOTHER org (admin there) on org-a's row -> the
 *            door's typed refusal relayed, the row unchanged.
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

type T = ReturnType<typeof convexTest<typeof schema>>;
type ToolResult = { isError?: boolean; content: { text: string }[] };

let t: T;
let harness: Harness;
let challenge: string;

beforeEach(async () => {
	harness = await installAuthorizeHarness();
	challenge = await sha256Base64Url(VERIFIER);
	vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });
	t = convexTest(schema, modules);
	const asService = t.withIdentity({ subject: SERVICE_ACCOUNT_ID });
	backend.run = async (kind, name, rawArgs) => {
		const ref = makeFunctionReference<"mutation">(name) as never;
		const args = { ...(rawArgs as Record<string, unknown>) };
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

const org = (slug: string) => testClerkOrgId(slug) as string;
const now = () => Date.now();

// One seeded row per family, written by `author` (a stored author ID) in org-a.
const FAMILIES: { table: string; seed: (author: string) => Promise<string> }[] = [
	{
		table: "memories",
		seed: (author) =>
			t.run((ctx) =>
				ctx.db.insert("memories", {
					namespace: "team/org-a",
					clerkOrgId: org("org-a"),
					type: "reference",
					content: "route erase me",
					createdBy: author,
					createdById: author,
					relations: [],
					isLatest: true,
					createdAt: now(),
					updatedAt: now(),
				}),
			),
	},
	{
		table: "tasks",
		seed: (author) =>
			t.run((ctx) =>
				ctx.db.insert("tasks", {
					title: "route erase me",
					assignedTo: "agent",
					priority: "medium",
					status: "todo",
					createdBy: author,
					createdById: author,
					createdAt: now(),
					updatedAt: now(),
					orgId: "org-a",
					clerkOrgId: org("org-a"),
				}),
			),
	},
	{
		table: "diary",
		seed: (author) =>
			t.run((ctx) =>
				ctx.db.insert("diary", {
					date: "2026-11-03",
					orchestrator: "agent",
					content: "route erase me",
					createdBy: author,
					createdById: author,
					createdAt: now(),
					orgId: "org-a",
					clerkOrgId: org("org-a"),
				}),
			),
	},
	{
		table: "briefingNotes",
		seed: (author) =>
			t.run((ctx) =>
				ctx.db.insert("briefingNotes", {
					title: "route erase me",
					topic: "t",
					participants: ["agent"],
					content: "route erase me",
					createdBy: author,
					createdById: author,
					createdAt: now(),
					orgId: "org-a",
					clerkOrgId: org("org-a"),
				}),
			),
	},
	{
		table: "messages",
		seed: (author) =>
			t.run((ctx) =>
				ctx.db.insert("messages", {
					from: author,
					fromId: author,
					channel: "agent",
					content: "route erase me",
					tenantId: "org-a",
					tenantOrgId: org("org-a"),
					createdAt: now(),
				}),
			),
	},
];

async function eraseAs(
	userId: string,
	org: string,
	table: string,
	rowId: string,
): Promise<ToolResult> {
	const client = await connectAs(await personToken(userId, org));
	const r = (await client.callTool({
		name: "erase_row",
		arguments: { table, rowId },
	})) as ToolResult;
	await client.close();
	return r;
}

const present = (id: string) =>
	t.run(async (ctx) => (await ctx.db.get(id as never)) !== null);

describe.each(FAMILIES)("erase_row through /mcp as a person bearer — $table", ({ table, seed }) => {
	it("SERVED: the author, an editor and not an admin, erases the row it wrote", async () => {
		const id = await seed("user:user_author");
		const r = await eraseAs("user_author", "org-a", table, id);
		expect(r.isError, r.content[0].text).toBeFalsy();
		expect(JSON.parse(r.content[0].text)).toMatchObject({ table, erased: true });
		expect(await present(id)).toBe(false);
	});

	it("SERVED: an org admin who is not the author erases any row of its org", async () => {
		const id = await seed("user:user_author");
		const r = await eraseAs("user_admin", "org-a", table, id);
		expect(r.isError, r.content[0].text).toBeFalsy();
		expect(await present(id)).toBe(false);
	});

	it("REFUSED: a same-org member who is not the author gets the typed RBAC_DENIED text; the row is unchanged", async () => {
		const id = await seed("user:user_author");
		const r = await eraseAs("user_other", "org-a", table, id);
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("RBAC_DENIED");
		expect(await present(id)).toBe(true);
	});

	it("REFUSED: a caller of ANOTHER org (admin there) on org-a's row gets the door's typed refusal; the row is unchanged", async () => {
		const id = await seed("user:user_author");
		const r = await eraseAs("user_admin_b", "org-b", table, id);
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/RBAC_DENIED|ORG_MISMATCH/);
		expect(await present(id)).toBe(true);
	});
});

describe("erase_row through /mcp — the enum", () => {
	it("a table outside the covered list is refused by the tool's input schema before any backend call", async () => {
		const client = await connectAs(await personToken("user_admin", "org-a"));
		const r = (await client.callTool({
			name: "erase_row",
			arguments: { table: "oauth_access_tokens", rowId: "x" },
		})) as ToolResult;
		await client.close();
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("Invalid arguments for tool erase_row");
	});
});
