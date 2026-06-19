/**
 * okfValidator.test.ts — unit tests for OKF v0.1 bundle validator (T2).
 *
 * Coverage matrix (RFC §3.5, ADR D3):
 *  - Conformance (4): valid memory / briefing-note / task / root index.md
 *  - Non-conformance (4): missing type / invalid YAML / broken cross-link /
 *    forbidden frontmatter on nested index.md
 *  - Custom field extension (2): unknown field preserved + not rejected
 *  - Roundtrip with T1 serializer (3): memory + briefing-note + task
 *  - Extras (3): vp:// URI not validated, log.md reserved checks, full bundle
 *
 * Total: 16 tests. Pure structural fixtures — no convex-test runtime.
 */

import { describe, expect, test } from "vitest";
import type { BriefingNoteDoc, MemoryDoc, TaskDoc } from "../okfSerializer";
import {
	serializeBriefingNote,
	serializeIndex,
	serializeMemory,
	serializeTask,
} from "../okfSerializer";
import {
	type BundleEntries,
	type BundleEntry,
	validateBundle,
	validateEntry,
} from "../okfValidator";

const FIXED_MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function memoryFixture(overrides: Partial<MemoryDoc> = {}): MemoryDoc {
	return {
		_id: "mem_abc123",
		_creationTime: FIXED_MS,
		namespace: "project/elpi-corp",
		type: "feedback",
		content: "Body line one.\n\nBody line two.",
		createdBy: "sigma",
		tags: ["doctrine"],
		title: "Sample memory",
		description: "A sample memory.",
		updatedAt: FIXED_MS,
		...overrides,
	};
}

function briefingFixture(
	overrides: Partial<BriefingNoteDoc> = {},
): BriefingNoteDoc {
	return {
		_id: "brief_xyz",
		_creationTime: FIXED_MS,
		title: "Daily standup",
		topic: "engineering",
		participants: ["sigma", "eta"],
		content: "Decisions logged.",
		createdBy: "sigma",
		updatedAt: FIXED_MS,
		...overrides,
	};
}

function taskFixture(overrides: Partial<TaskDoc> = {}): TaskDoc {
	return {
		_id: "task_foo",
		_creationTime: FIXED_MS,
		title: "Wire validator",
		description: "Implement OKF validator T2.",
		assignedTo: "sigma",
		priority: "high",
		status: "in_progress",
		createdBy: "sigma",
		updatedAt: FIXED_MS,
		...overrides,
	};
}

function entry(path: string, content: string): BundleEntry {
	return { path, content };
}

