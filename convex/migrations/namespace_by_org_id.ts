// allow-missing-refs: new file this agent creates
//
// namespace_by_org_id — moves every stored team namespace from `team/<orgSlug>` to
// `team/<clerkOrgId>` (task k1709kfcggpbqw6vc6x33nsadn8g3sfj). A namespace names an
// organisation by its permanent Clerk org ID; a slug is a renamable label, so a slug
// rename must not strand a namespace and a reused slug must not re-point one to
// another organisation. The readers (isNamespaceAllowedForScope and the callers that
// share it) already compare by ID; this migration rewrites the data they read.
//
// WHAT IT WALKS (the tables that store a team namespace string):
//   memories              `namespace`                              -> every row
//   oauth_access_tokens   `namespaceReadPrefixes` / `...WritePrefixes` (arrays)
//   oauth_scope_profiles  `namespaceReadPrefixes` / `...WritePrefixes` (arrays)
// Not walked, on purpose: `oauth_audit_log` (history, never read for a decision) and
// `okfDurableExportProgress` (a transient job row, restarted rather than rewritten).
//
// SOURCE OF TRUTH. `client_org_mapping`, through the SAME slug->ID derivation the
// org-ID backfill uses (`resolveSlug` over @vantageos/cloud-identity's
// `resolveOrgIdForLabelBackfillOnly`). No identity rule is written here and nothing is
// resolved externally. A segment that is already a mapped org ID is left alone.
//
// NEVER GUESSES. A row is rewritten only when EVERY team namespace it carries resolves.
// A segment that names no mapping row, more than one, or a mapping with no ID filled
// in is REFUSED: the row is not written at all (no half-rewritten array) and is LISTED
// by id with its segment and reason. Re-run after fixing the mapping.
//
// SHAPE. Caller-walked, cursor-paginated, one page of one table per execution (R-31:
// bounded reads AND writes). DRY RUN BY DEFAULT. A rewritten memory moves later in the
// namespace index, so a multi-page walk may meet it again and count it `alreadyById`;
// no row is skipped, and the count is a floor. Idempotent: a row already on the ID
// form is counted `alreadyById` and never written, so a second run writes nothing.
//
// RAG. A memory's search entry lives under its namespace in the RAG component, so a
// moved memory is re-indexed under the new namespace (`ragSync.addRagEntry`,
// idempotent on key = memoryId). `reindexRag: false` skips that for a caller that
// re-indexes in bulk afterwards. The superseded entry under the old namespace is not
// deleted here: it is reachable only by the fleet master, and no member can name it.
//
//   npx convex run migrations/namespace_by_org_id:inventory '{"table":"memories"}'
//        pre-state: the slug -> clerkOrgId map and, per team segment, the row count.
//   npx convex run migrations/namespace_by_org_id:run '{"table":"memories"}'
//        dry run (counts + refused rows). Add "dryRun": false to write.
//   -> repeat with {"cursor": <nextCursor>} until isDone, then continue with
//      `nextTable`, until nextTable is null.
//   npx convex run migrations/namespace_by_org_id:readBack '{"table":"memories"}'
//        walks the same way and reports how many team namespaces remain on a slug or
//        unmapped; the migration is finished when every page reports zero.
//
// Internal: reachable only with the deployment admin credential, so no per-caller
// auth check exists here by design.

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { teamNamespaceOf } from "../lib/teamNamespace";
import {
	indexBySlug,
	loadMappingRows,
	type MappingRow,
	type Reason,
	resolveSlug,
} from "./backfill_org_clerk_id";

type Column =
	| { kind: "string"; fields: readonly ["namespace"] }
	| {
			kind: "array";
			fields: readonly ["namespaceReadPrefixes", "namespaceWritePrefixes"];
	  };

export const NAMESPACE_COLUMNS = {
	memories: { kind: "string", fields: ["namespace"] },
	oauth_access_tokens: {
		kind: "array",
		fields: ["namespaceReadPrefixes", "namespaceWritePrefixes"],
	},
	oauth_scope_profiles: {
		kind: "array",
		fields: ["namespaceReadPrefixes", "namespaceWritePrefixes"],
	},
} as const satisfies Record<string, Column>;

export type NamespaceTable = keyof typeof NAMESPACE_COLUMNS;
export const TABLE_ORDER = Object.keys(NAMESPACE_COLUMNS) as NamespaceTable[];

