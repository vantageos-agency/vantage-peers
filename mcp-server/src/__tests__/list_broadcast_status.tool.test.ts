// ─────────────────────────────────────────────────────────────────────────────
// list_broadcast_status.tool.test.ts — TDD RED-before-GREEN.
// ─────────────────────────────────────────────────────────────────────────────
//
// LIVE DEFECT (GitHub issue, reproduced by 3 people): `list_broadcast_status`
// returns "Server Error" on every call.
//
// DEFECT 1 (crash) — the wrapper always injects `limit` into the Convex call
// even when the caller omits it (`limit: limit ?? 20`), but the backend
// historically declared no `limit` arg → ArgumentValidationError on every
// call. Backend-level RED for this is in
// convex/__tests__/listBroadcastStatus.contract.test.ts.
//
// DEFECT 2 (silent, hides behind the crash) — the backend returns a single
// OBJECT `{ messageId, from, channel, createdAt, receipts: [...] }`, but the
// wrapper does `scopeFilterList(oauthCtx, Array.isArray(status) ? status : [])`
// against a `z.array(...)` output schema. Once Defect 1 is fixed, the tool
// would return `[]` — "nobody read this broadcast" — instead of the real
// receipts. This file's tests are RED against the unmodified wrapper because
// the mock convex client returns the real object shape (not an array).
// ─────────────────────────────────────────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { registerTools } from "../tools.js";
import type { OAuthContext } from "../auth.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}>;

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

const masterCtx: OAuthContext = {
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

const REAL_STATUS_OBJECT = {
	messageId: "j57dy3049btafda9m2f5d2ggk987ph3f",
	from: "pi",
	channel: "broadcast",
	createdAt: 1000,
	receipts: [
		{ recipient: "tau", read: true, readAt: 2000 },
		{ recipient: "phi", read: false },
		{ recipient: "sigma", read: true, readAt: 2100 },
	],
	truncated: false,
};

function buildMockConvex(response: unknown = REAL_STATUS_OBJECT): ConvexHttpClient {
	return {
		query: vi.fn().mockResolvedValue(response),
		mutation: vi.fn().mockResolvedValue(null),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
}

describe("list_broadcast_status — does not throw ArgumentValidationError", () => {
	it("with an explicit limit argument", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, masterCtx);
		const handler = handlers.get("list_broadcast_status")!;

		const result = await handler({
			messageId: "j57dy3049btafda9m2f5d2ggk987ph3f",
			limit: 20,
		});

		expect(result.isError).not.toBe(true);
		expect(result.content[0].text).not.toContain("ArgumentValidationError");
	});

	it("with no limit argument at all (the exact incident repro)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, masterCtx);
		const handler = handlers.get("list_broadcast_status")!;

		const result = await handler({
			messageId: "j57dy3049btafda9m2f5d2ggk987ph3f",
		});

		expect(result.isError).not.toBe(true);
		expect(result.content[0].text).not.toContain("ArgumentValidationError");
	});
});

describe("list_broadcast_status — returned payload actually contains receipts (Defect 2)", () => {
	it("does NOT collapse the real object into an empty array", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, masterCtx);
		const handler = handlers.get("list_broadcast_status")!;

		const result = await handler({
			messageId: "j57dy3049btafda9m2f5d2ggk987ph3f",
		});

		const parsed = JSON.parse(result.content[0].text);
		// Defect 2 repro: unmodified wrapper does
		// `Array.isArray(status) ? status : []` against an object → `[]`.
		expect(Array.isArray(parsed)).toBe(false);
		expect(parsed.receipts).toBeDefined();
		expect(parsed.receipts.length).toBe(3);
		expect(parsed.receipts.map((r: any) => r.recipient)).toEqual(
			expect.arrayContaining(["tau", "phi", "sigma"]),
		);
	});

	it("preserves envelope metadata (from, channel, createdAt) alongside receipts", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, masterCtx);
		const handler = handlers.get("list_broadcast_status")!;

		const result = await handler({
			messageId: "j57dy3049btafda9m2f5d2ggk987ph3f",
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.from).toBe("pi");
		expect(parsed.channel).toBe("broadcast");
		expect(parsed.createdAt).toBe(1000);
	});
});

describe("list_broadcast_status — truncation signal survives the wrapper", () => {
	it("a truncated receipts list is flagged, never rendered as complete", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex({
			...REAL_STATUS_OBJECT,
			receipts: REAL_STATUS_OBJECT.receipts.slice(0, 2),
			truncated: true,
		});
		registerTools(server, convex, masterCtx);
		const handler = handlers.get("list_broadcast_status")!;

		const result = await handler({
			messageId: "j57dy3049btafda9m2f5d2ggk987ph3f",
			limit: 2,
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.receipts.length).toBe(2);
		expect(parsed.truncated).toBe(true);
	});

	it("truncated=false when the full list fits under limit", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, masterCtx);
		const handler = handlers.get("list_broadcast_status")!;

		const result = await handler({
			messageId: "j57dy3049btafda9m2f5d2ggk987ph3f",
			limit: 200,
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.truncated).toBe(false);
	});
});

describe("list_broadcast_status — scope filtering applies to receipts, not the envelope", () => {
	it("non-master scope still receives the envelope even if some receipts are filtered out", async () => {
		const scopedCtx: OAuthContext = {
			clientId: "scoped-client",
			userId: "scoped",
			scopes: ["vantage:read"],
			scopeProfile: "scoped",
			fromAllowList: ["tau"],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() + 3600_000,
			isMaster: false,
		};
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, scopedCtx);
		const handler = handlers.get("list_broadcast_status")!;

		const result = await handler({
			messageId: "j57dy3049btafda9m2f5d2ggk987ph3f",
		});
		const parsed = JSON.parse(result.content[0].text);

		// Envelope survives regardless of scope.
		expect(parsed.messageId).toBe("j57dy3049btafda9m2f5d2ggk987ph3f");
		expect(parsed.from).toBe("pi");
		// Only the receipt whose recipient is in fromAllowList passes.
		expect(parsed.receipts.map((r: any) => r.recipient)).toEqual(["tau"]);
	});
});
