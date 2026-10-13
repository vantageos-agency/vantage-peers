/**
 * Agent owner by row: the rollout backfill for `ownerPersonId` on the two rows
 * that carry an agent's credential.
 *
 *   agent_credentials.ownerPersonId
 *   oauth_access_tokens.ownerPersonId     (seat tokens: rows with an `agentId`)
 *
 * The owner is a fact of the AGENT ROW (`agents.ownerPersonId`); a credential or
 * token row carries a COPY taken at mint. Rows minted before the field existed,
 * or before the agent was bound to its owner, carry none, and the package then
 * proves no owner for them. This copies the agent row's owner onto each row,
 * from the agent row only (never from an argument).
 *
 * INTERNAL ONLY. Operator-run, cursor-paged, DRY-RUN FIRST:
 *
 *   npx convex run migrations/agentOwnerRows:backfillAgentOwnerIds \
 *     '{"table":"agent_credentials","dryRun":true,"cursor":null}'
 *   npx convex run migrations/agentOwnerRows:backfillAgentOwnerIds \
 *     '{"table":"oauth_access_tokens","dryRun":true,"cursor":null}'
 *
 * Repeat each with `cursor` = the returned `continueCursor` until `isDone`.
 *
 * Guarantees:
 *  - IDEMPOTENT: a row whose owner already equals its agent's is counted
 *    (`inSync`), never rewritten. A second run updates nothing.
 *  - A row naming no agent row (`missingAgent`) is counted and left untouched.
 *  - A row with no `agentId` (an org-level token) is skipped (`noAgent`).
 *  - dryRun writes nothing and reports what a real run would do.
 *  - Bounded: at most `batchSize` (default 100, max 200) rows per call.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation } from "../_generated/server";

const DEFAULT_BATCH = 100;
const MAX_BATCH = 200;

const tableName = v.union(
	v.literal("agent_credentials"),
	v.literal("oauth_access_tokens"),
);

export const backfillAgentOwnerIds = internalMutation({
	args: {
		table: tableName,
		dryRun: v.boolean(),
		cursor: v.union(v.string(), v.null()),
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		table: tableName,
		dryRun: v.boolean(),
		scanned: v.number(),
		updated: v.number(),
		inSync: v.number(),
		noAgent: v.number(),
		missingAgent: v.number(),
		isDone: v.boolean(),
		continueCursor: v.string(),
	}),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? DEFAULT_BATCH;
		if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH) {
			throw new ConvexError(
				`BATCH_SIZE_INVALID: batchSize ${batchSize} is out of range 1-${MAX_BATCH}`,
			);
		}
		const paginationOpts = { numItems: batchSize, cursor: args.cursor };
		const page =
			args.table === "agent_credentials"
				? await ctx.db.query("agent_credentials").paginate(paginationOpts)
				: await ctx.db.query("oauth_access_tokens").paginate(paginationOpts);

		let updated = 0;
		let inSync = 0;
		let noAgent = 0;
		let missingAgent = 0;
		for (const row of page.page) {
			if (row.agentId === undefined) {
				noAgent += 1;
				continue;
			}
			const agent = await ctx.db.get(row.agentId);
			if (agent === null) {
				missingAgent += 1;
				continue;
			}
			if (row.ownerPersonId === agent.ownerPersonId) {
				inSync += 1;
				continue;
			}
			updated += 1;
			if (!args.dryRun) {
				await ctx.db.patch(row._id, { ownerPersonId: agent.ownerPersonId });
			}
		}
		return {
			table: args.table,
			dryRun: args.dryRun,
			scanned: page.page.length,
			updated,
			inSync,
			noAgent,
			missingAgent,
			isDone: page.isDone,
			continueCursor: page.continueCursor,
		};
	},
});
