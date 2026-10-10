// CONSISTENT with convex/migrations/backfill_org_stamp.ts, NOT superseded (RULING 4,
// task k174d95s5qqy8t2r5rdrz3pr3d8fqv82): both stamp the fleet with the OPERATOR
// ORG's slug, derived at run time from the active orgKind "operator" mapping row,
// never typed. This file derives it inline (see the operator lookup below);
// backfill_org_stamp.ts uses convex/lib/operatorOrg.ts. FLEET_SCOPE_ORG_ID is retired.
// ─────────────────────────────────────────────────────────────────────────────
// fleetOrgStamp — stamp the FLEET'S unstamped rows with the fleet org slug,
// only where the row itself PROVES the attribution.
//
// WHY. An org member reads through org-keyed indexes (`by_orgId*` on tasks and
// missions, `by_tenant*` on messages). A row with no `orgId`/`tenantId` never
// matches `eq(<org field>, slug)`, so the fleet's legacy rows are invisible to
// the fleet org's own dashboard members until they are stamped.
//
// THE RULE (operator ruling 2026-10-03, relayed by pi, receipt
// k97eb7pbjh6xvknp32y1eg7ks18fk9sa): a NAME IS A LABEL, NEVER AN IDENTITY. A
// name-based backfill is a ONE-TIME BRIDGE, bounded so that it cannot assign a
// row to the wrong organisation. A row is stamped by name ONLY when
//   the orchestrator field  tasks.assignedTo | missions.pilot | messages.from
// resolves, under `normalizeOrchestratorId` (NFC + lowercase + trim), to
// EXACTLY ONE row of the `agents` table across ALL organisations (any
// isActive state: a deactivated namesake still makes the label ambiguous), AND
// that one agent belongs to the operator org (client_org_mapping
// orgKind="operator", derived, never typed). The operator ROSTER is not
// consulted: a roster entry is a string, an `agents` row is an identity.
// Every other row STAYS UNSTAMPED, is never guessed, and is LISTED BY ID in the
// result (bounded per page by the page size), in one bucket:
//   ambiguous       the name matches 2+ agent rows (two orgs, or twice in one)
//   unknown         the name matches NO agent row (even if some roster lists it)
//   otherOrg        exactly one agent, but it is not in the operator org
//   parentOtherOrg  (tasks) the parent mission is stamped for another org
// A task whose parent mission is stamped for a different org is never stamped,
// whatever its name resolves to.
//
// SHAPE. One page of one table per call, with a cursor returned for the next
// call. DRY RUN BY DEFAULT: nothing is written unless `apply: true`.
// Idempotent: it reads only UNSTAMPED rows (index equality on `undefined`), so a
// stamped row is never read, re-stamped or overwritten.
//
// OPERATING (internal — `convex run`, deployment admin credential; not
// reachable from any client, hence no per-caller auth check):
//   fleetOrgStamp:run {"table":"tasks"}                        dry run, page 1
//   fleetOrgStamp:run {"table":"tasks","cursor":"<nextCursor>"} next page
//   fleetOrgStamp:run {"table":"tasks","apply":true,...}        after reading it
// NOT RUN AGAINST ANY DEPLOYMENT BY ITS AUTHOR.
// ─────────────────────────────────────────────────────────────────────────────

import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import { clerkOrgIdForSlug } from "../lib/orgClerkId";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const MAPPING_READ_CAP = 1000;

const tableValidator = v.union(
	v.literal("tasks"),
	v.literal("missions"),
	v.literal("messages"),
);

const AGENT_READ_CAP = 5000;

type Resolver = {
	orgSlug: string;
	// normalized name -> orgSlugs of every agent row carrying it (one entry per row)
	agentOrgsByName: Map<string, string[]>;
};

