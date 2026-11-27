/**
 * S-28, tools that call a door taking `verifiedActor` forward the claim of their
 * caller, derived from the verified context, and refuse BEFORE the door when the
 * door admits no caller without one (task k1740ydgqb7bxwnftrfyskx1ch8jwtgg, batch 2;
 * VantagePeers Cloud + Self-host, MCP server).
 *
 * Per tool and caller class, the args that reach the fake Convex client:
 *   verified agent (credential or seat) -> the door receives verifiedActor {agentId, orgSlug}
 *   no claim, door refuses it           -> typed refusal, the door is never called
 * The claim comes from the oauthContext, never from a tool argument: a typed
 * verifiedActor argument is never forwarded.
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

const OPS_AGENT = "agentdedale00000000000000000001";
const CLIO_ID = "agentclio0000000000000000000001";
const ORG = "acme-hr";
const OPS_ORG = "vantage";
const ID = "j57aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
const ORG_TOKEN: OAuthContext = { ...base, clerkOrgSlug: ORG, seatAgent: null };

type Handler = (args: Record<string, unknown>) => Promise<{
	isError?: boolean;
	content?: Array<{ text?: string }>;
}>;
// The shape each door answers with, so a tool that checks its reply reaches its end.
const REPLIES: Record<string, unknown> = {
	"memories:listMemories": { value: [], continueCursor: "", isDone: true },
	"tasks:listBlockedOnMe": {
		entries: [],
		total: 0,
		truncated: false,
		oldestAge: 0,
	},
};
type Call = { kind: string; name: string; args: Record<string, unknown> };

async function call(
	tool: string,
	door: string,
	ctx: OAuthContext,
	args: Record<string, unknown>,
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
			return REPLIES[name] ?? [];
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
	const r = await handler(args);
	return {
		doorCalls: calls.filter((c) => c.name === door),
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

const OPS_CLAIM = { agentId: OPS_AGENT, orgSlug: OPS_ORG };

// Doors the tool forwards the verified agent ID to; the door also serves a caller with
// no agent ID, so the tool forwards nothing for it and refuses nothing.
const FORWARDS = [
	{
		tool: "list_episodes",
		door: "memories:listMemories",
		args: { namespace: "orchestrator/dedale" },
	},
	{
		tool: "list_memories",
		door: "memories:listMemories",
		args: { namespace: "orchestrator/dedale" },
	},
	{
		tool: "get_profile",
		door: "profiles:getProfile",
		args: { orchestratorId: "clio" },
	},
	{
		tool: "erase_memory",
		door: "memories:redactMemoryContentAsAgent",
		args: { memoryId: ID, redactions: [{ find: "x", replaceWith: "y" }] },
	},
	{
		tool: "update_briefing_note",
		door: "briefingNotes:update",
		args: { noteId: ID, callerOrchestrator: "dedale", title: "t" },
	},
	{
		tool: "create_recurring_task",
		door: "recurringTasks:create",
		args: {
			title: "t",
			assignedTo: "dedale",
			priority: "low",
			cronExpression: "0 9 * * *",
			createdBy: "dedale",
		},
	},
	{
		tool: "add_fix_attempt",
		door: "fixPatterns:addAttempt",
		args: {
			patternId: ID,
			description: "d",
			worked: true,
			why: "w",
			createdBy: "dedale",
		},
	},
	{ tool: "list_blocked_on_me", door: "tasks:listBlockedOnMe", args: {} },
] as const;

// Doors that judge their caller by the agent ID alone: no ID, no call.
const REQUIRES = [
	{
		tool: "accept_mandate",
		door: "mandates:accept",
		args: { mandateId: ID, callerOrchestrator: "dedale" },
	},
	{
		tool: "update_mandate",
		door: "mandates:update",
		args: { mandateId: ID, callerOrchestrator: "dedale", status: "accepted" },
	},
	{
		tool: "settle_mandate",
		door: "mandates:settle",
		args: { mandateId: ID, callerOrchestrator: "dedale", finalCost: 1 },
	},
	{ tool: "debate_get_room", door: "debate:getRoom", args: { roomId: ID } },
	{
		tool: "improvisation_digest",
		door: "improvisationDigest:scanWindow",
		args: { windowDays: 7 },
	},
] as const;

for (const t of [...FORWARDS, ...REQUIRES]) {
	describe(`${t.tool} -> ${t.door}`, () => {
		it("a verified agent: the door receives its verifiedActor, taken from the context", async () => {
			const r = await call(t.tool, t.door, MASTER_AGENT, {
				...t.args,
				verifiedActor: { agentId: "typed-by-caller", orgSlug: "typed" },
			});
			expect(r.doorCalls.length).toBeGreaterThan(0);
			for (const c of r.doorCalls) {
				expect(c.args.verifiedActor).toEqual(OPS_CLAIM);
			}
		});
	});
}

for (const t of REQUIRES) {
	describe(`${t.tool} refuses a caller with no verified agent ID before the door`, () => {
		it("master bearer with no agent ID: typed refusal, no door call", async () => {
			const r = await call(t.tool, t.door, MASTER_PLAIN, { ...t.args });
			expect(r.refused).toBe(true);
			expect(r.text).toContain("RBAC_DENIED");
			expect(r.text).toContain("verified-actor-required");
			expect(r.doorCalls).toHaveLength(0);
		});
	});
}

describe("list_blocked_on_me: the caller gate of this read lives in the door", () => {
	it("an org-level token that resolved no agent is sent no claim: the door refuses it", async () => {
		const r = await call(
			"list_blocked_on_me",
			"tasks:listBlockedOnMe",
			ORG_TOKEN,
			{},
		);
		expect(r.doorCalls).toHaveLength(1);
		expect(r.doorCalls[0].args).not.toHaveProperty("verifiedActor");
		expect(r.doorCalls[0].args).not.toHaveProperty("verifiedOrg");
	});

	it("a seat with an agent ID is served, with its actor and no organisation", async () => {
		const r = await call(
			"list_blocked_on_me",
			"tasks:listBlockedOnMe",
			CLIENT_SEAT,
			{},
		);
		expect(r.refused, r.text).toBe(false);
		expect(r.doorCalls[0].args.verifiedActor).toEqual({
			agentId: CLIO_ID,
			orgSlug: ORG,
		});
		expect(r.doorCalls[0].args).not.toHaveProperty("verifiedOrg");
	});
});

describe("get_fix_pattern narrows a non-master bearer by its ID, never a master seat", () => {
	const args = { patternId: ID };
	it("client seat: the door receives its verifiedActor", async () => {
		const r = await call(
			"get_fix_pattern",
			"fixPatterns:get",
			CLIENT_SEAT,
			args,
		);
		expect(r.doorCalls).toHaveLength(1);
		expect(r.doorCalls[0].args.verifiedActor).toEqual({
			agentId: CLIO_ID,
			orgSlug: ORG,
		});
	});
	it("master bearer with an agent ID: no actor (the master reads every pattern)", async () => {
		const r = await call(
			"get_fix_pattern",
			"fixPatterns:get",
			MASTER_AGENT,
			args,
		);
		expect(r.doorCalls).toHaveLength(1);
		expect(r.doorCalls[0].args).not.toHaveProperty("verifiedActor");
	});
});

describe("tasks doors reached through the scope resolver carry the org claim and the actor", () => {
	for (const t of [
		{
			tool: "block_task",
			door: "tasks:blockTask",
			args: { taskId: ID, callerOrchestrator: "clio" },
		},
		{
			tool: "add_task_dependency",
			door: "tasks:update",
			args: { taskId: ID, dependsOn: [ID], callerOrchestrator: "clio" },
		},
	] as const) {
		it(`${t.tool}: a client seat sends verifiedOrg and verifiedActor`, async () => {
			const r = await call(t.tool, t.door, CLIENT_SEAT, { ...t.args });
			expect(r.refused, r.text).toBe(false);
			expect(r.doorCalls[0].args.verifiedOrg).toMatchObject({ orgSlug: ORG });
			expect(r.doorCalls[0].args.verifiedActor).toEqual({
				agentId: CLIO_ID,
				orgSlug: ORG,
			});
		});
	}
});

describe("list_peers declares its divergence: profiles:listProfiles is sent no actor", () => {
	it("master bearer with an agent ID: the list is not narrowed by ID", async () => {
		const r = await call(
			"list_peers",
			"profiles:listProfiles",
			MASTER_AGENT,
			{},
		);
		expect(r.doorCalls).toHaveLength(1);
		expect(r.doorCalls[0].args).not.toHaveProperty("verifiedActor");
	});
});
