/**
 * Guard: no tool description and no server instructions may exceed 2048 UTF-8
 * bytes, the point at which Claude Code truncates a metadata field.
 * VantagePeers Cloud and Self-host MCP server (both entries register the same
 * tools). Task k1793xkjhzh1xm23gmmwjgwfyx8htbv0 (Manufact finding
 * claude-code-metadata-length: bulk_complete_tasks was 2766 bytes).
 *
 * The sweep reads EVERY registration registerTools makes, advertised or
 * masked, by recording the config each registerTool call receives on a real
 * McpServer. A new tool whose description grows past the budget fails here.
 */

import { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it } from "vitest";
import { LOCAL_STDIO_TRUST_CTX } from "../src/auth.js";
import {
	mcpImplementation,
	mcpServerOptions,
	SERVER_INSTRUCTIONS,
} from "../src/brand.js";
import { registerTools } from "../src/tools.js";

const BUDGET = 2048;
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Names whose field is over the budget. */
function overBudget(
	fields: ReadonlyArray<readonly [string, string]>,
): string[] {
	return fields
		.filter(([, text]) => bytes(text) > BUDGET)
		.map(([name, text]) => `${name}: ${bytes(text)} bytes`);
}

function recordedDescriptions(): Array<[string, string]> {
	const server = new McpServer(mcpImplementation("0.0.0", null));
	const seen: Array<[string, string]> = [];
	const real = server.registerTool.bind(server);
	// biome-ignore lint/suspicious/noExplicitAny: recording the overloaded registerTool signature.
	(server as any).registerTool = (
		name: string,
		config: unknown,
		...rest: unknown[]
	) => {
		const description = (config as { description?: unknown })?.description;
		seen.push([name, typeof description === "string" ? description : ""]);
		return (real as unknown as (...a: unknown[]) => unknown)(
			name,
			config,
			...rest,
		);
	};
	const convex = {
		query: async () => null,
		mutation: async () => null,
		action: async () => null,
		setAuth: () => undefined,
	} as unknown as ConvexHttpClient;
	registerTools(server, convex, LOCAL_STDIO_TRUST_CTX);
	return seen;
}

describe("2048-byte metadata budget", () => {
	it("the predicate is not vacuous: 2048 bytes passes, 2049 fails, multi-byte counts as bytes", () => {
		expect(overBudget([["at", "a".repeat(BUDGET)]])).toEqual([]);
		expect(overBudget([["over", "a".repeat(BUDGET + 1)]])).toEqual([
			"over: 2049 bytes",
		]);
		// 683 x "…" (3 bytes each) = 2049 bytes in 683 characters.
		expect(overBudget([["utf8", "…".repeat(683)]])).toEqual([
			"utf8: 2049 bytes",
		]);
	});

	it("every registered tool description fits 2048 UTF-8 bytes", () => {
		const fields = recordedDescriptions();
		expect(fields.length).toBeGreaterThanOrEqual(90);
		expect(overBudget(fields)).toEqual([]);
	});

	it("the server instructions fit 2048 UTF-8 bytes, and are what the entries pass", () => {
		expect(mcpServerOptions().instructions).toBe(SERVER_INSTRUCTIONS);
		expect(overBudget([["instructions", SERVER_INSTRUCTIONS]])).toEqual([]);
	});

	it("serverInfo title and description fit 2048 UTF-8 bytes", () => {
		const impl = mcpImplementation("0.0.0", "https://mcp.example.test");
		expect(
			overBudget([
				["title", impl.title ?? ""],
				["description", impl.description ?? ""],
			]),
		).toEqual([]);
	});
});
