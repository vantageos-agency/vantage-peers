/**
 * S-35 pin -- get_issue, issue_stats, get_mission_template.
 *
 * The three tools read a fleet-master-only door (issues:getByRepoNumber,
 * issues:getStats, missionTemplates:getByName). Until this change each narrowed
 * the row AFTER the read with scopeFilterGet. This file pins the exact output
 * (text, isError, structuredContent) each tool returns for a master caller and
 * for a non-master caller, so the move of the decision BEFORE the read cannot
 * change an answer. It is committed first and must stay green across the change.
 *
 * The door is mocked; the test sets which row it returns. Callers:
 *   master     scopeProfile "master", fromAllowList ["*"]
 *   member     scopeProfile "tenant", an org member's bearer (not master)
 *   no context no oauthContext at all
 *
 * The wrapper's { kind: "master" } on get_issue and issue_stats makes the in-handler check
 * unreachable through registerTools; s35-master-only-doors-handler.test.ts and
 * s35-may-read-master-only-door.test.ts exist to cover it.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function buildFakeServer(): {
	server: McpServer;
	handlers: Map<string, ToolHandler>;
} {
	const handlers = new Map<string, ToolHandler>();
	const capture = (...args: unknown[]): unknown => {
		handlers.set(args[0] as string, args[args.length - 1] as ToolHandler);
		return {};
	};
	return {
		server: { tool: capture, registerTool: capture } as unknown as McpServer,
		handlers,
	};
}

async function run(
	toolName: string,
	args: Record<string, unknown>,
	ctx: OAuthContext | undefined,
	doorReturns: unknown,
): Promise<{ result: unknown; query: ReturnType<typeof vi.fn> }> {
	const { server, handlers } = buildFakeServer();
	const query = vi.fn().mockResolvedValue(doorReturns);
	const convex = {
		query,
		mutation: vi.fn().mockResolvedValue(null),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
	registerTools(server, convex, ctx);
	const handler = handlers.get(toolName);
	if (!handler) throw new Error(`${toolName} not registered`);
	return { result: await handler(args), query };
}

const MASTER: OAuthContext = {
	clientId: "client-fixture-master",
	userId: "user-fixture-master",
	scopes: ["mcp:full"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3600_000,
	isMaster: true,
};

const MEMBER: OAuthContext = {
	clientId: "client-fixture-alpha",
	userId: "user-fixture-alpha",
	scopes: ["mcp:full"],
	scopeProfile: "tenant",
	fromAllowList: ["alpha"],
	namespaceReadPrefixes: ["team/org-fixture-alpha"],
	namespaceWritePrefixes: ["team/org-fixture-alpha"],
	expiresAt: Date.now() + 3600_000,
	isMaster: false,
	orgClerkId: "org_fixtureAlpha",
};

const ISSUE_ROW = {
	_id: "issue-fixture-001",
	_creationTime: 1780000000000,
	repo: "vantageos-agency/vantage-peers",
	issueNumber: 667,
	title: "boom",
	status: "open",
};
const STATS_ROW = { open: 3, in_progress: 1, fixed: 2, verified: 0, closed: 5 };
const ZERO_STATS = {
	open: 0,
	in_progress: 0,
	fixed: 0,
	verified: 0,
	closed: 0,
	total: 0,
};
// A template row the member's roster and namespace name (the filter would pass it).
const OWN_TEMPLATE = {
	_id: "mt_alpha",
	name: "alpha-template",
	createdBy: "alpha",
	namespace: "team/org-fixture-alpha",
};
// A template row owned by another tenant (the filter would empty it).
const FOREIGN_TEMPLATE = {
	_id: "mt_beta",
	name: "beta-template",
	createdBy: "beta",
	namespace: "team/org-fixture-beta",
};

const text = (s: string) => ({ content: [{ type: "text", text: s }] });
const MASTER_ONLY_MEMBER = {
	...text("Forbidden: this tool requires master scope (current: tenant)."),
	isError: true,
};
const MASTER_ONLY_NOCTX = {
	...text(
		"Forbidden: this tool requires master scope, but the request carried no authorization context (absence is never master).",
	),
	isError: true,
};

describe("S-35 pin -- get_issue", () => {
	const args = { repo: ISSUE_ROW.repo, issueNumber: 667 };

	it("master gets the row", async () => {
		const { result } = await run("get_issue", args, MASTER, ISSUE_ROW);
		expect(result).toEqual({
			...text(JSON.stringify(ISSUE_ROW, null, 2)),
			structuredContent: { issue: ISSUE_ROW },
		});
	});

	it("master, no such issue (door null) gets the not-found object", async () => {
		const { result } = await run("get_issue", args, MASTER, null);
		expect(result).toEqual({
			...text(JSON.stringify({ error: "Issue not found" }, null, 2)),
			structuredContent: { issue: null },
		});
	});

	it("member is refused with the master-scope error", async () => {
		const { result } = await run("get_issue", args, MEMBER, ISSUE_ROW);
		expect(result).toEqual(MASTER_ONLY_MEMBER);
	});

	it("no context is refused, absence is never master", async () => {
		const { result } = await run("get_issue", args, undefined, ISSUE_ROW);
		expect(result).toEqual(MASTER_ONLY_NOCTX);
	});
});

describe("S-35 pin -- issue_stats", () => {
	it("master gets the counts", async () => {
		const { result } = await run("issue_stats", {}, MASTER, STATS_ROW);
		expect(result).toEqual({
			...text(JSON.stringify(STATS_ROW, null, 2)),
			structuredContent: STATS_ROW,
		});
	});

	it("master gets the zeroed aggregate the door returns on refusal", async () => {
		const { result } = await run("issue_stats", {}, MASTER, ZERO_STATS);
		expect(result).toEqual({
			...text(JSON.stringify(ZERO_STATS, null, 2)),
			structuredContent: ZERO_STATS,
		});
	});

	it("member is refused with the master-scope error", async () => {
		const { result } = await run("issue_stats", {}, MEMBER, STATS_ROW);
		expect(result).toEqual(MASTER_ONLY_MEMBER);
	});

	it("no context is refused, absence is never master", async () => {
		const { result } = await run("issue_stats", {}, undefined, STATS_ROW);
		expect(result).toEqual(MASTER_ONLY_NOCTX);
	});
});

describe("S-35 pin -- get_mission_template", () => {
	const found = (row: unknown) => ({
		content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
		structuredContent: { found: true, item: row },
	});
	const notFound = (name: string) => ({
		content: [{ type: "text", text: "null" }],
		structuredContent: { found: false, id: name },
	});

	it("master gets a template, whoever owns it", async () => {
		const { result } = await run(
			"get_mission_template",
			{ name: "beta-template" },
			MASTER,
			FOREIGN_TEMPLATE,
		);
		expect(result).toEqual(found(FOREIGN_TEMPLATE));
	});

	it("master, no such template (door null), gets found:false", async () => {
		const { result } = await run(
			"get_mission_template",
			{ name: "nope" },
			MASTER,
			null,
		);
		expect(result).toEqual(notFound("nope"));
	});

	it("member asking for another tenant's template gets found:false", async () => {
		const { result } = await run(
			"get_mission_template",
			{ name: "beta-template" },
			MEMBER,
			FOREIGN_TEMPLATE,
		);
		expect(result).toEqual(notFound("beta-template"));
	});

	it("member, no such template (door null), gets found:false", async () => {
		const { result } = await run(
			"get_mission_template",
			{ name: "nope" },
			MEMBER,
			null,
		);
		expect(result).toEqual(notFound("nope"));
	});

	it("no context gets found:false, absence is never master", async () => {
		const { result } = await run(
			"get_mission_template",
			{ name: "beta-template" },
			undefined,
			FOREIGN_TEMPLATE,
		);
		expect(result).toEqual(notFound("beta-template"));
	});

	// MOCK-ONLY CASE. missionTemplates:getByName is masterOnly (convex/missionTemplates.ts), so
	// a real member never receives a row from it: the door refuses before the tool filters. With
	// a mocked door returning the member's own row, the after-read filter lets it through.
	it("member, door mocked to return the member's OWN template, gets it", async () => {
		const { result } = await run(
			"get_mission_template",
			{ name: "alpha-template" },
			MEMBER,
			OWN_TEMPLATE,
		);
		expect(result).toEqual(found(OWN_TEMPLATE));
	});
});
