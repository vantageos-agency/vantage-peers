/**
 * VantagePeers Cloud, task k17425xt3tjf8qkynefppcps1d8jdk5s: a member agent lists
 * its own diary.
 *
 * Defect (client, claude.ai, 2026-11-17): list_diaries compared the filters to
 * `oauthCtx.userId` (the Clerk subject) only, while an agent's entries are written
 * under its agent NAME (createdBy = the name whoami reports as agent_name; a
 * person's entries carry 'user:<subject>'). A member agent could never list its
 * own diary: "Forbidden: list_diaries requires orchestrator='user_...'".
 *
 * Every pole runs under a NON-master identity (scope team-member); the master is
 * pinned only as the unchanged control.
 *
 *   OWN        no filter, createdBy=<agent name>, orchestrator=<agent name>,
 *              createdBy='user:<subject>', the bare subject (kept): served.
 *   DEFAULT    no filter: the call reaches Convex with createdBy = the verified
 *              agent name (a person with no agent: 'user:<subject>').
 *   OTHER      another member's name, 'user:<another subject>', or an agent name
 *              the caller does not hold: refused BEFORE any Convex call.
 *   MASTER     unchanged: no filter forwards no author.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const ORG = "immobiliere-pujol";
const SUBJECT = "user_3LHjsUgTrYlFNo2a9C4tNtxMPqo";
const OTHER_SUBJECT = "user_3OtherMemberSubject000000000";
const AGENT = "telemaque";
const OTHER_AGENT = "mentor";

const text = (result: unknown): string =>
	(result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "";
const isError = (result: unknown): boolean =>
	(result as { isError?: boolean })?.isError === true;

const base = (): OAuthContext => ({
	clientId: "client-claude-ai",
	userId: SUBJECT,
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "team-member",
	fromAllowList: [],
	namespaceReadPrefixes: [`team/${ORG}`],
	namespaceWritePrefixes: [`team/${ORG}`],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	clerkOrgSlug: ORG,
});

/** A Clerk-JWT / person bearer acting as the agent it designates. */
const memberAgent = (): OAuthContext => ({
	...base(),
	clerkJwt: "verified-clerk-jwt",
	actor: { agentId: "agent-telemaque", orgSlug: ORG, agentName: AGENT },
});

/** A person bearer with no agent resolved. */
const personOnly = (): OAuthContext => ({
	...base(),
	clerkJwt: "verified-clerk-jwt",
});

/** A one-agent seat token: the agent comes from the stamp on the token. */
const seatAgent = (): OAuthContext => ({
	...base(),
	seatAgent: { agentId: "agent-telemaque", orgId: ORG, agentName: AGENT },
});

const ROW = (createdBy: string) => ({
	_id: "diary000000000000000000000000001",
	_creationTime: 1_780_000_000_000,
	date: "2026-11-17",
	orchestrator: createdBy,
	createdBy,
	content: "entry",
	createdAt: 1,
});

async function call(ctx: OAuthContext, args: Record<string, unknown>) {
	const handlers = new Map<string, ToolHandler>();
	const capture = (...a: unknown[]): unknown => {
		handlers.set(a[0] as string, a[a.length - 1] as ToolHandler);
		return {};
	};
	const server = {
		tool: capture,
		registerTool: capture,
	} as unknown as McpServer;
	const sent: Array<Record<string, unknown>> = [];
	const query = vi.fn(async (fn: string, a: Record<string, unknown>) => {
		if (fn !== "diary:list") throw new Error(`unexpected query ${fn}`);
		sent.push(a);
		return [ROW(typeof a.createdBy === "string" ? a.createdBy : AGENT)];
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
	const result = await handlers.get("list_diaries")?.(args);
	return { result, sent, query };
}

const OWNERS: Array<[string, () => OAuthContext]> = [
	["a Clerk-JWT member acting as its agent", memberAgent],
	["a one-agent seat token", seatAgent],
];

describe.each(OWNERS)("OWN — %s lists its own diary", (_label, make) => {
	it("with no filter, defaults to its verified agent name", async () => {
		const { result, sent } = await call(make(), {});
		expect(isError(result), text(result)).toBe(false);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.createdBy).toBe(AGENT);
		expect(sent[0]?.orchestrator).toBeUndefined();
	});

	it("with createdBy = its agent name, is served", async () => {
		const { result, sent } = await call(make(), { createdBy: AGENT });
		expect(isError(result), text(result)).toBe(false);
		expect(sent[0]?.createdBy).toBe(AGENT);
	});

	it("with orchestrator = its agent name, is served", async () => {
		const { result, sent } = await call(make(), { orchestrator: AGENT });
		expect(isError(result), text(result)).toBe(false);
		expect(sent[0]?.orchestrator).toBe(AGENT);
	});

	it("keeps its person form, 'user:<subject>' and the bare subject", async () => {
		for (const own of [`user:${SUBJECT}`, SUBJECT]) {
			const { result } = await call(make(), { createdBy: own });
			expect(isError(result), `${own}: ${text(result)}`).toBe(false);
		}
	});
});

describe("DEFAULT — a person with no agent resolved", () => {
	it("with no filter, defaults to 'user:<subject>'", async () => {
		const { result, sent } = await call(personOnly(), {});
		expect(isError(result), text(result)).toBe(false);
		expect(sent[0]?.createdBy).toBe(`user:${SUBJECT}`);
	});

	it("is refused an agent name it does not hold", async () => {
		const { result, query } = await call(personOnly(), { createdBy: AGENT });
		expect(isError(result)).toBe(true);
		expect(text(result)).toContain("Forbidden");
		expect(query).not.toHaveBeenCalled();
	});
});

describe.each(
	OWNERS,
)("OTHER — %s is refused another member", (_label, make) => {
	const OTHERS: Array<[string, Record<string, unknown>]> = [
		["another agent's name as createdBy", { createdBy: OTHER_AGENT }],
		["another agent's name as orchestrator", { orchestrator: OTHER_AGENT }],
		["another member's user id", { createdBy: OTHER_SUBJECT }],
		["another member's person form", { createdBy: `user:${OTHER_SUBJECT}` }],
		["another member's id as orchestrator", { orchestrator: OTHER_SUBJECT }],
	];
	it.each(OTHERS)("%s", async (_name, args) => {
		const { result, query } = await call(make(), args);
		expect(isError(result)).toBe(true);
		expect(text(result)).toContain("Forbidden");
		expect(query).not.toHaveBeenCalled();
	});
});

describe("MASTER — unchanged", () => {
	it("with no filter forwards no author", async () => {
		const { result, sent } = await call(LOCAL_STDIO_TRUST_CTX, {});
		expect(isError(result), text(result)).toBe(false);
		expect(sent[0]?.createdBy).toBeUndefined();
		expect(sent[0]?.orchestrator).toBeUndefined();
	});

	it("may name any author", async () => {
		const { result, sent } = await call(LOCAL_STDIO_TRUST_CTX, {
			createdBy: OTHER_AGENT,
		});
		expect(isError(result), text(result)).toBe(false);
		expect(sent[0]?.createdBy).toBe(OTHER_AGENT);
	});
});
