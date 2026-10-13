import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
	type QueryCtx,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "./_generated/server";
import {
	hasFleetRead,
	isServiceAccountScope,
	sameOrg,
} from "@vantageos/cloud-identity";
import { ownerOfRepo, repoOwnerBoundToOrg } from "./githubOwnerBinding";
import { orgRefOfRow, orgRefOfScope } from "./lib/authOrgMapping";
import {
	resolveVerifiedOrgScope,
	verifiedOrgValidator,
} from "./lib/verifiedOrg";
import {
	type OrgScope,
	requireOrchestratorOnRoster,
	requireResolvedCaller,
	requireScope,
	withOrgScope,
} from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// Auth — a tenant-owned surface (.claude/rules/authority-attached-to-anonymous-object.md)
//
// `githubRepoMapping` routes webhook events to an orchestrator. A row is the
// fleet's (no `orgId`) or a client org's (`orgId` stamped server-side); every
// door below decides from the verified scope (`withOrgScope`) and never from an
// argument. There is no master-only write gate any more: `add` / `remove` admit
// the fleet master for fleet rows and a member holding "manage-repo-mappings"
// for its own org's rows (`resolveWriteTenant`, `requireRowOwnedBy`).
// ─────────────────────────────────────────────────────────────────────────────

// WRITE TENANT. The tenant of a mapping row is derived HERE, from the verified
// scope, and nowhere else — no mutation in this file takes an `orgId` argument.
//   master / service account  -> undefined (a FLEET row)
//   org member                -> its own org slug, and only with the
//                                "manage-repo-mappings" scope on its mapping
// An unresolved caller or a signed-in caller with no organisation is refused.
function resolveWriteTenant(scope: OrgScope, door: string): string | undefined {
	// The fleet's own service account writes FLEET rows. That standing is the
	// package's verdict over the resolved scope; a bearer acting for a verified
	// org (`verifiedOrg`) arrives here as that org's ordinary member instead.
	if (isServiceAccountScope(scope)) return undefined;
	requireScope(scope, "manage-repo-mappings");
	if (scope.orgSlug === null) {
		throw new ConvexError(
			`RBAC_DENIED: ${door} needs an organisation to own the mapping — ${JSON.stringify({ door })}`,
		);
	}
	return scope.orgSlug;
}

