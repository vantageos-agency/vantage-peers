/// <reference types="vite/client" />
//
// listTasksCursorIndexGuard.test.ts — task k1796new6573dscmveetyvnqe98chbnb
// ─────────────────────────────────────────────────────────────────────────────
// `canPushCursorIntoIndex` (convex/tasks.ts, runTasksList and listByMission)
// encodes a Convex runtime rule the test harness does NOT enforce: an index
// range may add `.lt("_creationTime", before)` only when every explicit index
// field is pinned by equality, and only ONE range clause is allowed. convex-test
// accepts an illegal range, so relaxing the guard leaves a green suite and a
// throw in production.
//
// These tests therefore pin BEHAVIOUR the relaxation changes, not the throw:
//
//  - MUT-2 (drop `updatedSince === undefined`): with the guard relaxed, a
//    cursor + updatedSince call takes the index-pushed `.take(limit)` path, so
//    `limit` rows below the cursor are fetched BEFORE the in-memory updatedSince
//    filter. If the newest rows below the cursor are stale, the page comes back
//    short/empty and the walk loses the fresh rows behind them.
//
//  - MUT-3 (drop `statuses.length === 1`): measured as an EQUIVALENT mutant at
//    every current call site, because each use of the flag already sits inside
//    an `if (statuses.length === 1)` branch. No behaviour differs, so no
//    behavioural test can bite it; see the structural pin at the bottom, which
//    fails if a use of the flag is ever moved outside a single-status branch.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { api } from "../_generated/api";
import schema from "../schema";
import { insertTaskRow, seedFleetAgents } from "../../tests/lib/seedFleetAgents";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
const SA = { subject: "test-service-account-user-id" };

type Seed = { title: string; fresh: boolean };

// Oldest -> newest. The 3 newest rows are STALE (updatedAt below the window);
// the 6 older rows are FRESH. With limit=3 and a cursor above all of them, an
// index-pushed take(3) sees only the stale rows.
const ORDER: Seed[] = [
	...[0, 1, 2, 3, 4, 5].map((i) => ({ title: `fresh-${i}`, fresh: true })),
	...[0, 1, 2].map((i) => ({ title: `stale-${i}`, fresh: false })),
];
const WINDOW = 1_000_000;

async function seed(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	t: any,
	extra: Record<string, unknown>,
): Promise<void> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	await t.run(async (ctx: any) => {
		for (const row of ORDER) {
			await insertTaskRow(ctx, {
				title: row.title,
				assignedTo: "guard-creator",
				priority: "medium",
				status: "todo",
				createdBy: "guard-creator",
				createdAt: Date.now(),
				updatedAt: row.fresh ? WINDOW + 10 : WINDOW - 10,
				...extra,
			});
		}
	});
}

const EXPECTED_FRESH = ORDER.filter((r) => r.fresh)
	.map((r) => r.title)
	.reverse(); // newest first

async function walk(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	call: (cursor: number | undefined) => Promise<any[]>,
): Promise<string[]> {
	const seen: string[] = [];
	let cursor: number | undefined = Number.MAX_SAFE_INTEGER;
	for (let pages = 0; pages < 10; pages++) {
		const page = await call(cursor);
		if (page.length === 0) break;
		for (const r of page) seen.push(r.title as string);
		cursor = page[page.length - 1]._creationTime as number;
		if (page.length < 3) break;
	}
	return seen;
}

