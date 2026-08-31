import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";

export const getByRepo = query({
	args: { repo: v.string() },
	handler: async (ctx, args) => {
		return await ctx.db
			.query("githubRepoMapping")
			.withIndex("by_repo", (q) => q.eq("repo", args.repo))
			.unique();
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list repo mappings with envelope safety, cursor paging, lite projection.
// PR-C envelope safety: { items, nextCursor } envelope, limit default 20,
// cap 200, fields=lite|full projection, cursor-based paging.
// ─────────────────────────────────────────────────────────────────────────────

const repoMappingFullObject = v.object({
	_id: v.id("githubRepoMapping"),
	_creationTime: v.number(),
	repo: v.string(),
	orchestrator: v.string(),
	project: v.string(),
	active: v.boolean(),
	lastDeployedSHA: v.optional(v.string()),
	lastDeployedAt: v.optional(v.number()),
});

const repoMappingLiteObject = v.object({
	_id: v.id("githubRepoMapping"),
	_creationTime: v.number(),
	repo: v.string(),
	orchestrator: v.string(),
	project: v.string(),
});

interface RepoCursorPayload {
	time: number;
	id: string;
}

function encodeRepoCursor(time: number, id: string): string {
	return btoa(JSON.stringify({ time, id }));
}

function decodeRepoCursor(cursor: string | undefined): RepoCursorPayload | undefined {
	if (!cursor) return undefined;
	try {
		const raw = atob(cursor);
		const parsed = JSON.parse(raw) as unknown;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"time" in parsed &&
			"id" in parsed &&
			typeof (parsed as Record<string, unknown>).time === "number" &&
			typeof (parsed as Record<string, unknown>).id === "string"
		) {
			return {
				time: (parsed as Record<string, unknown>).time as number,
				id: (parsed as Record<string, unknown>).id as string,
			};
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export const GITHUB_REPO_MAPPING_LIST_SCAN_CAP = 2000;

// returns-projection: fields="lite" returns a routing-view summary (repoMappingLiteObject), full mapping fetched via getByRepo
export const list = query({
	args: {
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
		limit: v.optional(v.number()),
		// back-compat: keep createdBefore accepted; cursor takes precedence when both passed
		createdBefore: v.optional(v.number()),
		cursor: v.optional(v.string()),
	},
	returns: v.object({
		items: v.union(v.array(repoMappingFullObject), v.array(repoMappingLiteObject)),
		nextCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const DEFAULT_LIMIT = 20;
		const CAP = 200;
		const fields = args.fields ?? "full";
		const requested = args.limit ?? DEFAULT_LIMIT;
		const limit = Math.max(1, Math.min(requested, CAP));

		// Decode cursor payload; fall back to createdBefore legacy anchor
		const cursorPayload = decodeRepoCursor(args.cursor);

		// PR #635 wide-scan-cap pattern (see convex/tasks.ts TASK_LIST_SCAN_CAP,
		// convex/profiles.ts PROFILES_LIST_SCAN_CAP, lot 1 mission k574p02m).
		// mission k574p02m DEFECT 2, lot 2 — the previous `limit * 4 + 10` fixed
		// multiplier is a FALLIBLE buffer: `.take(fetchLimit)` always re-reads
		// only the TOP `fetchLimit` rows of the WHOLE ordering (not an offset
		// continuation), so once the cursor anchor's true position exceeds this
		// fixed window the anchor is never found and the page comes back empty
		// before the true end. Widen the fetch to the shared scan cap.
		// mission k574p02m lot 2 — Eta REVISE: widen on EITHER cursor source.
		// The legacy `createdBefore` back-compat path also filters after
		// `.take(fetchLimit)`, so it must widen too or it undershoots deep
		// pages the same way the cursor path used to.
		const wide = cursorPayload !== undefined || args.createdBefore !== undefined;
		const fetchLimit = wide ? GITHUB_REPO_MAPPING_LIST_SCAN_CAP + 1 : limit + 1;

		let rows: Doc<"githubRepoMapping">[] = await ctx.db
			.query("githubRepoMapping")
			.order("desc")
			.take(fetchLimit);

		// Apply cursor filter: skip rows up to and including the anchor row.
		if (cursorPayload !== undefined) {
			let pastAnchor = false;
			rows = rows.filter((r) => {
				if (pastAnchor) return true;
				if (r._id === cursorPayload.id) {
					pastAnchor = true;
					return false; // skip the anchor row itself
				}
				return false; // skip rows before anchor (newer in desc order)
			});
		} else if (args.createdBefore !== undefined) {
			// Legacy back-compat: filter by createdBefore timestamp
			const before = args.createdBefore;
			rows = rows.filter((r) => r._creationTime < before);
		}

		// Detect next page
		const hasMore = rows.length > limit;
		const pageRows = rows.slice(0, limit);

		const nextCursor =
			hasMore || (cursorPayload !== undefined && pageRows.length === limit)
				? encodeRepoCursor(
						pageRows[pageRows.length - 1]._creationTime,
						pageRows[pageRows.length - 1]._id,
					)
				: null;

		// Apply projection
		if (fields === "lite") {
			const liteItems = pageRows.map((r) => ({
				_id: r._id,
				_creationTime: r._creationTime,
				repo: r.repo,
				orchestrator: r.orchestrator,
				project: r.project,
			}));
			return { items: liteItems, nextCursor };
		}

		return { items: pageRows, nextCursor };
	},
});

export const add = mutation({
	args: {
		repo: v.string(),
		orchestrator: v.string(),
		project: v.string(),
		active: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		// Upsert by repo
		const existing = await ctx.db
			.query("githubRepoMapping")
			.withIndex("by_repo", (q) => q.eq("repo", args.repo))
			.unique();
		if (existing) {
			await ctx.db.patch(existing._id, {
				orchestrator: args.orchestrator,
				project: args.project,
				active: args.active ?? true,
			});
			return existing._id;
		}
		return await ctx.db.insert("githubRepoMapping", {
			repo: args.repo,
			orchestrator: args.orchestrator,
			project: args.project,
			active: args.active ?? true,
		});
	},
});

export const remove = mutation({
	args: { repo: v.string() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("githubRepoMapping")
			.withIndex("by_repo", (q) => q.eq("repo", args.repo))
			.unique();
		if (existing) {
			await ctx.db.delete(existing._id);
			return { deleted: true };
		}
		return { deleted: false };
	},
});

// Day 98 (k173yr5n1) — Mechanism (a) Deploy dedup by SHA.
// Called after a successful `npx convex deploy --yes` to record the deployed
// commit SHA + timestamp. createDeployTaskWithDedup uses lastDeployedAt to
// skip per-PR Deploy task spawn when the PR was shipped via a bundled chain
// that completed AFTER the PR merged.
//
// Day 98 F2 — INTERNAL ONLY. Was public on first ship (PR #703) and Eta
// flagged DoS risk: an attacker who could call the public mutation would set
// lastDeployedAt = MAX and silently disable Deploy task spawn for the repo.
// Now internalMutation — only callable via `npx convex run` with the CLI-
// authenticated deploy key, or from another Convex function (cron, action).
// Idempotent: re-recording the same SHA + timestamp is a no-op.
export const recordDeployment = internalMutation({
	args: {
		repo: v.string(),
		sha: v.string(),
		// Optional override; defaults to Date.now(). Test convenience.
		deployedAt: v.optional(v.number()),
	},
	returns: v.union(v.id("githubRepoMapping"), v.null()),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("githubRepoMapping")
			.withIndex("by_repo", (q) => q.eq("repo", args.repo))
			.unique();
		if (!existing) return null;
		const at = args.deployedAt ?? Date.now();
		if (existing.lastDeployedSHA === args.sha && existing.lastDeployedAt === at) {
			return existing._id;
		}
		await ctx.db.patch(existing._id, {
			lastDeployedSHA: args.sha,
			lastDeployedAt: at,
		});
		return existing._id;
	},
});

// Seed initial data — accepts an array of repo mappings so callers supply their own repos.
// Example usage:
//   convex.mutation("githubRepoMapping:seed", {
//     mappings: [{ repo: "your-org/your-repo", orchestrator: "sigma", project: "my-project" }]
//   })
export const seed = mutation({
	args: {
		mappings: v.array(
			v.object({
				repo: v.string(),
				orchestrator: v.string(),
				project: v.string(),
			}),
		),
	},
	handler: async (ctx, args) => {
		let count = 0;
		for (const m of args.mappings) {
			const existing = await ctx.db
				.query("githubRepoMapping")
				.withIndex("by_repo", (q) => q.eq("repo", m.repo))
				.unique();
			if (!existing) {
				await ctx.db.insert("githubRepoMapping", { ...m, active: true });
				count++;
			}
		}
		return { seeded: count };
	},
});