// A member may touch only rows its own org owns. The fleet may touch any row
// (and never changes who owns it); that standing is the package's verdict.
function requireRowOwnedBy(
	scope: OrgScope,
	row: Doc<"githubRepoMapping">,
	door: string,
): void {
	if (hasFleetRead(scope)) return;
	if (!sameOrg(orgRefOfRow(row), orgRefOfScope(scope))) {
		throw new ConvexError(
			`RBAC_DENIED: ${door} — repo is not owned by org "${scope.orgSlug}" — ${JSON.stringify({ door, repo: row.repo })}`,
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
		reviewer: v.optional(v.string()),
		fallbackReviewer: v.optional(v.string()),
		orgId: v.optional(v.string()),
		clerkOrgId: v.optional(v.string()),
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

// Public door. Tenant-scoped like `list`, `add` and `remove` in this file: the
// fleet master reads any row; an org member reads ONLY a row its own org owns
// (`orgId` stamped server-side). A row that exists but is not the caller's (a
// fleet row or another org's) is REFUSED by raising, never answered with a
// null that would read as "no such repo"; a repo with no row at all is a null.
// isolation-contract: no reactive subscriber. Enumerated by command against
// the only subscribing consumer (vantage-peers-dashboard):
//   grep -rn "api\.githubRepoMapping\." --include=*.tsx --include=*.ts app components hooks lib → 0 hits.
// So `alsoRefusePreOrg` is safe: no mounted render exists for the throw to crash.
// Server-side callers (convex/http.ts webhook, convex/issues.ts) run with NO
// identity and use `getByRepoInternal` below.
// fleet-wide: a claimless service-account call is the fleet master reading the whole repo-mapping corpus, which is this door's purpose; a non-master bearer arrives with `verifiedOrg` (the MCP forwards it, and refuses a bearer whose organisation it cannot resolve before Convex) and is confined to that organisation's rows.
export const getByRepo = query({
	args: {
		repo: v.string(),
		// The organisation the MCP transport VERIFIED for a bearer that reaches
		// Convex as the fleet service account. Believed from the service account
		// only; the read then runs as that org's member (convex/lib/verifiedOrg.ts).
		verifiedOrg: v.optional(verifiedOrgValidator),
	},
	returns: repoMappingDocOrNull,
	handler: async (ctx, args) => {
		const door = "githubRepoMapping:getByRepo";
		const transportScope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(transportScope, door, { alsoRefusePreOrg: true });
		const scope = await resolveVerifiedOrgScope(
			ctx,
			transportScope,
			args.verifiedOrg,
			door,
		);
		const row = await lookupByRepo(ctx, args.repo);
		if (row === null) return null;
		requireRowOwnedBy(scope, row, door);
		return row;
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
	reviewer: v.optional(v.string()),
	fallbackReviewer: v.optional(v.string()),
	orgId: v.optional(v.string()),
	clerkOrgId: v.optional(v.string()),
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

// returns-projection: fields="lite" returns a routing-view summary (repoMappingLiteObject), full mapping fetched via getByRepo
// fleet-wide: a claimless service-account call is the fleet master reading the whole repo-mapping corpus, which is this door's purpose; a non-master bearer arrives with `verifiedOrg` (the MCP forwards it, and refuses a bearer whose organisation it cannot resolve before Convex) and is confined to that organisation's rows.
export const list = query({
	args: {
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
		limit: v.optional(v.number()),
		// back-compat: keep createdBefore accepted; cursor takes precedence when both passed
		createdBefore: v.optional(v.number()),
		cursor: v.optional(v.string()),
		// The organisation the MCP transport VERIFIED for a bearer that reaches
		// Convex as the fleet service account. Believed from the service account
		// only; the read then runs under that org's member scope, so the `by_org`
		// index range below IS the read (convex/lib/verifiedOrg.ts).
		verifiedOrg: v.optional(verifiedOrgValidator),
	},
	returns: v.object({
		items: v.union(v.array(repoMappingFullObject), v.array(repoMappingLiteObject)),
		nextCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		// Fail-closed READ counterpart of this file's WRITE gate
		// (`resolveWriteTenant`, used by `add`/`remove`). Measured against LIVE
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
		const transportScope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(transportScope, "githubRepoMapping:list", {
			alsoRefusePreOrg: true,
		});
		const scope = await resolveVerifiedOrgScope(
			ctx,
			transportScope,
			args.verifiedOrg,
			"githubRepoMapping:list",
		);
		// The fleet reads the whole corpus (the package's standing; the operator
		// human is the fleet for READS). An org member reads ONLY the rows its own
		// org owns (the server-stamped `orgId`), via the by_org index.
		const fleet = hasFleetRead(scope);
		const memberOrg = fleet ? null : scope.orgSlug;
		if (!fleet && memberOrg === null) return { items: [], nextCursor: null };

		const DEFAULT_LIMIT = 20;
		const CAP = 200;
		const fields = args.fields ?? "full";
		const requested = args.limit ?? DEFAULT_LIMIT;
		const limit = Math.max(1, Math.min(requested, CAP));

		// Decode cursor payload; fall back to createdBefore legacy anchor
		const cursorPayload = decodeRepoCursor(args.cursor);

		// The page is cut from a range that is already narrowed: the tenant (the
		// `by_org` index range) and the paging anchor (`_creationTime` is the last
		// key of every index) are part of the range itself, so a page is never cut
		// first and narrowed after. The cursor anchors on the creation time of the
		// last row served — a deleted anchor row cannot empty the next page. The
		// legacy `createdBefore` anchor is the same range bound; the cursor takes
		// precedence when both are passed.
		const anchor = cursorPayload?.time ?? args.createdBefore;
		const rows =
			memberOrg === null
				? await ctx.db
						.query("githubRepoMapping")
						.withIndex("by_creation_time", (q) =>
							anchor === undefined ? q : q.lt("_creationTime", anchor),
						)
						.order("desc")
						.take(limit + 1)
				: await ctx.db
						.query("githubRepoMapping")
						.withIndex("by_org", (q) => {
							const byOrg = q.eq("orgId", memberOrg);
							return anchor === undefined
								? byOrg
								: byOrg.lt("_creationTime", anchor);
						})
						.order("desc")
						.take(limit + 1);

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

// fleet-wide: a claimless service-account call is the fleet master maintaining the FLEET's repo mappings, which is this door's purpose; a non-master bearer arrives with `verifiedOrg` (the MCP forwards it, and refuses a bearer whose organisation it cannot resolve before Convex) and writes only its own organisation's rows.
export const add = mutation({
	args: {
		repo: v.string(),
		orchestrator: v.string(),
		project: v.string(),
		active: v.optional(v.boolean()),
		reviewer: v.optional(v.string()),
		fallbackReviewer: v.optional(v.string()),
		// The organisation the MCP transport VERIFIED for a bearer that reaches
		// Convex as the fleet service account. Believed from the service account
		// only; the door then acts as that org's member, never as the fleet
		// (convex/lib/verifiedOrg.ts).
		verifiedOrg: v.optional(verifiedOrgValidator),
	},
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("githubRepoMapping:add", …) at mcp-server/src/tools.ts:7892 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); never a subscribing pre-org client shell. The no-org throw is a refusal at an imperative MCP call, never at a render.
		const door = "githubRepoMapping:add";
		const transportScope = await withOrgScope(ctx);
		const scope = await resolveVerifiedOrgScope(
			ctx,
			transportScope,
			args.verifiedOrg,
			door,
		);
		const tenant = resolveWriteTenant(scope, door);
		// A member routes only to orchestrators of its OWN roster.
		requireOrchestratorOnRoster(scope, args.orchestrator, door, "assignee");
		if (args.reviewer !== undefined) {
			requireOrchestratorOnRoster(scope, args.reviewer, door, "assignee");
		}
		if (args.fallbackReviewer !== undefined) {
			requireOrchestratorOnRoster(scope, args.fallbackReviewer, door, "assignee");
		}
		// PROOF OF OWNERSHIP. A member may map only a repo whose GitHub OWNER is
		// bound to its own org through a GitHub-verified step
		// (convex/githubOwnerBinding.ts). A first claim is never enough: without
		// this, org-a could map "org-b/newrepo" and receive org-b's issues.
		// Master (fleet) rows are not subject to it.
		if (tenant !== undefined) {
			if (ownerOfRepo(args.repo) === null) {
				throw new ConvexError(
					`INVALID_REPO: repo must be "owner/name" — ${JSON.stringify({ repo: args.repo })}`,
				);
			}
			if (!(await repoOwnerBoundToOrg(ctx, args.repo, tenant))) {
				throw new ConvexError(
					`RBAC_DENIED: the GitHub owner of "${args.repo}" is not bound to org "${tenant}" — an owner binding for it must exist first — ${JSON.stringify({ reason: "github-owner-not-bound", door, repo: args.repo })}`,
				);
			}
		}
		// Upsert by repo
		const existing = await ctx.db
			.query("githubRepoMapping")
			.withIndex("by_repo", (q) => q.eq("repo", args.repo))
			.unique();
		if (existing) {
			requireRowOwnedBy(scope, existing, door);
			await ctx.db.patch(existing._id, {
				orchestrator: args.orchestrator,
				project: args.project,
				active: args.active ?? true,
				...(args.reviewer !== undefined ? { reviewer: args.reviewer } : {}),
				...(args.fallbackReviewer !== undefined
					? { fallbackReviewer: args.fallbackReviewer }
					: {}),
			});
			return existing._id;
		}
		return await ctx.db.insert("githubRepoMapping", {
			repo: args.repo,
			orchestrator: args.orchestrator,
			project: args.project,
			active: args.active ?? true,
			...(tenant !== undefined ? { orgId: tenant } : {}),
			...(tenant !== undefined && scope.orgClerkId !== undefined
				? { clerkOrgId: scope.orgClerkId }
				: {}),
			...(args.reviewer !== undefined ? { reviewer: args.reviewer } : {}),
			...(args.fallbackReviewer !== undefined
				? { fallbackReviewer: args.fallbackReviewer }
				: {}),
		});
	},
});

// fleet-wide: a claimless service-account call is the fleet master maintaining the FLEET's repo mappings, which is this door's purpose; a non-master bearer arrives with `verifiedOrg` (the MCP forwards it, and refuses a bearer whose organisation it cannot resolve before Convex) and writes only its own organisation's rows.
export const remove = mutation({
	args: {
		repo: v.string(),
		// The organisation the MCP transport VERIFIED for a bearer that reaches
		// Convex as the fleet service account (convex/lib/verifiedOrg.ts).
		verifiedOrg: v.optional(verifiedOrgValidator),
	},
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("githubRepoMapping:remove", …) at mcp-server/src/tools.ts:8085 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); never a subscribing pre-org client shell. The no-org throw is a refusal at an imperative MCP call, never at a render.
		const door = "githubRepoMapping:remove";
		const transportScope = await withOrgScope(ctx);
		const scope = await resolveVerifiedOrgScope(
			ctx,
			transportScope,
			args.verifiedOrg,
			door,
		);
		resolveWriteTenant(scope, door);
		const existing = await ctx.db
			.query("githubRepoMapping")
			.withIndex("by_repo", (q) => q.eq("repo", args.repo))
			.unique();
		if (existing) {
			requireRowOwnedBy(scope, existing, door);
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
