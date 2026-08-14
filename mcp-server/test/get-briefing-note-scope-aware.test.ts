/**
 * S3.1.C Wave C Phase C0 — get_briefing_note MCP tool registration +
 * scope-aware filter (scopeFilterGet) applied to the single-row return path.
 *
 * Sprint    S3.1.C
 * Mission   k57c7s478gw1a3e5gmhdeptg5n87z78n
 * Task      k17fjd4dvp34k9q57t5e1qzrv187zz9n
 * Precedent Wave A SHA 251d183 (get_memory slice tests)
 *           Wave B SHA 28db616 (list_briefing_notes slice tests)
 *
 * Context (from Wave B handoff): `get_briefing_note` is NOT registered as an
 * MCP tool in `mcp-server/src/tools.ts`. Only create / update / list /
 * delete_briefing_note exist. Phase C0 = registration prerequisite for the
 * rest of Wave C. This file ships:
 *
 *   U1 — get_briefing_note returns the note when caller has scope access.
 *   U2 — null/absent backend result collapses to null (not-found shape).
 *   U3 — oauthCtx undefined (legacy bearer) returns the note unconditionally.
 *   U4 — master scope returns the note even for foreign tenant rows.
 *   U5 — scoped caller whose scope rejects the row gets null (non-leaky 404).
 *   M1 — cross-tenant: tenant-A row, tenant-B caller → null.
 *   M2 — namespace-prefix allowed: orchestrator/marie/x row + prefix
 *        orchestrator/marie → returned.
 *   M3 — createdBy fromAllowList: row.createdBy=marie + allowList=[marie] →
 *        returned.
 *
 * Harness convention (mirrors Wave A § Friction + Wave B note): tests
 * exercise the exact post-Convex-query slice the GREEN patch introduces —
 * `scopeFilterGet(oauthCtx, row)` — rather than the full Hono /mcp JSON-RPC
 * envelope. Doing so keeps Wave C0 within the test envelope and reuses the
 * Wave A/B fixture conventions verbatim.
 */

import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { LEGACY_WILDCARD_CTX, scopeFilterGet } from "@vantageos/cloud-identity";
import { registerTools } from "../src/tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders (mirror Wave A + Wave B exactly)
// ─────────────────────────────────────────────────────────────────────────────

