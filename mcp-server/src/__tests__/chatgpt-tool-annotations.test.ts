/**
 * Day 88 — ChatGPT Apps SDK tool annotations coverage.
 *
 * Spec: https://developers.openai.com/apps-sdk/build/mcp-server (annotations)
 * VP task: k173x3t2rsggn1krc0b4y3nvw987pqwy
 *
 * Without annotations ChatGPT classifies every tool as "may modify" and
 * pops up an extra confirmation dialog for read-only calls. This test
 * asserts that all VP MCP tools register an `annotations` object with
 * `readOnlyHint`, `openWorldHint`, `destructiveHint`, and a human-readable
 * `title`.
 *
 * Day 88 baseline: 84 tools. Day 100 Phase 1+2b additions: get_task,
 * get_fix_pattern, get_mandate, get_repo_mapping, get_message,
 * get_recurring_task. B2 alias sweep: 19 more tools. Count is now pinned
 * with toBeGreaterThanOrEqual so future additions don't break CI.
 *
 * SDK signature used (mcp.d.ts:146):
 *   server.tool(name, description, paramsSchema, annotations, cb)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { registerTools } from "../tools.js";

interface CapturedTool {
	description: string;
	annotations?: {
		readOnlyHint?: boolean;
		openWorldHint?: boolean;
		destructiveHint?: boolean;
		title?: string;
	};
}

function buildCapturingServer(): {
	server: McpServer;
	tools: Map<string, CapturedTool>;
} {
	const tools = new Map<string, CapturedTool>();

	const fakeServer = {
		tool(...args: unknown[]): unknown {
			const name = args[0] as string;
			const description = args[1] as string;
			// 5-arg form: tool(name, desc, schema, annotations, handler)
			// 4-arg form: tool(name, desc, schema, handler) — legacy, no annotations
			let annotations: CapturedTool["annotations"] | undefined;
			if (args.length === 5) {
				const candidate = args[3];
				if (
					typeof candidate === "object" &&
					candidate !== null &&
					!Array.isArray(candidate) &&
					("readOnlyHint" in candidate ||
						"destructiveHint" in candidate ||
						"openWorldHint" in candidate ||
						"title" in candidate)
				) {
					annotations = candidate as CapturedTool["annotations"];
				}
			}
			tools.set(name, { description, annotations });
			return {};
		},
	} as unknown as McpServer;

	return { server: fakeServer, tools };
}

function buildMockConvex(): ConvexHttpClient {
	return {
		query: vi.fn().mockResolvedValue([]),
		mutation: vi.fn().mockResolvedValue(null),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// Expected categorization.
// Day 88 baseline: 34 readOnly + 41 write + 9 destructive = 84 tools.
// Day 100 Phase 1+2b: +6 readOnly get_by_id tools (get_task, get_fix_pattern,
//   get_mandate, get_repo_mapping, get_message, get_recurring_task).
// B2 alias sweep + Day 92: +get_briefing_note, +whoami, +validate_task_payload,
//   +check_mandate_spending (readOnly aliases); +delete_repo_mapping,
//   +delete_deployment (destructive aliases).
// Total at Day 100 B2: 44 readOnly + 11 destructive + 48 write = 103 tools.
// ─────────────────────────────────────────────────────────────────────────────

const READ_ONLY_TOOLS = new Set([
	"get_memory",
	"recall",
	"text_search",
	"search_memories_by_keyword",
	"search_memories_by_semantic",
	"hybrid_search",
	"get_profile",
	"list_memories",
	"check_messages",
	"list_peers",
	"list_messages",
	"list_broadcast_status",
	"list_tasks",
	"list_tasks_by_mission",
	"list_missions",
	"get_mission",
	"get_diary",
	"list_diaries",
	"list_briefing_notes",
	"list_components",
	"get_component",
	"search_components",
	"list_recurring_tasks",
	"validate_mandate_spending",
	"list_mandates",
	"get_bu",
	"list_bus",
	"list_repo_mappings",
	"list_issues",
	"get_issue",
	"issue_stats",
	"search_fix_patterns",
	"list_fix_patterns",
	"get_mission_template",
	"list_errors",
	"get_error",
	// Day 100 — Phase 1 get_by_id surface additions (task k172735brsw6bc3j2dkkkfxqrx88kkjq)
	"get_task",
	"get_fix_pattern",
	"get_mandate",
	"get_repo_mapping",
	// Day 100 — Phase 2b get_by_id surface additions (same task; episodes dropped — uses get_memory)
	"get_message",
	"get_recurring_task",
	// Day 92 + B2 alias sweep — read-only tools added after Day 88
	"get_briefing_note",
	"whoami",
	"validate_task_payload",
	"check_mandate_spending",
]);

const DESTRUCTIVE_TOOLS = new Set([
	"soft_delete_memory",
	"delete_message",
	"delete_task",
	"block_task",
	"delete_component",
	"delete_recurring_task",
	"delete_bu",
	"remove_repo_mapping",
	"remove_deployment",
	// B2 alias sweep — destructive aliases added after Day 88
	"delete_repo_mapping",
	"delete_deployment",
]);

describe("ChatGPT Apps SDK tool annotations (Day 88)", () => {
	it("registers at least 84 VP MCP tools (Day 88 baseline; count grows with new tools)", () => {
		const { server, tools } = buildCapturingServer();
		registerTools(server, buildMockConvex());
		// Day 88 baseline was 84. Day 100 B2 is 103. Pin to >= baseline so
		// future tool additions don't break CI; invariants (annotations) are
		// enforced per-tool in the following tests.
		expect(tools.size).toBeGreaterThanOrEqual(84);
	});

	it("every tool carries an annotations object with the 3 required hints + title", () => {
		const { server, tools } = buildCapturingServer();
		registerTools(server, buildMockConvex());

		const missing: string[] = [];
		for (const [name, captured] of tools) {
			if (!captured.annotations) {
				missing.push(`${name}: no annotations object`);
				continue;
			}
			const a = captured.annotations;
			if (typeof a.readOnlyHint !== "boolean") {
				missing.push(`${name}: missing readOnlyHint`);
			}
			if (typeof a.openWorldHint !== "boolean") {
				missing.push(`${name}: missing openWorldHint`);
			}
			if (typeof a.destructiveHint !== "boolean") {
				missing.push(`${name}: missing destructiveHint`);
			}
			if (typeof a.title !== "string" || a.title.length === 0) {
				missing.push(`${name}: missing title`);
			}
		}

		expect(missing, missing.join("\n")).toEqual([]);
	});

	it("all 34 read-only tools have readOnlyHint=true and destructiveHint=false", () => {
		const { server, tools } = buildCapturingServer();
		registerTools(server, buildMockConvex());

		const mismatches: string[] = [];
		for (const name of READ_ONLY_TOOLS) {
			const t = tools.get(name);
			if (!t) {
				mismatches.push(`${name}: not registered`);
				continue;
			}
			if (t.annotations?.readOnlyHint !== true) {
				mismatches.push(`${name}: readOnlyHint=${t.annotations?.readOnlyHint}`);
			}
			if (t.annotations?.destructiveHint !== false) {
				mismatches.push(
					`${name}: destructiveHint=${t.annotations?.destructiveHint}`,
				);
			}
		}
		expect(mismatches, mismatches.join("\n")).toEqual([]);
		// Day 88 baseline: 34. Day 100 B2 additions bring total to 44.
		expect(READ_ONLY_TOOLS.size).toBeGreaterThanOrEqual(34);
	});

	it("all destructive tools have destructiveHint=true and readOnlyHint=false", () => {
		const { server, tools } = buildCapturingServer();
		registerTools(server, buildMockConvex());

		const mismatches: string[] = [];
		for (const name of DESTRUCTIVE_TOOLS) {
			const t = tools.get(name);
			if (!t) {
				mismatches.push(`${name}: not registered`);
				continue;
			}
			if (t.annotations?.destructiveHint !== true) {
				mismatches.push(
					`${name}: destructiveHint=${t.annotations?.destructiveHint}`,
				);
			}
			if (t.annotations?.readOnlyHint !== false) {
				mismatches.push(`${name}: readOnlyHint=${t.annotations?.readOnlyHint}`);
			}
		}
		expect(mismatches, mismatches.join("\n")).toEqual([]);
		// Day 88 baseline: 9. B2 alias sweep adds delete_repo_mapping + delete_deployment.
		expect(DESTRUCTIVE_TOOLS.size).toBeGreaterThanOrEqual(9);
	});

	it("all write tools have readOnlyHint=false and destructiveHint=false", () => {
		const { server, tools } = buildCapturingServer();
		registerTools(server, buildMockConvex());

		const writeTools: string[] = [];
		const mismatches: string[] = [];
		for (const [name, t] of tools) {
			if (READ_ONLY_TOOLS.has(name) || DESTRUCTIVE_TOOLS.has(name)) continue;
			writeTools.push(name);
			if (t.annotations?.readOnlyHint !== false) {
				mismatches.push(`${name}: readOnlyHint=${t.annotations?.readOnlyHint}`);
			}
			if (t.annotations?.destructiveHint !== false) {
				mismatches.push(
					`${name}: destructiveHint=${t.annotations?.destructiveHint}`,
				);
			}
		}
		expect(mismatches, mismatches.join("\n")).toEqual([]);
		// Day 88 baseline: 41. Count grows with new write tools; pin to >= baseline.
		expect(writeTools.length).toBeGreaterThanOrEqual(41);
	});

	it("every tool sets openWorldHint=false (VP is a closed Convex world)", () => {
		const { server, tools } = buildCapturingServer();
		registerTools(server, buildMockConvex());

		const mismatches: string[] = [];
		for (const [name, t] of tools) {
			if (t.annotations?.openWorldHint !== false) {
				mismatches.push(
					`${name}: openWorldHint=${t.annotations?.openWorldHint}`,
				);
			}
		}
		expect(mismatches, mismatches.join("\n")).toEqual([]);
	});
});
