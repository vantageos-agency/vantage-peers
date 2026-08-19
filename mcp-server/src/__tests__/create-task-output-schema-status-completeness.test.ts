/**
 * mcp-server/src/__tests__/create-task-output-schema-status-completeness.test.ts
 *
 * Operator-caught gap folded into T1 (same status-completeness class):
 * `createTaskOutputSchema` (mcp-server/src/tools.ts) is the ONLY strict
 * status z.enum() in this file — get_task/list_tasks use loose z.record so
 * they cannot drift this way — and it hand-typed a literal list that had
 * already silently fallen behind the Convex union: it omitted "cancelled"
 * (a first-class status with its own cancelReason field, not a note) and
 * would have made the same omission for "failed" (T1) had it not been
 * fixed in the same commit.
 *
 * `create_task` can only ever construct the response with the initial
 * `status` the caller passed to `create`, which itself is currently always
 * "todo" in practice (no live crash today, per the coordinator's own
 * framing) — so there is no live-crash RED to construct here. What this
 * test proves instead: the schema's enum is DERIVED to be the exact,
 * complete canonical set from convex/schema.ts's tasks.status union (not a
 * second hand-typed list that can independently drift), and a response
 * object carrying status="cancelled" (and "failed") DOES parse against it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTaskOutputSchema } from "../tools.js";

function deriveTaskStatusLiteralsFromConvexSchema(): string[] {
	const schemaPath = join(__dirname, "../../../convex/schema.ts");
	const src = readFileSync(schemaPath, "utf8");
	const tasksTableStart = src.indexOf('tasks: defineTable({');
	if (tasksTableStart === -1) {
		throw new Error("Could not locate the `tasks` table in convex/schema.ts");
	}
	const statusBlockStart = src.indexOf("status: v.union(", tasksTableStart);
	if (statusBlockStart === -1) {
		throw new Error("Could not locate tasks.status union in convex/schema.ts");
	}
	// Slice up to the next field (`completionNote:`) rather than tracking
	// paren depth — the block contains only flat v.literal(...) calls plus
	// comments, no nested v.union()/v.object().
	const statusBlockEnd = src.indexOf("completionNote:", statusBlockStart);
	const block = src.slice(statusBlockStart, statusBlockEnd);
	const literals = [...block.matchAll(/v\.literal\("([a-z_]+)"\)/g)].map(
		(m) => m[1],
	);
	if (literals.length === 0) {
		throw new Error("Derived zero status literals — parser broke, not the source of truth");
	}
	return literals;
}

describe("createTaskOutputSchema.status — complete, derived mirror of the Convex tasks.status union", () => {
	it("derives a non-empty canonical set from convex/schema.ts (proves the derivation itself runs, not a hand-copied expectation)", () => {
		const derived = deriveTaskStatusLiteralsFromConvexSchema();
		expect(derived.length).toBeGreaterThanOrEqual(7);
		expect(derived).toContain("todo");
		expect(derived).toContain("done");
	});

	it("createTaskOutputSchema.status enum contains every literal the Convex schema declares — no field silently dropped", () => {
		const derived = deriveTaskStatusLiteralsFromConvexSchema();
		const schemaOptions = createTaskOutputSchema.shape.status.options as string[];
		for (const literal of derived) {
			expect(schemaOptions).toContain(literal);
		}
		// And the reverse: the MCP schema declares nothing the Convex schema
		// doesn't also declare (no phantom values either).
		for (const option of schemaOptions) {
			expect(derived).toContain(option);
		}
	});

	it("a response object carrying status='cancelled' parses against createTaskOutputSchema", () => {
		const result = createTaskOutputSchema.safeParse({
			taskId: "kabc123",
			title: "some task",
			assignedTo: "sigma",
			priority: "medium",
			status: "cancelled",
		});
		expect(result.success).toBe(true);
	});

	it("a response object carrying status='failed' (T1) parses against createTaskOutputSchema", () => {
		const result = createTaskOutputSchema.safeParse({
			taskId: "kabc123",
			title: "some task",
			assignedTo: "sigma",
			priority: "medium",
			status: "failed",
		});
		expect(result.success).toBe(true);
	});
});
