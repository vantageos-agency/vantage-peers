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
// prior org and those prior ID fields on exactly those rows (walking `moved` newest first).
// A role ID the input does not supply is cleared on the moved row, never kept from the old org.
// A repo named twice in one call is refused (`duplicate-repo`) for every occurrence.
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
import { orgMappingLookups } from "../lib/authOrgMapping";

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
	v.literal("duplicate-repo"),
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
			reason: "target-org-not-found" | "agent-not-in-org" | "no-label-for-role" | "duplicate-repo";
			role?: Field;
			agentId?: Id<"agents">;
		}> = [];
		const unknownRepos: string[] = [];
		// A repo named twice in one call is ambiguous (chained priors, an order-dependent end
		// state): every occurrence is refused before anything is read or written.
		const seen = new Map<string, number>();
		for (const input of args.rows) seen.set(input.repo, (seen.get(input.repo) ?? 0) + 1);
		for (const input of args.rows) {
			if ((seen.get(input.repo) ?? 0) > 1) {
				refused.push({ repo: input.repo, reason: "duplicate-repo" });
				continue;
			}
			const row = await ctx.db
				.query("githubRepoMapping")
				.withIndex("by_repo", (q) => q.eq("repo", input.repo))
				.unique();
			if (row === null) {
				unknownRepos.push(input.repo);
				continue;
			}
			// The target org is read through the org-ID adapter (permanent id), never the table.
			const target = await orgMappingLookups(ctx).orgById(input.toClerkOrgId);
			if (target === null || target === undefined) {
				refused.push({ repo: input.repo, reason: "target-org-not-found" });
				continue;
			}
			const targetRef = { id: target.id, label: target.label };
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
					orgId: target.label,
					clerkOrgId: input.toClerkOrgId,
					// A role the input does not supply is CLEARED: the moved row carries only IDs
					// validated in the target org. The prior (recorded above) restores them.
					orchestratorAgentId: ids.orchestratorAgentId,
					reviewerAgentId: ids.reviewerAgentId,
					fallbackReviewerAgentId: ids.fallbackReviewerAgentId,
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
		// Newest first: each prior is the state BEFORE its move, so a reverse walk lands on the oldest.
		for (const { id, prior } of [...args.moved].reverse()) {
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
