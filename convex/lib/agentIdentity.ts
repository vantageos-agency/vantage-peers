import type { QueryCtx, MutationCtx } from "../_generated/server";

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

export interface ResolvedAgentIdentity {
	orgSlug: string;
	agentName: string;
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
 * resolveAgentCredentialCore — resolves a PRESENTED secret to its
 * (orgSlug, agentName), or null if the secret does not match any ACTIVE
 * `agent_credentials` row.
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

	// The credential is only as live as the AGENT it was minted for. An agent
	// deactivated (`agents.isActive === false`) or removed after minting must not
	// keep authenticating through a credential row that is itself still active:
	// nothing rotates that row when the agent is switched off. A missing `agents`
	// row is the same refusal — a credential never outlives its entity.
	const agent = await ctx.db
		.query("agents")
		.withIndex("by_org_name", (q) =>
			q.eq("orgSlug", row.orgSlug).eq("name", row.agentName),
		)
		.unique();
	if (!agent || !agent.isActive) {
		return null;
	}

	return { orgSlug: row.orgSlug, agentName: row.agentName };
}

/**
 * revokeActiveCredentialRows — the ONE implementation of "retire every active
 * credential row of (orgSlug, agentName)". Rows are patched to
 * `isActive: false`, never deleted (audit trail, as in mintAgentCredential's
 * rotation). Returns the number of rows THIS call flipped.
 *
 * Lives here, not in agentCredentials.ts, because both agentCredentials.ts
 * (`revokeAgentCredential`) and agents.ts (`deactivateAgent`) need it, and
 * this module depends only on the generated ctx types: no import cycle with
 * auth.ts and no agents.ts -> agentCredentials.ts edge. Authorization is the
 * CALLER's job; this helper trusts that `requireOrgAdmin` already ran.
 */
export async function revokeActiveCredentialRows(
	ctx: MutationCtx,
	orgSlug: string,
	agentName: string,
): Promise<number> {
	const rows = await ctx.db
		.query("agent_credentials")
		.withIndex("by_org_agent", (q) =>
			q.eq("orgSlug", orgSlug).eq("agentName", agentName),
		)
		.collect();
	let revoked = 0;
	for (const row of rows) {
		if (row.isActive) {
			await ctx.db.patch(row._id, { isActive: false });
			revoked += 1;
		}
	}
	return revoked;
}
