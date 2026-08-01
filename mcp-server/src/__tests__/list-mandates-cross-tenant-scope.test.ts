/**
 * list_mandates — refus-total fix (mandates rows lack createdBy/namespace).
 *
 * VP task k177617dqg6z5c099p1rdp5rqn8b2rp0.
 *
 * MEASURED (before fix): mandates rows carry `requestedBy` AND `fulfilledBy`
 * (schema.ts:388-389, creatorValidator), NOT `createdBy` and NOT `namespace`.
 * Passing rows through scopeFilterList unmapped finds no field to
 * discriminate on and refuses EVERY non-master caller — requester and
 * fulfiller included (refus-total). A mandate has TWO legitimate client
 * owners (either party), so the fix remaps onto `createdBy` twice (once per
 * side) and unions the surviving rows by `_id`.
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

// alpha is the REQUESTER
const MANDATE_ALPHA_REQUESTED = {
	_id: "mandate-fixture-001",
	_creationTime: 1780000002000,
	requestedBy: "alpha",
	fulfilledBy: "beta",
	service: "seo audit",
	budget: 1000,
	status: "in_progress",
};

// alpha is the FULFILLER
const MANDATE_ALPHA_FULFILLED = {
	_id: "mandate-fixture-002",
	_creationTime: 1780000001000,
	requestedBy: "gamma",
	fulfilledBy: "alpha",
	service: "content review",
	budget: 500,
	status: "accepted",
};

// alpha is neither party
const MANDATE_OTHER = {
	_id: "mandate-fixture-003",
	_creationTime: 1780000000000,
	requestedBy: "beta",
	fulfilledBy: "gamma",
	service: "development",
	budget: 2000,
	status: "requested",
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
// 1. RED — requester/fulfiller cannot see their own mandate today
// ─────────────────────────────────────────────────────────────────────────────

describe("RED — list_mandates refus-total reproduction (pre-fix behavior)", () => {
	it("requester's OWN mandate is returned (fails pre-fix)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			MANDATE_ALPHA_REQUESTED,
		]);

		const handler = handlers.get("list_mandates");
		expect(handler, "list_mandates must be registered").toBeDefined();

		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(
			parsed.some((m) => m._id === MANDATE_ALPHA_REQUESTED._id),
			"a guard that refuses everyone including the requester is refus-total, not isolation",
		).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GREEN — four independent poles (plus the fulfiller-side owner pole)
// ─────────────────────────────────────────────────────────────────────────────

describe("GREEN — list_mandates scoped correctly (four independent poles)", () => {
	it("(ii) OWNER pole — requester side — alpha sees the mandate it requested", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			MANDATE_ALPHA_REQUESTED,
			MANDATE_ALPHA_FULFILLED,
			MANDATE_OTHER,
		]);

		const handler = handlers.get("list_mandates");
		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(parsed.some((m) => m._id === MANDATE_ALPHA_REQUESTED._id)).toBe(
			true,
		);
	});

	it("(ii-b) OWNER pole — fulfiller side — alpha sees the mandate it fulfills", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			MANDATE_ALPHA_REQUESTED,
			MANDATE_ALPHA_FULFILLED,
			MANDATE_OTHER,
		]);

		const handler = handlers.get("list_mandates");
		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(parsed.some((m) => m._id === MANDATE_ALPHA_FULFILLED._id)).toBe(
			true,
		);
	});

	it("(iii) DENY pole alone — a mandate alpha is no party to is not rendered", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			MANDATE_ALPHA_REQUESTED,
			MANDATE_ALPHA_FULFILLED,
			MANDATE_OTHER,
		]);

		const handler = handlers.get("list_mandates");
		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(parsed.some((m) => m._id === MANDATE_OTHER._id)).toBe(false);
	});

	it("(iv) MASTER pole alone — legacy/master callers see all rows unfiltered", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, undefined);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			MANDATE_ALPHA_REQUESTED,
			MANDATE_ALPHA_FULFILLED,
			MANDATE_OTHER,
		]);

		const handler = handlers.get("list_mandates");
		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(parsed.length).toBe(3);
	});
});

describe("get_mandate — same two-sided remap, single-row get counterpart", () => {
	it("RED/GREEN requester-side — requester can fetch their own mandate", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			MANDATE_ALPHA_REQUESTED,
		);

		const handler = handlers.get("get_mandate");
		expect(handler, "get_mandate must be registered").toBeDefined();

		const result = await handler?.({ mandateId: MANDATE_ALPHA_REQUESTED._id });
		const parsed = parseResult(result) as { _id?: string };

		expect(parsed._id).toBe(MANDATE_ALPHA_REQUESTED._id);
	});

	it("GREEN fulfiller-side — fulfiller can fetch a mandate it fulfills", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			MANDATE_ALPHA_FULFILLED,
		);

		const handler = handlers.get("get_mandate");
		const result = await handler?.({ mandateId: MANDATE_ALPHA_FULFILLED._id });
		const parsed = parseResult(result) as { _id?: string };

		expect(parsed._id).toBe(MANDATE_ALPHA_FULFILLED._id);
	});

	it("DENY — a mandate alpha is no party to is not fetchable", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			MANDATE_OTHER,
		);

		const handler = handlers.get("get_mandate");
		const result = await handler?.({ mandateId: MANDATE_OTHER._id });

		expect(isErrorResult(result)).toBe(true);
	});

	it("MASTER sees any mandate", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, undefined);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			MANDATE_OTHER,
		);

		const handler = handlers.get("get_mandate");
		const result = await handler?.({ mandateId: MANDATE_OTHER._id });
		const parsed = parseResult(result) as { _id?: string };

		expect(parsed._id).toBe(MANDATE_OTHER._id);
	});
});
