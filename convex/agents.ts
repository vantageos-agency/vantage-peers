import { type ActingPrincipal, isPersonActorName } from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { normalizeOrchestratorId } from "./_helpers/normalizeOrchestratorId";
import {
	assertAgentNameFree,
	loadAgentOfPrincipalOrg,
	anonymousRefusal,
	stampOrgRefusal,
	requireOrgAdminById,
	revokeActiveCredentialRows,
} from "./lib/agentIdentity";
import { withOrgScope } from "./lib/auth";
import { clerkOrgIdForSlug } from "./lib/orgClerkId";

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
// Authorization: every door here proves the caller an ADMINISTRATOR of
// `args.orgSlug` through @vantageos/cloud-identity (`requireOrgAdminById`,
// convex/lib/agentIdentity.ts: `resolveActingPrincipal` + `assertOrgAdmin`),
// built only from the verified session, never from an argument (see
// `.claude/rules/authority-attached-to-anonymous-object.md`).
//
// IDENTITY IS THE AGENT ID. Every door that acts on an existing agent takes its
// `agentId` (the `agents` row id). A name is a display label: it is checked for
// uniqueness inside its org as a UX constraint and shown, but it never selects
// a row and never authorises one. The row an ID names must belong to the
// caller's organisation (`assertTargetBelongsTo`, by stored organisation ID);
// another organisation's agent is REFUSED, never returned and never touched.

const agentReturnValidator = v.object({
	_id: v.id("agents"),
	_creationTime: v.number(),
	orgSlug: v.string(),
	clerkOrgId: v.optional(v.string()),
	name: v.string(),
	normalizedName: v.optional(v.string()),
	formerNames: v.optional(v.array(v.string())),
	description: v.optional(v.string()),
	address: v.optional(v.string()),
	outboundAuthRef: v.optional(v.string()),
	isActive: v.boolean(),
	createdAt: v.number(),
});

// A label that is empty (after normalisation) labels nothing. This validates a
// DISPLAY LABEL; it does not, and cannot, name an identity.
function assertAgentLabelValid(name: string): void {
	if (normalizeOrchestratorId(name) === "") {
		throw new ConvexError(
			`AGENT_NAME_INVALID: an agent name must not be empty or whitespace-only — ${JSON.stringify({ name })}`,
		);
	}
	// "user:<subject>" is how a PERSON is recorded; the spelling and the
	// reservation belong to @vantageos/cloud-identity. An agent so named would
	// read as a person on every row it touched.
	if (isPersonActorName(name)) {
		throw new ConvexError(
			`AGENT_NAME_RESERVED: an agent name may not start with "user:", the prefix that records a person — ${JSON.stringify({ name })}`,
		);
	}
}

// The agent an `agentId` names inside the caller's organisation, or a thrown
// AGENT_NOT_FOUND. An ID naming a row of ANOTHER organisation never reaches
// here: `loadAgentOfPrincipalOrg` refuses it RBAC_DENIED first.
async function requireOwnAgent(
	ctx: MutationCtx,
	principal: ActingPrincipal,
	orgSlug: string,
	agentId: Id<"agents">,
	door: string,
): Promise<Doc<"agents">> {
	const agent = await loadAgentOfPrincipalOrg(ctx, principal, agentId, door);
	if (!agent) {
		throw new ConvexError(
			`AGENT_NOT_FOUND: no agent ${agentId} in org "${orgSlug}" — ${JSON.stringify({ orgSlug, agentId })}`,
		);
	}
	return agent;
}

