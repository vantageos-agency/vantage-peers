/**
 * An org token whose organisation is inactive is refused at the MCP boundary.
 * task k17fhnxz9sbqptg0tesxktv7es8hd360. VantagePeers Cloud.
 *
 * `oauth:getAccessTokenByHash` answers null for an access token whose org mapping
 * is inactive or missing. The bearer middleware must turn that null into a 401 and
 * must NOT hand the same bearer to another layer that would accept it (the Clerk
 * JWT layer is the only one after it; an opaque access token is not a JWT, and
 * the mapping join `clientOrgMapping:getByClerkSlug` must never be reached for it).
 * Counter-pole: the same bearer with a live context is served (200).
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_setInternalClientForTest,
	bearerAuthMiddleware,
	type OAuthContext,
} from "../src/auth.js";

const OPAQUE_TOKEN = "a".repeat(64);

const liveContext = {
	clientId: "client-1",
	userId: "seat",
	scopes: ["mcp:full"],
	scopeProfile: "p-org",
	fromAllowList: ["clio"],
	namespaceReadPrefixes: ["team/org-a"],
	namespaceWritePrefixes: ["team/org-a"],
	expiresAt: Date.now() + 3_600_000,
	seatAgent: null,
	personalAgent: null,
};

function fakeConvex(accessTokenAnswer: unknown, seen: string[]) {
	return {
		query: async (name: string) => {
			seen.push(name);
			if (name === "oauth:getAccessTokenByHash") return accessTokenAnswer;
			throw new Error(`unmocked query: ${name}`);
		},
		mutation: async (name: string) => {
			throw new Error(`unmocked mutation: ${name}`);
		},
	};
}

function buildApp(): Hono {
	const app = new Hono();
	app.use("*", bearerAuthMiddleware());
	app.get("/echo", (c) =>
		c.json({ ctx: (c.get("oauthContext") as OAuthContext | undefined) ?? null }),
	);
	return app;
}

describe("inactive-org access token at the bearer boundary", () => {
	beforeEach(() => {
		process.env.CONVEX_URL_INTERNAL = "https://internal.example.convex.cloud";
		// The Clerk layer must not be able to accept the bearer: no network at all.
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				throw new Error(`unmocked fetch: ${String(input)}`);
			}),
		);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("DENY: getAccessTokenByHash null (inactive org) -> 401, no context, no fall-through to the mapping join", async () => {
		const seen: string[] = [];
		// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
		_setInternalClientForTest(fakeConvex(null, seen) as any);
		const res = await buildApp().request("http://localhost/echo", {
			headers: { Authorization: `Bearer ${OPAQUE_TOKEN}` },
		});
		expect(res.status).toBe(401);
		expect(seen).toEqual(["oauth:getAccessTokenByHash"]);
	});

	it("PRESENT: the same bearer with a live context is served", async () => {
		const seen: string[] = [];
		// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
		_setInternalClientForTest(fakeConvex(liveContext, seen) as any);
		const res = await buildApp().request("http://localhost/echo", {
			headers: { Authorization: `Bearer ${OPAQUE_TOKEN}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ctx: OAuthContext | null };
		expect(body.ctx?.clientId).toBe("client-1");
	});
});
