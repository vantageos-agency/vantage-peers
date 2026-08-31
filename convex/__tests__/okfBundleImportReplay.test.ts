// R-18 — OKF bundle import inserts are idempotent under replay (TOCTOU fix).
//
// Before this change the three import inserts (`_insertImportedMemory`,
// `_insertImportedBriefing`, `_insertImportedTask` in convex/okfBundle.ts) were
// a non-atomic check-then-insert: the Node caller (convex/okfBundleNode.ts
// importOkfBundle) ran a SEPARATE paginated dedup query, then a SEPARATE insert
// mutation. A delivery retried between those two round-trips wrote a second row
// — the imported rows had no stable id to dedup on.
//
// Fix: each `_insertImported*` mutation now carries a `contentHash` (sha256 of
// the entity's dedup key, computed once by the caller) and is an ATOMIC
// findOrCreate — it reads the (namespace|orgId, contentHash) index and returns
// the existing row's _id on a hit instead of inserting. A replay is a no-op.
//
// This suite proves, mechanically:
//   1. Replay idempotence — calling the same insert twice with the same
//      contentHash returns the SAME _id and leaves exactly ONE row.
//   2. Tenant scoping / cross-tenant deny — the SAME content imported into two
//      DIFFERENT tenants (distinct orgId-derived namespaces) does NOT dedup
//      across the tenant boundary: tenant B's replay cannot match tenant A's
//      row, so the idempotency key never becomes a cross-tenant read channel
//      (AUTH_NAMESPACE_DENIED discipline — the key is tenant-scoped, never a
//      global content lookup).
//
// Mission: k5779qbxhwrfjmj02t31yvehns8911jp.
// Orchestrator: Sigma — VantagePeers | 2026-08-31

import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
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

const NOW = 1_700_000_000_000;

// Mirror the caller's hash inputs exactly (convex/okfBundleNode.ts).
const hash = (input: string): string =>
	createHash("sha256").update(input, "utf8").digest("hex");

describe("R-18 import replay idempotence", () => {
	test("memory: a replayed insert returns the same _id, writes one row", async () => {
		const t = createTestConvex();
		const ns = "team/acme-corp";
		const content = "Imported memory body — replay guard.";
		const contentHash = hash(content);

		const first = await t.mutation(internal.okfBundle._insertImportedMemory, {
			namespace: ns,
			type: "reference",
			content,
			createdBy: "sigma",
			contentHash,
			now: NOW,
		});
		const second = await t.mutation(internal.okfBundle._insertImportedMemory, {
			namespace: ns,
			type: "reference",
			content,
			createdBy: "sigma",
			contentHash,
			now: NOW,
		});

		expect(second).toBe(first);
		const rows = await t.run((ctx) =>
			ctx.db
				.query("memories")
				.withIndex("by_namespace_contentHash", (q) =>
					q.eq("namespace", ns).eq("isLatest", true).eq("contentHash", contentHash),
				)
				.collect(),
		);
		expect(rows).toHaveLength(1);
	});

	// Eta REVISE #1253: the dedup is scoped to the LIVE row. A memory can be flipped
	// isLatest:false WITHOUT deletion (soft_delete_memory, the TTL cron, the `updates`
	// relation). Without isLatest in the index, a re-import matches that DEAD row,
	// inserts nothing, and falsely reports success — the memory stays unrestored. This
	// pole proves a re-import over a superseded row creates a NEW live row.
	test("memory: re-import over a SUPERSEDED (isLatest:false) row inserts a fresh live row", async () => {
		const t = createTestConvex();
		const ns = "team/acme-corp";
		const content = "Imported memory body — supersede-then-reimport.";
		const contentHash = hash(content);

		const dead = await t.mutation(internal.okfBundle._insertImportedMemory, {
			namespace: ns,
			type: "reference",
			content,
			createdBy: "sigma",
			contentHash,
			now: NOW,
		});
		// Simulate soft_delete / TTL / an `updates` supersede: flip to isLatest:false,
		// row NOT deleted.
		await t.run((ctx) => ctx.db.patch(dead, { isLatest: false }));

		const revived = await t.mutation(internal.okfBundle._insertImportedMemory, {
			namespace: ns,
			type: "reference",
			content,
			createdBy: "sigma",
			contentHash,
			now: NOW,
		});

		// The re-import did NOT match the dead row — it inserted a new live row.
		expect(revived).not.toBe(dead);
		const live = await t.run((ctx) =>
			ctx.db
				.query("memories")
				.withIndex("by_namespace_contentHash", (q) =>
					q.eq("namespace", ns).eq("isLatest", true).eq("contentHash", contentHash),
				)
				.collect(),
		);
		expect(live).toHaveLength(1);
		expect(live[0]._id).toBe(revived);
		// The superseded row still exists, untouched.
		const deadRow = await t.run((ctx) => ctx.db.get(dead));
		expect(deadRow?.isLatest).toBe(false);
	});

	test("briefing: a replayed insert returns the same _id, writes one row", async () => {
		const t = createTestConvex();
		const ns = "team/acme-corp";
		const title = "Kickoff";
		const content = "Briefing body — replay guard.";
		const contentHash = hash(`${title}\n${content}`);

		const first = await t.mutation(internal.okfBundle._insertImportedBriefing, {
			namespace: ns,
			title,
			topic: "replay",
			participants: ["sigma"],
			content,
			createdBy: "sigma",
			contentHash,
			now: NOW,
		});
		const second = await t.mutation(
			internal.okfBundle._insertImportedBriefing,
			{
				namespace: ns,
				title,
				topic: "replay",
				participants: ["sigma"],
				content,
				createdBy: "sigma",
				contentHash,
				now: NOW,
			},
		);

		expect(second).toBe(first);
		const rows = await t.run((ctx) =>
			ctx.db
				.query("briefingNotes")
				.withIndex("by_orgId_contentHash", (q) =>
					q.eq("orgId", "acme-corp").eq("contentHash", contentHash),
				)
				.collect(),
		);
		expect(rows).toHaveLength(1);
	});

	test("task: a replayed insert returns the same _id, writes one row", async () => {
		const t = createTestConvex();
		const ns = "team/acme-corp";
		const title = "Ship the fix";
		const description = "Task body — replay guard.";
		const contentHash = hash(`${title}\n${description}`);

		const first = await t.mutation(internal.okfBundle._insertImportedTask, {
			namespace: ns,
			title,
			description,
			assignedTo: "sigma",
			priority: "medium",
			status: "todo",
			createdBy: "sigma",
			contentHash,
			now: NOW,
		});
		const second = await t.mutation(internal.okfBundle._insertImportedTask, {
			namespace: ns,
			title,
			description,
			assignedTo: "sigma",
			priority: "medium",
			status: "todo",
			createdBy: "sigma",
			contentHash,
			now: NOW,
		});

		expect(second).toBe(first);
		const rows = await t.run((ctx) =>
			ctx.db
				.query("tasks")
				.withIndex("by_orgId_contentHash", (q) =>
					q.eq("orgId", "acme-corp").eq("contentHash", contentHash),
				)
				.collect(),
		);
		expect(rows).toHaveLength(1);
	});
});

