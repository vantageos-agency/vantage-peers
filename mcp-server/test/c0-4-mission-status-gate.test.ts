/**
 * Day 92 C0.4 — update_mission_status master-only gate.
 *
 * Design call: masterOnlyMiddleware.
 * Rationale: Mission lifecycle is infrastructure-level. Missions are created
 * and owned by orchestrators. A scoped non-master client should not be able
 * to transition a mission's lifecycle state (brainstorm→plan→execute→validate→complete).
 * No per-mission identity field suitable for fromAllowList delegation exists
 * in the MCP args (missionId is opaque, not an orchestrator identity).
 *
 * Alternative considered: callerOrchestrator gate (fromAllowList).
 * Rejected: update_mission_status takes only missionId + status — no from/orchestrator arg.
 * Adding a callerOrchestrator arg would be a schema break. masterOnlyMiddleware is correct.
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
// C0.4 — update_mission_status
// ─────────────────────────────────────────────────────────────────────────────

const missionStatusArgs = {
	missionId: "mock-mission-id",
	status: "execute",
};

describe("C0.4 — update_mission_status master-only gate", () => {
	it("RED: non-master scoped bearer → Forbidden error", async () => {
		const result = await callTool(
			"update_mission_status",
			missionStatusArgs,
			buildScopedCtx(),
		);
		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(getText(result)).toMatch(/master/i);
	});

	it("happy path: master bearer → passes through (no Forbidden)", async () => {
		const result = await callTool(
			"update_mission_status",
			missionStatusArgs,
			buildMasterCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});

	it("no oauthCtx → REFUSED (absence is never master)", async () => {
		const result = await callTool(
			"update_mission_status",
			missionStatusArgs,
			undefined,
		);
		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/master/i);
	});
});
