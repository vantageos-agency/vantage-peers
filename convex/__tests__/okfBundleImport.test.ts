/// <reference types="vite/client" />
//
// OKF Phase 2 — B2 / T-OKF-PHASE2-B: import_okf_bundle action.
//
// Mission: k5779qbxhwrfjmj02t31yvehns8911jp (VP Cloud Dashboard, Day 108).
// Task:    k17fja9v7pgnf25yvzkwrj5ch5891bb3.
//
// Scope:
//   - Action `importOkfBundle` accepts {bundleUrl|storageId, targetNamespace,
//     mode:"merge"|"replace"|"dry-run", idempotencyKey} and returns
//     { imported:{memories,briefings,tasks}, skipped, conflicts[] } per RFC.
//   - mutation: writes to memories/briefingNotes/tasks (mode!=dry-run).
//   - Reuses validateBundle() from convex/okfValidator.ts before any write.
//   - dedup by content hash, supermemory isLatest chain preserved.
//
// TDD RULE #12 — tests AVANT impl. This file lands first; the action is
// implemented in convex/okfBundleNode.ts until tests pass.
//
// Status: WIP scaffold (Day 108, post-B1 merge 7f445a4). Action not yet
// implemented — tests intentionally RED until next iteration. PR is draft.
//
// Orchestrator: Sigma — VantagePeers | 2026-06-20

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
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

// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround (cf. B1)
const IMPORT_ACTION_REF = "okfBundleNode:importOkfBundle" as any;

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
		_id: "k179mem001" as never,
		_creationTime: FIXED_MS,
		type: "reference",
		namespace: "project/elpi-corp",
		content: "Imported memory body.",
		createdBy: "sigma",
		createdAt: FIXED_MS,
		updatedAt: FIXED_MS,
		...overrides,
	};
}

function briefingFixture(
	overrides: Partial<BriefingNoteDoc> = {},
): BriefingNoteDoc {
	return {
		_id: "k179bri001" as never,
		_creationTime: FIXED_MS,
		topic: "daily",
		title: "Imported briefing",
		content: "Body.",
		participants: ["sigma"],
		createdBy: "sigma",
		createdAt: FIXED_MS,
		updatedAt: FIXED_MS,
		...overrides,
	};
}

function taskFixture(overrides: Partial<TaskDoc> = {}): TaskDoc {
	return {
		_id: "k179tsk001" as never,
		_creationTime: FIXED_MS,
		title: "Imported task",
		description: "Body.",
		status: "todo",
		priority: "medium",
		assignedTo: "sigma",
		createdBy: "sigma",
		createdAt: FIXED_MS,
		updatedAt: FIXED_MS,
		...overrides,
	};
}

async function packFixtureBundle(): Promise<Buffer> {
	const mem = serializeMemory(memoryFixture());
	const bri = serializeBriefingNote(briefingFixture());
	const tsk = serializeTask(taskFixture());
	return await packTarball([
		{
			path: "index.md",
			content: '---\nokf_version: "0.1"\ntype: index\n---\n# Bundle\n',
		},
		{ path: mem.filePath, content: mem.content },
		{ path: bri.filePath, content: bri.content },
		{ path: tsk.filePath, content: tsk.content },
	]);
}

async function storeBundle(
	t: ReturnType<typeof createTestConvex>,
	buf: Buffer,
): Promise<string> {
	return await t.run(async (ctx) => {
		const blob = new Blob([new Uint8Array(buf)]);
		return await ctx.storage.store(blob);
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. dry-run — no writes, counts correct
// ─────────────────────────────────────────────────────────────────────────────

describe("import_okf_bundle action — dry-run", () => {
	test("dry-run returns counts but inserts 0 rows", async () => {
		const t = createTestConvex();
		const buf = await packFixtureBundle();
		const storageId = await storeBundle(t, buf);

		const result = await t.action(IMPORT_ACTION_REF, {
			storageId,
			targetNamespace: "project/elpi-corp",
			mode: "dry-run",
			idempotencyKey: "test-dry-run-1",
		});

		expect(result.imported.memories).toBe(1);
		expect(result.imported.briefings).toBe(1);
		expect(result.imported.tasks).toBe(1);

		const memCount = await t.run(
			async (ctx) => (await ctx.db.query("memories").collect()).length,
		);
		expect(memCount).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. merge — entries inserted, dedup by content hash, isLatest correct
// ─────────────────────────────────────────────────────────────────────────────

describe("import_okf_bundle action — merge mode", () => {
	test("merge inserts new entries + dedup by content hash on re-import", async () => {
		const t = createTestConvex();
		const buf = await packFixtureBundle();
		const storageId = await storeBundle(t, buf);

		const first = await t.action(IMPORT_ACTION_REF, {
			storageId,
			targetNamespace: "project/elpi-corp",
			mode: "merge",
			idempotencyKey: "test-merge-first",
		});
		expect(first.imported.memories).toBe(1);

		const second = await t.action(IMPORT_ACTION_REF, {
			storageId,
			targetNamespace: "project/elpi-corp",
			mode: "merge",
			idempotencyKey: "test-merge-second",
		});
		expect(second.skipped).toBe(3);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. idempotency — replayed key returns prior result, no double-write
// ─────────────────────────────────────────────────────────────────────────────

describe("import_okf_bundle action — idempotency", () => {
	test("same idempotencyKey replayed → no duplicate inserts", async () => {
		const t = createTestConvex();
		const buf = await packFixtureBundle();
		const storageId = await storeBundle(t, buf);

		const args = {
			storageId,
			targetNamespace: "project/elpi-corp",
			mode: "merge" as const,
			idempotencyKey: "test-idem-replay",
		};
		await t.action(IMPORT_ACTION_REF, args);
		await t.action(IMPORT_ACTION_REF, args);

		const memCount = await t.run(
			async (ctx) => (await ctx.db.query("memories").collect()).length,
		);
		expect(memCount).toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. cross-tenant deny — write scope enforced via assertCanImport
// ─────────────────────────────────────────────────────────────────────────────

describe("import_okf_bundle action — cross-tenant deny", () => {
	test("identity org X importing namespace team/Y → AUTH_NAMESPACE_DENIED", async () => {
		const t = createTestConvex();
		const buf = await packFixtureBundle();
		const storageId = await storeBundle(t, buf);

		const asOrgX = t.withIdentity({
			subject: "user_test",
			tokenIdentifier: "test|user_x",
			organizationId: "team-x",
		});

		await expect(
			asOrgX.action(IMPORT_ACTION_REF, {
				storageId,
				targetNamespace: "team/team-y",
				mode: "merge",
				idempotencyKey: "test-cross-tenant",
			}),
		).rejects.toThrow(/AUTH_NAMESPACE_DENIED/);
	});
});
