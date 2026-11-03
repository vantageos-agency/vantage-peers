// The ONE place that says what a retired (erased / superseded) row is, and drops it.
//
// CLASS. A row the owner removed or replaced must not come back through any read
// path. The marker is a field on the row (isLatest=false, deletedAt set) or, for a
// RAG search hit, the same marker copied onto the entry's filterValues. Each read
// path used to re-derive the test by hand (`row.deletedAt === undefined`, an
// `.eq("isLatest", true)` in one index range, a local `isLive`), and a path that
// forgot it leaked a retired row -- recall/text_search/hybrid_search returned
// superseded memories for as long as the RAG filter was believed to select.
//
// Tables carrying an ERASURE marker are the keys of RETIREMENT below. The table
// list is checked against convex/schema.ts by
// convex/__tests__/retiredRowsConformance.test.ts: a new retirement-shaped field
// in the schema that is not classified there fails the build.

import type { Doc } from "../_generated/dataModel";

export const RETIREMENT = {
	// memories (and the episodes stored in them): superseded or soft-deleted.
	memories: {
		field: "isLatest",
		isRetired: (row: Pick<Doc<"memories">, "isLatest">): boolean =>
			row.isLatest === false,
	},
	// mission-template catalog: soft-deleted.
	missionTemplates: {
		field: "deletedAt",
		isRetired: (row: Pick<Doc<"missionTemplates">, "deletedAt">): boolean =>
			row.deletedAt !== undefined,
	},
	// organisation membership: a tombstoned row is a removed member.
	orgMembership: {
		field: "deletedAt",
		isRetired: (row: Pick<Doc<"orgMembership">, "deletedAt">): boolean =>
			row.deletedAt !== undefined,
	},
} as const;

export type RetirementTable = keyof typeof RETIREMENT;

/** True when the row has been retired (erased or superseded). */
export function isRetired<T extends RetirementTable>(
	table: T,
	row: Parameters<(typeof RETIREMENT)[T]["isRetired"]>[0],
): boolean {
	return (RETIREMENT[table].isRetired as (r: typeof row) => boolean)(row);
}

/** The rows that are NOT retired, order kept. */
export function liveOnly<
	T extends RetirementTable,
	R extends Parameters<(typeof RETIREMENT)[T]["isRetired"]>[0],
>(table: T, rows: readonly R[]): R[] {
	return rows.filter((r) => !isRetired(table, r));
}

/** A single row, or null when it is absent or retired. */
export function liveOrNull<
	T extends RetirementTable,
	R extends Parameters<(typeof RETIREMENT)[T]["isRetired"]>[0],
>(table: T, row: R | null): R | null {
	return row === null || isRetired(table, row) ? null : row;
}

/**
 * RAG level. @convex-dev/rag ORs its filters (component/embeddings/index.js:49,
 * component/search.js:129, client/index.d.ts:421), so a filter on isLatest/type
 * selects nothing: the hit's own filterValues are the only truth. A hit is live
 * when its isLatest value is exactly "true" and, when a type was asked for, its
 * type equals it.
 */
export function isLiveRagEntry(
	filterValues: ReadonlyArray<{ name: string; value: unknown }>,
	wantedType?: string,
): boolean {
	if (filterValues.find((f) => f.name === "isLatest")?.value !== "true") {
		return false;
	}
	return (
		wantedType === undefined ||
		filterValues.find((f) => f.name === "type")?.value === wantedType
	);
}
