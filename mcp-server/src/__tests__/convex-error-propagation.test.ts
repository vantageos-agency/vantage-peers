/**
 * Unit tests for parseConvexError + mcpConvexError helpers.
 *
 * Root cause (Day 52 PM / Day 83 task k1764wwsyczv92a3g4q3gp0egn85n0q8):
 * When briefingNotes:create is called with a briefingNotes document ID in
 * linkedMemoryIds (which expects v.id("memories")), Convex returns:
 *
 *   "[CONVEX M(briefingNotes:create)] ArgumentValidationError: Found ID
 *   \"js72ewf0m...\" from table briefingNotes, which does not match the table
 *   name in validator v.id(\"memories\"). Path: .linkedMemoryIds[4]"
 *
 * Without explicit parsing the MCP client receives a bare "Error: Server Error"
 * string (or the full Convex message wrapped without structure) and cannot
 * diagnose the root cause.  These tests pin the contract of the two helpers.
 *
 * Victor incident Request IDs: 7c8a9947df75ae15 + 55bd859a570744dc (Day 54)
 * confirmed identical root cause; doublon closed as k17b7es0f.
 */

import { describe, expect, it } from "vitest";
import {
	mcpConvexError,
	parseConvexError,
	type ParsedConvexError,
} from "../tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// parseConvexError — unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("parseConvexError — ArgumentValidationError with full Convex prefix", () => {
	const rawMessage =
		'[CONVEX M(briefingNotes:create)] ArgumentValidationError: Found ID "js72ewf0mnp13y2a5kf6wdbex9820dk7" from table briefingNotes, which does not match the table name in validator v.id("memories"). Path: .linkedMemoryIds[4]';

	it("extracts code = ArgumentValidationError", () => {
		const result = parseConvexError(rawMessage);
		expect(result.code).toBe("ArgumentValidationError");
	});

	it("extracts path = .linkedMemoryIds[4]", () => {
		const result = parseConvexError(rawMessage);
		expect(result.path).toBe(".linkedMemoryIds[4]");
	});

	it("message does not contain the [CONVEX M(...)] prefix", () => {
		const result = parseConvexError(rawMessage);
		expect(result.message).not.toContain("[CONVEX");
	});

	it("message contains the core description about the wrong table", () => {
		const result = parseConvexError(rawMessage);
		expect(result.message).toContain("briefingNotes");
		expect(result.message).toContain("memories");
	});

	it("hint identifies the source and expected table", () => {
		const result = parseConvexError(rawMessage);
		expect(result.hint).not.toBeNull();
		expect(result.hint).toContain('"briefingNotes"');
		expect(result.hint).toContain('"memories"');
	});
});

describe("parseConvexError — ArgumentValidationError without prefix", () => {
	const rawMessage =
		'ArgumentValidationError: Found ID "abc123" from table tasks, which does not match the table name in validator v.id("memories"). Path: .linkedMemoryIds[0]';

	it("extracts code = ArgumentValidationError", () => {
		const result = parseConvexError(rawMessage);
		expect(result.code).toBe("ArgumentValidationError");
	});

	it("extracts path = .linkedMemoryIds[0]", () => {
		const result = parseConvexError(rawMessage);
		expect(result.path).toBe(".linkedMemoryIds[0]");
	});

	it("hint identifies tasks vs memories", () => {
		const result = parseConvexError(rawMessage);
		expect(result.hint).toContain('"tasks"');
		expect(result.hint).toContain('"memories"');
	});
});

describe("parseConvexError — update_briefing_note path variant", () => {
	const rawMessage =
		'[CONVEX M(briefingNotes:update)] ArgumentValidationError: Found ID "ab12cd34ef56gh78ij90kl12mn34op56" from table briefingNotes, which does not match the table name in validator v.id("memories"). Path: .linkedMemoryIds[0]';

	it("extracts code = ArgumentValidationError", () => {
		expect(parseConvexError(rawMessage).code).toBe("ArgumentValidationError");
	});

	it("extracts path = .linkedMemoryIds[0]", () => {
		expect(parseConvexError(rawMessage).path).toBe(".linkedMemoryIds[0]");
	});
});