/**
 * registerAgent — CREATES an agent row in the CALLER'S OWN org and returns its
 * ID. That ID is the agent's identity from now on.
 *
 * Gated to the organisation ADMINISTRATOR through @vantageos/cloud-identity
 * (`requireOrgAdminById`): the caller's own verified org must equal
 * `args.orgSlug`, its role must be an admin role, and `args.orgSlug` must be an
 * ACTIVE row in `client_org_mapping`. There is no master carve-out — an
 * org-admin identity is required every time.
 *
 * `name` is a DISPLAY LABEL, unique per org under `normalizeOrchestratorId`
 * (`Ada` vs `ada` is the same label). A label already held by another agent of
 * the org is REFUSED `AGENT_NAME_TAKEN` and the refusal names the holder BY ID
 * (`existingAgentId`); a label held by a RETIRED agent is refused
 * `AGENT_INACTIVE` and names `reactivateAgent`. A second call with the same
 * label therefore never selects, updates or revives the first row: the name
 * does not pick a row. The same label in another org is a different agent.
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
		// write-contract: imperative dashboard caller, no subscriber — components/agents/register-agent-form.tsx:30 (useMutation(api.agents.registerAgent), invoked from an event handler, never a render subscription); operator script scripts/mint-station-agents.mjs:147 client.mutation(api.agents.registerAgent) (imperative); 0 call sites in mcp-server/src and mcp-server/server-http.ts. Measured 2026-10-03 with `grep -rn "agents:registerAgent\|agents\.registerAgent" mcp-server/src mcp-server/server-http.ts scripts` -> scripts/mint-station-agents.mjs:147 only and `git -C <dashboard> grep -nE "api\.(agents|agentCredentials)\." origin/main -- app components hooks lib contexts providers` (dashboard origin/main 00a43cf, measured 2026-10-03); also convex/__tests__. No subscribing pre-org client shell can reach it at render time; the no-org throw is a refusal at an imperative call, never at a render.
		// The stamp is the caller's RESOLVED scope organisation (the admin proof
		// already required it to equal `args.orgSlug`), never the argument.
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw anonymousRefusal("agents:registerAgent");
		const principal = await requireOrgAdminById(ctx, identity, args.orgSlug, "agents:registerAgent");
		const scope = await withOrgScope(ctx);
		const orgSlug = scope.orgSlug;
		if (orgSlug === null || orgSlug !== principal.orgId) {
			throw stampOrgRefusal("agents:registerAgent");
		}

		assertAgentLabelValid(args.name);
		await assertAgentNameFree(ctx, orgSlug, args.name);

		return await ctx.db.insert("agents", {
			orgSlug,
			clerkOrgId: await clerkOrgIdForSlug(ctx, orgSlug),
			name: args.name,
			normalizedName: normalizeOrchestratorId(args.name),
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
 * `registerAgent` — only the ORG ADMIN of the agent's own org may write it —
 * and addressed by `agentId`: an ID naming another organisation's agent is
 * refused RBAC_DENIED, an ID naming no row raises AGENT_NOT_FOUND.
 */
export const setAgentAddress = mutation({
	args: {
		orgSlug: v.string(),
		agentId: v.id("agents"),
		address: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// write-contract: imperative dashboard caller, no subscriber — components/agents/agent-row.tsx:122 (useMutation(api.agents.setAgentAddress), invoked from an event handler, never a render subscription); 0 call sites in mcp-server/src, mcp-server/server-http.ts and scripts. Measured 2026-10-03 with `grep -rn "agents:setAgentAddress\|agents\.setAgentAddress" mcp-server/src mcp-server/server-http.ts scripts` -> 0 hits and `git -C <dashboard> grep -nE "api\.(agents|agentCredentials)\." origin/main -- app components hooks lib contexts providers` (dashboard origin/main 00a43cf, measured 2026-10-03); also convex/__tests__. No subscribing pre-org client shell can reach it at render time; the no-org throw is a refusal at an imperative call, never at a render.
		const door = "agents:setAgentAddress";
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw anonymousRefusal(door);
		const principal = await requireOrgAdminById(ctx, identity, args.orgSlug, door);
		const existing = await requireOwnAgent(ctx, principal, args.orgSlug, args.agentId, door);

		await ctx.db.patch(existing._id, { address: args.address });
		return null;
	},
});

