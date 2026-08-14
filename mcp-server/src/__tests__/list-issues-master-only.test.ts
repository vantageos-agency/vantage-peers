/**
 * list_issues / get_issue / issue_stats — refus-total closed by structural
 * removal from the client surface (issues has NO client-owner field).
 *
 * VP task k1759mg282aqy6t7c91gnk10598bn4sv, mission
 * vp-multitenant-zero-hole-v1 (final class sweep, 8 remaining instances).
 *
 * MEASURED (before fix): issues rows (schema.ts:421) carry no
 * `createdBy`-equivalent and no per-tenant `namespace` — `assignedOrchestrator`
 * /`fixedBy`/`verifiedBy` are fleet-operations routing fields, not tenant
 * ownership. scopeFilterList/scopeFilterGet found nothing to discriminate on
 * and refused EVERY non-master caller (refus-total — dead functionality, not
 * isolation, since there is no client owner to grant access back to). The
 * write mutations on this same table (update_issue_status,
 * link_commit_to_issue, verify_issue) are already `{ kind: "master" }`,
 * confirming issues is fleet-internal GitHub tracking data. The fix declares
 * all three read tools master-only (`{ kind: "master" }`) — a structural
 * removal from the client surface, mirroring list_errors/get_error. Intended
 * behavior change: non-master callers previously got a silent empty
 * list/null; they now get an explicit Forbidden error.
 *
 * NOTE (honest-bite discipline): list_issues' handler body ALSO retains an
 * in-handler `scopeFilterList` call (defense-in-depth left in place from the
 * prior `{ kind: "filtered" }` era). That in-handler call already denied
 * non-master callers before this fix — flipping the declared scope to
 * "master" does not by itself change list_issues' behavior for a
 * non-master caller (both poles already returned a Forbidden-shaped empty
 * result). The REAL behavior change proven here is the explicit
 * `Forbidden: this tool requires master scope` error text (vs. the prior
 * silent `{ count: 0, issues: [] }`), and get_issue/issue_stats — which have
 * NO in-handler scopeFilterGet-based master gate beyond the wrapper — where
 * the master-scope flip is the sole gate and the bite is unambiguous.
 *
 * METHOD CONSTRAINT: a positive control on a known-guarded tool
 * (get_briefing_note) runs first so a pattern that returns zero on a guarded
 * tool is disqualified from being read as "denied".
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
	const obj = parsed as { items?: Array<Record<string, unknown>>; issues?: Array<Record<string, unknown>> };
	return obj.items ?? obj.issues ?? [];
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

const MASTER_CALLER: OAuthContext = {
	clientId: "client-fixture-master",
	userId: "user-fixture-master",
	scopes: ["mcp:full"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3600_000,
	isMaster: true,
};

const ISSUE_ROW = {
	_id: "issue-fixture-001",
	_creationTime: 1780000000000,
	repo: "vantageos-agency/vantage-peers",
	issueNumber: 667,
	title: "boom",
	body: "repro steps",
	htmlUrl: "https://github.com/vantageos-agency/vantage-peers/issues/667",
	labels: [],
	status: "open",
	priority: "high",
	assignedOrchestrator: "omega",
	project: "vantage-peers",
	githubCreatedAt: 1780000000000,
	githubUpdatedAt: 1780000000000,
};

const STATS_ROW = {
	open: 3,
	in_progress: 1,
	fixed: 2,
	verified: 0,
	closed: 5,
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
		expect(isErrorResult(result)).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// list_issues
// ─────────────────────────────────────────────────────────────────────────────

describe("RED — list_issues refus-total reproduction (pre-fix behavior)", () => {
	it("non-master caller gets an EXPLICIT Forbidden, not a silent empty list", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			ISSUE_ROW,
		]);

		const handler = handlers.get("list_issues");
		expect(handler, "list_issues must be registered").toBeDefined();

		const result = await handler?.({});
		expect(
			isErrorResult(result),
			"pre-fix this silently returned { count: 0, issues: [] } (refus-total); post-fix it must be an explicit Forbidden",
		).toBe(true);
		const r = result as { content: Array<{ text: string }> };
		expect(r.content[0].text).toMatch(/master scope/i);
	});
});

describe("GREEN — list_issues master-only (four independent poles)", () => {
	it("(ii) 'OWNER' pole — there is no client owner, so non-master gets a clean deny", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			ISSUE_ROW,
		]);

		const handler = handlers.get("list_issues");
		const result = await handler?.({});

		expect(isErrorResult(result)).toBe(true);
	});

	it("(iii) DENY pole alone — non-master never receives issue rows", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			ISSUE_ROW,
		]);

		const handler = handlers.get("list_issues");
		const result = await handler?.({});
		const r = result as { content: Array<{ text: string }> };
		expect(r.content[0].text).not.toContain(String(ISSUE_ROW.issueNumber));
	});

	it("(iv) MASTER pole alone — master caller sees all rows", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, MASTER_CALLER);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			ISSUE_ROW,
		]);

		const handler = handlers.get("list_issues");
		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(parsed.some((i) => i._id === ISSUE_ROW._id)).toBe(true);
	});

	it("legacy bearer (oauthCtx undefined) still sees all rows", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, undefined);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			ISSUE_ROW,
		]);

		const handler = handlers.get("list_issues");
		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(parsed.some((i) => i._id === ISSUE_ROW._id)).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// get_issue — master-only, same class fix
// ─────────────────────────────────────────────────────────────────────────────

describe("get_issue — master-only, same class fix", () => {
	it("non-master caller is denied (RED reproduction)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			ISSUE_ROW,
		);

		const handler = handlers.get("get_issue");
		expect(handler, "get_issue must be registered").toBeDefined();

		const result = await handler?.({
			repo: ISSUE_ROW.repo,
			issueNumber: ISSUE_ROW.issueNumber,
		});
		expect(isErrorResult(result)).toBe(true);
	});

	it("master caller sees the row", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, MASTER_CALLER);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			ISSUE_ROW,
		);

		const handler = handlers.get("get_issue");
		const result = await handler?.({
			repo: ISSUE_ROW.repo,
			issueNumber: ISSUE_ROW.issueNumber,
		});
		const parsed = parseResult(result) as { _id?: string };

		expect(parsed._id).toBe(ISSUE_ROW._id);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// issue_stats — master-only, aggregate has no ownable rows
// ─────────────────────────────────────────────────────────────────────────────

describe("issue_stats — master-only, same class fix", () => {
	it("non-master caller is denied (RED reproduction)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			STATS_ROW,
		);

		const handler = handlers.get("issue_stats");
		expect(handler, "issue_stats must be registered").toBeDefined();

		const result = await handler?.({});
		expect(isErrorResult(result)).toBe(true);
	});

	it("master caller sees the aggregate", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, MASTER_CALLER);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			STATS_ROW,
		);

		const handler = handlers.get("issue_stats");
		const result = await handler?.({});
		const parsed = parseResult(result) as { open?: number };

		expect(parsed.open).toBe(3);
	});
});
