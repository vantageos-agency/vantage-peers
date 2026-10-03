// ─────────────────────────────────────────────────────────────────────────────
// fleetOrgStamp — stamp the FLEET'S unstamped rows with the fleet org slug,
// only where the row itself PROVES the attribution.
//
// WHY. An org member reads through org-keyed indexes (`by_orgId*` on tasks and
// missions, `by_tenant*` on messages). A row with no `orgId`/`tenantId` never
// matches `eq(<org field>, slug)`, so the fleet's legacy rows are invisible to
// the fleet org's own dashboard members until they are stamped. The general
// tenant backfill (`backfillOrgIds`) deliberately derives only task -> mission
// and refuses to map orchestrator NAMES to an org, because two orgs can share a
// name. This function adds the one name-based derivation that is not a guess:
//
//   A row is attributable to the fleet org iff its orchestrator field
//     tasks.assignedTo | missions.pilot | messages.from
//   names a member of the fleet (operator) org's roster
//   (`client_org_mapping.allowedOrchestrators` of the orgKind="operator" row,
//   the "*" sentinel excluded) AND that name appears in NO other organisation's
//   roster. A name rostered in two orgs is ambiguous and is NOT stamped.
//   A task whose parent mission is stamped for a DIFFERENT org is not stamped
//   either (the parent's stated tenant contradicts the name).
//
// Everything else is COUNTED, never guessed: `unprovable` is split into
// `notFleetRoster`, `ambiguousName`, `parentOtherOrg`.
//
// SHAPE. One page of one table per call, newest-last by index order, with a
// cursor returned for the next call. DRY RUN BY DEFAULT: nothing is written
// unless `apply: true`. Idempotent: it reads only UNSTAMPED rows (index
// equality on `undefined`), so a stamped row is never read, re-stamped or
// overwritten, and a re-run after a full pass finds `examined: 0`.
//
// OPERATING (internal — `convex run`, deployment admin credential; not
// reachable from any client, hence no per-caller auth check):
//   fleetOrgStamp:run {"table":"tasks"}                       dry run, page 1
//   fleetOrgStamp:run {"table":"tasks","cursor":"<nextCursor>"} next page
//   fleetOrgStamp:run {"table":"tasks","apply":true,...}       after reading counts
// NOT RUN AGAINST ANY DEPLOYMENT BY ITS AUTHOR.
// ─────────────────────────────────────────────────────────────────────────────

import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { internalMutation } from "../_generated/server";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const MAPPING_READ_CAP = 1000;

const tableValidator = v.union(
	v.literal("tasks"),
	v.literal("missions"),
	v.literal("messages"),
);

type Roster = {
	orgSlug: string;
	// names attributable to the fleet org: rostered there and nowhere else
	provable: Set<string>;
	// names rostered in the fleet org AND in another org
	ambiguous: Set<string>;
};

async function loadFleetRoster(
	db: DatabaseReader,
	requestedSlug: string | undefined,
): Promise<Roster> {
	const mappings = await db.query("client_org_mapping").take(MAPPING_READ_CAP + 1);
	if (mappings.length > MAPPING_READ_CAP) {
		throw new ConvexError(
			`fleetOrgStamp: client_org_mapping holds more than ${MAPPING_READ_CAP} rows; refusing to derive a roster from a truncated read.`,
		);
	}
	const operators = mappings.filter(
		(m) => m.isActive && m.orgKind === "operator",
	);
	const fleet =
		requestedSlug !== undefined
			? operators.find((m) => m.clerkOrgSlug === requestedSlug)
			: operators.length === 1
				? operators[0]
				: undefined;
	if (fleet === undefined) {
		throw new ConvexError(
			requestedSlug !== undefined
				? `fleetOrgStamp: "${requestedSlug}" is not an active orgKind="operator" organisation.`
				: `fleetOrgStamp: expected exactly one active operator organisation, found ${operators.length}; pass orgSlug explicitly.`,
		);
	}
	const elsewhere = new Set<string>();
	for (const m of mappings) {
		if (m._id === fleet._id) continue;
		for (const name of m.allowedOrchestrators) {
			if (name !== "*") elsewhere.add(name);
		}
	}
	const provable = new Set<string>();
	const ambiguous = new Set<string>();
	for (const name of fleet.allowedOrchestrators) {
		if (name === "*") continue;
		(elsewhere.has(name) ? ambiguous : provable).add(name);
	}
	return { orgSlug: fleet.clerkOrgSlug, provable, ambiguous };
}

