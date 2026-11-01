import type { ConvexHttpClient } from "convex/browser";
import { isMasterScope, type OAuthContext, seatAgentOf } from "./auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// toolUsage — the MCP side of "which tools has this caller called" (task
// k17cbr6y6da096t5e1k869kgb18hd0ht; Convex side: convex/toolUsage.ts).
//
// The caller key is derived from the VERIFIED oauthContext only, never from a
// tool argument:
//   - a Clerk session sends NO key: the Convex door derives "user:<subject>" from
//     the JWT it already receives;
//   - a person token: "user:<verified Clerk subject>" (also when the person acts
//     through its personal agent: the person is the caller);
//   - a per-agent credential, then a one-agent seat: "agent:<agents row id>";
//   - the master bearer / local stdio trust, no context, and an org-level seat
//     that resolves no agent: nothing is sent. Fleet operators are not an
//     organisation's callers, and a key invented from a client registration is
//     not an identity.
// The organisation is never sent: it travels as the acting org the client
// wrapper attaches to every call (authenticatedConvexClient.ts).
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
	const agentId = oauthCtx.actor?.agentId ?? seatAgentOf(oauthCtx)?.agentId;
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
		await convex.mutation(
			// biome-ignore lint/suspicious/noExplicitAny: Convex string API
			"toolUsage:record" as any,
			{
				toolName: tool,
				...(caller.callerKey !== undefined
					? { caller: caller.callerKey }
					: {}),
			},
		);
	} catch {
		// a recording failure is not the tool's failure
	}
}
