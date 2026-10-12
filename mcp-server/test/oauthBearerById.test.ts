/**
 * oauthBearerById.test.ts - module M3, MCP side. VantagePeers Cloud.
 *
 * The OAuth bearer is judged by @vantageos/cloud-identity (`validatePresentedBearer`)
 * and a one-agent seat token filters list_tasks by the agent it was issued for, by ID.
 *
 *   BEARER  a row the provider returns EXPIRED or REVOKED is refused (401) even if an
 *           older Convex handed it back; a live row passes with the agent ID attached.
 *   GATE    a seat resolved to an agent ID may filter by that agent's CURRENT label
 *           only; a stale allowlist name and another agent's name are Forbidden.
 *   REFRESH a refresh token is spent by the grant that uses it (see also
 *           test/audit/oauth-refresh.twoPoles.test.ts).
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import {
	_setInternalClientForTest,
	bearerAuthMiddleware,
	type OAuthContext,
} from "../src/auth.js";
import { listTasksGate } from "../src/list-tasks-gate.js";

const RAW = "m3-raw-access-token-0001";

function row(over: Record<string, unknown> = {}) {
	return {
		clientId: "seat-client",
		userId: "seat",
		scopes: ["mcp:full"],
		scopeProfile: "clio-org-a",
		fromAllowList: ["clio"],
		namespaceReadPrefixes: ["orchestrator/clio"],
		namespaceWritePrefixes: ["orchestrator/clio"],
		expiresAt: Date.now() + 3_600_000,
		clerkOrgSlug: "org-a",
		seatAgent: { agentId: "agent-clio-a", orgId: "org-a", agentName: "clio" },
		...over,
	};
}

function appWith(provider: (name: string) => unknown): Hono {
	process.env.CONVEX_URL_INTERNAL = "https://internal.example.convex.cloud";
	_setInternalClientForTest({
		query: async (name: string) => provider(name),
		mutation: async (name: string) => {
			throw new Error(`unmocked mutation: ${name}`);
		},
	} as unknown as Parameters<typeof _setInternalClientForTest>[0]);
	const a = new Hono();
	a.use("*", bearerAuthMiddleware());
	a.get("/echo", (c) =>
		c.json({ ctx: (c.get("oauthContext") as OAuthContext | undefined) ?? null }),
	);
	return a;
}

const get = (a: Hono) =>
	a.request("http://localhost/echo", {
		headers: { Authorization: `Bearer ${RAW}` },
	});

beforeEach(() => _setInternalClientForTest(null));

describe("bearer judged by cloud-identity", () => {
	it("PRESENT: a live row passes and carries the agent ID", async () => {
		const res = await get(
			appWith((n) => (n === "oauth:getAccessTokenByHash" ? row() : null)),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ctx: OAuthContext };
		expect(body.ctx.seatAgent?.agentId).toBe("agent-clio-a");
	});

	it("DENY: an expired row handed back by an older provider is refused", async () => {
		const res = await get(
			appWith((n) =>
				n === "oauth:getAccessTokenByHash"
					? row({ expiresAt: Date.now() - 1000 })
					: null,
			),
		);
		expect(res.status).toBe(401);
	});

	it("DENY: an unknown digest is refused", async () => {
		const res = await get(appWith(() => null));
		expect(res.status).toBe(401);
	});
});

describe("list_tasks gate follows the agent ID of a seat token", () => {
	const ctx = (over: Partial<OAuthContext> = {}): OAuthContext => ({
		clientId: "seat-client",
		userId: "seat",
		scopes: ["mcp:full"],
		scopeProfile: "clio-org-a",
		fromAllowList: ["clio"],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 1000,
		isMaster: false,
		accessTokenHash: "h",
		clerkOrgSlug: "org-a",
		seatAgent: { agentId: "agent-clio-a", orgId: "org-a", agentName: "clio-2" },
		...over,
	});

	it("PRESENT: the agent's current label passes (the allowlist snapshot is stale after a rename)", () => {
		expect(listTasksGate(ctx(), "clio-2", undefined)).toBeNull();
	});

	it("DENY: the stale allowlist name no longer passes", () => {
		expect(listTasksGate(ctx(), "clio", undefined)).toMatch(/Forbidden/);
	});

	it("DENY: another agent's label is Forbidden", () => {
		expect(listTasksGate(ctx(), "eta", undefined)).toMatch(/Forbidden/);
	});

	it("DENY: a stamp naming another org's agent is ignored, the allowlist rule applies", () => {
		const foreign = ctx({
			seatAgent: { agentId: "agent-clio-b", orgId: "org-b", agentName: "clio-2" },
		});
		expect(listTasksGate(foreign, "clio", undefined)).toBeNull();
		expect(listTasksGate(foreign, "clio-2", undefined)).toMatch(/Forbidden/);
	});
});