describe("parseConvexError — non-ArgumentValidation error", () => {
	it("returns ServerError code for an unknown error", () => {
		const result = parseConvexError("Something went wrong on the server");
		expect(result.code).toBe("ServerError");
		expect(result.path).toBeNull();
		expect(result.hint).toBeNull();
		expect(result.message).toBe("Something went wrong on the server");
	});

	it("returns ServerError for a generic network error", () => {
		const result = parseConvexError("Failed to fetch");
		expect(result.code).toBe("ServerError");
	});

	it("detects AuthorizationError code", () => {
		const result = parseConvexError("AuthorizationError: not allowed");
		expect(result.code).toBe("AuthorizationError");
		expect(result.message).toBe("not allowed");
	});
});

describe("parseConvexError — path extraction edge cases", () => {
	it("returns null path when no 'Path:' segment exists", () => {
		const result = parseConvexError(
			"ArgumentValidationError: Expected string, got number",
		);
		expect(result.path).toBeNull();
		expect(result.code).toBe("ArgumentValidationError");
	});

	it("handles nested array path like .linkedMemoryIds[10]", () => {
		const raw =
			'ArgumentValidationError: type mismatch. Path: .linkedMemoryIds[10]';
		expect(parseConvexError(raw).path).toBe(".linkedMemoryIds[10]");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// mcpConvexError — unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("mcpConvexError — ArgumentValidationError produces structured JSON", () => {
	const rawMessage =
		'[CONVEX M(briefingNotes:create)] ArgumentValidationError: Found ID "js72ewf0mnp13y2a5kf6wdbex9820dk7" from table briefingNotes, which does not match the table name in validator v.id("memories"). Path: .linkedMemoryIds[4]';

	it("sets isError = true", () => {
		const result = mcpConvexError(new Error(rawMessage));
		expect(result.isError).toBe(true);
	});

	it("content[0].type = 'text'", () => {
		const result = mcpConvexError(new Error(rawMessage));
		expect(result.content[0].type).toBe("text");
	});

	it("content[0].text is valid JSON", () => {
		const result = mcpConvexError(new Error(rawMessage));
		expect(() => JSON.parse(result.content[0].text)).not.toThrow();
	});

	it("parsed JSON has code = ArgumentValidationError", () => {
		const result = mcpConvexError(new Error(rawMessage));
		const payload = JSON.parse(result.content[0].text) as ParsedConvexError;
		expect(payload.code).toBe("ArgumentValidationError");
	});

	it("parsed JSON has path = .linkedMemoryIds[4]", () => {
		const result = mcpConvexError(new Error(rawMessage));
		const payload = JSON.parse(result.content[0].text) as ParsedConvexError;
		expect(payload.path).toBe(".linkedMemoryIds[4]");
	});

	it("parsed JSON has non-null hint", () => {
		const result = mcpConvexError(new Error(rawMessage));
		const payload = JSON.parse(result.content[0].text) as ParsedConvexError;
		expect(payload.hint).toBeTruthy();
	});

	it("parsed JSON does NOT contain bare 'Server Error' string", () => {
		const result = mcpConvexError(new Error(rawMessage));
		expect(result.content[0].text).not.toContain("Server Error");
	});
});

describe("mcpConvexError — unknown error falls back to plain text", () => {
	it("formats unknown error as 'Error: <message>'", () => {
		const result = mcpConvexError(new Error("Something totally unexpected"));
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Error: Something totally unexpected");
	});

	it("handles non-Error thrown values (string)", () => {
		const result = mcpConvexError("raw string thrown");
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Error: raw string thrown");
	});

	it("handles non-Error thrown values (null)", () => {
		const result = mcpConvexError(null);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Error: null");
	});
});

describe("mcpConvexError — Victor incident replay (Request IDs 7c8a9947 + 55bd8599)", () => {
	// Exact error string from Day 54 incident as reported in task k17b7es0f
	const victorRawMessage =
		'[CONVEX M(briefingNotes:create)] ArgumentValidationError: Found ID "js72ewf0m6gqq0zk3m5hhk1jed873p0x" from table briefingNotes, which does not match the table name in validator v.id("memories"). Path: .linkedMemoryIds[4]';

	it("incident error does NOT produce bare 'Server Error' in response", () => {
		const result = mcpConvexError(new Error(victorRawMessage));
		const text = result.content[0].text;
		expect(text).not.toBe("Error: Server Error");
		expect(text).not.toContain('"Server Error"');
	});

	it("incident error produces ArgumentValidationError code in JSON", () => {
		const result = mcpConvexError(new Error(victorRawMessage));
		const payload = JSON.parse(result.content[0].text) as ParsedConvexError;
		expect(payload.code).toBe("ArgumentValidationError");
		expect(payload.path).toBe(".linkedMemoryIds[4]");
	});
});
