/**
 * Day 92 C3 — Alias C0-gate coverage.
 *
 * Regression guard: every alias whose original is C0-master-only MUST block
 * non-master scoped bearers with a Forbidden error, and MUST pass for master
 * bearer and for legacy bearer (no oauthCtx).
 *
 * C0-gated alias matrix (PR #677 security fix):
 *   register_repo_mapping  → add_repo_mapping     (C0.3 #672)
 *   delete_repo_mapping    → remove_repo_mapping  (C0.3 #672)
 *   register_deployment    → add_deployment       (C0.1 #670)
 *   delete_deployment      → remove_deployment    (C0.1 #670)
 *   check_fix              → validate_fix         (C0.5 #675)
 *
 * Non-C0-gated aliases (documented, not tested here):
 *   check_mandate_spending → validate_mandate_spending  (read-only query)
 *   create_fix_attempt     → add_fix_attempt            (guardFrom(createdBy))
 *   create_task_dependency → add_task_dependency        (callerOrchestrator auth)
 *   update_summary         → set_summary                (orchestratorId auth)
 *   create_diary           → write_diary                (guardFrom(author) optional)
 *
 * Eta verdict: jn77zq0d3564vfhcs5z9x13qjx884c0k
 * PR: #677
 */

import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Mock infrastructure (mirrors c0-3-bu-repo-gate.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

type CapturedTool = {
	name: string;
	handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function captureTools(oauthCtx?: OAuthContext): Map<string, CapturedTool> {
	const tools = new Map<string, CapturedTool>();
	const mockServer = {
		// server.tool is overloaded:
		//   4-arg: (name, description, schema, handler)          — aliases section
		//   5-arg: (name, description, schema, annotations, handler) — main tools
		tool: (...args: unknown[]) => {
			const name = args[0] as string;
			// If 4th arg is a function → 4-arg form; if 5th arg is a function → 5-arg form
			const handler = (
				typeof args[3] === "function" ? args[3] : args[4]
			) as (a: Record<string, unknown>) => Promise<unknown>;
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
// Alias 1: register_repo_mapping → add_repo_mapping (C0.3)
// ─────────────────────────────────────────────────────────────────────────────

describe("C3 alias gate — register_repo_mapping (alias of add_repo_mapping, C0.3)", () => {
	const args = {
		repo: "vantageos-agency/test",
		orchestrator: "sigma",
		project: "test-project",
	};

	it("non-master scoped bearer → Forbidden", async () => {
		const result = await callTool("register_repo_mapping", args, buildScopedCtx());
		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(getText(result)).toMatch(/master/i);
	});

	it("master bearer → passes through", async () => {
		const result = await callTool("register_repo_mapping", args, buildMasterCtx());
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});

	it("legacy bearer (no oauthCtx) → passes through", async () => {
		const result = await callTool("register_repo_mapping", args, undefined);
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Alias 2: delete_repo_mapping → remove_repo_mapping (C0.3)
// ─────────────────────────────────────────────────────────────────────────────

describe("C3 alias gate — delete_repo_mapping (alias of remove_repo_mapping, C0.3)", () => {
	const args = { repo: "vantageos-agency/test" };

	it("non-master scoped bearer → Forbidden", async () => {
		const result = await callTool("delete_repo_mapping", args, buildScopedCtx());
		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(getText(result)).toMatch(/master/i);
	});

	it("master bearer → passes through", async () => {
		const result = await callTool("delete_repo_mapping", args, buildMasterCtx());
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});

	it("legacy bearer (no oauthCtx) → passes through", async () => {
		const result = await callTool("delete_repo_mapping", args, undefined);
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Alias 3: register_deployment → add_deployment (C0.1)
// ─────────────────────────────────────────────────────────────────────────────

describe("C3 alias gate — register_deployment (alias of add_deployment, C0.1)", () => {
	const args = {
		name: "vantage-prod",
		deploymentUrl: "https://vantage-prod.convex.cloud",
		deployKeyEnvVar: "DEPLOY_KEY_PROD",
		githubRepo: "vantageos-agency/vantage-peers",
		orchestrator: "sigma",
	};

	it("non-master scoped bearer → Forbidden", async () => {
		const result = await callTool("register_deployment", args, buildScopedCtx());
		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(getText(result)).toMatch(/master/i);
	});

	it("master bearer → passes through", async () => {
		const result = await callTool("register_deployment", args, buildMasterCtx());
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});

	it("legacy bearer (no oauthCtx) → passes through", async () => {
		const result = await callTool("register_deployment", args, undefined);
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Alias 4: delete_deployment → remove_deployment (C0.1)
// ─────────────────────────────────────────────────────────────────────────────

describe("C3 alias gate — delete_deployment (alias of remove_deployment, C0.1)", () => {
	const args = { name: "vantage-prod" };

	it("non-master scoped bearer → Forbidden", async () => {
		const result = await callTool("delete_deployment", args, buildScopedCtx());
		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(getText(result)).toMatch(/master/i);
	});

	it("master bearer → passes through", async () => {
		const result = await callTool("delete_deployment", args, buildMasterCtx());
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});

	it("legacy bearer (no oauthCtx) → passes through", async () => {
		const result = await callTool("delete_deployment", args, undefined);
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Alias 5: check_fix → validate_fix (C0.5)
// ─────────────────────────────────────────────────────────────────────────────

describe("C3 alias gate — check_fix (alias of validate_fix, C0.5)", () => {
	const args = {
		patternId: "j57aaaaa-test",
		validatedFix: "Add suppressHydrationWarning to date elements",
	};

	it("non-master scoped bearer → Forbidden", async () => {
		const result = await callTool("check_fix", args, buildScopedCtx());
		expect(result.isError).toBe(true);
		expect(getText(result)).toMatch(/Forbidden/i);
		expect(getText(result)).toMatch(/master/i);
	});

	it("master bearer → passes through", async () => {
		const result = await callTool("check_fix", args, buildMasterCtx());
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});

	it("legacy bearer (no oauthCtx) → passes through", async () => {
		const result = await callTool("check_fix", args, undefined);
		expect(result.isError).toBeFalsy();
		expect(getText(result)).not.toMatch(/Forbidden/i);
	});
});