const tableValidator = v.union(
	v.literal("memories"),
	v.literal("oauth_access_tokens"),
	v.literal("oauth_scope_profiles"),
);

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

// ── classification of ONE namespace string ───────────────────────────────────

type Classified =
	| { kind: "notTeam" }
	| { kind: "alreadyById"; segment: string }
	| { kind: "rewrite"; segment: string; clerkOrgId: string; next: string }
	| { kind: "unmapped"; segment: string; reason: Reason };

async function classify(
	namespace: string,
	bySlug: Map<string, MappingRow[]>,
	knownIds: Set<string>,
): Promise<Classified> {
	const parts = namespace.split("/");
	if (parts[0] !== "team" || parts.length < 2) return { kind: "notTeam" };
	const segment = parts[1] ?? "";
	if (segment === "") {
		return { kind: "unmapped", segment, reason: "orgUnmapped" };
	}
	if (knownIds.has(segment)) return { kind: "alreadyById", segment };
	const resolution = await resolveSlug(bySlug, segment);
	if (resolution.kind === "undecidable") {
		return { kind: "unmapped", segment, reason: resolution.reason };
	}
	const next = [teamNamespaceOf(resolution.clerkOrgId), ...parts.slice(2)].join(
		"/",
	);
	return { kind: "rewrite", segment, clerkOrgId: resolution.clerkOrgId, next };
}

// ── one page of one table, classified (shared by inventory, run and readBack) ──

type PageRow = { _id: string } & Record<string, unknown>;

type RowPlan = {
	id: string;
	// field -> the value to write, present only when the row is to be rewritten.
	patch: Record<string, string | string[]> | null;
	// Distinct team segments this row carries, with their classification.
	segments: Map<string, Classified>;
	unmapped: { segment: string; reason: Reason }[];
	rewrites: boolean;
	onlyById: boolean;
	carriesTeam: boolean;
};

async function planRow(
	table: NamespaceTable,
	row: PageRow,
	bySlug: Map<string, MappingRow[]>,
	knownIds: Set<string>,
): Promise<RowPlan> {
	const column: Column = NAMESPACE_COLUMNS[table];
	const segments = new Map<string, Classified>();
	const unmapped: { segment: string; reason: Reason }[] = [];
	const patch: Record<string, string | string[]> = {};
	let rewrites = false;
	let carriesTeam = false;

	const visit = async (value: string): Promise<string> => {
		const c = await classify(value, bySlug, knownIds);
		if (c.kind === "notTeam") return value;
		carriesTeam = true;
		if (!segments.has(c.segment)) segments.set(c.segment, c);
		if (c.kind === "unmapped") {
			unmapped.push({ segment: c.segment, reason: c.reason });
			return value;
		}
		if (c.kind === "rewrite") {
			rewrites = true;
			return c.next;
		}
		return value;
	};

	if (column.kind === "string") {
		const field = column.fields[0];
		const current = row[field];
		if (typeof current === "string") {
			const next = await visit(current);
			if (next !== current) patch[field] = next;
		}
	} else {
		for (const field of column.fields) {
			const current = row[field];
			if (!Array.isArray(current)) continue;
			const next: string[] = [];
			let changed = false;
			for (const item of current) {
				if (typeof item !== "string") {
					next.push(item as never);
					continue;
				}
				const out = await visit(item);
				if (out !== item) changed = true;
				next.push(out);
			}
			if (changed) patch[field] = next;
		}
	}

	return {
		id: row._id,
		// A row with any refused namespace is not written at all.
		patch: unmapped.length === 0 && rewrites ? patch : null,
		segments,
		unmapped,
		rewrites,
		onlyById: carriesTeam && !rewrites && unmapped.length === 0,
		carriesTeam,
	};
}

async function readPage(
	db: DatabaseReader,
	table: NamespaceTable,
	cursor: string | null,
	pageSize: number,
) {
	const paginationOpts = { cursor, numItems: pageSize };
	if (table === "memories") {
		// Only team namespaces matter: the index range `team/` .. `team0` (the next
		// character after `/`) holds every `team/...` string and nothing else.
		return await db
			.query("memories")
			.withIndex("by_namespace", (q) =>
				q.gte("namespace", "team/").lt("namespace", "team0"),
			)
			.paginate(paginationOpts);
	}
	return await db.query(table).paginate(paginationOpts);
}

