/**
 * Issue #323 regression — mark_as_read Zod schema validation.
 *
 * The `receiptIdSchema` exported from tools.ts must reject any string that
 * does not match the Convex ID format (32 lowercase alphanumeric chars).
 * This catches the class of bugs where LLM callers extract `messageId`
 * (wrong table) or other non-ID strings from check_messages output and pass
 * them directly to mark_as_read.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { convexIdPattern, receiptIdSchema } from "../tools.js";

const receiptIdsArraySchema = z.array(receiptIdSchema).min(1);

describe("convexIdPattern", () => {
	it("matches a valid 32-char lowercase alphanumeric ID", () => {
		expect(convexIdPattern.test("jn70tnqnsvbzh9w5kb8vamfjr984vhn2")).toBe(true);
	});

	it("rejects an ID with uppercase characters", () => {
		expect(convexIdPattern.test("JN70TNQNSVBZH9W5KB8VAMFJR984VHN2")).toBe(
			false,
		);
	});

	it("rejects an ID shorter than 32 chars", () => {
		expect(convexIdPattern.test("jn70tnqnsvbzh9w5kb8vamfjr984")).toBe(false);
	});

	it("rejects an ID longer than 32 chars", () => {
		expect(convexIdPattern.test("jn70tnqnsvbzh9w5kb8vamfjr984vhn2extra")).toBe(
			false,
		);
	});

	it("rejects an empty string", () => {
		expect(convexIdPattern.test("")).toBe(false);
	});
});

describe("receiptIdSchema — Zod refine rejects non-Convex-ID strings", () => {
	it("accepts a valid 32-char lowercase alphanumeric Convex ID", () => {
		const result = receiptIdSchema.safeParse(
			"jn70tnqnsvbzh9w5kb8vamfjr984vhn2",
		);
		expect(result.success).toBe(true);
	});

	it("rejects a plain non-ID string like 'not-an-id'", () => {
		const result = receiptIdSchema.safeParse("not-an-id");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe(
				"receiptId must be a 32-char lowercase alphanumeric Convex ID",
			);
		}
	});

	it("rejects a messages-table ID with uppercase prefix (wrong table shape)", () => {
		// Convex IDs for messages table have the same shape — the issue was LLMs
		// passing a messageId value rather than a receiptId value. The schema cannot
		// distinguish tables at parse time, but it does catch malformed IDs.
		const result = receiptIdSchema.safeParse("UPPERCASE0000000000000000000000");
		expect(result.success).toBe(false);
	});

	it("rejects an empty string", () => {
		const result = receiptIdSchema.safeParse("");
		expect(result.success).toBe(false);
	});

	it("rejects a UUID (wrong format)", () => {
		const result = receiptIdSchema.safeParse(
			"550e8400-e29b-41d4-a716-446655440000",
		);
		expect(result.success).toBe(false);
	});
});

describe("mark_as_read array schema rejects arrays containing invalid IDs", () => {
	it("rejects an array with a mix of valid and invalid IDs", () => {
		const result = receiptIdsArraySchema.safeParse([
			"jn70tnqnsvbzh9w5kb8vamfjr984vhn2",
			"not-an-id",
		]);
		expect(result.success).toBe(false);
	});

	it("rejects an array of all invalid IDs", () => {
		const result = receiptIdsArraySchema.safeParse(["not-an-id", "k97..."]);
		expect(result.success).toBe(false);
		if (!result.success) {
			// At least the first invalid element should produce the custom message
			const messages = result.error.issues.map((i) => i.message);
			expect(
				messages.some((m) =>
					m.includes("32-char lowercase alphanumeric Convex ID"),
				),
			).toBe(true);
		}
	});

	it("rejects an empty array (min(1) guard)", () => {
		const result = receiptIdsArraySchema.safeParse([]);
		expect(result.success).toBe(false);
	});

	it("accepts an array of valid Convex IDs", () => {
		const result = receiptIdsArraySchema.safeParse([
			"jn70tnqnsvbzh9w5kb8vamfjr984vhn2",
			"ab12cd34ef56gh78ij90kl12mn34op56",
		]);
		expect(result.success).toBe(true);
	});
});
