/**
 * Wiring contract test — kills the "surviving mutant" Eta found in PR #1065
 * review: `convex-id-validation.test.ts` proves the exported schemas
 * (taskIdSchema, missionIdSchema, ...) EXIST and behave, but nothing asserted
 * they are actually WIRED into the `server.tool(...)` registrations. A
 * refactor can silently revert `taskId: taskIdSchema.describe(...)` back to
 * `taskId: z.string().describe(...)` (the exact #1063 regression) and the
 * existing suite stays green.
 *
 * This test captures the REAL registration via a fake McpServer passed to
 * `registerTools`, then walks every registered tool's arg shape and asserts
 * the wiring contract holds for every Convex-ID-shaped argument, for EVERY
 * tool at once — no more per-tool mutants can hide.
 */

import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import type { OAuthContext } from "../auth.js";
import { registerTools } from "../tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Capture the real registration
//
// registerTools() must run at MODULE load time (not inside beforeAll) so the
// `registry` Map is already populated when the `describe(...)` bodies below
// execute their synchronous `for (const [toolName, shape] of registry)` loops
// during test collection — vitest collects all `describe`/`it` calls before
// running any `beforeAll` hook.
// ─────────────────────────────────────────────────────────────────────────────

type ZodShape = Record<string, ZodType>;

const registry = new Map<string, ZodShape>();

const fakeServer = {
	tool: (name: string, _description?: unknown, shape?: unknown, ..._rest: unknown[]) => {
		const isShapeObject =
			shape !== null &&
			typeof shape === "object" &&
			// Handler functions (3-arg `tool(name, desc, handler)` form) are not
			// arg-shape objects — guard against recording a function as a shape.
			typeof shape !== "function";
		registry.set(name, isShapeObject ? (shape as ZodShape) : {});
	},
	// `server.registerTool(name, config, handler)` — the config-object entry
	// point defineTool() uses since the Day-159 boot fix (see
	// registerTool.ts). `config.inputSchema` is now an already-built strict
	// ZodObject instance (not a raw shape record), so unwrap `.shape` to keep
	// recording the same per-field validator map this test always walked.
	registerTool: (
		name: string,
		config?: { inputSchema?: { shape?: unknown } },
	) => {
		const shape = config?.inputSchema?.shape;
		const isShapeObject =
			shape !== null && shape !== undefined && typeof shape === "object";
		registry.set(name, isShapeObject ? (shape as ZodShape) : {});
	},
} as unknown as Parameters<typeof registerTools>[0];

const fakeConvex = {} as Parameters<typeof registerTools>[1];

registerTools(fakeServer, fakeConvex, undefined as OAuthContext | undefined);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const TRUNCATED_ID = "k173j35p";
const VALID_ID = "k172735brsw6bc3j2dkkkfxqrx88kkjq";
const NON_CONVEX_STRING = "abc-123-not-convex";

const CONVEX_ID_ARG_NAMES = [
	"taskId",
	"missionId",
	"memoryId",
	"messageId",
	"noteId",
	"componentId",
	"mandateId",
	"patternId",
	"errorId",
	"recurringTaskId",
	"buId",
	"episodeId",
	"targetId",
	"diaryId",
];

const ARRAY_ID_ARG_NAMES = ["dependsOn", "blockedBy"];

const PERMISSIVE_ARG_NAMES = [
	"docId",
	"orgId",
	"orchestratorId",
	"instanceId",
	"tenantId",
	"issueId",
	"storageId",
];

/** Unwrap ZodOptional (and ZodNullable, for good measure) to the inner type. */
function unwrapOptional(schema: ZodLike): ZodLike {
	let current = schema;
	// ZodOptional/ZodNullable/ZodDefault all expose `_def.innerType`.
	while (current?._def?.innerType) {
		current = current._def.innerType;
	}
	return current;
}

/** Unwrap a ZodArray to its element type. */
function unwrapArrayElement(schema: ZodLike): ZodLike | null {
	const unwrapped = unwrapOptional(schema);
	const element = unwrapped?._def?.element ?? unwrapped?.element ?? null;
	return element;
}

