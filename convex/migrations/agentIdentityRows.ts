/**
 * Agent identity by row — rollout backfills for two optional fields.
 *
 *   agents.normalizedName           (the per-org uniqueness key)
 *   agent_credentials.agentId       (the credential's identity: the agents row)
 *
 * INTERNAL ONLY — never client-facing, never run automatically. Operator-run,
 * cursor-paged, DRY-RUN FIRST (same shape as memberScopesMigration.ts):
 *
 *   npx convex run migrations/agentIdentityRows:backfillAgentNormalizedNames \
 *     '{"dryRun":true,"cursor":null}'
 *   npx convex run migrations/agentIdentityRows:backfillCredentialAgentIds \
 *     '{"dryRun":true,"cursor":null}'
 *
 * Repeat each with `cursor` = the returned `continueCursor` until `isDone`.
 * Run the names backfill first; the two are independent but the report of the
 * first tells the operator which agents collide before any credential is tied.
 *
 * Guarantees (both):
 *  - IDEMPOTENT: a row already carrying the field is counted, never rewritten.
 *  - REFUSES, NEVER GUESSES: a row that cannot be resolved to exactly one
 *    agent is COUNTED (`missingAgent` / `ambiguous` / `collisions`) and left
 *    untouched, so an operator reads the count instead of finding a wrong id.
 *  - dryRun writes nothing and reports what a real run would do.
 *  - Bounded: at most `batchSize` (default 100, max 200) rows per call.
 */
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";

const DEFAULT_BATCH = 100;
const MAX_BATCH = 200;
/**
 * Most agents of one org the clash check reads (R-31). An org with more is
 * not guessed at: the row is COUNTED as a collision and left untouched, the
 * same refuse-never-guess outcome as a real clash.
 */
export const AGENT_ROSTER_SCAN_CAP = 500;

function checkBatch(batchSize: number): void {
	if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH) {
		throw new Error(
			`batchSize = ${batchSize} is out of expected range 1-${MAX_BATCH}.`,
		);
	}
}

export const backfillAgentNormalizedNames = internalMutation({
	args: {
		dryRun: v.boolean(),
		cursor: v.union(v.string(), v.null()),
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		dryRun: v.boolean(),
		scanned: v.number(),
		updated: v.number(),
		alreadySet: v.number(),
		collisions: v.number(),
		isDone: v.boolean(),
		continueCursor: v.string(),
	}),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? DEFAULT_BATCH;
		checkBatch(batchSize);
		const page = await ctx.db
			.query("agents")
			.paginate({ numItems: batchSize, cursor: args.cursor });

		let updated = 0;
		let alreadySet = 0;
		let collisions = 0;
		for (const row of page.page) {
			const normalized = normalizeOrchestratorId(row.name);
			if (row.normalizedName === normalized) {
				alreadySet += 1;
				continue;
			}
			// Two rows of one org that normalise equal: neither is patched. Which
			// of the two "owns" the name is an operator decision, not a guess.
			const roster = await ctx.db
				.query("agents")
				.withIndex("by_org", (q) => q.eq("orgSlug", row.orgSlug))
				.take(AGENT_ROSTER_SCAN_CAP + 1);
			const clash =
				roster.length > AGENT_ROSTER_SCAN_CAP ||
				roster.some(
				(other) =>
					other._id !== row._id &&
					normalizeOrchestratorId(other.name) === normalized,
				);
			if (clash) {
				collisions += 1;
				continue;
			}
			updated += 1;
			if (!args.dryRun) {
				await ctx.db.patch(row._id, { normalizedName: normalized });
			}
		}
		return {
			dryRun: args.dryRun,
			scanned: page.page.length,
			updated,
			alreadySet,
			collisions,
			isDone: page.isDone,
			continueCursor: page.continueCursor,
		};
	},
});

export const backfillCredentialAgentIds = internalMutation({
	args: {
		dryRun: v.boolean(),
		cursor: v.union(v.string(), v.null()),
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		dryRun: v.boolean(),
		scanned: v.number(),
		updated: v.number(),
		alreadySet: v.number(),
		missingAgent: v.number(),
		ambiguous: v.number(),
		isDone: v.boolean(),
		continueCursor: v.string(),
	}),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? DEFAULT_BATCH;
		checkBatch(batchSize);
		const page = await ctx.db
			.query("agent_credentials")
			.paginate({ numItems: batchSize, cursor: args.cursor });

		let updated = 0;
		let alreadySet = 0;
		let missingAgent = 0;
		let ambiguous = 0;
		for (const row of page.page) {
			if (row.agentId !== undefined) {
				alreadySet += 1;
				continue;
			}
			// The label recorded at mint time, exact: two candidates is ambiguous,
			// none is missing. Neither is patched.
			const candidates = await ctx.db
				.query("agents")
				.withIndex("by_org_name", (q) =>
					q.eq("orgSlug", row.orgSlug).eq("name", row.agentName),
				)
				.take(2);
			if (candidates.length === 0) {
				missingAgent += 1;
				continue;
			}
			if (candidates.length > 1) {
				ambiguous += 1;
				continue;
			}
			updated += 1;
			if (!args.dryRun) {
				await ctx.db.patch(row._id, { agentId: candidates[0]._id });
			}
		}
		return {
			dryRun: args.dryRun,
			scanned: page.page.length,
			updated,
			alreadySet,
			missingAgent,
			ambiguous,
			isDone: page.isDone,
			continueCursor: page.continueCursor,
		};
	},
});
