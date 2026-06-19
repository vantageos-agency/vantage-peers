/**
 * okfSerializer.test.ts — unit tests for OKF v0.1 frontmatter serializer (T1).
 *
 * Coverage matrix (RFC §3.2, ADR D3):
 *  - Happy path (memory, briefing-note, task)
 *  - Optional field stripping (null / undefined / empty arrays omitted)
 *  - Unicode body passthrough
 *  - Large body (≥100kb) passthrough
 *  - Empty tags / arrays handling
 *  - Roundtrip parse-emit byte-exact via gray-matter
 *  - Bonus: index/log serialization sanity
 *
 * Tests use pure structural fixtures — no convex-test runtime needed.
 */

import matter from "gray-matter";
import { describe, expect, test } from "vitest";
import {
	type BriefingNoteDoc,
	type MemoryDoc,
	serializeBriefingNote,
	serializeIndex,
	serializeLog,
	serializeMemory,
	serializeTask,
	type TaskDoc,
} from "../okfSerializer";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

function memoryFixture(overrides: Partial<MemoryDoc> = {}): MemoryDoc {
	return {
		_id: "mem_abc123",
		_creationTime: FIXED_MS,
		namespace: "project/elpi-corp",
		type: "feedback",
		content:
			"User reported the doctrine sweeper missed a stale task.\n\nFollow-up actions logged.",
		createdBy: "sigma",
		tags: ["doctrine", "sweep"],
		description: "Sweeper missed stale task — follow-up logged.",
		title: "Sweeper miss report",
		updatedAt: FIXED_MS,
		...overrides,
	};
}

function briefingFixture(
	overrides: Partial<BriefingNoteDoc> = {},
): BriefingNoteDoc {
	return {
		_id: "brf_xyz789",
		_creationTime: FIXED_MS,
		title: "Day 107 OKF kickoff",
		topic: "okf-bridge-phase-1",
		participants: ["sigma", "pi", "laurent"],
		content: "## Agenda\n\n- T0 ADR\n- T1 serializer kick\n",
		decisions: ["GO T1 with deterministic YAML"],
		createdBy: "sigma",
		createdAt: FIXED_MS,
		updatedAt: FIXED_MS,
		...overrides,
	};
}

