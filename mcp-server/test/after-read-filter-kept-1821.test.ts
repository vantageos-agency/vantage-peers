/**
 * The after-read scope filters on the three doors #1821 (contract 37) moved to
 * `verifiedOrg` (VantagePeers Cloud + Self-host, MCP server).
 *
 * `memories:listMemories`, `profiles:getProfile` and `fixPatterns:get` now decide the
 * caller's verified org inside the read. Each MCP site still applies
 * `scopeFilterList` / `scopeFilterGet` after the read. A filter may only go where the
 * door enforces everything it enforces, for every caller class. These pins state,
 * per site and per caller class, what the door receives and what the tool answers
 * when the door hands back a row the filter still guards against:
 *
 *   list_memories / list_episodes  the door narrows by org; a namespace admitted as the
 *                                   org's team namespace (not a read prefix) is still
 *                                   narrowed to rows whose creator is on the roster.
 *   get_profile                     the door checks the ORG roster, and nothing for a
 *                                   bearer with no org; the bearer's own roster can be
 *                                   narrower.
 *   get_fix_pattern                 with a verifiedActor the door judges the creator by
 *                                   agent ID and does not consult callerIdentities; the
 *                                   creator's label must still be on the roster.
 *
 * Caller classes: MEMBER (non-master bearer with a verified org and a seat agent),
 * MASTER, CLERK (a Clerk session), NO_ORG (non-master bearer, no resolvable org).
 */

import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

const ORG = "acme-hr";
const ORG_ID = "org_AAAA";
const CLIO_ID = "agentclio0000000000000000000001";
const TEAM_NS = `team/${ORG_ID}`;
const PATTERN_ID = "m974tpxzvq7q13ydqhx6w7abtx89n77q";

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
const MEMBER: OAuthContext = {
	...base,
	clerkOrgSlug: ORG,
	orgClerkId: ORG_ID,
	seatAgent: { agentId: CLIO_ID, orgId: ORG, agentName: "clio" },
};
const MASTER: OAuthContext = {
	...base,
	scopeProfile: "master",
	isMaster: true,
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
};
const CLERK: OAuthContext = {
	...base,
	accessTokenHash: undefined,
	clerkJwt: "eyJ.raw.clerk",
	clerkOrgSlug: ORG,
	namespaceReadPrefixes: [`team/${ORG}`, `project/${ORG}`],
	namespaceWritePrefixes: [`team/${ORG}`],
};
const NO_ORG: OAuthContext = { ...base };

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
type Result = {
	isError?: boolean;
	content?: Array<{ text?: string }>;
	structuredContent?: Record<string, unknown>;
};

async function run(
	ctx: OAuthContext,
	tool: string,
	door: string,
	answer: unknown,
	args: Record<string, unknown>,
) {
	const handlers = new Map<string, ToolHandler>();
	const capture = (...a: unknown[]): unknown => {
		handlers.set(a[0] as string, a[a.length - 1] as ToolHandler);
		return {};
	};
	const server = {
		tool: capture,
		registerTool: capture,
	} as unknown as McpServer;
	const doorCalls: Array<Record<string, unknown>> = [];
	const query = vi.fn(async (name: string, a: Record<string, unknown>) => {
		if (name === door) {
			doorCalls.push(a);
			return answer;
		}
		return null;
	});
	registerTools(
		server,
		{
			query,
			mutation: vi.fn(),
			action: vi.fn(),
		} as unknown as ConvexHttpClient,
		ctx,
	);
	const handler = handlers.get(tool);
	if (!handler) throw new Error(`${tool} was not registered`);
	const result = (await handler(args)) as Result;
	return {
		doorCalls,
		result,
		text: result.content?.[0]?.text ?? "",
		refused: result.isError === true,
	};
}

// ── list_memories / list_episodes -> memories:listMemories ──────────────────

const memoryRow = (n: number, createdBy: string, namespace: string) => ({
	_id: `mem${String(n).padStart(29, "0")}`,
	_creationTime: 1_780_000_000_000 + n,
	namespace,
	type: "episode",
	content: `content-of-${createdBy}`,
	createdBy,
	isLatest: true,
});
const page = (namespace: string) => ({
	value: [
		memoryRow(1, "clio", namespace),
		memoryRow(2, "person:bob", namespace),
	],
	continueCursor: null,
	isDone: true,
});
const creators = (r: Result): string[] =>
	((r.structuredContent?.items as Array<{ createdBy: string }>) ?? []).map(
		(m) => m.createdBy,
	);