describe("R-18 idempotency key is tenant-scoped — cross-tenant deny", () => {
	// AUTH_NAMESPACE_DENIED discipline: identical content in two different
	// tenants must resolve to two DISTINCT rows. If the findOrCreate keyed on
	// contentHash alone (globally) instead of (orgId, contentHash), tenant B's
	// import would silently dedup-match tenant A's row — a cross-tenant read
	// channel. This asserts the key never crosses the tenant boundary.
	test("task: same content, two tenants → two distinct rows, no cross-tenant match", async () => {
		const t = createTestConvex();
		const title = "Shared title";
		const description = "Shared body.";
		const contentHash = hash(`${title}\n${description}`);

		const idA = await t.mutation(internal.okfBundle._insertImportedTask, {
			namespace: "team/tenant-a",
			title,
			description,
			assignedTo: "sigma",
			priority: "medium",
			status: "todo",
			createdBy: "sigma",
			contentHash,
			now: NOW,
		});
		const idB = await t.mutation(internal.okfBundle._insertImportedTask, {
			namespace: "team/tenant-b",
			title,
			description,
			assignedTo: "sigma",
			priority: "medium",
			status: "todo",
			createdBy: "sigma",
			contentHash,
			now: NOW,
		});

		// The shared contentHash did NOT collapse the two tenants' rows.
		expect(idB).not.toBe(idA);
		const aRows = await t.run((ctx) =>
			ctx.db
				.query("tasks")
				.withIndex("by_orgId_contentHash", (q) =>
					q.eq("orgId", "tenant-a").eq("contentHash", contentHash),
				)
				.collect(),
		);
		const bRows = await t.run((ctx) =>
			ctx.db
				.query("tasks")
				.withIndex("by_orgId_contentHash", (q) =>
					q.eq("orgId", "tenant-b").eq("contentHash", contentHash),
				)
				.collect(),
		);
		expect(aRows).toHaveLength(1);
		expect(bRows).toHaveLength(1);
		expect(aRows[0]._id).toBe(idA);
		expect(bRows[0]._id).toBe(idB);
	});

	// Eta REVISE #1253: the memory path needs the same cross-tenant twin as task —
	// the memory dedup keys on `namespace` (team/<orgId>), so identical content in two
	// tenants must resolve to two distinct live rows, never a cross-tenant dedup match.
	test("memory: same content, two tenants → two distinct rows, no cross-tenant match", async () => {
		const t = createTestConvex();
		const content = "Shared memory body.";
		const contentHash = hash(content);

		const idA = await t.mutation(internal.okfBundle._insertImportedMemory, {
			namespace: "team/tenant-a",
			type: "reference",
			content,
			createdBy: "sigma",
			contentHash,
			now: NOW,
		});
		const idB = await t.mutation(internal.okfBundle._insertImportedMemory, {
			namespace: "team/tenant-b",
			type: "reference",
			content,
			createdBy: "sigma",
			contentHash,
			now: NOW,
		});

		expect(idB).not.toBe(idA);
		const aRows = await t.run((ctx) =>
			ctx.db
				.query("memories")
				.withIndex("by_namespace_contentHash", (q) =>
					q.eq("namespace", "team/tenant-a").eq("isLatest", true).eq("contentHash", contentHash),
				)
				.collect(),
		);
		const bRows = await t.run((ctx) =>
			ctx.db
				.query("memories")
				.withIndex("by_namespace_contentHash", (q) =>
					q.eq("namespace", "team/tenant-b").eq("isLatest", true).eq("contentHash", contentHash),
				)
				.collect(),
		);
		expect(aRows).toHaveLength(1);
		expect(bRows).toHaveLength(1);
		expect(aRows[0]._id).toBe(idA);
		expect(bRows[0]._id).toBe(idB);
	});
});
