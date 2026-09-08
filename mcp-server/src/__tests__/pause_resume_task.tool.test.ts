// ─────────────────────────────────────────────────────────────────────────────
// pause_resume_task.tool.test.ts — pause_task / resume_task MCP wrappers.
//
// Mounts the real tool handlers behind a mocked Convex client so each verb's
// mutation call (name + args) and error surfacing can be pinned without a
// full convex-test round-trip.
// ─────────────────────────────────────────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../auth.js";
import { registerTools } from "../tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}>;

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

const masterCtx: OAuthContext = {
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

const FAKE_TASK_ID = "b2v9k4x7p1m6q0z3w8n5r2t4y7c1u9df";

function buildMockConvex(
	mutationImpl: (name: string, args: unknown) => unknown = () => null,
): { convex: ConvexHttpClient; mutation: ReturnType<typeof vi.fn> } {
	const mutation = vi.fn(mutationImpl);
	const convex = {
		query: vi.fn().mockResolvedValue(null),
		mutation,
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
	return { convex, mutation };
}

describe("pause_task — calls tasks:pause with taskId + callerOrchestrator", () => {
	it("forwards args exactly and reports the reverted status", async () => {
		const { convex, mutation } = buildMockConvex();
		const { server, handlers } = buildFakeServer();
		registerTools(server, convex, masterCtx);
		const handler = handlers.get("pause_task")!;

		const result = await handler({
			taskId: FAKE_TASK_ID,
			callerOrchestrator: "gamma",
		});

		expect(mutation).toHaveBeenCalledWith("tasks:pause", {
			taskId: FAKE_TASK_ID,
			callerOrchestrator: "gamma",
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.status).toBe("todo");
	});

	it("surfaces a Convex refusal through mcpConvexError, not as a raw throw", async () => {
		const { convex } = buildMockConvex(() => {
			throw new Error(
				"[CONVEX M(tasks:pause)] PAUSE_REFUSED_NO_OPEN_SEGMENT: no open work segment",
			);
		});
		const { server, handlers } = buildFakeServer();
		registerTools(server, convex, masterCtx);
		const handler = handlers.get("pause_task")!;

		const result = await handler({
			taskId: FAKE_TASK_ID,
			callerOrchestrator: "gamma",
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("PAUSE_REFUSED_NO_OPEN_SEGMENT");
	});
});

describe("resume_task — calls tasks:resume with taskId + callerOrchestrator", () => {
	it("forwards args exactly and reports the reopened status", async () => {
		const { convex, mutation } = buildMockConvex();
		const { server, handlers } = buildFakeServer();
		registerTools(server, convex, masterCtx);
		const handler = handlers.get("resume_task")!;

		const result = await handler({
			taskId: FAKE_TASK_ID,
			callerOrchestrator: "gamma",
		});

		expect(mutation).toHaveBeenCalledWith("tasks:resume", {
			taskId: FAKE_TASK_ID,
			callerOrchestrator: "gamma",
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.status).toBe("in_progress");
	});

	it("surfaces a Convex refusal through mcpConvexError, not as a raw throw", async () => {
		const { convex } = buildMockConvex(() => {
			throw new Error(
				"[CONVEX M(tasks:resume)] RESUME_REFUSED_NOT_PAUSED: task is not paused",
			);
		});
		const { server, handlers } = buildFakeServer();
		registerTools(server, convex, masterCtx);
		const handler = handlers.get("resume_task")!;

		const result = await handler({
			taskId: FAKE_TASK_ID,
			callerOrchestrator: "gamma",
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("RESUME_REFUSED_NOT_PAUSED");
	});
});
