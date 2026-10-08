import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
	type MutationCtx,
	type QueryCtx,
	internalMutation,
	internalQuery,
	query,
} from "./_generated/server";
import { requireResolvedCaller, withOrgScope } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// GitHub owner binding — the proof behind "this repo belongs to this org".
//
// A repo is routed to an org only when the repo's OWNER (the "owner" of
// "owner/name") is bound to that org here. A first claim proves nothing: org-a
// could otherwise map "org-b/newrepo" and receive org-b's issues.
//
// HOW A BINDING IS CREATED: not in this module. The self-serve door that
// started a binding (`startBinding`), the signed install state, the GitHub
// setup callback and the writer of `githubOwnerBindings` were removed from this
// change and move to a follow-up that restores them through a cloud-identity
// admin primitive. What remains reads and revokes bindings:
//   - `listBindings` / `listUnprovenMappings` report them (cursor-paged);
//   - `repoRoutable` / `activeBindingForOwner` are the proof githubRepoMapping
//     checks before it routes a repo to an org;
//   - an `installation` webhook (HMAC-verified) with action deleted/suspend
//     deactivates the bindings of that installation.
// ─────────────────────────────────────────────────────────────────────────────

const REPO_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

/** Lowercase owner of "owner/name", or null when the string is not a repo name. */
export function ownerOfRepo(repo: string): string | null {
	const m = REPO_RE.exec(repo);
	return m === null ? null : m[1].toLowerCase();
}

/** The active binding of `owner`, if any (an owner is bound to at most one org). */
export async function activeBindingForOwner(
	ctx: QueryCtx | MutationCtx,
	owner: string,
): Promise<Doc<"githubOwnerBindings"> | null> {
	const rows = await ctx.db
		.query("githubOwnerBindings")
		.withIndex("by_owner", (q) => q.eq("owner", owner))
		.order("desc")
		.take(10);
	return rows.find((r) => r.active) ?? null;
}

/** Is the owner of `repo` bound, with proof, to `orgId`? */
export async function repoOwnerBoundToOrg(
	ctx: QueryCtx | MutationCtx,
	repo: string,
	orgId: string,
): Promise<boolean> {
	const owner = ownerOfRepo(repo);
	if (owner === null) return false;
	const binding = await activeBindingForOwner(ctx, owner);
	return binding !== null && binding.orgId === orgId;
}

/**
 * Does this mapping row still ROUTE? A fleet row (no orgId) always does. An
 * org-owned row routes only while its repo owner has an ACTIVE binding to that
 * same org: a deleted/suspended installation or a deactivated binding withdraws
 * the proof, and the row stops reaching issues, tasks, comments and deploy state
 * (it stays listed by listUnprovenMappings).
 */
export async function mappingIsProven(
	ctx: QueryCtx | MutationCtx,
	row: Pick<Doc<"githubRepoMapping">, "repo" | "orgId">,
): Promise<boolean> {
	if (row.orgId === undefined) return true;
	return await repoOwnerBoundToOrg(ctx, row.repo, row.orgId);
}

// Internal door for the HMAC-verified webhook: may this repo's mapping route?
export const repoRoutable = internalQuery({
	args: { repo: v.string() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("githubRepoMapping")
			.withIndex("by_repo", (q) => q.eq("repo", args.repo))
			.unique();
		return row !== null && (await mappingIsProven(ctx, row));
	},
});

const bindingView = v.object({
	owner: v.string(),
	orgId: v.string(),
	installationId: v.number(),
	accountType: v.string(),
	githubUserLogin: v.string(),
	boundAt: v.number(),
	active: v.boolean(),
});

function toView(r: Doc<"githubOwnerBindings">) {
	return {
		owner: r.owner,
		orgId: r.orgId,
		installationId: r.installationId,
		accountType: r.accountType,
		githubUserLogin: r.githubUserLogin,
		boundAt: r.boundAt,
		active: r.active,
	};
}

// HMAC-verified `installation` webhook (deleted / suspend): the proof is gone.
export const deactivateInstallation = internalMutation({
	args: { installationId: v.number() },
	returns: v.number(),
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query("githubOwnerBindings")
			.withIndex("by_installation", (q) => q.eq("installationId", args.installationId))
			.take(50);
		let n = 0;
		for (const r of rows) {
			if (!r.active) continue;
			await ctx.db.patch(r._id, { active: false, deactivatedAt: Date.now() });
			n++;
		}
		return n;
	},
});

