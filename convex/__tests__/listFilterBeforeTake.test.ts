/// <reference types="vite/client" />
//
// listFilterBeforeTake.test.ts — a filter the caller passes is applied by the
// READ, before the take, not to the rows the take already cut.
// ─────────────────────────────────────────────────────────────────────────────
//
// DEFECT (class swept by #1724, two sites left): `diary:list` with `createdBy`
// and `recurringTasks:list` with `assignedTo` + `active` took `limit` rows and
// THEN dropped the rows that did not match. A page whose newest rows belong to
// someone else came back short (or empty) with no cursor, while matching rows
// sat further down. The MCP tools emit `nextCursor` only on a full page, so the
// caller was told "that is all" when it was not.
//
// Precedent: #1727 (`messages:listMessages`) narrows the read by a `.filter()`
// BEFORE the take, with the cursor anchor inside the index range when the index
// allows it. This suite reuses its measuring harness: a `db` wrapper that, for
// every read of the table under test, records the index the read opened and the
// SIZE OF THAT INDEX RANGE (the same `withIndex(...)` replayed alone with
// `.collect()`). The range size is the upper bound of the documents the read can
// walk, whatever the filter or the take do afterwards. convex-test meters only
// documents a function RECEIVES, so a volume assertion on the read itself cannot
// fail here; the range is the declared proxy.
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { seedFleetAgents } from "../../tests/lib/seedFleetAgents";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { list as diaryList } from "../diary";
import { list as recurringList } from "../recurringTasks";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const SERVICE_ACCOUNT = { subject: "test-service-account-user-id" } as const;

type Op = { m: string; args: unknown[] };
type ReadLog = { index: string; rangeDocs: number };
const TERMINALS: ReadonlySet<string> = new Set(["take", "collect", "first", "unique"]);

// biome-ignore lint/suspicious/noExplicitAny: a structural wrapper over the db reader
type Loose = any;

function recorder(db: Loose, table: string, ops: Op[], log: ReadLog[]): Loose {
	return new Proxy(
		{},
		{
			get(_t, prop) {
				if (typeof prop !== "string") return undefined;
				if (TERMINALS.has(prop)) {
					return async (...args: unknown[]) => {
						const first = ops.find((o) => o.m === "withIndex");
						let ranged = db.query(table);
						if (first) ranged = ranged.withIndex(...first.args);
						const range: unknown[] = await ranged.collect();
						log.push({
							index: first ? String(first.args[0]) : "<full table>",
							rangeDocs: range.length,
						});
						let q = db.query(table);
						for (const op of ops) q = q[op.m](...op.args);
						return q[prop](...args);
					};
				}
				return (...args: unknown[]) =>
					recorder(db, table, [...ops, { m: prop, args }], log);
			},
		},
	);
}

