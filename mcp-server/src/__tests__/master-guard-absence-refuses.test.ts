/**
 * The two master-gate sites in the tool layer — `enforceScope({kind:"master"})`
 * (registerTool.ts) and `guardMasterOnly` (tools.ts) — must REFUSE when the
 * request carries no oauthContext. Pre-fix both did `if (!ctx) return null`
 * (pass), so an absent identity could call any master-only tool.
 *
 * Task k177v39m5w5t54mqf84mk9k0mn8czfwa. Driven end-to-end through
 * registerTools → captured handler, so the assertion exercises the real guard,
 * not a reimplementation (litmus: delete the guard and `undefined` passes →
 * these tests flip to failing).
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
			handlers.set(args[0] as string, args[args.length - 1] as ToolHandler);
			return {};
		},
		registerTool(...args: unknown[]): unknown {
			handlers.set(args[0] as string, args[args.length - 1] as ToolHandler);
			return {};
		},
	} as unknown as McpServer;
	return { server: fakeServer, handlers };
}

function buildMockConvex(): ConvexHttpClient {
	return {
		query: vi.fn().mockResolvedValue([]),
		mutation: vi.fn().mockResolvedValue(null),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
}

function isErrorResult(result: unknown): boolean {
	return (result as { isError?: boolean })?.isError === true;
}

const MASTER_CALLER: OAuthContext = {
	clientId: "master",
	userId: "master",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3600_000,
	isMaster: true,
};

describe("enforceScope({kind:'master'}) — undefined ctx REFUSES", () => {
	it("list_errors with NO context is denied (was: silently allowed)", async () => {
		const { server, handlers } = buildFakeServer();
		registerTools(server, buildMockConvex(), undefined);
		const handler = handlers.get("list_errors");
		expect(handler, "list_errors must be registered").toBeDefined();
		const result = await handler?.({});
		expect(isErrorResult(result)).toBe(true);
	});

	it("list_errors with MASTER context is allowed (presence grants)", async () => {
		const { server, handlers } = buildFakeServer();
		registerTools(server, buildMockConvex(), MASTER_CALLER);
		const handler = handlers.get("list_errors");
		const result = await handler?.({});
		expect(isErrorResult(result)).toBe(false);
	});
});

describe("guardMasterOnly — undefined ctx REFUSES", () => {
	it("soft_delete_memory with NO context is denied (was: silently allowed)", async () => {
		const { server, handlers } = buildFakeServer();
		registerTools(server, buildMockConvex(), undefined);
		const handler = handlers.get("soft_delete_memory");
		expect(handler, "soft_delete_memory must be registered").toBeDefined();
		const result = await handler?.({ memoryId: "mem-1" });
		expect(isErrorResult(result)).toBe(true);
	});

	it("soft_delete_memory with MASTER context passes the master gate", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		(convex.mutation as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: true,
		});
		registerTools(server, convex, MASTER_CALLER);
		const handler = handlers.get("soft_delete_memory");
		const result = await handler?.({ memoryId: "mem-1" });
		// The master gate did not short-circuit with a Forbidden — the handler
		// reached the mutation.
		expect(isErrorResult(result)).toBe(false);
	});
});
