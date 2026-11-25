import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
	type MutationCtx,
	type QueryCtx,
	internalMutation,
	internalQuery,
} from "./_generated/server";
import { mutation, query } from "./lib/functions";
import { sameOrg } from "@vantageos/cloud-identity";
import { ownerOfRepo, repoOwnerBoundToOrg } from "./githubOwnerBinding";
import { orgRefOfRow, orgRefOfScope } from "./lib/authOrgMapping";
import { rbacDenied } from "./lib/inboxReader";
import { findOperatorOrg } from "./lib/operatorOrg";
import {
	type OrgKey,
	isRoutingAdopted,
	orgKeyOfTenant,
	orgKeyOfRepo,
	routeOfRow,
} from "./lib/reviewRouting";
import {
	requireVerifiedOrgFromServiceAccount,
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
	if (scope.isMaster) return undefined;
	requireScope(scope, "manage-repo-mappings");
	if (scope.orgSlug === null) {
		throw new ConvexError(
			`RBAC_DENIED: ${door} needs an organisation to own the mapping — ${JSON.stringify({ door })}`,
		);
	}
	return scope.orgSlug;
}

// A member may touch only rows its own org owns. Master may touch any row
// (and never changes who owns it). `refuse: false` answers false instead of
// raising for a row that is not the caller's: the per-org route lookup states a
// typed absence for it (`getRoute`), the one place a refusal would be an oracle
// that the row exists.
function requireRowOwnedBy(
	scope: OrgScope,
	row: Doc<"githubRepoMapping">,
	door: string,
	opts?: { refuse: boolean },
): boolean {
	if (scope.isMaster) return true;
	if (!sameOrg(orgRefOfRow(row), orgRefOfScope(scope))) {
		if (opts?.refuse === false) return false;
		throw new ConvexError(
			`RBAC_DENIED: ${door} — repo is not owned by org "${scope.orgSlug}" — ${JSON.stringify({ door, repo: row.repo })}`,
		);
	}
	return true;
}

