/**
 * Tests for SEP-1865 M3 — __VP_TOOL_RESULT__ stream marker.
 *
 * Mission : sigma-vantage-peers-mcp-gui-iframe-embed-v1 (k5730xct6rvrwkvxhy5t5js12d87jwfw).
 * Covers  : wrapToolResult (×6 valid kinds + throw on invalid), parseToolResult
 *           (roundtrip, non-marker, embedded text, malformed JSON), schema rejects unknown kind.
 */

import { describe, expect, it } from "vitest";
import { VpToolResultSchema } from "../ui-resources/schemas.js";
import {
	MARKER_END,
	MARKER_START,
	parseToolResult,
	wrapToolResult,
} from "../ui-resources/stream-marker.js";

// ─────────────────────────────────────────────────────────────────────────────
// wrapToolResult — 6 valid kinds
// ─────────────────────────────────────────────────────────────────────────────

describe("wrapToolResult — valid kinds", () => {
	it("wraps tasks-table payload with markers", () => {
		const payload = {
			kind: "tasks-table" as const,
			items: [{ _id: "k1", title: "Ship M3", status: "in_progress" }],
		};
		const result = wrapToolResult(payload);
		expect(result.startsWith(MARKER_START)).toBe(true);
		expect(result.endsWith(MARKER_END)).toBe(true);
		expect(result).toContain('"kind":"tasks-table"');
		expect(result).toContain("Ship M3");
	});

	it("wraps messages-feed payload with markers", () => {
		const payload = {
			kind: "messages-feed" as const,
			items: [
				{ _id: "m1", from: "sigma", content: "Hello fleet", createdAt: 1000 },
			],
		};
		const result = wrapToolResult(payload);
		expect(result.startsWith(MARKER_START)).toBe(true);
		expect(result.endsWith(MARKER_END)).toBe(true);
		expect(result).toContain('"kind":"messages-feed"');
		expect(result).toContain("Hello fleet");
	});

	it("wraps diary-entry payload with markers", () => {
		const payload = {
			kind: "diary-entry" as const,
			item: {
				_id: "d1",
				date: "2026-05-28",
				orchestrator: "sigma",
				content: "Day 84 M3 shipped.",
			},
		};
		const result = wrapToolResult(payload);
		expect(result.startsWith(MARKER_START)).toBe(true);
		expect(result.endsWith(MARKER_END)).toBe(true);
		expect(result).toContain('"kind":"diary-entry"');
		expect(result).toContain("Day 84 M3 shipped.");
	});

	it("wraps mission-timeline payload with markers", () => {
		const payload = {
			kind: "mission-timeline" as const,
			items: [
				{
					_id: "ms1",
					name: "sigma-vantage-peers-mcp-gui-iframe-embed-v1",
					status: "execute",
				},
			],
		};
		const result = wrapToolResult(payload);
		expect(result.startsWith(MARKER_START)).toBe(true);
		expect(result.endsWith(MARKER_END)).toBe(true);
		expect(result).toContain('"kind":"mission-timeline"');
	});

	it("wraps briefing-note payload with markers", () => {
		const payload = {
			kind: "briefing-note" as const,
			item: { _id: "bn1", topic: "architecture", title: "M3 design review" },
		};
		const result = wrapToolResult(payload);
		expect(result.startsWith(MARKER_START)).toBe(true);
		expect(result.endsWith(MARKER_END)).toBe(true);
		expect(result).toContain('"kind":"briefing-note"');
		expect(result).toContain("M3 design review");
	});

	it("wraps memory-quote payload with markers", () => {
		const payload = {
			kind: "memory-quote" as const,
			items: [
				{
					_id: "mem1",
					namespace: "sigma",
					type: "feedback",
					content: "Evidence-bound done.",
				},
			],
		};
		const result = wrapToolResult(payload);
		expect(result.startsWith(MARKER_START)).toBe(true);
		expect(result.endsWith(MARKER_END)).toBe(true);
		expect(result).toContain('"kind":"memory-quote"');
		expect(result).toContain("Evidence-bound done.");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// wrapToolResult — throws on invalid payload
// ─────────────────────────────────────────────────────────────────────────────

describe("wrapToolResult — invalid payload", () => {
	it("throws TypeError when kind is unknown", () => {
		expect(() => wrapToolResult({ kind: "unknown-primitive" } as any)).toThrow(
			TypeError,
		);
	});

	it("throws TypeError when tasks-table items element is missing required title", () => {
		expect(() =>
			wrapToolResult({
				kind: "tasks-table",
				items: [{ _id: "k1", status: "todo" } as any],
			}),
		).toThrow(TypeError);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// parseToolResult — roundtrip
// ─────────────────────────────────────────────────────────────────────────────

describe("parseToolResult — roundtrip", () => {
	it("parses a wrapped tasks-table result back to original payload", () => {
		const original = {
			kind: "tasks-table" as const,
			items: [{ _id: "k1", title: "M3", status: "done" }],
		};
		const wrapped = wrapToolResult(original);
		const parsed = parseToolResult(wrapped);
		expect(parsed).not.toBeNull();
		expect(parsed?.kind).toBe("tasks-table");
		if (parsed?.kind === "tasks-table") {
			expect(parsed.items[0]._id).toBe("k1");
			expect(parsed.items[0].title).toBe("M3");
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// parseToolResult — non-marker text returns null
// ─────────────────────────────────────────────────────────────────────────────

describe("parseToolResult — non-marker input", () => {
	it("returns null for plain text without markers", () => {
		expect(parseToolResult("Here are your tasks: task A, task B")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(parseToolResult("")).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// parseToolResult — marker embedded in surrounding text
// ─────────────────────────────────────────────────────────────────────────────

describe("parseToolResult — marker embedded in surrounding text", () => {
	it("extracts marker from surrounding prose", () => {
		const payload = {
			kind: "memory-quote" as const,
			items: [
				{
					_id: "mem1",
					namespace: "sigma",
					type: "feedback",
					content: "Always ship with tests.",
				},
			],
		};
		const marker = wrapToolResult(payload);
		const fullResponse = `Here are your memories:\n${marker}\nPlease review above.`;
		const parsed = parseToolResult(fullResponse);
		expect(parsed).not.toBeNull();
		expect(parsed?.kind).toBe("memory-quote");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// parseToolResult — malformed JSON returns null
// ─────────────────────────────────────────────────────────────────────────────

describe("parseToolResult — malformed JSON", () => {
	it("returns null when JSON between markers is malformed", () => {
		const malformed = `${MARKER_START}{not valid json${MARKER_END}`;
		expect(parseToolResult(malformed)).toBeNull();
	});

	it("returns null when marker start present but end is missing", () => {
		const incomplete = `${MARKER_START}{"kind":"tasks-table","items":[]}`;
		expect(parseToolResult(incomplete)).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// VpToolResultSchema — rejects unknown kind
// ─────────────────────────────────────────────────────────────────────────────

describe("VpToolResultSchema — schema rejects unknown kind", () => {
	it("rejects a payload with an unknown kind string", () => {
		const result = VpToolResultSchema.safeParse({
			kind: "custom-widget",
			items: [],
		});
		expect(result.success).toBe(false);
	});

	it("rejects a payload with no kind field", () => {
		const result = VpToolResultSchema.safeParse({ items: [] });
		expect(result.success).toBe(false);
	});
});
