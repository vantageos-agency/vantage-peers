// ─────────────────────────────────────────────────────────────────────────────
// tools-descriptions-canonical.test.ts — PR-J TDD-RED phase
// ─────────────────────────────────────────────────────────────────────────────
//
// Canonical quality-contract snapshot for all ~114 registered MCP tools.
// Each section produces an independently auditable punch list of failures so
// T-GREEN has an exact list of description edits required.
//
// Section A — inventory floor: tools.length >= 100
// Section B — description length floor: >= 60 chars per tool
// Section C — no placeholder strings (TODO / FIXME / XXX / TBD / placeholder / coming soon)
// Section D — category contracts:
//   list_* tools MUST mention "limit" AND ("cap" OR "default 20" OR "default 100")
//   recall-class tools (5) must NOT carry the former VP-Sources doctrine
//   (forbidden in tool metadata since task k1793xkjhzh1xm23gmmwjgwfyx8htbv0)
//
// Mission: k571gcctka8mq5jbkgpj0a0b2n892ctg (Bloc A, audit section 27)
// ─────────────────────────────────────────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerTools } from "../tools.js";

// ─── Harness ─────────────────────────────────────────────────────────────────
// Reuses the same fake-server pattern from chatgpt-tool-annotations.test.ts.

interface CapturedTool {
	name: string;
	description: string;
	inputSchema?: unknown;
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
			tools.set(name, { name, description });
			return {};
		},
		registerTool(...args: unknown[]): unknown {
			// `server.registerTool(name, config, handler)` — the config-object
			// entry point defineTool() uses since the Day-159 boot fix (see
			// registerTool.ts).
			const name = args[0] as string;
			const config = args[1] as { description?: string; inputSchema?: unknown };
			tools.set(name, {
				name,
				description: config.description ?? "",
				inputSchema: config.inputSchema,
			});
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

// ─── Former VP-Sources doctrine substrings ───────────────────────────────────
// Tool metadata must NOT carry them any more (Anthropic Software Directory
// Policy D, Manufact policy-review-d26bfdfb4c66; task k1793xkjhzh1xm23gmmwjgwfyx8htbv0):
// the citation workflow is user documentation (mcp-server/README.md).

const SUBSTR_MUST_BE_CALLED = "MUST be called before any factual claim";

const SUBSTR_CITE_FOOTER = "Cite returned ids in the answer footer";

// 5 recall-class tools that once embedded the VP-Sources doctrine (PR-H) and must no longer
const VP_SOURCES_TOOLS = new Set([
	"recall",
	"hybrid_search",
	"text_search",
	"list_briefing_notes",
	"search_briefing_notes_by_keyword",
]);

/** The `limit` field of a tool's input schema declares both its cap and its default. */
function limitSchemaCarriesContract(inputSchema: unknown): boolean {
	if (!(inputSchema instanceof z.ZodType)) return false;
	const json = z.toJSONSchema(inputSchema, { io: "input" }) as {
		properties?: Record<string, { maximum?: number; default?: unknown }>;
	};
	const limit = json.properties?.limit;
	return limit?.maximum !== undefined && limit.default !== undefined;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Tool descriptions canonical quality contract (PR-J RED)", () => {
	// ── Section A — Inventory floor ───────────────────────────────────────────

	it("A: registers at least 100 MCP tools (inventory floor)", () => {
		const { server, tools } = buildCapturingServer();
		registerTools(server, buildMockConvex());
		// Pin to 100 to absorb minor future removals without breaking CI.
		// Actual count at PR-J authoring: ~114+.
		expect(tools.size).toBeGreaterThanOrEqual(100);
	});

	// ── Section B — Description length floor (>= 60 chars) ───────────────────

	it("B: every tool description is at least 60 characters long", () => {
		const { server, tools } = buildCapturingServer();
		registerTools(server, buildMockConvex());

		const mismatches: string[] = [];
		for (const [name, t] of tools) {
			if (t.description.length < 60) {
				mismatches.push(
					`${name}: description length=${t.description.length} (min 60) — "${t.description}"`,
				);
			}
		}
		expect(mismatches, mismatches.join("\n")).toEqual([]);
	});

	// ── Section C — No placeholder strings ───────────────────────────────────

	it("C: no tool description contains placeholder strings (TODO/FIXME/XXX/TBD/placeholder/coming soon)", () => {
		const { server, tools } = buildCapturingServer();
		registerTools(server, buildMockConvex());

		// Case-sensitive for TODO/FIXME/XXX/TBD — these are programmer placeholder
		// conventions that are ALWAYS uppercase. Lowercase "todo" is a legitimate
		// task-status term used in descriptions (e.g. "claim a todo task").
		// "placeholder" and "coming soon" use a separate case-insensitive check
		// since there is no legitimate usage of those phrases in a shipped description.
		const PLACEHOLDER_SENSITIVE_RE = /\b(TODO|FIXME|XXX|TBD)\b/;
		const PLACEHOLDER_INSENSITIVE_RE = /\b(placeholder|coming soon)\b/i;

		const mismatches: string[] = [];
		for (const [name, t] of tools) {
			const match =
				PLACEHOLDER_SENSITIVE_RE.exec(t.description) ??
				PLACEHOLDER_INSENSITIVE_RE.exec(t.description);
			if (match) {
				mismatches.push(
					`${name}: contains placeholder token "${match[0]}" — "${t.description.slice(0, 120)}..."`,
				);
			}
		}
		expect(mismatches, mismatches.join("\n")).toEqual([]);
	});

	// ── Section D — Category contracts ────────────────────────────────────────

	it("D: list_* tools mention paging contract (limit + cap/default) and recall-class tools embed VP-Sources doctrine", () => {
		const { server, tools } = buildCapturingServer();
		registerTools(server, buildMockConvex());

		// D1 — list_* paging contract
		// Description MUST mention "limit" AND one of: "cap", "default 20", "default 100"
		// — OR the `limit` input schema itself carries both its cap (maximum) and
		// its default, in which case the prose must not repeat them (task
		// k172z2f2q3bgr9wwc3agj08xx98hv4h2: a field description never restates
		// its schema).
		const pagingMismatches: string[] = [];
		for (const [name, t] of tools) {
			if (!name.startsWith("list_")) continue;
			if (limitSchemaCarriesContract(t.inputSchema)) continue;
			const desc = t.description;
			const hasLimit = desc.includes("limit");
			const hasCap =
				desc.includes("cap") ||
				desc.includes("default 20") ||
				desc.includes("default 100");
			if (!hasLimit || !hasCap) {
				const missing: string[] = [];
				if (!hasLimit) missing.push("'limit'");
				if (!hasCap) missing.push("'cap' or 'default 20' or 'default 100'");
				pagingMismatches.push(
					`${name}: missing paging contract — needs ${missing.join(" AND ")}`,
				);
			}
		}

		// D2 — VP-Sources doctrine in recall-class tools
		const vpSourcesMismatches: string[] = [];
		for (const name of VP_SOURCES_TOOLS) {
			const t = tools.get(name);
			if (!t) {
				vpSourcesMismatches.push(`${name}: tool not registered`);
				continue;
			}
			if (t.description.includes(SUBSTR_MUST_BE_CALLED)) {
				vpSourcesMismatches.push(
					`${name}: still carries the VP-Sources MUST-BE-CALLED substring`,
				);
			}
			if (t.description.includes(SUBSTR_CITE_FOOTER)) {
				vpSourcesMismatches.push(
					`${name}: still carries the VP-Sources CITE-FOOTER substring`,
				);
			}
		}

		// Report both buckets in separate blocks so T-GREEN punch list is clear
		const allMismatches: string[] = [];
		if (pagingMismatches.length > 0) {
			allMismatches.push(
				`\n--- D1: list_* paging contract violations (${pagingMismatches.length}) ---`,
				...pagingMismatches,
			);
		}
		if (vpSourcesMismatches.length > 0) {
			allMismatches.push(
				`\n--- D2: VP-Sources doctrine violations (${vpSourcesMismatches.length}) ---`,
				...vpSourcesMismatches,
			);
		}

		expect(allMismatches, allMismatches.join("\n")).toEqual([]);
	});
});
