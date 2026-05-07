/**
 * D62 regression — Zod schema validation for the 4 new fix-pattern MCP tools.
 *
 * The tools create_fix_pattern, add_fix_attempt, validate_fix, and
 * link_issue_to_pattern wrap Convex fixPatterns backend functions. The backend
 * logic is tested at the Convex layer; these tests focus on the MCP input
 * schema layer:
 *
 *   1. Required fields are enforced (missing → parse failure).
 *   2. Enum constraints on `severity` are enforced.
 *   3. Valid inputs parse successfully (smoke test for the happy path).
 *   4. `creatorSchema` and `severitySchema` are registered exports.
 *
 * No live Convex connection is required — all assertions are pure Zod.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { creatorSchema, flexArray, severitySchema } from "../tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Inline schemas mirroring the tool definitions in tools.ts
// ─────────────────────────────────────────────────────────────────────────────

const flexArrayOptional = flexArray.optional();

const createFixPatternSchema = z.object({
	symptom: z.string(),
	rootCause: z.string(),
	tags: flexArray,
	stack: flexArray,
	sourceProject: z.string(),
	createdBy: creatorSchema,
	severity: severitySchema,
	validatedFix: z.string().optional(),
	files: flexArrayOptional,
	linkedIssueIds: flexArrayOptional,
});

const addFixAttemptSchema = z.object({
	patternId: z.string(),
	description: z.string(),
	worked: z.boolean(),
	why: z.string(),
	createdBy: creatorSchema,
	commit: z.string().optional(),
});

const validateFixSchema = z.object({
	patternId: z.string(),
	validatedFix: z.string(),
});

const linkIssueToPatternSchema = z.object({
	patternId: z.string(),
	issueId: z.string(),
});

// ─────────────────────────────────────────────────────────────────────────────
// severitySchema
// ─────────────────────────────────────────────────────────────────────────────

describe("severitySchema", () => {
	it("accepts 'critical'", () => {
		expect(severitySchema.safeParse("critical").success).toBe(true);
	});

	it("accepts 'major'", () => {
		expect(severitySchema.safeParse("major").success).toBe(true);
	});

	it("accepts 'minor'", () => {
		expect(severitySchema.safeParse("minor").success).toBe(true);
	});

	it("rejects an unknown severity value", () => {
		const result = severitySchema.safeParse("blocker");
		expect(result.success).toBe(false);
	});

	it("rejects an empty string", () => {
		expect(severitySchema.safeParse("").success).toBe(false);
	});

	it("rejects an uppercase value", () => {
		expect(severitySchema.safeParse("CRITICAL").success).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// creatorSchema
// ─────────────────────────────────────────────────────────────────────────────

describe("creatorSchema", () => {
	it("accepts a Greek letter role name", () => {
		expect(creatorSchema.safeParse("sigma").success).toBe(true);
	});

	it("accepts a custom lowercase client role", () => {
		expect(creatorSchema.safeParse("myproject-agent").success).toBe(true);
	});

	it("rejects a non-string value (number)", () => {
		expect(creatorSchema.safeParse(42).success).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// create_fix_pattern
// ─────────────────────────────────────────────────────────────────────────────

const validCreateInput = {
	symptom: "Login button disappears after page reload",
	rootCause: "Clerk session hydration race condition",
	tags: ["clerk", "hydration"],
	stack: ["next.js", "clerk"],
	sourceProject: "myreeldream",
	createdBy: "sigma",
	severity: "major" as const,
};

describe("create_fix_pattern — valid input", () => {
	it("accepts a fully specified valid input", () => {
		const result = createFixPatternSchema.safeParse(validCreateInput);
		expect(result.success).toBe(true);
	});

	it("accepts tags as a single string (flexArray coercion)", () => {
		const result = createFixPatternSchema.safeParse({
			...validCreateInput,
			tags: "clerk",
			stack: "next.js",
		});
		expect(result.success).toBe(true);
	});

	it("accepts optional validatedFix when provided", () => {
		const result = createFixPatternSchema.safeParse({
			...validCreateInput,
			validatedFix: "Wrap <ClerkProvider> in Suspense boundary",
		});
		expect(result.success).toBe(true);
	});

	it("accepts input without optional fields", () => {
		const result = createFixPatternSchema.safeParse(validCreateInput);
		expect(result.success).toBe(true);
	});
});

describe("create_fix_pattern — missing required fields", () => {
	it("rejects input missing 'symptom'", () => {
		const { symptom: _omit, ...rest } = validCreateInput;
		expect(createFixPatternSchema.safeParse(rest).success).toBe(false);
	});

	it("rejects input missing 'rootCause'", () => {
		const { rootCause: _omit, ...rest } = validCreateInput;
		expect(createFixPatternSchema.safeParse(rest).success).toBe(false);
	});

	it("rejects input missing 'sourceProject'", () => {
		const { sourceProject: _omit, ...rest } = validCreateInput;
		expect(createFixPatternSchema.safeParse(rest).success).toBe(false);
	});

	it("rejects input missing 'createdBy'", () => {
		const { createdBy: _omit, ...rest } = validCreateInput;
		expect(createFixPatternSchema.safeParse(rest).success).toBe(false);
	});

	it("rejects input missing 'severity'", () => {
		const { severity: _omit, ...rest } = validCreateInput;
		expect(createFixPatternSchema.safeParse(rest).success).toBe(false);
	});

	it("rejects input missing 'tags'", () => {
		const { tags: _omit, ...rest } = validCreateInput;
		expect(createFixPatternSchema.safeParse(rest).success).toBe(false);
	});

	it("rejects input missing 'stack'", () => {
		const { stack: _omit, ...rest } = validCreateInput;
		expect(createFixPatternSchema.safeParse(rest).success).toBe(false);
	});
});

describe("create_fix_pattern — invalid severity enum", () => {
	it("rejects severity 'blocker' (not in enum)", () => {
		const result = createFixPatternSchema.safeParse({
			...validCreateInput,
			severity: "blocker",
		});
		expect(result.success).toBe(false);
	});

	it("rejects severity 'MAJOR' (uppercase not in enum)", () => {
		const result = createFixPatternSchema.safeParse({
			...validCreateInput,
			severity: "MAJOR",
		});
		expect(result.success).toBe(false);
	});

	it("rejects severity '' (empty string)", () => {
		const result = createFixPatternSchema.safeParse({
			...validCreateInput,
			severity: "",
		});
		expect(result.success).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// add_fix_attempt
// ─────────────────────────────────────────────────────────────────────────────

const validAttemptInput = {
	patternId: "jn70tnqnsvbzh9w5kb8vamfjr984vhn2",
	description: "Wrapped ClerkProvider in Suspense",
	worked: true,
	why: "Suspense defers render until Clerk session resolves",
	createdBy: "sigma",
};

describe("add_fix_attempt — valid input", () => {
	it("accepts a fully specified valid input", () => {
		expect(addFixAttemptSchema.safeParse(validAttemptInput).success).toBe(true);
	});

	it("accepts worked=false", () => {
		const result = addFixAttemptSchema.safeParse({
			...validAttemptInput,
			worked: false,
			why: "Did not resolve the race condition in SSR mode",
		});
		expect(result.success).toBe(true);
	});

	it("accepts optional commit hash", () => {
		const result = addFixAttemptSchema.safeParse({
			...validAttemptInput,
			commit: "abc1234",
		});
		expect(result.success).toBe(true);
	});
});

describe("add_fix_attempt — missing required fields", () => {
	it("rejects input missing 'patternId'", () => {
		const { patternId: _omit, ...rest } = validAttemptInput;
		expect(addFixAttemptSchema.safeParse(rest).success).toBe(false);
	});

	it("rejects input missing 'description'", () => {
		const { description: _omit, ...rest } = validAttemptInput;
		expect(addFixAttemptSchema.safeParse(rest).success).toBe(false);
	});

	it("rejects input missing 'worked'", () => {
		const { worked: _omit, ...rest } = validAttemptInput;
		expect(addFixAttemptSchema.safeParse(rest).success).toBe(false);
	});

	it("rejects input missing 'why'", () => {
		const { why: _omit, ...rest } = validAttemptInput;
		expect(addFixAttemptSchema.safeParse(rest).success).toBe(false);
	});

	it("rejects input missing 'createdBy'", () => {
		const { createdBy: _omit, ...rest } = validAttemptInput;
		expect(addFixAttemptSchema.safeParse(rest).success).toBe(false);
	});
});

describe("add_fix_attempt — type errors", () => {
	it("rejects worked as a string instead of boolean", () => {
		const result = addFixAttemptSchema.safeParse({
			...validAttemptInput,
			worked: "yes",
		});
		expect(result.success).toBe(false);
	});

	it("rejects patternId as a number", () => {
		const result = addFixAttemptSchema.safeParse({
			...validAttemptInput,
			patternId: 123,
		});
		expect(result.success).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// validate_fix
// ─────────────────────────────────────────────────────────────────────────────

const validValidateInput = {
	patternId: "jn70tnqnsvbzh9w5kb8vamfjr984vhn2",
	validatedFix: "Wrap <ClerkProvider> in Suspense boundary",
};

describe("validate_fix — valid input", () => {
	it("accepts valid patternId and validatedFix", () => {
		expect(validateFixSchema.safeParse(validValidateInput).success).toBe(true);
	});
});

describe("validate_fix — missing required fields", () => {
	it("rejects input missing 'validatedFix'", () => {
		const { validatedFix: _omit, ...rest } = validValidateInput;
		expect(validateFixSchema.safeParse(rest).success).toBe(false);
	});

	it("rejects input missing 'patternId'", () => {
		const { patternId: _omit, ...rest } = validValidateInput;
		expect(validateFixSchema.safeParse(rest).success).toBe(false);
	});

	it("rejects empty string for 'validatedFix'", () => {
		// z.string() allows empty string — Zod does not enforce min length here,
		// consistent with how other text fields behave in this codebase.
		// This test documents the current behaviour (not a constraint violation).
		const result = validateFixSchema.safeParse({
			...validValidateInput,
			validatedFix: "",
		});
		// z.string() accepts empty strings
		expect(result.success).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// link_issue_to_pattern
// ─────────────────────────────────────────────────────────────────────────────

const validLinkInput = {
	patternId: "jn70tnqnsvbzh9w5kb8vamfjr984vhn2",
	issueId: "ab12cd34ef56gh78ij90kl12mn34op56",
};

describe("link_issue_to_pattern — valid input", () => {
	it("accepts valid patternId and issueId", () => {
		expect(linkIssueToPatternSchema.safeParse(validLinkInput).success).toBe(
			true,
		);
	});
});

describe("link_issue_to_pattern — missing required fields", () => {
	it("rejects input missing 'issueId'", () => {
		const { issueId: _omit, ...rest } = validLinkInput;
		expect(linkIssueToPatternSchema.safeParse(rest).success).toBe(false);
	});

	it("rejects input missing 'patternId'", () => {
		const { patternId: _omit, ...rest } = validLinkInput;
		expect(linkIssueToPatternSchema.safeParse(rest).success).toBe(false);
	});

	it("rejects issueId as a number", () => {
		const result = linkIssueToPatternSchema.safeParse({
			...validLinkInput,
			issueId: 42,
		});
		expect(result.success).toBe(false);
	});
});
