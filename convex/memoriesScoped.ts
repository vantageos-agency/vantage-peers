/**
 * memoriesScoped — team namespace enforcement for Clerk JWT callers.
 *
 * B4 RAG namespace tenant enforcement (VP task k17528bya5wnbxm0x3cebrf9vh8915n0).
 *
 * These functions are the Convex-layer counterpart to the MCP bearer middleware's
 * namespaceRead/WritePrefixes enforcement. They ensure that a Clerk user whose JWT
 * carries org_A cannot read or write a memory in team/<org_B>.
 *
 * Design:
 *   - A Clerk caller with organizationId = "org_A" may only access team/org_A/*.
 *   - A caller with NO VERIFIED ORGANISATION is REFUSED. This line previously
 *     read "No-identity callers (MCP/CLI deploy key) retain master access
 *     (isMaster=true)" and that sentence WAS the production leak: an
 *     unauthenticated POST to the deployment URL was served real tenant rows.
 *     Master is now reachable only as withOrgScope defines it — the named
 *     stored fleet service account (lib/serviceAccount.ts), never inferred from the
 *     mere ABSENCE of a credential. See resolveCallerOrgId below.
 *   - Unknown or unregistered orgs are FAIL-CLOSED (throw AUTH_NAMESPACE_DENIED).
 *
 * storeMemoryScoped  — enforced write: org_A cannot write to team/org_B.
 * listMemoriesScoped — enforced read: org_A cannot read from team/org_B.
 */

import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { type OrgScope, withOrgScope } from "./lib/auth";
import {
	creatorValidator,
	memoryTypeValidator,
	relationTypeValidator,
	severityValidator,
} from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the caller into an org id, or a REFUSAL. Fail-closed.
 *
 * THE DEFECT THIS REPLACES (measured against LIVE production): the previous
 * `resolveOrgId` consulted `ctx.auth.getUserIdentity()` and then, on
 * `!identity`, did `return null` -- and `null` is this module's MASTER
 * sentinel ("all namespaces allowed", see assertNamespaceAllowed below). So a
 * caller presenting NO CREDENTIAL AT ALL was promoted to master:
 *
 *   POST https://<deployment>.convex.cloud/api/query
 *     {"path":"memoriesScoped:listMemoriesScoped","args":{"namespace":"global","limit":3}}
 *       -> {"status":"success", 3 rows of real memory content}
 *
 * That is precisely the shape `.claude/rules/authority-attached-to-anonymous-
 * object.md` names: the verified principal is computed and then DISCARDED in
 * favour of a populated default. A signed-in caller with no org attached fell
 * into the same `return null` master branch one line later. Note this site was
 * NOT "no identity check" -- it HAD one and failed OPEN, which is why a
 * scanner that only looks for the absence of a getUserIdentity call misses it.
 *
 * THE FIX -- reuse, do not invent. `withOrgScope` (convex/lib/auth.ts) already
 * resolves the principal fail-closed, and already owns the ONLY legitimate
 * master grants: the stored fleet service account (lib/serviceAccount.ts) and
 * the explicit `allowNoIdentityMaster` opt-in (deliberately NOT passed here).
 * A second identity layer in this module would itself be the defect, so this
 * function is a thin adapter over withOrgScope, not a reimplementation.
 *
 * The live fleet path is unaffected: the MCP server ALWAYS attaches an
 * identity now -- the caller's own verified Clerk JWT, or its Clerk
 * service-account token which withOrgScope maps to master by id (see
 * mcp-server/src/authenticatedConvexClient.ts, `selectConvexClientForRequest`,
 * and the P0 fix of 2026-08-07 that made setAuth unconditional). Master
 * callers keep byte-identical behaviour.
 *
 * `refuseWithoutThrow` is passed so the signed-in-no-org branch comes back as
 * a typed refused scope rather than a throw; each call site below then chooses
 * its OWN refusal shape (typed empty for the reactive read, throw for the
 * imperative write). Every OTHER refusal withOrgScope makes -- unknown or
 * inactive org -- still THROWS, and is re-labelled AUTH_NAMESPACE_DENIED here
 * because that is this module's public error contract (pinned by
 * convex/__tests__/auth-namespace-deny.test.ts). Re-labelling never downgrades
 * a throw into a value.
 */
