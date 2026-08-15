/// <reference types="vite/client" />
//
// listTasksCursorPagination.test.ts — Day 163 RED-first (Pi, k171rbm2txe42jxzddyqakbg7n8ch7zr)
// ─────────────────────────────────────────────────────────────────────────────
//
// DEFECT 2: `tasks.list` returned a `nextCursor` that yielded an EMPTY page
// while rows remained. Root cause: `needsWideScan` omitted `createdBefore`,
// so a cursor-only call fetched only `limit` NEWEST rows (all of which are
// >= the cursor anchor by construction), then the cursor filter dropped
// every one of them → empty page, read as end-of-list, silently truncating
// the caller's walk.
//
// Both poles required:
//   1. RED — walking a queue larger than one page must see every row
//      exactly once and terminate (fails today: page 2 is empty).
//   2. RED — a cursor that cannot continue (SCAN_CAP_EXCEEDED) must be
//      distinguishable from an exhausted list (empty page + no cursor).
// ─────────────────────────────────────────────────────────────────────────────

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

async function seedQueue(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	t: ReturnType<typeof createT>,
	count: number,
	opts: { assignedTo: string; status: "todo" | "in_progress" | "review" | "blocked" | "done" | "cancelled" },
): Promise<Set<string>> {
	const ids = new Set<string>();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	await t.run(async (ctx: any) => {
		for (let i = 0; i < count; i++) {
			const now = Date.now() + i; // strictly increasing _creationTime-adjacent ordering
			const id = await ctx.db.insert("tasks", {
				title: `queue task ${i}`,
				assignedTo: opts.assignedTo,
				priority: "medium",
				status: opts.status,
				createdBy: opts.assignedTo,
				createdAt: now,
				updatedAt: now,
			});
			ids.add(id as unknown as string);
		}
	});
	return ids;
}

