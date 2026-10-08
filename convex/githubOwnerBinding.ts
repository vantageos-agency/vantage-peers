import { type ActingCredential, resolveActingPrincipal } from "@vantageos/cloud-identity";
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
import { lookupOrgMapping, requireOrgAdmin, requireResolvedCaller, withOrgScope } from "./lib/auth";
import { signInstallState } from "./lib/installState";
import { findOperatorOrg } from "./lib/operatorOrg";

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

function randomNonce(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const START_DOOR = "githubOwnerBinding:startBinding";

function refuseStart(reason: string, detail: string): never {
	throw new ConvexError(`RBAC_DENIED: ${detail} — ${JSON.stringify({ door: START_DOOR, reason })}`);
}

// Step 1. Org admin only, own org only. The caller is identified BY ID through
// @vantageos/cloud-identity: a dashboard human is a `person` (stored subject +
// the org claim it presented), the fleet service account is a `service`. Each
// lookup reads a stored row by id; a miss, an inactive row or an unmapped org is
// a typed refusal, never a default principal. Only a person of a CLIENT-style
// org reaches the binding: a service account (the fleet) has no client org.
export const startBinding = mutation({
	args: {},
	returns: v.object({ state: v.string(), expiresAt: v.number() }),
	handler: async (ctx) => {
		// write-contract: MCP-transport-only (tool bind_github_owner); an
		// imperative call, never a render. The refusal is a coded RBAC_DENIED.
		const identity = await ctx.auth.getUserIdentity();
		if (identity === null) refuseStart("anonymous", "no authenticated identity presented");
		const claims = identity as Record<string, unknown>;
		const orgClaim =
			(claims.organizationSlug as string | undefined) ??
			(claims.org_slug as string | undefined) ??
			null;
		const serviceAccountUserId = process.env.CLERK_SERVICE_ACCOUNT_USER_ID;
		const credential: ActingCredential =
			serviceAccountUserId && identity.subject === serviceAccountUserId
				? { kind: "service", serviceAccountId: identity.subject }
				: orgClaim !== null
					? { kind: "person", personId: identity.subject, verifiedOrgId: orgClaim }
					: refuseStart("no-organisation", "identity has no organisation attached");
		const mappingOf = (orgId: string) => lookupOrgMapping(ctx, orgId);
		const who = await resolveActingPrincipal(
			credential,
			{
				personById: async (personId, orgId) => {
					const m = await mappingOf(orgId);
					return m === null ? null : { id: personId, orgId, active: m.isActive };
				},
				serviceAccountById: async (id) => {
					const op = await findOperatorOrg(ctx.db);
					return op.kind === "one" ? { id, orgId: op.slug, active: true } : null;
				},
				organisationById: async (orgId) => {
					const m = await mappingOf(orgId);
					return m === null ? null : { id: orgId, active: m.isActive };
				},
				orgKindOf: async (orgId) => (await mappingOf(orgId))?.orgKind ?? null,
			},
			START_DOOR,
		);
		if (!who.ok) refuseStart(who.refusal.reason, who.refusal.detail);
		const principal = who.principal;
		if (principal.kind !== "person") {
			refuseStart(
				"no-client-organisation",
				"startBinding binds a GitHub owner to a CLIENT org; the caller has no client organisation",
			);
		}
		await requireOrgAdmin(ctx, principal.orgId);
		const secret = process.env.GITHUB_APP_CLIENT_SECRET;
		if (!secret) {
			// Fail closed: without the App secret no signed state can be issued.
			refuseStart("github-app-not-configured", "the GitHub App is not configured on this deployment");
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
