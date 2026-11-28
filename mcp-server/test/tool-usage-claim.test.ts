/**
 * get_tool_usage -> toolUsage:getToolUsage and get_owner_tool_usage -> toolUsage:usageByOwner carry
 * a claim the door admits, per caller class (task k174spsjex627qrkvtfc703x598jvyt1; VantagePeers
 * Cloud + Self-host).
 *
 * Backend half: PR #1764 (contract 30) makes both doors admit `verifiedActor` of an operator-org
 * agent; a fleet service account with no claim stays refused (RBAC_DENIED
 * claimless-service-account). The master bearer resolves no verifiedOrg, so a master seat reached
 * these doors with no claim. Per caller class, the args that reach the fake Convex query:
 *   master + verified agent ID, no orgSlug -> verifiedActor, no verifiedOrg
 *   master + verified agent ID, orgSlug    -> verifiedOrg only (the two claims never travel together)
 *   client-org seat                        -> verifiedOrg, never an actor
 *   Clerk-JWT session                      -> no actor (its own session identity is the claim)
 *   master with no agent ID                -> no actor: nothing true to forward
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
import { MASTER_ACTOR_CLAIM_DOORS } from "../src/verifiedActor.js";

const OPS_AGENT = "agentdedale00000000000000000001";
const CLIO_ID = "agentclio0000000000000000000001";
const ORG = "acme-hr";
const OPS_ORG = "vantage";
const OWNER = "user_owner000000000000000000001";

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
const MASTER_AGENT: OAuthContext = {
	...base,
	scopeProfile: "master",
	isMaster: true,
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	actor: { orgSlug: OPS_ORG, agentName: "dedale", agentId: OPS_AGENT },
};
const MASTER_PLAIN: OAuthContext = { ...MASTER_AGENT, actor: undefined };
const CLIENT_SEAT: OAuthContext = {
	...base,
	clerkOrgSlug: ORG,
	seatAgent: { agentId: CLIO_ID, orgId: ORG, agentName: "clio" },
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

const DOORS = {
	get_tool_usage: { door: "toolUsage:getToolUsage", args: {} },
	get_owner_tool_usage: {
		door: "toolUsage:usageByOwner",
		args: { ownerUserId: OWNER },
	},
} as const;
type ToolName = keyof typeof DOORS;

async function call(
	tool: ToolName,
	ctx: OAuthContext,
	extra: Record<string, unknown> = {},
) {
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
			return [];
		});
	const client = {
		query: make("query"),
		mutation: make("mutation"),
		action: make("action"),
	};
	// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
	registerTools(server, client as any, ctx);
	const handler = tools.get(tool);
	if (!handler) throw new Error(`${tool} was not registered`);
	const r = await handler({ ...DOORS[tool].args, ...extra });
	const doorCalls = calls.filter((c) => c.name === DOORS[tool].door);
	return {
		doorCalls,
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

describe("the two tool-usage doors are master actor-claim doors", () => {
	it("MASTER_ACTOR_CLAIM_DOORS holds toolUsage:getToolUsage and toolUsage:usageByOwner", () => {
		expect(MASTER_ACTOR_CLAIM_DOORS.has("toolUsage:getToolUsage")).toBe(true);
		expect(MASTER_ACTOR_CLAIM_DOORS.has("toolUsage:usageByOwner")).toBe(true);
	});
});

for (const tool of Object.keys(DOORS) as ToolName[]) {
	describe(`${tool} claim per caller class`, () => {
		it("master bearer with a verified agent ID forwards verifiedActor and no verifiedOrg", async () => {
			const r = await call(tool, MASTER_AGENT);
			expect(r.refused, r.text).toBe(false);
			expect(r.doorCalls).toHaveLength(1);
			expect(r.doorCalls[0].args.verifiedActor).toEqual({
				agentId: OPS_AGENT,
				orgSlug: OPS_ORG,
			});
			expect(r.doorCalls[0].args).not.toHaveProperty("verifiedOrg");
		});

		it("master bearer naming an organisation forwards verifiedOrg only, never beside an actor", async () => {
			const r = await call(tool, MASTER_AGENT, { orgSlug: ORG });
			expect(r.refused, r.text).toBe(false);
			expect(r.doorCalls[0].args.verifiedOrg).toEqual({ orgSlug: ORG });
			expect(r.doorCalls[0].args).not.toHaveProperty("verifiedActor");
		});

		it("client-org seat forwards verifiedOrg, never an actor", async () => {
			const r = await call(tool, CLIENT_SEAT);
			expect(r.refused, r.text).toBe(false);
			expect(r.doorCalls[0].args.verifiedOrg).toEqual({ orgSlug: ORG });
			expect(r.doorCalls[0].args).not.toHaveProperty("verifiedActor");
		});

		it("Clerk-JWT session forwards no actor", async () => {
			const r = await call(tool, CLERK_SESSION);
			expect(r.refused, r.text).toBe(false);
			expect(r.doorCalls[0].args).not.toHaveProperty("verifiedActor");
		});

		it("master bearer with no agent ID forwards no actor: nothing true to send", async () => {
			const r = await call(tool, MASTER_PLAIN);
			expect(r.doorCalls[0].args).not.toHaveProperty("verifiedActor");
			expect(r.doorCalls[0].args).not.toHaveProperty("verifiedOrg");
		});
	});
}

// ── get_tool_usage: a master seat reads its own usage with no argument ───────────────────
//
// The door reads a trusted call with no selfKey as an organisation admin, and with no caller
// it has no target ("caller-unidentified"). masterSelfReadKey sends `selfKey: agent:<id>` on
// exactly the call that is refused today, and nowhere it would end the admin reading.
describe("get_tool_usage selfKey for a master bearer", () => {
	it("master with a verified agent ID, no caller, no orgSlug: selfKey agent:<its ID>", async () => {
		const r = await call("get_tool_usage", MASTER_AGENT);
		expect(r.refused, r.text).toBe(false);
		expect(r.doorCalls[0].args.selfKey).toBe(`agent:${OPS_AGENT}`);
		expect(r.doorCalls[0].args).not.toHaveProperty("caller");
	});
	it("master naming a caller keeps the admin read: no selfKey, the caller is sent", async () => {
		const r = await call("get_tool_usage", MASTER_AGENT, {
			caller: `agent:${CLIO_ID}`,
		});
		expect(r.doorCalls[0].args).not.toHaveProperty("selfKey");
		expect(r.doorCalls[0].args.caller).toBe(`agent:${CLIO_ID}`);
	});
	it("master naming an organisation: no selfKey (its agent is not in that organisation)", async () => {
		const r = await call("get_tool_usage", MASTER_AGENT, { orgSlug: ORG });
		expect(r.doorCalls[0].args).not.toHaveProperty("selfKey");
	});
	it("master with no agent ID: no selfKey, nothing true to send", async () => {
		const r = await call("get_tool_usage", MASTER_PLAIN);
		expect(r.doorCalls[0].args).not.toHaveProperty("selfKey");
	});
	it("get_owner_tool_usage from a master keeps no selfKey (the owner read stays an admin read)", async () => {
		const r = await call("get_owner_tool_usage", MASTER_AGENT);
		expect(r.doorCalls[0].args).not.toHaveProperty("selfKey");
	});
	it("a client seat keeps the selfKey it already sends (its own agent)", async () => {
		const r = await call("get_tool_usage", CLIENT_SEAT);
		expect(r.doorCalls[0].args.selfKey).toBe(`agent:${CLIO_ID}`);
	});
	it("a Clerk-JWT session sends no selfKey", async () => {
		const r = await call("get_tool_usage", CLERK_SESSION);
		expect(r.doorCalls[0].args).not.toHaveProperty("selfKey");
	});
});
