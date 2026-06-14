/**
 * __crud-smoke__ dummy entity setup/teardown helper.
 *
 * All write ops in the CRUD baseline suite tag their payloads with a
 * recognisable marker so cleanup can find and delete them after the suite.
 *
 * Marker strategy per entity:
 *   tasks        → assignedTo="__crud-smoke__"  createdBy="sigma"
 *   messages     → channel="__crud-smoke__"     from="sigma"
 *   memories     → namespace="audit/crud-smoke" createdBy="sigma"
 *   briefingNotes→ topic="__crud-smoke__"       createdBy="sigma"
 *   episodes     → namespace="audit/crud-smoke" context includes "crud-smoke"
 */

export const SMOKE_MARKER = "__crud-smoke__";
export const SMOKE_NS = "audit/crud-smoke";
export const SMOKE_CREATOR = "sigma";

/** IDs collected during a suite run so afterAll can delete them. */
export type CreatedIds = {
	taskIds: string[];
	messageIds: string[];
	memoryIds: string[];
	briefingNoteIds: string[];
	episodeIds: string[];
};

export function emptyCreatedIds(): CreatedIds {
	return {
		taskIds: [],
		messageIds: [],
		memoryIds: [],
		briefingNoteIds: [],
		episodeIds: [],
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP JSON-RPC client helpers
// ─────────────────────────────────────────────────────────────────────────────

export type McpEnv = {
	prodUrl: string;
	bearerToken: string;
};

/**
 * Resolve PROD credentials from environment.
 * Returns null when env vars are absent — callers should skip tests in that case.
 */
export function resolveMcpEnv(): McpEnv | null {
	const prodUrl = process.env.VP_MCP_PROD_URL;
	const bearerToken = process.env.VP_MCP_BEARER_TOKEN;
	if (!prodUrl || !bearerToken) return null;
	return { prodUrl, bearerToken };
}

let _sessionId: string | null = null;

/**
 * Initialize a stateless MCP session (required before tools/call).
 * Returns the mcp-session-id header value for subsequent requests.
 */
export async function initSession(env: McpEnv): Promise<string> {
	if (_sessionId) return _sessionId;

	const res = await fetch(env.prodUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${env.bearerToken}`,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "crud-smoke-test", version: "0.0.1" },
			},
		}),
	});

	if (!res.ok) {
		throw new Error(`MCP initialize failed: ${res.status} ${await res.text()}`);
	}

	const sessionId = res.headers.get("mcp-session-id");
	if (!sessionId) {
		throw new Error("MCP initialize response missing mcp-session-id header");
	}
	_sessionId = sessionId;
	return sessionId;
}

/** Reset session between test suites if needed. */
export function resetSession(): void {
	_sessionId = null;
}

let _rpcId = 100;

/**
 * Call a single MCP tool and return the parsed response body.
 * Throws on non-200 HTTP or on JSON-RPC error.
 */
export async function callTool(
	env: McpEnv,
	sessionId: string,
	toolName: string,
	toolArgs: Record<string, unknown>,
): Promise<unknown> {
	const id = _rpcId++;
	const res = await fetch(env.prodUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${env.bearerToken}`,
			"mcp-session-id": sessionId,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id,
			method: "tools/call",
			params: {
				name: toolName,
				arguments: toolArgs,
			},
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`[${toolName}] HTTP ${res.status}: ${body.slice(0, 300)}`);
	}

	const body = (await res.json()) as {
		jsonrpc: string;
		id: number;
		result?: { content: Array<{ type: string; text: string }> };
		error?: { code: number; message: string };
	};

	if (body.error) {
		throw new Error(
			`[${toolName}] JSON-RPC error ${body.error.code}: ${body.error.message}`,
		);
	}

	return body.result;
}

/**
 * Parse the text content from an MCP tool result.
 * Returns the first text content block as a parsed JSON value.
 */
export function parseResult(result: unknown): unknown {
	const r = result as {
		content?: Array<{ type: string; text: string }>;
	};
	if (!r?.content?.length) return null;
	const text = r.content.find((c) => c.type === "text")?.text ?? "";
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * Assert that a result has the expected MCP content shape.
 */
export function assertMcpResult(result: unknown): asserts result is {
	content: Array<{ type: string; text: string }>;
} {
	const r = result as { content?: unknown };
	if (!r || typeof r !== "object" || !Array.isArray(r.content)) {
		throw new Error(
			`Expected MCP result with content array, got: ${JSON.stringify(result)}`,
		);
	}
}
