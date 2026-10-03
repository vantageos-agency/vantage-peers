import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
	refuseUnresolvedCredential,
	requireOrgAdmin,
	requireResolvedCaller,
	withOrgScope,
} from "./lib/auth";
import {
	credentialRowsOfAgent,
	findAgentByName,
	revokeActiveCredentialRows,
	resolveAgentCredentialCore,
	sha256Hex,
} from "./lib/agentIdentity";

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
 * ROTATION: every prior row of the agent (by `agentId`) is marked
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
		// write-contract: operator script only — scripts/mint-station-agents.mjs:153 calls client.mutation(api.agentCredentials.mintAgentCredential) (imperative); 0 call sites in mcp-server/src and mcp-server/server-http.ts and 0 dashboard hits for api.agentCredentials.mintAgentCredential (measured 2026-10-03 with `grep -rn "mintAgentCredential" scripts mcp-server/src mcp-server/server-http.ts` and `git -C <dashboard> grep -n "mintAgentCredential" origin/main -- app components hooks lib contexts providers`, dashboard origin/main 00a43cf); also convex/__tests__. No subscribing pre-org client shell can reach it; the no-org throw is a refusal at an imperative SDK call, never at a render. Operator-run via `convex run` per docs/cloud/protocol/deployment-runbook.md:24 (imperative).
		await requireOrgAdmin(ctx, args.orgSlug);

		const agent = await findAgentByName(ctx, args.orgSlug, args.agentName);

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
		const priorRows = await credentialRowsOfAgent(ctx, agent);
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
			orgSlug: agent.orgSlug,
			agentId: agent._id,
			agentName: agent.name,
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
 * revokeAgentCredential — retires EVERY active credential row of ONE agent in
 * the caller's own org (`isActive: false`; rows are patched, never deleted,
 * same audit-trail rule as rotation in `mintAgentCredential`). Gated by
 * `requireOrgAdmin`, no master carve-out.
 *
 * RETURNS `{ revoked: number }`, the count of rows this call flipped. Load
 * bearing, not style: `.claude/rules/refusal-is-distinguishable-from-absence.md`
 * requires "revoked 1" and "there was nothing to revoke" to be different
 * bytes; a bare success collapses them.
 *
 * FOUR OUTCOMES. The reviewer named three: refused (`RBAC_DENIED`),
 * `{ revoked: N >= 1 }`, and `{ revoked: 0 }` (idempotent, not an error).
 * The fourth is this file's own, beyond the reviewer's three:
 * NONEXISTENT AGENT -> `AGENT_NOT_FOUND`, not `{ revoked: 0 }`. Agents are
 * never deleted, so a missing `agents` row can only mean a mistyped name, and
 * answering it with a zero would let the operator believe a credential was
 * retired when nothing was addressed. `{ revoked: 0 }` is reserved for an
 * EXISTING agent with no active credential (a true absence).
 *
 * The loop is shared with `deactivateAgent` via `revokeActiveCredentialRows`
 * (convex/lib/agentIdentity.ts).
 */
export const revokeAgentCredential = mutation({
	args: { orgSlug: v.string(), agentName: v.string() },
	returns: v.object({ revoked: v.number() }),
	handler: async (ctx, args) => {
		// write-contract: no mcp-server/src/tools.ts wiring and no dashboard reference exists for "agentCredentials:revokeAgentCredential" (same grep, 0 hits). Its only callers are convex-test direct mutations; a pre-organisation client has no render path to a credential revoke, and requireOrgAdmin refuses it RBAC_DENIED at an imperative call, an R-16 refusal, never an uncaught Server Error.
		await requireOrgAdmin(ctx, args.orgSlug);

		const agent = await findAgentByName(ctx, args.orgSlug, args.agentName);
		if (!agent) {
			throw new ConvexError(
				`AGENT_NOT_FOUND: no agent "${args.agentName}" in org "${args.orgSlug}" — ${JSON.stringify(
					{ orgSlug: args.orgSlug, agentName: args.agentName },
				)}`,
			);
		}

		const revoked = await revokeActiveCredentialRows(ctx, agent);
		return { revoked };
	},
});

