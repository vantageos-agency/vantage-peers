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
 *   - No-identity callers (MCP/CLI deploy key) retain master access (isMaster=true).
 *   - Unknown or unregistered orgs are FAIL-CLOSED (throw AUTH_NAMESPACE_DENIED).
 *
 * storeMemoryScoped  — enforced write: org_A cannot write to team/org_B.
 * listMemoriesScoped — enforced read: org_A cannot read from team/org_B.
 */

import { v } from "convex/values";
import type { DatabaseReader, MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
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
 * Resolves the Clerk identity's org_id. Returns null for no-identity callers
 * (MCP/CLI deploy key → master). Throws AUTH_NAMESPACE_DENIED for Clerk callers
 * whose org is unknown or inactive.
 *
 * Returns the caller's orgId string (for team/<orgId> prefix check) or null
 * (master: all namespaces allowed).
 */
async function resolveOrgId(ctx: QueryCtx | MutationCtx): Promise<string | null> {
	const identity = await ctx.auth.getUserIdentity();

	// No Clerk identity → master scope (MCP server / CLI / internal callers)
	if (!identity) return null;

	// Extract org_id across both claim casings — a Clerk-NATIVE session token
	// (no custom JWT template) delivers snake_case `org_id`/`org_slug`, not
	// camelCase `organizationId`/`organizationSlug` (IDENTITY-CLAIM CASING
	// CLASS — mirrors withOrgScope in convex/lib/auth.ts).
	const raw = identity as Record<string, unknown>;
	const orgId =
		(raw.organizationId as string | undefined) ??
		(raw.org_id as string | undefined) ??
		(raw.organizationSlug as string | undefined) ??
		(raw.org_slug as string | undefined) ??
		null;

	// Clerk caller without an org → also master (Laurent / internal dev)
	if (!orgId) return null;

	// Verify the org is registered and active in client_org_mapping
	const mapping = await (ctx.db as DatabaseReader)
		.query("client_org_mapping")
		.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", orgId))
		.first();

	if (!mapping?.isActive) {
		throw new Error(
			`AUTH_NAMESPACE_DENIED: org "${orgId}" is not registered or inactive`,
		);
	}

	return orgId;
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
		// ── Auth: resolve org and enforce team namespace boundary ──
		const orgId = await resolveOrgId(ctx);
		assertNamespaceAllowed(orgId, args.namespace);

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
		// ── Auth: resolve org and enforce team namespace boundary ──
		const orgId = await resolveOrgId(ctx);
		assertNamespaceAllowed(orgId, args.namespace);

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