/**
 * deactivateAgent — retires ONE agent of the caller's own org: patches
 * `isActive: false` AND revokes every active credential of that agent, in the
 * SAME mutation (one transaction). A retirement that depends on the operator
 * remembering a second call leaves a retired agent holding a key that still
 * resolves. Gated identically to `registerAgent`: `requireOrgAdminById`, no
 * master carve-out. PATCH, never delete; the audit trail is preserved.
 *
 * The credential revoke runs even when the agent was already inactive, so a
 * row deactivated before this door existed heals on the next call. The revoke
 * is the shared `revokeActiveCredentialRows` (convex/lib/agentIdentity.ts),
 * the same implementation `revokeAgentCredential` uses.
 *
 * Addressed by `agentId`. An ID naming no row raises `AGENT_NOT_FOUND` (same as
 * `setAgentAddress`), checked BEFORE anything is written; an ID naming another
 * organisation's agent is refused RBAC_DENIED.
 *
 * RETURNS `{ deactivated: boolean, revoked: number }`:
 *   - deactivated true  = this call flipped the row; false = already inactive;
 *   - revoked = credential rows this call flipped (0 is a real zero).
 * "Retired just now" and "was already retired" must not be the same bytes
 * (.claude/rules/refusal-is-distinguishable-from-absence.md).
 */
export const deactivateAgent = mutation({
	args: { orgSlug: v.string(), agentId: v.id("agents") },
	returns: v.object({ deactivated: v.boolean(), revoked: v.number() }),
	handler: async (ctx, args) => {
		// write-contract: imperative dashboard caller, no subscriber — components/agents/agent-row.tsx:123 (useMutation(api.agents.deactivateAgent), invoked from an event handler, never a render subscription); 0 call sites in mcp-server/src, mcp-server/server-http.ts and scripts. Measured 2026-10-03 with `grep -rn "agents:deactivateAgent\|agents\.deactivateAgent" mcp-server/src mcp-server/server-http.ts scripts` -> 0 hits and `git -C <dashboard> grep -nE "api\.(agents|agentCredentials)\." origin/main -- app components hooks lib contexts providers` (dashboard origin/main 00a43cf, measured 2026-10-03); also convex/__tests__. A signed-in caller with no organisation is refused RBAC_DENIED by requireOrgAdminById, an R-16 refusal thrown at an imperative call, never at a render.
		const door = "agents:deactivateAgent";
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw anonymousRefusal(door);
		const principal = await requireOrgAdminById(ctx, identity, args.orgSlug, door);
		const existing = await requireOwnAgent(ctx, principal, args.orgSlug, args.agentId, door);

		const revoked = await revokeActiveCredentialRows(ctx, existing._id);
		const deactivated = existing.isActive;
		if (deactivated) {
			await ctx.db.patch(existing._id, { isActive: false });
		}
		return { deactivated, revoked };
	},
});

/**
 * reactivateAgent — the explicit door back for a retired agent: patches
 * `isActive: true`. Gated by `requireOrgAdminById`, no master carve-out. It is the
 * answer to "an unconditional refusal in `registerAgent` would burn a retired
 * name forever": the name is reusable, but only by a deliberate call.
 *
 * REACTIVATION RESTORES THE IDENTITY AND NEVER A CREDENTIAL. A reactivated
 * agent holds zero usable credentials and must be re-minted with
 * `mintAgentCredential`. Before patching `isActive: true` this mutation
 * sweeps (`revokeActiveCredentialRows`) every active credential of the agent,
 * not because it was active before but because the identity was retired at
 * all.
 *
 * TWO SWEEPS, ON PURPOSE — DO NOT DELETE ONE AS REDUNDANT. `deactivateAgent`
 * sweeps on the retirement; this sweeps on the return. The second exists to
 * catch a credential that ESCAPED the first, by whatever path: a partial
 * failure, a row written between the two calls, or a code path not written
 * yet. If retiring an identity and bringing it back could leave any
 * credential able to resolve, deactivate-then-reactivate would be a way to
 * keep an old key alive while appearing to have retired it, and retirement
 * would be a state change with no authority consequence. Belt and braces is
 * the control, not waste.
 *
 * The sweep runs and is reported even when the row was already active (like
 * `deactivateAgent` on an already-inactive agent): a non-zero `revoked` is a
 * finding the operator must see, never hidden behind the `reactivated` flag.
 * It runs BEFORE the patch, after the existence check.
 *
 * Addressed by `agentId`; an ID naming no row raises `AGENT_NOT_FOUND`, one
 * naming another organisation's agent is refused RBAC_DENIED.
 * RETURNS `{ reactivated: boolean, revoked: number }`: reactivated true = this
 * call flipped the row, false = it was already active; revoked = credential
 * rows this call swept (0 is a real zero).
 */
