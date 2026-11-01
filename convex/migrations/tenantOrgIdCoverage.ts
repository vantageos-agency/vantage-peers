// tenantOrgIdCoverage — COUNT and BACKFILL of the permanent org ID (`tenantOrgId`) on
// `messages` and `messageReceipts`, the two tables whose reads switch from the slug
// (`tenantId`) to the ID. Task k1783fk8r6p795x9fxrzyt9evd8hcxm7, PR 2a. Run, deployed and
// read back BEFORE the read switch (PR 2b), so a row that only lacks a backfill does not
// vanish from, or get refused by, the new reads. Sibling of clerkOrgIdCoverage (which
// covers oauth_scope_profiles and tasks); same shape, same rules, separate module because
// the column name (`tenantOrgId`) and slug column (`tenantId`) differ.
//
// Two internal functions, both caller-walked and cursor-paginated (one page per call,
// bounded reads AND writes), reachable only with the deployment admin credential, so no
// per-caller auth check exists here by design:
//
//   count     read-only. Per page: { table, examined, withId, withoutId, done, cursor }.
//             COUNTS ONLY: no row content, no label, no id leaves it.
//   backfill  DRY RUN BY DEFAULT. For each row without tenantOrgId, the row's `tenantId`
//             slug is looked up in client_org_mapping (backfill_org_clerk_id's
//             `resolveSlug`); the row is filled ONLY when the slug names EXACTLY ONE
//             mapping row, that row is ACTIVE, carries a clerkOrgId, and was created no
//             later than the row (AGE CHECK: a slug can change hands, and a mapping newer
//             than the row is not the org that stamped it). Anything else is never
//             guessed: the row is left untouched and reported by `_id` only:
//               absentSlug / ambiguousSlug / inactiveMapping / mappingHasNoClerkId /
//               mappingRecordInvalid / mappingNewerThanRow.
//             A row with NO tenantId is counted `noSlug` and left alone (a fleet row; an
//             org is never invented). A row that already has a tenantOrgId is counted
//             `alreadyFilled` and never written. Idempotent: a second run fills 0.
//
// pageSize: default 50 (messages) / 100 (messageReceipts), cap 200. `messages.content` has
// no length cap in this schema, so a page of large bodies could approach the per-call read
// budget; the caller lowers pageSize if a call is refused for size. `unresolvedIds` is
// capped PER PAGE (`unresolvedIdCap`, default 50, max 500); `unresolved` and
// `unresolvedByReason` are never capped.
//
//   count:    bash .claude/scripts/convex-prod.sh run migrations/tenantOrgIdCoverage:count '{"table":"messages"}'
//             -> repeat with {"cursor": <cursor>} until done is true; sum the pages.
//   backfill: same walk with migrations/tenantOrgIdCoverage:backfill; pass "dryRun": false to write.

import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import {
	indexBySlug,
	loadMappingRows,
	resolveSlug,
} from "./backfill_org_clerk_id";

const tableValidator = v.union(
	v.literal("messages"),
	v.literal("messageReceipts"),
);
type CoverageTable = "messages" | "messageReceipts";

const DEFAULT_PAGE_SIZE: Record<CoverageTable, number> = {
	messages: 50,
	messageReceipts: 100,
};
const MAX_PAGE_SIZE = 200;
const DEFAULT_UNRESOLVED_ID_CAP = 50;
const MAX_UNRESOLVED_ID_CAP = 500;

type PageRow = {
	_id: string;
	tenantId?: string;
	tenantOrgId?: string;
	_creationTime: number;
};

function assertPageSize(fn: string, pageSize: number): void {
	if (
		!Number.isInteger(pageSize) ||
		pageSize < 1 ||
		pageSize > MAX_PAGE_SIZE
	) {
		throw new ConvexError(
			`${fn}: pageSize = ${pageSize} is out of expected range 1-${MAX_PAGE_SIZE}.`,
		);
	}
}

const hasId = (row: PageRow): boolean =>
	typeof row.tenantOrgId === "string" && row.tenantOrgId !== "";

