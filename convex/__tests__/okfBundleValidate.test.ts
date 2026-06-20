/// <reference types="vite/client" />
//
// OKF Phase 2 — B1 / T-OKF-PHASE2-A: validate_okf_bundle action.
//
// Mission: k5779qbxhwrfjmj02t31yvehns8911jp (VP Cloud Dashboard, Day 108).
// Task:    k1796g7g7y03gn9rd6z7psenk98910vt.
//
// Scope:
//   - Action `validateOkfBundle` accepts {bundleUrl|storageId} and returns
//     { valid, schemaVersion, errors?, stats } per RFC §3.5.
//   - read-only: no DB writes, no mutation.
//   - Reuses the pure `validateBundle()` from convex/okfValidator.ts (already
//     unit-tested in okfValidator.test.ts; this suite covers the action layer:
//     tarball fetch + tar-stream extract + result shape).
//
// TDD RULE #12 — tests AVANT impl. This file lands first, then the action is
// implemented in convex/okfBundleNode.ts until tests pass.
//
// Orchestrator: Sigma — VantagePeers | 2026-06-20

import { Readable } from "node:stream";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
	assembleBundle,
	BUNDLE_HARD_CAP_BYTES,
	BUNDLE_SOFT_CAP_BYTES,
} from "../okfBundle";
import { packTarball } from "../okfBundleNode";
import {
	type BriefingNoteDoc,
	type MemoryDoc,
	serializeBriefingNote,
	serializeMemory,
	serializeTask,
	type TaskDoc,
} from "../okfSerializer";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createTestConvex = () => convexTest(schema, modules);

const FIXED_MS = 1_700_000_000_000;

function memoryFixture(overrides: Partial<MemoryDoc> = {}): MemoryDoc {
	return {
		_id: "mem_validate_001",
		_creationTime: FIXED_MS,
		namespace: "project/elpi-corp",
		type: "feedback",
		content: "Valid memory body.",
		createdBy: "sigma",
		tags: ["okf-validate"],
		description: "Validate test fixture.",
		title: "Validate fixture",
		updatedAt: FIXED_MS,
		...overrides,
	};
}

function briefingFixture(
	overrides: Partial<BriefingNoteDoc> = {},
): BriefingNoteDoc {
	return {
		_id: "brf_validate_001",
		_creationTime: FIXED_MS,
		title: "OKF P2 B1 kickoff",
		topic: "okf-bridge-phase-2",
		participants: ["sigma", "kappa"],
		content: "## Agenda\n\nB1 validate first.",
		decisions: ["GO B1"],
		createdBy: "sigma",
		createdAt: FIXED_MS,
		updatedAt: FIXED_MS,
		...overrides,
	};
}

function taskFixture(overrides: Partial<TaskDoc> = {}): TaskDoc {
	return {
		_id: "tsk_validate_001",
		_creationTime: FIXED_MS,
		title: "Validate OKF action",
		description: "B1 — read-only validator action.",
		assignedTo: "sigma",
		priority: "high",
		status: "in_progress",
		tags: ["okf", "phase-2"],
		createdBy: "sigma",
		updatedAt: FIXED_MS,
		...overrides,
	};
}

async function packFixtureBundle(): Promise<Buffer> {
	const memories = [memoryFixture()];
	const briefings = [briefingFixture()];
	const tasks = [taskFixture()];
	const { entries } = assembleBundle(
		memories.map(serializeMemory),
		briefings.map(serializeBriefingNote),
		tasks.map(serializeTask),
		memories,
		briefings,
		tasks,
		{ softCap: BUNDLE_SOFT_CAP_BYTES, hardCap: BUNDLE_HARD_CAP_BYTES },
	);
	return packTarball(entries);
}

