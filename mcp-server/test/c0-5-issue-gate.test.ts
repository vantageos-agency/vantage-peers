/**
 * Day 92 C0.5 — update_issue_status + validate_fix + link_issue_to_pattern master-only gate.
 *
 * TDD RED phase: asserts non-master bearer is rejected with a Forbidden error.
 * None of these tools has an orchestrator/userId identity arg suitable for
 * fromAllowList delegation → masterOnlyMiddleware for all three.
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
		mutation: async () => null,
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

// ─────────────────────────────────────────────────────────────────────────────
// C0.5 — update_issue_status
// ─────────────────────────────────────────────────────────────────────────────

describe("C0.5 — update_issue_status master-only gate", () => {
	const args = {
		repo: "vantageos-agency/test",
		issueNumber: 42,
		status: "in_progress",
	};

	it("RED: non-master scoped bearer → Forbidden error", async () => {
		const result = await callTool("update_issue_status", args, buildScopedCtx());
		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(getText(result)).toMatch(/master/i);
	});

	it("happy path: master bearer → passes through", async () => {
		const result = await callTool("update_issue_status", args, buildMasterCtx());
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});

	it("happy path: legacy bearer (no oauthCtx) → passes through", async () => {
		const result = await callTool("update_issue_status", args, undefined);
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// C0.5 — validate_fix
// ─────────────────────────────────────────────────────────────────────────────

describe("C0.5 — validate_fix master-only gate", () => {
	const args = {
		patternId: "mock-pattern-id",
		validatedFix: "Use exact string comparison instead of coercion",
	};

	it("RED: non-master scoped bearer → Forbidden error", async () => {
		const result = await callTool("validate_fix", args, buildScopedCtx());
		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(getText(result)).toMatch(/master/i);
	});

	it("happy path: master bearer → passes through", async () => {
		const result = await callTool("validate_fix", args, buildMasterCtx());
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});

	it("happy path: legacy bearer (no oauthCtx) → passes through", async () => {
		const result = await callTool("validate_fix", args, undefined);
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// C0.5 — link_issue_to_pattern
// ─────────────────────────────────────────────────────────────────────────────

describe("C0.5 — link_issue_to_pattern master-only gate", () => {
	const args = {
		patternId: "mock-pattern-id",
		issueId: "mock-issue-id",
	};

	it("RED: non-master scoped bearer → Forbidden error", async () => {
		const result = await callTool("link_issue_to_pattern", args, buildScopedCtx());
		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(getText(result)).toMatch(/master/i);
	});

	it("happy path: master bearer → passes through", async () => {
		const result = await callTool("link_issue_to_pattern", args, buildMasterCtx());
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});

	it("happy path: legacy bearer (no oauthCtx) → passes through", async () => {
		const result = await callTool("link_issue_to_pattern", args, undefined);
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});
});