function makeMd(frontmatter: string, body = "body"): string {
	return `---\n${frontmatter}\n---\n${body}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1-4: Conformance
// ─────────────────────────────────────────────────────────────────────────────

describe("conformance", () => {
	test("valid memory entry passes", () => {
		const content = makeMd(
			'type: memory-feedback\ntitle: "Sample"\nresource: "vp://memory/abc"',
			"Body.",
		);
		const e = entry("memories/abc.md", content);
		const errors = validateEntry(e, new Set(["memories/abc.md"]));
		expect(errors).toEqual([]);
	});

	test("valid briefing-note entry passes", () => {
		const content = makeMd(
			'type: briefing-note\ntitle: "Standup"\nparticipants: ["sigma","eta"]',
			"Notes.",
		);
		const e = entry("briefing-notes/xyz.md", content);
		const errors = validateEntry(e, new Set(["briefing-notes/xyz.md"]));
		expect(errors).toEqual([]);
	});

	test("valid task entry passes", () => {
		const content = makeMd(
			'type: task\ntitle: "Do thing"\nstatus: in_progress\npriority: high',
			"Task body.",
		);
		const e = entry("tasks/foo.md", content);
		const errors = validateEntry(e, new Set(["tasks/foo.md"]));
		expect(errors).toEqual([]);
	});

	test("root index.md with okf_version passes", () => {
		const content = makeMd(
			'type: index\nokf_version: "0.1"\ntitle: "Bundle index"',
			"# Bundle index\n",
		);
		const e = entry("index.md", content);
		const errors = validateEntry(e, new Set(["index.md"]));
		expect(errors).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 5-8: Non-conformance
// ─────────────────────────────────────────────────────────────────────────────

describe("non-conformance", () => {
	test("missing `type` field flagged as MISSING_TYPE", () => {
		const content = makeMd('title: "No type"', "Body.");
		const errors = validateEntry(
			entry("memories/m1.md", content),
			new Set(["memories/m1.md"]),
		);
		expect(errors.some((e) => e.rule === "MISSING_TYPE")).toBe(true);
	});

	test("invalid YAML flagged as INVALID_YAML", () => {
		// Unclosed bracket: yaml will throw.
		const content = "---\ntype: memory-feedback\ntags: [unclosed\n---\nbody\n";
		const errors = validateEntry(
			entry("memories/bad.md", content),
			new Set(["memories/bad.md"]),
		);
		expect(errors.some((e) => e.rule === "INVALID_YAML")).toBe(true);
	});

	test("broken cross-link flagged as BROKEN_CROSSLINK", () => {
		const content = makeMd(
			"type: memory-reference",
			"See [other](/memories/missing.md) for details.",
		);
		const errors = validateEntry(
			entry("memories/src.md", content),
			new Set(["memories/src.md"]),
		);
		expect(errors.some((e) => e.rule === "BROKEN_CROSSLINK")).toBe(true);
	});

	test("nested memories/index.md with frontmatter is FORBIDDEN_FRONTMATTER", () => {
		const content = makeMd("type: index", "# Memories");
		const errors = validateEntry(
			entry("memories/index.md", content),
			new Set(["memories/index.md"]),
		);
		expect(errors.some((e) => e.rule === "FORBIDDEN_FRONTMATTER")).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 9-10: Custom field extension (spec §1.2)
// ─────────────────────────────────────────────────────────────────────────────

describe("custom field extension", () => {
	test("unknown frontmatter field is accepted (not rejected)", () => {
		const content = makeMd(
			'type: memory-project\ntitle: "X"\nelpi_extension_field: "custom-value"\ncustomArray: [1, 2, 3]',
			"Body.",
		);
		const errors = validateEntry(
			entry("memories/ext.md", content),
			new Set(["memories/ext.md"]),
		);
		expect(errors).toEqual([]);
	});

	test("entry with multiple extension fields validates PASS", () => {
		const content = makeMd(
			[
				"type: task",
				'title: "Ext task"',
				"status: done",
				"priority: low",
				"x_custom_a: alpha",
				"x_custom_b: 42",
				"nested:",
				"  inner: yes",
			].join("\n"),
			"Body.",
		);
		const result = validateBundle({
			entries: [entry("tasks/ext.md", content)],
		});
		expect(result.pass).toBe(true);
		expect(result.validatedCount).toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 11-13: Roundtrip integration with T1 serializer
// ─────────────────────────────────────────────────────────────────────────────

describe("roundtrip with T1 serializer", () => {
	test("serializeMemory → validateBundle returns pass=true", () => {
		const file = serializeMemory(memoryFixture());
		const bundle: BundleEntries = {
			entries: [{ path: file.filePath, content: file.content }],
		};
		const result = validateBundle(bundle);
		expect(result.pass).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test("serializeBriefingNote → validateBundle returns pass=true", () => {
		const file = serializeBriefingNote(briefingFixture());
		const bundle: BundleEntries = {
			entries: [{ path: file.filePath, content: file.content }],
		};
		const result = validateBundle(bundle);
		expect(result.pass).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test("serializeTask → validateBundle returns pass=true", () => {
		const file = serializeTask(
			taskFixture({ status: "done", completionNote: "shipped" }),
		);
		const bundle: BundleEntries = {
			entries: [{ path: file.filePath, content: file.content }],
		};
		const result = validateBundle(bundle);
		expect(result.pass).toBe(true);
		expect(result.errors).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 14-16: Extras
// ─────────────────────────────────────────────────────────────────────────────

describe("extras", () => {
	test("vp:// URI in body is preserved verbatim (not flagged as broken link)", () => {
		const content = makeMd(
			"type: memory-reference",
			"See [target](vp://memory/abc123) and [docs](https://example.com) for refs.",
		);
		const errors = validateEntry(
			entry("memories/refs.md", content),
			new Set(["memories/refs.md"]),
		);
		expect(errors).toEqual([]);
	});

	test("log.md with frontmatter is RESERVED_VIOLATION", () => {
		const content = makeMd("type: log", "2026-06-19 entry one");
		const errors = validateEntry(entry("log.md", content), new Set(["log.md"]));
		expect(errors.some((e) => e.rule === "RESERVED_VIOLATION")).toBe(true);
	});

	test("full bundle with root index + memory + briefing + task validates", () => {
		const mem = serializeMemory(memoryFixture({ _id: "m1" }));
		const brief = serializeBriefingNote(briefingFixture({ _id: "b1" }));
		const task = serializeTask(taskFixture({ _id: "t1" }));
		const idx = serializeIndex({
			memories: [memoryFixture({ _id: "m1" })],
			briefingNotes: [briefingFixture({ _id: "b1" })],
			tasks: [taskFixture({ _id: "t1" })],
		});
		const bundle: BundleEntries = {
			entries: [
				{ path: idx.filePath, content: idx.content },
				{ path: mem.filePath, content: mem.content },
				{ path: brief.filePath, content: brief.content },
				{ path: task.filePath, content: task.content },
			],
		};
		const result = validateBundle(bundle);
		expect(result.pass).toBe(true);
		expect(result.validatedCount).toBe(4);
		expect(result.skippedCount).toBe(0);
	});
});