export const reactivateAgent = mutation({
	args: { orgSlug: v.string(), agentId: v.id("agents") },
	returns: v.object({ reactivated: v.boolean(), revoked: v.number() }),
	handler: async (ctx, args) => {
		// write-contract: imperative dashboard caller, no subscriber — components/agents/agent-row.tsx:124 (useMutation(api.agents.reactivateAgent), invoked from an event handler, never a render subscription); 0 call sites in mcp-server/src, mcp-server/server-http.ts and scripts. Measured 2026-10-03 with `grep -rn "agents:reactivateAgent\|agents\.reactivateAgent" mcp-server/src mcp-server/server-http.ts scripts` -> 0 hits and `git -C <dashboard> grep -nE "api\.(agents|agentCredentials)\." origin/main -- app components hooks lib contexts providers` (dashboard origin/main 00a43cf, measured 2026-10-03); also convex/__tests__. This is the way BACK for a retired identity and also sweeps credentials, so it is a deliberately chosen admin act; requireOrgAdminById refuses it RBAC_DENIED at an imperative call, an R-16 refusal rather than an uncaught Server Error.
		const door = "agents:reactivateAgent";
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw anonymousRefusal(door);
		const principal = await requireOrgAdminById(ctx, identity, args.orgSlug, door);
		const existing = await requireOwnAgent(ctx, principal, args.orgSlug, args.agentId, door);

		// THE SWEEP IS SCOPED TO THE inactive -> active TRANSITION, and that
		// bound is load-bearing. Sweeping unconditionally — which this handler
		// did at 00bd640a — turns reactivateAgent into an OUTAGE PATH: a
		// doubled call, or a call naming a live agent by mistake, silently
		// revokes a working client's credential and the client simply stops
		// authenticating. Reviewer verdict on #1380 @ 00bd640a.
		//
		// The retirement bypass this sweep exists to close only arises on the
		// RETURN of a retired identity, so that is the only place it belongs:
		// a credential that escaped `deactivateAgent`'s sweep meets this one
		// when the identity comes back. An agent that was never retired has no
		// escaped credential to catch, so the sweep buys nothing there and
		// costs an outage. Belt and braces across the two ENDS of a
		// retirement, never a sweep on every call — do not "simplify" this by
		// hoisting it out of the branch.
		const reactivated = !existing.isActive;
		let revoked = 0;
		if (reactivated) {
			revoked = await revokeActiveCredentialRows(ctx, existing._id);
			await ctx.db.patch(existing._id, { isActive: true });
		}
		return { reactivated, revoked };
	},
});

/** Most former labels one agent row remembers (see `agents.formerNames`). */
export const FORMER_NAMES_CAP = 50;

/**
 * Edges rewritten per side (parent, child) per transaction by `renameAgent`
 * and its continuation. Both the read (`.take`) and the write (`patch`) are
 * bounded by it; the remainder is drained by `renameAgentRelations`.
 */
export const RENAME_RELATIONS_BATCH_SIZE = 100;

/**
 * Rewrites at most RENAME_RELATIONS_BATCH_SIZE edges per side from `oldName`
 * to `newName` within one org. Returns true when either side filled its batch
 * (more edges may remain). No cursor is needed: a rewritten edge leaves the
 * `(orgSlug, oldName)` index range, so the next `.take` reads the next
 * un-rewritten edges.
 */