async function resolveCallerOrgId(
	ctx: QueryCtx | MutationCtx,
): Promise<{ orgId: string | null; refused: boolean }> {
	let scope: OrgScope;
	try {
		scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
	} catch (err: unknown) {
		throw new Error(
			`AUTH_NAMESPACE_DENIED: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Master keeps the null sentinel assertNamespaceAllowed reads as
	// "unrestricted" -- unchanged for the fleet's own callers.
	if (scope.isMaster) return { orgId: null, refused: false };

	// No verified organisation: anonymous (no identity at all) OR signed in
	// without an org. NEVER master. This is the branch that used to leak.
	if (scope.orgSlug === null) return { orgId: null, refused: true };

	return { orgId: scope.orgSlug, refused: false };
}

/**
 * Asserts that the caller (identified by orgId) is allowed to access the
 * given namespace.
 *
 * Rules:
 *   - orgId === null (master) → always allowed
 *   - namespace starts with team/<orgId> → allowed
 *   - otherwise → AUTH_NAMESPACE_DENIED
 */
function assertNamespaceAllowed(orgId: string | null, namespace: string): void {
	if (orgId === null) return; // master: unrestricted
	const ownPrefix = `team/${orgId}`;
	if (namespace === ownPrefix || namespace.startsWith(`${ownPrefix}/`)) return;
	throw new Error(
		`AUTH_NAMESPACE_DENIED: caller org "${orgId}" may not access namespace "${namespace}". ` +
			`Allowed prefix: "${ownPrefix}".`,
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// storeMemoryScoped — write with team/<orgId> enforcement
// ─────────────────────────────────────────────────────────────────────────────

export const storeMemoryScoped = mutation({
	args: {
		namespace: v.string(),
		type: memoryTypeValidator,
		content: v.string(),
		createdBy: creatorValidator,
		relations: v.optional(
			v.array(
				v.object({
					targetId: v.id("memories"),
					type: relationTypeValidator,
				}),
			),
		),
		isLatest: v.optional(v.boolean()),
		ttl: v.optional(v.string()),
		episode: v.optional(
			v.object({
				context: v.string(),
				goal: v.string(),
				action: v.string(),
				outcome: v.string(),
				insight: v.string(),
				severity: severityValidator,
			}),
		),
	},
	returns: v.id("memories"),
	handler: async (ctx, args) => {
		// write-contract: no caller outside convex-test — 0 call sites in mcp-server (grep of "memoriesScoped:storeMemoryScoped" under mcp-server/src and mcp-server/server-http.ts) and 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); callers are convex/__tests__ only. No subscribing pre-org client shell can reach it; the no-org throw is a refusal at an imperative SDK call, never at a render.
		// ── Auth: resolve org and enforce team namespace boundary ──
		// REFUSAL SHAPE -- THROW. This is a chosen, imperative WRITE: it has a
		// call site to catch the refusal, and a write refusal must never be
		// softened into a typed empty value (that would silently report success
		// for a write that never happened).
		const caller = await resolveCallerOrgId(ctx);
		if (caller.refused) {
			throw new Error(
				"AUTH_NAMESPACE_DENIED: caller has no verified organisation — " +
					"a write requires a verified org; an anonymous or org-less caller " +
					"is never promoted to master.",
			);
		}
		assertNamespaceAllowed(caller.orgId, args.namespace);

		const now = Date.now();
		const relations = args.relations ?? [];

		// NOTE: RAG embedding is NOT scheduled here — callers that need RAG
		// indexing should use the canonical memories:storeMemory mutation after
		// this auth gate passes. storeMemoryScoped is the enforcement-only variant
		// used by the Convex test suite and future Clerk-authenticated dashboard
		// writes. Keeping it scheduler-free avoids convex-test incompatibility
		// with _scheduled_functions writes.
		const memoryId = await ctx.db.insert("memories", {
			namespace: args.namespace,
			type: args.type,
			content: args.content,
			createdBy: args.createdBy,
			relations,
			isLatest: true,
			ttl: args.ttl,
			episode: args.episode,
			createdAt: now,
			updatedAt: now,
		});

		return memoryId;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listMemoriesScoped — read with team/<orgId> enforcement
// ─────────────────────────────────────────────────────────────────────────────

const memoryRowValidator = v.object({
	_id: v.id("memories"),
	_creationTime: v.number(),
	namespace: v.string(),
	type: memoryTypeValidator,
	content: v.string(),
	createdBy: creatorValidator,
	instanceId: v.optional(v.string()),
	relations: v.array(
		v.object({
			targetId: v.id("memories"),
			type: relationTypeValidator,
		}),
	),
	isLatest: v.boolean(),
	ttl: v.optional(v.string()),
	episode: v.optional(
		v.object({
			context: v.string(),
			goal: v.string(),
			action: v.string(),
			outcome: v.string(),
			insight: v.string(),
			severity: severityValidator,
		}),
	),
	createdAt: v.number(),
	updatedAt: v.number(),
	// R-18 import idempotency key; only OKF-imported rows carry it.
	contentHash: v.optional(v.string()),
});

export const listMemoriesScoped = query({
	args: {
		namespace: v.string(),
		type: v.optional(memoryTypeValidator),
		limit: v.optional(v.number()),
	},
	returns: v.array(memoryRowValidator),
	handler: async (ctx, args) => {
		// isolation-contract: NO reactive subscriber — enumerated with
		// `git -C /root/coding/vantage-peers-dashboard grep -nE "api\.memoriesScoped\." {origin/main,0466fac} -- app components hooks lib contexts providers` -> 0 hits at both commits
		// (vantage-peers-dashboard e2dc58f and 0466fac). DECLARED, NOT CLOSED: the no-organisation caller still receives the typed empty array below, the shape of
		// an absence (pinned by auth-namespace-deny.test.ts and anonymousCallerServedTenantRows.test.ts); with no subscriber it could raise, which is a
		// behaviour change to those pinned poles and is left to its own task. R-50 is satisfied (no throw reaches a subscription); refusal-is-distinguishable-from-absence is not.
		// ── Auth: resolve org and enforce team namespace boundary ──
		// REFUSAL SHAPE -- TYPED EMPTY for "no verified organisation": this is a
		// reactively-subscribed public READ, and a query that throws crashes the
		// subscribing client's render. Cross-tenant access by a caller who DOES
		// have a verified org keeps THROWING AUTH_NAMESPACE_DENIED below -- that
		// is an active boundary violation, not an ordinary unauthenticated state,
		// and its contract is pinned by auth-namespace-deny.test.ts.
		const caller = await resolveCallerOrgId(ctx);
		if (caller.refused) return [];
		assertNamespaceAllowed(caller.orgId, args.namespace);

		const limit = args.limit ?? 50;
		const { namespace, type } = args;

		if (type !== undefined) {
			return await ctx.db
				.query("memories")
				.withIndex("by_namespace_type", (qi) =>
					qi.eq("namespace", namespace).eq("type", type).eq("isLatest", true),
				)
				.order("desc")
				.take(limit);
		}

		return await ctx.db
			.query("memories")
			.withIndex("by_namespace", (qi) =>
				qi.eq("namespace", namespace).eq("isLatest", true),
			)
			.order("desc")
			.take(limit);
	},
});
