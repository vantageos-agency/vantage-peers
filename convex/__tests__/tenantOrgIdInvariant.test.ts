/// <reference types="vite/client" />
//
// migrations/tenantOrgIdInvariant:count (Pi, task k1768vhaqbsf7kvtb4z8xhx6818hg19t,
// deliverable 1): the READ-ONLY coverage of the permanent org ID over EVERY tenant-scoped
// table, derived from convex/schema.ts. Pinned:
//   1. the derived set equals what schema.ts declares, read INDEPENDENTLY from its source
//      text (so a new tenant table is counted without editing a list);
//   2. stamped / slugOnly / unstamped / resolvable counted right, for every derived table;
//   3. the count writes nothing (every row of every table byte-identical);
//   4. paging sums to the whole;
//   5. no row id and no slug in the output;
//   6. an empty derived set refuses;
//   7. it covers every table the typed ORG_COLUMNS list names, with the same columns.
// Rows are inserted WITHOUT the schema (convexTest with no schema): `count` reads only the
// slug column, the id column and `_creationTime`. Fictitious identifiers only. Hermetic.

import { readFileSync } from "node:fs";
import type { FunctionReturnType } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { ORG_COLUMNS } from "../migrations/backfill_org_clerk_id";
import {
	deriveTenantTables,
	ID_COLUMN_CANDIDATES,
	SLUG_COLUMN_CANDIDATES,
	type TenantTable,
} from "../migrations/tenantOrgIdInvariant";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync"),
	),
);
const count = internal.migrations.tenantOrgIdInvariant.count;
type CountResult = FunctionReturnType<typeof count>;

const ACME = { slug: "acme-hr", id: "org_ACME1" };
const GHOST = "ghost-org";
const NOT_FILLED = "not-filled-yet";

const DERIVED = deriveTenantTables(
	schema.tables as unknown as Parameters<typeof deriveTenantTables>[0],
);

const createT = () => convexTest(undefined, modules);
type T = ReturnType<typeof createT>;
type Db = {
	insert: (table: string, doc: Record<string, unknown>) => Promise<unknown>;
	query: (table: string) => { collect(): Promise<unknown[]> };
};

async function seedMappings(t: T) {
	await t.run(async (ctx) => {
		const db = ctx.db as unknown as Db;
		const base = {
			allowedOrchestrators: ["seat-x"],
			scopes: ["view-own-tasks"],
			isActive: true,
			createdAt: 1,
		};
		await db.insert("client_org_mapping", {
			...base,
			clerkOrgSlug: ACME.slug,
			clerkOrgId: ACME.id,
			displayName: ACME.slug,
		});
		// A mapping whose id is not filled yet: its rows are slug-only, not resolvable.
		await db.insert("client_org_mapping", {
			...base,
			clerkOrgSlug: NOT_FILLED,
			displayName: NOT_FILLED,
		});
	});
}

// Per table, 6 rows. With both columns: 1 stamped, 3 slug-only (1 resolvable), 2
// unstamped. Without an id column: 0 stamped, 4 slug-only (1 resolvable), 2 unstamped.
// Without a slug column: 1 stamped, 0 slug-only, 5 unstamped.
async function seedTable(t: T, d: TenantTable) {
	await t.run(async (ctx) => {
		const db = ctx.db as unknown as Db;
		const slug = (s: string) => (d.slugField ? { [d.slugField]: s } : {});
		const id = (s: string) => (d.idField ? { [d.idField]: s } : {});
		await db.insert(d.table, { ...slug(ACME.slug), ...id(ACME.id) });
		await db.insert(d.table, slug(ACME.slug));
		await db.insert(d.table, slug(GHOST));
		await db.insert(d.table, slug(NOT_FILLED));
		await db.insert(d.table, {});
		await db.insert(d.table, slug(""));
	});
}

// client_org_mapping IS the table the resolver reads: it holds the two seeded mappings
// (one stamped, one slug-only whose own mapping has no id: not resolvable) and nothing
// else, because inserting more rows would change what the resolver sees.
const MAPPING = "client_org_mapping";
const MAPPING_EXPECTED = {
	examined: 2,
	stamped: 1,
	slugOnly: 1,
	unstamped: 0,
	resolvable: 0,
};
const SEEDABLE = DERIVED.filter((d) => d.table !== MAPPING);

function expected(d: TenantTable) {
	if (d.table === MAPPING) return MAPPING_EXPECTED;
	const slugBearing = d.slugField !== null ? 4 : 0;
	const stamped = d.idField !== null ? 1 : 0;
	// row 1 (slug + id) is stamped when an id column exists; slug-only otherwise.
	const slugOnly =
		d.slugField === null
			? 0
			: d.idField !== null
				? slugBearing - 1
				: slugBearing;
	// rows 1 and 2 carry the resolvable slug; row 1 is stamped when an id column exists.
	const resolvable = d.slugField === null ? 0 : d.idField !== null ? 1 : 2;
	return {
		examined: 6,
		stamped,
		slugOnly,
		unstamped: 6 - stamped - slugOnly,
		resolvable,
	};
}

