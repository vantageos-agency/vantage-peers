// ─────────────────────────────────────────────────────────────────────────────
// moveRepoMappingToOrg — re-key a routing row to the organisation that owns the repo.
// (task k170nabwrnahjcey4zayn7an3h8jxjg5)
//
// WHY. A client's repositories are routed in THAT client's org, never the operator's:
// they are owned elsewhere, not out of scope. A row the operator org holds for a
// client names agents of the client org (no active match in the operator org), so
// the client org cannot read its own route and an adopted operator org cannot judge it.
//
// HOW. The OPERATOR supplies the map:
// `rows: [{ repo, toClerkOrgId, orchestratorAgentId, reviewerAgentId?, fallbackReviewerAgentId? }]`.
// Nothing is looked up by name. The target org is read by its permanent id; each agent
// is read BY ID and must be an active agent of the TARGET org (the package's `sameOrg`).
// The existing row is RE-KEYED (orgId / clerkOrgId of the target) and given the IDs:
// one row per repo, never duplicated, never created. A reviewer ID is accepted only for
// a row that names a reviewer label (same for the fallback). Any failed check refuses
// that row and changes nothing for it.
//
// SHAPE. DRY RUN BY DEFAULT: nothing is written unless `apply: true`.
// REVERSIBLE: `apply` returns `moved` ({ id, prior }); `revert` restores exactly that
// prior org and those prior ID fields on exactly those rows.
//
// OPERATING (internal — `convex run`, deployment admin credential; not reachable
// from any client, hence no per-caller auth check):
//   migrations/moveRepoMappingToOrg:run '{"rows":[…]}'                dry run
//   migrations/moveRepoMappingToOrg:run '{"apply":true,"rows":[…]}'   after reading it
//   migrations/moveRepoMappingToOrg:revert '{"moved":[…]}'            undo, from the apply's `moved`
// NOT RUN AGAINST ANY DEPLOYMENT BY ITS AUTHOR.
// ─────────────────────────────────────────────────────────────────────────────

import { sameOrg } from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";

const MAX_ROWS = 100;

type Field = "orchestratorAgentId" | "reviewerAgentId" | "fallbackReviewerAgentId";

const fieldValidator = v.union(
	v.literal("orchestratorAgentId"),
	v.literal("reviewerAgentId"),
	v.literal("fallbackReviewerAgentId"),
);

const priorValidator = v.object({
	orgId: v.optional(v.string()),
	clerkOrgId: v.optional(v.string()),
	orchestratorAgentId: v.optional(v.id("agents")),
	reviewerAgentId: v.optional(v.id("agents")),
	fallbackReviewerAgentId: v.optional(v.id("agents")),
});

const movedValidator = v.object({
	id: v.id("githubRepoMapping"),
	prior: priorValidator,
});

const REASON = v.union(
	v.literal("target-org-not-found"),
	v.literal("agent-not-in-org"),
	v.literal("no-label-for-role"),
);

export const run = internalMutation({
	args: {
		apply: v.optional(v.boolean()),
		rows: v.array(
			v.object({
				repo: v.string(),
				toClerkOrgId: v.string(),
				orchestratorAgentId: v.id("agents"),
				reviewerAgentId: v.optional(v.id("agents")),
				fallbackReviewerAgentId: v.optional(v.id("agents")),
			}),
		),
	},
	returns: v.object({
		mode: v.union(v.literal("dry-run"), v.literal("applied")),
		moved: v.array(movedValidator),
		unchanged: v.array(v.string()),
		refused: v.array(
			v.object({
				repo: v.string(),
				reason: REASON,
				role: v.optional(fieldValidator),
				agentId: v.optional(v.id("agents")),
			}),
		),
		unknownRepos: v.array(v.string()),
	}),
	handler: async (ctx, args) => {
		if (args.rows.length > MAX_ROWS) {
			throw new ConvexError(
				`TOO_MANY_ROWS: at most ${MAX_ROWS} rows per call, got ${args.rows.length}`,
			);
		}
		const apply = args.apply === true;
		const moved: Array<{ id: Id<"githubRepoMapping">; prior: Partial<Doc<"githubRepoMapping">> }> = [];
		const unchanged: string[] = [];
		const refused: Array<{
			repo: string;
			reason: "target-org-not-found" | "agent-not-in-org" | "no-label-for-role";
			role?: Field;
			agentId?: Id<"agents">;
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
			const target = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", input.toClerkOrgId))
				.unique();
			if (target === null) {
				refused.push({ repo: input.repo, reason: "target-org-not-found" });
				continue;
			}
			const targetRef = { id: target.clerkOrgId, label: target.clerkOrgSlug };
			const wanted: Array<[Field, string | undefined, Id<"agents"> | undefined]> = [
				["orchestratorAgentId", row.orchestrator, input.orchestratorAgentId],
				["reviewerAgentId", row.reviewer, input.reviewerAgentId],
				["fallbackReviewerAgentId", row.fallbackReviewer, input.fallbackReviewerAgentId],
			];
			let ok = true;
			const ids: Partial<Record<Field, Id<"agents">>> = {};
			for (const [role, label, given] of wanted) {
				if (given === undefined) continue;
				if (label === undefined) {
					refused.push({ repo: input.repo, reason: "no-label-for-role", role, agentId: given });
					ok = false;
					break;
				}
				const agent = await ctx.db.get(given);
				if (
					agent === null ||
					!agent.isActive ||
					!sameOrg({ id: agent.clerkOrgId, label: agent.orgSlug }, targetRef)
				) {
					refused.push({ repo: input.repo, reason: "agent-not-in-org", role, agentId: given });
					ok = false;
					break;
				}
				ids[role] = given;
			}
			if (!ok) continue;
			if (sameOrg({ id: row.clerkOrgId, label: row.orgId }, targetRef)) {
				unchanged.push(input.repo);
				continue;
			}
			const prior = {
				orgId: row.orgId,
				clerkOrgId: row.clerkOrgId,
				orchestratorAgentId: row.orchestratorAgentId,
				reviewerAgentId: row.reviewerAgentId,
				fallbackReviewerAgentId: row.fallbackReviewerAgentId,
			};
			if (apply) {
				await ctx.db.patch(row._id, {
					orgId: target.clerkOrgSlug,
					clerkOrgId: target.clerkOrgId,
					...ids,
				});
			}
			moved.push({ id: row._id, prior });
		}
		return {
			mode: apply ? ("applied" as const) : ("dry-run" as const),
			moved,
			unchanged,
			refused,
			unknownRepos,
		};
	},
});

export const revert = internalMutation({
	args: { moved: v.array(movedValidator) },
	returns: v.object({ reverted: v.number() }),
	handler: async (ctx, args) => {
		let reverted = 0;
		for (const { id, prior } of args.moved) {
			const row = await ctx.db.get(id);
			if (row === null) continue;
			await ctx.db.patch(id, {
				orgId: prior.orgId,
				clerkOrgId: prior.clerkOrgId,
				orchestratorAgentId: prior.orchestratorAgentId,
				reviewerAgentId: prior.reviewerAgentId,
				fallbackReviewerAgentId: prior.fallbackReviewerAgentId,
			});
			reverted += 1;
		}
		return { reverted };
	},
});
