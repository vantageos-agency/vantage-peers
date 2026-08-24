// ─────────────────────────────────────────────────────────────────────────────
// billing_summary_by_project.tool.test.ts
// ─────────────────────────────────────────────────────────────────────────────
//
// Day 130 (k17dhcmzqafve1ayzvh833kf558ae019) coordinator follow-up:
// `tasks:billingSummaryByProject` existed in Convex but was NOT exposed as an
// MCP tool, so Pi/Laurent could not call it ("Verification ≠ Activation").
//
// Pins:
//   1. Exported name/description/schema contract (mirrors
//      bulk_complete_tasks.tool.test.ts convention).
//   2. The tool is actually REGISTERED by registerTools() and its handler
//      calls convex.query("tasks:billingSummaryByProject", ...) and returns
//      the {byProject, unattributedTaskCount, truncated} shape — proves
//      wiring, not just schema existence (same pattern as
//      list_memories_episodes_pagination.test.ts).
//   3. truncated is never silently dropped — it is passed through verbatim.
//   4. project arg is passed straight through to the Convex query args
//      (Day-131 fix: pushed into the index-backed query, never a post-hoc
//      client-side filter over a truncated cross-project scan).
// ─────────────────────────────────────────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_STDIO_TRUST_CTX } from "../auth.js";
import {
	BILLING_SUMMARY_BY_PROJECT_TOOL_DESCRIPTION,
	BILLING_SUMMARY_BY_PROJECT_TOOL_NAME,
	billingSummaryByProjectArgsSchema,
	registerTools,
} from "../tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
	content: Array<{ type: string; text: string }>;
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
		query: vi.fn().mockResolvedValue({
			byProject: [],
			unattributedTaskCount: 0,
			truncated: false,
		}),
		mutation: vi.fn().mockResolvedValue(null),
		action: vi.fn().mockResolvedValue(null),
	} as unknown as ConvexHttpClient;
}

describe("billing_summary_by_project — name/description/schema contract", () => {
	it("tool name is 'billing_summary_by_project'", () => {
		expect(BILLING_SUMMARY_BY_PROJECT_TOOL_NAME).toBe(
			"billing_summary_by_project",
		);
	});

	it("description is refacturation-base voice: mentions MACHINE-derived actualMinutes, startedAt→completedAt, truncated", () => {
		expect(
			BILLING_SUMMARY_BY_PROJECT_TOOL_DESCRIPTION.length,
		).toBeGreaterThanOrEqual(60);
		expect(BILLING_SUMMARY_BY_PROJECT_TOOL_DESCRIPTION).toContain(
			"MACHINE-derived actualMinutes",
		);
		expect(BILLING_SUMMARY_BY_PROJECT_TOOL_DESCRIPTION).toContain(
			"startedAt→completedAt",
		);
		expect(BILLING_SUMMARY_BY_PROJECT_TOOL_DESCRIPTION.toLowerCase()).toContain(
			"truncated",
		);
		expect(BILLING_SUMMARY_BY_PROJECT_TOOL_DESCRIPTION).not.toMatch(
			/TODO|FIXME|XXX|TBD|placeholder|coming soon/i,
		);
	});

	it("args schema: project/from/to all optional; from/to must be integers", () => {
		expect(billingSummaryByProjectArgsSchema.parse({})).toEqual({});
		expect(
			billingSummaryByProjectArgsSchema.parse({
				project: "vantage-immo",
				from: 1000,
				to: 2000,
			}),
		).toMatchObject({ project: "vantage-immo", from: 1000, to: 2000 });

		expect(() =>
			billingSummaryByProjectArgsSchema.parse({ from: 1.5 }),
		).toThrow();
		expect(() =>
			billingSummaryByProjectArgsSchema.parse({ project: 123 }),
		).toThrow();
	});
});

describe("billing_summary_by_project — registration + wiring", () => {
	it("is registered by registerTools() and calls tasks:billingSummaryByProject", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, LOCAL_STDIO_TRUST_CTX);

		const handler = handlers.get(BILLING_SUMMARY_BY_PROJECT_TOOL_NAME);
		expect(handler).toBeDefined();

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			byProject: [
				{ project: "vantage-immo", totalMinutes: 90, taskCount: 2 },
				{ project: "vantage-peers", totalMinutes: 45, taskCount: 1 },
			],
			unattributedTaskCount: 3,
			truncated: false,
		});

		const result = await handler!({ from: 1000, to: 2000 });

		expect(convex.query).toHaveBeenCalledWith("tasks:billingSummaryByProject", {
			startDate: 1000,
			endDate: 2000,
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.byProject).toHaveLength(2);
		expect(parsed.byProject[0]).toMatchObject({
			project: "vantage-immo",
			totalMinutes: 90,
			taskCount: 2,
		});
		expect(parsed.unattributedTaskCount).toBe(3);
		expect(parsed.truncated).toBe(false);
	});

	it("defaults from=0 / to=now when omitted", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, LOCAL_STDIO_TRUST_CTX);
		const handler = handlers.get(BILLING_SUMMARY_BY_PROJECT_TOOL_NAME)!;

		const before = Date.now();
		await handler({});
		const after = Date.now();

		const callArgs = (convex.query as ReturnType<typeof vi.fn>).mock
			.calls[0][1] as {
			startDate: number;
			endDate: number;
		};
		expect(callArgs.startDate).toBe(0);
		expect(callArgs.endDate).toBeGreaterThanOrEqual(before);
		expect(callArgs.endDate).toBeLessThanOrEqual(after);
	});

	it("project arg is forwarded to the Convex query args, never filtered client-side", async () => {
		const { server, handlers } = buildFakeServer();
		const convex = buildMockConvex();
		registerTools(server, convex, LOCAL_STDIO_TRUST_CTX);
		const handler = handlers.get(BILLING_SUMMARY_BY_PROJECT_TOOL_NAME)!;

		(convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			byProject: [{ project: "vantage-immo", totalMinutes: 90, taskCount: 2 }],
			unattributedTaskCount: 0,
			invalidDurationTaskCount: 0,
			truncated: true, // scan hit its cap — must survive verbatim
		});

		const result = await handler({
			project: "vantage-immo",
			from: 1000,
			to: 2000,
		});

		expect(convex.query).toHaveBeenCalledWith("tasks:billingSummaryByProject", {
			startDate: 1000,
			endDate: 2000,
			project: "vantage-immo",
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.byProject).toHaveLength(1);
		expect(parsed.byProject[0].project).toBe("vantage-immo");
		expect(parsed.truncated).toBe(true);
		expect(parsed.invalidDurationTaskCount).toBe(0);
	});
});