function masterCtx(): OAuthContext {
	return {
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
}

function tenantACtx(): OAuthContext {
	return {
		clientId: "client-tenant-a",
		userId: "user-tenant-a",
		scopes: ["vantage:read"],
		scopeProfile: "tenant-a",
		fromAllowList: ["tenant-a"],
		namespaceReadPrefixes: ["orchestrator/tenant-a", "project/tenant-a"],
		namespaceWritePrefixes: ["project/tenant-a"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
	};
}

function tenantBCtx(): OAuthContext {
	return {
		clientId: "client-tenant-b",
		userId: "user-tenant-b",
		scopes: ["vantage:read"],
		scopeProfile: "tenant-b",
		fromAllowList: ["tenant-b"],
		namespaceReadPrefixes: ["orchestrator/tenant-b", "project/tenant-b"],
		namespaceWritePrefixes: ["project/tenant-b"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
	};
}

function marieCtx(): OAuthContext {
	return {
		clientId: "client-marie",
		userId: "user-marie",
		scopes: ["vantage:read"],
		scopeProfile: "marie",
		fromAllowList: ["marie"],
		namespaceReadPrefixes: ["orchestrator/marie"],
		namespaceWritePrefixes: ["orchestrator/marie"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Row fixture — shape of a single `briefingNotes:get` Convex query result.
// Only the scope-filter inputs (createdBy + namespace) matter for these
// assertions; remaining fields are kept lightweight.
// ─────────────────────────────────────────────────────────────────────────────

type BriefingNoteRow = {
	_id: string;
	createdBy?: string;
	namespace?: string;
	topic: string;
	title: string;
	content: string;
};

const ownNote: BriefingNoteRow = {
	_id: "bn_own1",
	createdBy: "tenant-a",
	namespace: "orchestrator/tenant-a",
	topic: "decision",
	title: "Tenant A decision",
	content: "tenant-a body",
};

const foreignNote: BriefingNoteRow = {
	_id: "bn_foreign1",
	createdBy: "tenant-b",
	namespace: "orchestrator/tenant-b",
	topic: "decision",
	title: "Tenant B decision",
	content: "tenant-b body",
};

// ─────────────────────────────────────────────────────────────────────────────
// R — Registration assertion (RED→GREEN driver).
// Lightweight duck-typed McpServer mock captures `.tool()` registrations.
// At RED: `get_briefing_note` is absent → tests fail.
// At GREEN: tool is registered alongside list/create/update/delete → pass.
// ─────────────────────────────────────────────────────────────────────────────

type CapturedTool = {
	name: string;
	description: string;
	schema: Record<string, unknown>;
	annotations: Record<string, unknown>;
	handler: (args: any) => any;
};

function captureRegisteredTools(oauthCtx?: OAuthContext): Map<string, CapturedTool> {
	const tools = new Map<string, CapturedTool>();
	// Unwraps a strict ZodObject's `.shape` back to a raw field-validator
	// record, so this test keeps reading the same per-field validators it
	// always did regardless of whether the registration entry point handed
	// it a raw shape (legacy `.tool()`) or an already-built schema instance
	// (`.registerTool()`, used by defineTool() since the Day-159 boot fix —
	// see registerTool.ts `defineTool` doc comment).
	function unwrapShape(schema: unknown): Record<string, unknown> {
		const maybeZodObject = schema as { shape?: unknown };
		if (
			maybeZodObject &&
			typeof maybeZodObject === "object" &&
			maybeZodObject.shape !== undefined &&
			typeof maybeZodObject.shape === "object" &&
			maybeZodObject.shape !== null
		) {
			return maybeZodObject.shape as Record<string, unknown>;
		}
		return schema as Record<string, unknown>;
	}
	const mockServer = {
		tool: (
			name: string,
			description: string,
			schema: Record<string, unknown>,
			annotations: Record<string, unknown>,
			handler: (args: any) => any,
		) => {
			tools.set(name, {
				name,
				description,
				schema: unwrapShape(schema),
				annotations,
				handler,
			});
		},
		registerTool: (
			name: string,
			config: {
				description?: string;
				inputSchema?: Record<string, unknown>;
				annotations?: Record<string, unknown>;
			},
			handler: (args: any) => any,
		) => {
			tools.set(name, {
				name,
				description: config.description ?? "",
				schema: unwrapShape(config.inputSchema),
				annotations: config.annotations ?? {},
				handler,
			});
		},
	} as any;
	const mockConvex = {
		query: async () => null,
		mutation: async () => null,
		action: async () => null,
	} as any;
	registerTools(mockServer, mockConvex, oauthCtx);
	return tools;
}

describe("R — get_briefing_note tool registration", () => {
	it("R1 get_briefing_note is registered as an MCP tool", () => {
		const tools = captureRegisteredTools();
		expect(tools.has("get_briefing_note")).toBe(true);
	});

	it("R2 get_briefing_note schema has noteId: string input", () => {
		const tools = captureRegisteredTools();
		const t = tools.get("get_briefing_note");
		expect(t).toBeDefined();
		expect(t?.schema).toHaveProperty("noteId");
	});

	it("R3 get_briefing_note is read-only (annotations)", () => {
		const tools = captureRegisteredTools();
		const t = tools.get("get_briefing_note");
		expect(t?.annotations.readOnlyHint).toBe(true);
		expect(t?.annotations.destructiveHint).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// U1-U5 — single-row scope-filter slice (mirrors Wave A G1-G4 for get_memory)
// ─────────────────────────────────────────────────────────────────────────────

describe("U — get_briefing_note slice (scopeFilterGet)", () => {
	it("U1 caller in scope → note returned", () => {
		const out = scopeFilterGet(tenantACtx(), ownNote);
		expect(out).not.toBeNull();
		expect(out?._id).toBe("bn_own1");
	});

	it("U2 backend returns null (note absent) → null (not-found shape preserved)", () => {
		expect(scopeFilterGet(tenantACtx(), null)).toBeNull();
		expect(scopeFilterGet(masterCtx(), null)).toBeNull();
		// 0.3.0: oauthCtx is mandatory — undefined must be requested BY NAME via
		// LEGACY_WILDCARD_CTX, never inferred from an omitted argument.
		expect(scopeFilterGet(LEGACY_WILDCARD_CTX, null)).toBeNull();
	});

	it("U3 oauthCtx=LEGACY_WILDCARD_CTX (legacy bearer, explicit opt-in) → row returned regardless of tenancy", () => {
		const out = scopeFilterGet(LEGACY_WILDCARD_CTX, foreignNote);
		expect(out).not.toBeNull();
		expect(out?._id).toBe("bn_foreign1");
	});

	it("U4 master scope → foreign-tenant note returned", () => {
		const out = scopeFilterGet(masterCtx(), foreignNote);
		expect(out).not.toBeNull();
		expect(out?._id).toBe("bn_foreign1");
	});

	it("U5 scoped caller, row outside scope → null (non-leaky 404)", () => {
		const out = scopeFilterGet(tenantACtx(), foreignNote);
		expect(out).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// M1-M3 — multi-tenant scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe("M — get_briefing_note multi-tenant scenarios", () => {
	it("M1 cross-tenant: note owned by tenant-A, caller tenant-B → null", () => {
		const out = scopeFilterGet(tenantBCtx(), ownNote);
		expect(out).toBeNull();
	});

	it("M2 namespace-prefix allowed: row in orchestrator/marie/x → returned", () => {
		const row: BriefingNoteRow = {
			_id: "bn_marie_sub",
			createdBy: "someone-else",
			namespace: "orchestrator/marie/x",
			topic: "x",
			title: "marie subspace",
			content: "x",
		};
		const out = scopeFilterGet(marieCtx(), row);
		expect(out).not.toBeNull();
		expect(out?._id).toBe("bn_marie_sub");
	});

	it("M3 createdBy fromAllowList: row.createdBy=marie + allowList=[marie] → returned", () => {
		const row: BriefingNoteRow = {
			_id: "bn_marie_made",
			createdBy: "marie",
			namespace: "global", // not in marie's namespaceReadPrefixes
			topic: "x",
			title: "marie-authored",
			content: "x",
		};
		const out = scopeFilterGet(marieCtx(), row);
		expect(out).not.toBeNull();
		expect(out?._id).toBe("bn_marie_made");
	});
});
