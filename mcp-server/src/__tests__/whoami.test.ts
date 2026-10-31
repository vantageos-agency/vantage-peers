/**
 * whoami names the acting agent by its stored ID, never by a name alone
 * (task k174qcs0nj4qjjcw5ad50605ch8hb4jh; identity = agent ID, operator
 * 2026-10-31). `actor.agentId` / `actor.orgId` sit beside the display name;
 * when no agent is resolved, `agent_id` is null and `agent_unresolved_reason`
 * says why.
 *
 * Runs the REAL McpServer through an in-memory transport so the SDK validates
 * `structuredContent` against the declared outputSchema.
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../auth.js";
import { registerTools } from "../tools.js";

const HELIOS = "r57d7scvxejmb6fbdpxxx32ndn8fcnat";

function ctx(over: Partial<OAuthContext>): OAuthContext {
	return {
		clientId: "client-1",
		userId: "user_3KrDIUId3qN4ANWphSicL6RsSHr",
		scopes: ["mcp:full"],
		scopeProfile: "team-member",
		fromAllowList: [],
		namespaceReadPrefixes: ["team/iris-rh"],
		namespaceWritePrefixes: ["team/iris-rh"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
		accessTokenHash: "a".repeat(64),
		clerkOrgSlug: "iris-rh",
		...over,
	};
}

async function whoami(oauthCtx: OAuthContext) {
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
	const res = await client.callTool({ name: "whoami", arguments: {} });
	await client.close();
	expect(res.isError).toBeFalsy();
	return res.structuredContent as Record<string, unknown>;
}

describe("whoami returns the acting agent's ID", () => {
	it("a person token that designates hélios: actor.agentId is hélios's row ID", async () => {
		const out = await whoami(
			ctx({
				principal: "person",
				actor: { orgSlug: "iris-rh", agentName: "hélios", agentId: HELIOS },
			}),
		);
		expect(out.actor).toEqual({
			agentId: HELIOS,
			orgId: "iris-rh",
			agentName: "hélios",
			orgSlug: "iris-rh",
		});
		expect(out.agent_id).toBe(HELIOS);
		expect(out.agent_unresolved_reason).toBeNull();
	});

	it("a one-agent seat: the stamped seat agent is the acting agent", async () => {
		const out = await whoami(
			ctx({
				seatAgent: { agentId: HELIOS, orgId: "iris-rh", agentName: "hélios" },
			}),
		);
		expect(out.agent_id).toBe(HELIOS);
		expect((out.actor as { agentId: string }).agentId).toBe(HELIOS);
	});

	it("a credential-verified actor whose ID the backend did not return: agentId null, reason named", async () => {
		const out = await whoami(
			ctx({ actor: { orgSlug: "iris-rh", agentName: "hélios" } }),
		);
		expect((out.actor as { agentId: unknown }).agentId).toBeNull();
		expect(out.agent_id).toBeNull();
		expect(out.agent_unresolved_reason).toBe("actor-without-agent-id");
	});

	it("a person that designates no agent: no actor, reason named (never a name alone)", async () => {
		const out = await whoami(ctx({ principal: "person" }));
		expect(out.actor).toBeNull();
		expect(out.agent_id).toBeNull();
		expect(out.agent_unresolved_reason).toBe("person-designates-no-agent");
	});

	it("an org-level seat (seatAgent null): reason named", async () => {
		const out = await whoami(ctx({ seatAgent: null }));
		expect(out.agent_id).toBeNull();
		expect(out.agent_unresolved_reason).toBe("org-level-seat-no-agent");
	});

	it("a seat stamped with another org's agent: no agent ID, reason named (whoami never names an agent the server does not act as)", async () => {
		const out = await whoami(
			ctx({
				seatAgent: {
					agentId: "rForeignAgent0000000000000000000",
					orgId: "other-org",
					agentName: "clio",
				},
			}),
		);
		expect(out.actor).toBeNull();
		expect(out.agent_id).toBeNull();
		expect(out.agent_unresolved_reason).toBe("seat-agent-not-in-token-org");
	});

	it("a credential actor and a seat stamp together: the credential actor wins", async () => {
		const out = await whoami(
			ctx({
				actor: { orgSlug: "iris-rh", agentName: "hélios", agentId: HELIOS },
				seatAgent: {
					agentId: "rSeatAgent00000000000000000000000",
					orgId: "iris-rh",
					agentName: "clio",
				},
			}),
		);
		expect(out.agent_id).toBe(HELIOS);
		expect((out.actor as { agentName: string }).agentName).toBe("hélios");
	});

	it("the master bearer without a credential: reason names the missing credential", async () => {
		const out = await whoami(
			ctx({ isMaster: true, clerkOrgSlug: undefined, scopeProfile: "master" }),
		);
		expect(out.agent_id).toBeNull();
		expect(out.agent_unresolved_reason).toBe("no-agent-credential-presented");
	});
});
