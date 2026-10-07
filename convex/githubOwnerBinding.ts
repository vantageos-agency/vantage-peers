import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
	type MutationCtx,
	type QueryCtx,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "./_generated/server";
import { requireOrgAdmin, requireResolvedCaller, withOrgScope } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// GitHub owner binding — the proof behind "this repo belongs to this org".
//
// A repo is routed to an org only when the repo's OWNER (the "owner" of
// "owner/name") is bound to that org here. A first claim proves nothing: org-a
// could otherwise map "org-b/newrepo" and receive org-b's issues.
//
// HOW A BINDING IS PROVEN (no operator in the loop, self-serve):
//   1. an org ADMIN calls `startBinding` (requireOrgAdmin on its OWN org) and
//      receives a single-use, 15-minute, server-generated `state`;
//   2. the admin installs the VantagePeers GitHub App on the GitHub account
//      that owns the repos, with that `state` on the install/setup URL;
//   3. GitHub redirects to `/github/app/setup` (convex/http.ts), which
//      exchanges the OAuth `code` with the App's client secret and calls
//      `GET /user/installations` with the resulting USER token. Only an
//      installation the authorising GitHub user can actually see is accepted;
//      its `account.login` is the owner. Nothing in the query string names the
//      owner — GitHub does;
//   4. `completeBindingInternal` consumes the state and writes the binding.
// An `installation` webhook (HMAC-verified) with action deleted/suspend
// deactivates the bindings of that installation.
//
// LIMITS: needs a real GitHub App (GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET
// on the deployment, "Request user authorization (OAuth) during installation"
// enabled, setup URL pointing at /github/app/setup). Without them the setup
// route answers 501 and no binding can be created (fail closed). The GitHub
// side is exercised in tests with a stubbed fetch, never against github.com.
// ─────────────────────────────────────────────────────────────────────────────

export const INSTALL_STATE_TTL_MS = 15 * 60 * 1000;

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

function randomState(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Step 1. Org admin only, own org only.
export const startBinding = mutation({
	args: {},
	returns: v.object({ state: v.string(), expiresAt: v.number() }),
	handler: async (ctx) => {
		// write-contract: MCP-transport-only (tool bind_github_owner); an
		// imperative call, never a render. The refusal is a coded RBAC_DENIED.
		const scope = await withOrgScope(ctx);
		if (scope.isMaster || scope.orgSlug === null) {
			throw new ConvexError(
				"RBAC_DENIED: startBinding binds a GitHub owner to a CLIENT org; the caller has no client organisation — " +
					JSON.stringify({ door: "githubOwnerBinding:startBinding" }),
			);
		}
		await requireOrgAdmin(ctx, scope.orgSlug);
		const state = randomState();
		const now = Date.now();
		const expiresAt = now + INSTALL_STATE_TTL_MS;
		await ctx.db.insert("githubInstallStates", {
			state,
			orgId: scope.orgSlug,
			createdBy: scope.userId,
			expiresAt,
		});
		return { state, expiresAt };
	},
});

// Step 4. Internal: reached only from the GitHub-verified setup callback.
export const completeBindingInternal = internalMutation({
	args: {
		state: v.string(),
		installationId: v.number(),
		accountLogin: v.string(),
		accountType: v.string(),
		githubUserLogin: v.string(),
	},
	returns: v.union(
		v.object({ ok: v.literal(true), owner: v.string(), orgId: v.string() }),
		v.object({ ok: v.literal(false), reason: v.string() }),
	),
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("githubInstallStates")
			.withIndex("by_state", (q) => q.eq("state", args.state))
			.unique();
		const now = Date.now();
		if (row === null) return { ok: false as const, reason: "state-unknown" };
		if (row.usedAt !== undefined) return { ok: false as const, reason: "state-used" };
		if (row.expiresAt < now) return { ok: false as const, reason: "state-expired" };
		const owner = args.accountLogin.toLowerCase();
		const current = await activeBindingForOwner(ctx, owner);
		if (current !== null && current.orgId !== row.orgId) {
			// An owner is proven to ONE org. A second org claiming it is refused.
			return { ok: false as const, reason: "owner-bound-to-another-org" };
		}
		await ctx.db.patch(row._id, { usedAt: now });
		if (current !== null) {
			await ctx.db.patch(current._id, {
				installationId: args.installationId,
				githubUserLogin: args.githubUserLogin,
				boundBy: row.createdBy,
				boundAt: now,
			});
		} else {
			await ctx.db.insert("githubOwnerBindings", {
				owner,
				orgId: row.orgId,
				installationId: args.installationId,
				accountType: args.accountType,
				githubUserLogin: args.githubUserLogin,
				boundBy: row.createdBy,
				boundAt: now,
				active: true,
			});
		}
		return { ok: true as const, owner, orgId: row.orgId };
	},
});

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

// R-30: the read bounds are OURS and named. Each read fetches CAP + 1 rows so a
// full page can be told from a truncated one, and returns `truncated` instead of
// a short list that reads as complete.
export const OWNER_BINDING_LIST_CAP = 500;
export const UNPROVEN_MAPPING_SCAN_CAP = 2000;

// Own org's bindings (a member), or all (master). `truncated: true` means more
// bindings exist than the cap returned.
export const listBindings = query({
	args: {},
	returns: v.object({ items: v.array(bindingView), truncated: v.boolean() }),
	handler: async (ctx) => {
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		// isolation-contract: no reactive subscriber. Enumerated by command:
		//   grep -rn "api\.githubOwnerBinding\." --include=*.tsx --include=*.ts app components hooks lib
		// in vantage-peers-dashboard -> 0 hits (new door). So the pre-org caller
		// may be refused by raising.
		requireResolvedCaller(scope, "githubOwnerBinding:listBindings", {
			alsoRefusePreOrg: true,
		});
		const rows = scope.isMaster
			? await ctx.db.query("githubOwnerBindings").take(OWNER_BINDING_LIST_CAP + 1)
			: await ctx.db
					.query("githubOwnerBindings")
					.withIndex("by_org", (q) => q.eq("orgId", scope.orgSlug as string))
					.take(OWNER_BINDING_LIST_CAP + 1);
		return {
			items: rows.slice(0, OWNER_BINDING_LIST_CAP).map(toView),
			truncated: rows.length > OWNER_BINDING_LIST_CAP,
		};
	},
});

// Existing mappings that carry an org but NO proof: reported, never silently
// kept. Master only (the repo-mapping corpus is fleet configuration).
// `truncated: true` means the mapping table holds more rows than the scan cap, so
// the report may omit unproven mappings beyond it.
export const listUnprovenMappings = query({
	args: {},
	returns: v.object({
		items: v.array(
			v.object({
				repo: v.string(),
				orgId: v.string(),
				project: v.string(),
				reason: v.string(),
			}),
		),
		truncated: v.boolean(),
	}),
	handler: async (ctx) => {
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		// isolation-contract: no reactive subscriber (new door, 0 dashboard hits).
		requireResolvedCaller(scope, "githubOwnerBinding:listUnprovenMappings", {
			alsoRefusePreOrg: true,
			masterOnly: true,
		});
		const out: Array<{ repo: string; orgId: string; project: string; reason: string }> = [];
		const scanned = await ctx.db.query("githubRepoMapping").take(UNPROVEN_MAPPING_SCAN_CAP + 1);
		const rows = scanned.slice(0, UNPROVEN_MAPPING_SCAN_CAP);
		for (const m of rows) {
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
		return { items: out, truncated: scanned.length > UNPROVEN_MAPPING_SCAN_CAP };
	},
});
