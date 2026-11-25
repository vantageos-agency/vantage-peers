// ─────────────────────────────────────────────────────────────────────────────
// stampFleetRepoMappings — give the fleet's routing rows their organisation.
// (mission k577f8ksjx5ec3gq9bggc1brqd8jwkbh, S1; task k1707fkmyaavn0v0fkdjg2mhs58jx8dr)
//
// WHY. A `githubRepoMapping` row with no `orgId` is a FLEET row, the historical
// meaning of every row written before tenants existed. A per-org route lookup
// (`githubRepoMapping:getRoute`) answers a member only for rows its own org owns,
// so the operator org's members read nothing of the operator's routing until the
// rows carry the operator org's stamp. The rows belong to the operator org.
//
// WHICH ORG. Derived at run time by `findOperatorOrg` (the one active
// `orgKind: "operator"` mapping — the lookup `clientOrgMapping:
// addOperatorRosterMember` uses), never typed. Zero or several operator orgs
// refuse with OPERATOR_ORG_NOT_FOUND and nothing is written. `clerkOrgId` is
// stamped beside `orgId` when the operator mapping holds one; without it the row
// gets the slug only (backfill_org_clerk_id lists and fills it later).
//
// SHAPE. DRY RUN BY DEFAULT: nothing is written unless `apply: true`. It reads
// only UNSTAMPED rows (`by_org` equality on `undefined`), so a stamped row is
// never read or overwritten and a second apply finds nothing (idempotent). One
// call handles at most BATCH rows; `more: true` says run it again.
// REVERSIBLE: `apply` returns `stampedIds`; `revert` unstamps exactly those rows
// (and only while they still carry the operator stamp).
//
// OPERATING (internal — `convex run`, deployment admin credential; not reachable
// from any client, hence no per-caller auth check):
//   migrations/stampFleetRepoMappings:run '{}'                dry run
//   migrations/stampFleetRepoMappings:run '{"apply":true}'    after reading it
//   migrations/stampFleetRepoMappings:revert '{"ids":[…]}'    undo, from the apply's stampedIds
// NOT RUN AGAINST ANY DEPLOYMENT BY ITS AUTHOR.
// ─────────────────────────────────────────────────────────────────────────────

import { ConvexError, v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { findOperatorOrg } from "../lib/operatorOrg";

const BATCH = 500;
const SAMPLE = 10;

export const run = internalMutation({
	args: { apply: v.optional(v.boolean()) },
	returns: v.object({
		mode: v.union(v.literal("dry-run"), v.literal("applied")),
		operatorOrgId: v.string(),
		operatorClerkOrgId: v.union(v.string(), v.null()),
		// Unstamped rows read by THIS call (at most BATCH).
		unstamped: v.number(),
		more: v.boolean(),
		sample: v.array(v.string()),
		stampedIds: v.array(v.id("githubRepoMapping")),
	}),
	handler: async (ctx, args) => {
		const operator = await findOperatorOrg(ctx.db);
		if (operator.kind !== "one") {
			throw new ConvexError(
				`OPERATOR_ORG_NOT_FOUND: the operator org is not settled to exactly one active mapping (${operator.kind}); nothing stamped`,
			);
		}
		const apply = args.apply === true;
		const rows = await ctx.db
			.query("githubRepoMapping")
			.withIndex("by_org", (q) => q.eq("orgId", undefined))
			.take(BATCH + 1);
		const batch = rows.slice(0, BATCH);
		const stampedIds = [];
		if (apply) {
			for (const row of batch) {
				await ctx.db.patch(row._id, {
					orgId: operator.slug,
					...(operator.clerkOrgId !== undefined
						? { clerkOrgId: operator.clerkOrgId }
						: {}),
				});
				stampedIds.push(row._id);
			}
		}
		return {
			mode: apply ? ("applied" as const) : ("dry-run" as const),
			operatorOrgId: operator.slug,
			operatorClerkOrgId: operator.clerkOrgId ?? null,
			unstamped: batch.length,
			more: rows.length > BATCH,
			sample: batch.slice(0, SAMPLE).map((r) => r.repo),
			stampedIds,
		};
	},
});

export const revert = internalMutation({
	args: { ids: v.array(v.id("githubRepoMapping")) },
	returns: v.object({ reverted: v.number(), skipped: v.number() }),
	handler: async (ctx, args) => {
		const operator = await findOperatorOrg(ctx.db);
		if (operator.kind !== "one") {
			throw new ConvexError(
				`OPERATOR_ORG_NOT_FOUND: the operator org is not settled to exactly one active mapping (${operator.kind}); nothing reverted`,
			);
		}
		let reverted = 0;
		let skipped = 0;
		for (const id of args.ids) {
			const row = await ctx.db.get(id);
			// Only a row that still carries the operator stamp is unstamped: a row
			// stamped for any other org is not this migration's to touch.
			if (row === null || row.orgId !== operator.slug) {
				skipped++;
				continue;
			}
			await ctx.db.patch(id, { orgId: undefined, clerkOrgId: undefined });
			reverted++;
		}
		return { reverted, skipped };
	},
});
