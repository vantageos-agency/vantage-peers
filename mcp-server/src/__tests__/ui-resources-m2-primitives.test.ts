/**
 * Tests for SEP-1865 ui:// resources M2 — 5 new primitives + Zod schemas.
 *
 * Mission : sigma-vantage-peers-mcp-gui-iframe-embed-v1 (k5730xct6rvrwkvxhy5t5js12d87jwfw).
 * Task    : k17dwtcvgyhn5m47stjsby48m187k355
 */

import { describe, expect, it } from "vitest";
import { PRIMITIVES, readUiResource } from "../ui-resources/index.js";
import {
	VpBriefingNotePayloadSchema,
	VpDiaryEntryPayloadSchema,
	VpMemoryPayloadSchema,
	VpMessagePayloadSchema,
	VpMissionPayloadSchema,
	VpTaskPayloadSchema,
	VpToolResultSchema,
} from "../ui-resources/schemas.js";

// ─────────────────────────────────────────────────────────────────────────────
// PRIMITIVES registry
// ─────────────────────────────────────────────────────────────────────────────

describe("PRIMITIVES registry (M2)", () => {
	it("lists 6 primitives including all 5 new M2 ones", () => {
		expect(PRIMITIVES).toHaveLength(6);
		expect(PRIMITIVES).toContain("tasks-table");
		expect(PRIMITIVES).toContain("messages-feed");
		expect(PRIMITIVES).toContain("diary-entry");
		expect(PRIMITIVES).toContain("mission-timeline");
		expect(PRIMITIVES).toContain("briefing-note");
		expect(PRIMITIVES).toContain("memory-quote");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// messages-feed primitive
// ─────────────────────────────────────────────────────────────────────────────

// Helper: extract the HTML content item from readUiResource result.
// readUiResource returns { contents: [{ uri, mimeType, text, _meta }, { uri, mimeType: "text/markdown", text }] }.
// The first content item is always the HTML payload (text/html;profile=mcp-app).
function htmlText(r: Awaited<ReturnType<typeof readUiResource>>): string {
	return (r.contents[0] as { text: string }).text;
}

describe("messages-feed primitive (M2)", () => {
	it("renders empty state when backend returns no messages", async () => {
		const fetchConvex = async () => [];
		const r = await readUiResource(
			"ui://vp/v1/messages-feed?limit=5",
			fetchConvex,
		);
		expect(r.contents[0].mimeType).toContain("text/html");
		expect(htmlText(r)).toContain("vp-messages-feed");
		expect(htmlText(r)).toContain("No messages found");
	});

	it("renders populated messages table", async () => {
		const fetchConvex = async () => [
			{
				_id: "m1",
				from: "sigma",
				channel: "ops",
				content: "Hello world",
				createdAt: 1000,
			},
			{
				_id: "m2",
				from: "pi",
				channel: "general",
				content: "Ack",
				createdAt: 2000,
			},
		];
		const r = await readUiResource("ui://vp/v1/messages-feed", fetchConvex);
		expect(htmlText(r)).toContain("sigma");
		expect(htmlText(r)).toContain("Hello world");
		expect(htmlText(r)).toContain("ops");
		expect(htmlText(r)).toContain("2 messages");
	});

	it("renders French labels when lang=fr", async () => {
		const fetchConvex = async () => [
			{ _id: "m1", from: "sigma", content: "Bonjour", createdAt: 1000 },
		];
		const r = await readUiResource(
			"ui://vp/v1/messages-feed?lang=fr",
			fetchConvex,
		);
		expect(htmlText(r)).toContain("Flux de messages");
		expect(htmlText(r)).toContain("1 message");
	});

	it("escapes XSS in message content", async () => {
		const fetchConvex = async () => [
			{
				_id: "m1",
				from: "<script>",
				content: "<img onerror=alert(1)>",
				createdAt: 1000,
			},
		];
		const r = await readUiResource("ui://vp/v1/messages-feed", fetchConvex);
		expect(htmlText(r)).not.toContain("<script>");
		expect(htmlText(r)).toContain("&lt;script&gt;");
		expect(htmlText(r)).not.toContain("<img onerror");
	});

	it("returns error div when backend throws", async () => {
		const fetchConvex = async () => {
			throw new Error("messages backend down");
		};
		const r = await readUiResource("ui://vp/v1/messages-feed", fetchConvex);
		expect(htmlText(r)).toContain("vp-messages-feed-error");
		expect(htmlText(r)).toContain("messages backend down");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// diary-entry primitive
// ─────────────────────────────────────────────────────────────────────────────

describe("diary-entry primitive (M2)", () => {
	it("renders empty state when no diary entry found", async () => {
		const fetchConvex = async () => null;
		const r = await readUiResource(
			"ui://vp/v1/diary-entry?date=2026-05-28&orchestrator=sigma",
			fetchConvex,
		);
		expect(htmlText(r)).toContain("vp-diary-entry");
		expect(htmlText(r)).toContain("No diary entry found");
	});

	it("renders a single diary entry with highlights and blockers", async () => {
		const fetchConvex = async () => ({
			_id: "d1",
			date: "2026-05-28",
			orchestrator: "sigma",
			content: "Day 84 wrap-up.",
			highlights: ["M1 merged", "M2 started"],
			blockers: ["DB migration pending"],
		});
		const r = await readUiResource(
			"ui://vp/v1/diary-entry?date=2026-05-28&orchestrator=sigma",
			fetchConvex,
		);
		expect(htmlText(r)).toContain("sigma");
		expect(htmlText(r)).toContain("2026-05-28");
		expect(htmlText(r)).toContain("Day 84 wrap-up");
		expect(htmlText(r)).toContain("M1 merged");
		expect(htmlText(r)).toContain("DB migration pending");
	});

	it("renders French labels when lang=fr", async () => {
		const fetchConvex = async () => [
			{
				_id: "d1",
				date: "2026-05-28",
				orchestrator: "sigma",
				content: "Résumé du jour.",
			},
		];
		const r = await readUiResource(
			"ui://vp/v1/diary-entry?lang=fr",
			fetchConvex,
		);
		expect(htmlText(r)).toContain("Journal VantagePeers");
		expect(htmlText(r)).toContain("1 entr");
	});

	it("escapes XSS in diary content", async () => {
		const fetchConvex = async () => [
			{
				_id: "d1",
				date: "2026-05-28",
				orchestrator: "<bad>",
				content: "<script>xss()</script>",
			},
		];
		const r = await readUiResource("ui://vp/v1/diary-entry", fetchConvex);
		expect(htmlText(r)).not.toContain("<script>xss");
		expect(htmlText(r)).toContain("&lt;script&gt;");
	});

	it("returns error div when backend throws", async () => {
		const fetchConvex = async () => {
			throw new Error("diary unavailable");
		};
		const r = await readUiResource("ui://vp/v1/diary-entry", fetchConvex);
		expect(htmlText(r)).toContain("vp-diary-entry-error");
		expect(htmlText(r)).toContain("diary unavailable");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// mission-timeline primitive
// ─────────────────────────────────────────────────────────────────────────────

describe("mission-timeline primitive (M2)", () => {
	it("renders empty state when no missions found", async () => {
		const fetchConvex = async () => [];
		const r = await readUiResource("ui://vp/v1/mission-timeline", fetchConvex);
		expect(htmlText(r)).toContain("vp-mission-timeline");
		expect(htmlText(r)).toContain("No missions found");
	});

	it("renders populated missions table with progress bar", async () => {
		const fetchConvex = async () => [
			{
				_id: "ms1",
				name: "Alpha mission",
				project: "vantage-memory",
				status: "active",
				pilot: "sigma",
				priority: "high",
				progress: 60,
			},
			{
				_id: "ms2",
				name: "Beta mission",
				project: "vantage-peers",
				status: "done",
				pilot: "pi",
				priority: "medium",
				progress: 100,
			},
		];
		const r = await readUiResource("ui://vp/v1/mission-timeline", fetchConvex);
		expect(htmlText(r)).toContain("Alpha mission");
		expect(htmlText(r)).toContain("vp-mission-status-active");
		expect(htmlText(r)).toContain("progressbar");
		expect(htmlText(r)).toContain("2 missions");
	});

	it("renders French labels when lang=fr", async () => {
		const fetchConvex = async () => [
			{ _id: "ms1", name: "Mission test", status: "active" },
		];
		const r = await readUiResource(
			"ui://vp/v1/mission-timeline?lang=fr",
			fetchConvex,
		);
		expect(htmlText(r)).toContain("Missions VantagePeers");
		expect(htmlText(r)).toContain("Statut");
	});

	it("escapes XSS in mission name", async () => {
		const fetchConvex = async () => [
			{ _id: "ms1", name: "<script>evil()</script>", status: "active" },
		];
		const r = await readUiResource("ui://vp/v1/mission-timeline", fetchConvex);
		expect(htmlText(r)).not.toContain("<script>evil");
		expect(htmlText(r)).toContain("&lt;script&gt;");
	});

	it("returns error div when backend throws", async () => {
		const fetchConvex = async () => {
			throw new Error("missions unavailable");
		};
		const r = await readUiResource("ui://vp/v1/mission-timeline", fetchConvex);
		expect(htmlText(r)).toContain("vp-mission-timeline-error");
		expect(htmlText(r)).toContain("missions unavailable");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// briefing-note primitive
// ─────────────────────────────────────────────────────────────────────────────

describe("briefing-note primitive (M2)", () => {
	it("renders empty state when no notes found", async () => {
		const fetchConvex = async () => [];
		const r = await readUiResource("ui://vp/v1/briefing-note", fetchConvex);
		expect(htmlText(r)).toContain("vp-briefing-note");
		expect(htmlText(r)).toContain("No briefing notes found");
	});

	it("renders a briefing note card with participants and content", async () => {
		const fetchConvex = async () => [
			{
				_id: "bn1",
				topic: "architecture",
				title: "M2 design review",
				participants: ["sigma", "pi", "eta"],
				content: "Reviewed M2 scope. Approved.",
				createdBy: "sigma",
			},
		];
		const r = await readUiResource("ui://vp/v1/briefing-note", fetchConvex);
		expect(htmlText(r)).toContain("M2 design review");
		expect(htmlText(r)).toContain("architecture");
		expect(htmlText(r)).toContain("sigma");
		expect(htmlText(r)).toContain("Reviewed M2 scope");
	});

	it("renders French labels when lang=fr", async () => {
		const fetchConvex = async () => [
			{ _id: "bn1", topic: "ops", title: "Note test", participants: ["sigma"] },
		];
		const r = await readUiResource(
			"ui://vp/v1/briefing-note?lang=fr",
			fetchConvex,
		);
		expect(htmlText(r)).toContain("Notes de briefing");
		expect(htmlText(r)).toContain("Participants");
	});

	it("escapes XSS in note title", async () => {
		const fetchConvex = async () => [
			{
				_id: "bn1",
				topic: "security",
				title: '<img src=x onerror="alert(1)">',
				participants: [],
			},
		];
		const r = await readUiResource("ui://vp/v1/briefing-note", fetchConvex);
		expect(htmlText(r)).not.toContain('<img src=x onerror="alert(1)">');
		expect(htmlText(r)).toContain("&lt;img");
	});

	it("returns error div when backend throws", async () => {
		const fetchConvex = async () => {
			throw new Error("briefingNotes backend down");
		};
		const r = await readUiResource("ui://vp/v1/briefing-note", fetchConvex);
		expect(htmlText(r)).toContain("vp-briefing-note-error");
		expect(htmlText(r)).toContain("briefingNotes backend down");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// memory-quote primitive
// ─────────────────────────────────────────────────────────────────────────────

describe("memory-quote primitive (M2)", () => {
	it("returns error when namespace param is missing", async () => {
		const fetchConvex = async () => [];
		const r = await readUiResource("ui://vp/v1/memory-quote", fetchConvex);
		expect(htmlText(r)).toContain("vp-memory-quote-error");
		expect(htmlText(r)).toContain("namespace");
	});

	it("renders empty state when no memories found", async () => {
		const fetchConvex = async () => [];
		const r = await readUiResource(
			"ui://vp/v1/memory-quote?namespace=sigma",
			fetchConvex,
		);
		expect(htmlText(r)).toContain("vp-memory-quote");
		expect(htmlText(r)).toContain("No memories found");
	});

	it("renders populated memory cards", async () => {
		const fetchConvex = async () => [
			{
				_id: "mem1",
				namespace: "sigma",
				type: "feedback",
				content: "Always verify evidence before pushback.",
			},
			{
				_id: "mem2",
				namespace: "sigma",
				type: "decision",
				content: "M2 approved for May 28.",
			},
		];
		const r = await readUiResource(
			"ui://vp/v1/memory-quote?namespace=sigma",
			fetchConvex,
		);
		expect(htmlText(r)).toContain("Always verify evidence");
		expect(htmlText(r)).toContain("feedback");
		expect(htmlText(r)).toContain("2 memor");
	});

	it("renders French labels when lang=fr", async () => {
		const fetchConvex = async () => [
			{
				_id: "mem1",
				namespace: "sigma",
				type: "feedback",
				content: "Feedback FR.",
			},
		];
		const r = await readUiResource(
			"ui://vp/v1/memory-quote?namespace=sigma&lang=fr",
			fetchConvex,
		);
		expect(htmlText(r)).toContain("Mémoires VantagePeers");
		expect(htmlText(r)).toContain("1 mémoire");
	});

	it("escapes XSS in memory content", async () => {
		const fetchConvex = async () => [
			{
				_id: "mem1",
				namespace: "sigma",
				type: "note",
				content: "<script>pwned()</script>",
			},
		];
		const r = await readUiResource(
			"ui://vp/v1/memory-quote?namespace=sigma",
			fetchConvex,
		);
		expect(htmlText(r)).not.toContain("<script>pwned");
		expect(htmlText(r)).toContain("&lt;script&gt;");
	});

	it("returns error div when backend throws", async () => {
		const fetchConvex = async () => {
			throw new Error("memories unavailable");
		};
		const r = await readUiResource(
			"ui://vp/v1/memory-quote?namespace=sigma",
			fetchConvex,
		);
		expect(htmlText(r)).toContain("vp-memory-quote-error");
		expect(htmlText(r)).toContain("memories unavailable");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Zod schemas (M2)
// ─────────────────────────────────────────────────────────────────────────────

describe("VpToolResultSchema discriminated union (M2)", () => {
	it("accepts tasks-table variant", () => {
		const result = VpToolResultSchema.safeParse({
			kind: "tasks-table",
			items: [{ _id: "k1", title: "Task 1", status: "todo" }],
		});
		expect(result.success).toBe(true);
	});

	it("accepts messages-feed variant", () => {
		const result = VpToolResultSchema.safeParse({
			kind: "messages-feed",
			items: [{ _id: "m1", from: "sigma", content: "Hello", createdAt: 1000 }],
		});
		expect(result.success).toBe(true);
	});

	it("accepts diary-entry variant", () => {
		const result = VpToolResultSchema.safeParse({
			kind: "diary-entry",
			item: {
				_id: "d1",
				date: "2026-05-28",
				orchestrator: "sigma",
				content: "Done.",
			},
		});
		expect(result.success).toBe(true);
	});

	it("accepts mission-timeline variant", () => {
		const result = VpToolResultSchema.safeParse({
			kind: "mission-timeline",
			items: [{ _id: "ms1", name: "M2", status: "active" }],
		});
		expect(result.success).toBe(true);
	});

	it("accepts briefing-note variant", () => {
		const result = VpToolResultSchema.safeParse({
			kind: "briefing-note",
			item: { _id: "bn1", topic: "ops", title: "Design review" },
		});
		expect(result.success).toBe(true);
	});

	it("accepts memory-quote variant", () => {
		const result = VpToolResultSchema.safeParse({
			kind: "memory-quote",
			items: [
				{
					_id: "mem1",
					namespace: "sigma",
					type: "feedback",
					content: "Evidence bound done.",
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("rejects unknown kind", () => {
		const result = VpToolResultSchema.safeParse({
			kind: "unknown-kind",
			items: [],
		});
		expect(result.success).toBe(false);
	});

	it("rejects tasks-table with missing required field (title)", () => {
		const result = VpToolResultSchema.safeParse({
			kind: "tasks-table",
			items: [{ _id: "k1", status: "todo" }], // missing title
		});
		expect(result.success).toBe(false);
	});

	it("rejects diary-entry variant when item has missing date", () => {
		const result = VpToolResultSchema.safeParse({
			kind: "diary-entry",
			item: { _id: "d1", orchestrator: "sigma", content: "no date" }, // missing date
		});
		expect(result.success).toBe(false);
	});

	it("VpTaskPayloadSchema accepts optional fields", () => {
		const result = VpTaskPayloadSchema.safeParse({
			_id: "k1",
			title: "Test",
			status: "todo",
			priority: "high",
			assignedTo: "sigma",
			_creationTime: 1000,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.priority).toBe("high");
		}
	});

	it("VpMemoryPayloadSchema accepts score field", () => {
		const result = VpMemoryPayloadSchema.safeParse({
			_id: "mem1",
			namespace: "sigma",
			type: "feedback",
			content: "Test content",
			score: 0.87,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.score).toBe(0.87);
		}
	});

	it("VpMissionPayloadSchema rejects missing name", () => {
		const result = VpMissionPayloadSchema.safeParse({
			_id: "ms1",
			status: "active",
			// missing name
		});
		expect(result.success).toBe(false);
	});

	it("VpBriefingNotePayloadSchema rejects missing topic", () => {
		const result = VpBriefingNotePayloadSchema.safeParse({
			_id: "bn1",
			title: "Note",
			// missing topic
		});
		expect(result.success).toBe(false);
	});

	it("VpMessagePayloadSchema rejects missing content", () => {
		const result = VpMessagePayloadSchema.safeParse({
			_id: "m1",
			from: "sigma",
			createdAt: 1000,
			// missing content
		});
		expect(result.success).toBe(false);
	});

	it("VpDiaryEntryPayloadSchema accepts optional highlights and blockers", () => {
		const result = VpDiaryEntryPayloadSchema.safeParse({
			_id: "d1",
			date: "2026-05-28",
			orchestrator: "sigma",
			content: "Day summary.",
			highlights: ["item 1"],
			blockers: [],
		});
		expect(result.success).toBe(true);
	});
});
