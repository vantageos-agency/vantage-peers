import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { requireResolvedCaller, withOrgScope } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// Store stats (internal mutation — called from the action)
// ─────────────────────────────────────────────────────────────────────────────

export const upsertStats = internalMutation({
	args: {
		repo: v.string(),
		date: v.string(),
		totalIssues: v.number(),
		resolvedIssues: v.number(),
		medianTimeToFirstResponse: v.optional(v.number()),
		medianTimeToFix: v.optional(v.number()),
		fastestResolution: v.optional(v.number()),
		slowestResolution: v.optional(v.number()),
		avgTimeToFix: v.optional(v.number()),
		beforeVantageOS: v.optional(v.object({
			totalIssues: v.number(),
			resolvedIssues: v.number(),
			medianTimeToFix: v.optional(v.number()),
			avgTimeToFix: v.optional(v.number()),
		})),
		afterVantageOS: v.optional(v.object({
			totalIssues: v.number(),
			resolvedIssues: v.number(),
			medianTimeToFix: v.optional(v.number()),
			avgTimeToFix: v.optional(v.number()),
		})),
		issueDetails: v.optional(
			v.array(
				v.object({
					number: v.number(),
					title: v.string(),
					timeToFirstResponse: v.optional(v.number()),
					timeToFix: v.optional(v.number()),
					status: v.string(),
				}),
			),
		),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("issueStats")
			.withIndex("by_repo_date", (q) =>
				q.eq("repo", args.repo).eq("date", args.date),
			)
			.unique();

		if (existing) {
			await ctx.db.patch(existing._id, {
				...args,
				calculatedAt: Date.now(),
			});
		} else {
			await ctx.db.insert("issueStats", {
				...args,
				calculatedAt: Date.now(),
			});
		}
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper query to get active repos
// ─────────────────────────────────────────────────────────────────────────────

export const listActiveRepos = internalQuery({
	args: {},
	returns: v.array(v.object({ repo: v.string() })),
	handler: async (ctx) => {
		const mappings = await ctx.db
			.query("githubRepoMapping")
			.filter((q) => q.eq(q.field("active"), true))
			.take(50);
		const seen = new Set<string>();
		return mappings
			.filter((m) => {
				if (seen.has(m.repo)) return false;
				seen.add(m.repo);
				return true;
			})
			.map((m) => ({ repo: m.repo }));
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Public query — read stats (for dashboard / sales page)
// returns-projection: dashboard summary rows omit issueDetails, the bulky per-issue array; not needed for the daily trend view
// ─────────────────────────────────────────────────────────────────────────────
export const getLatest = query({
	args: {
		repo: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("issueStats"),
			_creationTime: v.number(),
			repo: v.string(),
			date: v.string(),
			totalIssues: v.number(),
			resolvedIssues: v.number(),
			medianTimeToFirstResponse: v.optional(v.number()),
			medianTimeToFix: v.optional(v.number()),
			fastestResolution: v.optional(v.number()),
			slowestResolution: v.optional(v.number()),
			avgTimeToFix: v.optional(v.number()),
			beforeVantageOS: v.optional(v.object({
				totalIssues: v.number(),
				resolvedIssues: v.number(),
				medianTimeToFix: v.optional(v.number()),
				avgTimeToFix: v.optional(v.number()),
			})),
			afterVantageOS: v.optional(v.object({
				totalIssues: v.number(),
				resolvedIssues: v.number(),
				medianTimeToFix: v.optional(v.number()),
				avgTimeToFix: v.optional(v.number()),
			})),
			calculatedAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		// Fail-closed READ. Measured against LIVE production at commit bd8c60e9:
		// 30 `issueStats` rows served to a caller presenting NO CREDENTIAL AT ALL —
		// no identity was consulted. The WRITE side of this table is
		// `upsertStats`, an `internalMutation` (structurally unreachable from
		// `api.*`), so this READ was the only public door and it had no lock.
		// `issueStats` carries no orgId column: it aggregates the FLEET's own
		// GitHub repositories' throughput — commercially meaningful metrics that
		// are the fleet's, never a tenant's. Master only, matching the internal-
		// only write.
		// REFUSAL SHAPE — typed empty, never a throw: reactively-subscribed public
		// READ, and a throw crashes the subscriber's render (R-50/R-51).
		//
		// REFUSAL SHAPE, CORRECTED (task k177hpz3cx9bb842tc9201wf118f94sa). The
		// paragraph above reasoned correctly about R-50 and then drew the wrong
		// conclusion for the ANONYMOUS pole. A caller with no credential at all
		// has no mounted render for a throw to crash: the only subscribing
		// consumer of this backend is the vantage-peers-dashboard Next.js app,
		// every route of which sits behind `clerkMiddleware`, so no `useQuery`
		// subscription is ever established without a Clerk session. Returning an
		// empty SUCCESS to that caller is the defect — "you may not" and "there is
		// nothing" come out as identical bytes, and a guard reading this door
		// cannot tell a refusal from an absence. `missions:list` has raised
		// RBAC_DENIED at this same pole in production all along while being
		// reactively subscribed (components/missions/mission-board.tsx:25).
		// See `.claude/rules/refusal-is-distinguishable-from-absence.md`.
		// isolation-contract: no reactive subscriber. Enumerated by command against
		// the only subscribing consumer (vantage-peers-dashboard):
		//   grep -rn "api\.issueStatsQueries\." --include=*.tsx app components hooks lib → 0 hits.
		// So `alsoRefusePreOrg` is safe: there is no mounted render for the
		// signed-in-but-not-yet-onboarded caller's throw to crash, and that caller
		// must not be handed a fabricated absence either.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(scope, "issueStatsQueries:getLatest", {
			alsoRefusePreOrg: true,
		});
		if (!scope.isMaster) return [];

		const limit = args.limit ?? 30;
		let results;
		if (args.repo) {
			results = await ctx.db
				.query("issueStats")
				.withIndex("by_repo_date", (qb) => qb.eq("repo", args.repo!))
				.order("desc")
				.take(limit);
		} else {
			results = await ctx.db.query("issueStats").order("desc").take(limit);
		}
		return results.map(({ issueDetails, ...rest }) => rest);
	},
});