async function storeBundle(
	t: ReturnType<typeof createTestConvex>,
	buf: Buffer,
): Promise<string> {
	// convex-test exposes ctx.storage.store via the test harness `t.run`.
	return await t.run(async (ctx) => {
		const blob = new Blob([buf]);
		return await ctx.storage.store(blob);
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Happy path — valid bundle returns { valid: true, stats correct }
// ─────────────────────────────────────────────────────────────────────────────

describe("validate_okf_bundle action — happy path", () => {
	test("valid bundle from storageId → valid:true, stats match", async () => {
		const t = createTestConvex();
		const buf = await packFixtureBundle();
		const storageId = await storeBundle(t, buf);

		const result = await t.action(api.okfBundleNode.validateOkfBundle, {
			storageId,
		});

		expect(result.valid).toBe(true);
		expect(result.schemaVersion).toBe("0.1");
		expect(result.stats.memoryCount).toBe(1);
		expect(result.stats.briefingCount).toBe(1);
		expect(result.stats.taskCount).toBe(1);
		expect(result.errors).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Schema violation — missing frontmatter type field
// ─────────────────────────────────────────────────────────────────────────────

describe("validate_okf_bundle action — schema violations", () => {
	test("entry with missing `type` frontmatter field → valid:false + MISSING_TYPE", async () => {
		const t = createTestConvex();
		// Build a bundle whose memory entry has frontmatter but no `type` field
		// (simulates a corrupted/hand-edited bundle).
		const tamperedEntries = [
			{
				path: "index.md",
				content: "---\nokf_version: \"0.1\"\ntype: index\n---\n# Bundle\n",
			},
			{
				path: "memories/mem_bad.md",
				// Frontmatter present, type field intentionally omitted.
				content: "---\ndescription: tampered\n---\nBody.\n",
			},
		];
		const buf = await packTarball(tamperedEntries);
		const storageId = await storeBundle(t, buf);

		const result = await t.action(api.okfBundleNode.validateOkfBundle, {
			storageId,
		});

		expect(result.valid).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors?.some((e) => e.rule === "MISSING_TYPE")).toBe(true);
	});

	test("entry with malformed YAML frontmatter → valid:false + INVALID_YAML", async () => {
		const t = createTestConvex();
		const tamperedEntries = [
			{
				path: "index.md",
				content: "---\nokf_version: \"0.1\"\ntype: index\n---\n# Bundle\n",
			},
			{
				path: "memories/mem_bad_yaml.md",
				// Missing closing fence → malformed frontmatter.
				content: "---\ntype: memory-feedback\nDescription without closing fence\nBody.\n",
			},
		];
		const buf = await packTarball(tamperedEntries);
		const storageId = await storeBundle(t, buf);

		const result = await t.action(api.okfBundleNode.validateOkfBundle, {
			storageId,
		});

		expect(result.valid).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors?.some((e) => e.rule === "INVALID_YAML")).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Read-only — action does NOT mutate the database
// ─────────────────────────────────────────────────────────────────────────────

describe("validate_okf_bundle action — read-only invariant", () => {
	test("validating a bundle does not insert any rows (read-only contract)", async () => {
		const t = createTestConvex();
		const buf = await packFixtureBundle();
		const storageId = await storeBundle(t, buf);

		const memoriesBefore = await t.run(async (ctx) =>
			ctx.db.query("memories").collect(),
		);
		const briefingsBefore = await t.run(async (ctx) =>
			ctx.db.query("briefingNotes").collect(),
		);
		const tasksBefore = await t.run(async (ctx) =>
			ctx.db.query("tasks").collect(),
		);

		await t.action(api.okfBundleNode.validateOkfBundle, { storageId });

		const memoriesAfter = await t.run(async (ctx) =>
			ctx.db.query("memories").collect(),
		);
		const briefingsAfter = await t.run(async (ctx) =>
			ctx.db.query("briefingNotes").collect(),
		);
		const tasksAfter = await t.run(async (ctx) =>
			ctx.db.query("tasks").collect(),
		);

		expect(memoriesAfter.length).toBe(memoriesBefore.length);
		expect(briefingsAfter.length).toBe(briefingsBefore.length);
		expect(tasksAfter.length).toBe(tasksBefore.length);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Counting stats — purely based on extracted entries (skips index.md/log.md)
// ─────────────────────────────────────────────────────────────────────────────

describe("validate_okf_bundle action — counting stats", () => {
	test("stats count only family entries, not index.md/log.md", async () => {
		const t = createTestConvex();
		const memories = [memoryFixture(), memoryFixture({ _id: "mem_validate_002" })];
		const briefings = [briefingFixture()];
		const tasks: TaskDoc[] = [];
		const { entries } = assembleBundle(
			memories.map(serializeMemory),
			briefings.map(serializeBriefingNote),
			tasks.map(serializeTask),
			memories,
			briefings,
			tasks,
			{ softCap: BUNDLE_SOFT_CAP_BYTES, hardCap: BUNDLE_HARD_CAP_BYTES },
		);
		const buf = await packTarball(entries);
		const storageId = await storeBundle(t, buf);

		const result = await t.action(api.okfBundleNode.validateOkfBundle, {
			storageId,
		});

		expect(result.valid).toBe(true);
		expect(result.stats.memoryCount).toBe(2);
		expect(result.stats.briefingCount).toBe(1);
		expect(result.stats.taskCount).toBe(0);
	});
});
