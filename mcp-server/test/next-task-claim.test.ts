/**
 * next_task -> tasks:nextForAssignee carries a claim the door admits, per caller class
 * (task k178q6x954qeh4mxh0b4x6sss98jtarn; VantagePeers Cloud + Self-host).
 *
 * The door (convex/tasks.ts nextForAssignee -> requireClaimedCaller) refuses the fleet
 * service account that carries no claim (RBAC_DENIED claimless-service-account). The
 * master bearer resolves no verifiedOrg, so before this fix a master-profile seat
 * reached the door with neither claim and was refused. Per caller class, the args
 * that reach the fake Convex query:
 *   master + verified agent ID    -> verifiedActor (judged by ID as an operator-org agent), no verifiedOrg
 *   client-org seat               -> verifiedOrg only (an actor of a client org is refused by the door)
 *   Clerk-JWT session             -> neither (its own session identity is the claim)
 *   master with no agent ID       -> neither: there is nothing true to forward
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetUnattributedClaimsForTest,
	_setInternalClientForTest,
	ACTOR_CREDENTIAL_MODE_ENV,
	type OAuthContext,
} from "../src/auth.js";
import { registerTools } from "../src/tools.js";
import { withVerifiedActor } from "../src/verifiedActor.js";

const OPS_AGENT = "agentdedale00000000000000000001";
const CLIO_ID = "agentclio0000000000000000000001";
const ORG = "acme-hr";
const OPS_ORG = "vantage";

const base: OAuthContext = {
	clientId: "client-x",
	userId: "user-x",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "p",
	fromAllowList: ["clio"],
	namespaceReadPrefixes: ["orchestrator/clio"],
	namespaceWritePrefixes: ["orchestrator/clio"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	accessTokenHash: "hash-x",
};
// The master bearer with a presented agent credential: the agent ID is resolved by Convex.
const MASTER_AGENT: OAuthContext = {
	...base,
	scopeProfile: "master",
	isMaster: true,
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	actor: { orgSlug: OPS_ORG, agentName: "dedale", agentId: OPS_AGENT },
};
// The master bearer with no agent identity at all.
const MASTER_PLAIN: OAuthContext = { ...MASTER_AGENT, actor: undefined };
// A master-profile seat token of the operator organisation: its org resolves, so the
// door narrows to it with verifiedOrg and the actor is not also sent.
const MASTER_PROFILE_SEAT: OAuthContext = {
	...base,
	scopeProfile: "master",
	clerkOrgSlug: OPS_ORG,
	seatAgent: { agentId: OPS_AGENT, orgId: OPS_ORG, agentName: "dedale" },
};
const CLIENT_SEAT: OAuthContext = {
	...base,
	clerkOrgSlug: ORG,
	seatAgent: { agentId: CLIO_ID, orgId: ORG, agentName: "clio" },
};
// A master bearer carrying the credential of a CLIENT-org agent.
const MASTER_CLIENT_AGENT: OAuthContext = {
	...MASTER_AGENT,
	actor: { orgSlug: ORG, agentName: "clio", agentId: CLIO_ID },
};
const CLERK_SESSION: OAuthContext = {
	...base,
	clerkJwt: "jwt.header.payload",
	clerkOrgSlug: ORG,
	accessTokenHash: undefined,
};

type Handler = (args: Record<string, unknown>) => Promise<{
	isError?: boolean;
	content?: Array<{ text?: string }>;
}>;
type Call = { kind: string; name: string; args: Record<string, unknown> };

async function nextTask(ctx: OAuthContext) {
	const tools = new Map<string, Handler>();
	const reg = (...a: unknown[]) => {
		tools.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	const server = { tool: reg, registerTool: reg } as unknown as McpServer;
	const calls: Call[] = [];
	const make = (kind: string) =>
		vi.fn(async (name: string, a: Record<string, unknown>) => {
			calls.push({ kind, name, args: a });
			return { found: false };
		});
	const client = {
		query: make("query"),
		mutation: make("mutation"),
		action: make("action"),
	};
	// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	registerTools(server, client as any, ctx);
	const handler = tools.get("next_task");
	if (!handler) throw new Error("next_task was not registered");
	const r = await handler({ assignedToAgentId: CLIO_ID });
	return {
		calls,
		text: r.content?.[0]?.text ?? "",
		refused: r.isError === true,
	};
}

let savedMode: string | undefined;
beforeEach(() => {
	savedMode = process.env[ACTOR_CREDENTIAL_MODE_ENV];
	process.env[ACTOR_CREDENTIAL_MODE_ENV] = "permissive";
	_resetUnattributedClaimsForTest();
	vi.spyOn(console, "error").mockImplementation(() => {});
	// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	_setInternalClientForTest({ query: async () => null } as any);
});
afterEach(() => {
	if (savedMode === undefined) delete process.env[ACTOR_CREDENTIAL_MODE_ENV];
	else process.env[ACTOR_CREDENTIAL_MODE_ENV] = savedMode;
	vi.restoreAllMocks();
	_resetUnattributedClaimsForTest();
	_setInternalClientForTest(null);
});

describe("next_task claim per caller class", () => {
	it("master bearer with a verified agent ID forwards verifiedActor and no verifiedOrg", async () => {
		const r = await nextTask(MASTER_AGENT);
		expect(r.refused, r.text).toBe(false);
		expect(r.calls).toHaveLength(1);
		expect(r.calls[0].name).toBe("tasks:nextForAssignee");
		expect(r.calls[0].args).toEqual({
			assignedToAgentId: CLIO_ID,
			verifiedActor: { agentId: OPS_AGENT, orgSlug: OPS_ORG },
		});
	});

	it("client-org seat forwards verifiedOrg only, never an actor", async () => {
		const r = await nextTask(CLIENT_SEAT);
		expect(r.refused, r.text).toBe(false);
		expect(r.calls[0].args).toEqual({
			assignedToAgentId: CLIO_ID,
			verifiedOrg: { orgSlug: ORG },
		});
		expect(r.calls[0].args).not.toHaveProperty("verifiedActor");
	});

	it("master-profile operator seat forwards verifiedOrg only (the org resolves, no second claim)", async () => {
		const r = await nextTask(MASTER_PROFILE_SEAT);
		expect(r.refused, r.text).toBe(false);
		expect(r.calls[0].args).toEqual({
			assignedToAgentId: CLIO_ID,
			verifiedOrg: { orgSlug: OPS_ORG },
		});
	});

	it("master bearer carrying a client-org agent forwards that agent ID: the door judges it and refuses loudly", async () => {
		// The MCP does not know which organisation is the operator's; the door does
		// (requireFleetAgentActor). A refusal by ID is loud; an absent claim would be
		// the claimless-service-account refusal and would name the wrong cause.
		const r = await nextTask(MASTER_CLIENT_AGENT);
		expect(r.calls[0].args).toEqual({
			assignedToAgentId: CLIO_ID,
			verifiedActor: { agentId: CLIO_ID, orgSlug: ORG },
		});
	});

	it("Clerk-JWT session forwards no claim (its own session identity is the claim)", async () => {
		const r = await nextTask(CLERK_SESSION);
		expect(r.refused, r.text).toBe(false);
		expect(r.calls[0].args).toEqual({ assignedToAgentId: CLIO_ID });
	});

	it("master bearer with no agent ID forwards no claim: nothing true to send", async () => {
		const r = await nextTask(MASTER_PLAIN);
		expect(r.calls[0].args).toEqual({ assignedToAgentId: CLIO_ID });
	});
});

describe("next_task master-only actor claim (withVerifiedActor)", () => {
	it("a non-master bearer with a verified actor never sends verifiedActor on tasks:nextForAssignee, even with no verifiedOrg in the args", async () => {
		// Unreachable through registerTools today (a non-master actor always resolves its
		// own verifiedOrg), so the guard is pinned directly on the wrapper: the master-only
		// claim must not widen a scoped bearer into an operator-agent claim.
		const NON_MASTER_ACTOR: OAuthContext = {
			...base,
			actor: { orgSlug: ORG, agentName: "clio", agentId: CLIO_ID },
		};
		const seen: Array<Record<string, unknown>> = [];
		const client = {
			mutation: vi.fn(async () => null),
			query: vi.fn(async (_n: string, a: Record<string, unknown>) => {
				seen.push(a);
				return { found: false };
			}),
		};
		// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
		await (withVerifiedActor(client as any, NON_MASTER_ACTOR) as any).query(
			"tasks:nextForAssignee",
			{ assignedToAgentId: CLIO_ID },
		);
		expect(seen).toEqual([{ assignedToAgentId: CLIO_ID }]);
	});
});
