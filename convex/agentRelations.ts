import type { ActingPrincipal } from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, mutation, query } from "./_generated/server";
import {
	loadAgentOfPrincipalOrg,
	anonymousRefusal,
	stampOrgRefusal,
	requireOrgAdminById,
} from "./lib/agentIdentity";
import { withOrgScope } from "./lib/auth";
import { clerkOrgIdForSlug } from "./lib/orgClerkId";

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
// Authorization: every door proves the caller an ADMINISTRATOR of `orgSlug`
// through @vantageos/cloud-identity (`requireOrgAdminById`,
// convex/lib/agentIdentity.ts) — the SAME gate `agents.ts` uses — scoped to the
// CALLER'S OWN org, never trusting a caller-supplied `orgSlug` argument to
// select which org's edges are visible (see `.claude/rules/authority-
// attached-to-anonymous-object.md`). There is no master carve-out.
//
// AGENTS ARE NAMED BY ID. The doors take `parentAgentId` / `childAgentId`; each
// must be an `agents` row of the caller's organisation (another organisation's
// agent is refused RBAC_DENIED, an ID naming no row raises AGENT_NOT_FOUND). The
// edge row stores a copy of each endpoint's current LABEL (the table has no
// agent-ID field); the doors derive that label from the row the ID names, never
// from a caller-typed name, and `agents:renameAgent` refreshes the copy.

const edgeReturnValidator = v.object({
	_id: v.id("agent_relations"),
	_creationTime: v.number(),
	orgSlug: v.string(),
	clerkOrgId: v.optional(v.string()),
	parentName: v.string(),
	childName: v.string(),
	createdAt: v.number(),
});

// The endpoint labels of an edge, read from the agent rows the IDs name.
async function endpointsOf(
	ctx: QueryCtx | MutationCtx,
	principal: ActingPrincipal,
	orgSlug: string,
	ids: Record<string, Id<"agents">>,
	door: string,
): Promise<Record<string, Doc<"agents">>> {
	const out: Record<string, Doc<"agents">> = {};
	for (const [role, agentId] of Object.entries(ids)) {
		const agent = await loadAgentOfPrincipalOrg(ctx, principal, agentId, door);
		if (!agent) {
			throw new ConvexError(
				`AGENT_NOT_FOUND: no ${role} agent ${agentId} in org "${orgSlug}" — ${JSON.stringify({ orgSlug, role, agentId })}`,
			);
		}
		out[role] = agent;
	}
	return out;
}

const graphNodeValidator = v.object({ name: v.string() });
const graphEdgeValidator = v.object({
	parentName: v.string(),
	childName: v.string(),
});

/**
 * linkChild — records a parent→child edge in the CALLER'S OWN org, between two
 * agents named BY ID.
 *
 * Gated to the organisation ADMINISTRATOR via `requireOrgAdminById`, identical
 * to `agents.ts`'s `registerAgent`. Idempotent on the (parent, child) pair: a
 * second identical call does not insert a duplicate row.
 *
 * A child shared by two parents (parent1→child, parent2→child) is TWO
 * separate rows — this mutation never checks or enforces a single-parent
 * constraint.
 */
export const linkChild = mutation({
	args: {
		orgSlug: v.string(),
		parentAgentId: v.id("agents"),
		childAgentId: v.id("agents"),
	},
	returns: v.id("agent_relations"),
	handler: async (ctx, args) => {
		// write-contract: no caller outside convex-test — 0 call sites in mcp-server (grep of "agentRelations:linkChild" under mcp-server/src and mcp-server/server-http.ts) and 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); callers are convex/__tests__ only. No subscribing pre-org client shell can reach it; the no-org throw is a refusal at an imperative SDK call, never at a render.
		const door = "agentRelations:linkChild";
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw anonymousRefusal(door);
		const principal = await requireOrgAdminById(ctx, identity, args.orgSlug, door);
		const scope = await withOrgScope(ctx);
		const orgSlug = scope.orgSlug;
		if (orgSlug === null || orgSlug !== principal.orgId) {
			throw stampOrgRefusal(door);
		}
		const { parent, child } = await endpointsOf(
			ctx,
			principal,
			args.orgSlug,
			{ parent: args.parentAgentId, child: args.childAgentId },
			door,
		);

		const existing = await ctx.db
			.query("agent_relations")
			.withIndex("by_parent", (q) =>
				q.eq("orgSlug", args.orgSlug).eq("parentName", parent.name),
			)
			.filter((q) => q.eq(q.field("childName"), child.name))
			.unique();

		if (existing) {
			return existing._id;
		}

		return await ctx.db.insert("agent_relations", {
			orgSlug,
			clerkOrgId: await clerkOrgIdForSlug(ctx, orgSlug),
			parentName: parent.name,
			childName: child.name,
			createdAt: Date.now(),
		});
	},
});

/**
 * unlinkChild — removes a parent→child edge in the CALLER'S OWN org, between
 * two agents named BY ID. Gated identically to `linkChild`. No-op (returns null) if the edge does
 * not exist — deletion is idempotent.
 */
