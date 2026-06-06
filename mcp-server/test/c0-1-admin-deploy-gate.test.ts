/**
 * Day 92 C0.1 — add_deployment + remove_deployment master-only gate.
 *
 * TDD RED phase: asserts non-master bearer is rejected with a Forbidden error.
 * These tools are infrastructure-level (admin deploy) → masterOnlyMiddleware.
 *
 * Happy path: master-scope bearer (or legacy bearer = no oauthCtx) → passes through.
 * Forbidden path: any scoped non-master bearer → Error: Forbidden …
 *
 * Mission: k57a36y8w5t085bqr23dsmvb2d882506
 * Eta C0 endorsement DM: jn7fhtjdw2yakwwm1p1v6scb9x882ccv
 * Pi auth token: k17f493gw0cpbr3nxkvcc09ngn884n22
 */

import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Mock infrastructure (mirrors whoami-day92.test.ts pattern)
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
	} as Parameters<typeof registerTools>[0];

	const mockConvex = {
		query: async () => null,
		mutation: async () => ({ id: "mock-id", removed: true }),
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
// C0.1 — add_deployment
// ─────────────────────────────────────────────────────────────────────────────

const addDeployArgs = {
	name: "test-deploy",
	deploymentUrl: "https://test-deploy.convex.cloud",
	deployKeyEnvVar: "DEPLOY_KEY_TEST",
	githubRepo: "vantageos-agency/test",
	orchestrator: "sigma",
};

describe("C0.1 — add_deployment master-only gate", () => {
	it("RED: non-master scoped bearer → Forbidden error", async () => {
		const result = await callTool("add_deployment", addDeployArgs, buildScopedCtx());
		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(getText(result)).toMatch(/master/i);
	});

	it("happy path: master bearer → passes through (no Forbidden)", async () => {
		const result = await callTool("add_deployment", addDeployArgs, buildMasterCtx());
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});

	it("happy path: legacy bearer (no oauthCtx) → passes through", async () => {
		const result = await callTool("add_deployment", addDeployArgs, undefined);
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// C0.1 — remove_deployment
// ─────────────────────────────────────────────────────────────────────────────

const removeDeployArgs = { name: "test-deploy" };

describe("C0.1 — remove_deployment master-only gate", () => {
	it("RED: non-master scoped bearer → Forbidden error", async () => {
		const result = await callTool("remove_deployment", removeDeployArgs, buildScopedCtx());
		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(getText(result)).toMatch(/master/i);
	});

	it("happy path: master bearer → passes through (no Forbidden)", async () => {
		const result = await callTool("remove_deployment", removeDeployArgs, buildMasterCtx());
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});

	it("happy path: legacy bearer (no oauthCtx) → passes through", async () => {
		const result = await callTool("remove_deployment", removeDeployArgs, undefined);
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});
});
