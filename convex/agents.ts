import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { revokeActiveCredentialRows } from "./lib/agentIdentity";
import { requireOrgAdmin } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// [P-T2] agents — the agent as an ENTITY carrying its organisation.
// ─────────────────────────────────────────────────────────────────────────────
//
// Governing cap analysis/le-cap/le-cap.md @ e3c1ffd6 §6 VP.2 (corrected):
// `mcp__vantage-peers__list_peers` rows carry id/instanceId/name/role/
// workspace/currentTask/lastSeen/sessionCount and NO organisation field — org
// membership rides on the CALLING TOKEN, never on the agent row itself. This
// file is the missing organisation carrier: a CREATE, not an extension of any
// existing shape.
//
// The parent-child edge (P-T3) is deliberately NOT modeled here — it attaches
// ON TOP of this table in a separate layer (docs-subagents.md: "A declared
// subagent inherits nothing from the root's authored slots").
//
// Authorization: every mutation here reuses `requireOrgAdmin` (convex/lib/
// auth.ts) — the SAME org-admin gate `provisionOrganization` uses — and every
// query below scopes strictly to the CALLER'S OWN org via the same function,
// never trusting a caller-supplied `orgSlug` argument to select which org's
// rows are visible (see `.claude/rules/authority-attached-to-anonymous-
// object.md`: authority is bound to the verified principal, never a
// caller-supplied value).

const agentReturnValidator = v.object({
	_id: v.id("agents"),
	_creationTime: v.number(),
	orgSlug: v.string(),
	name: v.string(),
	description: v.optional(v.string()),
	address: v.optional(v.string()),
	outboundAuthRef: v.optional(v.string()),
	isActive: v.boolean(),
	createdAt: v.number(),
});

/**
 * registerAgent — creates or updates an agent row in the CALLER'S OWN org.
 *
 * Gated to the organisation ADMINISTRATOR via `requireOrgAdmin`, which
 * verifies the caller's own org (never a caller-supplied identity claim)
 * equals `args.orgSlug`, that the caller's role normalizes to "admin", and
 * that `args.orgSlug` is an ACTIVE row in `client_org_mapping`. There is no
 * master carve-out on this mutation — an org-admin identity is required
 * every time (see the "MASTER note" test in
 * convex/__tests__/agentsEntity.test.ts).
 *
 * Idempotent on (orgSlug, name): a second call with the same pair UPDATES
 * the existing row (description/outboundAuthRef) rather than creating a
 * duplicate, reusing the `by_org_name` index.
 *
 * INACTIVE ROWS ARE NOT SILENTLY REVIVED. This branch used to patch
 * `isActive: true` unconditionally, so re-registering a name retired by
 * `deactivateAgent` resurrected it with no signal: the defect the retire
 * surface closes, wearing the fix's clothes. A row with `isActive === false`
 * is now REFUSED, unconditionally, with `AGENT_INACTIVE`; there is no opt-in
 * argument. Bringing an identity back is an act someone chose
 * (`reactivateAgent`), never a side effect of an idempotent call.
 *   - An earlier draft took `reactivate: true` here. Rejected on review: a
 *     flag on an idempotent upsert keeps reactivation a side effect of that
 *     call.
 *   - The objection that an unconditional refusal burns a retired name
 *     forever is answered by `reactivateAgent`, the dedicated third door.
 * Reactivating does NOT revive revoked credentials; mint a new one.
 */
export const registerAgent = mutation({
	args: {
		orgSlug: v.string(),
		name: v.string(),
		description: v.optional(v.string()),
		outboundAuthRef: v.optional(v.string()),
	},
	returns: v.id("agents"),
	handler: async (ctx, args) => {
		await requireOrgAdmin(ctx, args.orgSlug);

		const existing = await ctx.db
			.query("agents")
			.withIndex("by_org_name", (q) =>
				q.eq("orgSlug", args.orgSlug).eq("name", args.name),
			)
			.unique();

		if (existing) {
			if (!existing.isActive) {
				throw new ConvexError(
					`AGENT_INACTIVE: agent "${args.name}" in org "${args.orgSlug}" is inactive; use reactivateAgent to bring it back — ${JSON.stringify(
						{ orgSlug: args.orgSlug, name: args.name },
					)}`,
				);
			}
			await ctx.db.patch(existing._id, {
				description: args.description,
				outboundAuthRef: args.outboundAuthRef,
				isActive: true,
			});
			return existing._id;
		}

		return await ctx.db.insert("agents", {
			orgSlug: args.orgSlug,
			name: args.name,
			description: args.description,
			outboundAuthRef: args.outboundAuthRef,
			isActive: true,
			createdAt: Date.now(),
		});
	},
});

/**
 * setAgentAddress — the write-back path used AFTER an agent deploys. The
 * emitter (P-T3's parent-child edge layer) reads this address as the source
 * for a parent's remote-agent declaration. Gated identically to
 * `registerAgent` — only the ORG ADMIN of the agent's own org may write it.
 */
export const setAgentAddress = mutation({
	args: {
		orgSlug: v.string(),
		name: v.string(),
		address: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireOrgAdmin(ctx, args.orgSlug);

		const existing = await ctx.db
			.query("agents")
			.withIndex("by_org_name", (q) =>
				q.eq("orgSlug", args.orgSlug).eq("name", args.name),
			)
			.unique();

		if (!existing) {
			throw new ConvexError(
				`AGENT_NOT_FOUND: no agent "${args.name}" in org "${args.orgSlug}" — ${JSON.stringify(
					{ orgSlug: args.orgSlug, name: args.name },
				)}`,
			);
		}

		await ctx.db.patch(existing._id, { address: args.address });
		return null;
	},
});

