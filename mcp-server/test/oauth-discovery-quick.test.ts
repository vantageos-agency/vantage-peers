/**
 * OAuth discovery quick wins — VantagePeers Cloud MCP server
 * (task k177sbtzv7ecw21b55ynqf8wfs8fkhrw, scope item 1).
 *
 * Four contracts, each RED on d440b95 and GREEN after the fix:
 *
 *   1. RFC 9728 Protected Resource Metadata names the resource the client
 *      actually configures (`<base>/mcp`), is served at both the bare and the
 *      path-inserted well-known URL, and the 401 from /mcp points at the
 *      path-inserted (/mcp) variant.
 *   2. RFC 8414 AS metadata advertises `none` (public clients — DCR already
 *      accepts and /token already honours it) and does NOT advertise Client ID
 *      Metadata Documents, which this server does not implement.
 *   3. RFC 9207: the authorization response carries `iss`, and the metadata
 *      says so (`authorization_response_iss_parameter_supported: true`).
 *   4. DCR rate limit is two-tier: distinct clients behind one egress IP are
 *      not throttled together, an identical-registration loop is, and a
 *      per-IP abuse ceiling still holds.
 *
 * Harness: Hono app.request() + fake ConvexHttpClient (same pattern as
 * oauth-d6-d7.test.ts). No network, no Convex process.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as serverHttp from "../server-http.js";
import { _setInternalClientForTest } from "../src/auth.js";

// Namespace import so each pole fails on its own assertion (not on a missing
// export at module load) when run against the pre-fix server.
const { app } = serverHttp;
const REGISTER_RATE_LIMIT_PER_CLIENT =
	serverHttp.REGISTER_RATE_LIMIT_PER_CLIENT ?? 10;
const REGISTER_RATE_LIMIT_PER_IP = serverHttp.REGISTER_RATE_LIMIT_PER_IP ?? 60;

type ClientRow = {
	clientId: string;
	redirectUris: string[];
	scopeProfile: string;
	tokenEndpointAuthMethod?: string;
};

const clients = new Map<string, ClientRow>();
const authCodes = new Map<string, Record<string, unknown>>();

function makeFakeConvex() {
	return {
		query: async (name: string, args: Record<string, unknown>) => {
			if (name === "oauth:getClientByClientId") {
				return clients.get(args.clientId as string) ?? null;
			}
			// bearerAuthMiddleware lookups on an absent/unknown token resolve to null
			return null;
		},
		mutation: async (name: string, args: Record<string, unknown>) => {
			if (name === "oauth:registerPublicClient") {
				clients.set(args.clientId as string, {
					clientId: args.clientId as string,
					redirectUris: args.redirectUris as string[],
					scopeProfile: args.scopeProfile as string,
				});
				return "fake-id";
			}
			if (name === "oauth:createAuthorizationCode") {
				authCodes.set(args.code as string, args);
				return "fake-id";
			}
			throw new Error(`unmocked mutation: ${name}`);
		},
	};
}

beforeEach(() => {
	clients.clear();
	authCodes.clear();
	serverHttp._resetRegisterRateLimitForTest?.();
	// biome-ignore lint/suspicious/noExplicitAny: test fake
	_setInternalClientForTest(makeFakeConvex() as any);
});

const HOST_HEADERS = {
	host: "vp.example.com",
	"x-forwarded-proto": "https",
};
const BASE = "https://vp.example.com";

async function getJson(
	path: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await app.request(`http://localhost${path}`, {
		headers: HOST_HEADERS,
	});
	const text = await res.text();
	let json: Record<string, unknown> = {};
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		// non-JSON body (404) — leave empty
	}
	return { status: res.status, json };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Protected Resource Metadata (RFC 9728)
// ─────────────────────────────────────────────────────────────────────────────

describe("item 1 — protected resource metadata names <base>/mcp", () => {
	it("bare well-known URL: resource is the /mcp URL clients configure", async () => {
		const { status, json } = await getJson(
			"/.well-known/oauth-protected-resource",
		);
		expect(status).toBe(200);
		expect(json.resource).toBe(`${BASE}/mcp`);
		expect(json.authorization_servers).toEqual([BASE]);
	});

	it("path-inserted well-known URL (/mcp) is served with the same document", async () => {
		const { status, json } = await getJson(
			"/.well-known/oauth-protected-resource/mcp",
		);
		expect(status).toBe(200);
		expect(json.resource).toBe(`${BASE}/mcp`);
		expect(json.authorization_servers).toEqual([BASE]);
	});

	it("401 from /mcp points resource_metadata at the /mcp variant", async () => {
		const res = await app.request("http://localhost/mcp", {
			method: "POST",
			headers: { ...HOST_HEADERS, "content-type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toBe(
			`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 + 3. Authorization Server Metadata (RFC 8414) — none, no CIMD, RFC 9207
// ─────────────────────────────────────────────────────────────────────────────

describe("items 2+3 — authorization server metadata", () => {
	it("advertises token_endpoint_auth_method none (public clients)", async () => {
		const { json } = await getJson("/.well-known/oauth-authorization-server");
		expect(json.token_endpoint_auth_methods_supported).toEqual(
			expect.arrayContaining([
				"none",
				"client_secret_basic",
				"client_secret_post",
			]),
		);
	});

	it("does NOT advertise Client ID Metadata Documents (not implemented)", async () => {
		const { json } = await getJson("/.well-known/oauth-authorization-server");
		expect(json.client_id_metadata_document_supported).not.toBe(true);
	});

	it("advertises authorization_response_iss_parameter_supported (RFC 9207)", async () => {
		const { json } = await getJson("/.well-known/oauth-authorization-server");
		expect(json.authorization_response_iss_parameter_supported).toBe(true);
		expect(json.issuer).toBe(BASE);
	});
});

describe("item 3 — authorization response carries iss (RFC 9207)", () => {
	it("302 redirect to the client carries iss equal to the metadata issuer", async () => {
		clients.set("client-a", {
			clientId: "client-a",
			redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
			scopeProfile: "client-generic",
		});
		const qs = new URLSearchParams({
			client_id: "client-a",
			redirect_uri: "https://claude.ai/api/mcp/auth_callback",
			code_challenge: "abc",
			code_challenge_method: "S256",
			response_type: "code",
			state: "st-1",
		});
		const res = await app.request(`http://localhost/authorize?${qs}`, {
			headers: HOST_HEADERS,
		});
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get("location") ?? "");
		expect(location.searchParams.get("iss")).toBe(BASE);
		expect(location.searchParams.get("state")).toBe("st-1");
		expect(location.searchParams.get("code")).toBeTruthy();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. DCR rate limit — two tiers
// ─────────────────────────────────────────────────────────────────────────────

async function register(
	ip: string,
	clientName: string,
	redirectUri = "https://claude.ai/api/mcp/auth_callback",
): Promise<number> {
	const res = await app.request("http://localhost/register", {
		method: "POST",
		headers: { "content-type": "application/json", "x-forwarded-for": ip },
		body: JSON.stringify({
			client_name: clientName,
			redirect_uris: [redirectUri],
		}),
	});
	return res.status;
}

describe("item 4 — DCR rate limit keyed per client, with a per-IP ceiling", () => {
	it("states the numbers: 10/min per (IP, client fingerprint), 60/min per IP", () => {
		expect(serverHttp.REGISTER_RATE_LIMIT_PER_CLIENT).toBe(10);
		expect(serverHttp.REGISTER_RATE_LIMIT_PER_IP).toBe(60);
	});

	it("distinct clients behind one shared egress IP are not throttled together", async () => {
		const statuses: number[] = [];
		for (let i = 0; i < 12; i++) {
			statuses.push(
				await register(
					"160.79.104.10",
					`client-${i}`,
					`https://app-${i}.example.com/callback`,
				),
			);
		}
		// d440b95: 6th registration from the same IP was 429.
		expect(statuses.every((s) => s === 201)).toBe(true);
	});

	it("an identical-registration loop from one IP is throttled at the per-client limit", async () => {
		const statuses: number[] = [];
		for (let i = 0; i < REGISTER_RATE_LIMIT_PER_CLIENT + 1; i++) {
			statuses.push(await register("203.0.113.7", "loop"));
		}
		expect(statuses.slice(0, REGISTER_RATE_LIMIT_PER_CLIENT)).toEqual(
			Array(REGISTER_RATE_LIMIT_PER_CLIENT).fill(201),
		);
		expect(statuses[REGISTER_RATE_LIMIT_PER_CLIENT]).toBe(429);
	});

	it("the per-IP abuse ceiling holds even when every registration is distinct", async () => {
		const statuses: number[] = [];
		for (let i = 0; i < REGISTER_RATE_LIMIT_PER_IP + 1; i++) {
			statuses.push(
				await register(
					"198.51.100.9",
					`spray-${i}`,
					`https://spray-${i}.example.com/cb`,
				),
			);
		}
		expect(statuses.slice(0, REGISTER_RATE_LIMIT_PER_IP)).toEqual(
			Array(REGISTER_RATE_LIMIT_PER_IP).fill(201),
		);
		expect(statuses[REGISTER_RATE_LIMIT_PER_IP]).toBe(429);
	});

	it("a throttled client on one IP does not throttle the same client on another IP", async () => {
		for (let i = 0; i < REGISTER_RATE_LIMIT_PER_CLIENT; i++) {
			await register("203.0.113.20", "same");
		}
		expect(await register("203.0.113.20", "same")).toBe(429);
		expect(await register("203.0.113.21", "same")).toBe(201);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4b. The rate-limit IP is the one the trusted edge observed, never the
//     client-controlled first x-forwarded-for entry.
// ─────────────────────────────────────────────────────────────────────────────

async function registerWithHeaders(
	headers: Record<string, string>,
	clientName: string,
): Promise<number> {
	const res = await app.request("http://localhost/register", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({
			client_name: clientName,
			redirect_uris: [`https://${clientName}.example.com/cb`],
		}),
	});
	return res.status;
}

describe("item 4b — rate-limit IP comes from the trusted proxy", () => {
	it("a rotating spoofed FIRST x-forwarded-for entry does not escape the per-IP ceiling (rightmost entry counts)", async () => {
		const statuses: number[] = [];
		for (let i = 0; i < REGISTER_RATE_LIMIT_PER_IP + 1; i++) {
			statuses.push(
				await registerWithHeaders(
					{ "x-forwarded-for": `10.9.${i}.1, 198.51.100.50` },
					`spoof-${i}`,
				),
			);
		}
		expect(statuses.slice(0, REGISTER_RATE_LIMIT_PER_IP)).toEqual(
			Array(REGISTER_RATE_LIMIT_PER_IP).fill(201),
		);
		expect(statuses[REGISTER_RATE_LIMIT_PER_IP]).toBe(429);
	});

	it("x-real-ip (set by the Railway edge) wins over any x-forwarded-for content", async () => {
		const statuses: number[] = [];
		for (let i = 0; i < REGISTER_RATE_LIMIT_PER_IP + 1; i++) {
			statuses.push(
				await registerWithHeaders(
					{
						"x-real-ip": "198.51.100.77",
						"x-forwarded-for": `10.8.${i}.1, 10.7.${i}.2`,
					},
					`real-${i}`,
				),
			);
		}
		expect(statuses[REGISTER_RATE_LIMIT_PER_IP - 1]).toBe(201);
		expect(statuses[REGISTER_RATE_LIMIT_PER_IP]).toBe(429);
	});

	it("no proxy header at all falls back to one shared 'unknown' bucket, as before", async () => {
		const statuses: number[] = [];
		for (let i = 0; i < REGISTER_RATE_LIMIT_PER_IP + 1; i++) {
			statuses.push(await registerWithHeaders({}, `bare-${i}`));
		}
		expect(statuses[REGISTER_RATE_LIMIT_PER_IP - 1]).toBe(201);
		expect(statuses[REGISTER_RATE_LIMIT_PER_IP]).toBe(429);
	});

	it("clientIpForRateLimit: x-real-ip, else rightmost x-forwarded-for, else unknown", () => {
		const pick = serverHttp.clientIpForRateLimit;
		const h = (o: Record<string, string>) => (n: string) => o[n];
		expect(pick(h({ "x-real-ip": " 203.0.113.1 " }))).toBe("203.0.113.1");
		expect(pick(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.2" }))).toBe(
			"203.0.113.2",
		);
		expect(pick(h({ "x-forwarded-for": "203.0.113.3" }))).toBe("203.0.113.3");
		expect(pick(h({ "x-forwarded-for": "6.6.6.6, " }))).toBe("6.6.6.6");
		expect(pick(h({ "x-forwarded-for": " , " }))).toBe("unknown");
		expect(pick(h({}))).toBe("unknown");
	});
});
