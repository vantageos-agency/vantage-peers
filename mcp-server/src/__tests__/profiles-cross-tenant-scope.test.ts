/**
 * get_profile / list_peers — refus-total fix (profiles rows lack
 * createdBy/namespace).
 *
 * VP task k1759mg282aqy6t7c91gnk10598bn4sv, mission
 * vp-multitenant-zero-hole-v1 (final class sweep, 8 remaining instances).
 *
 * MEASURED (before fix): profiles rows (schema.ts:118) carry `orchestratorId`
 * (the profile owner), NOT `createdBy` and NOT `namespace`. Passing rows
 * through scopeFilterGet/scopeFilterList unmapped finds no field to
 * discriminate on and refuses EVERY non-master caller — the owning
 * orchestrator included (refus-total), not a targeted cross-tenant leak.
 * The fix remaps `orchestratorId` -> `createdBy` before calling
 * scopeFilterGet/scopeFilterList (same pattern established by
 * list_broadcast_status, tools.ts:~3607), then strips the synthetic field
 * from single-row responses (list_peers' output projection never surfaces
 * `createdBy` in the first place, so no explicit strip is needed there).
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

const PROFILE_ALPHA_OWN = {
	_id: "profile-fixture-alpha-001",
	_creationTime: 1780000001000,
	orchestratorId: "alpha",
	instanceId: "alpha-vps",
	name: "Alpha",
	static: { role: "engineer", workspace: "/root/alpha", capabilities: [] },
	dynamic: { lastSeen: 1780000001000, sessionCount: 5 },
};

const PROFILE_BETA_OTHER = {
	_id: "profile-fixture-beta-001",
	_creationTime: 1780000000000,
	orchestratorId: "beta",
	instanceId: "beta-vps",
	name: "Beta",
	static: { role: "engineer", workspace: "/root/beta", capabilities: [] },
	dynamic: { lastSeen: 1780000000000, sessionCount: 2 },
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
// get_profile
// ─────────────────────────────────────────────────────────────────────────────

describe("RED — get_profile refus-total reproduction (pre-fix behavior)", () => {
	it("owning orchestrator cannot fetch their own profile (fails pre-fix)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			PROFILE_ALPHA_OWN,
		);

		const handler = handlers.get("get_profile");
		expect(handler, "get_profile must be registered").toBeDefined();

		const result = await handler?.({ orchestratorId: "alpha" });
		const parsed = parseResult(result) as { orchestratorId?: string };

		expect(parsed?.orchestratorId).toBe("alpha");
	});
});

describe("GREEN — get_profile scoped correctly (four independent poles)", () => {
	it("(ii) OWNER pole alone — alpha sees its own profile", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			PROFILE_ALPHA_OWN,
		);

		const handler = handlers.get("get_profile");
		const result = await handler?.({ orchestratorId: "alpha" });
		const parsed = parseResult(result) as { orchestratorId?: string };

		expect(parsed?.orchestratorId).toBe("alpha");
	});

	it("(iii) DENY pole alone — beta's profile is not rendered to alpha", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			PROFILE_BETA_OTHER,
		);

		const handler = handlers.get("get_profile");
		const result = await handler?.({ orchestratorId: "beta" });
		const parsed = parseResult(result);

		expect(parsed).toBeNull();
	});

	it("(iv) MASTER pole alone — legacy/master callers see any profile", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, LOCAL_STDIO_TRUST_CTX);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			PROFILE_BETA_OTHER,
		);

		const handler = handlers.get("get_profile");
		const result = await handler?.({ orchestratorId: "beta" });
		const parsed = parseResult(result) as { orchestratorId?: string };

		expect(parsed?.orchestratorId).toBe("beta");
	});

	it("does not leak the synthetic `createdBy` remap field into the response", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			PROFILE_ALPHA_OWN,
		);

		const handler = handlers.get("get_profile");
		const result = await handler?.({ orchestratorId: "alpha" });
		const parsed = parseResult(result) as Record<string, unknown>;

		expect(parsed).not.toHaveProperty("createdBy");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// list_peers — same remap, list counterpart
// ─────────────────────────────────────────────────────────────────────────────

describe("RED — list_peers refus-total reproduction (pre-fix behavior)", () => {
	it("owning orchestrator's OWN profile is returned (fails pre-fix)", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			PROFILE_ALPHA_OWN,
		]);

		const handler = handlers.get("list_peers");
		expect(handler, "list_peers must be registered").toBeDefined();

		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(
			parsed.some((p) => p.id === "alpha"),
			"a guard that refuses everyone including the owning orchestrator is refus-total, not isolation",
		).toBe(true);
	});
});

describe("GREEN — list_peers scoped correctly (four independent poles)", () => {
	it("(ii) OWNER pole alone — alpha sees its own peer entry", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			PROFILE_ALPHA_OWN,
			PROFILE_BETA_OTHER,
		]);

		const handler = handlers.get("list_peers");
		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(parsed.some((p) => p.id === "alpha")).toBe(true);
	});

	it("(iii) DENY pole alone — beta's peer entry is not rendered to alpha", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			PROFILE_ALPHA_OWN,
			PROFILE_BETA_OTHER,
		]);

		const handler = handlers.get("list_peers");
		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(parsed.some((p) => p.id === "beta")).toBe(false);
	});

	it("(iv) MASTER pole alone — legacy/master callers see all peers unfiltered", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, LOCAL_STDIO_TRUST_CTX);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			PROFILE_ALPHA_OWN,
			PROFILE_BETA_OTHER,
		]);

		const handler = handlers.get("list_peers");
		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(parsed.length).toBe(2);
	});

	it("does not leak the synthetic `createdBy` remap field into the response", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, CALLER_ALPHA);

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			PROFILE_ALPHA_OWN,
		]);

		const handler = handlers.get("list_peers");
		const result = await handler?.({});
		const parsed = items(parseResult(result));

		expect(parsed[0]).not.toHaveProperty("createdBy");
		expect(parsed[0]).toHaveProperty("id", "alpha");
	});
});
