/**
 * PERSON_REFRESH_TOKEN - a person connection (/authorize -> consent -> /token)
 * is given a refresh token, and the refresh_token grant for it returns a new
 * access token and a new refresh token for the SAME agent.
 *
 * Task k17bgdk3j5r4dns1m132xag8rh8hasmk. Same harness as
 * oauth-end-to-end-by-identity.test.ts: the real Hono app against the real
 * Convex functions (convex-test); only the transport is a bridge. The six
 * constraints are pinned at the Convex door in
 * convex/__tests__/personRefreshTokens.test.ts; this file proves the HTTP
 * boundary reaches them. The seat grant is pinned unchanged by
 * seat-token-renewal.test.ts.
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
	type Harness,
	installAuthorizeHarness,
	membership,
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
const ORG_SLUG = "org-prt";
const ORG_ID = "org_prt";
const PERSON = "user_prt";

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

let harness: Harness;
beforeEach(async () => {
	harness = await installAuthorizeHarness();
});
afterEach(() => {
	_setInternalClientForTest(null);
	harness.restore();
});

/** A connected person: org + member + personal agent on the roster, one code exchange. */
async function connect() {
	const t = convexTest(schema, modules);
	const service = t.withIdentity({ subject: SERVICE_ACCOUNT_ID });
	_setInternalClientForTest(
		// biome-ignore lint/suspicious/noExplicitAny: test bridge
		bridge(service) as any,
	);
	const masterBearer = process.env.BEARER_SECRET_MASTER as string;
	const adminCall = (path: string, body: unknown) =>
		app.request(`/admin${path}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${masterBearer}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
	await adminCall("/oauth/seed-profiles", {});
	const created = await adminCall("/oauth/clients", {
		name: "prt-client",
		scope_profile: "client-generic",
		redirect_uris: [REDIRECT],
	});
	const { client_id: clientId, client_secret: clientSecret } =
		(await created.json()) as { client_id: string; client_secret: string };
	const agentId = await t.run(async (ctx) => {
		const agent = await ctx.db.insert("agents", {
			orgSlug: ORG_SLUG,
			clerkOrgId: ORG_ID,
			name: "Aria",
			normalizedName: "aria",
			isActive: true,
			createdAt: Date.now(),
			personalAgentOf: PERSON,
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: ORG_SLUG,
			clerkOrgId: ORG_ID,
			allowedOrchestrators: ["aria"],
			allowedAgentIds: [agent],
			scopes: ["view-own-tasks"],
			displayName: ORG_SLUG,
			isActive: true,
			createdAt: Date.now(),
		});
		await ctx.db.insert("orgMembership", {
			clerkOrgSlug: ORG_SLUG,
			clerkOrgId: ORG_ID,
			clerkUserId: PERSON,
			role: "member",
			createdAt: 1,
			updatedAt: 1,
			lastEventAt: 1,
		});
		return agent;
	});
	harness.setMemberships(PERSON, [membership(ORG_ID, ORG_SLUG)]);
	const verifier = "prt-code-verifier-0123456789-0123456789-0123456789";
	const authorize = await authorizeAsPerson(app, {
		clientId,
		redirectUri: REDIRECT,
		challenge: await sha256Base64Url(verifier),
		sessionToken: await harness.session(PERSON),
		orgId: ORG_ID,
		scope: "mcp:full offline_access",
	});
	const code = new URL(authorize.location as string).searchParams.get(
		"code",
	) as string;
	const basic = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
	const token = (form: Record<string, string>) =>
		app.request("/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Authorization: basic,
			},
			body: new URLSearchParams({ client_id: clientId, ...form }).toString(),
		});
	const exchanged = await token({
		grant_type: "authorization_code",
		code,
		code_verifier: verifier,
		redirect_uri: REDIRECT,
	});
	const first = (await exchanged.json()) as {
		access_token?: string;
		refresh_token?: string;
		scope?: string;
	};
	// The consent screen stamps the chosen agent on the access token; stamp it the
	// same way here, on the rows the exchange just wrote.
	await t.run(async (ctx) => {
		for (const r of await ctx.db.query("oauth_access_tokens").collect()) {
			await ctx.db.patch(r._id, { agentId });
		}
		for (const r of await ctx.db.query("oauth_refresh_tokens").collect()) {
			await ctx.db.patch(r._id, { agentId });
		}
	});
	return { t, token, exchanged, first, agentId };
}

describe("a person exchange returns a refresh_token", () => {
	it("ISSUED: /token authorization_code carries refresh_token, and offline_access is not minted", async () => {
		const { t, exchanged, first } = await connect();
		expect(exchanged.status).toBe(200);
		expect(first.refresh_token).toBeTruthy();
		const access = await t.run((ctx) =>
			ctx.db.query("oauth_access_tokens").collect(),
		);
		expect(access).toHaveLength(1);
		expect(access[0].scopes).not.toContain("offline_access");
		const stored = await t.run((ctx) =>
			ctx.db.query("oauth_refresh_tokens").collect(),
		);
		expect(stored).toHaveLength(1);
		expect(stored[0].tokenHash).toBe(
			await sha256Hex(first.refresh_token as string),
		);
		expect(JSON.stringify(stored)).not.toContain(first.refresh_token as string);
	});
});

describe("the person refresh_token grant", () => {
	it("ADMIT: new access + new refresh token, same agentId; the old refresh token is spent", async () => {
		const { t, token, first, agentId } = await connect();
		const refreshed = await token({
			grant_type: "refresh_token",
			refresh_token: first.refresh_token as string,
		});
		expect(refreshed.status).toBe(200);
		const body = (await refreshed.json()) as {
			access_token: string;
			refresh_token: string;
			scope: string;
		};
		expect(body.access_token).not.toBe(first.access_token);
		expect(body.refresh_token).not.toBe(first.refresh_token);
		expect(body.scope).not.toContain("offline_access");
		const hash = await sha256Hex(body.access_token);
		const row = await t.run((ctx) =>
			ctx.db
				.query("oauth_access_tokens")
				.withIndex("by_tokenHash", (q) => q.eq("tokenHash", hash))
				.unique(),
		);
		expect(row?.agentId).toBe(agentId);
		expect(row?.principal).toBe("person");
		const replay = await token({
			grant_type: "refresh_token",
			refresh_token: first.refresh_token as string,
		});
		expect(replay.status).toBe(400);
		expect(((await replay.json()) as { error: string }).error).toBe(
			"invalid_grant",
		);
		// the replay revoked the family: the second-generation refresh token is dead too
		const dead = await token({
			grant_type: "refresh_token",
			refresh_token: body.refresh_token,
		});
		expect(dead.status).toBe(400);
	});

	it("REFUSE: a removed member's refresh token answers invalid_grant", async () => {
		const { t, token, first } = await connect();
		expect(first.refresh_token).toBeTruthy();
		await t.run(async (ctx) => {
			const m =await ctx.db
				.query("orgMembership")
				.withIndex("by_user", (q) => q.eq("clerkUserId", PERSON))
				.unique();
			if (m) await ctx.db.patch(m._id, { deletedAt: 5_000 });
		});
		const refused = await token({
			grant_type: "refresh_token",
			refresh_token: first.refresh_token as string,
		});
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { error: string }).error).toBe(
			"invalid_grant",
		);
	});
});
