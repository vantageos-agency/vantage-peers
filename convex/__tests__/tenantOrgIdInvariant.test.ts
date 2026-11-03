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
//   7. it covers every table the typed ORG_COLUMNS list names, with the same columns;
//   8. `table` is REQUIRED (one paginate per query): a call without it is refused, typed;
//   9. unstamped rows are split fleet / client / unknown by author, for every table that
//      names an author field (fleet-agent row, client-seat row, person row, author-less
//      row), through the token / receipt / profile chains, ID over label, ambiguous label;
//  10. every refusal kind of the guarded resolver is counted, and resolvable + refusals
//      = slugOnly;
//  11. AUTHOR_FIELDS names every derived table and only columns the schema declares.
// Rows are inserted WITHOUT the schema (convexTest with no schema): `count` reads only the
// slug column, the id column and `_creationTime`. Fictitious identifiers only. Hermetic.

import { readFileSync } from "node:fs";
import type { FunctionReturnType } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { ORG_COLUMNS } from "../migrations/backfill_org_clerk_id";
import {
	AUTHOR_FIELDS,
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
// unstamped. Without an id column: 0 stamped, 4 slug-only (2 resolvable), 2 unstamped.
// Without a slug column: 1 stamped, 0 slug-only, 5 unstamped. The unstamped rows carry NO
// author, so they are `unknown` and the author lookups are never reached.
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

type Shape = {
	examined: number;
	stamped: number;
	slugOnly: number;
	unstamped: { fleet: number; client: number; unknown: number };
	resolvable: number;
	refusals: Record<string, number>;
};
const NO_REFUSALS = {
	orgUnmapped: 0,
	ambiguousMapping: 0,
	mappingHasNoClerkId: 0,
	mappingRecordInvalid: 0,
	inactiveMapping: 0,
	mappingNewerThanRow: 0,
};
const emptyShape = (): Shape => ({
	examined: 0,
	stamped: 0,
	slugOnly: 0,
	unstamped: { fleet: 0, client: 0, unknown: 0 },
	resolvable: 0,
	refusals: { ...NO_REFUSALS },
});

const MAPPING_EXPECTED: Shape = {
	examined: 2,
	stamped: 1,
	slugOnly: 1,
	unstamped: { fleet: 0, client: 0, unknown: 0 },
	resolvable: 0,
	refusals: { ...NO_REFUSALS, mappingHasNoClerkId: 1 },
};
const SEEDABLE = DERIVED.filter((d) => d.table !== MAPPING);

function expected(d: TenantTable): Shape {
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
	const refused = d.slugField === null ? 0 : 1;
	return {
		examined: 6,
		stamped,
		slugOnly,
		unstamped: { fleet: 0, client: 0, unknown: 6 - stamped - slugOnly },
		resolvable,
		refusals: {
			...NO_REFUSALS,
			orgUnmapped: refused,
			mappingHasNoClerkId: refused,
		},
	};
}

async function snapshot(t: T): Promise<string> {
	return await t.run(async (ctx) => {
		const out: Record<string, unknown[]> = {};
		for (const table of [
			...DERIVED.map((d) => d.table),
			"client_org_mapping",
			"agents",
		]) {
			out[table] = await (ctx.db as unknown as Db).query(table).collect();
		}
		return JSON.stringify(out);
	});
}

function addInto(sum: Shape, e: Shape) {
	sum.examined += e.examined;
	sum.stamped += e.stamped;
	sum.slugOnly += e.slugOnly;
	sum.resolvable += e.resolvable;
	for (const k of ["fleet", "client", "unknown"] as const) {
		sum.unstamped[k] += e.unstamped[k];
	}
	for (const k of Object.keys(NO_REFUSALS)) sum.refusals[k] += e.refusals[k];
}

async function walk(t: T, table: string, limit?: number) {
	const sum = emptyShape();
	let cursor: string | null = null;
	let pages = 0;
	for (;;) {
		if (++pages > 50) throw new Error("walk did not terminate");
		const r: CountResult = await t.query(count, { table, cursor, limit });
		expect(r.tables).toHaveLength(1);
		const e = r.tables[0];
		addInto(sum, e);
		if (e.done) return { sum, pages };
		cursor = e.cursor;
	}
}

// ── the author world ─────────────────────────────────────────────────────────
// An operator org (one active `orgKind: "operator"` mapping), one agent in it ("Pi"), one
// agent in the client org ("nadia"), a label carried by BOTH ("twin"), and an agent row
// with no permanent org id ("legacy"). Fictitious names.
const OP = { slug: "fleet-op", id: "org_OP1" };
type World = {
	fleetAgent: string;
	seatAgent: string;
};

async function seedWorld(t: T): Promise<World> {
	return await t.run(async (ctx) => {
		const db = ctx.db as unknown as Db;
		const mapping = (extra: Record<string, unknown>) => ({
			allowedOrchestrators: [],
			scopes: ["view-own-tasks"],
			isActive: true,
			createdAt: 1,
			...extra,
		});
		await db.insert(
			"client_org_mapping",
			mapping({
				clerkOrgSlug: OP.slug,
				clerkOrgId: OP.id,
				displayName: OP.slug,
				orgKind: "operator",
				allowedOrchestrators: ["*"],
			}),
		);
		await db.insert(
			"client_org_mapping",
			mapping({
				clerkOrgSlug: ACME.slug,
				clerkOrgId: ACME.id,
				displayName: ACME.slug,
				allowedOrchestrators: ["seat-x"],
			}),
		);
		// an agent with no permanent org id names no org by ID
		await db.insert("agents", {
			orgSlug: OP.slug,
			name: "legacy",
			isActive: true,
			createdAt: 1,
		});
		const agent = (
			name: string,
			org: { slug: string; id: string },
		): Promise<unknown> =>
			db.insert("agents", {
				orgSlug: org.slug,
				clerkOrgId: org.id,
				name,
				isActive: true,
				createdAt: 1,
			});
		const fleetAgent = await agent("Pi", OP);
		const seatAgent = await agent("nadia", ACME);
		await agent("twin", OP);
		await agent("twin", ACME);
		return { fleetAgent: String(fleetAgent), seatAgent: String(seatAgent) };
	});
}

const insertInto = (t: T, table: string, rows: Record<string, unknown>[]) =>
	t.run(async (ctx) => {
		const db = ctx.db as unknown as Db;
		const ids: string[] = [];
		for (const r of rows) ids.push(String(await db.insert(table, r)));
		return ids;
	});

// Columns whose value is a Clerk subject (a person), not an agent ID or a label.
const PERSON_COLUMNS = new Set([
	"boundBy",
	"clerkUserId",
	"userId",
	"grantedBy",
]);
const PLAIN_AUTHOR_TABLES = Object.entries(AUTHOR_FIELDS).filter(
	([, spec]) => spec.via === undefined && spec.fields.length > 0,
);

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
			const u = sum.unstamped;
			expect(sum.stamped + sum.slugOnly + u.fleet + u.client + u.unknown).toBe(
				sum.examined,
			);
			// every slug-only row is either resolvable or refused for a counted reason
			expect(
				sum.resolvable + Object.values(sum.refusals).reduce((a, b) => a + b, 0),
			).toBe(sum.slugOnly);
		});
	}

	test("AUTHOR_FIELDS names every derived table, and only columns the schema declares", () => {
		const derivedNames = DERIVED.map((d) => d.table);
		expect(Object.keys(AUTHOR_FIELDS).sort()).toEqual([...derivedNames].sort());
		const tables = schema.tables as unknown as Record<
			string,
			{ validator: { fields: Record<string, unknown> } }
		>;
		for (const [table, spec] of Object.entries(AUTHOR_FIELDS)) {
			const columnsOf = (name: string) =>
				Object.keys(tables[name].validator.fields);
			const home = spec.via === "message" ? "messages" : table;
			for (const f of spec.fields) {
				expect(columnsOf(home), `${table}.${f.name}`).toContain(f.name);
			}
		}
		// the tables with no author field are the ones the header names
		expect(
			Object.entries(AUTHOR_FIELDS)
				.filter(([, spec]) => spec.fields.length === 0)
				.map(([table]) => table)
				.sort(),
		).toEqual(
			[
				"issues",
				"githubRepoMapping",
				"tool_usage",
				"kbUploads",
				"uploadTickets",
				"memberWriterRoles",
				"client_org_mapping",
				"orgMembership",
				"okfDurableExportProgress",
				"okfDurableExportEntries",
				"agents",
				"agent_relations",
			].sort(),
		);
	});

	test("tables lists the derived set with the author fields read", async () => {
		const t = createT();
		const listed = await t.query(
			internal.migrations.tenantOrgIdInvariant.tables,
			{},
		);
		expect(listed.map((e) => e.table)).toEqual(DERIVED.map((d) => d.table));
		const missions = listed.find((e) => e.table === "missions");
		expect(missions?.authorFields).toEqual(["createdById", "createdBy"]);
		expect(listed.find((e) => e.table === "issues")?.authorFields).toEqual([]);
	});

	for (const [table, spec] of PLAIN_AUTHOR_TABLES) {
		const ids = spec.fields.filter((f) => f.as === "id");
		const labels = spec.fields.filter((f) => f.as === "label");
		const personOnly =
			labels.length === 0 && ids.every((f) => PERSON_COLUMNS.has(f.name));
		test(`${table}: unstamped rows split by author (${spec.fields.map((f) => f.name).join(", ")})`, async () => {
			const t = createT();
			const w = await seedWorld(t);
			const first = spec.fields[0].name;
			const rows: Record<string, unknown>[] = [];
			const want = { fleet: 0, client: 0, unknown: 0 };
			if (!personOnly && ids.length > 0) {
				rows.push({ [ids[0].name]: w.fleetAgent }); // a fleet agent, by ID
				rows.push({ [ids[0].name]: w.seatAgent }); // a client seat, by ID
				want.fleet++;
				want.client++;
			}
			if (labels.length > 0) {
				rows.push({ [labels[0].name]: " PI " }); // a fleet label, normalised
				rows.push({ [labels[0].name]: "nadia" }); // a client label
				want.fleet++;
				want.client++;
			}
			if (PERSON_COLUMNS.has(ids[0]?.name ?? "")) {
				rows.push({ [ids[0].name]: "user_abc123" }); // a person
				want.client++;
			}
			rows.push({}); // no author at all
			rows.push({ [first]: "ghost-author" }); // an author that names nobody
			want.unknown += 2;
			await insertInto(t, table, rows);
			const { sum } = await walk(t, table);
			expect(sum.unstamped).toEqual(want);
			expect(sum.examined).toBe(rows.length);
		});
	}

	test("ID beats a disagreeing label; an ambiguous label, the wildcard, a roster name and an agent with no org id are unknown", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await insertInto(t, "tasks", [
			{ createdById: w.seatAgent, createdBy: "pi" }, // id says client, label says fleet
			{ createdById: "not-an-agent", createdBy: "pi" }, // id resolves nothing: label decides
			{ createdBy: "twin" }, // carried by both orgs
			{ createdBy: "*" }, // the wildcard names nobody
			{ createdBy: "seat-x" }, // on a client roster, but no agent row: rosters are not read
			{ createdBy: "legacy" }, // an agent row with no permanent org id
			{ createdBy: "user:abc" }, // a stable person principal in a label slot: not an agent
		]);
		const { sum } = await walk(t, "tasks");
		// rows: client, fleet, then five unknown
		expect(sum.unstamped).toEqual({ fleet: 1, client: 1, unknown: 5 });
	});

	test("messageReceipts: the author is the PARENT message's sender", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const parents = await insertInto(t, "messages", [
			{ fromId: w.fleetAgent, from: "pi" },
			{ fromId: w.seatAgent, from: "nadia" },
			{ from: "nadia" },
			{ channel: "x" },
			{ fromId: w.fleetAgent },
		]);
		await t.run(async (ctx) => {
			// the last parent is deleted: its receipt is orphaned
			await (
				ctx.db as unknown as { delete: (id: string) => Promise<void> }
			).delete(parents[4]);
		});
		await insertInto(t, "messageReceipts", [
			{ messageId: parents[0], recipient: "nadia" },
			{ messageId: parents[1], recipient: "pi" },
			{ messageId: parents[2], recipient: "pi" },
			{ messageId: parents[3], recipient: "pi" },
			{ messageId: parents[4], recipient: "pi" },
			{ recipient: "pi" },
		]);
		const { sum } = await walk(t, "messageReceipts");
		// fleet, client, client (by label), unknown (no author), unknown (orphan), unknown (none)
		expect(sum.unstamped).toEqual({ fleet: 1, client: 2, unknown: 3 });
	});

	test("oauth_access_tokens: agent, person, scope profile, subject", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await insertInto(t, "oauth_scope_profiles", [
			{ profileId: "pf-fleet", agentId: w.fleetAgent },
			{ profileId: "pf-allow", fromAllowList: ["pi"] },
			{ profileId: "pf-stamp", clerkOrgId: ACME.id },
			{ profileId: "pf-slug", clerkOrgSlug: ACME.slug },
		]);
		await insertInto(t, "oauth_access_tokens", [
			{ agentId: w.fleetAgent }, // fleet
			{ agentId: w.seatAgent }, // client
			{ principal: "person", userId: "user_p" }, // client
			{ scopeProfile: "pf-fleet" }, // fleet, via the profile's agent
			{ scopeProfile: "pf-allow" }, // unknown: a fromAllowList is a name list, not read
			{ scopeProfile: "pf-stamp" }, // client, via the profile's permanent org id
			{ scopeProfile: "pf-slug" }, // unknown: a slug stamp never matches
			{ fromAllowList: ["nadia"] }, // unknown: the token's own allow-list is not read
			{ userId: "user_q" }, // client, a Clerk subject
			{ scopeProfile: "no-such-profile" }, // unknown
			{ agentId: w.seatAgent, scopeProfile: "pf-fleet" }, // client: the agent wins
		]);
		const { sum } = await walk(t, "oauth_access_tokens");
		expect(sum.unstamped).toEqual({ fleet: 2, client: 5, unknown: 4 });
		expect(sum.examined).toBe(11);
	});

	test("oauth_refresh_tokens: the same chain", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await insertInto(t, "oauth_scope_profiles", [
			{ profileId: "pf-fleet", agentId: w.fleetAgent },
			{ profileId: "pf-stamp", clerkOrgId: OP.id },
		]);
		await insertInto(t, "oauth_refresh_tokens", [
			{ agentId: w.fleetAgent }, // fleet
			{ principal: "person" }, // client
			{ scopeProfile: "pf-fleet" }, // fleet
			{ scopeProfile: "pf-stamp" }, // fleet: the profile's permanent org id is the operator's
			{ fromAllowList: ["nadia"] }, // not a refresh-token column: unknown
			{}, // unknown
		]);
		const { sum } = await walk(t, "oauth_refresh_tokens");
		expect(sum.unstamped).toEqual({ fleet: 3, client: 1, unknown: 2 });
	});

	test("oauth_scope_profiles: by agent; a stamped profile is not unstamped; an allow-list is not read", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await insertInto(t, "oauth_scope_profiles", [
			{ profileId: "a", agentId: w.fleetAgent }, // fleet
			{ profileId: "b", agentId: w.seatAgent }, // client
			{ profileId: "c", fromAllowList: ["pi"] }, // unknown: no agentId
			{ profileId: "d", fromAllowList: ["nadia"] }, // unknown
			{ profileId: "e", agentId: "not-an-agent" }, // unknown: names nobody
			{ profileId: "f", clerkOrgId: OP.id }, // stamped
			{ profileId: "g", clerkOrgSlug: OP.slug }, // slug-only
		]);
		const { sum } = await walk(t, "oauth_scope_profiles");
		expect(sum.unstamped).toEqual({ fleet: 1, client: 1, unknown: 3 });
		expect(sum.stamped).toBe(1);
		expect(sum.slugOnly).toBe(1);
	});

	test("an unclear operator org REFUSES the split; with no author to look up it does not", async () => {
		const t = createT();
		// no operator mapping at all
		await insertInto(t, "tasks", [{ createdBy: "pi" }]);
		await expect(t.query(count, { table: "tasks" })).rejects.toThrow(
			/operator org is "none"/,
		);
		// rows with no author candidate never reach the lookup: no refusal
		const t2 = createT();
		await insertInto(t2, "tasks", [{}, { createdBy: "" }]);
		const { sum } = await walk(t2, "tasks");
		expect(sum.unstamped).toEqual({ fleet: 0, client: 0, unknown: 2 });
		// an operator mapping with no permanent id
		const t4 = createT();
		await insertInto(t4, "client_org_mapping", [
			{
				clerkOrgSlug: "op-noid",
				orgKind: "operator",
				allowedOrchestrators: [],
				scopes: ["view-own-tasks"],
				displayName: "op-noid",
				isActive: true,
				createdAt: 1,
			},
		]);
		await insertInto(t4, "tasks", [{ createdBy: "pi" }]);
		await expect(t4.query(count, { table: "tasks" })).rejects.toThrow(
			/no permanent id/,
		);
		// two operator orgs
		const t3 = createT();
		await insertInto(t3, "client_org_mapping", [
			...["a", "b"].map((k) => ({
				clerkOrgSlug: `op-${k}`,
				clerkOrgId: `org_${k.toUpperCase()}`,
				orgKind: "operator",
				allowedOrchestrators: [],
				scopes: ["view-own-tasks"],
				displayName: `op-${k}`,
				isActive: true,
				createdAt: 1,
			})),
		]);
		await insertInto(t3, "tasks", [{ createdBy: "pi" }]);
		await expect(t3.query(count, { table: "tasks" })).rejects.toThrow(
			/operator org is "many"/,
		);
	});

	test("REFUSAL REASONS: every kind the guarded resolver returns is counted", async () => {
		const t = createT();
		const m = (slug: string, extra: Record<string, unknown>) => ({
			clerkOrgSlug: slug,
			allowedOrchestrators: ["x"],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: 1,
			...extra,
		});
		// the row that predates its slug's mapping is written first, the mapping after
		await insertInto(t, "missions", [{ orgId: "late-org" }]);
		await new Promise((r) => setTimeout(r, 25));
		await insertInto(t, "client_org_mapping", [
			m("late-org", { clerkOrgId: "org_LATE" }),
			m(ACME.slug, { clerkOrgId: ACME.id }),
			m(NOT_FILLED, {}),
			m("inactive-org", { clerkOrgId: "org_IN", isActive: false }),
			m("twin-org", { clerkOrgId: "org_T1" }),
			m("twin-org", { clerkOrgId: "org_T2" }),
			m("bad-record", { clerkOrgId: "" }),
		]);
		await insertInto(t, "missions", [
			{ orgId: ACME.slug }, // resolvable
			{ orgId: GHOST }, // orgUnmapped
			{ orgId: NOT_FILLED }, // mappingHasNoClerkId
			{ orgId: "inactive-org" }, // inactiveMapping
			{ orgId: "twin-org" }, // ambiguousMapping
			{ orgId: "bad-record" }, // mappingRecordInvalid
		]);
		const { sum } = await walk(t, "missions");
		expect(sum.slugOnly).toBe(7);
		expect(sum.resolvable).toBe(1);
		expect(sum.refusals).toEqual({
			orgUnmapped: 1,
			ambiguousMapping: 1,
			mappingHasNoClerkId: 1,
			mappingRecordInvalid: 1,
			inactiveMapping: 1,
			mappingNewerThanRow: 1,
		});
		// and the identity holds, by paging as well as in one page
		const paged = await walk(t, "missions", 2);
		expect(paged.sum).toEqual(sum);
	});

	test("WRITES NOTHING: every row of every table is byte-identical after counting all, author lookups included", async () => {
		const t = createT();
		const w = await seedWorld(t);
		for (const d of SEEDABLE) {
			if (d.table === "agents") continue;
			await seedTable(t, d);
		}
		await insertInto(t, "tasks", [
			{ createdById: w.fleetAgent },
			{ createdBy: "nadia" },
		]);
		await insertInto(t, "oauth_scope_profiles", [
			{ profileId: "p9", agentId: w.seatAgent },
		]);
		await insertInto(t, "oauth_access_tokens", [{ scopeProfile: "p9" }]);
		const before = await snapshot(t);
		expect(before.length).toBeGreaterThan(1000);
		for (const d of DERIVED) {
			await walk(t, d.table);
			await walk(t, d.table, 2);
		}
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
		const w = await seedWorld(t);
		for (const d of SEEDABLE) {
			if (d.table === "agents") continue;
			await seedTable(t, d);
		}
		await insertInto(t, "missions", [{ createdById: w.fleetAgent }]);
		const ids = (await t.run(
			async (ctx) =>
				(await (ctx.db as unknown as Db).query("missions").collect()) as {
					_id: string;
				}[],
		)) as { _id: string }[];
		const pages = [
			await t.query(count, { table: "missions" }),
			await t.query(count, { table: "missions", limit: 2 }),
			await t.query(count, { table: "tasks" }),
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
		for (const secret of [
			ACME.slug,
			ACME.id,
			GHOST,
			NOT_FILLED,
			OP.slug,
			OP.id,
			w.fleetAgent,
			w.seatAgent,
		]) {
			expect(json).not.toContain(secret);
		}
		expect(json).not.toContain("org_ACME");
		expect(json).not.toMatch(/\b[a-z0-9]{32}\b/);
	});

	test("REFUSES a call without `table` (one paginate per query), an unknown table and an out-of-range limit", async () => {
		const t = createT();
		await seedMappings(t);
		await expect(t.query(count, {})).rejects.toThrow(
			/`table` is required.*one paginate per query/,
		);
		await expect(t.query(count, { cursor: "abc" })).rejects.toThrow(
			/`table` is required/,
		);
		await expect(t.query(count, { limit: 10 })).rejects.toThrow(
			/`table` is required/,
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
