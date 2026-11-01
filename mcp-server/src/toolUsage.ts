import type { ConvexHttpClient } from "convex/browser";
import { isMasterScope, type OAuthContext } from "./auth.js";
import { type DoorScopeArgs, verifiedOrgSlugOf } from "./doorScope.js";

// ─────────────────────────────────────────────────────────────────────────────
// toolUsage — the MCP side of "which tools has this caller called" (task
// k17cbr6y6da096t5e1k869kgb18hd0ht; Convex side: convex/toolUsage.ts).
//
// The caller key is derived from the VERIFIED oauthContext only, never from a
// tool argument:
//   - a Clerk session sends NO key: the Convex door derives "user:<subject>" from
//     the JWT it already receives;
//   - a person token: "user:<verified Clerk subject>" (also when the person acts
//     through its personal agent: the person is the caller). The RECORDER sends
//     the token proof instead and Convex re-reads the subject from the token row;
//   - a per-agent credential, then a one-agent seat: "agent:<agents row id>";
//   - the master bearer / local stdio trust, no context, and an org-level seat
//     that resolves no agent: nothing is sent. Fleet operators are not an
//     organisation's callers, and a key invented from a client registration is
//     not an identity.
// The organisation travels as the transport claim (`verifiedOrg`, R-54) beside
// the acting org the client wrapper attaches to every call.
// ─────────────────────────────────────────────────────────────────────────────

export type ToolUsageCaller =
	| { readonly send: false }
	| { readonly send: true; readonly callerKey?: string };

export function toolUsageCallerOf(
	oauthCtx: OAuthContext | undefined,
): ToolUsageCaller {
	if (oauthCtx === undefined) return { send: false };
	if (oauthCtx.clerkJwt !== undefined && !isMasterScope(oauthCtx)) {
		return { send: true };
	}
	if (isMasterScope(oauthCtx)) return { send: false };
	if (
		oauthCtx.principal === "person" &&
		oauthCtx.accessTokenHash !== undefined &&
		oauthCtx.userId !== ""
	) {
		return { send: true, callerKey: `user:${oauthCtx.userId}` };
	}
	const agentId = oauthCtx.actor?.agentId ?? oauthCtx.seatAgent?.agentId;
	if (agentId !== undefined && agentId !== "") {
		return { send: true, callerKey: `agent:${agentId}` };
	}
	return { send: false };
}

/**
 * Records one call of `tool` for the caller of this request. Fire-and-forget by
 * contract: it never rejects and never throws, so the tool that called it cannot
 * be failed by a recording error.
 */
export async function recordToolUsage(
	convex: Pick<ConvexHttpClient, "mutation">,
	oauthCtx: OAuthContext | undefined,
	tool: string,
): Promise<void> {
	try {
		const caller = toolUsageCallerOf(oauthCtx);
		if (!caller.send) return;
		const claimed = verifiedOrgSlugOf(oauthCtx);
		const orgSlug = claimed === "" ? undefined : claimed;
		// A bearer whose organisation cannot be resolved records nothing; a Clerk
		// session sends no claim (Convex sees its own org).
		if (caller.callerKey !== undefined && orgSlug === undefined) return;
		const person =
			oauthCtx?.principal === "person" &&
			oauthCtx.accessTokenHash !== undefined &&
			caller.callerKey !== undefined;
		await convex.mutation(
			// biome-ignore lint/suspicious/noExplicitAny: Convex string API
			"toolUsage:record" as any,
			{
				toolName: tool,
				...(person
					? { verifiedPerson: { accessTokenHash: oauthCtx.accessTokenHash } }
					: caller.callerKey !== undefined
						? { caller: caller.callerKey }
						: {}),
				...(orgSlug !== undefined ? { verifiedOrg: { orgSlug } } : {}),
			},
		);
	} catch {
		// a recording failure is not the tool's failure
	}
}

/**
 * The identity facts a tool-usage READ hands the Convex door, from the verified
 * oauthContext only: the door's scope arguments (a person bearer's token proof,
 * the bearer's verified organisation), else the seat's agent key. A named
 * organisation (`orgSlug`) rides as the transport claim: Convex believes it from
 * the service account only and refuses another organisation than the one the
 * call acts for, so a non-master naming a foreign organisation is refused there.
 * A Clerk session and the master send no key (Convex sees them itself). Any other
 * bearer that resolves no identity is REFUSED here: the Convex door serves an
 * acting-org call that presents no identity as the org-scoped service caller (the
 * onboarding engine), so an unidentified seat must never reach it.
 */
export function toolUsageReadArgs(
	oauthCtx: OAuthContext | undefined,
	scopeArgs: DoorScopeArgs,
	orgSlug: string | undefined,
): { args: Record<string, unknown> } | { denied: string } {
	if (oauthCtx === undefined) {
		return {
			denied: "Forbidden: the request carried no authorization context.",
		};
	}
	const named = orgSlug !== undefined ? { verifiedOrg: { orgSlug } } : {};
	if (isMasterScope(oauthCtx) || oauthCtx.clerkJwt !== undefined) {
		return { args: { ...scopeArgs, ...named } };
	}
	if (scopeArgs.verifiedPerson !== undefined) {
		return { args: { ...scopeArgs, ...named } };
	}
	const self = toolUsageCallerOf(oauthCtx);
	if (self.send && self.callerKey !== undefined) {
		return { args: { selfKey: self.callerKey, ...scopeArgs, ...named } };
	}
	return {
		denied:
			"Forbidden: this tool needs a caller identity and this bearer resolves none (no agent credential, no one-agent seat, no person token).",
	};
}
