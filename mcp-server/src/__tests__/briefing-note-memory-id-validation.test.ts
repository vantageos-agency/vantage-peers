/**
 * Issue #386 regression — memoryIdSchema Zod validation for briefingNotes.
 *
 * linkedMemoryIds in create_briefing_note and update_briefing_note must only
 * accept 32-char lowercase alphanumeric Convex IDs from the memories table.
 * This catches the class of bugs where a caller passes a briefingNotes ID (or
 * any other non-memories ID) into linkedMemoryIds[], producing an
 * ArgumentValidationError at the Convex boundary.
 *
 * Same defense-in-depth pattern as PR #328 mark_as_read fix.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { memoryIdSchema, updateBriefingNoteSchema } from "../tools.js";

const linkedMemoryIdsArraySchema = z.array(memoryIdSchema);

describe("memoryIdSchema", () => {
	it("accepts a valid 32-char lowercase alphanumeric Convex ID", () => {
		const result = memoryIdSchema.safeParse("js7aky1p5vc5ghwk34y6cbnzx9862dk6");
		expect(result.success).toBe(true);
	});

	it("rejects an empty string", () => {
		const result = memoryIdSchema.safeParse("");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe(
				"Invalid memory ID format (expected 32-char Convex ID)",
			);
		}
	});

	it("rejects a string shorter than 32 chars", () => {
		const result = memoryIdSchema.safeParse("js7aky1p5vc5ghwk34y6cbnzx9862d");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe(
				"Invalid memory ID format (expected 32-char Convex ID)",
			);
		}
	});

	it("rejects a string longer than 32 chars", () => {
		const result = memoryIdSchema.safeParse(
			"js7aky1p5vc5ghwk34y6cbnzx9862dk6extra",
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe(
				"Invalid memory ID format (expected 32-char Convex ID)",
			);
		}
	});

	it("rejects a string with uppercase characters", () => {
		const result = memoryIdSchema.safeParse("JS7AKY1P5VC5GHWK34Y6CBNZX9862DK6");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe(
				"Invalid memory ID format (expected 32-char Convex ID)",
			);
		}
	});
});

describe("create_briefing_note — linkedMemoryIds array rejects invalid IDs", () => {
	it("rejects an array containing one valid and one invalid ID", () => {
		const result = linkedMemoryIdsArraySchema.safeParse([
			"js7aky1p5vc5ghwk34y6cbnzx9862dk6",
			"not-a-valid-convex-id",
		]);
		expect(result.success).toBe(false);
		if (!result.success) {
			const messages = result.error.issues.map((i) => i.message);
			expect(messages.some((m) => m.includes("Invalid memory ID format"))).toBe(
				true,
			);
		}
	});
});

describe("updateBriefingNoteSchema — linkedMemoryIds rejects invalid IDs", () => {
	it("rejects a linkedMemoryIds entry that is a briefingNotes-table ID (wrong table)", () => {
		// The bug: caller passes a briefingNotes document ID where a memories ID
		// is required. The schema must catch this at the MCP boundary.
		const result = updateBriefingNoteSchema.safeParse({
			noteId: "js7aky1p5vc5ghwk34y6cbnzx9862dk6",
			callerOrchestrator: "sigma",
			linkedMemoryIds: ["BRIEFINGNOTEID000000000000000000"],
		});
		expect(result.success).toBe(false);
	});

	it("accepts a valid linkedMemoryIds array", () => {
		const result = updateBriefingNoteSchema.safeParse({
			noteId: "js7aky1p5vc5ghwk34y6cbnzx9862dk6",
			callerOrchestrator: "sigma",
			linkedMemoryIds: ["ab12cd34ef56gh78ij90kl12mn34op56"],
		});
		expect(result.success).toBe(true);
	});
});