/**
 * resolveAgentCredential — resolves a PRESENTED secret to its agent's (orgSlug,
 * current agentName) — read off the agents ROW the credential belongs to, so it
 * follows a rename — or REFUSES it with a code. It never answers "no match" with
 * `null`.
 *
 * THE SHAPE, AND WHY. This read used to return `null` for a wrong secret — the
 * same bytes as "there is no such credential". That is an absence-shaped
 * answer to a refusal (.claude/rules/refusal-is-distinguishable-from-absence.md):
 * any guard reading it could not tell "this secret is wrong" from "nothing
 * there". It now RAISES `RBAC_DENIED` (via `refuseUnresolvedCredential`, the
 * same code `requireResolvedCaller` carries), naming this door in `errorData`.
 *
 * RAISE, not a typed envelope, because no mounted render subscribes to it —
 * measured: `grep -rnE "agentCredentials|resolveAgentCredential"
 * /root/coding/vantage-peers-dashboard --include=*.ts --include=*.tsx
 * --exclude-dir=node_modules --exclude-dir=.next` -> 0 hits; the only
 * consumer is mcp-server/src/auth.ts `resolveActorFromRequest`, a server-side
 * one-shot call that already treats a throw as a DENY. A throw needs no render
 * to crash (R-50 is about a mounted shell). The caller here is presenting a
 * credential, not an unresolved principal, so the envelope shape reserved for
 * a subscribed list does not apply.
 *
 * THREE OUTCOMES, never two:
 *   - resolves            -> { orgSlug, agentName }
 *   - empty secret        -> RAISES reason "no-credential"
 *   - wrong / rotated-out / inactive agent
 *                         -> RAISES reason "credential-not-recognised"
 * A legitimate ABSENCE ("does this agent hold a credential?") is a different
 * question with its own door, `getAgentCredentialStatus`, which answers a
 * plain success `{ hasActiveCredential: false }`.
 *
 * Trusts NO caller-declared name: the only argument is the presented secret
 * itself; the identity returned comes solely from which row's `secretHash`
 * matches.
 *
 * WHO MAY ASK — THE FLEET'S SERVICE ACCOUNT ONLY. This door used to serve any
 * caller, anonymous included: whoever held a secret could ask "is it live, and
 * whose is it". Its sole consumer is the MCP server (`resolveActorFromRequest`,
 * mcp-server/src/auth.ts), which always calls through its service-account
 * identity (`createServiceAccountConvexClient`) — that account resolves as
 * master. So the caller is resolved FIRST (`withOrgScope` +
 * `requireResolvedCaller(..., { masterOnly: true })`) and everyone else is
 * refused BEFORE the secret is examined: a made-up secret and a live one are
 * the same bytes to a non-service caller, so the door is no validity oracle.
 * The refusal keeps the `RBAC_DENIED` code and names this door, so the MCP
 * reader (which branches on both) still maps it to a 401.
 */
// @credential presentedSecret agent-credential: the presented agent secret is hashed and resolved against stored agent credentials
export const resolveAgentCredential = query({
	args: { presentedSecret: v.string() },
	returns: resolvedIdentityValidator,
	handler: async (ctx, args) => {
		// isolation-contract: server-side only, no reactive subscriber — enumerated 2026-09-30 with: grep -rnE "agentCredentials|resolveAgentCredential" /root/coding/vantage-peers-dashboard --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git -> 0 hits. R-50 declared divergence.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(scope, "agentCredentials:resolveAgentCredential", {
			alsoRefusePreOrg: true,
			masterOnly: true,
			mcpBoundOnly: true,
		});
		if (args.presentedSecret.trim() === "") {
			return refuseUnresolvedCredential(
				"agentCredentials:resolveAgentCredential",
				"no-credential",
			);
		}
		const resolved = await resolveAgentCredentialCore(ctx, args.presentedSecret);
		if (resolved === null) {
			return refuseUnresolvedCredential(
				"agentCredentials:resolveAgentCredential",
				"credential-not-recognised",
			);
		}
		return { orgSlug: resolved.agent.orgSlug, agentName: resolved.agent.name };
	},
});

/**
 * getAgentCredentialStatus — the legitimate-absence door. An org-admin of the
 * agent's OWN org asks whether an agent holds an active credential; "no" is a
 * plain SUCCESS, distinguishable from every refusal above because it is a
 * value, not a raise. The credential value never appears: only a boolean and
 * the active-row count.
 */
export const getAgentCredentialStatus = query({
	args: { orgSlug: v.string(), agentName: v.string() },
	returns: v.object({
		orgSlug: v.string(),
		agentName: v.string(),
		hasActiveCredential: v.boolean(),
		activeRows: v.number(),
	}),
	handler: async (ctx, args) => {
		// isolation-contract: no reactive subscriber — enumerated 2026-10-03 with: `git -C <dashboard> grep -nE "api\.(agents|agentCredentials)\." origin/main -- app components hooks lib contexts providers` (dashboard origin/main 00a43cf, measured 2026-10-03) -> the only reader is components/agents/agents-admin.tsx:68, an imperative convex.query (no useQuery/useSubscription); server-side callers: grep -rnE "agentCredentials|resolveAgentCredential" convex mcp-server/src scripts. R-50 declared divergence.
		await requireOrgAdmin(ctx, args.orgSlug);
		const agent = await findAgentByName(ctx, args.orgSlug, args.agentName);
		const rows = agent ? await credentialRowsOfAgent(ctx, agent) : [];
		const activeRows = rows.filter((r) => r.isActive).length;
		return {
			orgSlug: args.orgSlug,
			agentName: args.agentName,
			hasActiveCredential: activeRows > 0,
			activeRows,
		};
	},
});
