/**
 * get_briefing_note / list_briefing_notes — participant visibility (Day 165).
 *
 * VP task k175ga65p654z200ydj7s8qv5s8cnxfc.
 *
 * BUG: a briefing note shared via its `participants` array was NOT readable
 * by a SCOPED participant. get_briefing_note for a note with
 * createdBy="sigma", participants=["pi","sigma","prometheus","laurent"]
 * returned "not found" for a caller scoped fromAllowList=["prometheus"] — it
 * worked only for master, which bypasses scopeFilterGet entirely (that's why
 * the bug was masked).
 *
 * FIX CONTRACT asserted here (MCP-server layer):
 *   1. The MCP handler threads `master`/`callerIdentities` into the Convex
 *      query args — the query itself is now the visibility gate.
 *   2. A note Convex returns (because the caller is a participant, even
 *      though NOT the creator) is not re-rejected by the generic
 *      scopeFilterGet/scopeFilterList post-query filter, which only ever
 *      understood createdBy/namespace.
 *   3. A non-participant, non-creator scoped caller still gets "not found"
 *      (no cross-tenant leak — this is the pole that already worked and
 *      must not regress).
 *   4. Master still sees everything, unfiltered.
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
		query: vi.fn().mockResolvedValue(null),
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

const CALLER_PROMETHEUS: OAuthContext = {
	clientId: "client-fixture-prometheus",
	userId: "user-fixture-prometheus",
	scopes: ["mcp:full"],
	scopeProfile: "tenant",
	fromAllowList: ["prometheus"],
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	expiresAt: Date.now() + 3600_000,
	isMaster: false,
};

const NOTE_ID = "note-fixture-shared-001";

// Convex, once the fix is in place, would only ever RETURN this row to
// "prometheus" because the query itself resolved participant membership
// (by_participant_note index) server-side — createdBy stays "sigma".
const SHARED_NOTE = {
	_id: NOTE_ID,
	_creationTime: 1780000000000,
	title: "handoff",
	topic: "daily",
	participants: ["pi", "sigma", "prometheus", "laurent"],
	content: "shared handoff content",
	createdBy: "sigma",
	createdAt: 1780000000000,
};

describe("get_briefing_note — threads caller identity into the Convex query (Day 165)", () => {
	it("calls briefingNotes:get with master=false and callerIdentities=fromAllowList", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_PROMETHEUS);
		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			SHARED_NOTE,
		);

		const handler = handlers.get("get_briefing_note");
		await handler?.({ noteId: NOTE_ID });

		expect(convex.query).toHaveBeenCalledWith(
			"briefingNotes:get",
			expect.objectContaining({
				noteId: NOTE_ID,
				master: false,
				callerIdentities: ["prometheus"],
			}),
		);
	});

	it("a participant who did NOT create the note still receives it (createdBy remap survives scopeFilterGet)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_PROMETHEUS);
		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			SHARED_NOTE,
		);

		const handler = handlers.get("get_briefing_note");
		const result = await handler?.({ noteId: NOTE_ID });

		expect(isErrorResult(result)).toBe(false);
		const parsed = parseResult(result) as { title?: string; createdBy?: string };
		expect(parsed.title).toBe("handoff");
		// The true creator is preserved on output (remap is undone).
		expect(parsed.createdBy).toBe("sigma");
	});

	it("a non-participant, non-creator scoped caller still gets not-found (no regression)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_PROMETHEUS);
		// Convex query itself returns null for a caller with no visibility.
		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

		const handler = handlers.get("get_briefing_note");
		const result = await handler?.({ noteId: "note-fixture-other-999" });

		expect(isErrorResult(result)).toBe(true);
	});

	it("master sees the note unfiltered and threads master=true, callerIdentities=undefined", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, undefined); // legacy/master path

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			SHARED_NOTE,
		);

		const handler = handlers.get("get_briefing_note");
		const result = await handler?.({ noteId: NOTE_ID });

		expect(convex.query).toHaveBeenCalledWith(
			"briefingNotes:get",
			expect.objectContaining({
				noteId: NOTE_ID,
				master: true,
				callerIdentities: undefined,
			}),
		);
		expect(isErrorResult(result)).toBe(false);
		const parsed = parseResult(result) as { createdBy?: string };
		expect(parsed.createdBy).toBe("sigma");
	});
});

describe("list_briefing_notes — threads caller identity into the Convex query (Day 165)", () => {
	it("calls briefingNotes:list with master/callerIdentities and preserves createdBy on a participant-shared note", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_PROMETHEUS);
		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			SHARED_NOTE,
		]);

		const handler = handlers.get("list_briefing_notes");
		const result = await handler?.({});

		expect(convex.query).toHaveBeenCalledWith(
			"briefingNotes:list",
			expect.objectContaining({
				master: false,
				callerIdentities: ["prometheus"],
			}),
		);
		const text = (
			result as { content: Array<{ type: string; text: string }> }
		).content[0].text;
		const parsed = JSON.parse(text) as Array<{ createdBy?: string }> | {
			items: Array<{ createdBy?: string }>;
		};
		const items = Array.isArray(parsed) ? parsed : parsed.items;
		expect(items.some((n) => n.createdBy === "sigma")).toBe(true);
	});
});
