/**
 * VantagePeers Cloud, task k17bmxpw878e7yhqemey4c38q98hyk9f: list_diaries and a
 * capped `diary:list` page. When the backend scanned its whole window without
 * filling the page it answers `{ partial: true, items, nextCreatedBefore }`; the
 * tool must say "continue" with a cursor that resumes at `nextCreatedBefore`,
 * never "that is all", and an exhausted short page keeps no cursor.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_STDIO_TRUST_CTX } from "../src/auth.js";
import { decodeCursor } from "../src/paging.js";
import { registerTools } from "../src/tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

async function listDiaries(
	reply: unknown,
	args: Record<string, unknown>,
): Promise<{ structured: Record<string, unknown>; sent: Record<string, unknown> }> {
	const handlers = new Map<string, ToolHandler>();
	const capture = (...a: unknown[]): unknown => {
		handlers.set(a[0] as string, a[a.length - 1] as ToolHandler);
		return {};
	};
	const server = { tool: capture, registerTool: capture } as unknown as McpServer;
	let sent: Record<string, unknown> = {};
	const query = vi.fn(async (_fn: string, a: Record<string, unknown>) => {
		sent = a;
		return reply;
	});
	registerTools(
		server,
		{ query, mutation: vi.fn(), action: vi.fn() } as unknown as ConvexHttpClient,
		LOCAL_STDIO_TRUST_CTX,
	);
	const result = (await handlers.get("list_diaries")?.(args)) as {
		structuredContent: Record<string, unknown>;
	};
	return { structured: result.structuredContent, sent };
}

const ROW = {
	_id: "diary000000000000000000000000001",
	_creationTime: 10,
	date: "2026-03-01",
	orchestrator: "sigma",
	content: "x",
	createdAt: 1,
};

describe("list_diaries over a capped diary:list page", () => {
	it("a partial page carries a cursor resuming at nextCreatedBefore", async () => {
		const { structured } = await listDiaries(
			{ partial: true, items: [ROW], nextCreatedBefore: 4242 },
			{ createdBy: "pi", limit: 5 },
		);
		expect((structured.items as unknown[]).length).toBe(1);
		expect(typeof structured.nextCursor).toBe("string");
		expect(decodeCursor(structured.nextCursor as string)).toMatchObject({
			createdBefore: 4242,
		});
	});

	it("a short bare array (scan exhausted) has no cursor", async () => {
		const { structured } = await listDiaries([ROW], { createdBy: "pi", limit: 5 });
		expect(structured.nextCursor ?? null).toBeNull();
	});
});