function metered(ctx: Loose, table: string, log: ReadLog[]): Loose {
	const db = ctx.db;
	const dbProxy = new Proxy(db, {
		get(target, prop) {
			if (prop === "query") {
				return (name: string) =>
					name === table ? recorder(target, table, [], log) : target.query(name);
			}
			const v = Reflect.get(target, prop);
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
	return new Proxy(ctx, {
		get(target, prop) {
			if (prop === "db") return dbProxy;
			return Reflect.get(target, prop);
		},
	});
}

type Client = { run: <T>(fn: (ctx: Loose) => Promise<T>) => Promise<T> };
type Row = { _id: string; _creationTime: number };

async function meteredRead(
	client: Client,
	fn: Loose,
	table: string,
	args: Record<string, unknown>,
): Promise<{ rows: Row[]; reads: ReadLog[] }> {
	const log: ReadLog[] = [];
	const rows = await client.run(async (ctx) =>
		fn._handler(metered(ctx, table, log), args),
	);
	if (!Array.isArray(rows)) throw new Error("the fleet master must be served the bare array");
	return { rows, reads: log };
}

async function createdAt(client: Client, table: "diary" | "recurringTasks", id: string): Promise<number> {
	return client.run(async (ctx) => {
		const docId = ctx.db.normalizeId(table, id);
		const doc = docId === null ? null : await ctx.db.get(docId);
		if (doc === null) throw new Error(`fixture ${id} not found`);
		return doc._creationTime;
	});
}

// ── diary:list with createdBy ────────────────────────────────────────────────

const AUTHOR = "pi";
const OTHER = "beta";

// 24 entries, oldest first. The 8 newest belong to OTHER, so the first `limit`
// rows of the table are all foreign; AUTHOR's 16 sit below them, interleaved
// with OTHER's (every third row).
async function seedDiary() {
	const t = convexTest(schema, modules);
	const master = t.withIdentity(SERVICE_ACCOUNT as Parameters<typeof t.withIdentity>[0]);
	const plan: string[] = [];
	for (let i = 0; i < 16; i++) plan.push(i % 3 === 2 ? OTHER : AUTHOR);
	for (let i = 0; i < 8; i++) plan.push(OTHER);
	const seeded: Array<{ _id: string; orchestrator: string; createdBy: string }> = [];
	let at = 1_780_000_000_000;
	for (const [i, createdBy] of plan.entries()) {
		at += 1000;
		const orchestrator = i % 2 === 0 ? "sigma" : "eta";
		const date = `2026-03-${String(i + 1).padStart(2, "0")}`;
		const id: string = await t.run(async (ctx) =>
			ctx.db.insert("diary", {
				date,
				orchestrator,
				content: `fixture ${i}`,
				createdBy,
				createdAt: at,
			}),
		);
		seeded.push({ _id: id, orchestrator, createdBy });
	}
	return { t, master, seeded };
}

describe("diary:list createdBy — the filter is applied before the take", () => {
	test("the first page is FULL when more matching rows exist, and its cursor walks every match once", async () => {
		const { master, seeded } = await seedDiary();
		const expected = seeded.filter((r) => r.createdBy === AUTHOR).map((r) => r._id).reverse();
		expect(expected).toHaveLength(11);
		const LIMIT = 4;
		const collected: string[] = [];
		let createdBefore: number | undefined;
		let firstPage = -1;
		for (let page = 0; page < 10; page++) {
			const { rows } = await meteredRead(master as unknown as Client, diaryList, "diary", {
				createdBy: AUTHOR,
				limit: LIMIT,
				createdBefore,
			});
			if (page === 0) firstPage = rows.length;
			collected.push(...rows.map((r) => r._id));
			if (rows.length < LIMIT) break;
			createdBefore = rows[rows.length - 1]._creationTime;
		}
		expect(firstPage).toBe(LIMIT);
		expect(collected).toEqual(expected);
	});

	test("with an orchestrator too: full page, no gap, no duplicate", async () => {
		const { master, seeded } = await seedDiary();
		const expected = seeded
			.filter((r) => r.createdBy === AUTHOR && r.orchestrator === "sigma")
			.map((r) => r._id)
			.reverse();
		const LIMIT = 3;
		const collected: string[] = [];
		let createdBefore: number | undefined;
		let firstPage = -1;
		for (let page = 0; page < 10; page++) {
			const { rows } = await meteredRead(master as unknown as Client, diaryList, "diary", {
				orchestrator: "sigma",
				createdBy: AUTHOR,
				limit: LIMIT,
				createdBefore,
			});
			if (page === 0) firstPage = rows.length;
			collected.push(...rows.map((r) => r._id));
			if (rows.length < LIMIT) break;
			createdBefore = rows[rows.length - 1]._creationTime;
		}
		expect(expected.length).toBeGreaterThan(LIMIT);
		expect(firstPage).toBe(LIMIT);
		expect(new Set(collected).size).toBe(collected.length);
		expect(collected).toEqual(expected);
	});

	test("a cursor opens the range BELOW its anchor, not the whole table", async () => {
		const { master, seeded } = await seedDiary();
		// Entry 12 is one of AUTHOR's; the 12 entries below it are all the read may walk.
		const anchor = await createdAt(master as unknown as Client, "diary", seeded[12]._id);
		const { rows, reads } = await meteredRead(master as unknown as Client, diaryList, "diary", {
			createdBy: AUTHOR,
			limit: 4,
			createdBefore: anchor,
		});
		expect(rows).toHaveLength(4);
		// The window read, then the filtered read inside it: both below the anchor.
		expect(reads.length).toBeGreaterThan(0);
		for (const read of reads) {
			expect(read.rangeDocs).toBeLessThanOrEqual(12);
			expect(read.rangeDocs).toBeLessThan(seeded.length);
		}
	});
});

// ── recurringTasks:list with assignedTo + active ─────────────────────────────

const ASSIGNEE = "sweep-assignee";

// 12 templates for ASSIGNEE, oldest first. The 7 newest are paused, so the first
// `limit` rows of the assignee's range are all paused; 5 are active, below them.
async function seedRecurring() {
	const t = convexTest(schema, modules);
	await seedFleetAgents(t, [ASSIGNEE, "sigma"]);
	const master = t.withIdentity(SERVICE_ACCOUNT as Parameters<typeof t.withIdentity>[0]);
	const seeded: Array<{ _id: string; active: boolean }> = [];
	for (let i = 0; i < 12; i++) {
		const id: string = await master.mutation(api.recurringTasks.create, {
			title: `fixture ${i}`,
			assignedTo: ASSIGNEE,
			priority: "medium",
			cronExpression: "0 9 * * *",
			createdBy: "sigma",
		});
		const active = i < 5;
		if (!active) {
			await t.run(async (ctx) => {
				const docId = ctx.db.normalizeId("recurringTasks", id);
				if (docId === null) throw new Error("fixture id does not normalise");
				await ctx.db.patch(docId, { active: false });
			});
		}
		seeded.push({ _id: id, active });
	}
	return { t, master, seeded };
}

describe("recurringTasks:list assignedTo + active — the filter is applied before the take", () => {
	test("the first page is FULL when more active templates exist, and its cursor walks each once", async () => {
		const { master, seeded } = await seedRecurring();
		const expected = seeded.filter((r) => r.active).map((r) => r._id).reverse();
		expect(expected).toHaveLength(5);
		const LIMIT = 2;
		const collected: string[] = [];
		let createdBefore: number | undefined;
		let firstPage = -1;
		for (let page = 0; page < 10; page++) {
			const { rows } = await meteredRead(
				master as unknown as Client,
				recurringList,
				"recurringTasks",
				{ assignedTo: ASSIGNEE, active: true, limit: LIMIT, createdBefore },
			);
			if (page === 0) firstPage = rows.length;
			collected.push(...rows.map((r) => r._id));
			if (rows.length < LIMIT) break;
			createdBefore = rows[rows.length - 1]._creationTime;
		}
		expect(firstPage).toBe(LIMIT);
		expect(new Set(collected).size).toBe(collected.length);
		expect(collected).toEqual(expected);
	});

	test("active=false pages the same way (the paused ones are the newest here)", async () => {
		const { master, seeded } = await seedRecurring();
		const expected = seeded.filter((r) => !r.active).map((r) => r._id).reverse();
		const collected: string[] = [];
		let createdBefore: number | undefined;
		for (let page = 0; page < 10; page++) {
			const { rows } = await meteredRead(
				master as unknown as Client,
				recurringList,
				"recurringTasks",
				{ assignedTo: ASSIGNEE, active: false, limit: 3, createdBefore },
			);
			collected.push(...rows.map((r) => r._id));
			if (rows.length < 3) break;
			createdBefore = rows[rows.length - 1]._creationTime;
		}
		expect(collected).toEqual(expected);
	});

	test("a cursor opens the assignee's range BELOW its anchor, not the whole range", async () => {
		const { master, seeded } = await seedRecurring();
		// Template 4 is the oldest-but-one active one; 4 templates sit below it.
		const anchor = await createdAt(master as unknown as Client, "recurringTasks", seeded[4]._id);
		const { rows, reads } = await meteredRead(
			master as unknown as Client,
			recurringList,
			"recurringTasks",
			{ assignedTo: ASSIGNEE, active: true, limit: 2, createdBefore: anchor },
		);
		expect(rows).toHaveLength(2);
		expect(reads).toHaveLength(1);
		expect(reads[0].rangeDocs).toBeLessThanOrEqual(4);
		expect(reads[0].rangeDocs).toBeLessThan(seeded.length);
	});
});
