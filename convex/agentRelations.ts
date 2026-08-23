import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireOrgAdmin } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// [P-T3] agent_relations — the parent-child EDGE, on top of P-T2's `agents`
// entity table.
// ─────────────────────────────────────────────────────────────────────────────
//
// Governing cap analysis/le-cap/le-cap.md @ e3c1ffd6 §6 VP.2 (edge half): the
// layer does not know that one agent is another's child, nor that a child can
// be shared by two parents. This file is that graph — the missing relation an
// organisation model needs to clone, and the source the emitter reads the
// addresses it writes into a parent's remote-agent declaration
// (docs-guides-remote-agents.md: "`defineRemoteAgent` calls a separately
// deployed eve agent as if it were a local subagent").
//
// MANY-TO-MANY, deliberately: a child shared by two parents is TWO ROWS in
// `agent_relations`, never a parent field on the child row (which would cap a
// child at exactly one parent and could not represent the shared-child case
// the cap analysis calls out).
//
// Authorization: every mutation reuses `requireOrgAdmin` (convex/lib/auth.ts)
// — the SAME org-admin gate `agents.ts`'s `registerAgent`/`setAgentAddress`
// use — and every query below scopes strictly to the CALLER'S OWN org via the
// same function, never trusting a caller-supplied `orgSlug` argument to
// select which org's edges are visible (see `.claude/rules/authority-
// attached-to-anonymous-object.md`: authority is bound to the verified
// principal, never a caller-supplied value). There is no master carve-out —
// an org-admin identity of the target org is required every time.

const edgeReturnValidator = v.object({
	_id: v.id("agent_relations"),
	_creationTime: v.number(),
	orgSlug: v.string(),
	parentName: v.string(),
	childName: v.string(),
	createdAt: v.number(),
});

const graphNodeValidator = v.object({ name: v.string() });
const graphEdgeValidator = v.object({
	parentName: v.string(),
	childName: v.string(),
});

/**
 * linkChild — records a parent→child edge in the CALLER'S OWN org.
 *
 * Gated to the organisation ADMINISTRATOR via `requireOrgAdmin`, identical to
 * `agents.ts`'s `registerAgent`. Idempotent on (orgSlug, parentName,
 * childName): a second identical call does not insert a duplicate row.
 *
 * A child shared by two parents (parent1→child, parent2→child) is TWO
 * separate rows — this mutation never checks or enforces a single-parent
 * constraint.
 */
export const linkChild = mutation({
	args: {
		orgSlug: v.string(),
		parentName: v.string(),
		childName: v.string(),
	},
	returns: v.id("agent_relations"),
	handler: async (ctx, args) => {
		await requireOrgAdmin(ctx, args.orgSlug);

		const existing = await ctx.db
			.query("agent_relations")
			.withIndex("by_parent", (q) =>
				q.eq("orgSlug", args.orgSlug).eq("parentName", args.parentName),
			)
			.filter((q) => q.eq(q.field("childName"), args.childName))
			.unique();

		if (existing) {
			return existing._id;
		}

		return await ctx.db.insert("agent_relations", {
			orgSlug: args.orgSlug,
			parentName: args.parentName,
			childName: args.childName,
			createdAt: Date.now(),
		});
	},
});

/**
 * unlinkChild — removes a parent→child edge in the CALLER'S OWN org.
 * Gated identically to `linkChild`. No-op (returns null) if the edge does
 * not exist — deletion is idempotent.
 */
export const unlinkChild = mutation({
	args: {
		orgSlug: v.string(),
		parentName: v.string(),
		childName: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireOrgAdmin(ctx, args.orgSlug);

		const existing = await ctx.db
			.query("agent_relations")
			.withIndex("by_parent", (q) =>
				q.eq("orgSlug", args.orgSlug).eq("parentName", args.parentName),
			)
			.filter((q) => q.eq(q.field("childName"), args.childName))
			.unique();

		if (existing) {
			await ctx.db.delete(existing._id);
		}
		return null;
	},
});

/**
 * childrenOf — all children of `parentName`, org-scoped via `requireOrgAdmin`
 * so that a caller of org B passing org A's slug is REFUSED (RBAC_DENIED),
 * never silently emptied.
 */
export const childrenOf = query({
	args: { orgSlug: v.string(), parentName: v.string() },
	returns: v.array(edgeReturnValidator),
	handler: async (ctx, args) => {
		await requireOrgAdmin(ctx, args.orgSlug);

		return await ctx.db
			.query("agent_relations")
			.withIndex("by_parent", (q) =>
				q.eq("orgSlug", args.orgSlug).eq("parentName", args.parentName),
			)
			.collect();
	},
});

/**
 * parentsOf — all parents of `childName` (proves the shared-child case: a
 * child linked from two parents returns BOTH rows). Org-scoped via
 * `requireOrgAdmin`.
 */
export const parentsOf = query({
	args: { orgSlug: v.string(), childName: v.string() },
	returns: v.array(edgeReturnValidator),
	handler: async (ctx, args) => {
		await requireOrgAdmin(ctx, args.orgSlug);

		return await ctx.db
			.query("agent_relations")
			.withIndex("by_child", (q) =>
				q.eq("orgSlug", args.orgSlug).eq("childName", args.childName),
			)
			.collect();
	},
});

/**
 * graphByOrg — the whole org's parent-child graph as nodes + edges. Nodes are
 * the DISTINCT set of names appearing as either a parent or a child across
 * this org's edges (a name registered in `agents` but never linked does not
 * appear here — this is the EDGE graph, not the agent roster). Org-scoped via
 * `requireOrgAdmin`.
 */
export const graphByOrg = query({
	args: { orgSlug: v.string() },
	returns: v.object({
		nodes: v.array(graphNodeValidator),
		edges: v.array(graphEdgeValidator),
	}),
	handler: async (ctx, args) => {
		await requireOrgAdmin(ctx, args.orgSlug);

		const rows = await ctx.db
			.query("agent_relations")
			.withIndex("by_org", (q) => q.eq("orgSlug", args.orgSlug))
			.collect();

		const names = new Set<string>();
		const edges = rows.map((row) => {
			names.add(row.parentName);
			names.add(row.childName);
			return { parentName: row.parentName, childName: row.childName };
		});

		return {
			nodes: Array.from(names).map((name) => ({ name })),
			edges,
		};
	},
});

// Re-exported for callers that need the Id type without importing
// _generated/dataModel directly.
export type AgentRelationId = Id<"agent_relations">;
