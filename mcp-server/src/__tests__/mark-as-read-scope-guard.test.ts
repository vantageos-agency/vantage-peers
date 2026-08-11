/**
 * mark_as_read — MCP-layer callerOrchestrator identity guard.
 *
 * Task k179nrp3apj700pm0h1ckewm2h8b3nz7. MEASURED (before fix): mark_as_read
 * declared `kind: "filtered"` with no in-handler enforcement at all — any
 * caller-supplied receiptIds were passed straight to messages:markAsRead,
 * which validated ID FORMAT only, never ownership. A scoped (non-master)
 * OAuth client could mark ANY other orchestrator's receipts read by omitting
 * or spoofing callerOrchestrator. The fix promotes the tool to
 * `kind: "from", fromArg: "callerOrchestrator"`, which the registerTool.ts
 * wrapper enforces BEFORE the handler runs (checkFromAllowed) — a scoped
 * caller must supply its own allow-listed identity or the call is denied
 * pre-handler, before the mutation ever dispatches.
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
	} as unknown as McpServer;
	return { server: fakeServer, handlers };
}

function buildMockConvex(): ConvexHttpClient {
	return {
		query: vi.fn().mockResolvedValue([]),
		mutation: vi.fn().mockResolvedValue(1),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
}

function isErrorResult(result: unknown): boolean {
	const r = result as { isError?: boolean };
	return r?.isError === true;
}

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

const RECEIPT_ID = "jn70tnqnsvbzh9w5kb8vamfjr984vhn2";

describe("mark_as_read — callerOrchestrator identity guard (k179nrp3apj700pm0h1ckewm2h8b3nz7)", () => {
	it("caller A claiming to be beta-role is denied before the mutation runs", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		const handler = handlers.get("mark_as_read");
		expect(handler, "mark_as_read must be registered").toBeDefined();

		const result = await handler?.({
			receiptIds: [RECEIPT_ID],
			callerOrchestrator: "beta-role",
		});

		expect(
			isErrorResult(result),
			"caller A spoofing callerOrchestrator='beta-role' must be denied pre-handler",
		).toBe(true);
		expect(
			(convex.mutation as ReturnType<typeof vi.fn>).mock.calls.length,
			"the mutation must never be dispatched once the identity guard denies",
		).toBe(0);
	});

	it("caller A omitting callerOrchestrator entirely is denied (no free pass)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		const handler = handlers.get("mark_as_read");
		const result = await handler?.({ receiptIds: [RECEIPT_ID] });

		expect(isErrorResult(result)).toBe(true);
		expect(
			(convex.mutation as ReturnType<typeof vi.fn>).mock.calls.length,
		).toBe(0);
	});

	it("positive control: caller A using its own identity is allowed through to the mutation", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_A);

		const handler = handlers.get("mark_as_read");
		const result = await handler?.({
			receiptIds: [RECEIPT_ID],
			callerOrchestrator: "alpha-role",
		});

		expect(isErrorResult(result)).toBe(false);
		expect(
			(convex.mutation as ReturnType<typeof vi.fn>).mock.calls.length,
		).toBe(1);
	});
});
