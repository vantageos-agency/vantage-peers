/**
 * list_bus — refus-total fix (businessUnits rows lack createdBy/namespace).
 *
 * VP task k177617dqg6z5c099p1rdp5rqn8b2rp0.
 *
 * MEASURED (before fix): businessUnits rows carry `orchestratorId` (the BU's
 * lead orchestrator, schema.ts:499), NOT `createdBy` and NOT `namespace`.
 * Passing rows through scopeFilterList unmapped finds no field to
 * discriminate on and refuses EVERY non-master caller — the lead
 * orchestrator included (refus-total), not a targeted cross-tenant leak.
 * The fix remaps `orchestratorId` -> `createdBy` before calling
 * scopeFilterList (same pattern established by list_broadcast_status,
 * tools.ts:~3502), then strips the synthetic field from the response.
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

const BU_ALPHA_OWN = {
	_id: "bu-fixture-alpha-001",
	_creationTime: 1780000001000,
	name: "AlphaBU",
	orchestratorId: "alpha",
	status: "live",
};

const BU_BETA_OTHER = {
	_id: "bu-fixture-beta-001",
	_creationTime: 1780000000000,
	name: "BetaBU",
	orchestratorId: "beta",
	status: "live",
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
// 1. RED — the owner cannot see their own BU today (refus-total reproduction)
// ─────────────────────────────────────────────────────────────────────────────

describe("RED — list_bus refus-total reproduction (pre-fix behavior)", () => {
	it("owning orchestrator's OWN business unit is returned (fails pre-fix)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			items: [BU_ALPHA_OWN],
			nextCursor: null,
		});

		const handler = handlers.get("list_bus");
		expect(handler, "list_bus must be registered").toBeDefined();

		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(
			parsed.some((bu) => bu._id === BU_ALPHA_OWN._id),
			"a guard that refuses everyone including the lead orchestrator is refus-total, not isolation",
		).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GREEN — four independent poles
// ─────────────────────────────────────────────────────────────────────────────

describe("GREEN — list_bus scoped correctly (four independent poles)", () => {
	it("(ii) OWNER pole alone — alpha sees its own BU", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			items: [BU_ALPHA_OWN, BU_BETA_OTHER],
			nextCursor: null,
		});

		const handler = handlers.get("list_bus");
		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(parsed.some((bu) => bu._id === BU_ALPHA_OWN._id)).toBe(true);
	});

	it("(iii) DENY pole alone — beta's BU is not rendered to alpha", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			items: [BU_ALPHA_OWN, BU_BETA_OTHER],
			nextCursor: null,
		});

		const handler = handlers.get("list_bus");
		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(parsed.some((bu) => bu._id === BU_BETA_OTHER._id)).toBe(false);
	});

	it("(iv) MASTER pole alone — legacy/master callers see all rows unfiltered", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, undefined);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			items: [BU_ALPHA_OWN, BU_BETA_OTHER],
			nextCursor: null,
		});

		const handler = handlers.get("list_bus");
		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(parsed.length).toBe(2);
	});

	it("does not leak the synthetic `createdBy` remap field into the response", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			items: [BU_ALPHA_OWN],
			nextCursor: null,
		});

		const handler = handlers.get("list_bus");
		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(parsed[0]).not.toHaveProperty("createdBy");
		expect(parsed[0]).toHaveProperty("orchestratorId", "alpha");
	});
});

describe("get_bu — same remap, single-row get counterpart", () => {
	it("RED — owner cannot fetch their own BU (fails pre-fix)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			BU_ALPHA_OWN,
		);

		const handler = handlers.get("get_bu");
		expect(handler, "get_bu must be registered").toBeDefined();

		const result = await handler?.({ buId: BU_ALPHA_OWN._id });
		const parsed = parseResult(result) as { _id?: string };

		expect(parsed._id).toBe(BU_ALPHA_OWN._id);
	});

	it("DENY — non-owner cannot fetch another BU", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			BU_BETA_OTHER,
		);

		const handler = handlers.get("get_bu");
		const result = await handler?.({ buId: BU_BETA_OTHER._id });
		const parsed = parseResult(result);

		expect(parsed).toBeNull();
	});

	it("MASTER sees any BU", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, undefined);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			BU_BETA_OTHER,
		);

		const handler = handlers.get("get_bu");
		const result = await handler?.({ buId: BU_BETA_OTHER._id });
		const parsed = parseResult(result) as { _id?: string };

		expect(parsed._id).toBe(BU_BETA_OTHER._id);
	});

	it("does not leak the synthetic createdBy remap field", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			BU_ALPHA_OWN,
		);

		const handler = handlers.get("get_bu");
		const result = await handler?.({ buId: BU_ALPHA_OWN._id });
		const parsed = parseResult(result) as Record<string, unknown>;

		expect(parsed).not.toHaveProperty("createdBy");
	});
});