export const unlinkChild = mutation({
	args: {
		orgSlug: v.string(),
		parentAgentId: v.id("agents"),
		childAgentId: v.id("agents"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// write-contract: no caller outside convex-test — 0 call sites in mcp-server (grep of "agentRelations:unlinkChild" under mcp-server/src and mcp-server/server-http.ts) and 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); callers are convex/__tests__ only. No subscribing pre-org client shell can reach it; the no-org throw is a refusal at an imperative SDK call, never at a render.
		const door = "agentRelations:unlinkChild";
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw anonymousRefusal(door);
		const principal = await requireOrgAdminById(ctx, identity, args.orgSlug, door);
		const { parent, child } = await endpointsOf(
			ctx,
			principal,
			args.orgSlug,
			{ parent: args.parentAgentId, child: args.childAgentId },
			door,
		);

		const existing = await ctx.db
			.query("agent_relations")
			.withIndex("by_parent", (q) =>
				q.eq("orgSlug", args.orgSlug).eq("parentName", parent.name),
			)
			.filter((q) => q.eq(q.field("childName"), child.name))
			.unique();

		if (existing) {
			await ctx.db.delete(existing._id);
		}
		return null;
	},
});

/**
 * childrenOf — all children of the agent `parentAgentId`, org-scoped via
 * `requireOrgAdminById` so that a caller of org B passing org A's slug is
 * REFUSED (RBAC_DENIED), never silently emptied.
 */
export const childrenOf = query({
	args: { orgSlug: v.string(), parentAgentId: v.id("agents") },
	returns: v.array(edgeReturnValidator),
	handler: async (ctx, args) => {
		// isolation-contract: NO reactive subscriber — enumerated with
		// `git -C /root/coding/vantage-peers-dashboard grep -nE "api\.agentRelations\." {origin/main,0466fac} -- app components hooks lib contexts providers` -> 0 hits at both commits
		// (vantage-peers-dashboard e2dc58f and 0466fac). The refusal stays a RAISE: `requireOrgAdminById` throws RBAC_DENIED for the anonymous, the no-organisation and the wrong-organisation caller alike, and no render exists for a throw to crash.
		const door = "agentRelations:childrenOf";
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw anonymousRefusal(door);
		const principal = await requireOrgAdminById(ctx, identity, args.orgSlug, door);
		const { parent } = await endpointsOf(
			ctx,
			principal,
			args.orgSlug,
			{ parent: args.parentAgentId },
			door,
		);

		return await ctx.db
			.query("agent_relations")
			.withIndex("by_parent", (q) =>
				q.eq("orgSlug", args.orgSlug).eq("parentName", parent.name),
			)
			.collect();
	},
});

/**
 * parentsOf — all parents of the agent `childAgentId` (proves the shared-child
 * case: a child linked from two parents returns BOTH rows). Org-scoped via
 * `requireOrgAdminById`.
 */
export const parentsOf = query({
	args: { orgSlug: v.string(), childAgentId: v.id("agents") },
	returns: v.array(edgeReturnValidator),
	handler: async (ctx, args) => {
		// isolation-contract: NO reactive subscriber — enumerated with
		// `git -C /root/coding/vantage-peers-dashboard grep -nE "api\.agentRelations\." {origin/main,0466fac} -- app components hooks lib contexts providers` -> 0 hits at both commits
		// (vantage-peers-dashboard e2dc58f and 0466fac). The refusal stays a RAISE: `requireOrgAdminById` throws RBAC_DENIED for the anonymous, the no-organisation and the wrong-organisation caller alike, and no render exists for a throw to crash.
		const door = "agentRelations:parentsOf";
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw anonymousRefusal(door);
		const principal = await requireOrgAdminById(ctx, identity, args.orgSlug, door);
		const { child } = await endpointsOf(
			ctx,
			principal,
			args.orgSlug,
			{ child: args.childAgentId },
			door,
		);

		return await ctx.db
			.query("agent_relations")
			.withIndex("by_child", (q) =>
				q.eq("orgSlug", args.orgSlug).eq("childName", child.name),
			)
			.collect();
	},
});

/**
 * graphByOrg — the whole org's parent-child graph as nodes + edges. Nodes are
 * the DISTINCT set of names appearing as either a parent or a child across
 * this org's edges (a name registered in `agents` but never linked does not
 * appear here — this is the EDGE graph, not the agent roster). Org-scoped via
 * `requireOrgAdminById`.
 */
export const graphByOrg = query({
	args: { orgSlug: v.string() },
	returns: v.object({
		nodes: v.array(graphNodeValidator),
		edges: v.array(graphEdgeValidator),
	}),
	handler: async (ctx, args) => {
		// isolation-contract: NO reactive subscriber — enumerated with
		// `git -C /root/coding/vantage-peers-dashboard grep -nE "api\.agentRelations\." {origin/main,0466fac} -- app components hooks lib contexts providers` -> 0 hits at both commits
		// (vantage-peers-dashboard e2dc58f and 0466fac). The refusal stays a RAISE: `requireOrgAdminById` throws RBAC_DENIED for the anonymous, the no-organisation and the wrong-organisation caller alike, and no render exists for a throw to crash.
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw anonymousRefusal("agentRelations:graphByOrg");
		await requireOrgAdminById(ctx, identity, args.orgSlug, "agentRelations:graphByOrg");

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