const repoMappingDocOrNull = v.union(
	v.object({
		_id: v.id("githubRepoMapping"),
		_creationTime: v.number(),
		repo: v.string(),
		orchestrator: v.optional(v.string()),
		outOfScope: v.optional(v.object({ reason: v.string() })),
		project: v.string(),
		active: v.boolean(),
		lastDeployedSHA: v.optional(v.string()),
		lastDeployedAt: v.optional(v.number()),
		reviewer: v.optional(v.string()),
		fallbackReviewer: v.optional(v.string()),
		// The agents the labels above name, by agents-row ID (list_peers `agentId`).
		// A task's assignee is compared with THESE, never with a label.
		orchestratorAgentId: v.optional(v.id("agents")),
		reviewerAgentId: v.optional(v.id("agents")),
		fallbackReviewerAgentId: v.optional(v.id("agents")),
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
export const getByRepo = query({
	args: { repo: v.string() },
	returns: repoMappingDocOrNull,
	handler: async (ctx, args) => {
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(scope, "githubRepoMapping:getByRepo", {
			alsoRefusePreOrg: true,
		});
		const row = await lookupByRepo(ctx, args.repo);
		if (row === null) return null;
		requireRowOwnedBy(scope, row, "githubRepoMapping:getByRepo");
		return row;
	},
});

const routeValidator = v.union(
	v.object({
		state: v.literal("routed"),
		owner: v.string(),
		reviewer: v.string(),
		fallbackReviewer: v.optional(v.string()),
		ownerAgentId: v.optional(v.id("agents")),
		reviewerAgentId: v.optional(v.id("agents")),
		fallbackReviewerAgentId: v.optional(v.id("agents")),
	}),
	v.object({
		state: v.literal("unreviewed"),
		owner: v.string(),
		ownerAgentId: v.optional(v.id("agents")),
	}),
	v.object({ state: v.literal("out-of-scope"), reason: v.string() }),
	v.object({ state: v.literal("absent") }),
);

// The route of ONE repository in the CALLER'S OWN org (mission
// k577f8ksjx5ec3gq9bggc1brqd8jwkbh, S1). The org is the verified one
// (withOrgScope / the transport's verifiedOrg), never an argument.
//   routed      the org's row names an owner and a reviewer
//   unreviewed  the org's row exists and names no reviewer (the owner is named)
//   absent      the org has no row for this repository — an explicit state, not a
//               fallback. A row that belongs to ANOTHER org (or to the fleet, for a
//               member of another org) is answered as absent too: it is not this
//               org's route, and the answer carries none of its content.
// A caller with no credential (or signed in with no organisation) is RAISED at
// RBAC_DENIED, never answered with an absence. The fleet master reads any row.
// Whether the fleet default applies to an `unreviewed`/`absent` repo is NOT said
// here: it depends on the org's adoption (convex/lib/reviewRouting.ts).
// isolation-contract: no reactive subscriber. New door, so 0 consumers by
// construction; re-enumerate before adding one:
//   grep -rn "api\.githubRepoMapping\.getRoute" --include=*.tsx --include=*.ts app components hooks lib → 0 hits.
export const getRoute = query({
	args: { repo: v.string(), verifiedOrg: v.optional(verifiedOrgValidator) },
	returns: routeValidator,
	handler: async (ctx, args) => {
		const transportScope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(transportScope, "githubRepoMapping:getRoute", {
			alsoRefusePreOrg: true,
		});
		// R-54: the service account acts inside a transport-verified organisation. A
		// claimless service-account call is refused, never served as master.
		requireVerifiedOrgFromServiceAccount(
			transportScope,
			args.verifiedOrg,
			"githubRepoMapping:getRoute",
		);
		const scope = await resolveVerifiedOrgScope(
			ctx,
			transportScope,
			args.verifiedOrg,
			"githubRepoMapping:getRoute",
		);
		const row = await lookupByRepo(ctx, args.repo);
		if (row === null) return { state: "absent" as const };
		if (!requireRowOwnedBy(scope, row, "githubRepoMapping:getRoute", { refuse: false })) {
			return { state: "absent" as const };
		}
		return routeOfRow(row);
	},
});

// Which of the caller's listed repositories have a row in ANOTHER organisation (task
// k170nabwrnahjcey4zayn7an3h8jxjg5): a client's repositories are routed in that client's
// org, so the operator org's completeness check must not count them as missing. The
// answer is the caller's own input names, filtered: no org, owner or content of the
// other org's row. It applies to the OPERATOR org only (a client org is told
// `applicable: false`, a typed answer, never an empty absence); getRoute is untouched
// and keeps answering absent for another org's row.
// isolation-contract: no reactive subscriber. New door, so 0 consumers by construction;
// re-enumerate before adding one:
//   grep -rn "api\.githubRepoMapping\.routedElsewhere" --include=*.tsx --include=*.ts app components hooks lib → 0 hits.
export const routedElsewhere = query({
	args: {
		repos: v.array(v.string()),
		verifiedOrg: v.optional(verifiedOrgValidator),
	},
	returns: v.object({ applicable: v.boolean(), elsewhere: v.array(v.string()) }),
	handler: async (ctx, args) => {
		const transportScope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(transportScope, "githubRepoMapping:routedElsewhere", {
			alsoRefusePreOrg: true,
		});
		requireVerifiedOrgFromServiceAccount(
			transportScope,
			args.verifiedOrg,
			"githubRepoMapping:routedElsewhere",
		);
		const scope = await resolveVerifiedOrgScope(
			ctx,
			transportScope,
			args.verifiedOrg,
			"githubRepoMapping:routedElsewhere",
		);
		const operator = await findOperatorOrg(ctx.db);
		const callerRef = orgRefOfScope(scope);
		if (
			operator.kind !== "one" ||
			!sameOrg(callerRef, { id: operator.clerkOrgId, label: operator.slug })
		) {
			return { applicable: false, elsewhere: [] };
		}
		const elsewhere: string[] = [];
		for (const repo of [...new Set(args.repos)].slice(0, 500)) {
			const row = await lookupByRepo(ctx, repo);
			// A fleet row (no stamp) is the operator's own; a stamped row of another org is elsewhere.
			if (row === null || (row.orgId === undefined && row.clerkOrgId === undefined)) continue;
			if (!sameOrg(orgRefOfRow(row), callerRef)) elsewhere.push(repo);
		}
		return { applicable: true, elsewhere };
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
	orchestrator: v.optional(v.string()),
	outOfScope: v.optional(v.object({ reason: v.string() })),
	project: v.string(),
	active: v.boolean(),
	lastDeployedSHA: v.optional(v.string()),
	lastDeployedAt: v.optional(v.number()),
	reviewer: v.optional(v.string()),
	fallbackReviewer: v.optional(v.string()),
	orchestratorAgentId: v.optional(v.id("agents")),
	reviewerAgentId: v.optional(v.id("agents")),
	fallbackReviewerAgentId: v.optional(v.id("agents")),
	orgId: v.optional(v.string()),
	clerkOrgId: v.optional(v.string()),
});

const repoMappingLiteObject = v.object({
	_id: v.id("githubRepoMapping"),
	_creationTime: v.number(),
	repo: v.string(),
	orchestrator: v.optional(v.string()),
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
		// A master reads the whole corpus. An org member reads ONLY the rows its
		// own org owns (the server-stamped `orgId`), via the by_org index.
		const memberOrg = scope.isMaster ? null : scope.orgSlug;
		if (!scope.isMaster && memberOrg === null) return { items: [], nextCursor: null };

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

		let rows: Doc<"githubRepoMapping">[] =
			memberOrg === null
				? await ctx.db.query("githubRepoMapping").order("desc").take(fetchLimit)
				: await ctx.db
						.query("githubRepoMapping")
						.withIndex("by_org", (q) => q.eq("orgId", memberOrg))
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
				...(r.orchestrator !== undefined ? { orchestrator: r.orchestrator } : {}),
				project: r.project,
			}));
			return { items: liteItems, nextCursor };
		}

		return { items: pageRows, nextCursor };
	},
});

