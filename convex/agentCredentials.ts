import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOrgAdmin } from "./lib/auth";
import { resolveAgentCredentialCore, sha256Hex } from "./lib/agentIdentity";

// ─────────────────────────────────────────────────────────────────────────────
// [P-T4] agentCredentials — the per-agent CREDENTIAL, on top of P-T2's
// `agents` entity table.
// ─────────────────────────────────────────────────────────────────────────────
//
// Governing cap analysis/le-cap/le-cap.md @ e3c1ffd6 §6 VP.4 (first half):
// today the token identifies the ORGANISATION and the agent writes its own
// name into the call, so agents of one client share a token and nothing
// compares the declared name to the token presented — a right written "this
// specialist only" is a label, not a lock. Each agent being its own
// deployment, it can carry its own key. This file issues that key; P-T5 turns
// it into the lock (the resolution below is the piece the lock consumes).
//
// Hashing reuse: `sha256Hex` below is the SAME sha256-hex pattern already
// used for tokens in this codebase (convex/credentials.ts's exported
// `sha256Hex`, convex/oauth.ts's local mirror of the same helper — that file's
// own comment records the "local, mirrors credentials.ts — avoids cross-file
// import" convention this file follows too, rather than inventing a new
// scheme).
//
// Authorization split (two DIFFERENT identities, deliberately):
//   - MINT is gated by `requireOrgAdmin` — the SAME org-admin gate
//     `agents.ts`'s `registerAgent` and `agentRelations.ts`'s `linkChild` use.
//     Only an org:admin of the agent's OWN org may mint/rotate its credential.
//   - RESOLUTION trusts NO caller-declared name. `resolveAgentCredential`
//     takes only the presented secret; the (orgSlug, agentName) identity it
//     returns comes SOLELY from which row's `secretHash` matches — never from
//     an argument the caller could set. This is the property P-T5's lock
//     depends on: the credential HOLDER is authenticated by presenting the
//     secret, not by declaring who it is.

const mintResultValidator = v.object({
	secret: v.string(),
	mintedAt: v.number(),
});

const resolvedIdentityValidator = v.object({
	orgSlug: v.string(),
	agentName: v.string(),
});

/**
 * mintAgentCredential — mints a fresh, high-entropy secret for ONE agent in
 * the CALLER'S OWN org, stores only its sha256 hash, and returns the
 * plaintext EXACTLY ONCE (in this mutation's result — never re-derivable
 * from the DB afterward).
 *
 * Gated to the organisation ADMINISTRATOR via `requireOrgAdmin`, identical to
 * `agents.ts`'s `registerAgent`. Refuses to mint for an agent name that has
 * no `agents` row in this org (AGENT_NOT_FOUND) — a credential is issued to
 * an agent that already EXISTS as an entity, never to an arbitrary string.
 *
 * ROTATION: every prior row for (orgSlug, agentName) is marked
 * `isActive: false` (never deleted — audit trail preserved) before the new
 * active row is inserted. Only the LATEST mint's plaintext resolves
 * afterward; the previous plaintext stops authenticating immediately.
 */
export const mintAgentCredential = mutation({
	args: {
		orgSlug: v.string(),
		agentName: v.string(),
	},
	returns: mintResultValidator,
	handler: async (ctx, args) => {
		await requireOrgAdmin(ctx, args.orgSlug);

		const agent = await ctx.db
			.query("agents")
			.withIndex("by_org_name", (q) =>
				q.eq("orgSlug", args.orgSlug).eq("name", args.agentName),
			)
			.unique();

		if (!agent) {
			throw new ConvexError(
				`AGENT_NOT_FOUND: no agent "${args.agentName}" in org "${args.orgSlug}" — ${JSON.stringify(
					{ orgSlug: args.orgSlug, agentName: args.agentName },
				)}`,
			);
		}

		// Rotation: invalidate every PRIOR row for this agent before minting the
		// new one. Rows are patched, never deleted — the audit trail of past
		// mints is preserved.
		const priorRows = await ctx.db
			.query("agent_credentials")
			.withIndex("by_org_agent", (q) =>
				q.eq("orgSlug", args.orgSlug).eq("agentName", args.agentName),
			)
			.collect();
		for (const row of priorRows) {
			if (row.isActive) {
				await ctx.db.patch(row._id, { isActive: false });
			}
		}

		// 32 random bytes → 64-char hex — same shape as oauth.ts's client
		// secrets and credentials.ts's Bearer tokens.
		const secretBytes = new Uint8Array(32);
		crypto.getRandomValues(secretBytes);
		const rawSecret = Array.from(secretBytes)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");

		const secretHash = await sha256Hex(rawSecret);
		const mintedAt = Date.now();

		await ctx.db.insert("agent_credentials", {
			orgSlug: args.orgSlug,
			agentName: args.agentName,
			secretHash,
			isActive: true,
			createdAt: mintedAt,
		});

		// Plaintext returned EXACTLY ONCE — never written to the DB, never
		// re-derivable afterward.
		return { secret: rawSecret, mintedAt };
	},
});

/**
 * resolveAgentCredential — resolves a PRESENTED secret to its (orgSlug,
 * agentName), or null if the secret does not match any ACTIVE credential
 * row.
 *
 * Trusts NO caller-declared name: the only argument is the presented secret
 * itself; the identity returned comes solely from which row's `secretHash`
 * (an index lookup on the same hash `mintAgentCredential` stored) matches.
 * A rotated-out (isActive: false) row's old plaintext no longer resolves,
 * even though the row itself still exists for audit purposes.
 *
 * No `requireOrgAdmin` gate here, deliberately — the credential itself IS
 * the proof of identity being verified; requiring a separate org-admin
 * identity on the same call would defeat the point of an agent
 * authenticating as itself.
 */
export const resolveAgentCredential = query({
	args: { presentedSecret: v.string() },
	returns: v.union(resolvedIdentityValidator, v.null()),
	handler: async (ctx, args) => {
		return await resolveAgentCredentialCore(ctx, args.presentedSecret);
	},
});
