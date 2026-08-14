/**
 * E2E test: bearer→oauthCtx→action flow for KB ingest tools.
 *
 * Catches the ctx.auth-null-over-HTTP class of bug that the convex-test suite
 * cannot catch: convex-test injects identity via withIdentity, but the real
 * ConvexHttpClient (server-http.ts:1437) is constructed without setAuth, so
 * ctx.auth.getUserIdentity() is always null over HTTP.
 *
 * This test exercises the MCP layer (registerKbIngestTools) directly with a
 * synthetic oauthCtx, asserting that:
 *  1. The tool handler reads orgId from oauthCtx.namespaceWritePrefixes[0].
 *  2. The Convex action receives explicit orgId + namespace args (not ctx.auth).
 *  3. Master-scope and missing namespaceWritePrefixes are rejected at the MCP
 *     layer with AUTH_NO_ORG_ID before any Convex call is made.
 *
 * No convex-test, no withIdentity — the ConvexHttpClient is replaced with a
 * spy that records the args passed to convex.action().
 *
 * B4 #915 pattern reference: auth.ts:443-444 (namespaceWritePrefixes mint).
 * HTTP transport evidence: server-http.ts:1437 (no setAuth).
 * VP task: k17bdmhr2hffhz2t96p65j70nh891wcp.
 * Mission: k5779qbxhwrfjmj02t31yvehns8911jp.
 *
 * Orchestrator: Sigma — VantagePeers | 2026-06-27
 */

