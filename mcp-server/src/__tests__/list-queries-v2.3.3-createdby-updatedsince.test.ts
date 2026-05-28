/**
 * Tests for v2.3.3 MCP wrapper schemas:
 * - updatedSinceSchema (integer ms timestamp)
 * - createdBy filter exposed on list_tasks + list_tasks_by_mission
 * - updatedSince filter exposed on all 4 list tools
 *
 * Follow-up to v2.3.2 (PR #537) per Pi scope élargi Day 84.
 * VP task: k1796s5j6jfkvkx0tn5n926ftd87jx9p
 */

import { describe, expect, it } from "vitest";
import { updatedSinceSchema } from "../tools.js";

describe("updatedSinceSchema (v2.3.3)", () => {
	it("accepts positive integer timestamp", () => {
		expect(updatedSinceSchema.parse(1779949000000)).toBe(1779949000000);
	});
	it("accepts very recent timestamp", () => {
		const now = Date.now();
		expect(updatedSinceSchema.parse(now)).toBe(now);
	});
	it("rejects negative number", () => {
		expect(() => updatedSinceSchema.parse(-1)).toThrow();
	});
	it("rejects zero", () => {
		expect(() => updatedSinceSchema.parse(0)).toThrow();
	});
	it("rejects float", () => {
		expect(() => updatedSinceSchema.parse(1779949.5)).toThrow();
	});
	it("rejects string", () => {
		expect(() => updatedSinceSchema.parse("2026-05-28")).toThrow();
	});
	it("accepts well-known last-24h pattern", () => {
		const last24h = Date.now() - 24 * 60 * 60 * 1000;
		expect(updatedSinceSchema.parse(last24h)).toBe(last24h);
	});
});

// Note: createdBy uses the existing assigneeSchema (already tested).
// Validation that creator names like "pi", "alpha", "sigma" pass is covered
// implicitly by assigneeSchema enum (no need to duplicate).

describe("v2.3.3 schema integration sanity", () => {
	it("updatedSinceSchema accepts boundary 1ms timestamp", () => {
		expect(updatedSinceSchema.parse(1)).toBe(1);
	});
	it("updatedSinceSchema rejects null", () => {
		expect(() => updatedSinceSchema.parse(null)).toThrow();
	});
	it("updatedSinceSchema rejects undefined explicitly", () => {
		expect(() => updatedSinceSchema.parse(undefined)).toThrow();
	});
});

describe("updatedSinceSchema edge cases", () => {
	it("rejects empty object", () => {
		expect(() => updatedSinceSchema.parse({})).toThrow();
	});
	it("rejects empty array", () => {
		expect(() => updatedSinceSchema.parse([])).toThrow();
	});
	it("rejects Infinity", () => {
		expect(() => updatedSinceSchema.parse(Number.POSITIVE_INFINITY)).toThrow();
	});
	it("rejects NaN", () => {
		expect(() => updatedSinceSchema.parse(Number.NaN)).toThrow();
	});
	it("rejects boolean true coerced", () => {
		expect(() => updatedSinceSchema.parse(true)).toThrow();
	});
});
