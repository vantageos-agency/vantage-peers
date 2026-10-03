import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";

// ─────────────────────────────────────────────────────────────────────────────
// [P-T5] agentIdentity — the shared CORE resolution used by BOTH
// convex/agentCredentials.ts's public `resolveAgentCredential` query AND
// convex/lib/auth.ts's `requireAgentCredentialMatch` write-surface gate.
//
// Extracted to its OWN module (rather than importing agentCredentials.ts
// from auth.ts, or vice versa) to avoid a circular import: agentCredentials.ts
// already imports `requireOrgAdmin` from auth.ts, so auth.ts importing back
// from agentCredentials.ts would create a cycle. This file has NO dependency
// on auth.ts or agentCredentials.ts — only on the generated ctx types — so
// both can import it safely.
//
// Governing cap analysis/le-cap/le-cap.md @ e3c1ffd6 §6 VP.4 (second half):
// the ACTING AGENT is derived from the presented per-agent credential, never
// from a caller-declared name. This is the ONE hashing+lookup implementation
// — never duplicated.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The identity a presented credential resolves to: the agents ROW. `agent._id`
 * is the identity; `agent.name` is its CURRENT label (it follows a rename).
 */
export interface ResolvedAgentIdentity {
	agent: Doc<"agents">;
}

/**
 * findAgentByName — the ONE name -> agents-row lookup. Name is a label, so the
 * match is under `normalizeOrchestratorId` (the uniqueness key). Reads the
 * `normalizedName` index first; falls back to the raw `by_org_name` index so a
 * legacy row not yet backfilled is still found by its exact label. Returns the
 * row whatever its `isActive` (callers decide what an inactive agent means).
 */
export async function findAgentByName(
	ctx: QueryCtx | MutationCtx,
	orgSlug: string,
	name: string,
): Promise<Doc<"agents"> | null> {
	const normalized = normalizeOrchestratorId(name);
	const byNormalized = await ctx.db
		.query("agents")
		.withIndex("by_org_normalized_name", (q) =>
			q.eq("orgSlug", orgSlug).eq("normalizedName", normalized),
		)
		.first();
	// The index is a shortcut, `name` is the truth: a stale `normalizedName` (a
	// row whose label was patched without it) must not name the wrong agent.
	if (byNormalized && normalizeOrchestratorId(byNormalized.name) === normalized) {
		return byNormalized;
	}
	return await ctx.db
		.query("agents")
		.withIndex("by_org_name", (q) => q.eq("orgSlug", orgSlug).eq("name", name))
		.first();
}

/**
 * assertAgentNameFree — refuses (AGENT_NAME_TAKEN) when ANOTHER agent row of the
 * SAME org already carries this name under `normalizeOrchestratorId`. Scoped to
 * `orgSlug` and nothing else: the same name in two orgs is legitimate. Scans the
 * org's roster (small, bounded by org) rather than trusting the index alone, so
 * a legacy row with no (or a stale) `normalizedName` still blocks a case variant.
 * `exceptId` is the row being written (an idempotent re-register or a rename).
 */
export async function assertAgentNameFree(
	ctx: QueryCtx | MutationCtx,
	orgSlug: string,
	name: string,
	exceptId?: Doc<"agents">["_id"],
): Promise<void> {
	const normalized = normalizeOrchestratorId(name);
	const roster = await ctx.db
		.query("agents")
		.withIndex("by_org", (q) => q.eq("orgSlug", orgSlug))
		.collect();
	const clash = roster.find(
		(row) =>
			row._id !== exceptId &&
			normalizeOrchestratorId(row.name) === normalized,
	);
	if (clash) {
		throw new ConvexError(
			`AGENT_NAME_TAKEN: org "${orgSlug}" already has an agent named "${clash.name}" (names are unique per organisation, case-insensitively); the agent's identity is its id, not its name — ${JSON.stringify(
				{ orgSlug, name, existingAgentId: clash._id },
			)}`,
		);
	}
}

/**
 * sha256Hex — SAME sha256-hex pattern used across this codebase for token
 * hashing (convex/credentials.ts, convex/oauth.ts, convex/agentCredentials.ts
 * each carry their own local copy per this repo's documented "local, mirrors
 * credentials.ts" convention — this is that same copy, shared instead of
 * re-duplicated a fourth time since both call sites now live outside
 * agentCredentials.ts itself).
 */
