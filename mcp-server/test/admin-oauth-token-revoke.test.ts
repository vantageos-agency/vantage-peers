/**
 * Admin token revoke routes (VantagePeers Cloud).
 *
 *   POST   /admin/oauth/access-tokens/:tokenId/revoke               (new, master-only)
 *   POST   /admin/oauth/clients/:clientId/revoke-access-tokens-only  (admin-mint:* clients)
 *   DELETE /admin/oauth/clients/:clientId
 *
 * Convex redacts a thrown Error's message to "[Request ID: ..] Server Error" in
 * production; only a ConvexError's `data` survives. The routes therefore map on
 * `err.data` (a coded string), never on `err.message`.
 *
 * Harness: Hono `app.request()` in-memory; a fake ConvexHttpClient is injected
 * through _setInternalClientForTest.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../server-http.js";
import { _setInternalClientForTest } from "../src/auth.js";

type Call = { name: string; args: Record<string, unknown> };

const state: {
	calls: Call[];
	impl: (name: string, args: Record<string, unknown>) => Promise<unknown>;
} = {
	calls: [],
	impl: async () => ({}),
};

// What ConvexHttpClient raises for a server-side `throw new ConvexError(data)`:
// the message is redacted, the payload rides on `data`.
function convexError(data: string): Error {
	const e = new Error("[Request ID: abc123] Server Error") as Error & {
		data: string;
	};
	e.name = "ConvexError";
	e.data = data;
	return e;
}

const MASTER = "test-master-token"; // matches vitest.config.ts env
const REASON = "operator audit trail reason, over twenty characters";
const TOKEN_ID = "k57abc123def456ghi789jkl012mno345";

beforeEach(() => {
	state.calls.length = 0;
	state.impl = async () => ({});
	_setInternalClientForTest(
		// biome-ignore lint/suspicious/noExplicitAny: test fake
		{
			query: async (name: string) => {
				throw new Error(`unmocked query: ${name}`);
			},
			mutation: async (name: string, args: Record<string, unknown>) => {
				state.calls.push({ name, args });
				return state.impl(name, args);
			},
		} as any,
	);
});

function post(
	path: string,
	body: Record<string, unknown> | undefined,
	auth: string | undefined = `Bearer ${MASTER}`,
): Promise<Response> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (auth) headers.Authorization = auth;
	return app.request(`http://localhost${path}`, {
		method: "POST",
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

describe("POST /admin/oauth/access-tokens/:tokenId/revoke", () => {
	it("200: forwards the row id and the reason to oauth:revokeAccessTokenById", async () => {
		state.impl = async () => ({
			tokenId: TOKEN_ID,
			clientId: "admin-mint:abc",
			alreadyRevoked: false,
		});
		const res = await post(`/admin/oauth/access-tokens/${TOKEN_ID}/revoke`, {
			reason: REASON,
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ tokenId: TOKEN_ID });
		expect(state.calls).toEqual([
			{
				name: "oauth:revokeAccessTokenById",
				args: { tokenId: TOKEN_ID, reason: REASON },
			},
		]);
	});

	it("401 without a bearer, 403 with a wrong bearer: nothing reaches Convex", async () => {
		const path = `/admin/oauth/access-tokens/${TOKEN_ID}/revoke`;
		expect((await post(path, { reason: REASON }, "")).status).toBe(401);
		expect(
			(await post(path, { reason: REASON }, "Bearer not-the-master")).status,
		).toBe(403);
		expect(state.calls).toEqual([]);
	});

	it("400 when the reason is absent", async () => {
		const res = await post(`/admin/oauth/access-tokens/${TOKEN_ID}/revoke`, {});
		expect(res.status).toBe(400);
		expect(state.calls).toEqual([]);
	});

	it("404 on TOKEN_NOT_FOUND, 400 on a malformed id or a short reason", async () => {
		const path = `/admin/oauth/access-tokens/${TOKEN_ID}/revoke`;
		state.impl = async () => {
			throw convexError("TOKEN_NOT_FOUND: no access token row");
		};
		expect((await post(path, { reason: REASON })).status).toBe(404);
		state.impl = async () => {
			throw convexError("REASON_TOO_SHORT: reason must be at least 20");
		};
		expect((await post(path, { reason: "short" })).status).toBe(400);
		state.impl = async () => {
			throw convexError("INVALID_ID: not a valid oauth_access_tokens ID");
		};
		expect((await post(path, { reason: REASON })).status).toBe(400);
	});

	it("500 with the coded detail for any other failure", async () => {
		state.impl = async () => {
			throw convexError("RBAC_DENIED: not the service account");
		};
		const res = await post(`/admin/oauth/access-tokens/${TOKEN_ID}/revoke`, {
			reason: REASON,
		});
		expect(res.status).toBe(500);
		expect(JSON.stringify(await res.json())).toContain("RBAC_DENIED");
	});
});

describe("POST /admin/oauth/clients/:clientId/revoke-access-tokens-only", () => {
	it("404 for an admin-mint:* client whose message Convex redacted", async () => {
		state.impl = async () => {
			throw convexError("CLIENT_NOT_FOUND: client not found: admin-mint:abc");
		};
		const res = await post(
			"/admin/oauth/clients/admin-mint:abc/revoke-access-tokens-only",
			{ reason: REASON },
		);
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ error: "not_found" });
	});

	it("400 on REASON_TOO_SHORT carried by data", async () => {
		state.impl = async () => {
			throw convexError("REASON_TOO_SHORT: reason must be at least 20");
		};
		const res = await post(
			"/admin/oauth/clients/c1/revoke-access-tokens-only",
			{ reason: "short" },
		);
		expect(res.status).toBe(400);
	});
});

describe("DELETE /admin/oauth/clients/:clientId", () => {
	it("a Convex failure answers structured JSON carrying the coded detail, not a bare 500", async () => {
		state.impl = async () => {
			throw convexError("SOME_CODE: backend refused");
		};
		const res = await app.request("http://localhost/admin/oauth/clients/c1", {
			method: "DELETE",
			headers: { Authorization: `Bearer ${MASTER}` },
		});
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error?: string; detail?: string };
		expect(body.error).toBe("server_error");
		expect(body.detail).toContain("SOME_CODE");
	});

	it("200 passes the result through", async () => {
		state.impl = async () => ({
			revokedClient: true,
			revokedTokens: 1,
			revokedRefresh: 1,
		});
		const res = await app.request("http://localhost/admin/oauth/clients/c1", {
			method: "DELETE",
			headers: { Authorization: `Bearer ${MASTER}` },
		});
		expect(res.status).toBe(200);
	});
});