// R-3 / R-30: both list reads are CURSOR-paginated with a named default and a
// named maximum. A caller pages with `cursor` = the previous `nextCursor`;
// `nextCursor: null` means the scan is exhausted, a string means more remain.
export const OWNER_LIST_DEFAULT_LIMIT = 100;
export const OWNER_LIST_MAX_LIMIT = 500;

export function pageSize(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return OWNER_LIST_DEFAULT_LIMIT;
	return Math.min(Math.max(Math.floor(limit), 1), OWNER_LIST_MAX_LIMIT);
}

// Own org's bindings (a member), or all (master), one page at a time.
export const listBindings = query({
	args: { limit: v.optional(v.number()), cursor: v.optional(v.string()) },
	returns: v.object({ items: v.array(bindingView), nextCursor: v.union(v.string(), v.null()) }),
	handler: async (ctx, args) => {
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		// isolation-contract: no reactive subscriber. Enumerated by command:
		//   grep -rn "api\.githubOwnerBinding\." --include=*.tsx --include=*.ts app components hooks lib
		// in vantage-peers-dashboard -> 0 hits (new door). So the pre-org caller
		// may be refused by raising.
		requireResolvedCaller(scope, "githubOwnerBinding:listBindings", {
			alsoRefusePreOrg: true,
		});
		const opts = { numItems: pageSize(args.limit), cursor: args.cursor ?? null };
		const page = scope.isMaster
			? await ctx.db.query("githubOwnerBindings").paginate(opts)
			: await ctx.db
					.query("githubOwnerBindings")
					.withIndex("by_org", (q) => q.eq("orgId", scope.orgSlug as string))
					.paginate(opts);
		return {
			items: page.page.map(toView),
			nextCursor: page.isDone ? null : page.continueCursor,
		};
	},
});

type UnprovenMapping = { repo: string; orgId: string; project: string; reason: string };

/**
 * One page of the scan behind `listUnprovenMappings`: reads `numItems`
 * githubRepoMapping rows from `cursor` and reports the unproven ones among them.
 * A page may therefore hold fewer than `numItems` items (or none) while
 * `nextCursor` is still a string: only `nextCursor: null` ends the scan. It
 * performs no authorisation of its own; callers are the master-only handler and
 * tests.
 */
export async function collectUnprovenMappings(
	ctx: QueryCtx,
	numItems: number,
	cursor: string | null,
): Promise<{ items: UnprovenMapping[]; nextCursor: string | null }> {
	const out: UnprovenMapping[] = [];
	const page = await ctx.db.query("githubRepoMapping").paginate({ numItems, cursor });
	for (const m of page.page) {
		if (m.orgId === undefined) continue;
		const owner = ownerOfRepo(m.repo);
		const binding = owner === null ? null : await activeBindingForOwner(ctx, owner);
		if (binding === null) {
			out.push({ repo: m.repo, orgId: m.orgId, project: m.project, reason: "owner-not-bound" });
		} else if (binding.orgId !== m.orgId) {
			out.push({
				repo: m.repo,
				orgId: m.orgId,
				project: m.project,
				reason: "owner-bound-to-another-org",
			});
		}
	}
	return { items: out, nextCursor: page.isDone ? null : page.continueCursor };
}

// Existing mappings that carry an org but NO proof: reported, never silently
// kept. Master only (the repo-mapping corpus is fleet configuration).
export const listUnprovenMappings = query({
	args: { limit: v.optional(v.number()), cursor: v.optional(v.string()) },
	returns: v.object({
		items: v.array(
			v.object({
				repo: v.string(),
				orgId: v.string(),
				project: v.string(),
				reason: v.string(),
			}),
		),
		nextCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		// isolation-contract: no reactive subscriber (new door, 0 dashboard hits).
		requireResolvedCaller(scope, "githubOwnerBinding:listUnprovenMappings", {
			alsoRefusePreOrg: true,
			masterOnly: true,
		});
		return await collectUnprovenMappings(ctx, pageSize(args.limit), args.cursor ?? null);
	},
});