function assertRejectsTruncatedAcceptsValid(
	schema: ZodLike,
	label: string,
): void {
	const unwrapped = unwrapOptional(schema);
	const rejectResult = unwrapped.safeParse(TRUNCATED_ID);
	expect(
		rejectResult.success,
		`${label} MUST reject a truncated id ("${TRUNCATED_ID}") — got success=${rejectResult.success}. ` +
			`This is the #1063 regression: a Convex ID arg wired as bare z.string() instead of the strict *IdSchema.`,
	).toBe(false);

	const acceptResult = unwrapped.safeParse(VALID_ID);
	expect(
		acceptResult.success,
		`${label} MUST accept a valid 32-char Convex ID ("${VALID_ID}") — got success=${acceptResult.success}.`,
	).toBe(true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sanity
// ─────────────────────────────────────────────────────────────────────────────

describe("registration sanity", () => {
	it("registers more than 100 tools (registration actually ran)", () => {
		expect(registry.size).toBeGreaterThan(100);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The contract: every Convex-ID-shaped arg, on every registered tool
// ─────────────────────────────────────────────────────────────────────────────

describe("wiring contract — every registered tool's Convex-ID args are strictly validated", () => {
	for (const [toolName, shape] of registry) {
		for (const argName of CONVEX_ID_ARG_NAMES) {
			const schema = shape[argName];
			if (!schema) continue;
			it(`${toolName}.${argName} rejects truncated / accepts valid 32-char id`, () => {
				assertRejectsTruncatedAcceptsValid(schema, `${toolName}.${argName}`);
			});
		}

		for (const argName of ARRAY_ID_ARG_NAMES) {
			const schema = shape[argName];
			if (!schema) continue;
			const element = unwrapArrayElement(schema);
			if (!element) continue;
			it(`${toolName}.${argName}[] element rejects truncated / accepts valid 32-char id`, () => {
				assertRejectsTruncatedAcceptsValid(element, `${toolName}.${argName}[]`);
			});
		}
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// Explicit allow-list — these must STAY permissive (not Convex document IDs)
// ─────────────────────────────────────────────────────────────────────────────

describe("wiring contract — permissive allow-list args must NOT be tightened", () => {
	for (const [toolName, shape] of registry) {
		for (const argName of PERMISSIVE_ARG_NAMES) {
			const schema = shape[argName];
			if (!schema) continue;
			it(`${toolName}.${argName} still accepts a non-Convex-ID string (must stay permissive)`, () => {
				const unwrapped = unwrapOptional(schema);
				const result = unwrapped.safeParse(NON_CONVEX_STRING);
				expect(
					result.success,
					`${toolName}.${argName} unexpectedly rejected a non-Convex-ID string ("${NON_CONVEX_STRING}"). ` +
						`This arg is on the explicit permissive allow-list (${argName}) and must never be tightened ` +
						`to the strict 32-char Convex ID regex — an over-zealous sweep broke it.`,
				).toBe(true);
			});
		}
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// Eta's exact mutant, pinned by name
// ─────────────────────────────────────────────────────────────────────────────

describe("mutant: get_task.taskId must reject a truncated id", () => {
	it("get_task.taskId (as REGISTERED, not the exported schema) rejects a truncated id", () => {
		const shape = registry.get("get_task");
        expect(shape, "get_task must be registered").toBeTruthy();
		const taskIdSchema = shape?.taskId;
		expect(taskIdSchema, "get_task.taskId must exist in the registered shape").toBeTruthy();

		const unwrapped = unwrapOptional(taskIdSchema);
		const result = unwrapped.safeParse(TRUNCATED_ID);
		expect(
			result.success,
			`get_task.taskId accepted the truncated id "${TRUNCATED_ID}" — this is the exact #1063 regression ` +
				`(taskId wired as bare z.string() instead of taskIdSchema).`,
		).toBe(false);
	});
});
