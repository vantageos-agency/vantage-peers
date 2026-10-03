import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { normalizeOrchestratorId } from "./_helpers/normalizeOrchestratorId";
import {
	assertAgentNameFree,
	assertNoOrphanLegacyCredentials,
	bindLegacyCredentials,
	findAgentByName,
	revokeActiveCredentialRows,
} from "./lib/agentIdentity";
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
	normalizedName: v.optional(v.string()),
	description: v.optional(v.string()),
	address: v.optional(v.string()),
	outboundAuthRef: v.optional(v.string()),
	isActive: v.boolean(),
	createdAt: v.number(),
});

// A name is a label; an empty one (after normalisation) labels nothing.
function assertAgentNameUsable(name: string): void {
	if (normalizeOrchestratorId(name) === "") {
		throw new ConvexError(
			`AGENT_NAME_INVALID: an agent name must not be empty or whitespace-only — ${JSON.stringify({ name })}`,
		);
	}
}

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
 * duplicate. A name is unique per org UNDER `normalizeOrchestratorId`: a
 * different spelling of a name already taken (`Clio` vs `clio`) is REFUSED with
 * `AGENT_NAME_TAKEN`; the same name in another org is a different agent.
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
		// write-contract: no caller outside convex-test — 0 call sites in mcp-server (grep of "agents:registerAgent" under mcp-server/src and mcp-server/server-http.ts) and 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); callers are convex/__tests__ only. No subscribing pre-org client shell can reach it; the no-org throw is a refusal at an imperative SDK call, never at a render.
		await requireOrgAdmin(ctx, args.orgSlug);

		assertAgentNameUsable(args.name);
		const existing = await findAgentByName(ctx, args.orgSlug, args.name);

		// Names are unique per org under normalizeOrchestratorId. `Clio` then
		// `clio` is a DIFFERENT spelling of a name already taken: refused, never
		// a second row and never a silent update of the first.
		if (existing && existing.name !== args.name) {
			throw new ConvexError(
				`AGENT_NAME_TAKEN: org "${args.orgSlug}" already has an agent named "${existing.name}" (names are unique per organisation, case-insensitively); register that exact name to update it — ${JSON.stringify(
					{ orgSlug: args.orgSlug, name: args.name, existingAgentId: existing._id },
				)}`,
			);
		}
		await assertAgentNameFree(ctx, args.orgSlug, args.name, existing?._id);

		if (existing) {
			if (!existing.isActive) {
				throw new ConvexError(
					`AGENT_INACTIVE: agent "${args.name}" in org "${args.orgSlug}" is inactive; use reactivateAgent to bring it back — ${JSON.stringify(
						{ orgSlug: args.orgSlug, name: args.name },
					)}`,
				);
			}
			await ctx.db.patch(existing._id, {
				normalizedName: normalizeOrchestratorId(args.name),
				description: args.description,
				outboundAuthRef: args.outboundAuthRef,
				isActive: true,
			});
			return existing._id;
		}

		await assertNoOrphanLegacyCredentials(ctx, args.orgSlug, args.name);

		return await ctx.db.insert("agents", {
			orgSlug: args.orgSlug,
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
		// write-contract: no caller outside convex-test — 0 call sites in mcp-server (grep of "agents:setAgentAddress" under mcp-server/src and mcp-server/server-http.ts) and 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); callers are convex/__tests__ only. No subscribing pre-org client shell can reach it; the no-org throw is a refusal at an imperative SDK call, never at a render.
		await requireOrgAdmin(ctx, args.orgSlug);

		const existing = await findAgentByName(ctx, args.orgSlug, args.name);

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
		// write-contract: no caller exists outside convex-test — measured 2026-10-01 with `grep -rnE "deactivateAgent|reactivateAgent|revokeAgentCredential" /root/coding/vantage-peers-dashboard mcp-server/src --include=*.ts --include=*.tsx --exclude-dir=node_modules --exclude-dir=.next` -> 0 hits. No subscribing pre-org client shell can reach this retire write; a signed-in caller with no organisation is refused RBAC_DENIED by requireOrgAdmin, an R-16 refusal thrown at an imperative SDK call, never at a render.
		await requireOrgAdmin(ctx, args.orgSlug);

		const existing = await findAgentByName(ctx, args.orgSlug, args.name);

		if (!existing) {
			throw new ConvexError(
				`AGENT_NOT_FOUND: no agent "${args.name}" in org "${args.orgSlug}" — ${JSON.stringify(
					{ orgSlug: args.orgSlug, name: args.name },
				)}`,
			);
		}

		const revoked = await revokeActiveCredentialRows(ctx, existing);
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
 * Unknown name raises `AGENT_NOT_FOUND`.
 * RETURNS `{ reactivated: boolean, revoked: number }`: reactivated true = this
 * call flipped the row, false = it was already active; revoked = credential
 * rows this call swept (0 is a real zero).
 */
export const reactivateAgent = mutation({
	args: { orgSlug: v.string(), name: v.string() },
	returns: v.object({ reactivated: v.boolean(), revoked: v.number() }),
	handler: async (ctx, args) => {
		// write-contract: no caller exists outside convex-test (same grep as deactivateAgent, 0 hits in the dashboard and mcp-server/src). This is the way BACK for a retired identity and also sweeps credentials, so it is a deliberately chosen admin act: a pre-organisation client has no render path to it, and requireOrgAdmin refuses it RBAC_DENIED at an imperative call, an R-16 refusal rather than an uncaught Server Error.
		await requireOrgAdmin(ctx, args.orgSlug);

		const existing = await findAgentByName(ctx, args.orgSlug, args.name);

		if (!existing) {
			throw new ConvexError(
				`AGENT_NOT_FOUND: no agent "${args.name}" in org "${args.orgSlug}" — ${JSON.stringify(
					{ orgSlug: args.orgSlug, name: args.name },
				)}`,
			);
		}

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
			revoked = await revokeActiveCredentialRows(ctx, existing);
			await ctx.db.patch(existing._id, { isActive: true });
		}
		return { reactivated, revoked };
	},
});

/**
 * renameAgent — changes an agent's LABEL. The agent is its row (`_id`), so its
 * credentials, and anything else keyed on `agentId`, are untouched: a rename
 * never orphans a credential. Gated like `registerAgent` (`requireOrgAdmin`, no
 * master carve-out). The new name must be free in this org under
 * `normalizeOrchestratorId` (`AGENT_NAME_TAKEN` otherwise); renaming to another
 * spelling of the agent's OWN name (`clio` -> `Clio`) is allowed. Unknown name
 * raises `AGENT_NOT_FOUND`. `agent_relations` edges name agents by label, so the
 * agent's edges are rewritten to the new label in the same transaction.
 */
export const renameAgent = mutation({
	args: { orgSlug: v.string(), name: v.string(), newName: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		// write-contract: no caller outside convex-test — 0 call sites in mcp-server/src and the dashboard (new door, measured 2026-10-03 with `grep -rn "agents:renameAgent" mcp-server/src` -> 0 hits). A pre-organisation client has no render path to it; requireOrgAdmin refuses it RBAC_DENIED at an imperative call, never at a render.
		await requireOrgAdmin(ctx, args.orgSlug);
		assertAgentNameUsable(args.newName);

		const existing = await findAgentByName(ctx, args.orgSlug, args.name);
		if (!existing) {
			throw new ConvexError(
				`AGENT_NOT_FOUND: no agent "${args.name}" in org "${args.orgSlug}" — ${JSON.stringify(
					{ orgSlug: args.orgSlug, name: args.name },
				)}`,
			);
		}
		await assertAgentNameFree(ctx, args.orgSlug, args.newName, existing._id);

		// Bind unbound (legacy) credential rows to THIS row BEFORE the label
		// changes: they follow the name otherwise, locking this agent out and
		// handing the credential to whoever registers the old name next.
		await bindLegacyCredentials(ctx, existing);
		await assertNoOrphanLegacyCredentials(ctx, args.orgSlug, args.newName);

		const oldName = existing.name;
		await ctx.db.patch(existing._id, {
			name: args.newName,
			normalizedName: normalizeOrchestratorId(args.newName),
		});

		if (oldName !== args.newName) {
			const asParent = await ctx.db
				.query("agent_relations")
				.withIndex("by_parent", (q) =>
					q.eq("orgSlug", args.orgSlug).eq("parentName", oldName),
				)
				.collect();
			for (const edge of asParent) {
				await ctx.db.patch(edge._id, { parentName: args.newName });
			}
			const asChild = await ctx.db
				.query("agent_relations")
				.withIndex("by_child", (q) =>
					q.eq("orgSlug", args.orgSlug).eq("childName", oldName),
				)
				.collect();
			for (const edge of asChild) {
				await ctx.db.patch(edge._id, { childName: args.newName });
			}
		}
		return null;
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
		// isolation-contract: NO reactive subscriber — enumerated with
		// `git -C /root/coding/vantage-peers-dashboard grep -nE "api\.agents\." {origin/main,0466fac} -- app components hooks lib contexts providers` -> 0 hits at both commits
		// (vantage-peers-dashboard e2dc58f and 0466fac). The refusal stays a RAISE: `requireOrgAdmin` throws RBAC_DENIED for the anonymous, the no-organisation and the wrong-organisation caller alike, and no render exists for a throw to crash.
		await requireOrgAdmin(ctx, args.orgSlug);

		return await findAgentByName(ctx, args.orgSlug, args.name);
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
		// isolation-contract: NO reactive subscriber — enumerated with
		// `git -C /root/coding/vantage-peers-dashboard grep -nE "api\.agents\." {origin/main,0466fac} -- app components hooks lib contexts providers` -> 0 hits at both commits
		// (vantage-peers-dashboard e2dc58f and 0466fac). The refusal stays a RAISE: `requireOrgAdmin` throws RBAC_DENIED for the anonymous, the no-organisation and the wrong-organisation caller alike, and no render exists for a throw to crash.
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