describe("MUT-2 — cursor + updatedSince must not take the index-pushed take(limit) path", () => {
	test("list {project, status, updatedSince, createdBefore}: stale rows under the cursor do not hide fresh ones", async () => {
		const t = createT();
		await seedFleetAgents(t, ["guard-creator"]);
		await seed(t, { project: "guard-project" });
		const seen = await walk((cursor) =>
			t.withIdentity(SA).query(api.tasks.list, {
				project: "guard-project",
				status: "todo",
				updatedSince: WINDOW,
				createdBefore: cursor,
				limit: 3,
				fields: "lite",
			}),
		);
		expect(seen).toEqual(EXPECTED_FRESH);
	});

	test("list {assignedToInstance, status, updatedSince, createdBefore}: same property on by_instance", async () => {
		const t = createT();
		await seedFleetAgents(t, ["guard-creator"]);
		await seed(t, { assignedToInstance: "guard-instance" });
		const seen = await walk((cursor) =>
			t.withIdentity(SA).query(api.tasks.list, {
				assignedToInstance: "guard-instance",
				status: "todo",
				updatedSince: WINDOW,
				createdBefore: cursor,
				limit: 3,
				fields: "lite",
			}),
		);
		expect(seen).toEqual(EXPECTED_FRESH);
	});

	test("list {assignedToInstance, project, status, updatedSince, createdBefore}: same property on by_instance_project", async () => {
		const t = createT();
		await seedFleetAgents(t, ["guard-creator"]);
		await seed(t, { assignedToInstance: "guard-instance", project: "guard-project" });
		const seen = await walk((cursor) =>
			t.withIdentity(SA).query(api.tasks.list, {
				assignedToInstance: "guard-instance",
				project: "guard-project",
				status: "todo",
				updatedSince: WINDOW,
				createdBefore: cursor,
				limit: 3,
				fields: "lite",
			}),
		);
		expect(seen).toEqual(EXPECTED_FRESH);
	});

	test("listByMission {status, updatedSince, createdBefore}: same property on by_mission", async () => {
		const t = createT();
		await seedFleetAgents(t, ["guard-creator"]);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const missionId = await t.run(async (ctx: any) =>
			ctx.db.insert("missions", {
				name: "Cursor index guard mission",
				project: "vantage-peers",
				status: "execute",
				priority: "medium",
				pilot: "pi",
				agents: ["pi"],
				createdBy: "pi",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		await seed(t, { missionId });
		const seen = await walk((cursor) =>
			t.withIdentity(SA).query(api.tasks.listByMission, {
				missionId,
				status: "todo",
				updatedSince: WINDOW,
				createdBefore: cursor,
				limit: 3,
				fields: "lite",
			}),
		);
		expect(seen).toEqual(EXPECTED_FRESH);
	});
});

describe("MUT-3 — multi-status + cursor: no hole, no duplicate (behavioural companion)", () => {
	test("list {project, status:[todo,in_progress], createdBefore} walk equals the expected set exactly once", async () => {
		const t = createT();
		await seedFleetAgents(t, ["guard-creator"]);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await t.run(async (ctx: any) => {
			for (let i = 0; i < 12; i++) {
				await insertTaskRow(ctx, {
					title: `multi-${i}`,
					assignedTo: "guard-creator",
					priority: "medium",
					status: i % 2 === 0 ? "todo" : "in_progress",
					createdBy: "guard-creator",
					project: "guard-project",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			}
		});
		const seen: string[] = [];
		let cursor: number | undefined = Number.MAX_SAFE_INTEGER;
		for (let pages = 0; pages < 10; pages++) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const page: any[] = await t.withIdentity(SA).query(api.tasks.list, {
				project: "guard-project",
				status: ["todo", "in_progress"],
				createdBefore: cursor,
				limit: 5,
				fields: "lite",
			});
			if (page.length === 0) break;
			for (const r of page) seen.push(r.title as string);
			cursor = page[page.length - 1]._creationTime as number;
			if (page.length < 5) break;
		}
		expect(seen).toEqual(Array.from({ length: 12 }, (_, i) => `multi-${11 - i}`));
	});
});

describe("MUT-3 — structural pin: the cursor bound is a range clause only after every explicit index field is pinned", () => {
	// The runtime rule (equality on every explicit index field, then one range)
	// is not enforced by convex-test. The old `canPushCursorIntoIndex` flag guarded
	// it by hand; tasks.list now reads one index range PER STATUS BUCKET, so every
	// `.lt("_creationTime", ...)` must directly follow an `.eq("status", status)`
	// (the last explicit field of the index it ranges on), or sit on the
	// `by_creation_time` index, which has no explicit field. If a range clause is
	// moved after a field that is not pinned, production throws while every
	// behavioural test stays green.
	const full = readFileSync(resolve(__dirname, "../tasks.ts"), "utf8");
	const start = full.indexOf("async function runTasksList(");
	const end = full.indexOf("export const list = query(", start);
	const src = full.slice(start, end);

	test("the retired flag is gone", () => {
		expect(src).not.toMatch(/canPushCursorIntoIndex/);
	});

	test("every `.lt(\"_creationTime\", upper)` follows .eq(\"status\", status) or is the creation-time index", () => {
		const lines = src.split("\n");
		const sites: number[] = [];
		lines.forEach((l, i) => {
			if (/\.lt\("_creationTime", upper\)/.test(l)) sites.push(i);
		});
		expect(sites.length).toBeGreaterThan(8);
		for (const idx of sites) {
			const window = lines.slice(Math.max(0, idx - 8), idx + 1).join("\n");
			const pinned = /\.eq\("status", status\)\s*\.lt\("_creationTime", upper\)/.test(
				window.replace(/\s+/g, " ").replace(/\) \./g, ").").replace(/\)\./g, ")."),
			);
			const creationIndex = /withIndex\("by_creation_time"/.test(window);
			expect(
				pinned || creationIndex,
				`tasks.ts runTasksList range at +${idx + 1} is not preceded by a pinned status`,
			).toBe(true);
		}
	});
});