function checkPageSize(args: { pageSize?: number }): number {
	const pageSize = args.pageSize ?? DEFAULT_PAGE_SIZE;
	if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
		throw new ConvexError(
			`namespace_by_org_id: pageSize = ${pageSize} is out of expected range 1-${MAX_PAGE_SIZE}.`,
		);
	}
	return pageSize;
}

async function scanPage(
	db: DatabaseReader,
	table: NamespaceTable,
	cursor: string | null,
	pageSize: number,
) {
	const mappingRows = await loadMappingRows(db);
	const bySlug = indexBySlug(mappingRows);
	const knownIds = new Set<string>();
	for (const m of mappingRows) {
		if (m.clerkOrgId !== undefined) knownIds.add(m.clerkOrgId);
	}
	const page = await readPage(db, table, cursor, pageSize);
	const plans: RowPlan[] = [];
	for (const row of page.page as unknown as PageRow[]) {
		plans.push(await planRow(table, row, bySlug, knownIds));
	}
	const idx = TABLE_ORDER.indexOf(table);
	return {
		mappingRows,
		plans,
		isDone: page.isDone,
		nextCursor: page.isDone ? null : page.continueCursor,
		nextTable: page.isDone ? (TABLE_ORDER[idx + 1] ?? null) : table,
	};
}

// ── validators ───────────────────────────────────────────────────────────────

const pageEnd = {
	isDone: v.boolean(),
	nextCursor: v.union(v.string(), v.null()),
	nextTable: v.union(tableValidator, v.null()),
};

const unmappedRowValidator = v.object({
	id: v.string(),
	segment: v.string(),
	reason: v.string(),
});

// ── inventory: the pre-state, read before any write ───────────────────────────

export const inventory = internalQuery({
	args: {
		table: tableValidator,
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
	},
	returns: v.object({
		table: tableValidator,
		// The slug -> clerkOrgId map the rewrite will use (null: ID not filled in).
		slugToClerkOrgId: v.array(
			v.object({
				slug: v.string(),
				clerkOrgId: v.union(v.string(), v.null()),
				isActive: v.boolean(),
			}),
		),
		examined: v.number(),
		rowsOnTeamNamespace: v.number(),
		// Per distinct team segment found on this page: its form and its row count.
		bySegment: v.array(
			v.object({
				segment: v.string(),
				form: v.union(
					v.literal("slug"),
					v.literal("id"),
					v.literal("unmapped"),
				),
				clerkOrgId: v.union(v.string(), v.null()),
				rows: v.number(),
			}),
		),
		unmappedRows: v.array(unmappedRowValidator),
		...pageEnd,
	}),
	handler: async (ctx, args) => {
		const pageSize = checkPageSize(args);
		const scan = await scanPage(
			ctx.db,
			args.table,
			args.cursor ?? null,
			pageSize,
		);
		const counts = new Map<
			string,
			{
				form: "slug" | "id" | "unmapped";
				clerkOrgId: string | null;
				rows: number;
			}
		>();
		const unmappedRows: { id: string; segment: string; reason: string }[] = [];
		let rowsOnTeamNamespace = 0;
		for (const plan of scan.plans) {
			if (plan.carriesTeam) rowsOnTeamNamespace++;
			for (const [segment, c] of plan.segments) {
				const entry = counts.get(segment) ?? {
					form:
						c.kind === "rewrite"
							? ("slug" as const)
							: c.kind === "alreadyById"
								? ("id" as const)
								: ("unmapped" as const),
					clerkOrgId: c.kind === "rewrite" ? c.clerkOrgId : null,
					rows: 0,
				};
				entry.rows++;
				counts.set(segment, entry);
			}
			for (const u of plan.unmapped) {
				unmappedRows.push({
					id: plan.id,
					segment: u.segment,
					reason: u.reason,
				});
			}
		}
		return {
			table: args.table,
			slugToClerkOrgId: scan.mappingRows.map((m) => ({
				slug: m.clerkOrgSlug,
				clerkOrgId: m.clerkOrgId ?? null,
				isActive: m.isActive,
			})),
			examined: scan.plans.length,
			rowsOnTeamNamespace,
			bySegment: [...counts.entries()].map(([segment, e]) => ({
				segment,
				...e,
			})),
			unmappedRows,
			isDone: scan.isDone,
			nextCursor: scan.nextCursor,
			nextTable: scan.nextTable,
		};
	},
});

