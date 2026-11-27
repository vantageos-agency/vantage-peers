/**
 * Shared stand-ins for the S-54 tool tests (VantagePeers Cloud + Self-host, MCP
 * server): registerTools() is the REAL production function, the server is a
 * recording stand-in that keeps each registered tool's config and handler, and
 * the Convex client is a mock keyed by function path. A door nobody mocked
 * throws, so a tool that reaches an unexpected door fails loudly.
 *
 * `tools` is the Map of registered handlers: a test calls a tool as
 * `h.tools.get("<name>")!.handler(args)`, the position mcp-doctor S-54 reads.
 */

import { expect } from "vitest";
import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../../src/auth.js";
import { registerTools } from "../../src/tools.js";

export type ToolResult = {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
	structuredContent?: Record<string, unknown>;
};

export type Captured = {
	config: {
		outputSchema?: { safeParse: (v: unknown) => { success: boolean } };
	};
	handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

export type Door = (args: Record<string, unknown>) => unknown;

/** A bearer scoped to one organisation: not master, reads/writes only `project/ops`, acts only as `beta`. */
export const CLIENT_CTX: OAuthContext = {
	clientId: "client-ops",
	userId: "client-ops",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "client-ops",
	fromAllowList: ["beta"],
	namespaceReadPrefixes: ["project/ops"],
	namespaceWritePrefixes: ["project/ops"],
	expiresAt: Number.MAX_SAFE_INTEGER,
	isMaster: false,
};

export function harness(
	doors: Record<string, Door>,
	oauthCtx: OAuthContext = LOCAL_STDIO_TRUST_CTX,
) {
	const tools = new Map<string, Captured>();
	const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
	const server = {
		registerTool: (
			name: string,
			config: Captured["config"],
			handler: never,
		) => {
			tools.set(name, { config, handler });
		},
	} as unknown as Parameters<typeof registerTools>[0];
	const door = async (fn: unknown, args: unknown) => {
		const path = String(fn);
		calls.push({ fn: path, args: args as Record<string, unknown> });
		const d = doors[path];
		if (d === undefined) throw new Error(`no door mocked for ${path}`);
		return d(args as Record<string, unknown>);
	};
	const convex = {
		query: door,
		mutation: door,
		action: door,
	} as unknown as Parameters<typeof registerTools>[1];
	registerTools(server, convex, oauthCtx);
	return { tools, calls };
}

/** The tool answered a success: no isError, structuredContent validates against its declared outputSchema, (the caller compares the text where it is the same object). */
export function expectServed(
	tools: Map<string, Captured>,
	name: string,
	res: ToolResult,
): Record<string, unknown> {
	expect(res.isError, res.content?.[0]?.text).not.toBe(true);
	const schema = tools.get(name)?.config.outputSchema;
	expect(schema, `${name} declares an outputSchema`).toBeDefined();
	expect(res.structuredContent, `${name} answers structuredContent`).toBeDefined();
	expect(
		(schema as NonNullable<typeof schema>).safeParse(res.structuredContent)
			.success,
		`${name} structuredContent validates against its outputSchema`,
	).toBe(true);
	return res.structuredContent as Record<string, unknown>;
}

/** The tool refused: isError, a text naming the refusal, and no structuredContent. */
export function expectRefused(res: ToolResult, pattern: RegExp) {
	expect(res.isError).toBe(true);
	expect(res.structuredContent).toBeUndefined();
	expect(res.content[0].text).toMatch(pattern);
}
