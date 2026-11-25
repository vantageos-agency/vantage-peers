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
// HOW. The OPERATOR supplies the map (built from list_peers + list_repo_mappings):
// `rows: [{ repo, orchestratorAgentId, reviewerAgentId?, fallbackReviewerAgentId? }]`.
// Nothing is looked up by name. Each ID is read BY ID and must be an active agent of
// the row's own org (an unstamped fleet row is the operator org's). A reviewer ID is
// accepted only for a row that names a reviewer label (same for the fallback). An ID
// the row already stores is left alone; a DIFFERENT stored ID is refused (change it
// with `add_repo_mapping`, which restates the IDs).
//
// SHAPE. DRY RUN BY DEFAULT: nothing is written unless `apply: true`. The answer
// lists what it stamped, what it refused and why, the input repos that have no row,
// and the rows of the table that carry a label with no stored ID and are NOT in the
// input (`absentFromInput`, at most SCAN rows read).
// REVERSIBLE: `apply` returns `stamped` ({ id, fields }); `revert` clears exactly
// those fields on exactly those rows.
//
// OPERATING (internal — `convex run`, deployment admin credential; not reachable
// from any client, hence no per-caller auth check):
//   migrations/stampRepoMappingAgentIds:run '{"rows":[…]}'                  dry run
//   migrations/stampRepoMappingAgentIds:run '{"apply":true,"rows":[…]}'     after reading it
//   migrations/stampRepoMappingAgentIds:revert '{"stamped":[…]}'            undo, from the apply's `stamped`
// NOT RUN AGAINST ANY DEPLOYMENT BY ITS AUTHOR.
// ─────────────────────────────────────────────────────────────────────────────

import { sameOrg } from "@vantageos/cloud-identity";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { findOperatorOrg } from "../lib/operatorOrg";

const MAX_ROWS = 200;
const SCAN = 2000;

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

const rowInput = v.object({
	repo: v.string(),
	orchestratorAgentId: v.id("agents"),
	reviewerAgentId: v.optional(v.id("agents")),
	fallbackReviewerAgentId: v.optional(v.id("agents")),
});

const REFUSAL = v.union(
	v.literal("no-label-for-role"),
	v.literal("agent-not-in-org"),
	v.literal("stored-id-differs"),
);

export const run = internalMutation({
	args: { apply: v.optional(v.boolean()), rows: v.array(rowInput) },
	returns: v.object({
		mode: v.union(v.literal("dry-run"), v.literal("applied")),
		stamped: v.array(stampedValidator),
		refused: v.array(
			v.object({
				repo: v.string(),
				role: fieldValidator,
				agentId: v.id("agents"),
				reason: REFUSAL,
			}),
		),
		unknownRepos: v.array(v.string()),
		absentFromInput: v.array(v.string()),
	}),
	handler: async (ctx, args) => {
		if (args.rows.length > MAX_ROWS) {
			throw new Error(`TOO_MANY_ROWS: at most ${MAX_ROWS} rows per call, got ${args.rows.length}`);
		}
		const apply = args.apply === true;
		const operator = await findOperatorOrg(ctx.db);
		const stamped: Array<{ id: Id<"githubRepoMapping">; fields: Field[] }> = [];
		const refused: Array<{
			repo: string;
			role: Field;
			agentId: Id<"agents">;
			reason: "no-label-for-role" | "agent-not-in-org" | "stored-id-differs";
		}> = [];
		const unknownRepos: string[] = [];
		for (const input of args.rows) {
			const row = await ctx.db
				.query("githubRepoMapping")
				.withIndex("by_repo", (q) => q.eq("repo", input.repo))
				.unique();
			if (row === null) {
				unknownRepos.push(input.repo);
				continue;
			}
			// The org the row belongs to: its own stamp, else the operator org's.
			const rowOrg =
				row.orgId !== undefined || row.clerkOrgId !== undefined
					? { id: row.clerkOrgId, label: row.orgId }
					: operator.kind === "one"
						? { id: operator.clerkOrgId, label: operator.slug }
						: null;
			const wanted: Array<[Field, string | undefined, Id<"agents"> | undefined, Id<"agents"> | undefined]> = [
				["orchestratorAgentId", row.orchestrator, input.orchestratorAgentId, row.orchestratorAgentId],
				["reviewerAgentId", row.reviewer, input.reviewerAgentId, row.reviewerAgentId],
				[
					"fallbackReviewerAgentId",
					row.fallbackReviewer,
					input.fallbackReviewerAgentId,
					row.fallbackReviewerAgentId,
				],
			];
			const patch: Partial<Doc<"githubRepoMapping">> = {};
			const fields: Field[] = [];
			for (const [role, label, given, stored] of wanted) {
				if (given === undefined) continue;
				if (label === undefined) {
					refused.push({ repo: input.repo, role, agentId: given, reason: "no-label-for-role" });
					continue;
				}
				const agent = await ctx.db.get(given);
				const inOrg =
					agent !== null &&
					rowOrg !== null &&
					sameOrg({ id: agent.clerkOrgId, label: agent.orgSlug }, rowOrg);
				if (agent === null || !agent.isActive || !inOrg) {
					refused.push({ repo: input.repo, role, agentId: given, reason: "agent-not-in-org" });
					continue;
				}
				if (stored !== undefined) {
					if (stored !== given) {
						refused.push({ repo: input.repo, role, agentId: given, reason: "stored-id-differs" });
					}
					continue;
				}
				patch[role] = given;
				fields.push(role);
			}
			if (fields.length === 0) continue;
			if (apply) await ctx.db.patch(row._id, patch);
			stamped.push({ id: row._id, fields });
		}
		const given = new Set(args.rows.map((r) => r.repo));
		const absentFromInput: string[] = [];
		for (const row of await ctx.db.query("githubRepoMapping").take(SCAN)) {
			if (given.has(row.repo)) continue;
			const missing =
				row.orchestratorAgentId === undefined ||
				(row.reviewer !== undefined && row.reviewerAgentId === undefined) ||
				(row.fallbackReviewer !== undefined && row.fallbackReviewerAgentId === undefined);
			if (missing) absentFromInput.push(row.repo);
		}
		return {
			mode: apply ? ("applied" as const) : ("dry-run" as const),
			stamped,
			refused,
			unknownRepos,
			absentFromInput,
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
