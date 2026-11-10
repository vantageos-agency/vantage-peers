/// <reference types="vite/client" />
//
// diaryListScanCap.test.ts — `diary:list` for the fleet master with `createdBy`
// and NO `orchestrator` reads a bounded range per call, whatever the author's
// density, and a capped page hands back a cursor that resumes without a gap.
// ─────────────────────────────────────────────────────────────────────────────
//
// DEFECT (Eta REVISE on #1732, the #1724 class): that path walked
// `by_creation_time` with `createdBy` as a `.filter()` before the `take`. For a
// SPARSE author the filter keeps evaluating rows until `limit` matches exist, so
// one call can walk the whole table. `createdBy` is a NAME stamped on legacy rows
// too (no `createdById` there), so no ID-keyed index can serve it, and a
// name-keyed index would count against R-53: the read is CAPPED instead.
//
// THE PROXY FOR "DOCUMENTS A READ CAN WALK" (declared, not hidden). convex-test
// meters only documents a function RECEIVES. The `db` wrapper below records, for
// each read of `diary`, the size of the index range it opened (the same
// `withIndex(...)` replayed alone with `.collect()`). A read that evaluates a
// `.filter()` walks that whole range; a read with no filter and a `take(n)`
// walks at most `n` of it. `walked` is that bound.
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "vitest";
import schema from "../schema";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import * as diaryModule from "../diary";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const SERVICE_ACCOUNT = { subject: "test-service-account-user-id" } as const;

/** Declared scan cap: must equal `DIARY_LIST_SCAN_CAP` in convex/diary.ts. */
const CAP = 500;

type Op = { m: string; args: unknown[] };
type ReadLog = { index: string; rangeDocs: number; walked: number };
const TERMINALS: ReadonlySet<string> = new Set(["take", "collect", "first", "unique"]);

// biome-ignore lint/suspicious/noExplicitAny: a structural wrapper over the db reader
type Loose = any;

function recorder(db: Loose, ops: Op[], log: ReadLog[]): Loose {
	return new Proxy(
		{},
		{
			get(_t, prop) {
				if (typeof prop !== "string") return undefined;
				if (TERMINALS.has(prop)) {
					return async (...args: unknown[]) => {
						const first = ops.find((o) => o.m === "withIndex");
						let ranged = db.query("diary");
						if (first) ranged = ranged.withIndex(...first.args);
						const range: unknown[] = await ranged.collect();
						const filtered = ops.some((o) => o.m === "filter");
						const takeN = prop === "take" ? Number(args[0]) : range.length;
						log.push({
							index: first ? String(first.args[0]) : "<full table>",
							rangeDocs: range.length,
							walked: filtered ? range.length : Math.min(range.length, takeN),
						});
						let q = db.query("diary");
						for (const op of ops) q = q[op.m](...op.args);
						return q[prop](...args);
					};
				}
				return (...args: unknown[]) => recorder(db, [...ops, { m: prop, args }], log);
			},
		},
	);
}

function metered(ctx: Loose, log: ReadLog[]): Loose {
	const db = ctx.db;
	const dbProxy = new Proxy(db, {
		get(target, prop) {
			if (prop === "query") {
				return (name: string) =>
					name === "diary" ? recorder(target, [], log) : target.query(name);
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
type Page = {
	rows: Row[];
	partial: boolean;
	nextCreatedBefore: number | null;
	reads: ReadLog[];
};

async function readPage(client: Client, args: Record<string, unknown>): Promise<Page> {
	const log: ReadLog[] = [];
	const res = await client.run(async (ctx) =>
		(diaryModule.list as Loose)._handler(metered(ctx, log), args),
	);
	if (Array.isArray(res)) {
		return { rows: res, partial: false, nextCreatedBefore: null, reads: log };
	}
	if (res && res.partial === true) {
		return {
			rows: res.items,
			partial: true,
			nextCreatedBefore: res.nextCreatedBefore,
			reads: log,
		};
	}
	throw new Error(`unexpected result shape: ${JSON.stringify(res)}`);
}

const AUTHOR = "pi";
const OTHER = "beta";
// 1300 entries, oldest first. AUTHOR wrote three: the oldest, one at 400 and one
// at 900. Every other entry is OTHER's. With a cap of 500 the author's rows sit in
// three different scan windows, so a sparse author needs several calls.
const TOTAL = 1300;
const AUTHOR_AT = new Set([0, 400, 900]);

async function seed() {
	const t = convexTest(schema, modules);
	const master = t.withIdentity(SERVICE_ACCOUNT as Parameters<typeof t.withIdentity>[0]);
	const ids: string[] = await t.run(async (ctx) => {
		const out: string[] = [];
		for (let i = 0; i < TOTAL; i++) {
			out.push(
				await ctx.db.insert("diary", {
					date: "2026-03-01",
					orchestrator: i % 2 === 0 ? "sigma" : "eta",
					content: `fixture ${i}`,
					createdBy: AUTHOR_AT.has(i) ? AUTHOR : OTHER,
					createdAt: 1_780_000_000_000 + i,
				}),
			);
		}
		return out;
	});
	return { master: master as unknown as Client, ids };
}

describe("diary:list master createdBy without orchestrator — a bounded scan per call", () => {
	test("the scan cap is declared and equals the tested one", () => {
		expect((diaryModule as Record<string, unknown>).DIARY_LIST_SCAN_CAP).toBe(CAP);
	});

	test("a sparse author: no call walks more than the cap", async () => {
		const { master } = await seed();
		const page = await readPage(master, { createdBy: AUTHOR, limit: 5 });
		expect(page.reads).toHaveLength(1);
		expect(page.reads[0].rangeDocs).toBeGreaterThan(CAP);
		expect(page.reads[0].walked).toBeLessThanOrEqual(CAP);
	});

	test("a capped page returns a cursor that resumes with no gap and no duplicate", async () => {
		const { master, ids } = await seed();
		const expected = [...AUTHOR_AT].sort((a, b) => b - a).map((i) => ids[i]);
		const collected: string[] = [];
		let createdBefore: number | undefined;
		let calls = 0;
		let sawPartial = false;
		for (; calls < 10; ) {
			const page = await readPage(master, { createdBy: AUTHOR, limit: 5, createdBefore });
			calls++;
			expect(page.reads[0].walked).toBeLessThanOrEqual(CAP);
			collected.push(...page.rows.map((r) => r._id));
			if (page.partial) {
				sawPartial = true;
				createdBefore = page.nextCreatedBefore ?? undefined;
				continue;
			}
			break;
		}
		expect(sawPartial).toBe(true);
		expect(collected).toEqual(expected);
		expect(calls).toBeGreaterThan(1);
	});

	test("a dense author fills the page in one call: bare array, exact limit", async () => {
		const { master, ids } = await seed();
		const page = await readPage(master, { createdBy: OTHER, limit: 7 });
		expect(page.partial).toBe(false);
		expect(page.rows.map((r) => r._id)).toEqual(
			ids.filter((_, i) => !AUTHOR_AT.has(i)).reverse().slice(0, 7),
		);
	});
});
