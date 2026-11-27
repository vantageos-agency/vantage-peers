/**
 * S-35 -- a fleet-master-only door is decided BEFORE the read.
 *
 * get_issue, issue_stats and get_mission_template read a door only the fleet master may
 * read. A non-master caller (member bearer, or no context) never reaches it: the door
 * mock is asserted NOT called. A master caller is forwarded unchanged: the door is
 * called once with the tool's arguments. The answers themselves are pinned by
 * s35-master-only-doors-pin.test.ts.
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
// A template row the member's roster and namespace name (the filter would pass it).
const OWN_TEMPLATE = {
	_id: "mt_alpha",
	name: "alpha-template",
	createdBy: "alpha",
	namespace: "team/org-fixture-alpha",
};

const CASES = [
	{
		tool: "get_issue",
		args: { repo: "vantageos-agency/vantage-peers", issueNumber: 667 },
		door: "issues:getByRepoNumber",
		doorArgs: { repo: "vantageos-agency/vantage-peers", issueNumber: 667 },
		row: ISSUE_ROW,
	},
	{
		tool: "issue_stats",
		args: { project: "vantage-peers" },
		door: "issues:getStats",
		doorArgs: { project: "vantage-peers" },
		row: STATS_ROW,
	},
	{
		tool: "get_mission_template",
		args: { name: "alpha-template" },
		door: "missionTemplates:getByName",
		doorArgs: { name: "alpha-template" },
		row: OWN_TEMPLATE,
	},
];

describe("S-35 -- master-only door decided before the read", () => {
	for (const c of CASES) {
		// get_mission_template stays after-read: members see their own templates (S-35 ruling B).
		if (c.tool === "get_mission_template") {
			it(`${c.tool}: master is forwarded to ${c.door} unchanged`, async () => {
				const { query } = await run(c.tool, c.args, MASTER, c.row);
				expect(query).toHaveBeenCalledWith(c.door, c.doorArgs);
			});
			continue;
		}
		it(`${c.tool}: member never reaches ${c.door}`, async () => {
			const { query } = await run(c.tool, c.args, MEMBER, c.row);
			expect(query).not.toHaveBeenCalled();
		});

		it(`${c.tool}: no context never reaches ${c.door}`, async () => {
			const { query } = await run(c.tool, c.args, undefined, c.row);
			expect(query).not.toHaveBeenCalled();
		});

		it(`${c.tool}: master is forwarded to ${c.door} unchanged`, async () => {
			const { query } = await run(c.tool, c.args, MASTER, c.row);
			expect(query).toHaveBeenCalledTimes(1);
			expect(query).toHaveBeenCalledWith(c.door, c.doorArgs);
		});
	}
});