async function renameRelationsBatch(
	ctx: MutationCtx,
	orgSlug: string,
	oldName: string,
	newName: string,
): Promise<boolean> {
	const asParent = await ctx.db
		.query("agent_relations")
		.withIndex("by_parent", (q) =>
			q.eq("orgSlug", orgSlug).eq("parentName", oldName),
		)
		.take(RENAME_RELATIONS_BATCH_SIZE);
	for (const edge of asParent) {
		await ctx.db.patch(edge._id, { parentName: newName });
	}
	const asChild = await ctx.db
		.query("agent_relations")
		.withIndex("by_child", (q) =>
			q.eq("orgSlug", orgSlug).eq("childName", oldName),
		)
		.take(RENAME_RELATIONS_BATCH_SIZE);
	for (const edge of asChild) {
		await ctx.db.patch(edge._id, { childName: newName });
	}
	return (
		asParent.length === RENAME_RELATIONS_BATCH_SIZE ||
		asChild.length === RENAME_RELATIONS_BATCH_SIZE
	);
}

/**
 * renameAgentRelations — the self-scheduled continuation of `renameAgent`.
 * Internal only: the caller was authorised (`requireOrgAdminById`) by the public
 * mutation that scheduled it, and `orgSlug` is the one that call proved. The
 * edge set is scoped by `(orgSlug, oldName)` so another org's edges that carry
 * the same label are never read.
 */
export const renameAgentRelations = internalMutation({
	args: { orgSlug: v.string(), oldName: v.string(), newName: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const more = await renameRelationsBatch(
			ctx,
			args.orgSlug,
			args.oldName,
			args.newName,
		);
		if (more) {
			await ctx.scheduler.runAfter(0, internal.agents.renameAgentRelations, args);
		}
		return null;
	},
});

/**
 * renameAgent — changes an agent's DISPLAY LABEL, nothing else. The agent is
 * addressed by its `agentId` and IS its row (`_id`): its credentials, its
 * directory entry, and everything else keyed on the ID are untouched, so a
 * rename never orphans a grant. No roster is rewritten.
 * Gated like `registerAgent` (org administrator, no master carve-out). The new
 * label must be free in this org under `normalizeOrchestratorId`
 * (`AGENT_NAME_TAKEN` otherwise); renaming to another spelling of the agent's
 * OWN label (`ada` -> `Ada`) is allowed. An ID naming no row raises
 * `AGENT_NOT_FOUND`; an ID naming another organisation's agent is refused.
 *
 * `agent_relations` rows keep a DENORMALISED COPY of each endpoint's label (the
 * table stores no agent ID), so the copy is refreshed to the new label in
 * batches of RENAME_RELATIONS_BATCH_SIZE per side (R-31): the first batch in
 * this transaction, the rest via the self-scheduled `renameAgentRelations`.
 * The edges are reached by ID at the doors (`agentRelations.ts`); only the
 * stored label copy follows the rename.
 */
export const renameAgent = mutation({
	args: { orgSlug: v.string(), agentId: v.id("agents"), newName: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		// write-contract: imperative dashboard caller, no subscriber — components/agents/agent-row.tsx:121 (useMutation(api.agents.renameAgent), invoked from an event handler, never a render subscription); 0 call sites in mcp-server/src, mcp-server/server-http.ts and scripts. Measured 2026-10-03 with `grep -rn "agents:renameAgent\|agents\.renameAgent" mcp-server/src mcp-server/server-http.ts scripts` -> 0 hits and `git -C <dashboard> grep -nE "api\.(agents|agentCredentials)\." origin/main -- app components hooks lib contexts providers` (dashboard origin/main 00a43cf, measured 2026-10-03); also convex/__tests__. requireOrgAdminById refuses it RBAC_DENIED at an imperative call, never at a render.
		const door = "agents:renameAgent";
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw anonymousRefusal(door);
		const principal = await requireOrgAdminById(ctx, identity, args.orgSlug, door);
		assertAgentLabelValid(args.newName);

		const existing = await requireOwnAgent(ctx, principal, args.orgSlug, args.agentId, door);
		await assertAgentNameFree(ctx, args.orgSlug, args.newName, existing._id);

		const oldName = existing.name;
		const newKey = normalizeOrchestratorId(args.newName);
		const oldKey = normalizeOrchestratorId(oldName);
		// The label this row leaves is remembered on the row, so a roster that
		// still names it keeps resolving to the same agent ID. A label the row
		// takes back is no longer "former". Bounded: the newest FORMER_NAMES_CAP.
		const formerNames = [...(existing.formerNames ?? []), oldKey]
			.filter((key, at, all) => key !== newKey && all.indexOf(key) === at)
			.slice(-FORMER_NAMES_CAP);
		await ctx.db.patch(existing._id, {
			name: args.newName,
			normalizedName: newKey,
			formerNames,
		});

		if (oldName !== args.newName) {
			const more = await renameRelationsBatch(
				ctx,
				args.orgSlug,
				oldName,
				args.newName,
			);
			if (more) {
				await ctx.scheduler.runAfter(0, internal.agents.renameAgentRelations, {
					orgSlug: args.orgSlug,
					oldName,
					newName: args.newName,
				});
			}
		}
		return null;
	},
});

