/**
 * okfBundle.test.ts — unit tests for OKF v0.1 bundle exporter (T3).
 *
 * Pure tests on the helpers + tarball roundtrip integration. The Convex
 * `action` handler itself is exercised via dedicated helpers (auth gating,
 * size caps, manifest math) — no convex-test runtime needed because the
 * action calls runQuery which is mocked at the helper boundary.
 *
 * Coverage (RFC §4 — target ≥10, this file delivers 18):
 *   - Round-trip serialize → tarball → extract → parse (3 tests, one per type)
 *   - Tarball structure conforms RFC §3.3 (2 tests)
 *   - Size cap behaviour (3 tests: soft truncate, hard refuse, single-entry refuse)
 *   - type filter routing (3 tests: family include/exclude, memory-* wildcard,
 *     memory-<sub> literal)
 *   - since arg parsing (2 tests: valid + invalid)
 *   - auth helper (1 test: phase 1 namespace lock)
 *   - Eta REVISE iter 2 — pagination cursor chain (1 test)
 *   - Eta REVISE iter 2 — cross-namespace isolation (3 tests)
 *
 * RFC parent: decisions/okf-bridge-phase-1-rfc-2026-06-18.md (commit 6613610).
 * ADR:        decisions/adr-okf-exporter-arch.md (commit 2cd357e).
 *
 * Orchestrator: Sigma — VantagePeers | 2026-06-19
 */

import { Readable } from "node:stream";
import matter from "gray-matter";
import { extract } from "tar-stream";
import { describe, expect, test } from "vitest";
import {
	applyMemorySubtypeFilter,
	assembleBundle,
	BUNDLE_HARD_CAP_BYTES,
	BUNDLE_PAGE_SIZE,
	BUNDLE_SOFT_CAP_BYTES,
	expectedOrgIdForNamespace,
	matchesNamespaceScope,
	PHASE1_NAMESPACE,
	parseSinceArg,
	shouldIncludeFamily,
} from "../okfBundle";
// packTarball moved to convex/okfBundleNode.ts under "use node" (Eta REVISE
// fix-pattern m9781h39 — Buffer + tar-stream are Node-only).
import { packTarball } from "../okfBundleNode";
import {
	type BriefingNoteDoc,
	type MemoryDoc,
	type SerializedFile,
	serializeBriefingNote,
	serializeMemory,
	serializeTask,
	type TaskDoc,
} from "../okfSerializer";
import { validateBundle } from "../okfValidator";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures (mirror okfSerializer.test.ts shapes)
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_MS = 1_700_000_000_000;

