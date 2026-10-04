/**
 * The HTTP /mcp route hands the tools THIS request's verified caller, in both
 * protocol eras. VantagePeers Cloud.
 *
 * Eta REVISE on PR #1446 (mutant S3): replacing `registerTools(server, convex,
 * oauthCtx)` in server-http.ts's per-request factory by `(…, undefined)` left
 * the whole suite green, because every route-level test ran as master and the
 * scoped suites call registerTools directly. This file drives the REAL route
 * (Hono app + bearer middleware + createMcpHandler) with scoped person tokens
 * minted by the real /authorize + /token flow, through the official v2 client,
 * on 2026-07-28 AND 2025-11-25:
 *
 *   - DENY:  a viewer person's write is refused `role-not-writer`, nothing sent;
 *   - ALLOW: an editor person's write is served and reaches Convex once, under
 *            the MCP server's service-account identity (mint stubbed);
 *   - NONE:  a request with no bearer is answered 401 before any MCP layer.
 *
 * The Convex deployment client the route builds (`convex/browser`) is replaced
 * by a recorder, so "nothing sent" and "sent once" are measured, not inferred.
 */

import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../../convex/schema";
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

// What the route's per-request Convex client was asked to do.
const sent = vi.hoisted(() => ({
	calls: [] as Array<{ kind: string; name: string; auth: string | null }>,
}));

vi.mock("convex/browser", () => {
	class RecordingConvexHttpClient {
		auth: string | null = null;
		constructor(_url: string) {}
		setAuth(token: string) {
			this.auth = token;
		}
		clearAuth() {
			this.auth = null;
		}
		async query(name: string) {
			sent.calls.push({ kind: "query", name: String(name), auth: this.auth });
			return [];
		}
		async mutation(name: string) {
			sent.calls.push({
				kind: "mutation",
				name: String(name),
				auth: this.auth,
			});
			return "mem-id";
		}
		async action(name: string) {
			sent.calls.push({ kind: "action", name: String(name), auth: this.auth });
			return null;
		}
	}
	return { ConvexHttpClient: RecordingConvexHttpClient };
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
const WRITE = {
	namespace: "team/org-a",
	type: "project",
	content: "a note",
	createdBy: "agent-a",
};

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

let t: T;
let harness: Harness;
let challenge: string;

beforeEach(async () => {
	sent.calls.length = 0;
	harness = await installAuthorizeHarness();
	challenge = await sha256Base64Url(VERIFIER);
	t = convexTest(schema, modules);
	_setInternalClientForTest(
		// biome-ignore lint/suspicious/noExplicitAny: test bridge
		bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })) as any,
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
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["agent-a"],
			scopes: ["vantage:read", "vantage:write"],
			displayName: "a",
			isActive: true,
			createdAt: now,
		});
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: now,
		});
	});
	harness.setMemberships("user_viewer", [
		membership("org_A", "org-a", "org:viewer"),
	]);
	harness.setMemberships("user_editor", [
		membership("org_A", "org-a", "org:editor"),
	]);
});

afterEach(() => {
	harness.restore();
	_setInternalClientForTest(null);
	_setServiceAccountDepsForTest(null);
	_resetServiceAccountCacheForTest();
});

/** Signs the person in through the real flow and returns the raw access token. */
async function personToken(userId: string): Promise<string> {
	const r = await authorizeAsPerson(app, {
		clientId: CLIENT_ID,
		redirectUri: REDIRECT,
		challenge,
		sessionToken: await harness.session(userId),
		orgId: "org_A",
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

/** In-process fetch into the real Hono app carrying `token` as the bearer. */
function shimFor(token: string) {
	return async (url: string | URL, init?: RequestInit): Promise<Response> => {
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${token}`);
		return app.fetch(new Request(url, { ...init, headers }));
	};
}

const ERAS = [
	{ era: "modern", version: "2026-07-28" },
	{ era: "legacy", version: "2025-11-25" },
] as const;

async function connectAs(token: string, era: "modern" | "legacy") {
	const client = new Client(
		{ name: "route-scoped-test", version: "0.0.0" },
		era === "modern" ? { versionNegotiation: { mode: "auto" } } : {},
	);
	await client.connect(
		new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
			fetch: shimFor(token),
		}),
	);
	return client;
}

type ToolResult = { isError?: boolean; content: { text: string }[] };

describe.each(ERAS)("/mcp under a scoped person token ($era era)", ({
	era,
	version,
}) => {
	it("a viewer's write is refused role-not-writer and nothing reaches Convex", async () => {
		const client = await connectAs(await personToken("user_viewer"), era);
		expect(client.getNegotiatedProtocolVersion()).toBe(version);
		const r = (await client.callTool({
			name: "store_memory",
			arguments: WRITE,
		})) as ToolResult;
		await client.close();
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("role-not-writer");
		expect(sent.calls.filter((c) => c.kind !== "query")).toEqual([]);
	});

	it("an editor's write is served and reaches Convex once, as the service account", async () => {
		const client = await connectAs(await personToken("user_editor"), era);
		expect(client.getNegotiatedProtocolVersion()).toBe(version);
		const r = (await client.callTool({
			name: "store_memory",
			arguments: WRITE,
		})) as ToolResult;
		await client.close();
		expect(r.isError).toBeFalsy();
		expect(sent.calls.filter((c) => c.kind === "mutation")).toEqual([
			{
				kind: "mutation",
				name: "memories:storeMemory",
				auth: SERVICE_ACCOUNT_JWT,
			},
		]);
	});
});

describe("/mcp with no bearer", () => {
	it.each([
		{
			era: "2026-07-28",
			method: "server/discover",
			headers: { "MCP-Protocol-Version": "2026-07-28" },
			params: {
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		},
		{
			era: "2025-11-25",
			method: "initialize",
			headers: {},
			params: {
				protocolVersion: "2025-11-25",
				capabilities: {},
				clientInfo: { name: "anon", version: "0" },
			},
		},
	])("$era: $method is answered 401 and never reaches Convex", async ({
		method,
		headers,
		params,
	}) => {
		const res = await app.fetch(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					...headers,
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
			}),
		);
		expect(res.status).toBe(401);
		expect(sent.calls).toEqual([]);
	});
});
