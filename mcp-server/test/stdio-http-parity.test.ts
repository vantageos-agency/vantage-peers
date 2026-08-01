/**
 * stdio ↔ HTTP transport parity test.
 *
 * Day 102 fix-pattern m974adhs7wtwb6pt4h0sdxn1k988mnxk — locks in the
 * single-registry doctrine: both transports (server.ts → StdioServerTransport,
 * server-http.ts → StreamableHTTPServerTransport) MUST delegate ALL tool
 * registration to `registerTools(server, convex, oauthCtx?)` exported by
 * src/tools.ts. Any inline `server.tool(...)` re-introduced in server.ts or
 * server-http.ts will fail this test.
 *
 * Background: prior to this lock, server.ts had ~85 tools registered inline
 * while src/tools.ts had ~97 (including 12 newly-added CRUD-baseline tools).
 * Fleet stdio consumers (Claude Code, Codex via npx vantage-peers-mcp) silently
 * missed: search_tasks_by_keyword/_by_semantic, get_task, get_message,
 * get_briefing_note, search_messages_by_keyword/_by_semantic,
 * search_briefing_notes_by_keyword/_by_semantic, get_episode, list_episodes,
 * search_episodes_by_keyword/_by_semantic.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const SERVER_TS = resolve(__dirname, "../server.ts");
const SERVER_HTTP_TS = resolve(__dirname, "../server-http.ts");
const TOOLS_TS = resolve(__dirname, "../src/tools.ts");

function read(path: string): string {
	return readFileSync(path, "utf-8");
}

function countMatches(source: string, pattern: RegExp): number {
	return (source.match(pattern) ?? []).length;
}

describe("stdio ↔ HTTP transport parity (single registry)", () => {
	it("server.ts imports registerTools from src/tools.js", () => {
		const src = read(SERVER_TS);
		expect(src).toMatch(/from\s+["']\.\/src\/tools\.js["']/);
		expect(src).toMatch(/registerTools\s*\(\s*server\s*,\s*convex\s*\)/);
	});

	it("server-http.ts imports registerTools from src/tools.js", () => {
		const src = read(SERVER_HTTP_TS);
		expect(src).toMatch(/from\s+["']\.\/src\/tools\.js["']/);
		expect(src).toMatch(/registerTools\s*\(\s*server\s*,\s*convex\s*,/);
	});

	it("server.ts contains ZERO inline server.tool() registrations", () => {
		const src = read(SERVER_TS);
		// Strip comments to avoid counting `server.tool(` mentions in doc-comments.
		const stripped = src
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		const inlineCount = countMatches(stripped, /\bserver\.tool\s*\(/g);
		expect(inlineCount).toBe(0);
	});

	it("server-http.ts contains ZERO inline server.tool() registrations", () => {
		const src = read(SERVER_HTTP_TS);
		const stripped = src
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		const inlineCount = countMatches(stripped, /\bserver\.tool\s*\(/g);
		expect(inlineCount).toBe(0);
	});

	it("src/tools.ts is the single source of tool registration (>= 80 tools)", () => {
		const src = read(TOOLS_TS);
		// S2 (vp-multitenant-zero-hole-v1): every registration now flows through
		// the mandatory-scope wrapper `defineTool(server, authCtx, <scope>, …)`
		// instead of a bare `server.tool(…)`. Count the wrapper form.
		const toolCount = countMatches(src, /\bdefineTool\s*\(/g);
		// Sanity floor — at the time of Day 102 lock we have ~114. Test must
		// scream if the registry shrinks unexpectedly OR if anyone tries to
		// move registrations back into the transport bins.
		expect(toolCount).toBeGreaterThanOrEqual(80);
	});

	it("previously-missing CRUD-baseline tools are registered in src/tools.ts", () => {
		const src = read(TOOLS_TS);
		// Canonical Day 102 set: tools that lived only in src/tools.ts (HTTP) and
		// were unreachable from stdio before this refactor. Locks regression of
		// the 12+ CRUD-baseline reads + the broader 31-tool delta.
		const required = [
			"search_tasks_by_keyword",
			"get_task",
			"get_message",
			"get_briefing_note",
			"search_messages_by_keyword",
			"search_briefing_notes_by_keyword",
			"get_episode",
			"list_episodes",
			"search_episodes_by_keyword",
			"search_episodes_by_semantic",
			"get_recurring_task",
			"whoami",
		];
		for (const name of required) {
			expect(src, `tool ${name} missing from src/tools.ts registry`).toContain(
				`"${name}"`,
			);
		}
	});
});
