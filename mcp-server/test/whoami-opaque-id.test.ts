/**
 * whoami: opaque stable caller id, org slug, role, acting name, declared
 * outputSchema, `_meta["openai/profile"]`, and no secret in the payload.
 *
 * Runs the REAL McpServer through an in-memory transport so the SDK itself
 * validates `structuredContent` against the declared outputSchema.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools, whoamiOutputSchema } from "../src/tools.js";
import { deriveOpaqueCallerId } from "../src/whoamiIdentity.js";

const SECRET = "test-whoami-secret-not-a-real-credential";
const CLERK_SUB = "user_2abcDEFghiJKLmno";

function ctx(over: Partial<OAuthContext>): OAuthContext {
	return {
		clientId: "client-1",
		userId: CLERK_SUB,
		scopes: ["vantage:read"],
		scopeProfile: "team-member",
		fromAllowList: ["ada"],
		namespaceReadPrefixes: ["team/acme"],
		namespaceWritePrefixes: ["team/acme"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
		clerkJwt: "eyJ.raw.clerk-jwt-secret",
		accessTokenHash: "a".repeat(64),
		clerkOrgSlug: "acme",
		...over,
	};
}

async function callWhoami(oauthCtx: OAuthContext) {
	const server = new McpServer({ name: "t", version: "0.0.0" });
	const convex = {
		query: async () => null,
		mutation: async () => null,
		action: async () => null,
	} as unknown as Parameters<typeof registerTools>[1];
	registerTools(server, convex, oauthCtx);
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "0.0.0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	const tools = await client.listTools();
	const res = await client.callTool({ name: "whoami", arguments: {} });
	await client.close();
	return { tools: tools.tools, res };
}

const saved = { w: process.env.WHOAMI_ID_SECRET, b: process.env.BEARER_SECRET_MASTER };
beforeEach(() => {
	process.env.WHOAMI_ID_SECRET = SECRET;
});
afterEach(() => {
	if (saved.w === undefined) delete process.env.WHOAMI_ID_SECRET;
	else process.env.WHOAMI_ID_SECRET = saved.w;
	if (saved.b === undefined) delete process.env.BEARER_SECRET_MASTER;
	else process.env.BEARER_SECRET_MASTER = saved.b;
});

describe("whoami shape + outputSchema (real SDK validation)", () => {
	it("declares an outputSchema on the listed tool", async () => {
		const { tools } = await callWhoami(ctx({}));
		const t = tools.find((x) => x.name === "whoami");
		expect(t?.outputSchema).toBeDefined();
		const props = Object.keys(
			(t?.outputSchema as { properties: Record<string, unknown> }).properties,
		);
		for (const k of ["caller_id", "org_slug", "role", "acting_name"]) {
			expect(props).toContain(k);
		}
	});

	it("returns structuredContent that parses against whoamiOutputSchema, with _meta profile", async () => {
		const { res } = await callWhoami(
			ctx({ actor: { orgSlug: "acme", agentName: "ada" } }),
		);
		expect(res.isError).not.toBe(true);
		const parsed = whoamiOutputSchema.parse(res.structuredContent);
		expect(parsed.org_slug).toBe("acme");
		expect(parsed.role).toBe("org-member");
		expect(parsed.acting_name).toBe("ada");
		expect(parsed.caller_id).toMatch(/^vpu_[0-9a-f]{32}$/);
		const meta = res._meta as Record<string, Record<string, unknown>>;
		expect(meta["openai/profile"]).toEqual({
			id: parsed.caller_id,
			org_slug: "acme",
			role: "org-member",
			name: "ada",
		});
	});

	it("no actor header -> acting_name null; OAuth client role", async () => {
		const { res } = await callWhoami(
			ctx({ clerkJwt: undefined, userId: "oauth-user-1" }),
		);
		const parsed = whoamiOutputSchema.parse(res.structuredContent);
		expect(parsed.acting_name).toBeNull();
		expect(parsed.role).toBe("oauth-client");
	});
});

describe("whoami opaque id: stable, distinct, never the raw id", () => {
	it("same identity across two sessions/tokens/clients -> identical id", async () => {
		const a = await callWhoami(ctx({}));
		const b = await callWhoami(
			ctx({
				clientId: "another-client",
				clerkJwt: "eyJ.other.session.token",
				accessTokenHash: "b".repeat(64),
				expiresAt: Date.now() + 99_000,
			}),
		);
		const ida = (a.res.structuredContent as { caller_id: string }).caller_id;
		const idb = (b.res.structuredContent as { caller_id: string }).caller_id;
		expect(ida).toBe(idb);
	});

	it("two identities -> different ids", async () => {
		const a = await callWhoami(ctx({}));
		const b = await callWhoami(ctx({ userId: "user_2zzzOTHERperson" }));
		expect(
			(a.res.structuredContent as { caller_id: string }).caller_id,
		).not.toBe((b.res.structuredContent as { caller_id: string }).caller_id);
	});

	it("same subject string from two issuers (Clerk vs OAuth) -> different ids", () => {
		const env = { WHOAMI_ID_SECRET: SECRET };
		expect(deriveOpaqueCallerId(ctx({}), env)).not.toBe(
			deriveOpaqueCallerId(ctx({ clerkJwt: undefined }), env),
		);
	});

	it("a different server secret -> a different id (HMAC, not a bare hash)", () => {
		expect(deriveOpaqueCallerId(ctx({}), { WHOAMI_ID_SECRET: "s1" })).not.toBe(
			deriveOpaqueCallerId(ctx({}), { WHOAMI_ID_SECRET: "s2" }),
		);
	});

	it("falls back to the master secret only when WHOAMI_ID_SECRET is unset; null with neither", () => {
		const viaMaster = deriveOpaqueCallerId(ctx({}), {
			BEARER_SECRET_MASTER: "m",
		});
		expect(viaMaster).toMatch(/^vpu_/);
		expect(deriveOpaqueCallerId(ctx({}), {})).toBeNull();
	});

	it("the id contains neither the raw subject nor the agent name", async () => {
		const { res } = await callWhoami(
			ctx({ actor: { orgSlug: "acme", agentName: "ada" } }),
		);
		const id = (res.structuredContent as { caller_id: string }).caller_id;
		expect(id).not.toContain(CLERK_SUB);
		expect(id).not.toContain("ada");
	});
});

describe("whoami never returns a secret", () => {
	it("whole result (text, structured, _meta) holds no token, hash, JWT or server secret", async () => {
		process.env.BEARER_SECRET_MASTER = "master-bearer-value-xyz";
		const { res } = await callWhoami(
			ctx({ actor: { orgSlug: "acme", agentName: "ada" } }),
		);
		const all = JSON.stringify(res);
		for (const secret of [
			SECRET,
			"master-bearer-value-xyz",
			"eyJ.raw.clerk-jwt-secret",
			"a".repeat(64),
			CLERK_SUB,
		]) {
			expect(all).not.toContain(secret);
		}
		const keys = Object.keys(res.structuredContent as object);
		for (const forbidden of ["clerkJwt", "accessTokenHash", "token", "secret", "userId"]) {
			expect(keys).not.toContain(forbidden);
		}
	});

	it("master scope: role master, no wildcard internals", async () => {
		const { res } = await callWhoami(
			ctx({
				isMaster: true,
				clerkJwt: undefined,
				userId: "master",
				scopeProfile: "master",
				fromAllowList: ["*"],
				namespaceReadPrefixes: ["*"],
				namespaceWritePrefixes: ["*"],
				clerkOrgSlug: undefined,
				viaMasterBearer: true,
			}),
		);
		const p = whoamiOutputSchema.parse(res.structuredContent);
		expect(p.role).toBe("master");
		expect(p.fromAllowList).toEqual([]);
		expect(p.org_slug).toBeNull();
	});
});
