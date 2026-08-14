/**
 * get_message — refus-total fix (message rows carry `from`, not
 * createdBy/namespace).
 *
 * VP task k1759mg282aqy6t7c91gnk10598bn4sv, mission
 * vp-multitenant-zero-hole-v1 (final class sweep, 8 remaining instances).
 *
 * MEASURED (before fix): message rows (schema.ts:148) carry `from`
 * (creatorValidator), NOT `createdBy` and NOT `namespace`. Passing rows
 * through scopeFilterGet unmapped finds no field to discriminate on and
 * refuses EVERY non-master caller — the sender included (refus-total). Same
 * remedy already applied to list_messages/search_messages_by_keyword/
 * list_broadcast_status, but this single-row get was missed in that sweep:
 * remap `from` -> `createdBy` before scopeFilterGet, then strip the
 * synthetic field from the response.
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

const MESSAGE_FROM_ALPHA = {
	_id: "message-fixture-alpha-001",
	_creationTime: 1780000001000,
	from: "alpha",
	channel: "broadcast",
	content: "alpha's own message",
	createdAt: 1780000001000,
};

const MESSAGE_FROM_BETA = {
	_id: "message-fixture-beta-001",
	_creationTime: 1780000000000,
	from: "beta",
	channel: "broadcast",
	content: "beta's message",
	createdAt: 1780000000000,
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
// get_message
// ─────────────────────────────────────────────────────────────────────────────

describe("RED — get_message refus-total reproduction (pre-fix behavior)", () => {
	it("sender cannot fetch their own message (fails pre-fix)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			MESSAGE_FROM_ALPHA,
		);

		const handler = handlers.get("get_message");
		expect(handler, "get_message must be registered").toBeDefined();

		const result = await handler?.({
			messageId: MESSAGE_FROM_ALPHA._id,
		});
		const parsed = parseResult(result) as { _id?: string };

		expect(parsed._id).toBe(MESSAGE_FROM_ALPHA._id);
	});
});

describe("GREEN — get_message scoped correctly (four independent poles)", () => {
	it("(ii) OWNER pole alone — alpha fetches its own message", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			MESSAGE_FROM_ALPHA,
		);

		const handler = handlers.get("get_message");
		const result = await handler?.({
			messageId: MESSAGE_FROM_ALPHA._id,
		});
		const parsed = parseResult(result) as { _id?: string };

		expect(parsed._id).toBe(MESSAGE_FROM_ALPHA._id);
	});

	it("(iii) DENY pole alone — beta's message is not returned to alpha", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			MESSAGE_FROM_BETA,
		);

		const handler = handlers.get("get_message");
		const result = await handler?.({
			messageId: MESSAGE_FROM_BETA._id,
		});

		expect(isErrorResult(result)).toBe(true);
	});

	it("(iv) MASTER pole alone — legacy/master callers see any message", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, undefined);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			MESSAGE_FROM_BETA,
		);

		const handler = handlers.get("get_message");
		const result = await handler?.({
			messageId: MESSAGE_FROM_BETA._id,
		});
		const parsed = parseResult(result) as { _id?: string };

		expect(parsed._id).toBe(MESSAGE_FROM_BETA._id);
	});

	it("does not leak the synthetic `createdBy` remap field into the response", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			MESSAGE_FROM_ALPHA,
		);

		const handler = handlers.get("get_message");
		const result = await handler?.({
			messageId: MESSAGE_FROM_ALPHA._id,
		});
		const parsed = parseResult(result) as Record<string, unknown>;

		expect(parsed).not.toHaveProperty("createdBy");
		expect(parsed).toHaveProperty("from", "alpha");
	});
});