export const run = internalMutation({
	args: {
		table: tableValidator,
		apply: v.optional(v.boolean()),
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
		orgSlug: v.optional(v.string()),
	},
	returns: v.object({
		table: tableValidator,
		orgSlug: v.string(),
		apply: v.boolean(),
		examined: v.number(),
		stampable: v.number(),
		stamped: v.number(),
		unprovable: v.object({
			notFleetRoster: v.number(),
			ambiguousName: v.number(),
			parentOtherOrg: v.number(),
		}),
		isDone: v.boolean(),
		nextCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const apply = args.apply === true;
		const pageSize = args.pageSize ?? DEFAULT_PAGE_SIZE;
		if (
			!Number.isInteger(pageSize) ||
			pageSize < 1 ||
			pageSize > MAX_PAGE_SIZE
		) {
			throw new ConvexError(
				`fleetOrgStamp: pageSize = ${pageSize} is out of expected range 1-${MAX_PAGE_SIZE}.`,
			);
		}
		const roster = await loadFleetRoster(ctx.db, args.orgSlug);

		let examined = 0;
		let stampable = 0;
		let stamped = 0;
		const unprovable = { notFleetRoster: 0, ambiguousName: 0, parentOtherOrg: 0 };

		// Classify one row from its orchestrator name. Returns true when stampable.
		const classify = (name: string | undefined): boolean => {
			if (name !== undefined && roster.provable.has(name)) return true;
			if (name !== undefined && roster.ambiguous.has(name)) {
				unprovable.ambiguousName++;
			} else {
				unprovable.notFleetRoster++;
			}
			return false;
		};

		let isDone: boolean;
		let nextCursor: string | null;

		if (args.table === "tasks") {
			const page = await ctx.db
				.query("tasks")
				.withIndex("by_orgId", (q) => q.eq("orgId", undefined))
				.paginate({ cursor: args.cursor ?? null, numItems: pageSize });
			for (const row of page.page) {
				examined++;
				if (!classify(row.assignedTo)) continue;
				if (row.missionId !== undefined) {
					const parent: { orgId?: string } | null = await ctx.db.get(
						row.missionId as Id<"missions">,
					);
					if (
						parent !== null &&
						parent.orgId !== undefined &&
						parent.orgId !== roster.orgSlug
					) {
						unprovable.parentOtherOrg++;
						continue;
					}
				}
				stampable++;
				if (apply) {
					await ctx.db.patch(row._id, { orgId: roster.orgSlug });
					stamped++;
				}
			}
			isDone = page.isDone;
			nextCursor = page.isDone ? null : page.continueCursor;
		} else if (args.table === "missions") {
			const page = await ctx.db
				.query("missions")
				.withIndex("by_orgId", (q) => q.eq("orgId", undefined))
				.paginate({ cursor: args.cursor ?? null, numItems: pageSize });
			for (const row of page.page) {
				examined++;
				if (!classify(row.pilot)) continue;
				stampable++;
				if (apply) {
					await ctx.db.patch(row._id, { orgId: roster.orgSlug });
					stamped++;
				}
			}
			isDone = page.isDone;
			nextCursor = page.isDone ? null : page.continueCursor;
		} else {
			const page = await ctx.db
				.query("messages")
				.withIndex("by_tenant_created", (q) => q.eq("tenantId", undefined))
				.paginate({ cursor: args.cursor ?? null, numItems: pageSize });
			for (const row of page.page) {
				examined++;
				if (!classify(row.from)) continue;
				stampable++;
				if (apply) {
					await ctx.db.patch(row._id, { tenantId: roster.orgSlug });
					stamped++;
				}
			}
			isDone = page.isDone;
			nextCursor = page.isDone ? null : page.continueCursor;
		}

		return {
			table: args.table,
			orgSlug: roster.orgSlug,
			apply,
			examined,
			stampable,
			stamped,
			unprovable,
			isDone,
			nextCursor,
		};
	},
});
