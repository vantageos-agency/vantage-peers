/**
 * create_task requires `project` at the tool boundary (task k17c7mz2n765wacn6qxcgy00vn8hsa58).
 * Poles: REFUSED without / empty / whitespace project; ACCEPTED with one, trimmed.
 */
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { LOCAL_STDIO_TRUST_CTX } from "../src/auth.js";
import { registerTools } from "../src/tools.js";

function createTaskSchema(): z.ZodTypeAny {
	const shapes = new Map<string, z.ZodTypeAny>();
	const reg = (...a: unknown[]) => {
		const config = a[1] as { inputSchema?: z.ZodTypeAny } | undefined;
		if (config?.inputSchema) shapes.set(a[0] as string, config.inputSchema);
		return {};
	};
	const convex = { query: vi.fn(), mutation: vi.fn(), action: vi.fn() };
	registerTools(
		{ registerTool: reg, tool: reg } as unknown as Parameters<typeof registerTools>[0],
		convex as unknown as Parameters<typeof registerTools>[1],
		LOCAL_STDIO_TRUST_CTX,
	);
	const schema = shapes.get("create_task");
	if (!schema) throw new Error("create_task not registered");
	return schema;
}

describe("create_task input schema: project is required", () => {
	const base = { title: "t", assignedTo: "beta", priority: "low" };

	it("REFUSED: project omitted", () => {
		expect(createTaskSchema().safeParse(base).success).toBe(false);
	});
	it("REFUSED: project empty", () => {
		expect(createTaskSchema().safeParse({ ...base, project: "" }).success).toBe(false);
	});
	it("REFUSED: project whitespace only", () => {
		expect(createTaskSchema().safeParse({ ...base, project: "   " }).success).toBe(false);
	});
	it("ACCEPTED: a real project, trimmed", () => {
		const r = createTaskSchema().safeParse({ ...base, project: " vantage-peers " });
		expect(r.success).toBe(true);
		if (r.success) expect((r.data as { project: string }).project).toBe("vantage-peers");
	});
});
