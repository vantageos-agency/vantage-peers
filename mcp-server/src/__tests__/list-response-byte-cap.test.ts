/**
 * List response byte-cap tests (Day 89 overflow protection).
 *
 * Context: on 2026-05-31 Pi's Claude.ai session received a 75,003-char tool
 * result from `list_tasks` and the MCP client rejected it with
 * "exceeds maximum allowed tokens". The Convex layer already auto-clamps
 * `limit=30` when `fields=full` is used without an explicit limit, but 30
 * full task rows with long descriptions still blow past the 25k-token /
 * ~75 KB MCP client ceiling.
 *
 * `capListResponseBytes` is the universal defensive cap added at the tool
 * layer in v2.4.3. It guarantees no list_* tool ever returns a payload
 * larger than `MAX_LIST_RESPONSE_BYTES` (60 KB) and, when it does truncate,
 * returns a structured `_meta` envelope explaining what to do next.
 */

import { describe, expect, it } from "vitest";
import {
	capListResponseBytes,
	MAX_LIST_RESPONSE_BYTES,
} from "../tools.js";

describe("MAX_LIST_RESPONSE_BYTES constant", () => {
	it("is exactly 60,000 bytes (15 KB headroom under typical 75 KB MCP cap)", () => {
		expect(MAX_LIST_RESPONSE_BYTES).toBe(60_000);
	});
});

describe("capListResponseBytes — under cap", () => {
	it("returns rawText unchanged when under MAX_LIST_RESPONSE_BYTES", () => {
		const items = [{ a: 1 }, { a: 2 }, { a: 3 }];
		const raw = JSON.stringify(items, null, 2);
		const out = capListResponseBytes(items, raw, "list_tasks");
		expect(out).toBe(raw);
	});

	it("returns rawText unchanged when items is empty", () => {
		const items: unknown[] = [];
		const raw = JSON.stringify(items, null, 2);
		const out = capListResponseBytes(items, raw, "list_tasks");
		expect(out).toBe(raw);
	});

	it("returns rawText unchanged when items is not an array (defensive)", () => {
		const items = { some: "object" } as unknown;
		const raw = JSON.stringify(items, null, 2);
		const out = capListResponseBytes(items, raw, "list_tasks");
		expect(out).toBe(raw);
	});
});

describe("capListResponseBytes — over cap", () => {
	function makeItem(i: number, contentSize = 2000): Record<string, unknown> {
		return {
			_id: `item${i.toString().padStart(6, "0")}`,
			title: `Task ${i}`,
			description: "x".repeat(contentSize),
		};
	}

	it("truncates when raw exceeds cap and emits structured _meta envelope", () => {
		const items = Array.from({ length: 100 }, (_, i) => makeItem(i, 2000));
		const raw = JSON.stringify(items, null, 2);
		expect(raw.length).toBeGreaterThan(MAX_LIST_RESPONSE_BYTES);

		const out = capListResponseBytes(items, raw, "list_tasks");
		const parsed = JSON.parse(out);

		expect(parsed._meta).toBeDefined();
		expect(parsed._meta._truncated).toBe(true);
		expect(parsed._meta._tool).toBe("list_tasks");
		expect(parsed._meta._total).toBe(100);
		expect(parsed._meta._showing).toBeGreaterThan(0);
		expect(parsed._meta._showing).toBeLessThan(100);
		expect(parsed._meta._bytesOriginal).toBe(raw.length);
		expect(parsed._meta._bytesCap).toBe(MAX_LIST_RESPONSE_BYTES);
		expect(typeof parsed._meta._advice).toBe("string");
		expect(parsed._meta._advice).toMatch(/fields="lite"|limit|filter/i);
	});

	it("truncated payload fits under cap (binary-halving converges)", () => {
		const items = Array.from({ length: 200 }, (_, i) => makeItem(i, 1500));
		const raw = JSON.stringify(items, null, 2);
		const out = capListResponseBytes(items, raw, "list_missions");
		expect(out.length).toBeLessThanOrEqual(MAX_LIST_RESPONSE_BYTES);
	});

	it("preserves first-N order in truncated items (FIFO, no reorder)", () => {
		const items = Array.from({ length: 100 }, (_, i) => makeItem(i, 2000));
		const raw = JSON.stringify(items, null, 2);
		const out = capListResponseBytes(items, raw, "list_briefing_notes");
		const parsed = JSON.parse(out);

		// First item in truncated list must be the first item in the original
		expect(parsed.items[0]._id).toBe("item000000");
		// Each subsequent item's index is contiguous (no skipping)
		for (let i = 0; i < parsed.items.length; i++) {
			expect(parsed.items[i]._id).toBe(`item${i.toString().padStart(6, "0")}`);
		}
	});

	it("supports custom maxBytes override (smaller cap → smaller payload)", () => {
		const items = Array.from({ length: 50 }, (_, i) => makeItem(i, 500));
		const raw = JSON.stringify(items, null, 2);
		const out = capListResponseBytes(items, raw, "list_tasks", 5_000);
		const parsed = JSON.parse(out);

		expect(out.length).toBeLessThanOrEqual(5_000);
		expect(parsed._meta._bytesCap).toBe(5_000);
		expect(parsed._meta._showing).toBeLessThan(50);
	});

	it("retains tool name in the envelope for debugging", () => {
		const items = Array.from({ length: 100 }, (_, i) => makeItem(i, 2000));
		const raw = JSON.stringify(items, null, 2);

		for (const toolName of [
			"list_tasks",
			"list_missions",
			"list_briefing_notes",
			"list_diaries",
			"list_memories",
			"list_messages",
			"list_components",
		]) {
			const out = capListResponseBytes(items, raw, toolName);
			const parsed = JSON.parse(out);
			expect(parsed._meta._tool).toBe(toolName);
		}
	});
});

describe("capListResponseBytes — Day 89 regression (Pi 75k overflow)", () => {
	it("reproduces Pi's 2026-05-31 75,003-char overflow and caps it", () => {
		// Simulate the actual incident: ~30 full task rows with descriptions
		// totalling ~75 KB.
		const items = Array.from({ length: 30 }, (_, i) => ({
			_id: `j97abc${i.toString().padStart(26, "0")}`,
			_creationTime: 1780000000000 + i,
			title: `Task ${i} — long descriptive title that adds to byte count`,
			description: "x".repeat(2400),
			status: "todo",
			priority: "high",
			assignedTo: "sigma",
			createdBy: "pi",
			project: "vantage-peers",
			tags: ["day-89", "regression"],
		}));
		const raw = JSON.stringify(items, null, 2);
		expect(raw.length).toBeGreaterThan(60_000);

		const out = capListResponseBytes(items, raw, "list_tasks");
		expect(out.length).toBeLessThanOrEqual(MAX_LIST_RESPONSE_BYTES);

		const parsed = JSON.parse(out);
		expect(parsed._meta._truncated).toBe(true);
		expect(parsed._meta._total).toBe(30);
	});
});
