/**
 * One-off migration: add the default own-org member scopes to organisations
 * that were provisioned while `oauth:provisionOrganization` defaulted to the
 * narrow `["view-own-tasks"]` (members of those orgs are refused
 * `missions:list` with RBAC_DENIED `Missing scope "view-own-missions"`).
 *
 * INTERNAL ONLY — never client-facing. Operator-run, paginated:
 *   npx convex run memberScopesMigration:addDefaultMemberScopes \
 *     '{"dryRun":true,"cursor":null}'
 * then repeat with `cursor` = the returned `continueCursor` until `isDone`.
 *
 * Guarantees:
 *  - ADDITIVE ONLY: scopes are appended, none is ever removed or replaced.
 *  - Only the scopes in DEFAULT_MEMBER_SCOPES are ever added; never
 *    cross-tenant-read, view-stats-aggregated or view-orchestrator-summary.
 *  - Only ACTIVE mappings; inactive orgs stay as they are.
 *  - Fleet-wide mappings (the explicit `fleetWide` flag) are skipped.
 *  - Idempotent: a mapping already holding every default scope is not written.
 *  - Bounded: at most `batchSize` (default 100, max 200) mappings per call.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { DEFAULT_MEMBER_SCOPES } from "./lib/memberScopes";

const DEFAULT_BATCH = 100;
const MAX_BATCH = 200;

export const addDefaultMemberScopes = internalMutation({
	args: {
		dryRun: v.boolean(),
		cursor: v.union(v.string(), v.null()),
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		dryRun: v.boolean(),
		scanned: v.number(),
		updated: v.number(),
		updatedSlugs: v.array(v.string()),
		isDone: v.boolean(),
		continueCursor: v.string(),
	}),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? DEFAULT_BATCH;
		if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH) {
			throw new Error(
				`batchSize = ${batchSize} is out of expected range 1-${MAX_BATCH}.`,
			);
		}
		const page = await ctx.db
			.query("client_org_mapping")
			.paginate({ numItems: batchSize, cursor: args.cursor });

		let updated = 0;
		const updatedSlugs: string[] = [];
		for (const row of page.page) {
			if (!row.isActive) continue;
			if (row.fleetWide === true) continue;
			const missing = DEFAULT_MEMBER_SCOPES.filter(
				(s) => !row.scopes.includes(s),
			);
			if (missing.length === 0) continue;
			updated += 1;
			updatedSlugs.push(row.clerkOrgSlug);
			if (!args.dryRun) {
				await ctx.db.patch(row._id, { scopes: [...row.scopes, ...missing] });
			}
		}
		return {
			dryRun: args.dryRun,
			scanned: page.page.length,
			updated,
			updatedSlugs,
			isDone: page.isDone,
			continueCursor: page.continueCursor,
		};
	},
});
