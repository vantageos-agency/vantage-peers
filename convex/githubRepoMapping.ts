import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
	type QueryCtx,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "./_generated/server";
import { requireResolvedCaller, withOrgScope } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// Auth — fleet-internal surface, no per-org owner field
// (.claude/rules/authority-attached-to-anonymous-object.md)
//
// `githubRepoMapping` routes webhook events to an orchestrator fleet-wide —
// it has no `orgId`/owner field, and no client_org_mapping `scopes` entry
// exists for "manage webhook routing". `add`/`remove` used to take NO
// identity check at all. Same closure as convex/issues.ts's
// `requireMasterScope` (mirrors convex/orgRoster.ts's
// `getForAccessToken` idiom) — master-only, no org-scope fallback.
// ─────────────────────────────────────────────────────────────────────────────

async function requireMasterScope(ctx: Parameters<typeof withOrgScope>[0]) {
	const scope = await withOrgScope(ctx);
	if (!scope.isMaster) {
		throw new ConvexError(
			"RBAC_DENIED: this mutation requires master or service-account scope " +
				"— fleet webhook-routing config has no org-scoped write authority.",
		);
	}
}

const repoMappingDocOrNull = v.union(
	v.object({
		_id: v.id("githubRepoMapping"),
		_creationTime: v.number(),
		repo: v.string(),
		orchestrator: v.string(),
		project: v.string(),
		active: v.boolean(),
		lastDeployedSHA: v.optional(v.string()),
		lastDeployedAt: v.optional(v.number()),
	}),
	v.null(),
);

// Shared body of the public door and its internal twin — one lookup, two
// admission rules.
async function lookupByRepo(
	ctx: QueryCtx,
	repo: string,
): Promise<Doc<"githubRepoMapping"> | null> {
	return await ctx.db
		.query("githubRepoMapping")
		.withIndex("by_repo", (q) => q.eq("repo", repo))
		.unique();
}

// Public door. Fleet-master only: the table has no orgId column (it maps the
// FLEET's own repositories to orchestrators), so there is no tenant predicate
// to scope by — same admission as `list`, `add` and `remove` in this file.
// An ordinary org member is REFUSED by raising (`masterOnly`), never answered
// with a null that would read as "no such repo".
// isolation-contract: no reactive subscriber. Enumerated by command against
// the only subscribing consumer (vantage-peers-dashboard):
//   grep -rn "api\.githubRepoMapping\." --include=*.tsx --include=*.ts app components hooks lib → 0 hits.
// So `alsoRefusePreOrg` is safe: no mounted render exists for the throw to crash.
// Server-side callers (convex/http.ts webhook, convex/issues.ts) run with NO
// identity and use `getByRepoInternal` below.
export const getByRepo = query({
	args: { repo: v.string() },
	returns: repoMappingDocOrNull,
	handler: async (ctx, args) => {
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(scope, "githubRepoMapping:getByRepo", {
			alsoRefusePreOrg: true,
			masterOnly: true,
		});
		return await lookupByRepo(ctx, args.repo);
	},
});

// Internal twin — callable only from other Convex functions (the HMAC-verified
// GitHub webhook in convex/http.ts, convex/issues.ts upsertFromGitHub). Not
// reachable from the public internet, so it carries no caller identity check.
export const getByRepoInternal = internalQuery({
	args: { repo: v.string() },
	returns: repoMappingDocOrNull,
	handler: async (ctx, args) => {
		return await lookupByRepo(ctx, args.repo);
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
		// Fail-closed READ counterpart of this file's own master-only WRITE gate
		// (`requireMasterScope`, used by `add`/`remove`). Measured against LIVE
		// production at commit bd8c60e9: this query served a row to a caller
		// presenting NO CREDENTIAL AT ALL. `githubRepoMapping` carries no orgId
		// column — it maps the FLEET's own repositories to orchestrators, and it
		// discloses the private repository inventory plus each repo's most recent
		// production-deployed SHA. Master only, exactly as the writes already are.
		// REFUSAL SHAPE — the typed empty ENVELOPE (`items: []`, `nextCursor:
		// null`), never a throw: reactively-subscribed public READ, and a throw
		// crashes the subscriber's render (R-50/R-51). The envelope shape is
		// returned rather than a bare `[]` so the refusal still satisfies the
		// declared `returns` validator.
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
		//   grep -rn "api\.githubRepoMapping\." --include=*.tsx app components hooks lib → 0 hits.
		// So `alsoRefusePreOrg` is safe: there is no mounted render for the
		// signed-in-but-not-yet-onboarded caller's throw to crash, and that caller
		// must not be handed a fabricated absence either.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(scope, "githubRepoMapping:list", {
			alsoRefusePreOrg: true,
		});
		if (!scope.isMaster) return { items: [], nextCursor: null };

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
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("githubRepoMapping:add", …) at mcp-server/src/tools.ts:7892 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); never a subscribing pre-org client shell. The no-org throw is a refusal at an imperative MCP call, never at a render.
		await requireMasterScope(ctx);
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
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("githubRepoMapping:remove", …) at mcp-server/src/tools.ts:8085 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); never a subscribing pre-org client shell. The no-org throw is a refusal at an imperative MCP call, never at a render.
		await requireMasterScope(ctx);
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
//
// INTERNAL — zero callers enumerated anywhere in mcp-server/ or
// vantage-peers-dashboard (grepped both; only referenced from this file's
// own former doc-comment example). Converted to internalMutation — no
// external caller needs public reachability today. Invoke via
// `npx convex run githubRepoMapping:seed '{"mappings": [...]}'` (CLI-
// authenticated deploy key) or from another Convex function.
export const seed = internalMutation({
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