// ── run: dry run by default, writes with dryRun:false ─────────────────────────

export const run = internalMutation({
	args: {
		table: tableValidator,
		dryRun: v.optional(v.boolean()),
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
		reindexRag: v.optional(v.boolean()),
	},
	returns: v.object({
		table: tableValidator,
		dryRun: v.boolean(),
		examined: v.number(),
		alreadyById: v.number(),
		toRewrite: v.number(),
		rewritten: v.number(),
		unmapped: v.number(),
		unmappedRows: v.array(unmappedRowValidator),
		ragReindexScheduled: v.number(),
		...pageEnd,
	}),
	handler: async (ctx, args) => {
		const dryRun = args.dryRun !== false;
		const pageSize = checkPageSize(args);
		const scan = await scanPage(
			ctx.db,
			args.table,
			args.cursor ?? null,
			pageSize,
		);

		let alreadyById = 0;
		let toRewrite = 0;
		let rewritten = 0;
		let ragReindexScheduled = 0;
		const unmappedRows: { id: string; segment: string; reason: string }[] = [];

		for (const plan of scan.plans) {
			if (plan.unmapped.length > 0) {
				for (const u of plan.unmapped) {
					unmappedRows.push({
						id: plan.id,
						segment: u.segment,
						reason: u.reason,
					});
				}
				continue;
			}
			if (plan.patch === null) {
				if (plan.onlyById) alreadyById++;
				continue;
			}
			toRewrite++;
			if (dryRun) continue;
			await ctx.db.patch(args.table, plan.id as never, plan.patch as never);
			rewritten++;
			if (args.table === "memories" && args.reindexRag !== false) {
				const doc = await ctx.db.get(plan.id as Id<"memories">);
				if (doc !== null) {
					const payload = {
						memoryId: doc._id,
						content: doc.content,
						namespace: doc.namespace,
						type: doc.type,
					};
					if (doc.isLatest) {
						await ctx.scheduler.runAfter(
							0,
							internal.ragSync.addRagEntry,
							payload,
						);
					} else {
						await ctx.scheduler.runAfter(
							0,
							internal.ragSync.markRagEntrySuperseded,
							payload,
						);
					}
					ragReindexScheduled++;
				}
			}
		}

		return {
			table: args.table,
			dryRun,
			examined: scan.plans.length,
			alreadyById,
			toRewrite,
			rewritten,
			unmapped: unmappedRows.length,
			unmappedRows,
			ragReindexScheduled,
			isDone: scan.isDone,
			nextCursor: scan.nextCursor,
			nextTable: scan.nextTable,
		};
	},
});

// ── readBack: what is still not on the ID form ────────────────────────────────

export const readBack = internalQuery({
	args: {
		table: tableValidator,
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
	},
	returns: v.object({
		table: tableValidator,
		examined: v.number(),
		onIdForm: v.number(),
		remainingOnSlug: v.number(),
		unmapped: v.number(),
		unmappedRows: v.array(unmappedRowValidator),
		// True when this page holds nothing left to migrate and nothing refused.
		clean: v.boolean(),
		...pageEnd,
	}),
	handler: async (ctx, args) => {
		const pageSize = checkPageSize(args);
		const scan = await scanPage(
			ctx.db,
			args.table,
			args.cursor ?? null,
			pageSize,
		);
		let onIdForm = 0;
		let remainingOnSlug = 0;
		const unmappedRows: { id: string; segment: string; reason: string }[] = [];
		for (const plan of scan.plans) {
			if (plan.unmapped.length > 0) {
				for (const u of plan.unmapped) {
					unmappedRows.push({
						id: plan.id,
						segment: u.segment,
						reason: u.reason,
					});
				}
			} else if (plan.rewrites) {
				remainingOnSlug++;
			} else if (plan.onlyById) {
				onIdForm++;
			}
		}
		return {
			table: args.table,
			examined: scan.plans.length,
			onIdForm,
			remainingOnSlug,
			unmapped: unmappedRows.length,
			unmappedRows,
			clean: remainingOnSlug === 0 && unmappedRows.length === 0,
			isDone: scan.isDone,
			nextCursor: scan.nextCursor,
			nextTable: scan.nextTable,
		};
	},
});