for (const tool of ["list_memories", "list_episodes"] as const) {
	const door = "memories:listMemories";
	describe(`${tool} -> ${door}: after-read filter kept, per caller class`, () => {
		it("MEMBER in its org's team namespace: the door receives verifiedOrg and verifiedActor; an off-roster creator's row is not served", async () => {
			const r = await run(MEMBER, tool, door, page(TEAM_NS), {
				namespace: TEAM_NS,
			});
			expect(r.refused, r.text).toBe(false);
			expect(r.doorCalls).toHaveLength(1);
			expect(r.doorCalls[0].verifiedOrg).toEqual({
				orgSlug: ORG,
				orgId: ORG_ID,
			});
			expect(r.doorCalls[0].verifiedActor).toEqual({
				agentId: CLIO_ID,
				orgSlug: ORG,
			});
			expect(creators(r.result)).toEqual(["clio"]);
			expect(r.text).not.toContain("content-of-person:bob");
		});

		it("MASTER: the door receives no claim; every row the door returns is served", async () => {
			const r = await run(MASTER, tool, door, page(TEAM_NS), {
				namespace: TEAM_NS,
			});
			expect(r.refused, r.text).toBe(false);
			expect(r.doorCalls[0]).not.toHaveProperty("verifiedOrg");
			expect(r.doorCalls[0]).not.toHaveProperty("verifiedActor");
			expect(creators(r.result)).toEqual(["clio", "person:bob"]);
		});

		it("CLERK in a read-prefix namespace: the door receives no claim (its own session); every row is served", async () => {
			const ns = `team/${ORG}`;
			const r = await run(CLERK, tool, door, page(ns), { namespace: ns });
			expect(r.refused, r.text).toBe(false);
			expect(r.doorCalls[0]).not.toHaveProperty("verifiedOrg");
			expect(r.doorCalls[0]).not.toHaveProperty("verifiedActor");
			expect(creators(r.result)).toEqual(["clio", "person:bob"]);
		});

		it("NO_ORG in a read-prefix namespace: the door receives no claim; every row of that namespace is served", async () => {
			const ns = "orchestrator/clio";
			const r = await run(NO_ORG, tool, door, page(ns), { namespace: ns });
			expect(r.refused, r.text).toBe(false);
			expect(r.doorCalls[0]).not.toHaveProperty("verifiedOrg");
			expect(r.doorCalls[0]).not.toHaveProperty("verifiedActor");
			expect(creators(r.result)).toEqual(["clio", "person:bob"]);
		});

		it("NO_ORG outside its read prefixes: refused before the door", async () => {
			const r = await run(NO_ORG, tool, door, page(TEAM_NS), {
				namespace: TEAM_NS,
			});
			expect(r.refused).toBe(true);
			expect(r.doorCalls).toHaveLength(0);
		});
	});
}

// ── get_profile -> profiles:getProfile ──────────────────────────────────────

const profile = (orchestratorId: string) => ({
	_id: `profile-${orchestratorId}`,
	_creationTime: 1_780_000_000_000,
	orchestratorId,
	instanceId: `${orchestratorId}-vps`,
	name: orchestratorId,
	static: {
		role: "engineer",
		workspace: `/root/${orchestratorId}`,
		capabilities: [],
	},
	dynamic: { lastSeen: 1_780_000_000_000, sessionCount: 1 },
});
const found = (r: Result) =>
	r.structuredContent as { found: boolean; item?: { orchestratorId?: string } };

describe("get_profile -> profiles:getProfile: after-read filter kept, per caller class", () => {
	const tool = "get_profile";
	const door = "profiles:getProfile";

	it("MEMBER: the door receives verifiedOrg and verifiedActor; a profile on the org roster but not the bearer's is not served", async () => {
		const r = await run(MEMBER, tool, door, profile("eta"), {
			orchestratorId: "eta",
		});
		expect(r.refused, r.text).toBe(false);
		expect(r.doorCalls[0].verifiedOrg).toEqual({ orgSlug: ORG, orgId: ORG_ID });
		expect(r.doorCalls[0].verifiedActor).toEqual({
			agentId: CLIO_ID,
			orgSlug: ORG,
		});
		expect(found(r.result)).toEqual({ found: false, id: "eta" });
	});

	it("MEMBER: a profile on the bearer's roster is served, without the synthetic createdBy", async () => {
		const r = await run(MEMBER, tool, door, profile("clio"), {
			orchestratorId: "clio",
		});
		expect(found(r.result).found).toBe(true);
		expect(found(r.result).item?.orchestratorId).toBe("clio");
		expect(found(r.result).item).not.toHaveProperty("createdBy");
	});

	it("MASTER: the door receives no claim; the profile is served", async () => {
		const r = await run(MASTER, tool, door, profile("eta"), {
			orchestratorId: "eta",
		});
		expect(r.doorCalls[0]).not.toHaveProperty("verifiedOrg");
		expect(r.doorCalls[0]).not.toHaveProperty("verifiedActor");
		expect(found(r.result).item?.orchestratorId).toBe("eta");
	});

	it("CLERK: the door receives no claim (its own session); an off-roster profile is not served", async () => {
		const r = await run(CLERK, tool, door, profile("eta"), {
			orchestratorId: "eta",
		});
		expect(r.doorCalls[0]).not.toHaveProperty("verifiedOrg");
		expect(r.doorCalls[0]).not.toHaveProperty("verifiedActor");
		expect(found(r.result)).toEqual({ found: false, id: "eta" });
	});

	it("NO_ORG: the door receives no claim and reads as the service account; an off-roster profile is not served", async () => {
		const r = await run(NO_ORG, tool, door, profile("eta"), {
			orchestratorId: "eta",
		});
		expect(r.doorCalls[0]).not.toHaveProperty("verifiedOrg");
		expect(r.doorCalls[0]).not.toHaveProperty("verifiedActor");
		expect(found(r.result)).toEqual({ found: false, id: "eta" });
	});
});

