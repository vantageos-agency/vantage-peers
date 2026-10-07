// backfill_org_clerk_id — EXPAND PHASE of the org-identity-by-ID move (Pi ruling (d),
// task k174d95s5qqy8t2r5rdrz3pr3d8fqv82): an organisation is identified by its
// permanent Clerk org id (org_...), never by its slug, which is a label and can be
// renamed. Every table that stores an org as a slug now has an OPTIONAL id column next
// to it (`clerkOrgId`, or `tenantOrgId` next to a `tenantId`). This migration fills it,
// ONCE, from the slug. After it, comparisons are by id only; the slug is display-only.
//
// SOURCE OF TRUTH. `client_org_mapping.clerkOrgId`, set per mapping by
// clientOrgMapping:setClerkOrgId (scripts/fill-mapping-clerk-org-id.mjs resolves each
// slug against the Clerk Backend API). THIS MIGRATION RESOLVES NOTHING EXTERNALLY: it
// joins a row's slug to the mapping row by `by_clerk_slug` and copies that row's id.
// The operator org is an ordinary mapping row and maps the same way.
//
// NEVER GUESSES. A row is filled only when its slug names EXACTLY ONE mapping row that
// carries a clerkOrgId. Otherwise it is left unfilled and LISTED BY ID with its reason:
//   orgUnmapped         the slug has no client_org_mapping row;
//   ambiguousMapping    the slug names more than one mapping row;
//   mappingHasNoClerkId the mapping exists but its clerkOrgId is not filled yet (run
//                       the mapping fill first).
// A row with NO slug (fleet-owned, unstamped) is counted `noSlug` and left alone:
// backfill_org_stamp decides its slug first; this migration never invents one.
//
// SHAPE. Caller-walked, cursor-paginated, one page of one table per execution (R-31:
// bounded reads AND writes), exactly like backfill_org_stamp. DRY RUN BY DEFAULT.
// Idempotent: a row that already has an id is counted `alreadyFilled` and never written.
//
//   npx convex run migrations/backfill_org_clerk_id:inventory
//   npx convex run migrations/backfill_org_clerk_id:run '{"table":"missions"}'
//   -> repeat with {"cursor": <nextCursor>} until isDone, then continue with
//      `nextTable`, until nextTable is null. Pass "dryRun": false to write.
//
// Internal: reachable only with the deployment admin credential, so no per-caller
// auth check exists here by design.

import { ConvexError, v } from "convex/values";
import type { DatabaseReader } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { findOperatorOrg } from "../lib/operatorOrg";

type Column = { slugField: string; idField: string };

// table -> the slug column it stores and the id column that sits next to it.
export const ORG_COLUMNS = {
	missions: { slugField: "orgId", idField: "clerkOrgId" },
	messages: { slugField: "tenantId", idField: "tenantOrgId" },
	tasks: { slugField: "orgId", idField: "clerkOrgId" },
	messageReceipts: { slugField: "tenantId", idField: "tenantOrgId" },
	briefingNotes: { slugField: "orgId", idField: "clerkOrgId" },
	recurringTasks: { slugField: "orgId", idField: "clerkOrgId" },
	diary: { slugField: "orgId", idField: "clerkOrgId" },
	businessUnits: { slugField: "orgId", idField: "clerkOrgId" },
	bulk_complete_runs: { slugField: "orgId", idField: "clerkOrgId" },
	agents: { slugField: "orgSlug", idField: "clerkOrgId" },
	agent_relations: { slugField: "orgSlug", idField: "clerkOrgId" },
	agent_credentials: { slugField: "orgSlug", idField: "clerkOrgId" },
	orgMembership: { slugField: "clerkOrgSlug", idField: "clerkOrgId" },
	memberWriterRoles: { slugField: "orgSlug", idField: "clerkOrgId" },
	oauth_access_tokens: { slugField: "clerkOrgSlug", idField: "clerkOrgId" },
	oauth_scope_profiles: { slugField: "clerkOrgSlug", idField: "clerkOrgId" },
	iframeEmbedSessions: { slugField: "tenantId", idField: "tenantOrgId" },
} as const satisfies Record<string, Column>;

