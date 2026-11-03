// tenantOrgIdInvariant — READ-ONLY coverage of the permanent org ID on EVERY
// tenant-scoped table, derived from convex/schema.ts and never from a typed list.
// Pi ruling, task k1768vhaqbsf7kvtb4z8xhx6818hg19t (deliverable 1; it replaces the
// ORG_COLUMNS-based count of k1778zdhntzk53dyac8hxg71zx8hhzfx).
//
// Why. Under @vantageos/cloud-identity `sameOrg`, a row matches a tenant only when BOTH
// rows carry a `clerkOrgId` and they are equal; a row stamped only with the slug matches
// no tenant. A typed list of tables (ORG_COLUMNS) misses every table nobody added to it,
// which is how a tenant table can hold slug-only rows unseen. This instrument counts
// every table the schema itself declares as org-scoped, so a NEW tenant table is counted
// the day it is declared, with no list to edit.
//
// DERIVATION RULE (applied to the tables object of convex/schema.ts at run time, see
// `deriveTenantTables`). For each table whose top-level validator is an object:
//   idField    the first declared among `clerkOrgId`, `tenantOrgId` whose validator is a
//              string (optional or required), else null;
//   slugField  the first declared among `clerkOrgSlug`, `orgSlug`, `orgId`, `tenantId`
//              whose validator is a string (optional or required), else null. A column of
//              the same name that is a union or an id is skipped, not read as a slug;
//   the table is TENANT-SCOPED iff idField or slugField is not null.
// The set is refused (ConvexError) when it is EMPTY: an instrument that finds no tenant
// table has failed, and an empty answer must not read as "all clean".
// Columns that name an org but follow neither convention (`agentOrgId`, `fromOrgId`,
// `toOrgId`, `orgRole`) are not read: they are not the row's own tenant stamp.
//
// COUNTS PER TABLE. Rows examined; `stamped` (idField present, the same test
// backfill_org_clerk_id:run calls alreadyFilled); `slugOnly` (slug present, no id: the
// rows `sameOrg` cannot match); `unstamped` (neither); `resolvable` (slugOnly rows whose
// slug the GUARDED resolver of backfill_org_clerk_id, resolveSlugForRow, maps to exactly
// one active mapping with a clerkOrgId not newer than the row: what a backfill would fill).
// A table with no idField reports stamped 0 and every slug-bearing row as slugOnly: it has
// nowhere to hold the id, and its idField is reported null so the reader sees that.
// COUNTS ONLY: no row id, no slug, no mapping content leaves it; column names are schema
// facts, not data.
//
// SHAPE. Internal, deployment-admin only (no per-caller check by design), cursor-paginated
// and bounded: one page of one table per call with `table`, or one page of every derived
// table without it (a cursor is then refused). It writes nothing.
//
//   bash .claude/scripts/convex-prod.sh run migrations/tenantOrgIdInvariant:count '{"table":"missions"}'
//   -> repeat with {"table":..., "cursor": <cursor>} until done is true; sum the pages.
//   bash .claude/scripts/convex-prod.sh run migrations/tenantOrgIdInvariant:count '{}'
//   -> the derived table list and one page of each (read `tables[].table`).

import { ConvexError, v } from "convex/values";
import { internalQuery } from "../_generated/server";
import schema from "../schema";
import {
	indexBySlug,
	loadMappingRows,
	resolveSlugForRow,
} from "./backfill_org_clerk_id";

export const ID_COLUMN_CANDIDATES = ["clerkOrgId", "tenantOrgId"] as const;
export const SLUG_COLUMN_CANDIDATES = [
	"clerkOrgSlug",
	"orgSlug",
	"orgId",
	"tenantId",
] as const;

export type TenantTable = {
	table: string;
	slugField: string | null;
	idField: string | null;
};

// The part of a TableDefinition the rule reads.
type FieldLike = { kind: string };
type TableLike = {
	validator: { kind: string; fields?: Record<string, FieldLike> };
};

const firstStringColumn = (
	fields: Record<string, FieldLike>,
	candidates: readonly string[],
): string | null =>
	candidates.find(
		(c) => fields[c] !== undefined && fields[c].kind === "string",
	) ?? null;

