/**
 * bulk_complete_tasks — MCP-layer callerOrchestrator spoof guard.
 *
 * Task k179nrp3apj700pm0h1ckewm2h8b3nz7. MEASURED (before fix): the tool
 * declared `kind: "filtered"` claiming enforcement lives in
 * tasks:bulkComplete, but that Convex handler only checks whether MATCHED
 * TASKS belong to the client-SUPPLIED callerOrchestrator — it never verifies
 * the caller claiming that identity actually IS it. A scoped (non-master)
 * OAuth client could pass any other orchestrator's name in
 * `callerOrchestrator` and bulk-close that orchestrator's tasks. The fix adds
 * a `guardFrom(callerOrchestrator)` MCP-side check (mirrors delete_message)
 * before the mutation is ever dispatched.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../auth.js";
import { registerTools } from "../tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function buildFakeServer(): {
	server: McpServer;
	handlers: Map<string, ToolHandler>;
} {
	const handlers = new Map<string, ToolHandler>();
	const fakeServer = {
		tool(...args: unknown[]): unknown {
			const name = args[0] as string;
			const handler = args[args.length - 1] as ToolHandler;
			handlers.set(name, handler);
			return {};
		},
		registerTool(...args: unknown[]): unknown {
			const name = args[0] as string;
			const handler = args[args.length - 1] as ToolHandler;
			handlers.set(name, handler);
			return {};
		},
	} as unknown as McpServer;
	return { server: fakeServer, handlers };
}

function buildMockConvex(): ConvexHttpClient {
	return {
		query: vi.fn().mockResolvedValue([]),
		mutation: vi.fn().mockResolvedValue({
			count: 1,
			sampleIds: ["task-fixture-1"],
			bulkRunId: "bulk-fixture-1",
		}),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
}

function isErrorResult(result: unknown): boolean {
	const r = result as { isError?: boolean };
	return r?.isError === true;
}

// Non-wildcard fromAllowList — a real non-master, non-legacy caller whose
// only allowed identity is "alpha-role".
const CALLER_A: OAuthContext = {
	clientId: "client-fixture-alpha",
	userId: "user-fixture-alpha",
	scopes: ["mcp:full"],
	scopeProfile: "tenant",
	fromAllowList: ["alpha-role"],
	namespaceReadPrefixes: ["team/org-fixture-alpha"],
	namespaceWritePrefixes: ["team/org-fixture-alpha"],
	expiresAt: Date.now() + 3600_000,
	isMaster: false,
};

describe("bulk_complete_tasks — callerOrchestrator spoof guard (k179nrp3apj700pm0h1ckewm2h8b3nz7)", () => {
	it("RED reproduction (pre-fix behavior would dispatch): caller A claiming to be beta-role is denied before the mutation runs", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		const handler = handlers.get("bulk_complete_tasks");
		expect(handler, "bulk_complete_tasks must be registered").toBeDefined();

		const result = await handler?.({
			filter: { assignedTo: "beta-role" },
			dryRun: false,
			callerOrchestrator: "beta-role",
		});

		expect(
			isErrorResult(result),
			"caller A spoofing callerOrchestrator='beta-role' must be denied — this is the hole the guard closes",
		).toBe(true);
		expect(
			(convex.mutation as ReturnType<typeof vi.fn>).mock.calls.length,
			"the mutation must never be dispatched once the identity guard denies",
		).toBe(0);
	});

	it("positive control: caller A using its own identity is allowed through to the mutation", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		const handler = handlers.get("bulk_complete_tasks");
		const result = await handler?.({
			filter: { assignedTo: "alpha-role" },
			dryRun: true,
			callerOrchestrator: "alpha-role",
		});

		expect(isErrorResult(result)).toBe(false);
		expect(
			(convex.mutation as ReturnType<typeof vi.fn>).mock.calls.length,
		).toBe(1);
	});
});
