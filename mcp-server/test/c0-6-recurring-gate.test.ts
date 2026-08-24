/**
 * Day 92 C0.6 — pause_recurring_task + resume_recurring_task + delete_recurring_task master-only gate.
 *
 * TDD RED phase: asserts non-master bearer is rejected with a Forbidden error.
 * Recurring task management is cron infrastructure — no per-task identity arg
 * suitable for fromAllowList delegation → masterOnlyMiddleware for all three.
 *
 * Mission: k57a36y8w5t085bqr23dsmvb2d882506
 * Eta C0 endorsement DM: jn7fhtjdw2yakwwm1p1v6scb9x882ccv
 * Pi auth token: k17f493gw0cpbr3nxkvcc09ngn884n22
 */

import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Mock infrastructure
// ─────────────────────────────────────────────────────────────────────────────

type CapturedTool = {
	name: string;
	handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function captureTools(oauthCtx?: OAuthContext): Map<string, CapturedTool> {
	const tools = new Map<string, CapturedTool>();
	const mockServer = {
		tool: (
			name: string,
			_description: string,
			_schema: Record<string, unknown>,
			_annotations: Record<string, unknown>,
			handler: (args: Record<string, unknown>) => Promise<unknown>,
		) => {
			tools.set(name, { name, handler });
		},
		registerTool: (
			name: string,
			config: { description?: string },
			handler: (args: Record<string, unknown>) => Promise<unknown>,
		) => {
			tools.set(name, { name, handler });
		},
	} as Parameters<typeof registerTools>[0];

	const mockConvex = {
		query: async () => null,
		mutation: async () => ({
			taskId: "mock-id",
			paused: true,
			resumed: true,
			removed: true,
		}),
		action: async () => null,
	} as Parameters<typeof registerTools>[1];

	registerTools(mockServer, mockConvex, oauthCtx);
	return tools;
}

function buildScopedCtx(overrides: Partial<OAuthContext> = {}): OAuthContext {
	return {
		clientId: "alpha-client",
		userId: "alpha-user",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "alpha-test-trio",
		fromAllowList: ["Alpha", "alpha"],
		namespaceReadPrefixes: ["orchestrator/Alpha"],
		namespaceWritePrefixes: ["orchestrator/Alpha"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
		...overrides,
	};
}

function buildMasterCtx(): OAuthContext {
	return {
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
}

type ToolResult = {
	content?: Array<{ text?: string }>;
	isError?: boolean;
};

async function callTool(
	toolName: string,
	args: Record<string, unknown>,
	oauthCtx?: OAuthContext,
): Promise<ToolResult> {
	const tools = captureTools(oauthCtx);
	const tool = tools.get(toolName);
	if (!tool) throw new Error(`Tool '${toolName}' not registered`);
	return (await tool.handler(args)) as ToolResult;
}

function getText(result: ToolResult): string {
	return result.content?.[0]?.text ?? "";
}

const recurringArgs = { taskId: "mock-recurring-task-id" };

// ─────────────────────────────────────────────────────────────────────────────
// C0.6 — pause_recurring_task
// ─────────────────────────────────────────────────────────────────────────────

describe("C0.6 — pause_recurring_task master-only gate", () => {
	it("RED: non-master scoped bearer → Forbidden error", async () => {
		const result = await callTool(
			"pause_recurring_task",
			recurringArgs,
			buildScopedCtx(),
		);
		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(getText(result)).toMatch(/master/i);
	});

	it("happy path: master bearer → passes through", async () => {
		const result = await callTool(
			"pause_recurring_task",
			recurringArgs,
			buildMasterCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});

	it("no oauthCtx → REFUSED (absence is never master)", async () => {
		const result = await callTool(
			"pause_recurring_task",
			recurringArgs,
			undefined,
		);
		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/master/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// C0.6 — resume_recurring_task
// ─────────────────────────────────────────────────────────────────────────────

describe("C0.6 — resume_recurring_task master-only gate", () => {
	it("RED: non-master scoped bearer → Forbidden error", async () => {
		const result = await callTool(
			"resume_recurring_task",
			recurringArgs,
			buildScopedCtx(),
		);
		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(getText(result)).toMatch(/master/i);
	});

	it("happy path: master bearer → passes through", async () => {
		const result = await callTool(
			"resume_recurring_task",
			recurringArgs,
			buildMasterCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});

	it("no oauthCtx → REFUSED (absence is never master)", async () => {
		const result = await callTool(
			"resume_recurring_task",
			recurringArgs,
			undefined,
		);
		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/master/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// C0.6 — delete_recurring_task
// ─────────────────────────────────────────────────────────────────────────────

describe("C0.6 — delete_recurring_task master-only gate", () => {
	it("RED: non-master scoped bearer → Forbidden error", async () => {
		const result = await callTool(
			"delete_recurring_task",
			recurringArgs,
			buildScopedCtx(),
		);
		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(getText(result)).toMatch(/master/i);
	});

	it("happy path: master bearer → passes through", async () => {
		const result = await callTool(
			"delete_recurring_task",
			recurringArgs,
			buildMasterCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});

	it("no oauthCtx → REFUSED (absence is never master)", async () => {
		const result = await callTool(
			"delete_recurring_task",
			recurringArgs,
			undefined,
		);
		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/master/i);
	});
});