/**
 * getAgent — an agent of the caller's org, read BY ID. Gated by the org
 * administrator proof so that `args.orgSlug` is bound to the CALLER'S OWN org —
 * a caller of org B passing org A's slug is REFUSED (RBAC_DENIED), never
 * silently emptied. An ID naming ANOTHER organisation's agent is refused the
 * same way, so the row is never returned; an ID naming no row is an absence
 * (null).
 */
export const getAgent = query({
	args: { orgSlug: v.string(), agentId: v.id("agents") },
	returns: v.union(agentReturnValidator, v.null()),
	handler: async (ctx, args) => {
		// isolation-contract: NO reactive subscriber — enumerated 2026-10-03 with
		// `git -C <dashboard> grep -nE "api\.(agents|agentCredentials)\." origin/main -- app components hooks lib contexts providers` (dashboard origin/main 00a43cf, measured 2026-10-03) -> the dashboard calls it imperatively (components/agents/agents-admin.tsx:60, convex.query), no useQuery. Zero `useQuery` hits.
		// The refusal stays a RAISE: `requireOrgAdminById` throws RBAC_DENIED for the anonymous, the no-organisation and the wrong-organisation caller alike, and no render exists for a throw to crash.
		const door = "agents:getAgent";
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw anonymousRefusal(door);
		const principal = await requireOrgAdminById(ctx, identity, args.orgSlug, door);

		return await loadAgentOfPrincipalOrg(ctx, principal, args.agentId, door);
	},
});

/**
 * listAgentsByOrg — org-scoped listing. Gated via `requireOrgAdminById` so that
 * `args.orgSlug` is bound to the CALLER'S OWN org — never a free-form
 * cross-org read.
 */
export const listAgentsByOrg = query({
	args: { orgSlug: v.string() },
	returns: v.array(agentReturnValidator),
	handler: async (ctx, args) => {
		// isolation-contract: NO reactive subscriber — enumerated 2026-10-03 with
		// `git -C <dashboard> grep -nE "api\.(agents|agentCredentials)\." origin/main -- app components hooks lib contexts providers` (dashboard origin/main 00a43cf, measured 2026-10-03) -> the dashboard calls it imperatively (components/agents/agents-admin.tsx:60, convex.query), no useQuery. Zero `useQuery` hits.
		// The refusal stays a RAISE: `requireOrgAdminById` throws RBAC_DENIED for the anonymous, the no-organisation and the wrong-organisation caller alike, and no render exists for a throw to crash.
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw anonymousRefusal("agents:listAgentsByOrg");
		await requireOrgAdminById(ctx, identity, args.orgSlug, "agents:listAgentsByOrg");

		return await ctx.db
			.query("agents")
			.withIndex("by_org", (q) => q.eq("orgSlug", args.orgSlug))
			.collect();
	},
});

// Re-exported for callers that need the Id type without importing
// _generated/dataModel directly.
export type AgentId = Id<"agents">;