import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../auth.js";
import { registerKbIngestTools } from "../tools/kbIngest.js";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal McpServer stub — records registered tool handlers by name
// ─────────────────────────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function makeStubServer(): {
	tool: (
		name: string,
		description: string,
		schema: unknown,
		annotations: unknown,
		handler: ToolHandler,
	) => void;
	registerTool: (
		name: string,
		config: { description?: string; annotations?: unknown },
		handler: ToolHandler,
	) => void;
	handlers: Map<string, ToolHandler>;
} {
	const handlers = new Map<string, ToolHandler>();
	return {
		tool(name, _description, _schema, _annotations, handler) {
			handlers.set(name, handler);
		},
		// `server.registerTool(name, config, handler)` — the config-object entry
		// point defineTool() uses since the Day-159 boot fix (see
		// registerTool.ts).
		registerTool(name, _config, handler) {
			handlers.set(name, handler);
		},
		handlers,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal ConvexHttpClient stub — spy on action() calls
// ─────────────────────────────────────────────────────────────────────────────

function makeStubConvex(actionResult: unknown = { docId: "stub-doc", chunkCount: 1, storageId: "stub-storage" }) {
	const actionSpy = vi.fn().mockResolvedValue(actionResult);
	const stub = { action: actionSpy } as unknown as ConvexHttpClient;
	return { stub, actionSpy };
}

// ─────────────────────────────────────────────────────────────────────────────
// oauthCtx fixtures (mirrors auth.ts layer 2.5 output)
// ─────────────────────────────────────────────────────────────────────────────

const now = Date.now();

/** Clerk JWT with org_id = "org-A" — the happy path fixture. */
const teamACtx: OAuthContext = {
	clientId: "dcr-clerk-org-A",
	userId: "user-123",
	scopes: ["mcp:full"],
	scopeProfile: "team-member",
	fromAllowList: [],
	namespaceReadPrefixes: ["team/org-A"],
	namespaceWritePrefixes: ["team/org-A"],
	expiresAt: now + 3_600_000,
	isMaster: false,
};

/** Master-scope bearer — must be rejected (no team namespace). */
const masterCtx: OAuthContext = {
	clientId: "master",
	userId: "master",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: now + 3_600_000,
	isMaster: true,
};

/** Bearer with empty namespaceWritePrefixes — no org resolved. */
const noOrgCtx: OAuthContext = {
	clientId: "dcr-anon-claude-ai",
	userId: "anon-user",
	scopes: ["mcp:full"],
	scopeProfile: "client-generic",
	fromAllowList: [],
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	expiresAt: now + 3_600_000,
	isMaster: false,
};

/** undefined oauthCtx — legacy bearer / unauthenticated. */
const noCtx = undefined;

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("KB ingest E2E — bearer→oauthCtx→action (no withIdentity)", () => {
	it("happy path: store_document_chunked passes orgId='org-A' + namespace='team/org-A' to Convex action", async () => {
		const server = makeStubServer();
		const { stub, actionSpy } = makeStubConvex();

		registerKbIngestTools(server as never, stub, teamACtx);

		const handler = server.handlers.get("store_document_chunked");
		expect(handler).toBeDefined();
		if (!handler) throw new Error("store_document_chunked handler not registered");

		await handler({
			storageId: "fake-storage-id",
			mimeType: "text/markdown",
			filename: "spec.md",
		});

		// The Convex action must have been called with explicit orgId + namespace.
		// This is the key assertion: ctx.auth is NOT used — the args come from oauthCtx.
		expect(actionSpy).toHaveBeenCalledOnce();
		const [_ref, actionArgs] = actionSpy.mock.calls[0] as [unknown, Record<string, unknown>];
		expect(actionArgs.orgId).toBe("org-A");
		expect(actionArgs.namespace).toBe("team/org-A");
		expect(actionArgs.storageId).toBe("fake-storage-id");
		expect(actionArgs.mimeType).toBe("text/markdown");
		expect(actionArgs.filename).toBe("spec.md");
	});

	it("happy path: soft_delete_document passes orgId='org-A' + namespace='team/org-A' to Convex action", async () => {
		const server = makeStubServer();
		const { stub, actionSpy } = makeStubConvex({ docId: "doc-xyz", markedCount: 3 });

		registerKbIngestTools(server as never, stub, teamACtx);

		const handler = server.handlers.get("soft_delete_document");
		expect(handler).toBeDefined();
		if (!handler) throw new Error("soft_delete_document handler not registered");

		await handler({ docId: "doc-xyz" });

		expect(actionSpy).toHaveBeenCalledOnce();
		const [_ref, actionArgs] = actionSpy.mock.calls[0] as [unknown, Record<string, unknown>];
		expect(actionArgs.orgId).toBe("org-A");
		expect(actionArgs.namespace).toBe("team/org-A");
		expect(actionArgs.docId).toBe("doc-xyz");
	});

	it("master-scope bearer → store_document_chunked throws AUTH_NO_ORG_ID without calling Convex", async () => {
		const server = makeStubServer();
		const { stub, actionSpy } = makeStubConvex();

		registerKbIngestTools(server as never, stub, masterCtx);

		const handler = server.handlers.get("store_document_chunked");
		expect(handler).toBeDefined();
		if (!handler) throw new Error("store_document_chunked handler not registered");

		await expect(
			handler({ storageId: "x", mimeType: "text/plain", filename: "x.txt" }),
		).rejects.toThrow(/AUTH_NO_ORG_ID/);

		// Convex action must NOT have been called — rejection happens in MCP layer
		expect(actionSpy).not.toHaveBeenCalled();
	});

	it("empty namespaceWritePrefixes → store_document_chunked throws AUTH_NO_ORG_ID without calling Convex", async () => {
		const server = makeStubServer();
		const { stub, actionSpy } = makeStubConvex();

		registerKbIngestTools(server as never, stub, noOrgCtx);

		const handler = server.handlers.get("store_document_chunked");
		expect(handler).toBeDefined();
		if (!handler) throw new Error("store_document_chunked handler not registered");

		await expect(
			handler({ storageId: "x", mimeType: "text/plain", filename: "x.txt" }),
		).rejects.toThrow(/AUTH_NO_ORG_ID/);

		expect(actionSpy).not.toHaveBeenCalled();
	});

	it("undefined oauthCtx (legacy bearer) → store_document_chunked throws AUTH_NO_ORG_ID without calling Convex", async () => {
		const server = makeStubServer();
		const { stub, actionSpy } = makeStubConvex();

		registerKbIngestTools(server as never, stub, noCtx);

		const handler = server.handlers.get("store_document_chunked");
		expect(handler).toBeDefined();
		if (!handler) throw new Error("store_document_chunked handler not registered");

		await expect(
			handler({ storageId: "x", mimeType: "text/plain", filename: "x.txt" }),
		).rejects.toThrow(/AUTH_NO_ORG_ID/);

		expect(actionSpy).not.toHaveBeenCalled();
	});

	it("MCP layer surfaces AUTH_STORAGE_NOT_OWNED on cross-tenant storageId", async () => {
		// Simulate: first call succeeds (org-A owns the storageId), second call from
		// org-A again succeeds, but a spy that has been configured to throw on the
		// second invocation will surface AUTH_STORAGE_NOT_OWNED to the MCP caller.
		//
		// The Convex action throws AUTH_STORAGE_NOT_OWNED when the kbUploads binding
		// check fails (bindOrAssertStorageOwnership). This test verifies the MCP tool
		// handler does NOT swallow that error — it propagates to the caller unchanged.
		const server = makeStubServer();
		const actionSpy = vi
			.fn()
			.mockResolvedValueOnce({ docId: "doc-A", chunkCount: 2, storageId: "shared-storage-id" })
			.mockRejectedValueOnce(new Error("AUTH_STORAGE_NOT_OWNED: storageId does not belong to this org."));
		const stub = { action: actionSpy } as unknown as import("convex/browser").ConvexHttpClient;

		registerKbIngestTools(server as never, stub, teamACtx);

		const handler = server.handlers.get("store_document_chunked");
		expect(handler).toBeDefined();
		if (!handler) throw new Error("store_document_chunked handler not registered");

		// First call — succeeds (TOFU binding created in Convex for org-A).
		// The MCP tool wraps the Convex result in { content: [{ type:"text", text: JSON }] }.
		const firstResult = await handler({
			storageId: "shared-storage-id",
			mimeType: "text/markdown",
			filename: "doc.md",
		}) as { content: Array<{ type: string; text: string }> };
		expect(firstResult).toHaveProperty("content");
		const parsed = JSON.parse(firstResult.content[0].text) as Record<string, unknown>;
		expect(parsed).toMatchObject({ docId: "doc-A", chunkCount: 2 });

		// Second call — Convex throws AUTH_STORAGE_NOT_OWNED (cross-tenant attempt);
		// the MCP tool must propagate the error, not swallow it.
		await expect(
			handler({
				storageId: "shared-storage-id",
				mimeType: "text/markdown",
				filename: "inject.md",
			}),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);

		expect(actionSpy).toHaveBeenCalledTimes(2);
	});
});