function memoryFixture(overrides: Partial<MemoryDoc> = {}): MemoryDoc {
	return {
		_id: "mem_abc123",
		_creationTime: FIXED_MS,
		namespace: "project/elpi-corp",
		type: "feedback",
		content: "User feedback on doctrine sweep.\n\nFollow-up logged.",
		createdBy: "sigma",
		tags: ["doctrine"],
		description: "Sweep follow-up.",
		title: "Sweeper feedback",
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
		content: "## Agenda\n\n- T0 ADR\n",
		decisions: ["GO T1"],
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
		title: "Implement OKF action",
		description: "T3 — Convex action + MCP tool wrapper.",
		assignedTo: "dev-architect",
		priority: "high",
		status: "in_progress",
		tags: ["okf", "phase-1"],
		missionId: "mission_k570",
		createdBy: "sigma",
		updatedAt: FIXED_MS,
		...overrides,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Tarball read helper
// ─────────────────────────────────────────────────────────────────────────────

interface ExtractedEntry {
	name: string;
	content: string;
}

async function extractTarball(buf: Buffer): Promise<ExtractedEntry[]> {
	const out: ExtractedEntry[] = [];
	const ext = extract();
	const done = new Promise<void>((resolve, reject) => {
		ext.on("entry", (header, stream, next) => {
			const chunks: Buffer[] = [];
			stream.on("data", (c: Buffer) => chunks.push(c));
			stream.on("end", () => {
				out.push({
					name: header.name,
					content: Buffer.concat(chunks).toString("utf8"),
				});
				next();
			});
			stream.on("error", reject);
			stream.resume();
		});
		ext.on("finish", () => resolve());
		ext.on("error", reject);
	});
	Readable.from(buf).pipe(ext);
	await done;
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Round-trip serialize → tarball → extract → parse (3 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe("roundtrip — pack + extract + frontmatter parse", () => {
	test("memory roundtrip preserves frontmatter + body byte-exact", async () => {
		const memories = [memoryFixture()];
		const { entries } = assembleBundle(
			memories.map(serializeMemory),
			[],
			[],
			memories,
			[],
			[],
			{ softCap: BUNDLE_SOFT_CAP_BYTES, hardCap: BUNDLE_HARD_CAP_BYTES },
		);
		const tar = await packTarball(entries);
		const extracted = await extractTarball(tar);
		const memEntry = extracted.find((e) => e.name === "memories/mem_abc123.md");
		expect(memEntry).toBeDefined();
		if (memEntry === undefined) throw new Error("memEntry missing");
		const parsed = matter(memEntry.content);
		expect(parsed.data.type).toBe("memory-feedback");
		expect(parsed.data.resource).toBe("vp://memory/mem_abc123");
		expect(parsed.content.trim()).toContain("User feedback on doctrine sweep.");
	});

	test("briefing-note roundtrip preserves topic + participants", async () => {
		const briefings = [briefingFixture()];
		const { entries } = assembleBundle(
			[],
			briefings.map(serializeBriefingNote),
			[],
			[],
			briefings,
			[],
			{ softCap: BUNDLE_SOFT_CAP_BYTES, hardCap: BUNDLE_HARD_CAP_BYTES },
		);
		const tar = await packTarball(entries);
		const extracted = await extractTarball(tar);
		const briefEntry = extracted.find(
			(x) => x.name === "briefing-notes/brf_xyz789.md",
		);
		expect(briefEntry).toBeDefined();
		if (briefEntry === undefined) throw new Error("briefEntry missing");
		const parsed = matter(briefEntry.content);
		expect(parsed.data.type).toBe("briefing-note");
		expect(parsed.data.topic).toBe("okf-bridge-phase-1");
		expect(parsed.data.participants).toEqual(["sigma", "pi", "laurent"]);
	});

	test("task roundtrip preserves status + missionId tags", async () => {
		const tasks = [taskFixture()];
		const { entries } = assembleBundle(
			[],
			[],
			tasks.map(serializeTask),
			[],
			[],
			tasks,
			{ softCap: BUNDLE_SOFT_CAP_BYTES, hardCap: BUNDLE_HARD_CAP_BYTES },
		);
		const tar = await packTarball(entries);
		const extracted = await extractTarball(tar);
		const taskEntry = extracted.find((x) => x.name === "tasks/tsk_pqr456.md");
		expect(taskEntry).toBeDefined();
		if (taskEntry === undefined) throw new Error("taskEntry missing");
		const parsed = matter(taskEntry.content);
		expect(parsed.data.type).toBe("task");
		expect(parsed.data.status).toBe("in_progress");
		expect(parsed.data.tags).toContain("status:in_progress");
		expect(parsed.data.tags).toContain("mission:mission_k570");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Tarball structure conforms RFC §3.3 (2 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe("tarball structure (RFC §3.3)", () => {
	test("bundle always contains index.md and log.md at root", async () => {
		const memories = [memoryFixture()];
		const { entries } = assembleBundle(
			memories.map(serializeMemory),
			[],
			[],
			memories,
			[],
			[],
			{ softCap: BUNDLE_SOFT_CAP_BYTES, hardCap: BUNDLE_HARD_CAP_BYTES },
		);
		const names = entries.map((e) => e.path);
		expect(names).toContain("index.md");
		expect(names).toContain("log.md");
		// Validator MUST pass on a real bundle.
		const validation = validateBundle({ entries });
		if (!validation.pass) {
			console.error("validation errors", validation.errors);
		}
		expect(validation.pass).toBe(true);
	});

	test("entries split by family into memories/, briefing-notes/, tasks/", async () => {
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
		const tar = await packTarball(entries);
		const extracted = await extractTarball(tar);
		const names = extracted.map((e) => e.name).sort();
		expect(names).toEqual(
			[
				"briefing-notes/brf_xyz789.md",
				"index.md",
				"log.md",
				"memories/mem_abc123.md",
				"tasks/tsk_pqr456.md",
			].sort(),
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Size cap behaviour (3 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe("size caps (ADR D4)", () => {
	test("soft cap (50 MB) triggers truncated=true and stops appending", () => {
		// Fabricate many small memory files until soft cap exceeded.
		const big = "x".repeat(10 * 1024); // 10 KB body
		const memories: MemoryDoc[] = [];
		const files: SerializedFile[] = [];
		for (let i = 0; i < 200; i++) {
			const m = memoryFixture({ _id: `mem_${i}`, content: big });
			memories.push(m);
			files.push(serializeMemory(m));
		}
		// Use a tiny soft cap so we don't actually allocate 50 MB in CI.
		const softCap = 50_000; // 50 KB
		const hardCap = 1_000_000;
		const { entries, truncated, bytes } = assembleBundle(
			files,
			[],
			[],
			memories,
			[],
			[],
			{ softCap, hardCap },
		);
		expect(truncated).toBe(true);
		expect(bytes).toBeLessThanOrEqual(softCap + 20_000); // index+log allowance
		expect(entries.length).toBeLessThan(files.length + 2);
	});

	test("hard cap (>100 MB) throws OKF_BUNDLE_REFUSED at cumulative overflow", () => {
		const big = "x".repeat(50_000);
		const memoriesHard: MemoryDoc[] = [];
		const filesHard: SerializedFile[] = [];
		for (let i = 0; i < 50; i++) {
			const m = memoryFixture({ _id: `mem_${i}`, content: big });
			memoriesHard.push(m);
			filesHard.push(serializeMemory(m));
		}
		expect(() =>
			assembleBundle(filesHard, [], [], memoriesHard, [], [], {
				softCap: 10_000_000,
				hardCap: 100_000,
			}),
		).toThrow(/OKF_BUNDLE_REFUSED/);
	});

	test("hard cap rejects a single entry larger than the cap", () => {
		const huge = "y".repeat(200_000);
		const m = memoryFixture({ _id: "mem_huge", content: huge });
		expect(() =>
			assembleBundle([serializeMemory(m)], [], [], [m], [], [], {
				softCap: 50_000,
				hardCap: 100_000,
			}),
		).toThrow(/OKF_BUNDLE_REFUSED/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Type filter routing (3 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe("type filter routing", () => {
	test("null/empty filter includes all three families", () => {
		expect(shouldIncludeFamily("memory", null)).toBe(true);
		expect(shouldIncludeFamily("briefing", null)).toBe(true);
		expect(shouldIncludeFamily("task", null)).toBe(true);
		expect(shouldIncludeFamily("memory", [])).toBe(true);
	});

	test("memory-* wildcard keeps all memory subtypes", () => {
		const memories = [
			memoryFixture({ _id: "m1", type: "feedback" }),
			memoryFixture({ _id: "m2", type: "project" }),
		];
		const files = memories.map(serializeMemory);
		const kept = applyMemorySubtypeFilter(files, memories, ["memory-*"]);
		expect(kept).toHaveLength(2);
		// Task family not selected → shouldIncludeFamily returns false
		expect(shouldIncludeFamily("task", ["memory-*"])).toBe(false);
	});

	test("memory-<sub> literal keeps only matching subtypes", () => {
		const memories = [
			memoryFixture({ _id: "m1", type: "feedback" }),
			memoryFixture({ _id: "m2", type: "project" }),
			memoryFixture({ _id: "m3", type: "reference" }),
		];
		const files = memories.map(serializeMemory);
		const kept = applyMemorySubtypeFilter(files, memories, [
			"memory-feedback",
			"memory-reference",
		]);
		expect(kept.map((f) => f.filePath)).toEqual([
			"memories/m1.md",
			"memories/m3.md",
		]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. since arg parsing (2 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe("parseSinceArg", () => {
	test("valid ISO 8601 → epoch ms", () => {
		expect(parseSinceArg("2026-06-18T00:00:00Z")).toBe(
			Date.parse("2026-06-18T00:00:00Z"),
		);
	});

	test("invalid string throws OKF_INVALID_SINCE", () => {
		expect(() => parseSinceArg("not-a-date")).toThrow(/OKF_INVALID_SINCE/);
		expect(parseSinceArg(undefined)).toBeUndefined();
		expect(parseSinceArg(null)).toBeUndefined();
		expect(parseSinceArg("")).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Auth helper smoke — Phase 1 constants still consistent after B3 generalize.
//
// B3 (mission k5779qbxh, task k17f3407) dropped the `project/elpi-corp` hard
// lock from `assertCanExportNamespace`. Behavioural coverage of the relaxed
// gate lives in `okfBundleExportGeneralize.test.ts`; this suite only pins the
// cap constants since they remain T3 contract.
// ─────────────────────────────────────────────────────────────────────────────

describe("export constants — Phase 1 sizing pins", () => {
	test("size + TTL constants unchanged after B3 generalize", async () => {
		const mod = await import("../okfBundle");
		expect(mod.BUNDLE_SOFT_CAP_BYTES).toBe(50 * 1024 * 1024);
		expect(mod.BUNDLE_HARD_CAP_BYTES).toBe(100 * 1024 * 1024);
		expect(mod.DEFAULT_URL_TTL_SECONDS).toBe(3600);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Eta REVISE iter 2 — pagination cursor chain (1 test)
//
// Simulates the action's `collectAllPages()` loop against a fake paginated
// query that returns BUNDLE_PAGE_SIZE rows per page over multiple pages.
// Asserts the loop concatenates all pages in order until `isDone === true`.
// ─────────────────────────────────────────────────────────────────────────────

describe("pagination cursor chain (Eta REVISE iter 2)", () => {
	test("loop walks all pages until isDone and preserves order", async () => {
		const TOTAL = BUNDLE_PAGE_SIZE * 3 + 17; // 785 rows → 4 pages
		const all = Array.from({ length: TOTAL }, (_, i) => ({
			_id: `m_${i}`,
			content: `row ${i}`,
		}));
		const fakeRunQuery = async (
			cursor: string | null,
		): Promise<{
			page: typeof all;
			isDone: boolean;
			continueCursor: string;
		}> => {
			const start = cursor === null ? 0 : Number.parseInt(cursor, 10);
			const end = Math.min(start + BUNDLE_PAGE_SIZE, all.length);
			return {
				page: all.slice(start, end),
				isDone: end >= all.length,
				continueCursor: String(end),
			};
		};

		// Inline the same loop the action uses (`collectAllPages`) to keep the
		// test free of "use node" / Convex action runtime dependencies.
		const collected: Array<{ _id: string; content: string }> = [];
		let cursor: string | null = null;
		let hops = 0;
		for (;;) {
			hops++;
			const res = await fakeRunQuery(cursor);
			collected.push(...res.page);
			if (res.isDone) break;
			cursor = res.continueCursor;
			if (hops > 100) throw new Error("runaway loop");
		}
		expect(collected).toHaveLength(TOTAL);
		expect(collected[0]._id).toBe("m_0");
		expect(collected[TOTAL - 1]._id).toBe(`m_${TOTAL - 1}`);
		expect(hops).toBe(4); // 256 + 256 + 256 + 17 = 785 over 4 pages
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Eta REVISE iter 2 — cross-namespace isolation (1 test)
//
// Verifies the namespace → orgId mapping + `matchesNamespaceScope` predicate
// reject rows whose `orgId` does not match the requested namespace tail.
// This is the unit-test layer of the defence-in-depth that the V8 internal
// queries apply after their `by_orgId` index scan.
// ─────────────────────────────────────────────────────────────────────────────

describe("cross-namespace isolation (Eta REVISE iter 2)", () => {
	test("Phase 1 namespace maps to master (undefined orgId)", () => {
		expect(expectedOrgIdForNamespace(PHASE1_NAMESPACE)).toBeUndefined();
	});

	test("non-Phase-1 project namespace maps to slug tail", () => {
		expect(expectedOrgIdForNamespace("project/acme-hr")).toBe("acme-hr");
	});

	test("matchesNamespaceScope keeps only rows for the requested tenant", () => {
		const rowsA = [
			{ _id: "a1", orgId: undefined }, // master
			{ _id: "a2", orgId: null as unknown as undefined }, // master (legacy null)
			{ _id: "b1", orgId: "acme-hr" }, // tenant B
			{ _id: "b2", orgId: "acme" }, // tenant C
		];
		const keptForMaster = rowsA.filter((r) =>
			matchesNamespaceScope(r, PHASE1_NAMESPACE),
		);
		expect(keptForMaster.map((r) => r._id)).toEqual(["a1", "a2"]);

		const keptForAcme = rowsA.filter((r) =>
			matchesNamespaceScope(r, "project/acme-hr"),
		);
		expect(keptForAcme.map((r) => r._id)).toEqual(["b1"]);
	});
});