async function loadResolver(
	db: DatabaseReader,
	requestedSlug: string | undefined,
): Promise<Resolver> {
	const mappings = await db.query("client_org_mapping").take(MAPPING_READ_CAP + 1);
	if (mappings.length > MAPPING_READ_CAP) {
		throw new ConvexError(
			`fleetOrgStamp: client_org_mapping holds more than ${MAPPING_READ_CAP} rows; refusing to derive the operator org from a truncated read.`,
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
	const agents = await db.query("agents").take(AGENT_READ_CAP + 1);
	if (agents.length > AGENT_READ_CAP) {
		throw new ConvexError(
			`fleetOrgStamp: agents holds more than ${AGENT_READ_CAP} rows; refusing to resolve names from a truncated read.`,
		);
	}
	const agentOrgsByName = new Map<string, string[]>();
	for (const a of agents) {
		// Legacy rows may lack normalizedName: derive it, never skip the row.
		const key = a.normalizedName ?? normalizeOrchestratorId(a.name);
		const list = agentOrgsByName.get(key) ?? [];
		list.push(a.orgSlug);
		agentOrgsByName.set(key, list);
	}
	return { orgSlug: fleet.clerkOrgSlug, agentOrgsByName };
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
		ambiguous: v.number(),
		unknown: v.number(),
		otherOrg: v.number(),
		parentOtherOrg: v.number(),
		// Row ids left UNSTAMPED on this page, by bucket (bounded by pageSize).
		unstampedIds: v.object({
			ambiguous: v.array(v.string()),
			unknown: v.array(v.string()),
			otherOrg: v.array(v.string()),
			parentOtherOrg: v.array(v.string()),
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
		const resolver = await loadResolver(ctx.db, args.orgSlug);
		// The id of the org being stamped, written beside its slug. Absent when the
		// mapping has no id yet: then the row gets the slug only and
		// backfill_org_clerk_id lists and fills it.
		const orgClerkId = await clerkOrgIdForSlug(ctx, resolver.orgSlug);
		const idPatch =
			orgClerkId === undefined ? {} : { clerkOrgId: orgClerkId };

		let examined = 0;
		let stampable = 0;
		let stamped = 0;
		const unstampedIds = {
			ambiguous: [] as string[],
			unknown: [] as string[],
			otherOrg: [] as string[],
			parentOtherOrg: [] as string[],
		};

		// Resolve a row's orchestrator label to a bucket. "stamp" only when the
		// label is exactly one agent row and that agent is in the operator org.
		const resolve = (
			name: string | undefined,
		): "stamp" | "ambiguous" | "unknown" | "otherOrg" => {
			if (name === undefined) return "unknown";
			const orgs = resolver.agentOrgsByName.get(normalizeOrchestratorId(name));
			if (orgs === undefined || orgs.length === 0) return "unknown";
			if (orgs.length > 1) return "ambiguous";
			// allow-local-identity: offline backfill with no caller; compares stored data against data
			return orgs[0] === resolver.orgSlug ? "stamp" : "otherOrg";
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
				const verdict = resolve(row.assignedTo);
				if (verdict !== "stamp") {
					unstampedIds[verdict].push(row._id);
					continue;
				}
				if (row.missionId !== undefined) {
					const parent: { orgId?: string } | null = await ctx.db.get(
						row.missionId as Id<"missions">,
					);
					if (
						parent !== null &&
						parent.orgId !== undefined &&
						parent.orgId !== resolver.orgSlug
					) {
						unstampedIds.parentOtherOrg.push(row._id);
						continue;
					}
				}
				stampable++;
				if (apply) {
					await ctx.db.patch(row._id, {
						orgId: resolver.orgSlug,
						...idPatch,
					});
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
				const verdict = resolve(row.pilot);
				if (verdict !== "stamp") {
					unstampedIds[verdict].push(row._id);
					continue;
				}
				stampable++;
				if (apply) {
					await ctx.db.patch(row._id, {
						orgId: resolver.orgSlug,
						...idPatch,
					});
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
				const verdict = resolve(row.from);
				if (verdict !== "stamp") {
					unstampedIds[verdict].push(row._id);
					continue;
				}
				stampable++;
				if (apply) {
					await ctx.db.patch(row._id, {
						tenantId: resolver.orgSlug,
						...(orgClerkId === undefined ? {} : { tenantOrgId: orgClerkId }),
					});
					stamped++;
				}
			}
			isDone = page.isDone;
			nextCursor = page.isDone ? null : page.continueCursor;
		}

		return {
			table: args.table,
			orgSlug: resolver.orgSlug,
			apply,
			examined,
			stampable,
			stamped,
			ambiguous: unstampedIds.ambiguous.length,
			unknown: unstampedIds.unknown.length,
			otherOrg: unstampedIds.otherOrg.length,
			parentOtherOrg: unstampedIds.parentOtherOrg.length,
			unstampedIds,
			isDone,
			nextCursor,
		};
	},
});
