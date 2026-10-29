import {
	assertOrgAdmin,
	isPersonActorName,
	resolveCallerFromClaims,
} from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { normalizeOrchestratorId } from "./_helpers/normalizeOrchestratorId";
import {
	anonymousRefusal,
	assertAgentNameFree,
	loadAgentOfPrincipalOrg,
	resolveSessionCaller,
	revokeActiveCredentialRows,
	type SessionCaller,
} from "./lib/agentIdentity";
import { ORG_ADMIN_ROLES, refusalError } from "./lib/auth";
import { lookupOrgMapping } from "./lib/authOrgMapping";
import { orgByIdLookups, orgByIdPrincipalLookups } from "./lib/orgIdLookups";

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
// Authorization: every door here proves the caller an ADMINISTRATOR of its OWN
// organisation through @vantageos/cloud-identity (`resolveSessionCaller`,
// convex/lib/agentIdentity.ts: `resolveCallerFromClaims` + `assertOrgAdmin`),
// built only from the verified session, never from an argument (see
// `.claude/rules/authority-attached-to-anonymous-object.md`). The organisation a
// door acts in is the one the session's `org_id` resolves to: no door takes an
// organisation, slug or label as an argument, so a caller can name neither its own
// org nor another's, and the only way to reach an agent of another organisation is
// by its ID, which is refused.
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
	description: v.optional(v.string()),
	address: v.optional(v.string()),
	outboundAuthRef: v.optional(v.string()),
	kind: v.optional(v.union(v.literal("agent"), v.literal("service"))),
	authSubject: v.optional(v.string()),
	ownerPersonId: v.optional(v.string()),
	personalAgentOf: v.optional(v.string()),
	isActive: v.boolean(),
	createdAt: v.number(),
});

// A label that is empty (after normalisation) labels nothing. This validates a
// DISPLAY LABEL; it does not, and cannot, name an identity.
export function assertAgentLabelValid(name: string): void {
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
	caller: SessionCaller,
	agentId: Id<"agents">,
	door: string,
): Promise<Doc<"agents">> {
	const agent = await loadAgentOfPrincipalOrg(ctx, caller.principal, agentId, door);
	if (!agent) {
		throw new ConvexError(
			`AGENT_NOT_FOUND: no agent ${agentId} in org "${caller.org.label}" — ${JSON.stringify({ orgSlug: caller.org.label, agentId })}`,
		);
	}
	return agent;
}

