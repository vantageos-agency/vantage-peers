/**
 * Tests for MCP wrapper Zod schemas added in v2.3.2 hotfix.
 *
 * Backend support (Convex queries) shipped in v2.3.1 sprint
 * `vp-list-queries-fields-lite-status-multi-v1` but MCP wrapper schemas
 * never got updated → clients couldn't pass `fields="lite"` or status
 * aliases/arrays. Day 83 Pi runtime overflow (79k chars list_tasks).
 *
 * This file pins the v2.3.2 schema contract:
 * - fieldsSchema: enum "lite"|"full"
 * - taskStatusFilterSchema: single|alias|array (no aliases inside arrays)
 * - missionStatusFilterSchema: same shape
 *
 * VP task: k17e09ng1tf217n93z9m4tr0mx87hfe0
 */

import { describe, expect, it } from "vitest";
import {
	fieldsSchema,
	missionStatusFilterSchema,
	taskStatusFilterSchema,
} from "../tools.js";

describe("fieldsSchema (v2.3.2)", () => {
	it('accepts "lite"', () => {
		expect(fieldsSchema.parse("lite")).toBe("lite");
	});
	it('accepts "full"', () => {
		expect(fieldsSchema.parse("full")).toBe("full");
	});
	it('rejects invalid enum value "compact"', () => {
		expect(() => fieldsSchema.parse("compact")).toThrow();
	});
	it("rejects non-string input", () => {
		expect(() => fieldsSchema.parse(123)).toThrow();
	});
});

describe("taskStatusFilterSchema (v2.3.2)", () => {
	it('accepts single direct status "todo"', () => {
		expect(taskStatusFilterSchema.parse("todo")).toBe("todo");
	});
	it('accepts single direct status "in_progress"', () => {
		expect(taskStatusFilterSchema.parse("in_progress")).toBe("in_progress");
	});
	it('accepts alias "open"', () => {
		expect(taskStatusFilterSchema.parse("open")).toBe("open");
	});
	it('accepts alias "active"', () => {
		expect(taskStatusFilterSchema.parse("active")).toBe("active");
	});
	it('accepts alias "all"', () => {
		expect(taskStatusFilterSchema.parse("all")).toBe("all");
	});
	it("accepts array of direct statuses", () => {
		expect(taskStatusFilterSchema.parse(["todo", "in_progress"])).toEqual([
			"todo",
			"in_progress",
		]);
	});
	it("rejects array containing alias", () => {
		expect(() => taskStatusFilterSchema.parse(["open", "todo"])).toThrow();
	});
	it("rejects empty array", () => {
		expect(() => taskStatusFilterSchema.parse([])).toThrow();
	});
	it('rejects invalid status "frozen"', () => {
		expect(() => taskStatusFilterSchema.parse("frozen")).toThrow();
	});
});

describe("missionStatusFilterSchema (v2.3.2)", () => {
	it('accepts single direct status "execute"', () => {
		expect(missionStatusFilterSchema.parse("execute")).toBe("execute");
	});
	it('accepts alias "open"', () => {
		expect(missionStatusFilterSchema.parse("open")).toBe("open");
	});
	it("accepts array of direct statuses", () => {
		expect(missionStatusFilterSchema.parse(["plan", "execute"])).toEqual([
			"plan",
			"execute",
		]);
	});
	it("rejects array containing alias", () => {
		expect(() =>
			missionStatusFilterSchema.parse(["active", "plan"]),
		).toThrow();
	});
});
