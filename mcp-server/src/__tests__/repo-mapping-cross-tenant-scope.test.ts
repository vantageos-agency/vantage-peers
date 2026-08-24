/**
 * list_repo_mappings / get_repo_mapping — refus-total fix (githubRepoMapping
 * rows lack createdBy/namespace).
 *
 * VP task k1759mg282aqy6t7c91gnk10598bn4sv, mission
 * vp-multitenant-zero-hole-v1 (final class sweep, 8 remaining instances).
 *
 * MEASURED (before fix): githubRepoMapping rows (schema.ts:482) carry
 * `orchestrator` (the mapping's owning orchestrator), NOT `createdBy` and NOT
 * `namespace`. Passing rows through scopeFilterGet/scopeFilterList unmapped
 * finds no field to discriminate on and refuses EVERY non-master caller —
 * the owning orchestrator included (refus-total). The fix remaps
 * `orchestrator` -> `createdBy` before calling scopeFilterGet/scopeFilterList
 * (same pattern established by list_broadcast_status, tools.ts:~3607), then
 * strips the synthetic field from the response.
 *
 * METHOD CONSTRAINT: a positive control on a known-guarded tool
 * (get_briefing_note) runs first so a pattern that returns zero on a guarded
 * tool is disqualified from being read as "denied".
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../auth.js";
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
		mutation: vi.fn().mockResolvedValue(null),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
}

function parseResult(result: unknown): unknown {
	const r = result as {
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
	};
	return JSON.parse(r.content[0].text);
}

function isErrorResult(result: unknown): boolean {
	const r = result as { isError?: boolean };
	return r?.isError === true;
}

function items(parsed: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
	const obj = parsed as { items?: Array<Record<string, unknown>> };
	return obj.items ?? [];
}

const CALLER_ALPHA: OAuthContext = {
	clientId: "client-fixture-alpha",
	userId: "user-fixture-alpha",
	scopes: ["mcp:full"],
	scopeProfile: "tenant",
	fromAllowList: ["alpha"],
	namespaceReadPrefixes: ["team/org-fixture-alpha"],
	namespaceWritePrefixes: ["team/org-fixture-alpha"],
	expiresAt: Date.now() + 3600_000,
	isMaster: false,
};

const MAPPING_ALPHA_OWN = {
	_id: "mapping-fixture-alpha-001",
	_creationTime: 1780000001000,
	repo: "vantageos-agency/alpha-repo",
	orchestrator: "alpha",
	project: "alpha-project",
	active: true,
};

const MAPPING_BETA_OTHER = {
	_id: "mapping-fixture-beta-001",
	_creationTime: 1780000000000,
	repo: "vantageos-agency/beta-repo",
	orchestrator: "beta",
	project: "beta-project",
	active: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// 0. POSITIVE CONTROL
// ─────────────────────────────────────────────────────────────────────────────

describe("POSITIVE CONTROL — get_briefing_note (known scopeFilterGet call site)", () => {
	it("tenant A is denied reading tenant B's note by ID — NON-ZERO evidence", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			_id: "note-fixture-beta-001",
			_creationTime: 1780000000000,
			title: "Beta internal roadmap",
			topic: "planning",
			content: "Confidential beta content",
			createdBy: "org-fixture-beta",
			createdAt: 1780000000000,
		});

		const handler = handlers.get("get_briefing_note");
		expect(handler, "get_briefing_note must be registered").toBeDefined();

		const result = await handler?.({ noteId: "note-fixture-beta-001" });
		expect(
			isErrorResult(result),
			"positive control FAILED if this is not an error — scopeFilterGet is not actually enforced here",
		).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// list_repo_mappings
// ─────────────────────────────────────────────────────────────────────────────

describe("RED — list_repo_mappings refus-total reproduction (pre-fix behavior)", () => {
	it("owning orchestrator's OWN mapping is returned (fails pre-fix)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			items: [MAPPING_ALPHA_OWN],
			nextCursor: null,
		});

		const handler = handlers.get("list_repo_mappings");
		expect(handler, "list_repo_mappings must be registered").toBeDefined();

		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(
			parsed.some((m) => m._id === MAPPING_ALPHA_OWN._id),
			"a guard that refuses everyone including the owning orchestrator is refus-total, not isolation",
		).toBe(true);
	});
});

describe("GREEN — list_repo_mappings scoped correctly (four independent poles)", () => {
	it("(ii) OWNER pole alone — alpha sees its own mapping", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			items: [MAPPING_ALPHA_OWN, MAPPING_BETA_OTHER],
			nextCursor: null,
		});

		const handler = handlers.get("list_repo_mappings");
		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(parsed.some((m) => m._id === MAPPING_ALPHA_OWN._id)).toBe(true);
	});

	it("(iii) DENY pole alone — beta's mapping is not rendered to alpha", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			items: [MAPPING_ALPHA_OWN, MAPPING_BETA_OTHER],
			nextCursor: null,
		});

		const handler = handlers.get("list_repo_mappings");
		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(parsed.some((m) => m._id === MAPPING_BETA_OTHER._id)).toBe(false);
	});

	it("(iv) MASTER pole alone — legacy/master callers see all mappings unfiltered", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, LOCAL_STDIO_TRUST_CTX);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			items: [MAPPING_ALPHA_OWN, MAPPING_BETA_OTHER],
			nextCursor: null,
		});

		const handler = handlers.get("list_repo_mappings");
		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(parsed.length).toBe(2);
	});

	it("does not leak the synthetic `createdBy` remap field into the response", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			items: [MAPPING_ALPHA_OWN],
			nextCursor: null,
		});

		const handler = handlers.get("list_repo_mappings");
		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(parsed[0]).not.toHaveProperty("createdBy");
		expect(parsed[0]).toHaveProperty("orchestrator", "alpha");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// get_repo_mapping — same remap, single-row get counterpart
// ─────────────────────────────────────────────────────────────────────────────

describe("get_repo_mapping — same remap, single-row get counterpart", () => {
	it("RED — owner cannot fetch their own mapping (fails pre-fix)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			MAPPING_ALPHA_OWN,
		);

		const handler = handlers.get("get_repo_mapping");
		expect(handler, "get_repo_mapping must be registered").toBeDefined();

		const result = await handler?.({ repo: MAPPING_ALPHA_OWN.repo });
		const parsed = parseResult(result) as { _id?: string };

		expect(parsed._id).toBe(MAPPING_ALPHA_OWN._id);
	});

	it("DENY — non-owner cannot fetch another orchestrator's mapping", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			MAPPING_BETA_OTHER,
		);

		const handler = handlers.get("get_repo_mapping");
		const result = await handler?.({ repo: MAPPING_BETA_OTHER.repo });

		expect(isErrorResult(result)).toBe(true);
	});

	it("MASTER sees any mapping", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, LOCAL_STDIO_TRUST_CTX);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			MAPPING_BETA_OTHER,
		);

		const handler = handlers.get("get_repo_mapping");
		const result = await handler?.({ repo: MAPPING_BETA_OTHER.repo });
		const parsed = parseResult(result) as { _id?: string };

		expect(parsed._id).toBe(MAPPING_BETA_OTHER._id);
	});

	it("does not leak the synthetic createdBy remap field", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			MAPPING_ALPHA_OWN,
		);

		const handler = handlers.get("get_repo_mapping");
		const result = await handler?.({ repo: MAPPING_ALPHA_OWN.repo });
		const parsed = parseResult(result) as Record<string, unknown>;

		expect(parsed).not.toHaveProperty("createdBy");
	});
});