/**
 * registerAgent — CREATES an agent row in the CALLER'S OWN org and returns its
 * ID. That ID is the agent's identity from now on.
 *
 * Gated to the organisation ADMINISTRATOR through @vantageos/cloud-identity
 * (`resolveSessionCaller`): the caller's verified `org_id` must resolve to an
 * ACTIVE organisation and its role must be an admin role there. The agent is
 * stamped with THAT organisation's permanent id and current label. There is no
 * master carve-out — an org-admin identity is required every time.
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
		// deprecated, ignored: removed at the contract step after the dashboard stops sending it (task k17dcydcvcdzh1gp1zd1ebt23s8fyjde)
		orgSlug: v.optional(v.string()),
		name: v.string(),
		description: v.optional(v.string()),
		outboundAuthRef: v.optional(v.string()),
	},
	returns: v.id("agents"),
	handler: async (ctx, args) => {
		// write-contract: imperative dashboard caller, no subscriber — components/agents/register-agent-form.tsx:30 (useMutation(api.agents.registerAgent), invoked from an event handler, never a render subscription); operator script scripts/mint-station-agents.mjs:147 client.mutation(api.agents.registerAgent) (imperative); 0 call sites in mcp-server/src and mcp-server/server-http.ts. Measured 2026-10-03 with `grep -rn "agents:registerAgent\|agents\.registerAgent" mcp-server/src mcp-server/server-http.ts scripts` -> scripts/mint-station-agents.mjs:147 only and `git -C <dashboard> grep -nE "api\.(agents|agentCredentials)\." origin/main -- app components hooks lib contexts providers` (dashboard origin/main 00a43cf, measured 2026-10-03); also convex/__tests__. No subscribing pre-org client shell can reach it at render time; the no-org throw is a refusal at an imperative call, never at a render.
		// The stamp is the verified session's organisation (its permanent id and
		// current label, resolved by the package), never an argument.
		const door = "agents:registerAgent";
		const identity = await ctx.auth.getUserIdentity();
		const caller = await resolveCallerFromClaims(
			identity,
			{
				orgLookups: orgByIdLookups(ctx),
				principalLookups: orgByIdPrincipalLookups(ctx),
			},
			{ adminRoles: ORG_ADMIN_ROLES, door },
		);
		if (!caller.ok) {
			if (caller.subject === undefined) throw anonymousRefusal(door);
			throw refusalError(caller.refusal);
		}
		const admin = assertOrgAdmin(caller.principal, caller.org.id, {
			adminRoles: ORG_ADMIN_ROLES,
			door,
		});
		if (!admin.ok) throw refusalError(admin.refusal);

		// The organisation the verified session resolves to: the row is stamped with
		// its permanent id and current label (the stamp debate.ts also builds).
		const stamp = { orgSlug: caller.org.label, clerkOrgId: caller.org.id };

		assertAgentLabelValid(args.name);
		await assertAgentNameFree(ctx, caller.org, args.name);

		return await ctx.db.insert("agents", {
			...stamp,
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
 * registerAgentInOrgById — OPERATOR DOOR: create an active agent in the organisation
 * an operator names BY ITS PERMANENT ID.
 *
 * Why it exists: `registerAgent` is an org-admin session door and stamps the
 * caller's own organisation; an operator holding the deployment admin credential
 * has no such session. This door takes the organisation as an argument, which is
 * safe ONLY because it is internal: reachable with the deployment admin
 * credential or from another Convex function, never from a client.
 *
 * The slug is derived from `client_org_mapping` by the ID (`lookupOrgMapping`, the
 * `by_clerk_org_id` index), never typed. No mapping, or an inactive one, is REFUSED (ORG_NOT_FOUND /
 * ORG_INACTIVE); a name already held in that org is REFUSED by
 * `assertAgentNameFree` (AGENT_NAME_TAKEN / AGENT_INACTIVE). It writes ONE agents
 * row and touches no roster (`allowedAgentIds`, `allowedOrchestrators`) and no
 * credential.
 *
 *   npx convex run agents:registerAgentInOrgById '{"clerkOrgId":"org_...","name":"..."}'
 */