describe("tasks.list — cursor pagination walks a queue larger than one page (Day 163)", () => {
	test("RED: every row is seen exactly once and the walk terminates", async () => {
		const t = createT();
		const assignedTo = "pi-cursor-queue";
		const total = 250;
		const seededIds = await seedQueue(t, total, { assignedTo, status: "todo" });

		const seenIds = new Set<string>();
		let createdBefore: number | undefined;
		let pages = 0;
		const maxPages = 50; // circuit breaker — must terminate well before this

		while (pages < maxPages) {
			pages++;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const page: any[] = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.list, {
				assignedTo,
				status: "todo",
				limit: 50,
				fields: "lite",
				createdBefore,
			});

			if (page.length === 0) break;

			for (const row of page) {
				// No row seen twice.
				expect(seenIds.has(row._id)).toBe(false);
				seenIds.add(row._id);
			}

			const last = page[page.length - 1];
			createdBefore = last._creationTime;

			if (page.length < 50) break; // partial page — exhausted
		}

		// Every seeded row was seen exactly once.
		expect(seenIds.size).toBe(total);
		for (const id of seededIds) {
			expect(seenIds.has(id)).toBe(true);
		}
		// Walk terminated well within the circuit breaker.
		expect(pages).toBeLessThan(maxPages);
	});

	test("RED: an un-continuable cursor is distinguishable from an exhausted list", async () => {
		const t = createT();
		const assignedTo = "pi-cursor-distinguish";
		await seedQueue(t, 5, { assignedTo, status: "todo" });

		// A normal exhausted page (no more matching rows below the cursor) —
		// must be an empty array AND must NOT throw.
		const exhausted = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.list, {
				assignedTo,
				status: "todo",
				limit: 50,
				fields: "lite",
				createdBefore: 1, // older than every seeded row (createdAt is Date.now()+i, always > 1)
			});
		expect(exhausted).toEqual([]);

		// A call that CANNOT be measured (widened scan overflow, forced via
		// updatedSince + createdBy on a global, unindexed candidate set) must
		// THROW ConvexError SCAN_CAP_EXCEEDED — never render as the same empty
		// array as the genuinely-exhausted case above. Seed past the cap.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await t.run(async (ctx: any) => {
			for (let i = 0; i < 2001; i++) {
				const now = Date.now() + i;
				await ctx.db.insert("tasks", {
					title: `distinguish-overflow ${i}`,
					assignedTo: "someone-else-distinguish",
					priority: "medium",
					status: "todo",
					createdBy: "distinguish-overflow-creator",
					createdAt: now,
					updatedAt: now,
				});
			}
		});

		const error: unknown = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.list, {
				createdBy: "distinguish-overflow-creator",
				createdBefore: Date.now() + 1_000_000,
				limit: 50,
				fields: "lite",
			})
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ConvexError);
		expect((error as ConvexError<string>).message).toMatch(/SCAN_CAP_EXCEEDED/);
		// Distinguishable by construction: the exhausted case above returned
		// `[]` and did not throw; this case throws and never reaches `[]`.
	});

	test("RED: widened scan overflow throws SCAN_CAP_EXCEEDED — never a silent empty page", async () => {
		const t = createT();
		const assignedTo = "pi-cursor-overflow";
		// updatedSince forces a bound that, combined on this branch's fallback
		// path, cannot push into the index alongside createdBefore — but the
		// simplest reliable overflow trigger is createdBy (always unindexed,
		// always wide-scanned) combined with createdBefore over > SCAN_CAP rows.
		await seedQueue(t, 5, { assignedTo, status: "todo" });
		// Seed 2001 rows matching createdBy filter distinct from assignedTo so
		// the createdBy branch (global, no assignedTo) wide-scans everything.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await t.run(async (ctx: any) => {
			for (let i = 0; i < 2001; i++) {
				const now = Date.now() + i;
				await ctx.db.insert("tasks", {
					title: `overflow ${i}`,
					assignedTo: "someone-else",
					priority: "medium",
					status: "todo",
					createdBy: "overflow-creator",
					createdAt: now,
					updatedAt: now,
				});
			}
		});

		const error: unknown = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.list, {
				createdBy: "overflow-creator",
				limit: 50,
				fields: "lite",
			})
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ConvexError);
		expect((error as ConvexError<string>).message).toMatch(/SCAN_CAP_EXCEEDED/);
	});
});

describe("tasks.listByMission — cursor pagination (Day 163)", () => {
	test("RED/GREEN: every row is seen exactly once and the walk terminates", async () => {
		const t = createT();
		const total = 220;

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const missionId = await t.run(async (ctx: any) => {
			return await ctx.db.insert("missions", {
				name: "Cursor pagination mission",
				project: "vantage-peers",
				status: "execute",
				priority: "medium",
				pilot: "pi",
				agents: ["pi"],
				createdBy: "pi",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const seededIds = new Set<string>();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await t.run(async (ctx: any) => {
			for (let i = 0; i < total; i++) {
				const now = Date.now() + i;
				const id = await ctx.db.insert("tasks", {
					title: `mission task ${i}`,
					assignedTo: "pi",
					priority: "medium",
					status: "todo",
					createdBy: "pi",
					missionId,
					createdAt: now,
					updatedAt: now,
				});
				seededIds.add(id as unknown as string);
			}
		});

		const seenIds = new Set<string>();
		let createdBefore: number | undefined;
		let pages = 0;
		const maxPages = 50;

		while (pages < maxPages) {
			pages++;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const page: any[] = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.listByMission, {
				missionId,
				status: "todo",
				limit: 50,
				fields: "lite",
				createdBefore,
			});

			if (page.length === 0) break;
			for (const row of page) {
				expect(seenIds.has(row._id)).toBe(false);
				seenIds.add(row._id);
			}
			const last = page[page.length - 1];
			createdBefore = last._creationTime;
			if (page.length < 50) break;
		}

		expect(seenIds.size).toBe(total);
		for (const id of seededIds) {
			expect(seenIds.has(id)).toBe(true);
		}
		expect(pages).toBeLessThan(maxPages);
	});
});
