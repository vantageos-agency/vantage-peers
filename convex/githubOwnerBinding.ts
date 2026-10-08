import { assertOrgAdmin, resolveActingPrincipal } from "@vantageos/cloud-identity";
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
import { requireResolvedCaller, withOrgScope } from "./lib/auth";
import { signInstallState } from "./lib/installState";

// ─────────────────────────────────────────────────────────────────────────────
// GitHub owner binding — the proof behind "this repo belongs to this org".
//
// A repo is routed to an org only when the repo's OWNER (the "owner" of
// "owner/name") is bound to that org here. A first claim proves nothing: org-a
// could otherwise map "org-b/newrepo" and receive org-b's issues.
//
// HOW A BINDING IS PROVEN (no operator in the loop, self-serve):
//   1. an org ADMIN calls `startBinding` (resolved BY ID and proven admin of
//      its OWN org through @vantageos/cloud-identity `assertOrgAdmin`) and
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

function randomNonce(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const START_DOOR = "githubOwnerBinding:startBinding";

function startRefusal(reason: string, detail: string): ConvexError<string> {
	return new ConvexError(`RBAC_DENIED: ${detail} — ${JSON.stringify({ door: START_DOOR, reason })}`);
}

// Clerk's admin role claim, exactly as the verified token spells it.
const ORG_ADMIN_ROLES = ["org:admin"] as const;

// The credential of the person calling startBinding, built ONLY from the
// verified identity: the Clerk subject, the Clerk org ID the session is bound to
// (`org_id`) and the role the SAME token carries in that org (`org_role`). No
// argument contributes. An absent identity is forwarded as absent and the
// package refuses it; an absent org or role reaches the package as absent and
// is refused there (credential-invalid / role-not-admin).
async function startBindingCredential(ctx: MutationCtx) {
	const identity = await ctx.auth.getUserIdentity();
	if (identity === null) return null;
	return {
		kind: "person" as const,
		personId: identity.subject,
		verifiedOrgId: identity.org_id as string,
		verifiedOrgRole: identity.org_role as string,
	};
}

// Step 1. Org admin only, own org only, decided BY ID through
// @vantageos/cloud-identity: `resolveActingPrincipal` resolves the person in the
// Clerk org its token is bound to, `assertOrgAdmin` admits it only as an admin of
// THAT org. Each host read is by ID:
//   - organisationById / orgKindOf read client_org_mapping by `by_clerk_org_id`;
//   - personById answers the membership the verified token attests (Clerk issues
//     `org_id` only to a current member of that org), and answers NOTHING for the
//     fleet service account: it is a service, never a person, so it never becomes
//     an org admin here (it is also a Clerk org:admin of orgs it created).
// The install state is stamped with the principal's org ID (the Clerk org ID);
// completeBindingInternal re-reads that org by ID before binding.
export const startBinding = mutation({
	args: {},
	returns: v.object({ state: v.string(), expiresAt: v.number() }),
	handler: async (ctx) => {
		// write-contract: MCP-transport-only (tool bind_github_owner); an
		// imperative call, never a render. The refusal is a coded RBAC_DENIED.
		const credential = await startBindingCredential(ctx);
		const who = await resolveActingPrincipal(
			credential,
			{
				personById: async (personId, orgId) =>
					personId === process.env.CLERK_SERVICE_ACCOUNT_USER_ID
						? null
						: { id: personId, orgId, active: true },
				organisationById: async (orgId) => {
					const row = await ctx.db
						.query("client_org_mapping")
						.withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", orgId))
						.unique();
					if (row === null) return null;
					return { id: orgId, active: row.isActive };
				},
				orgKindOf: async (orgId) => {
					const row = await ctx.db
						.query("client_org_mapping")
						.withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", orgId))
						.unique();
					if (row === null || !row.isActive) return null;
					return row.orgKind === "operator" ? "operator" : "client";
				},
			},
			START_DOOR,
		);
		if (!who.ok) throw startRefusal(who.refusal.reason, who.refusal.detail);
		const principal = who.principal;
		const admin = assertOrgAdmin(principal, principal.orgId, {
			adminRoles: ORG_ADMIN_ROLES,
			door: START_DOOR,
		});
		if (!admin.ok) throw startRefusal(admin.refusal.reason, admin.refusal.detail);
		const secret = process.env.GITHUB_APP_CLIENT_SECRET;
		if (!secret) {
			// Fail closed: without the App secret no signed state can be issued.
			throw startRefusal(
				"github-app-not-configured",
				"the GitHub App is not configured on this deployment",
			);
		}
		const state = await signInstallState(randomNonce(), secret);
		const now = Date.now();
		const expiresAt = now + INSTALL_STATE_TTL_MS;
		await ctx.db.insert("githubInstallStates", {
			state,
			orgId: principal.orgId,
			createdBy: principal.principalId,
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
		// The state carries the Clerk org ID startBinding resolved. Bindings and
		// mappings are keyed by the org's slug, so the org is re-read BY ID here:
		// an org gone or deactivated since the state was issued binds nothing.
		const org = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", row.orgId))
			.unique();
		if (org === null || !org.isActive) return { ok: false as const, reason: "org-not-active" };
		const orgSlug = org.clerkOrgSlug;
		const owner = args.accountLogin.toLowerCase();
		const current = await activeBindingForOwner(ctx, owner);
		if (current !== null && current.orgId !== orgSlug) {
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
				orgId: orgSlug,
				installationId: args.installationId,
				accountType: args.accountType,
				githubUserLogin: args.githubUserLogin,
				boundBy: row.createdBy,
				boundAt: now,
				active: true,
			});
		}
		return { ok: true as const, owner, orgId: orgSlug };
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