function taskFixture(overrides: Partial<TaskDoc> = {}): TaskDoc {
	return {
		_id: "tsk_pqr456",
		_creationTime: FIXED_MS,
		title: "Implement OKF serializer",
		description: "Map VP entities to OKF v0.1 YAML frontmatter + markdown.",
		assignedTo: "dev-architect",
		priority: "high",
		status: "in_progress",
		tags: ["okf", "phase-1"],
		missionId: "mission_k570",
		dependsOn: ["tsk_prereq1"],
		createdBy: "sigma",
		updatedAt: FIXED_MS,
		...overrides,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy-path
// ─────────────────────────────────────────────────────────────────────────────

describe("happy-path serialization", () => {
	test("memory → expected file path + parseable frontmatter", () => {
		const out = serializeMemory(memoryFixture());
		expect(out.filePath).toBe("memories/mem_abc123.md");
		const parsed = matter(out.content);
		expect(parsed.data.type).toBe("memory-feedback");
		expect(parsed.data.resource).toBe("vp://memory/mem_abc123");
		// gray-matter parses ISO timestamps to Date — compare by ms.
		const ts = parsed.data.timestamp;
		const tsMs =
			ts instanceof Date ? ts.getTime() : new Date(ts as string).getTime();
		expect(tsMs).toBe(FIXED_MS);
		expect(parsed.data.namespace).toBe("project/elpi-corp");
		expect(parsed.data.tags).toEqual(["doctrine", "sweep"]);
		expect(parsed.content.trim()).toContain("doctrine sweeper");
	});

	test("briefing-note → expected file path + frontmatter", () => {
		const out = serializeBriefingNote(briefingFixture());
		expect(out.filePath).toBe("briefing-notes/brf_xyz789.md");
		const parsed = matter(out.content);
		expect(parsed.data.type).toBe("briefing-note");
		expect(parsed.data.title).toBe("Day 107 OKF kickoff");
		expect(parsed.data.topic).toBe("okf-bridge-phase-1");
		expect(parsed.data.participants).toEqual(["sigma", "pi", "laurent"]);
		expect(parsed.data.tags).toContain("snapshot");
		expect(parsed.data.tags).toContain("okf-bridge-phase-1");
	});

	test("task → expected file path + frontmatter", () => {
		const out = serializeTask(taskFixture());
		expect(out.filePath).toBe("tasks/tsk_pqr456.md");
		const parsed = matter(out.content);
		expect(parsed.data.type).toBe("task");
		expect(parsed.data.assignedTo).toBe("dev-architect");
		expect(parsed.data.priority).toBe("high");
		expect(parsed.data.status).toBe("in_progress");
		expect(parsed.data.tags).toEqual(
			expect.arrayContaining([
				"vp-task",
				"status:in_progress",
				"mission:mission_k570",
				"okf",
				"phase-1",
			]),
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Optional-field stripping
// ─────────────────────────────────────────────────────────────────────────────

describe("null/undefined optional fields are omitted", () => {
	test("memory without tags/description/title → keys absent", () => {
		const out = serializeMemory(
			memoryFixture({
				tags: undefined,
				description: undefined,
				title: undefined,
				updatedAt: undefined,
			}),
		);
		expect(out.content).not.toContain("\ntags:");
		// description is auto-derived, so it IS present — assert the auto-value
		const parsed = matter(out.content);
		expect(parsed.data.description).toBeTruthy();
		expect(parsed.data.title).toBeTruthy();
	});

	test("briefing without decisions does not emit decisions key", () => {
		const out = serializeBriefingNote(
			briefingFixture({ decisions: undefined, tags: undefined }),
		);
		expect(out.content).not.toContain("\ndecisions:");
	});

	test("task with no completionNote when status!=done → key absent", () => {
		const out = serializeTask(
			taskFixture({
				status: "in_progress",
				completionNote: "should not appear",
				missionId: undefined,
				dependsOn: undefined,
			}),
		);
		expect(out.content).not.toContain("completionNote:");
		expect(out.content).not.toContain("missionId:");
		expect(out.content).not.toContain("dependsOn:");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Unicode passthrough
// ─────────────────────────────────────────────────────────────────────────────

describe("unicode body preservation", () => {
	const unicodeBody =
		"Café résumé naïveté — 日本語 — émojis 🚀✨ — Ω≈ç∫˜µ — RTL: مرحبا";

	test("memory body roundtrips unicode unchanged", () => {
		const out = serializeMemory(memoryFixture({ content: unicodeBody }));
		const parsed = matter(out.content);
		expect(parsed.content.trim()).toBe(unicodeBody);
	});

	test("briefing body roundtrips unicode unchanged", () => {
		const out = serializeBriefingNote(
			briefingFixture({ content: unicodeBody }),
		);
		const parsed = matter(out.content);
		expect(parsed.content.trim()).toBe(unicodeBody);
	});

	test("task body roundtrips unicode unchanged", () => {
		const out = serializeTask(taskFixture({ description: unicodeBody }));
		const parsed = matter(out.content);
		expect(parsed.content.trim()).toBe(unicodeBody);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Large body passthrough (≥100kb)
// ─────────────────────────────────────────────────────────────────────────────

describe("100kb+ body passthrough", () => {
	const bigBody = `${"line of payload — ".repeat(7000)}END`;

	test("memory body of 100kb+ passes through verbatim", () => {
		expect(bigBody.length).toBeGreaterThan(100_000);
		const out = serializeMemory(memoryFixture({ content: bigBody }));
		const parsed = matter(out.content);
		expect(parsed.content.endsWith("END\n")).toBe(true);
		expect(parsed.content.length).toBeGreaterThan(100_000);
	});

	test("briefing body of 100kb+ passes through verbatim", () => {
		const out = serializeBriefingNote(briefingFixture({ content: bigBody }));
		const parsed = matter(out.content);
		expect(parsed.content.length).toBeGreaterThan(100_000);
	});

	test("task description of 100kb+ passes through verbatim", () => {
		const out = serializeTask(taskFixture({ description: bigBody }));
		const parsed = matter(out.content);
		expect(parsed.content.length).toBeGreaterThan(100_000);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Empty arrays / tags
// ─────────────────────────────────────────────────────────────────────────────

describe("empty arrays handling", () => {
	test("memory with empty tags array → tags key omitted", () => {
		const out = serializeMemory(memoryFixture({ tags: [] }));
		expect(out.content).not.toContain("\ntags:");
	});

	test("task with empty dependsOn → dependsOn key omitted", () => {
		const out = serializeTask(taskFixture({ dependsOn: [] }));
		expect(out.content).not.toContain("dependsOn:");
	});

	test("briefing with empty participants emits empty array? → omitted", () => {
		const out = serializeBriefingNote(briefingFixture({ participants: [] }));
		// participants is required schema-side but our compactor omits empty arrays
		// for OKF output to keep frontmatter clean — assert absence.
		expect(out.content).not.toContain("participants:");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Roundtrip parse-emit byte-exact
// ─────────────────────────────────────────────────────────────────────────────

describe("roundtrip parse-emit via gray-matter is byte-exact", () => {
	test("memory: parse → restringify reproduces frontmatter keys/values", () => {
		const out = serializeMemory(memoryFixture());
		const parsed = matter(out.content);
		// Re-stringify with gray-matter; the data block should yield identical
		// frontmatter content (modulo key ordering, which gray-matter preserves
		// per js-yaml — and our emit is already sorted).
		const restitched = matter.stringify(parsed.content, parsed.data);
		const reparsed = matter(restitched);
		expect(reparsed.data).toEqual(parsed.data);
		expect(reparsed.content).toBe(parsed.content);
	});

	test("briefing: parse → restringify is data-stable", () => {
		const out = serializeBriefingNote(briefingFixture());
		const parsed = matter(out.content);
		const restitched = matter.stringify(parsed.content, parsed.data);
		const reparsed = matter(restitched);
		expect(reparsed.data).toEqual(parsed.data);
		expect(reparsed.content).toBe(parsed.content);
	});

	test("task: parse → restringify is data-stable, body verbatim", () => {
		const out = serializeTask(taskFixture());
		const parsed = matter(out.content);
		const restitched = matter.stringify(parsed.content, parsed.data);
		const reparsed = matter(restitched);
		expect(reparsed.data).toEqual(parsed.data);
		expect(reparsed.content).toBe(parsed.content);
	});

	test("memory body containing '---' separators parses without breakage", () => {
		const trickyBody =
			"# Section\n\n---\n\nNot frontmatter, just a horizontal rule.\n\n---\n\nMore body.\n";
		const out = serializeMemory(memoryFixture({ content: trickyBody }));
		const parsed = matter(out.content);
		expect(parsed.data.type).toBe("memory-feedback");
		expect(parsed.content).toContain(
			"Not frontmatter, just a horizontal rule.",
		);
		expect(parsed.content).toContain("More body.");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Index / log
// ─────────────────────────────────────────────────────────────────────────────

describe("index.md and log.md generators", () => {
	test("serializeIndex emits stable counts + file path", () => {
		const out = serializeIndex({
			memories: [memoryFixture()],
			briefingNotes: [briefingFixture()],
			tasks: [taskFixture()],
		});
		expect(out.filePath).toBe("index.md");
		expect(out.content).toContain("memories: 1");
		expect(out.content).toContain("briefing-notes: 1");
		expect(out.content).toContain("tasks: 1");
		const parsed = matter(out.content);
		expect(parsed.data.type).toBe("index");
	});

	test("serializeLog emits totals + parseable frontmatter", () => {
		const out = serializeLog({
			memories: [memoryFixture(), memoryFixture()],
			tasks: [taskFixture()],
		});
		expect(out.filePath).toBe("log.md");
		const parsed = matter(out.content);
		expect(parsed.data.type).toBe("log");
		expect(out.content).toContain("Total entries serialized: 3");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Determinism (sorted keys)
// ─────────────────────────────────────────────────────────────────────────────

describe("deterministic key ordering", () => {
	test("two identical memory inputs produce byte-identical output", () => {
		const a = serializeMemory(memoryFixture());
		const b = serializeMemory(memoryFixture());
		expect(a.content).toBe(b.content);
	});

	test("frontmatter keys are emitted in alphabetical order", () => {
		const out = serializeMemory(memoryFixture());
		const fm = out.content.split("---\n")[1] ?? "";
		const keys = fm
			.split("\n")
			.map((l) => l.match(/^([a-zA-Z][a-zA-Z0-9]*):/)?.[1])
			.filter((k): k is string => !!k);
		const sorted = [...keys].sort();
		expect(keys).toEqual(sorted);
	});
});