/** The derivation rule of the module header. Throws on an empty result. */
export function deriveTenantTables(
	tables: Record<string, TableLike>,
): TenantTable[] {
	const out: TenantTable[] = [];
	for (const [table, def] of Object.entries(tables)) {
		const fields =
			def.validator.kind === "object" ? def.validator.fields : null;
		if (!fields) continue;
		const idField = firstStringColumn(fields, ID_COLUMN_CANDIDATES);
		const slugField = firstStringColumn(fields, SLUG_COLUMN_CANDIDATES);
		if (idField !== null || slugField !== null) {
			out.push({ table, slugField, idField });
		}
	}
	if (out.length === 0) {
		throw new ConvexError(
			"tenantOrgIdInvariant: the schema yields no tenant-scoped table; refusing to report an empty set as a clean one.",
		);
	}
	return out;
}

const SCHEMA_TABLES = schema.tables as unknown as Record<string, TableLike>;

const DEFAULT_PAGE_SIZE = 100;
const SMALL_PAGE_SIZE: Record<string, number> = {
	missions: 50,
	messages: 50,
	tasks: 50,
	memories: 50,
	briefingNotes: 20,
};
const MAX_PAGE_SIZE = 500;

const entryValidator = v.object({
	table: v.string(),
	slugField: v.union(v.string(), v.null()),
	idField: v.union(v.string(), v.null()),
	examined: v.number(),
	stamped: v.number(),
	slugOnly: v.number(),
	unstamped: v.number(),
	resolvable: v.number(),
	done: v.boolean(),
	cursor: v.union(v.string(), v.null()),
});

export const count = internalQuery({
	args: {
		table: v.optional(v.string()),
		cursor: v.optional(v.union(v.string(), v.null())),
		limit: v.optional(v.number()),
	},
	returns: v.object({ tables: v.array(entryValidator) }),
	handler: async (ctx, args) => {
		const derived = deriveTenantTables(SCHEMA_TABLES);
		if (args.table === undefined && args.cursor != null) {
			throw new ConvexError(
				"tenantOrgIdInvariant:count: a cursor belongs to one table; pass `table` with it.",
			);
		}
		if (
			args.limit !== undefined &&
			(!Number.isInteger(args.limit) ||
				args.limit < 1 ||
				args.limit > MAX_PAGE_SIZE)
		) {
			throw new ConvexError(
				`tenantOrgIdInvariant:count: limit = ${args.limit} is out of expected range 1-${MAX_PAGE_SIZE}.`,
			);
		}
		const targets =
			args.table === undefined
				? derived
				: derived.filter((d) => d.table === args.table);
		if (args.table !== undefined && targets.length === 0) {
			throw new ConvexError(
				`tenantOrgIdInvariant:count: table = ${args.table} is not a tenant-scoped table of the schema (${derived.length} derived; call without \`table\` to list them).`,
			);
		}
		const mappings = indexBySlug(await loadMappingRows(ctx.db));
		const tables = [];
		for (const { table, slugField, idField } of targets) {
			const limit = args.limit ?? SMALL_PAGE_SIZE[table] ?? DEFAULT_PAGE_SIZE;
			const page = await ctx.db
				.query(table as never)
				.paginate({ cursor: args.cursor ?? null, numItems: limit });
			let stamped = 0;
			let slugOnly = 0;
			let unstamped = 0;
			let resolvable = 0;
			for (const row of page.page as unknown as ({
				_creationTime: number;
			} & Record<string, unknown>)[]) {
				if (idField !== null && row[idField] !== undefined) {
					stamped++;
					continue;
				}
				const slug = slugField === null ? undefined : row[slugField];
				if (typeof slug !== "string" || slug === "") {
					unstamped++;
					continue;
				}
				slugOnly++;
				const resolution = await resolveSlugForRow(
					mappings,
					slug,
					row._creationTime,
				);
				if (resolution.kind === "id") resolvable++;
			}
			tables.push({
				table,
				slugField,
				idField,
				examined: stamped + slugOnly + unstamped,
				stamped,
				slugOnly,
				unstamped,
				resolvable,
				done: page.isDone,
				cursor: page.isDone ? null : page.continueCursor,
			});
		}
		return { tables };
	},
});
