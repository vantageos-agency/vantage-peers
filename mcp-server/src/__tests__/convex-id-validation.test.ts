/**
 * Issues #996..#1063 regression — MCP tools accept Convex document IDs as
 * bare `z.string()`. Peers routinely quote SHORT/TRUNCATED taskIds (8-9
 * chars, e.g. "k173j35p"). These reach the Convex `v.id("tasks")` validator,
 * which throws, surfacing as an opaque raw "Server Error" instead of a clean
 * rejection at the MCP boundary.
 *
 * Root cause: `mcp-server/src/tools.ts:171` exports `convexIdPattern`, but it
 * is wired into ONLY two schemas today — `receiptIdSchema` (tools.ts:172)
 * and `memoryIdSchema` (tools.ts:179). No per-entity id schema exists for
 * tasks, missions, messages, notes, components, mandates, patterns, errors,
 * recurring tasks, business units, or episodes. `get_task` args are
 * `{ taskId: z.string() }` at tools.ts:8783 — no regex boundary at all.
 *
 * This test asserts the EXISTENCE and BEHAVIOUR of the missing per-entity id
 * schemas. RED is expected: the import itself must fail because these
 * schemas do not exist yet in ../tools.js.
 */

import { describe, expect, it } from "vitest";
import {
	convexIdPattern,
	receiptIdSchema,
	memoryIdSchema,
	taskIdSchema,
	missionIdSchema,
	messageIdSchema,
	noteIdSchema,
	componentIdSchema,
	mandateIdSchema,
	patternIdSchema,
	errorIdSchema,
	recurringTaskIdSchema,
	buIdSchema,
	episodeIdSchema,
} from "../tools.js";

const TRUNCATED_ID = "k173j35p";
const UPPERCASE_WRONG_CHARSET_ID = "K173J35PXXXXXXXXXXXXXXXXXXXXXXXX";
const OVER_LONG_ID = "k173j35p".repeat(9);
const VALID_ID = "k172735brsw6bc3j2dkkkfxqrx88kkjq";

type NamedSchema = {
	name: string;
	schema: { safeParse: (v: string) => { success: boolean; error?: { issues: { message: string }[] } } };
};

const entitySchemas: NamedSchema[] = [
	{ name: "taskIdSchema", schema: taskIdSchema },
	{ name: "missionIdSchema", schema: missionIdSchema },
	{ name: "messageIdSchema", schema: messageIdSchema },
	{ name: "noteIdSchema", schema: noteIdSchema },
	{ name: "componentIdSchema", schema: componentIdSchema },
	{ name: "mandateIdSchema", schema: mandateIdSchema },
	{ name: "patternIdSchema", schema: patternIdSchema },
	{ name: "errorIdSchema", schema: errorIdSchema },
	{ name: "recurringTaskIdSchema", schema: recurringTaskIdSchema },
	{ name: "buIdSchema", schema: buIdSchema },
	{ name: "episodeIdSchema", schema: episodeIdSchema },
];

describe("per-entity Convex ID schemas (Issues #996..#1063)", () => {
	for (const { name, schema } of entitySchemas) {
		describe(name, () => {
			it(`rejects a truncated id ("${TRUNCATED_ID}")`, () => {
				const result = schema.safeParse(TRUNCATED_ID);
				expect(result.success).toBe(false);
			});

			it("rejects an uppercase / wrong-charset id", () => {
				const result = schema.safeParse(UPPERCASE_WRONG_CHARSET_ID);
				expect(result.success).toBe(false);
			});

			it("rejects an over-long id", () => {
				const result = schema.safeParse(OVER_LONG_ID);
				expect(result.success).toBe(false);
			});

			it(`accepts a valid 32-char lowercase alphanumeric id ("${VALID_ID}")`, () => {
				const result = schema.safeParse(VALID_ID);
				expect(result.success).toBe(true);
			});

			it("rejection message is explicit and names the field (not a raw Server Error)", () => {
				const result = schema.safeParse(TRUNCATED_ID);
				expect(result.success).toBe(false);
				if (!result.success) {
					expect(result.error!.issues[0].message).toMatch(/32-char/i);
				}
			});
		});
	}
});

describe("non-regression — existing schemas retain current behaviour", () => {
	it("convexIdPattern still matches the shared 32-char lowercase alphanumeric shape", () => {
		expect(convexIdPattern.test(VALID_ID)).toBe(true);
		expect(convexIdPattern.test(TRUNCATED_ID)).toBe(false);
	});

	it("memoryIdSchema still rejects truncated ids and accepts valid ids", () => {
		expect(memoryIdSchema.safeParse(TRUNCATED_ID).success).toBe(false);
		expect(memoryIdSchema.safeParse(VALID_ID).success).toBe(true);
	});

	it("memoryIdSchema still rejects uppercase / over-long ids", () => {
		expect(memoryIdSchema.safeParse(UPPERCASE_WRONG_CHARSET_ID).success).toBe(
			false,
		);
		expect(memoryIdSchema.safeParse(OVER_LONG_ID).success).toBe(false);
	});

	it("receiptIdSchema still rejects truncated ids and accepts valid ids", () => {
		expect(receiptIdSchema.safeParse(TRUNCATED_ID).success).toBe(false);
		expect(receiptIdSchema.safeParse(VALID_ID).success).toBe(true);
	});

	it("receiptIdSchema still rejects uppercase / over-long ids", () => {
		expect(
			receiptIdSchema.safeParse(UPPERCASE_WRONG_CHARSET_ID).success,
		).toBe(false);
		expect(receiptIdSchema.safeParse(OVER_LONG_ID).success).toBe(false);
	});
});