// A route's agent ID must name an active agent of the org the row belongs to. The
// refusal is the one RBAC_DENIED constructor, with its own reason.
async function requireRouteAgent(
	ctx: MutationCtx,
	agentId: Id<"agents">,
	org: OrgKey | null,
	repo: string,
): Promise<void> {
	const agent = await ctx.db.get(agentId);
	const inOrg =
		agent !== null &&
		org !== null &&
		sameOrg(
			{ id: agent.clerkOrgId, label: agent.orgSlug },
			{ id: org.clerkOrgId, label: org.clerkOrgSlug },
		);
	if (agent === null || !agent.isActive || !inOrg) {
		throw rbacDenied(
			"githubRepoMapping:add",
			"route-agent-not-in-org",
			`agent "${agentId}" is not an active agent of the organisation that owns repo "${repo}"`,
		);
	}
}

export const add = mutation({
	args: {
		repo: v.string(),
		// Required for a routed row; absent for an out-of-scope row (refused otherwise).
		orchestrator: v.optional(v.string()),
		// A repo no station owns. Excludes orchestrator, reviewers and agent IDs.
		outOfScope: v.optional(v.object({ reason: v.string() })),
		project: v.string(),
		active: v.optional(v.boolean()),
		reviewer: v.optional(v.string()),
		fallbackReviewer: v.optional(v.string()),
		orchestratorAgentId: v.optional(v.id("agents")),
		reviewerAgentId: v.optional(v.id("agents")),
		fallbackReviewerAgentId: v.optional(v.id("agents")),
		// The organisation the MCP transport VERIFIED for a bearer that reaches
		// Convex as the fleet service account (task k176y0q5jcz3m8m673bf61kva98h49js).
		// Without it a seat's mapping was written as a FLEET row, exempt from the
		// owner-binding proof, and its own `list` (which takes verifiedOrg) could not
		// read it back. The write then runs under that org's member scope, exactly
		// as its read sibling does. Believed from the service account only.
		verifiedOrg: v.optional(verifiedOrgValidator),
	},
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("githubRepoMapping:add", …) at mcp-server/src/tools.ts:7892 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); never a subscribing pre-org client shell. The no-org throw is a refusal at an imperative MCP call, never at a render.
		const scope = await resolveVerifiedOrgScope(
			ctx,
			await withOrgScope(ctx),
			args.verifiedOrg,
			"githubRepoMapping:add",
		);
		const tenant = resolveWriteTenant(scope, "githubRepoMapping:add");
		// A row is either routed OR out of scope, never both.
		const outOfScopeReason = args.outOfScope?.reason.trim();
		if (args.outOfScope !== undefined) {
			if (outOfScopeReason === undefined || outOfScopeReason.length < 10) {
				throw new ConvexError(
					`INVALID_ROUTE: an out-of-scope repo needs a reason of at least 10 characters — ${JSON.stringify({ door: "githubRepoMapping:add", repo: args.repo })}`,
				);
			}
			if (
				args.orchestrator !== undefined ||
				args.reviewer !== undefined ||
				args.fallbackReviewer !== undefined ||
				args.orchestratorAgentId !== undefined ||
				args.reviewerAgentId !== undefined ||
				args.fallbackReviewerAgentId !== undefined
			) {
				throw new ConvexError(
					`INVALID_ROUTE: an out-of-scope repo is not routed: it takes no orchestrator, reviewer or agent ID — ${JSON.stringify({ door: "githubRepoMapping:add", repo: args.repo })}`,
				);
			}
		} else if (args.orchestrator === undefined) {
			throw new ConvexError(
				`INVALID_ROUTE: a routed repo needs an orchestrator (or record it as outOfScope with a reason) — ${JSON.stringify({ door: "githubRepoMapping:add", repo: args.repo })}`,
			);
		}
		// A member routes only to orchestrators of its OWN roster.
		if (args.orchestrator !== undefined) {
			requireOrchestratorOnRoster(scope, args.orchestrator, "githubRepoMapping:add", "assignee");
		}
		if (args.reviewer !== undefined) {
			requireOrchestratorOnRoster(scope, args.reviewer, "githubRepoMapping:add", "assignee");
		}
		if (args.fallbackReviewer !== undefined) {
			requireOrchestratorOnRoster(scope, args.fallbackReviewer, "githubRepoMapping:add", "assignee");
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
					`RBAC_DENIED: the GitHub owner of "${args.repo}" is not bound to org "${tenant}" — an owner binding for it must exist first — ${JSON.stringify({ reason: "github-owner-not-bound", door: "githubRepoMapping:add", repo: args.repo })}`,
				);
			}
		}
		// Upsert by repo
		const existing = await ctx.db
			.query("githubRepoMapping")
			.withIndex("by_repo", (q) => q.eq("repo", args.repo))
			.unique();
		// ADOPTED ORG: a routing row names its reviewer (the one on the row already,
		// or this call's). The org is the existing row's own, else the writer's
		// tenant (an unstamped fleet row = the operator org). A NON-adopted org is
		// unchanged: a reviewer stays optional and the fleet default applies.
		if (existing) requireRowOwnedBy(scope, existing, "githubRepoMapping:add");
		const writeOrg = existing
			? await orgKeyOfRepo(ctx, args.repo, existing)
			: await orgKeyOfTenant(ctx, tenant, scope.orgClerkId);
		if (
			args.outOfScope === undefined &&
			(await isRoutingAdopted(ctx, writeOrg)) &&
			(args.reviewer ?? existing?.reviewer) === undefined
		) {
			throw new ConvexError(
				`REVIEWER_REQUIRED: org "${writeOrg?.clerkOrgSlug}" adopted explicit review routing — a mapping must name its reviewer — ${JSON.stringify({ door: "githubRepoMapping:add", repo: args.repo })}`,
			);
		}
		// A stored agent ID names an ACTIVE agent of the org the row belongs to, and
		// belongs to a label the same call gives: it is what a task's assignee is later
		// compared with (lib/taskRouting.ts).
		if (args.reviewerAgentId !== undefined && args.reviewer === undefined) {
			throw new ConvexError(
				`INVALID_ROUTE: reviewerAgentId needs the reviewer label it belongs to — ${JSON.stringify({ door: "githubRepoMapping:add", repo: args.repo })}`,
			);
		}
		if (args.fallbackReviewerAgentId !== undefined && args.fallbackReviewer === undefined) {
			throw new ConvexError(
				`INVALID_ROUTE: fallbackReviewerAgentId needs the fallbackReviewer label it belongs to — ${JSON.stringify({ door: "githubRepoMapping:add", repo: args.repo })}`,
			);
		}
		for (const agentId of [
			args.orchestratorAgentId,
			args.reviewerAgentId,
			args.fallbackReviewerAgentId,
		]) {
			if (agentId !== undefined) await requireRouteAgent(ctx, agentId, writeOrg, args.repo);
		}
		if (args.outOfScope !== undefined) {
			// Out of scope: the whole route is cleared, so no half of it outlives the conversion.
			const outOfScope = { reason: outOfScopeReason as string };
			if (existing) {
				await ctx.db.patch(existing._id, {
					outOfScope,
					orchestrator: undefined,
					reviewer: undefined,
					fallbackReviewer: undefined,
					orchestratorAgentId: undefined,
					reviewerAgentId: undefined,
					fallbackReviewerAgentId: undefined,
					project: args.project,
					active: args.active ?? true,
				});
				return existing._id;
			}
			return await ctx.db.insert("githubRepoMapping", {
				repo: args.repo,
				outOfScope,
				project: args.project,
				active: args.active ?? true,
				...(tenant !== undefined ? { orgId: tenant } : {}),
				...(tenant !== undefined && scope.orgClerkId !== undefined
					? { clerkOrgId: scope.orgClerkId }
					: {}),
			});
		}
		if (existing) {
			await ctx.db.patch(existing._id, {
				orchestrator: args.orchestrator,
				outOfScope: undefined,
				project: args.project,
				active: args.active ?? true,
				// The IDs are restated by each call, role by role: an ID never outlives
				// the label it was given with (undefined clears it).
				orchestratorAgentId: args.orchestratorAgentId,
				...(args.reviewer !== undefined
					? { reviewer: args.reviewer, reviewerAgentId: args.reviewerAgentId }
					: {}),
				...(args.fallbackReviewer !== undefined
					? {
							fallbackReviewer: args.fallbackReviewer,
							fallbackReviewerAgentId: args.fallbackReviewerAgentId,
						}
					: {}),
			});
			return existing._id;
		}
		return await ctx.db.insert("githubRepoMapping", {
			repo: args.repo,
			orchestrator: args.orchestrator,
			project: args.project,
			active: args.active ?? true,
			...(args.orchestratorAgentId !== undefined
				? { orchestratorAgentId: args.orchestratorAgentId }
				: {}),
			...(args.reviewer !== undefined && args.reviewerAgentId !== undefined
				? { reviewerAgentId: args.reviewerAgentId }
				: {}),
			...(args.fallbackReviewer !== undefined && args.fallbackReviewerAgentId !== undefined
				? { fallbackReviewerAgentId: args.fallbackReviewerAgentId }
				: {}),
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

export const remove = mutation({
	args: {
		repo: v.string(),
		// See `add`: the bearer's verified org; the removal runs under its member scope.
		verifiedOrg: v.optional(verifiedOrgValidator),
	},
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("githubRepoMapping:remove", …) at mcp-server/src/tools.ts:8085 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); never a subscribing pre-org client shell. The no-org throw is a refusal at an imperative MCP call, never at a render.
		const scope = await resolveVerifiedOrgScope(
			ctx,
			await withOrgScope(ctx),
			args.verifiedOrg,
			"githubRepoMapping:remove",
		);
		resolveWriteTenant(scope, "githubRepoMapping:remove");
		const existing = await ctx.db
			.query("githubRepoMapping")
			.withIndex("by_repo", (q) => q.eq("repo", args.repo))
			.unique();
		if (existing) {
			requireRowOwnedBy(scope, existing, "githubRepoMapping:remove");
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