export type OrgIdTable = keyof typeof ORG_COLUMNS;
export const TABLE_ORDER = Object.keys(ORG_COLUMNS) as OrgIdTable[];

const tableValidator = v.union(
	v.literal("missions"),
	v.literal("messages"),
	v.literal("tasks"),
	v.literal("messageReceipts"),
	v.literal("briefingNotes"),
	v.literal("recurringTasks"),
	v.literal("diary"),
	v.literal("businessUnits"),
	v.literal("bulk_complete_runs"),
	v.literal("agents"),
	v.literal("agent_relations"),
	v.literal("agent_credentials"),
	v.literal("orgMembership"),
	v.literal("memberWriterRoles"),
	v.literal("oauth_access_tokens"),
	v.literal("oauth_scope_profiles"),
	v.literal("iframeEmbedSessions"),
);

const DEFAULT_PAGE_SIZE = 100;
const SMALL_PAGE_SIZE: Partial<Record<OrgIdTable, number>> = {
	missions: 50,
	messages: 50,
	tasks: 50,
	briefingNotes: 20,
};
const MAX_PAGE_SIZE = 500;
const MAPPING_READ_CAP = 1000;

type Reason = "orgUnmapped" | "ambiguousMapping" | "mappingHasNoClerkId";

type Resolution =
	| { kind: "id"; clerkOrgId: string }
	| { kind: "undecidable"; reason: Reason };

async function loadMappings(
	db: DatabaseReader,
): Promise<Map<string, Resolution>> {
	const rows = await db.query("client_org_mapping").take(MAPPING_READ_CAP + 1);
	if (rows.length > MAPPING_READ_CAP) {
		throw new ConvexError(
			`backfill_org_clerk_id: client_org_mapping holds more than ${MAPPING_READ_CAP} rows; refusing to decide from a truncated read.`,
		);
	}
	const bySlug = new Map<string, Resolution>();
	const seen = new Set<string>();
	for (const m of rows) {
		if (seen.has(m.clerkOrgSlug)) {
			bySlug.set(m.clerkOrgSlug, {
				kind: "undecidable",
				reason: "ambiguousMapping",
			});
			continue;
		}
		seen.add(m.clerkOrgSlug);
		bySlug.set(
			m.clerkOrgSlug,
			m.clerkOrgId === undefined
				? { kind: "undecidable", reason: "mappingHasNoClerkId" }
				: { kind: "id", clerkOrgId: m.clerkOrgId },
		);
	}
	return bySlug;
}

const mappingInventoryValidator = v.object({
	clerkOrgSlug: v.string(),
	clerkOrgId: v.union(v.string(), v.null()),
	isActive: v.boolean(),
	orgKind: v.union(v.literal("operator"), v.literal("client")),
});

// The dry-run-first inventory: which mappings carry an id and which do not, the
// operator org, and every (table, slug column, id column) this migration walks.
export const inventory = internalQuery({
	args: {},
	returns: v.object({
		mappings: v.array(mappingInventoryValidator),
		mappingsWithoutClerkId: v.array(v.string()),
		operatorSlug: v.union(v.string(), v.null()),
		operatorClerkOrgId: v.union(v.string(), v.null()),
		tables: v.array(
			v.object({
				table: v.string(),
				slugField: v.string(),
				idField: v.string(),
			}),
		),
	}),
	handler: async (ctx) => {
		const rows = await ctx.db
			.query("client_org_mapping")
			.take(MAPPING_READ_CAP + 1);
		if (rows.length > MAPPING_READ_CAP) {
			throw new ConvexError(
				`backfill_org_clerk_id: client_org_mapping holds more than ${MAPPING_READ_CAP} rows; refusing to list a truncated set.`,
			);
		}
		const mappings = rows.map((m) => ({
			clerkOrgSlug: m.clerkOrgSlug,
			clerkOrgId: m.clerkOrgId ?? null,
			isActive: m.isActive,
			orgKind: m.orgKind ?? ("client" as const),
		}));
		const operator = await findOperatorOrg(ctx.db);
		const operatorSlug = operator.kind === "one" ? operator.slug : null;
		return {
			mappings,
			mappingsWithoutClerkId: mappings
				.filter((m) => m.clerkOrgId === null)
				.map((m) => m.clerkOrgSlug),
			operatorSlug,
			operatorClerkOrgId:
				mappings.find((m) => m.clerkOrgSlug === operatorSlug)?.clerkOrgId ??
				null,
			tables: TABLE_ORDER.map((table) => ({ table, ...ORG_COLUMNS[table] })),
		};
	},
});