export const count = internalQuery({
	args: {
		table: tableValidator,
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
	},
	returns: v.object({
		table: tableValidator,
		examined: v.number(),
		withId: v.number(),
		withoutId: v.number(),
		done: v.boolean(),
		cursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const pageSize = args.pageSize ?? DEFAULT_PAGE_SIZE[args.table];
		assertPageSize("tenantOrgIdCoverage:count", pageSize);
		const page = await ctx.db
			.query(args.table)
			.paginate({ cursor: args.cursor ?? null, numItems: pageSize });
		let withId = 0;
		let withoutId = 0;
		for (const row of page.page as PageRow[]) {
			if (hasId(row)) withId++;
			else withoutId++;
		}
		return {
			table: args.table,
			examined: withId + withoutId,
			withId,
			withoutId,
			done: page.isDone,
			cursor: page.isDone ? null : page.continueCursor,
		};
	},
});

type Unresolved =
	| "absentSlug"
	| "ambiguousSlug"
	| "inactiveMapping"
	| "mappingHasNoClerkId"
	| "mappingRecordInvalid"
	| "mappingNewerThanRow";
const REASON_NAME = {
	orgUnmapped: "absentSlug",
	ambiguousMapping: "ambiguousSlug",
	mappingHasNoClerkId: "mappingHasNoClerkId",
	mappingRecordInvalid: "mappingRecordInvalid",
} as const satisfies Record<string, Unresolved>;
type Resolution =
	| { kind: "id"; clerkOrgId: string }
	| { kind: "unresolved"; reason: Unresolved };

export const backfill = internalMutation({
	args: {
		table: tableValidator,
		dryRun: v.optional(v.boolean()),
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
		unresolvedIdCap: v.optional(v.number()),
	},
	returns: v.object({
		table: tableValidator,
		dryRun: v.boolean(),
		examined: v.number(),
		alreadyFilled: v.number(),
		noSlug: v.number(),
		toFill: v.number(),
		filled: v.number(),
		unresolved: v.number(),
		unresolvedByReason: v.object({
			absentSlug: v.number(),
			ambiguousSlug: v.number(),
			inactiveMapping: v.number(),
			mappingHasNoClerkId: v.number(),
			mappingRecordInvalid: v.number(),
			mappingNewerThanRow: v.number(),
		}),
		unresolvedIds: v.array(v.string()),
		done: v.boolean(),
		cursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const dryRun = args.dryRun !== false;
		const pageSize = args.pageSize ?? DEFAULT_PAGE_SIZE[args.table];
		assertPageSize("tenantOrgIdCoverage:backfill", pageSize);
		const cap = args.unresolvedIdCap ?? DEFAULT_UNRESOLVED_ID_CAP;
		if (!Number.isInteger(cap) || cap < 0 || cap > MAX_UNRESOLVED_ID_CAP) {
			throw new ConvexError(
				`tenantOrgIdCoverage:backfill: unresolvedIdCap = ${cap} is out of expected range 0-${MAX_UNRESOLVED_ID_CAP}.`,
			);
		}

		const page = await ctx.db
			.query(args.table)
			.paginate({ cursor: args.cursor ?? null, numItems: pageSize });

		// The mapping rows are read once per call; the slug -> ID derivation is the
		// package's backfill-only resolver, reached through backfill_org_clerk_id's
		// `resolveSlug`. This module adds only the "active" requirement, the AGE CHECK
		// and the reason names (same as clerkOrgIdCoverage).
		const mappings = indexBySlug(await loadMappingRows(ctx.db));
		const resolve = async (
			slug: string,
			rowCreationTime: number,
		): Promise<Resolution> => {
			const rows = mappings.get(slug) ?? [];
			if (rows.length === 1 && !rows[0].isActive) {
				return { kind: "unresolved", reason: "inactiveMapping" };
			}
			if (rows.length === 1 && rows[0]._creationTime > rowCreationTime) {
				return { kind: "unresolved", reason: "mappingNewerThanRow" };
			}
			const resolved = await resolveSlug(mappings, slug);
			if (resolved.kind === "id") return resolved;
			return { kind: "unresolved", reason: REASON_NAME[resolved.reason] };
		};

		let examined = 0;
		let alreadyFilled = 0;
		let noSlug = 0;
		let toFill = 0;
		let filled = 0;
		let unresolved = 0;
		const byReason: Record<Unresolved, number> = {
			absentSlug: 0,
			ambiguousSlug: 0,
			inactiveMapping: 0,
			mappingHasNoClerkId: 0,
			mappingRecordInvalid: 0,
			mappingNewerThanRow: 0,
		};
		const unresolvedIds: string[] = [];

		for (const row of page.page as PageRow[]) {
			examined++;
			if (hasId(row)) {
				alreadyFilled++;
				continue;
			}
			const slug = row.tenantId;
			if (typeof slug !== "string" || slug === "") {
				noSlug++;
				continue;
			}
			const resolution = await resolve(slug, row._creationTime);
			if (resolution.kind === "unresolved") {
				unresolved++;
				byReason[resolution.reason]++;
				if (unresolvedIds.length < cap) unresolvedIds.push(row._id);
				continue;
			}
			toFill++;
			if (!dryRun) {
				await ctx.db.patch(args.table, row._id as never, {
					tenantOrgId: resolution.clerkOrgId,
				} as never);
				filled++;
			}
		}

		return {
			table: args.table,
			dryRun,
			examined,
			alreadyFilled,
			noSlug,
			toFill,
			filled,
			unresolved,
			unresolvedByReason: byReason,
			unresolvedIds,
			done: page.isDone,
			cursor: page.isDone ? null : page.continueCursor,
		};
	},
});