async function snapshot(t: T): Promise<string> {
	return await t.run(async (ctx) => {
		const out: Record<string, unknown[]> = {};
		for (const table of [
			...DERIVED.map((d) => d.table),
			"client_org_mapping",
		]) {
			out[table] = await (ctx.db as unknown as Db).query(table).collect();
		}
		return JSON.stringify(out);
	});
}

async function walk(t: T, table: string, limit?: number) {
	const sum = {
		examined: 0,
		stamped: 0,
		slugOnly: 0,
		unstamped: 0,
		resolvable: 0,
	};
	let cursor: string | null = null;
	let pages = 0;
	for (;;) {
		if (++pages > 50) throw new Error("walk did not terminate");
		const r: CountResult = await t.query(count, { table, cursor, limit });
		expect(r.tables).toHaveLength(1);
		const e = r.tables[0];
		for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += e[k];
		if (e.done) return { sum, pages };
		cursor = e.cursor;
	}
}

// The schema, read as TEXT, by a deliberately different method from the module's (which
// reads the runtime validator): table = a `\t<name>: defineTable(` line, its top-level
// fields = lines at exactly two tabs `\t\t<field>:`, kind string = the line holds
// `v.string()` and not a union/id.
function declaredBySourceText(): (TenantTable & { indirect: boolean })[] {
	const lines = readFileSync(
		new URL("../schema.ts", import.meta.url),
		"utf8",
	).split("\n");
	const tables: {
		table: string;
		fields: Map<string, boolean>;
		indirect: boolean;
	}[] = [];
	for (const line of lines) {
		const head = /^\t(\w+): defineTable\((.?)/.exec(line);
		if (head) {
			// `defineTable({` is an inline literal; `defineTable(someFields)` is not.
			tables.push({
				table: head[1],
				fields: new Map(),
				indirect: head[2] !== "{",
			});
			continue;
		}
		if (tables.length === 0) continue;
		const cur = tables[tables.length - 1];
		if (/^\t\t\.\.\./.test(line)) cur.indirect = true;
		const field = /^\t\t(\w+): (.*)$/.exec(line);
		if (field) {
			const kind = field[2].replace(/,\s*(\/\/.*)?$/, "").trim();
			cur.fields.set(
				field[1],
				kind === "v.string()" || kind === "v.optional(v.string())",
			);
		}
	}
	const pick = (f: Map<string, boolean>, cands: readonly string[]) =>
		cands.find((c) => f.get(c) === true) ?? null;
	return tables.map((t) => ({
		table: t.table,
		slugField: pick(t.fields, SLUG_COLUMN_CANDIDATES),
		idField: pick(t.fields, ID_COLUMN_CANDIDATES),
		indirect: t.indirect,
	}));
}

describe("tenantOrgIdInvariant:count", () => {
	test("DERIVED SET equals what schema.ts declares (read from its source text)", () => {
		const source = readFileSync(
			new URL("../schema.ts", import.meta.url),
			"utf8",
		);
		const tableLines = source.match(/^\t\w+: defineTable\(/gm) ?? [];
		expect(tableLines.length).toBe(Object.keys(schema.tables).length);
		expect(DERIVED.length).toBeGreaterThan(20);
		const text = declaredBySourceText();
		// Every table whose fields are an inline literal: the source text and the derived
		// set agree EXACTLY (present with the same columns, or absent from both).
		for (const t of text.filter((x) => !x.indirect)) {
			const d = DERIVED.find((x) => x.table === t.table);
			const scoped = t.slugField !== null || t.idField !== null;
			expect(d ?? null, t.table).toEqual(
				scoped
					? { table: t.table, slugField: t.slugField, idField: t.idField }
					: null,
			);
		}
		// Tables whose fields come from an imported object or a spread are visible only to
		// the validator: they may be derived, and must be for the ones the schema names.
		const indirect = new Set(
			text.filter((x) => x.indirect).map((x) => x.table),
		);
		for (const d of DERIVED) {
			expect(
				text.map((x) => x.table),
				d.table,
			).toContain(d.table);
		}
		for (const name of ["debateTemplates", "debateSettings", "debateRooms"]) {
			expect(indirect.has(name), name).toBe(true);
			expect(
				DERIVED.map((d) => d.table),
				name,
			).toContain(name);
		}
	});

	test("every table the typed ORG_COLUMNS list names is derived, with the same columns", () => {
		for (const [table, c] of Object.entries(ORG_COLUMNS)) {
			const d = DERIVED.find((x) => x.table === table);
			expect(d, table).toBeDefined();
			expect({ slug: d?.slugField, id: d?.idField }, table).toEqual({
				slug: c.slugField,
				id: c.idField,
			});
		}
		// and the derivation reaches tables that list does not: that is its purpose.
		const beyond = DERIVED.filter((d) => !(d.table in ORG_COLUMNS)).map(
			(d) => d.table,
		);
		expect(beyond).toEqual(
			expect.arrayContaining(["githubOwnerBindings", "memories"]),
		);
	});

	test("an EMPTY derived set refuses (no tenant table, no table with an object validator)", () => {
		expect(() => deriveTenantTables({})).toThrow(/no tenant-scoped table/);
		expect(() =>
			deriveTenantTables({
				plain: {
					validator: { kind: "object", fields: { name: { kind: "string" } } },
				},
				union: { validator: { kind: "union" } },
			}),
		).toThrow(/no tenant-scoped table/);
	});

	test("a column named like a slug but not a string is not read as one", () => {
		const r = deriveTenantTables({
			a: {
				validator: {
					kind: "object",
					fields: { orgSlug: { kind: "union" }, orgId: { kind: "string" } },
				},
			},
		});
		expect(r).toEqual([{ table: "a", slugField: "orgId", idField: null }]);
	});

	for (const d of DERIVED) {
		test(`${d.table} (${d.slugField ?? "-"}/${d.idField ?? "-"}): stamped / slugOnly / unstamped / resolvable counted right`, async () => {
			const t = createT();
			await seedMappings(t);
			if (d.table !== MAPPING) await seedTable(t, d);
			const { sum } = await walk(t, d.table);
			expect(sum).toEqual(expected(d));
			expect(sum.stamped + sum.slugOnly + sum.unstamped).toBe(sum.examined);
		});
	}

	test("WRITES NOTHING: every row of every table is byte-identical after counting all", async () => {
		const t = createT();
		await seedMappings(t);
		for (const d of SEEDABLE) await seedTable(t, d);
		const before = await snapshot(t);
		expect(before.length).toBeGreaterThan(1000);
		const all = await t.query(count, {});
		expect(all.tables.map((e) => e.table)).toEqual(DERIVED.map((d) => d.table));
		for (const e of all.tables) {
			const d = DERIVED.find((x) => x.table === e.table) as TenantTable;
			expect(e).toMatchObject(expected(d));
		}
		for (const d of DERIVED) await walk(t, d.table, 2);
		expect(await snapshot(t)).toBe(before);
	});

	test("PAGING sums to the whole: limit 2 gives three pages, same totals", async () => {
		const t = createT();
		await seedMappings(t);
		const d = DERIVED.find((x) => x.table === "missions") as TenantTable;
		await seedTable(t, d);
		const { sum, pages } = await walk(t, "missions", 2);
		expect(pages).toBeGreaterThanOrEqual(3);
		expect(sum).toEqual(expected(d));
	});

	test("NO ID AND NO SLUG leaves the output", async () => {
		const t = createT();
		await seedMappings(t);
		for (const d of SEEDABLE) await seedTable(t, d);
		const ids = (await t.run(
			async (ctx) =>
				(await (ctx.db as unknown as Db).query("missions").collect()) as {
					_id: string;
				}[],
		)) as { _id: string }[];
		const pages = [
			await t.query(count, {}),
			await t.query(count, { table: "missions", limit: 2 }),
		];
		// The paging cursor is the platform's opaque position token (convex-test prints it
		// readably and it names the last row there); it is the one field that is not a
		// count, so it is asserted to be a string or null and set aside.
		const json = JSON.stringify(
			pages.map((p) =>
				p.tables.map(({ cursor, ...rest }) => {
					expect(cursor === null || typeof cursor === "string").toBe(true);
					return rest;
				}),
			),
		);
		for (const row of ids) expect(json).not.toContain(row._id);
		for (const secret of [ACME.slug, ACME.id, GHOST, NOT_FILLED]) {
			expect(json).not.toContain(secret);
		}
		expect(json).not.toContain("org_ACME");
		expect(json).not.toMatch(/\b[a-z0-9]{32}\b/);
	});

	test("REFUSES a cursor without a table, an unknown table and an out-of-range limit", async () => {
		const t = createT();
		await seedMappings(t);
		await expect(t.query(count, { cursor: "abc" })).rejects.toThrow(
			/belongs to one table/,
		);
		await expect(t.query(count, { table: "profiles" })).rejects.toThrow(
			/not a tenant-scoped table/,
		);
		await expect(
			t.query(count, { table: "missions", limit: 0 }),
		).rejects.toThrow(/out of expected range/);
		await expect(
			t.query(count, { table: "missions", limit: 501 }),
		).rejects.toThrow(/out of expected range/);
	});
});