export async function sha256Hex(input: string): Promise<string> {
	const encoded = new TextEncoder().encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * resolveAgentCredentialCore — resolves a PRESENTED secret to the agents ROW the
 * credential was minted for, or null if the secret does not match any ACTIVE
 * `agent_credentials` row.
 *
 * The row is reached by `agentId`, never by name: renaming the agent keeps its
 * credential working. A legacy row with no `agentId` (minted before the field
 * existed, not yet backfilled) falls back to its (orgSlug, agentName) label.
 *
 * Trusts NO caller-declared name: the only input is the presented secret
 * itself. A rotated-out (isActive: false) row's old plaintext no longer
 * resolves.
 *
 * Read-only (`ctx.db.query`) — safe to call from either a QueryCtx or a
 * MutationCtx, which is what lets write surfaces (mutations) call it
 * directly without an extra `ctx.runQuery` hop.
 */
export async function resolveAgentCredentialCore(
	ctx: QueryCtx | MutationCtx,
	presentedSecret: string,
): Promise<ResolvedAgentIdentity | null> {
	const presentedHash = await sha256Hex(presentedSecret);

	const row = await ctx.db
		.query("agent_credentials")
		.withIndex("by_secret_hash", (q) => q.eq("secretHash", presentedHash))
		.unique();

	if (!row || !row.isActive) {
		return null;
	}

	const agent = row.agentId
		? await ctx.db.get(row.agentId)
		: await findAgentByName(ctx, row.orgSlug, row.agentName);

	// The credential is only as live as the AGENT it was minted for. An agent
	// deactivated (`agents.isActive === false`) or removed after minting must not
	// keep authenticating through a credential row that is itself still active:
	// nothing rotates that row when the agent is switched off. A missing `agents`
	// row is the same refusal — a credential never outlives its entity. The org
	// check is defence in depth: a row whose agent sits in another org is refused.
	if (!agent || !agent.isActive || agent.orgSlug !== row.orgSlug) {
		return null;
	}

	return { agent };
}

/**
 * legacyCredentialRowsByLabel — credential rows with NO `agentId` (minted before
 * the field existed) whose label names `name` under `normalizeOrchestratorId`,
 * the same comparison `findAgentByName` uses to resolve them. Scans the org's
 * credential rows (bounded per org).
 */
async function legacyCredentialRowsByLabel(
	ctx: QueryCtx | MutationCtx,
	orgSlug: string,
	name: string,
): Promise<Doc<"agent_credentials">[]> {
	const normalized = normalizeOrchestratorId(name);
	const rows = await ctx.db
		.query("agent_credentials")
		.withIndex("by_org_agent", (q) => q.eq("orgSlug", orgSlug))
		.collect();
	return rows.filter(
		(row) =>
			row.agentId === undefined &&
			normalizeOrchestratorId(row.agentName) === normalized,
	);
}

/**
 * credentialRowsOfAgent — every credential row of ONE agent: by `agentId`, plus
 * legacy rows (no `agentId` yet) matched on the agent's label.
 */
export async function credentialRowsOfAgent(
	ctx: QueryCtx | MutationCtx,
	agent: Doc<"agents">,
): Promise<Doc<"agent_credentials">[]> {
	const byId = await ctx.db
		.query("agent_credentials")
		.withIndex("by_agent", (q) => q.eq("agentId", agent._id))
		.collect();
	const legacy = await legacyCredentialRowsByLabel(ctx, agent.orgSlug, agent.name);
	return [...byId, ...legacy];
}

/**
 * bindLegacyCredentials — sets `agentId` on every legacy credential row that
 * names this agent by label. MUST run in the same transaction and BEFORE any
 * write that changes the label: an unbound row follows the NAME, so a rename
 * would lock the agent out and a later registration of the old name would take
 * the credential over. Returns the number of rows bound.
 */
export async function bindLegacyCredentials(
	ctx: MutationCtx,
	agent: Doc<"agents">,
): Promise<number> {
	const legacy = await legacyCredentialRowsByLabel(ctx, agent.orgSlug, agent.name);
	for (const row of legacy) {
		await ctx.db.patch(row._id, { agentId: agent._id });
	}
	return legacy.length;
}

/**
 * assertNoOrphanLegacyCredentials — refuses (AGENT_LEGACY_CREDENTIAL_ORPHANED)
 * giving a label to an agent row while unbound legacy credential rows still
 * carry that label. Called only once the name is known to be free, so any such
 * row belongs to no live agent; letting the new row take the label would hand
 * it a credential minted for someone else. The operator revokes or deletes the
 * orphan rows first.
 */
export async function assertNoOrphanLegacyCredentials(
	ctx: QueryCtx | MutationCtx,
	orgSlug: string,
	name: string,
): Promise<void> {
	const orphans = await legacyCredentialRowsByLabel(ctx, orgSlug, name);
	if (orphans.length > 0) {
		throw new ConvexError(
			`AGENT_LEGACY_CREDENTIAL_ORPHANED: ${orphans.length} credential row(s) in org "${orgSlug}" still carry the label "${name}" with no agent id and no live agent holds it; registering it would hand them to a different agent — ${JSON.stringify(
				{ orgSlug, name, credentialIds: orphans.map((r) => r._id) },
			)}`,
		);
	}
}

/**
 * revokeActiveCredentialRows — the ONE implementation of "retire every active
 * credential row of ONE agent". Rows are patched to `isActive: false`, never
 * deleted (audit trail, as in mintAgentCredential's rotation). Keyed on the
 * agent ROW, so it still finds the credentials after a rename. Returns the
 * number of rows THIS call flipped.
 *
 * Lives here, not in agentCredentials.ts, because both agentCredentials.ts
 * (`revokeAgentCredential`) and agents.ts (`deactivateAgent`) need it, and
 * this module depends only on the generated ctx types: no import cycle with
 * auth.ts and no agents.ts -> agentCredentials.ts edge. Authorization is the
 * CALLER's job; this helper trusts that `requireOrgAdmin` already ran.
 */
export async function revokeActiveCredentialRows(
	ctx: MutationCtx,
	agent: Doc<"agents">,
): Promise<number> {
	const rows = await credentialRowsOfAgent(ctx, agent);
	let revoked = 0;
	for (const row of rows) {
		if (row.isActive) {
			await ctx.db.patch(row._id, { isActive: false });
			revoked += 1;
		}
	}
	return revoked;
}
