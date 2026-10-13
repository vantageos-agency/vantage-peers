/**
 * The agent's human OWNER crosses the MCP boundary as a fact Convex PROVED, never
 * as something this server decides (task k1778c2hvae8e8vz9f5bbbbbb98g62hw, RULE
 * #24 mirror of the `agents.ownerPersonId` / `agent_credentials.ownerPersonId` /
 * `oauth_access_tokens.ownerPersonId` schema change).
 *
 * Convex resolves the credential or the seat token through
 * @vantageos/cloud-identity `resolveCallerFromAgentCredential` and answers with
 * the owner only when the package proved it (convex/lib/__tests__/agentOwner.test.ts
 * pins the REFUSED / ACCEPTED / ABSENT poles there). Here:
 *
 *   FORWARDED  a credential lookup that carries `ownerPersonId` reaches `actor`.
 *   ABSENT     a lookup that carries none leaves `actor` without the key.
 *   SEAT       a seat token's `seatAgent.ownerPersonId` survives `seatAgentOf`.
 *   REFUSED    a credential Convex refuses for its owner is a 401, never an
 *              org-only caller (the door RAISES RBAC_DENIED naming the owner reason).
 */

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetUnattributedClaimsForTest,
	_setInternalClientForTest,
	bearerAuthMiddleware,
	type OAuthContext,
	seatAgentOf,
	sha256Hex,
} from "../../auth";

const HEADER = "x-vantage-agent-credential";
const TEAM = "team-token-owner";
const SEAT = "seat-token-owner";
const AGENT_ID = "agentclio0000000000000000000001";
const ORG_ID = "org_IRIS1";

let credentialAnswer: Record<string, unknown> | "refuse-owner" | null = null;
const rows: Record<string, Record<string, unknown>> = {};

function installInternalClient(): void {
	const fake = {
		query: async (name: string, args: unknown) => {
			if (name === "oauth:getAccessTokenByHash") {
				return rows[(args as { tokenHash: string }).tokenHash] ?? null;
			}
			if (name === "agentCredentials:resolveAgentCredential") {
				if (credentialAnswer === "refuse-owner") {
					throw Object.assign(new Error("[Request ID: x] Server Error"), {
						data: `RBAC_DENIED: the presented agent credential does not resolve to an active agent for "agentCredentials:resolveAgentCredential" — {"reason":"agent-owner-not-member"}`,
					});
				}
				if (credentialAnswer !== null) return credentialAnswer;
				throw new Error("unmocked answer");
			}
			throw new Error(`unmocked query: ${name}`);
		},
		mutation: async (name: string) => {
			throw new Error(`unmocked mutation: ${name}`);
		},
	};
	// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	_setInternalClientForTest(fake as any);
}

function app(): Hono {
	const a = new Hono();
	a.use("*", bearerAuthMiddleware());
	a.get("/whoami", (c) => {
		const ctx = c.get("oauthContext") as OAuthContext;
		return c.json({ actor: ctx.actor ?? null, seat: seatAgentOf(ctx) ?? null });
	});
	return a;
}

async function whoami(bearer: string, credential?: string) {
	const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
	if (credential !== undefined) headers[HEADER] = credential;
	const res = await app().request("http://localhost/whoami", { headers });
	return {
		status: res.status,
		body: (await res.json().catch(() => ({}))) as {
			actor?: Record<string, unknown> | null;
			seat?: Record<string, unknown> | null;
		},
	};
}

beforeEach(async () => {
	credentialAnswer = null;
	_resetUnattributedClaimsForTest();
	vi.spyOn(console, "error").mockImplementation(() => {});
	process.env.CONVEX_URL_INTERNAL = "https://internal.example.convex.cloud";
	const base = {
		userId: "user-x",
		scopes: ["vantage:read", "vantage:write"],
		expiresAt: Date.now() + 3_600_000,
		clerkOrgSlug: "iris-rh",
		clerkOrgId: ORG_ID,
	};
	rows[await sha256Hex(TEAM)] = {
		...base,
		clientId: "team-client",
		scopeProfile: "team-member",
		fromAllowList: ["alice", "clio"],
		namespaceReadPrefixes: ["team/iris-rh"],
		namespaceWritePrefixes: ["team/iris-rh"],
	};
	rows[await sha256Hex(SEAT)] = {
		...base,
		clientId: "seat-client",
		scopeProfile: "clio-iris-rh",
		fromAllowList: ["clio"],
		namespaceReadPrefixes: ["orchestrator/clio"],
		namespaceWritePrefixes: ["orchestrator/clio"],
		seatAgent: {
			agentId: AGENT_ID,
			orgId: "iris-rh",
			agentName: "clio",
			orgClerkId: ORG_ID,
			ownerPersonId: "person-1",
		},
	};
	installInternalClient();
});

afterEach(() => {
	vi.restoreAllMocks();
	_resetUnattributedClaimsForTest();
	_setInternalClientForTest(null);
});

describe("the owner Convex proved is forwarded, never decided here", () => {
	it("FORWARDED: a credential lookup carrying ownerPersonId reaches the actor", async () => {
		credentialAnswer = {
			orgSlug: "iris-rh",
			agentName: "clio",
			agentId: AGENT_ID,
			ownerPersonId: "person-1",
		};
		const r = await whoami(TEAM, "secret-clio");
		expect(r.status).toBe(200);
		expect(r.body.actor).toEqual({
			orgSlug: "iris-rh",
			agentName: "clio",
			agentId: AGENT_ID,
			ownerPersonId: "person-1",
		});
	});

	it("ABSENT: a lookup carrying no owner leaves the actor without the key", async () => {
		credentialAnswer = {
			orgSlug: "iris-rh",
			agentName: "clio",
			agentId: AGENT_ID,
		};
		const r = await whoami(TEAM, "secret-clio");
		expect(r.status).toBe(200);
		expect(r.body.actor).not.toHaveProperty("ownerPersonId");
	});

	it("SEAT: a seat token's owner survives seatAgentOf", async () => {
		const r = await whoami(SEAT);
		expect(r.status).toBe(200);
		expect(r.body.seat).toMatchObject({
			agentId: AGENT_ID,
			ownerPersonId: "person-1",
		});
	});

	it("REFUSED: a credential Convex refuses for its owner is a 401, never an org-only caller", async () => {
		credentialAnswer = "refuse-owner";
		const r = await whoami(TEAM, "secret-clio");
		expect(r.status).toBe(401);
	});
});
