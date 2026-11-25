// ─────────────────────────────────────────────────────────────────────────────
// stampRepoMappingAgentIds — give existing routing rows the agent IDs of their labels.
// (mission k577f8ksjx5ec3gq9bggc1brqd8jwkbh, S2; task k1730d1b6wzwepjyyth266xq958jxfv0)
//
// WHY. An organisation that adopted explicit review routing has a task's assignee
// compared with the AGENT IDs a `githubRepoMapping` row stores
// (`orchestratorAgentId`, `reviewerAgentId`, `fallbackReviewerAgentId`), never with
// its labels (convex/lib/taskRouting.ts). A row written before those fields existed
// carries labels only and is refused (`route-has-no-agent-ids`) until it is stamped.
//
// HOW. For every row, each label whose ID is missing is looked up as an active agent
// of the ROW'S OWN org (its `orgId`; an unstamped fleet row is the operator org's).
// A label that names no active agent there is LISTED (`unresolved`) and left alone:
// nothing is guessed. A stored ID is never overwritten.
//
// SHAPE. DRY RUN BY DEFAULT: nothing is written unless `apply: true`. Paged by
// `cursor` (`next` is the cursor of the following call, null when done).
// REVERSIBLE: `apply` returns `stamped` ({ id, fields }); `revert` clears exactly
// those fields on exactly those rows.
//
// OPERATING (internal — `convex run`, deployment admin credential; not reachable
// from any client, hence no per-caller auth check):
//   migrations/stampRepoMappingAgentIds:run '{}'                       dry run
//   migrations/stampRepoMappingAgentIds:run '{"apply":true}'           after reading it
//   migrations/stampRepoMappingAgentIds:revert '{"stamped":[…]}'       undo, from the apply's `stamped`
// NOT RUN AGAINST ANY DEPLOYMENT BY ITS AUTHOR.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import { findOperatorOrg } from "../lib/operatorOrg";

const BATCH = 200;

type Field = "orchestratorAgentId" | "reviewerAgentId" | "fallbackReviewerAgentId";
const fieldValidator = v.union(
	v.literal("orchestratorAgentId"),
	v.literal("reviewerAgentId"),
	v.literal("fallbackReviewerAgentId"),
);

const stampedValidator = v.object({
	id: v.id("githubRepoMapping"),
	fields: v.array(fieldValidator),
});

export const run = internalMutation({
	args: { apply: v.optional(v.boolean()), cursor: v.optional(v.string()) },
	returns: v.object({
		mode: v.union(v.literal("dry-run"), v.literal("applied")),
		read: v.number(),
		next: v.union(v.string(), v.null()),
		stamped: v.array(stampedValidator),
		unresolved: v.array(
			v.object({ repo: v.string(), role: fieldValidator, label: v.string() }),
		),
	}),
	handler: async (ctx, args) => {
		const apply = args.apply === true;
		const operator = await findOperatorOrg(ctx.db);
		const operatorSlug = operator.kind === "one" ? operator.slug : undefined;
		const page = await ctx.db
			.query("githubRepoMapping")
			.paginate({ numItems: BATCH, cursor: args.cursor ?? null });
		const stamped: Array<{ id: Id<"githubRepoMapping">; fields: Field[] }> = [];
		const unresolved: Array<{ repo: string; role: Field; label: string }> = [];
		for (const row of page.page) {
			const orgSlug = row.orgId ?? operatorSlug;
			const wanted: Array<[Field, string | undefined, Id<"agents"> | undefined]> = [
				["orchestratorAgentId", row.orchestrator, row.orchestratorAgentId],
				["reviewerAgentId", row.reviewer, row.reviewerAgentId],
				["fallbackReviewerAgentId", row.fallbackReviewer, row.fallbackReviewerAgentId],
			];
			const patch: Partial<Doc<"githubRepoMapping">> = {};
			const fields: Field[] = [];
			for (const [role, label, existing] of wanted) {
				if (label === undefined || existing !== undefined) continue;
				const agent =
					orgSlug === undefined
						? null
						: await ctx.db
								.query("agents")
								.withIndex("by_org_normalized_name", (q) =>
									q.eq("orgSlug", orgSlug).eq("normalizedName", normalizeOrchestratorId(label)),
								)
								.first();
				if (agent === null || !agent.isActive) {
					unresolved.push({ repo: row.repo, role, label });
					continue;
				}
				patch[role] = agent._id;
				fields.push(role);
			}
			if (fields.length === 0) continue;
			if (apply) await ctx.db.patch(row._id, patch);
			stamped.push({ id: row._id, fields });
		}
		return {
			mode: apply ? ("applied" as const) : ("dry-run" as const),
			read: page.page.length,
			next: page.isDone ? null : page.continueCursor,
			stamped,
			unresolved,
		};
	},
});

export const revert = internalMutation({
	args: { stamped: v.array(stampedValidator) },
	returns: v.object({ reverted: v.number() }),
	handler: async (ctx, args) => {
		let reverted = 0;
		for (const { id, fields } of args.stamped) {
			const row = await ctx.db.get(id);
			if (row === null) continue;
			const patch: Partial<Record<Field, undefined>> = {};
			for (const f of fields) patch[f] = undefined;
			await ctx.db.patch(id, patch);
			reverted += 1;
		}
		return { reverted };
	},
});
