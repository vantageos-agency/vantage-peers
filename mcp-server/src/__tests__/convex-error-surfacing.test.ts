/**
 * ConvexError.data surfacing — root-cause fix, not cosmetics.
 *
 * Empirically proven bug: every ConvexError thrown by a Convex mutation
 * reaches the MCP server as an object where:
 *   error.constructor.name === "ConvexError"
 *   error.message === "[Request ID: 3e0eac668b68a1ef] Server Error"   <- Convex redacts this
 *   error.data    === "TASK_START_BLOCKED: Cannot start task k174... —
 *                       caller sigma has an unclosed in_progress task ...
 *                       Call complete_task with completionNote first —
 *                       {\"currentInProgressTaskId\":\"k17fvts7...\"}"
 *
 * `mcpConvexError` (tools.ts:787) does:
 *     const rawMessage = error instanceof Error ? error.message : String(error);
 * It NEVER reads `error.data`. Result: all 121 MCP tools surface an opaque
 * "Server Error" instead of the actionable message baked into `.data` by
 * Convex's `ConvexError` payload mechanism.
 *
 * This test pins the fix: `mcpConvexError` must prefer `error.data` (string
 * or JSON-stringified object) over the redacted `.message` when present.
 */

import { describe, expect, it } from "vitest";
import {
	mcpConvexError,
	parseConvexError,
	type ParsedConvexError,
} from "../tools.js";

describe("mcpConvexError — ConvexError.data surfacing (string payload)", () => {
	const e = Object.assign(new Error("[Request ID: abc123] Server Error"), {
		name: "ConvexError",
		data: 'TASK_START_BLOCKED: caller sigma has an unclosed in_progress task "T2b". Call complete_task with completionNote first',
	});

	it("returns isError = true", () => {
		const result = mcpConvexError(e);
		expect(result.isError).toBe(true);
	});

	it("surfaced text contains the actionable code TASK_START_BLOCKED", () => {
		const result = mcpConvexError(e);
		expect(result.content[0].text).toContain("TASK_START_BLOCKED");
	});

	it("surfaced text contains the remediation hint 'complete_task'", () => {
		const result = mcpConvexError(e);
		expect(result.content[0].text).toContain("complete_task");
	});

	it("surfaced text is NOT the bare redacted 'Server Error' string", () => {
		const result = mcpConvexError(e);
		expect(result.content[0].text).not.toBe("Server Error");
		expect(result.content[0].text).not.toBe("Error: Server Error");
	});
});

describe("mcpConvexError — ConvexError.data surfacing (object payload)", () => {
	const e = Object.assign(new Error("[Request ID: def456] Server Error"), {
		name: "ConvexError",
		data: {
			code: "TASK_START_BLOCKED",
			currentInProgressTaskId: "k17fvts7abc123def456abc123def456",
		},
	});

	it("surfaced text contains the code from the data object", () => {
		const result = mcpConvexError(e);
		expect(result.content[0].text).toContain("TASK_START_BLOCKED");
	});

	it("surfaced text contains the JSON-stringified currentInProgressTaskId", () => {
		const result = mcpConvexError(e);
		expect(result.content[0].text).toContain(
			"k17fvts7abc123def456abc123def456",
		);
	});
});

describe("mcpConvexError — non-regression: ArgumentValidationError with no .data", () => {
	const rawMessage =
		"[CONVEX M(tasks:start)] ArgumentValidationError: Value does not match validator. Path: .taskId";

	it("still parses code = ArgumentValidationError", () => {
		const result = mcpConvexError(new Error(rawMessage));
		const payload = JSON.parse(result.content[0].text) as ParsedConvexError;
		expect(payload.code).toBe("ArgumentValidationError");
	});

	it("still parses path = .taskId exactly as today", () => {
		const result = mcpConvexError(new Error(rawMessage));
		const payload = JSON.parse(result.content[0].text) as ParsedConvexError;
		expect(payload.path).toBe(".taskId");
	});
});

describe("mcpConvexError — non-regression: plain Error with no .data", () => {
	it("still falls back to 'Error: <message>' plain text", () => {
		const result = mcpConvexError(new Error("boom"));
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Error: boom");
	});
});

describe("parseConvexError — unchanged behaviour for existing inputs", () => {
	it("still extracts ArgumentValidationError + path from full Convex prefix", () => {
		const rawMessage =
			'[CONVEX M(briefingNotes:create)] ArgumentValidationError: Found ID "js72ewf0mnp13y2a5kf6wdbex9820dk7" from table briefingNotes, which does not match the table name in validator v.id("memories"). Path: .linkedMemoryIds[4]';
		const result = parseConvexError(rawMessage);
		expect(result.code).toBe("ArgumentValidationError");
		expect(result.path).toBe(".linkedMemoryIds[4]");
		expect(result.hint).toContain('"briefingNotes"');
		expect(result.hint).toContain('"memories"');
	});

	it("still returns ServerError code + null path/hint for unknown strings", () => {
		const result = parseConvexError("Something went wrong on the server");
		expect(result.code).toBe("ServerError");
		expect(result.path).toBeNull();
		expect(result.hint).toBeNull();
		expect(result.message).toBe("Something went wrong on the server");
	});
});