/**
 * deactivateAgent — retires ONE agent of the caller's own org: patches
 * `isActive: false` AND revokes every active credential of that agent, in the
 * SAME mutation (one transaction). A retirement that depends on the operator
 * remembering a second call leaves a retired agent holding a key that still
 * resolves. Gated identically to `registerAgent`: `requireOrgAdmin`, no
 * master carve-out. PATCH, never delete; the audit trail is preserved.
 *
 * The credential revoke runs even when the agent was already inactive, so a
 * row deactivated before this door existed heals on the next call. The revoke
 * is the shared `revokeActiveCredentialRows` (convex/lib/agentIdentity.ts),
 * the same implementation `revokeAgentCredential` uses.
 *
 * Unknown name raises `AGENT_NOT_FOUND` (same as `setAgentAddress`), checked
 * BEFORE anything is written.
 *
 * RETURNS `{ deactivated: boolean, revoked: number }`:
 *   - deactivated true  = this call flipped the row; false = already inactive;
 *   - revoked = credential rows this call flipped (0 is a real zero).
 * "Retired just now" and "was already retired" must not be the same bytes
 * (.claude/rules/refusal-is-distinguishable-from-absence.md).
 */
export const deactivateAgent = mutation({
	args: { orgSlug: v.string(), name: v.string() },
	returns: v.object({ deactivated: v.boolean(), revoked: v.number() }),
	handler: async (ctx, args) => {
		await requireOrgAdmin(ctx, args.orgSlug);

		const existing = await ctx.db
			.query("agents")
			.withIndex("by_org_name", (q) =>
				q.eq("orgSlug", args.orgSlug).eq("name", args.name),
			)
			.unique();

		if (!existing) {
			throw new ConvexError(
				`AGENT_NOT_FOUND: no agent "${args.name}" in org "${args.orgSlug}" — ${JSON.stringify(
					{ orgSlug: args.orgSlug, name: args.name },
				)}`,
			);
		}

		const revoked = await revokeActiveCredentialRows(
			ctx,
			args.orgSlug,
			args.name,
		);
		const deactivated = existing.isActive;
		if (deactivated) {
			await ctx.db.patch(existing._id, { isActive: false });
		}
		return { deactivated, revoked };
	},
});

/**
 * reactivateAgent — the explicit door back for a retired agent: patches
 * `isActive: true`. Gated by `requireOrgAdmin`, no master carve-out. It is the
 * answer to "an unconditional refusal in `registerAgent` would burn a retired
 * name forever": the name is reusable, but only by a deliberate call.
 *
 * It does NOT resurrect credentials: revoked rows stay revoked, and a fresh
 * one must be minted with `mintAgentCredential`.
 *
 * Unknown name raises `AGENT_NOT_FOUND`.
 * RETURNS `{ reactivated: boolean }`: true = this call flipped the row,
 * false = it was already active.
 */
export const reactivateAgent = mutation({
	args: { orgSlug: v.string(), name: v.string() },
	returns: v.object({ reactivated: v.boolean() }),
	handler: async (ctx, args) => {
		await requireOrgAdmin(ctx, args.orgSlug);

		const existing = await ctx.db
			.query("agents")
			.withIndex("by_org_name", (q) =>
				q.eq("orgSlug", args.orgSlug).eq("name", args.name),
			)
			.unique();

		if (!existing) {
			throw new ConvexError(
				`AGENT_NOT_FOUND: no agent "${args.name}" in org "${args.orgSlug}" — ${JSON.stringify(
					{ orgSlug: args.orgSlug, name: args.name },
				)}`,
			);
		}

		const reactivated = !existing.isActive;
		if (reactivated) {
			await ctx.db.patch(existing._id, { isActive: true });
		}
		return { reactivated };
	},
});

/**
 * getAgent — org-scoped lookup by (orgSlug, name). Gated via `requireOrgAdmin`
 * so that `args.orgSlug` is bound to the CALLER'S OWN org — a caller of org B
 * passing org A's slug is REFUSED (RBAC_DENIED), never silently emptied.
 */
export const getAgent = query({
	args: { orgSlug: v.string(), name: v.string() },
	returns: v.union(agentReturnValidator, v.null()),
	handler: async (ctx, args) => {
		await requireOrgAdmin(ctx, args.orgSlug);

		return await ctx.db
			.query("agents")
			.withIndex("by_org_name", (q) =>
				q.eq("orgSlug", args.orgSlug).eq("name", args.name),
			)
			.unique();
	},
});

/**
 * listAgentsByOrg — org-scoped listing. Gated via `requireOrgAdmin` so that
 * `args.orgSlug` is bound to the CALLER'S OWN org — never a free-form
 * cross-org read.
 */
export const listAgentsByOrg = query({
	args: { orgSlug: v.string() },
	returns: v.array(agentReturnValidator),
	handler: async (ctx, args) => {
		await requireOrgAdmin(ctx, args.orgSlug);

		return await ctx.db
			.query("agents")
			.withIndex("by_org", (q) => q.eq("orgSlug", args.orgSlug))
			.collect();
	},
});

// Re-exported for callers that need the Id type without importing
// _generated/dataModel directly.
export type AgentId = Id<"agents">;