const reasonCountsValidator = v.object({
	orgUnmapped: v.number(),
	ambiguousMapping: v.number(),
	mappingHasNoClerkId: v.number(),
});

const resultValidator = v.object({
	table: tableValidator,
	slugField: v.string(),
	idField: v.string(),
	dryRun: v.boolean(),
	examined: v.number(),
	alreadyFilled: v.number(),
	noSlug: v.number(),
	toFill: v.number(),
	undecidable: v.number(),
	undecidableByReason: reasonCountsValidator,
	// Row ids left unfilled on this page, with the slug that could not be resolved.
	undecidableRows: v.array(
		v.object({ id: v.string(), slug: v.string(), reason: v.string() }),
	),
	filled: v.number(),
	isDone: v.boolean(),
	nextCursor: v.union(v.string(), v.null()),
	nextTable: v.union(tableValidator, v.null()),
});

type PageRow = { _id: string } & Record<string, unknown>;

export const run = internalMutation({
	args: {
		table: tableValidator,
		dryRun: v.optional(v.boolean()),
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
	},
	returns: resultValidator,
	handler: async (ctx, args) => {
		const dryRun = args.dryRun !== false;
		const pageSize =
			args.pageSize ?? SMALL_PAGE_SIZE[args.table] ?? DEFAULT_PAGE_SIZE;
		if (
			!Number.isInteger(pageSize) ||
			pageSize < 1 ||
			pageSize > MAX_PAGE_SIZE
		) {
			throw new ConvexError(
				`backfill_org_clerk_id: pageSize = ${pageSize} is out of expected range 1-${MAX_PAGE_SIZE}.`,
			);
		}
		const { slugField, idField } = ORG_COLUMNS[args.table];
		const mappings = await loadMappings(ctx.db);

		const page = await ctx.db
			.query(args.table)
			.paginate({ cursor: args.cursor ?? null, numItems: pageSize });

		let examined = 0;
		let alreadyFilled = 0;
		let noSlug = 0;
		let toFill = 0;
		let filled = 0;
		const byReason: Record<Reason, number> = {
			orgUnmapped: 0,
			ambiguousMapping: 0,
			mappingHasNoClerkId: 0,
		};
		const undecidableRows: { id: string; slug: string; reason: string }[] = [];

		for (const row of page.page as unknown as PageRow[]) {
			examined++;
			if (row[idField] !== undefined) {
				alreadyFilled++;
				continue;
			}
			const slug = row[slugField];
			if (typeof slug !== "string" || slug === "") {
				noSlug++;
				continue;
			}
			const resolution = mappings.get(slug) ?? {
				kind: "undecidable" as const,
				reason: "orgUnmapped" as const,
			};
			if (resolution.kind === "undecidable") {
				byReason[resolution.reason]++;
				undecidableRows.push({ id: row._id, slug, reason: resolution.reason });
				continue;
			}
			toFill++;
			if (!dryRun) {
				await ctx.db.patch(
					args.table,
					row._id as never,
					{
						[idField]: resolution.clerkOrgId,
					} as never,
				);
				filled++;
			}
		}

		const idx = TABLE_ORDER.indexOf(args.table);
		return {
			table: args.table,
			slugField,
			idField,
			dryRun,
			examined,
			alreadyFilled,
			noSlug,
			toFill,
			undecidable: undecidableRows.length,
			undecidableByReason: byReason,
			undecidableRows,
			filled,
			isDone: page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
			nextTable: page.isDone ? (TABLE_ORDER[idx + 1] ?? null) : args.table,
		};
	},
});