export const registerAgentInOrgById = internalMutation({
	args: { clerkOrgId: v.string(), name: v.string() },
	returns: v.id("agents"),
	handler: async (ctx, args) => {
		// The organisation by its permanent ID, through the one org-mapping read
		// (convex/lib/authOrgMapping.ts: `by_clerk_org_id`; two rows claiming one id
		// answer null, never a pick between them).
		const mapping = await lookupOrgMapping(ctx, { clerkOrgId: args.clerkOrgId });
		if (mapping === null) {
			throw new ConvexError(
				`ORG_NOT_FOUND: no organisation maps the id ${args.clerkOrgId}; nothing written.`,
			);
		}
		if (!mapping.isActive) {
			throw new ConvexError(
				`ORG_INACTIVE: the organisation ${args.clerkOrgId} ("${mapping.clerkOrgSlug}") is not active; nothing written.`,
			);
		}
		assertAgentLabelValid(args.name);
		await assertAgentNameFree(
			ctx,
			{ id: args.clerkOrgId, label: mapping.clerkOrgSlug },
			args.name,
		);
		return await ctx.db.insert("agents", {
			orgSlug: mapping.clerkOrgSlug,
			clerkOrgId: args.clerkOrgId,
			name: args.name,
			normalizedName: normalizeOrchestratorId(args.name),
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
		// deprecated, ignored: removed at the contract step after the dashboard stops sending it (task k17dcydcvcdzh1gp1zd1ebt23s8fyjde)
		orgSlug: v.optional(v.string()),
		agentId: v.id("agents"),
		address: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// write-contract: imperative dashboard caller, no subscriber — components/agents/agent-row.tsx:122 (useMutation(api.agents.setAgentAddress), invoked from an event handler, never a render subscription); 0 call sites in mcp-server/src, mcp-server/server-http.ts and scripts. Measured 2026-10-03 with `grep -rn "agents:setAgentAddress\|agents\.setAgentAddress" mcp-server/src mcp-server/server-http.ts scripts` -> 0 hits and `git -C <dashboard> grep -nE "api\.(agents|agentCredentials)\." origin/main -- app components hooks lib contexts providers` (dashboard origin/main 00a43cf, measured 2026-10-03); also convex/__tests__. No subscribing pre-org client shell can reach it at render time; the no-org throw is a refusal at an imperative call, never at a render.
		const door = "agents:setAgentAddress";
		const caller = await resolveSessionCaller(ctx, door);
		const admin = assertOrgAdmin(caller.principal, caller.org.id, {
			adminRoles: ORG_ADMIN_ROLES,
			door: door,
		});
		if (!admin.ok) throw refusalError(admin.refusal);
		const existing = await requireOwnAgent(ctx, caller, args.agentId, door);

		await ctx.db.patch(existing._id, { address: args.address });
		return null;
	},
});

/**
 * deactivateAgent — retires ONE agent of the caller's own org: patches
 * `isActive: false` AND revokes every active credential of that agent, in the
 * SAME mutation (one transaction). A retirement that depends on the operator
 * remembering a second call leaves a retired agent holding a key that still
 * resolves. Gated identically to `registerAgent`: `resolveSessionCaller`, no
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
	// deprecated, ignored: removed at the contract step after the dashboard stops sending it (task k17dcydcvcdzh1gp1zd1ebt23s8fyjde)
	args: { orgSlug: v.optional(v.string()), agentId: v.id("agents") },
	returns: v.object({ deactivated: v.boolean(), revoked: v.number() }),
	handler: async (ctx, args) => {
		// write-contract: imperative dashboard caller, no subscriber — components/agents/agent-row.tsx:123 (useMutation(api.agents.deactivateAgent), invoked from an event handler, never a render subscription); 0 call sites in mcp-server/src, mcp-server/server-http.ts and scripts. Measured 2026-10-03 with `grep -rn "agents:deactivateAgent\|agents\.deactivateAgent" mcp-server/src mcp-server/server-http.ts scripts` -> 0 hits and `git -C <dashboard> grep -nE "api\.(agents|agentCredentials)\." origin/main -- app components hooks lib contexts providers` (dashboard origin/main 00a43cf, measured 2026-10-03); also convex/__tests__. A signed-in caller with no organisation is refused RBAC_DENIED by resolveSessionCaller / assertOrgAdmin, an R-16 refusal thrown at an imperative call, never at a render.
		const door = "agents:deactivateAgent";
		const caller = await resolveSessionCaller(ctx, door);
		const admin = assertOrgAdmin(caller.principal, caller.org.id, {
			adminRoles: ORG_ADMIN_ROLES,
			door: door,
		});
		if (!admin.ok) throw refusalError(admin.refusal);
		const existing = await requireOwnAgent(ctx, caller, args.agentId, door);

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
 * `isActive: true`. Gated by `resolveSessionCaller`, no master carve-out. It is the
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
	// deprecated, ignored: removed at the contract step after the dashboard stops sending it (task k17dcydcvcdzh1gp1zd1ebt23s8fyjde)
	args: { orgSlug: v.optional(v.string()), agentId: v.id("agents") },
	returns: v.object({ reactivated: v.boolean(), revoked: v.number() }),
	handler: async (ctx, args) => {
		// write-contract: imperative dashboard caller, no subscriber — components/agents/agent-row.tsx:124 (useMutation(api.agents.reactivateAgent), invoked from an event handler, never a render subscription); 0 call sites in mcp-server/src, mcp-server/server-http.ts and scripts. Measured 2026-10-03 with `grep -rn "agents:reactivateAgent\|agents\.reactivateAgent" mcp-server/src mcp-server/server-http.ts scripts` -> 0 hits and `git -C <dashboard> grep -nE "api\.(agents|agentCredentials)\." origin/main -- app components hooks lib contexts providers` (dashboard origin/main 00a43cf, measured 2026-10-03); also convex/__tests__. This is the way BACK for a retired identity and also sweeps credentials, so it is a deliberately chosen admin act; resolveSessionCaller refuses it RBAC_DENIED at an imperative call, an R-16 refusal rather than an uncaught Server Error.
		const door = "agents:reactivateAgent";
		const caller = await resolveSessionCaller(ctx, door);
		const admin = assertOrgAdmin(caller.principal, caller.org.id, {
			adminRoles: ORG_ADMIN_ROLES,
			door: door,
		});
		if (!admin.ok) throw refusalError(admin.refusal);
		const existing = await requireOwnAgent(ctx, caller, args.agentId, door);

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
	orgId: string,
	oldName: string,
	newName: string,
): Promise<boolean> {
	const asParent = await ctx.db
		.query("agent_relations")
		.withIndex("by_parent_clerk_id", (q) =>
			q.eq("clerkOrgId", orgId).eq("parentName", oldName),
		)
		.take(RENAME_RELATIONS_BATCH_SIZE);
	for (const edge of asParent) {
		await ctx.db.patch(edge._id, { parentName: newName });
	}
	const asChild = await ctx.db
		.query("agent_relations")
		.withIndex("by_child_clerk_id", (q) =>
			q.eq("clerkOrgId", orgId).eq("childName", oldName),
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
 * Internal only: the caller was authorised (`resolveSessionCaller`) by the public
 * mutation that scheduled it, and `orgId` is the permanent org id that call
 * proved. The edge set is keyed by `(clerkOrgId, oldName)`, never by the slug, so
 * another org's edges (or those of an org that once held the slug) are never read.
 */
export const renameAgentRelations = internalMutation({
	args: { orgId: v.string(), oldName: v.string(), newName: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const more = await renameRelationsBatch(
			ctx,
			args.orgId,
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
	// deprecated, ignored: removed at the contract step after the dashboard stops sending it (task k17dcydcvcdzh1gp1zd1ebt23s8fyjde)
	args: { orgSlug: v.optional(v.string()), agentId: v.id("agents"), newName: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		// write-contract: imperative dashboard caller, no subscriber — components/agents/agent-row.tsx:121 (useMutation(api.agents.renameAgent), invoked from an event handler, never a render subscription); 0 call sites in mcp-server/src, mcp-server/server-http.ts and scripts. Measured 2026-10-03 with `grep -rn "agents:renameAgent\|agents\.renameAgent" mcp-server/src mcp-server/server-http.ts scripts` -> 0 hits and `git -C <dashboard> grep -nE "api\.(agents|agentCredentials)\." origin/main -- app components hooks lib contexts providers` (dashboard origin/main 00a43cf, measured 2026-10-03); also convex/__tests__. resolveSessionCaller refuses it RBAC_DENIED at an imperative call, never at a render.
		const door = "agents:renameAgent";
		const caller = await resolveSessionCaller(ctx, door);
		const admin = assertOrgAdmin(caller.principal, caller.org.id, {
			adminRoles: ORG_ADMIN_ROLES,
			door: door,
		});
		if (!admin.ok) throw refusalError(admin.refusal);
		assertAgentLabelValid(args.newName);

		const existing = await requireOwnAgent(ctx, caller, args.agentId, door);
		await assertAgentNameFree(ctx, caller.org, args.newName, existing._id);

		const oldName = existing.name;
		const newKey = normalizeOrchestratorId(args.newName);
		await ctx.db.patch(existing._id, {
			name: args.newName,
			normalizedName: newKey,
		});

		if (oldName !== args.newName) {
			const more = await renameRelationsBatch(
				ctx,
				caller.org.id,
				oldName,
				args.newName,
			);
			if (more) {
				await ctx.scheduler.runAfter(0, internal.agents.renameAgentRelations, {
					orgId: caller.org.id,
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
 * administrator proof, which binds the call to the CALLER'S OWN org (the
 * session's `org_id`). An ID naming ANOTHER organisation's agent is refused
 * RBAC_DENIED, so the row is never returned; an ID naming no row is an absence
 * (null).
 */
export const getAgent = query({
	// deprecated, ignored: removed at the contract step after the dashboard stops sending it (task k17dcydcvcdzh1gp1zd1ebt23s8fyjde)
	args: { orgSlug: v.optional(v.string()), agentId: v.id("agents") },
	returns: v.union(agentReturnValidator, v.null()),
	handler: async (ctx, args) => {
		// isolation-contract: NO reactive subscriber — enumerated 2026-10-03 with
		// `git -C <dashboard> grep -nE "api\.(agents|agentCredentials)\." origin/main -- app components hooks lib contexts providers` (dashboard origin/main 00a43cf, measured 2026-10-03) -> the dashboard calls it imperatively (components/agents/agents-admin.tsx:60, convex.query), no useQuery. Zero `useQuery` hits.
		// The refusal stays a RAISE: `resolveSessionCaller` throws RBAC_DENIED for the anonymous, the no-organisation and the wrong-organisation caller alike, and no render exists for a throw to crash.
		const door = "agents:getAgent";
		const caller = await resolveSessionCaller(ctx, door);
		const admin = assertOrgAdmin(caller.principal, caller.org.id, {
			adminRoles: ORG_ADMIN_ROLES,
			door: door,
		});
		if (!admin.ok) throw refusalError(admin.refusal);

		return await loadAgentOfPrincipalOrg(ctx, caller.principal, args.agentId, door);
	},
});

/**
 * listAgentsByOrg — the CALLER'S OWN org's agents. Gated via
 * `resolveSessionCaller`: the org listed is the one the session's `org_id`
 * resolves to, never a free-form cross-org read.
 */
export const listAgentsByOrg = query({
	// deprecated, ignored: removed at the contract step after the dashboard stops sending it (task k17dcydcvcdzh1gp1zd1ebt23s8fyjde)
	args: { orgSlug: v.optional(v.string()) },
	returns: v.array(agentReturnValidator),
	handler: async (ctx, args) => {
		// isolation-contract: NO reactive subscriber — enumerated 2026-10-03 with
		// `git -C <dashboard> grep -nE "api\.(agents|agentCredentials)\." origin/main -- app components hooks lib contexts providers` (dashboard origin/main 00a43cf, measured 2026-10-03) -> the dashboard calls it imperatively (components/agents/agents-admin.tsx:60, convex.query), no useQuery. Zero `useQuery` hits.
		// The refusal stays a RAISE: `resolveSessionCaller` throws RBAC_DENIED for the anonymous, the no-organisation and the wrong-organisation caller alike, and no render exists for a throw to crash.
		const caller = await resolveSessionCaller(ctx, "agents:listAgentsByOrg");
		const admin = assertOrgAdmin(caller.principal, caller.org.id, {
			adminRoles: ORG_ADMIN_ROLES,
			door: "agents:listAgentsByOrg",
		});
		if (!admin.ok) throw refusalError(admin.refusal);

		return await ctx.db
			.query("agents")
			.withIndex("by_org_clerk_id", (q) => q.eq("clerkOrgId", caller.org.id))
			.collect();
	},
});

// Re-exported for callers that need the Id type without importing
// _generated/dataModel directly.
export type AgentId = Id<"agents">;

// ─────────────────────────────────────────────────────────────────────────────
// Agent owner (EXPAND ONLY) — task k1778c2hvae8e8vz9f5bbbbbb98g62hw item 3.
// ─────────────────────────────────────────────────────────────────────────────
//
// `agents.ownerPersonId` is the Clerk user ID of the human who owns an agent, so a
// later delivery can hand it to `@vantageos/cloud-identity`
// `resolveCallerFromAgentCredential`. These two operator doors only STORE and LIST
// that ID (rule one-identity-layer: no local identity decision). Nothing refuses an
// agent without an owner and no request path reads the field yet.
//
// Refusal codes of setAgentOwner (all checked before any write):
//   AGENT_OWNER_BATCH_INVALID  agentIds empty or longer than 100
//   OWNER_PERSON_ID_INVALID    ownerPersonId is not `user_` + alphanumerics
//   OWNER_REASON_REQUIRED      reason shorter than 10 characters once trimmed
//   AGENT_NOT_FOUND            an id names no agent row
//   AGENT_INACTIVE             an id names an inactive agent
//   OWNER_CONFLICT             the agent has a different owner and replace is not true

const OWNER_BATCH_MAX = 100;
const OWNER_REASON_MIN_LENGTH = 10;
const OWNER_PERSON_ID_PATTERN = /^user_[A-Za-z0-9]+$/;
const OWNER_SCAN_CAP = 2000;

export const setAgentOwner = internalMutation({
	args: {
		agentIds: v.array(v.id("agents")),
		ownerPersonId: v.string(),
		reason: v.string(),
		replace: v.optional(v.boolean()),
	},
	returns: v.object({
		results: v.array(
			v.object({
				agentId: v.id("agents"),
				previous: v.union(v.string(), v.null()),
				current: v.string(),
				changed: v.boolean(),
			}),
		),
	}),
	handler: async (ctx, args) => {
		if (args.agentIds.length < 1 || args.agentIds.length > OWNER_BATCH_MAX) {
			throw new ConvexError(
				`AGENT_OWNER_BATCH_INVALID: agentIds must hold 1 to ${OWNER_BATCH_MAX} ids, got ${args.agentIds.length}`,
			);
		}
		if (!OWNER_PERSON_ID_PATTERN.test(args.ownerPersonId)) {
			throw new ConvexError(
				"OWNER_PERSON_ID_INVALID: ownerPersonId must be a Clerk user ID (user_ followed by letters and digits)",
			);
		}
		if (args.reason.trim().length < OWNER_REASON_MIN_LENGTH) {
			throw new ConvexError(
				`OWNER_REASON_REQUIRED: reason must be at least ${OWNER_REASON_MIN_LENGTH} characters once trimmed`,
			);
		}

		// Phase 1: judge every agent, write nothing.
		const plan: Array<{ agentId: Id<"agents">; previous: string | null; changed: boolean }> = [];
		const planned = new Map<string, string | null>();
		for (const agentId of args.agentIds) {
			const agent = await ctx.db.get(agentId);
			if (agent === null) {
				throw new ConvexError(`AGENT_NOT_FOUND: no agent ${agentId}`);
			}
			if (!agent.isActive) {
				throw new ConvexError(`AGENT_INACTIVE: agent ${agentId} is not active`);
			}
			// A repeated id sees the owner an earlier occurrence in this call would leave.
			const previous = planned.has(agentId)
				? (planned.get(agentId) ?? null)
				: (agent.ownerPersonId ?? null);
			if (
				previous !== null &&
				previous !== args.ownerPersonId &&
				args.replace !== true
			) {
				throw new ConvexError(
					`OWNER_CONFLICT: agent ${agentId} already belongs to another person; pass replace: true to move it`,
				);
			}
			plan.push({ agentId, previous, changed: previous !== args.ownerPersonId });
			planned.set(agentId, args.ownerPersonId);
		}

		// Phase 2: write.
		const written = new Set<string>();
		for (const step of plan) {
			if (step.changed && !written.has(step.agentId)) {
				await ctx.db.patch(step.agentId, { ownerPersonId: args.ownerPersonId });
				written.add(step.agentId);
			}
		}
		return {
			results: plan.map((s) => ({
				agentId: s.agentId,
				previous: s.previous,
				current: args.ownerPersonId,
				changed: s.changed,
			})),
		};
	},
});

/**
 * listAgentsWithoutOwner — the operator's worklist for the owner backfill: every
 * ACTIVE agent with no `ownerPersonId`. Labels (`orgSlug`, `name`, `kind`) are for the
 * operator's reading only and decide nothing. The scan is bounded; over the cap it
 * REFUSES rather than answering from a partial view.
 */
export const listAgentsWithoutOwner = internalQuery({
	args: {},
	returns: v.array(
		v.object({
			agentId: v.id("agents"),
			orgSlug: v.string(),
			clerkOrgId: v.union(v.string(), v.null()),
			name: v.string(),
			kind: v.union(v.literal("agent"), v.literal("service"), v.null()),
		}),
	),
	handler: async (ctx) => {
		const all = await ctx.db.query("agents").take(OWNER_SCAN_CAP + 1);
		if (all.length > OWNER_SCAN_CAP) {
			throw new ConvexError(
				`AGENT_SCAN_CAP_EXCEEDED: more than ${OWNER_SCAN_CAP} agents, refusing to list from a partial view`,
			);
		}
		return all
			.filter((a) => a.isActive && a.ownerPersonId === undefined)
			.map((a) => ({
				agentId: a._id,
				orgSlug: a.orgSlug,
				clerkOrgId: a.clerkOrgId ?? null,
				name: a.name,
				kind: a.kind ?? null,
			}));
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Personal agent — task k17ee3efn6xz4zpapcg68sgvnh8h43gt.
// ─────────────────────────────────────────────────────────────────────────────
//
// `agents.personalAgentOf` is the Clerk user ID of the person an agent is bound to. A
// person holds ONE AGENT PER AI CLIENT, so several agents of one org may designate the
// same person; a person token acts as the agent CHOSEN at consent and stamped on the
// token by ID (lib/personalAgent.ts), not as "the one agent that designates them". This
// door only STORES the designation. It is an internalMutation like `setAgentOwner`:
// reachable by the operator (`convex run`) and by no client, so it has no public gate to
// forget.
//
// Refusal codes (all checked before any write):
//   PERSONAL_AGENT_PERSON_ID_INVALID  personId is not `user_` + alphanumerics (null clears)
//   PERSONAL_AGENT_REASON_REQUIRED    reason shorter than 10 characters once trimmed
//   AGENT_NOT_FOUND                   the id names no agent row
//   AGENT_INACTIVE                    the agent is not active (to designate; clearing is allowed)
//   PERSONAL_AGENT_SERVICE_ACCOUNT    the row is the fleet service account (kind "service")
//   PERSONAL_AGENT_CONFLICT           the agent designates another person and replace is not true

const PERSONAL_AGENT_REASON_MIN_LENGTH = 10;
const PERSONAL_AGENT_PERSON_ID_PATTERN = /^user_[A-Za-z0-9]+$/;

export const setPersonalAgentOf = internalMutation({
	args: {
		agentId: v.id("agents"),
		// null clears the designation.
		personId: v.union(v.string(), v.null()),
		reason: v.string(),
		replace: v.optional(v.boolean()),
	},
	returns: v.object({
		agentId: v.id("agents"),
		previous: v.union(v.string(), v.null()),
		current: v.union(v.string(), v.null()),
		changed: v.boolean(),
	}),
	handler: async (ctx, args) => {
		if (
			args.personId !== null &&
			!PERSONAL_AGENT_PERSON_ID_PATTERN.test(args.personId)
		) {
			throw new ConvexError(
				"PERSONAL_AGENT_PERSON_ID_INVALID: personId must be a Clerk user ID (user_ followed by letters and digits), or null to clear",
			);
		}
		if (args.reason.trim().length < PERSONAL_AGENT_REASON_MIN_LENGTH) {
			throw new ConvexError(
				`PERSONAL_AGENT_REASON_REQUIRED: reason must be at least ${PERSONAL_AGENT_REASON_MIN_LENGTH} characters once trimmed`,
			);
		}
		const agent = await ctx.db.get(args.agentId);
		if (agent === null) {
			throw new ConvexError(`AGENT_NOT_FOUND: no agent ${args.agentId}`);
		}
		const previous = agent.personalAgentOf ?? null;
		if (args.personId !== null) {
			if (!agent.isActive) {
				throw new ConvexError(
					`AGENT_INACTIVE: agent ${args.agentId} is not active`,
				);
			}
			if (agent.kind === "service") {
				throw new ConvexError(
					`PERSONAL_AGENT_SERVICE_ACCOUNT: agent ${args.agentId} is the fleet service account and cannot be a person's agent`,
				);
			}
			if (
				previous !== null &&
				previous !== args.personId &&
				args.replace !== true
			) {
				throw new ConvexError(
					`PERSONAL_AGENT_CONFLICT: agent ${args.agentId} already belongs to another person; pass replace: true to move it`,
				);
			}
		}
		const changed = previous !== args.personId;
		if (changed) {
			await ctx.db.patch(args.agentId, { personalAgentOf: args.personId ?? undefined });
		}
		return { agentId: args.agentId, previous, current: args.personId, changed };
	},
});