// ── get_fix_pattern -> fixPatterns:get ──────────────────────────────────────

const pattern = (createdBy: string) => ({
	_id: PATTERN_ID,
	_creationTime: 1,
	symptom: `symptom-of-${createdBy}`,
	rootCause: "rc",
	tags: [],
	stack: [],
	sourceProject: "p",
	createdBy,
	severity: "minor",
	createdAt: 1,
	updatedAt: 1,
	attempts: [],
});

describe("get_fix_pattern -> fixPatterns:get: after-read filter kept, per caller class", () => {
	const tool = "get_fix_pattern";
	const door = "fixPatterns:get";

	it("MEMBER: the door receives verifiedOrg, verifiedActor and callerIdentities; a row whose creator label is off the roster is REFUSED", async () => {
		// The door judged the creator by agent ID (callerIdentities not consulted)
		// and returned the row; its label is not on the bearer's roster.
		const r = await run(MEMBER, tool, door, pattern("eta"), {
			patternId: PATTERN_ID,
		});
		expect(r.doorCalls[0].verifiedOrg).toEqual({ orgSlug: ORG, orgId: ORG_ID });
		expect(r.doorCalls[0].verifiedActor).toEqual({
			agentId: CLIO_ID,
			orgSlug: ORG,
		});
		expect(r.doorCalls[0].callerIdentities).toEqual(["clio"]);
		expect(r.refused).toBe(true);
		expect(r.text).toContain("REFUSED (RBAC_DENIED)");
		expect(r.text).not.toContain("symptom-of-eta");
	});

	it("MEMBER: its own pattern is served", async () => {
		const r = await run(MEMBER, tool, door, pattern("clio"), {
			patternId: PATTERN_ID,
		});
		expect(r.refused, r.text).toBe(false);
		expect(r.text).toContain("symptom-of-clio");
	});

	it("MASTER: the door receives no claim and no roster; the pattern is served", async () => {
		const r = await run(MASTER, tool, door, pattern("eta"), {
			patternId: PATTERN_ID,
		});
		expect(r.doorCalls[0]).not.toHaveProperty("verifiedOrg");
		expect(r.doorCalls[0]).not.toHaveProperty("verifiedActor");
		expect(r.doorCalls[0]).not.toHaveProperty("callerIdentities");
		expect(r.refused, r.text).toBe(false);
		expect(r.text).toContain("symptom-of-eta");
	});

	it("CLERK: the door receives the roster as callerIdentities, no actor, no verifiedOrg; a roster pattern is served", async () => {
		const r = await run(CLERK, tool, door, pattern("clio"), {
			patternId: PATTERN_ID,
		});
		expect(r.doorCalls[0].callerIdentities).toEqual(["clio"]);
		expect(r.doorCalls[0]).not.toHaveProperty("verifiedActor");
		expect(r.doorCalls[0]).not.toHaveProperty("verifiedOrg");
		expect(r.refused, r.text).toBe(false);
		expect(r.text).toContain("symptom-of-clio");
	});

	it("NO_ORG: the door receives the roster as callerIdentities, no actor, no verifiedOrg; an off-roster pattern is REFUSED", async () => {
		const r = await run(NO_ORG, tool, door, pattern("eta"), {
			patternId: PATTERN_ID,
		});
		expect(r.doorCalls[0].callerIdentities).toEqual(["clio"]);
		expect(r.doorCalls[0]).not.toHaveProperty("verifiedActor");
		expect(r.doorCalls[0]).not.toHaveProperty("verifiedOrg");
		expect(r.refused).toBe(true);
		expect(r.text).not.toContain("symptom-of-eta");
	});
});
