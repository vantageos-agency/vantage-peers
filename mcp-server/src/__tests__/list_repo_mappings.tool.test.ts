// ─────────────────────────────────────────────────────────────────────────────
// list_repo_mappings.tool.test.ts — PR-C TDD-RED phase
// ─────────────────────────────────────────────────────────────────────────────
// Pins the MCP tool description + args schema contract for list_repo_mappings.
//
// T-GREEN must export from mcp-server/src/tools.ts:
//   - LIST_REPO_MAPPINGS_TOOL_DESCRIPTION: string — must contain "default 20",
//     "cap 200", and "fields=lite|full"
//   - listRepoMappingsArgsSchema: z.ZodObject — must accept
//     { limit (1-200), cursor (string), fields ("lite"|"full") }
//     and reject limit > 200 or invalid fields
//
// Both imports will throw "does not provide an export named …" until T-GREEN
// ships them — that is the RED contract.
// ─────────────────────────────────────────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../auth.js";
import { listRepoMappingsServedOutputSchema } from "../outputSchemas.js";
// Expected exports from T-GREEN — these do not yet exist in tools.ts → RED
import {
	LIST_REPO_MAPPINGS_TOOL_DESCRIPTION,
	listRepoMappingsArgsSchema,
	registerTools,
} from "../tools.js";

describe("list_repo_mappings tool description + args schema (PR-C RED)", () => {
	it("description mentions 'default 20', 'cap 200', and 'fields=lite|full'", () => {
		expect(LIST_REPO_MAPPINGS_TOOL_DESCRIPTION).toContain("default 20");
		expect(LIST_REPO_MAPPINGS_TOOL_DESCRIPTION).toContain("cap 200");
		expect(LIST_REPO_MAPPINGS_TOOL_DESCRIPTION).toContain("fields=lite|full");
	});

	it("args schema accepts {limit (1-200), cursor (string), fields ('lite'|'full')} and rejects out-of-range values", () => {
		// Valid full object
		expect(
			listRepoMappingsArgsSchema.parse({
				limit: 20,
				cursor: "abc",
				fields: "lite",
			}),
		).toBeTruthy();

		// Valid — limit at boundaries
		expect(listRepoMappingsArgsSchema.parse({ limit: 1 })).toBeTruthy();
		expect(listRepoMappingsArgsSchema.parse({ limit: 200 })).toBeTruthy();

		// Valid — fields=full, no cursor
		expect(
			listRepoMappingsArgsSchema.parse({ limit: 10, fields: "full" }),
		).toBeTruthy();

		// Invalid — limit exceeds cap
		expect(() => listRepoMappingsArgsSchema.parse({ limit: 250 })).toThrow();

		// Invalid — limit below 1
		expect(() => listRepoMappingsArgsSchema.parse({ limit: 0 })).toThrow();

		// Invalid — fields not in enum
		expect(() => listRepoMappingsArgsSchema.parse({ fields: "xxx" })).toThrow();

		// Invalid — fields "compact" not in enum
		expect(() =>
			listRepoMappingsArgsSchema.parse({ fields: "compact" }),
		).toThrow();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Out-of-scope rows: the served output schema must mirror the backend validators
// (convex/githubRepoMapping.ts repoMappingFullObject / repoMappingLiteObject),
// where `orchestrator` is optional and a full row may carry `outOfScope`.
// The real server validates structuredContent against the served schema and
// refuses the whole result on a mismatch; the fake server below does not, so the
// test runs the same validation explicitly.
// ─────────────────────────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const MASTER: OAuthContext = {
	clientId: "client-master",
	userId: "user-master",
	scopes: ["mcp:full"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3600_000,
	isMaster: true,
};

const ROUTED_FULL = {
	_id: "jd7routedrow00000000000000000001",
	_creationTime: 1_700_000_000_000,
	repo: "acme/app",
	orchestrator: "sigma",
	project: "app",
	active: true,
	reviewer: "minos",
	orchestratorAgentId: "kh7agentorchestrator0000000000001",
	reviewerAgentId: "kh7agentreviewer0000000000000001",
	fallbackReviewerAgentId: "kh7agentfallback000000000000001",
	orgId: "acme",
	clerkOrgId: "org_123",
};

const OUT_OF_SCOPE_FULL = {
	_id: "jd7outofscoperow000000000000002",
	_creationTime: 1_700_000_001_000,
	repo: "acme/old-fork",
	project: "archive",
	active: false,
	outOfScope: { reason: "no owning station, no activity in 30 days" },
};

const OUT_OF_SCOPE_LITE = {
	_id: "jd7outofscopelite00000000000003",
	_creationTime: 1_700_000_002_000,
	repo: "acme/old-fork",
	project: "archive",
};

async function listWith(items: unknown[], fields: "full" | "lite") {
	const handlers = new Map<string, ToolHandler>();
	const reg = (...args: unknown[]): unknown => {
		handlers.set(args[0] as string, args[args.length - 1] as ToolHandler);
		return {};
	};
	const server = { tool: reg, registerTool: reg } as unknown as McpServer;
	const convex = {
		query: vi.fn().mockResolvedValue({ items, nextCursor: null }),
		mutation: vi.fn(),
		action: vi.fn(),
	} as unknown as ConvexHttpClient;
	registerTools(server, convex, MASTER);
	return (await handlers.get("list_repo_mappings")?.({ fields })) as {
		isError?: boolean;
		content: Array<{ text: string }>;
		structuredContent: unknown;
	};
}

describe("list_repo_mappings serves out-of-scope rows as the backend returns them", () => {
	it("full page: a routed row and an out-of-scope row (no orchestrator) are both served and validate against the served schema", async () => {
		const result = await listWith([ROUTED_FULL, OUT_OF_SCOPE_FULL], "full");
		expect(result.isError).not.toBe(true);
		const parsed = listRepoMappingsServedOutputSchema.safeParse(
			result.structuredContent,
		);
		expect(parsed.success ? "ok" : JSON.stringify(parsed.error.issues)).toBe(
			"ok",
		);
		const body = JSON.parse(result.content[0].text);
		expect(body.items).toHaveLength(2);
		expect(body.items[1].outOfScope.reason).toMatch(/no owning station/);
	});

	it("lite page: an out-of-scope lite row (no orchestrator) is served and validates against the served schema", async () => {
		const result = await listWith([OUT_OF_SCOPE_LITE], "lite");
		expect(result.isError).not.toBe(true);
		const parsed = listRepoMappingsServedOutputSchema.safeParse(
			result.structuredContent,
		);
		expect(parsed.success ? "ok" : JSON.stringify(parsed.error.issues)).toBe(
			"ok",
		);
		expect(JSON.parse(result.content[0].text).items).toHaveLength(1);
	});
});
