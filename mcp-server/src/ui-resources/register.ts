/**
 * Registration of the SEP-1865 `ui://vp/v1/{primitive}` resource template on a
 * per-request McpServer. VantagePeers Cloud (HTTP /mcp entry, server-http.ts).
 *
 * Extracted from server-http.ts so the resources/read callback can be driven
 * through the real SDK in a test (in-memory transport) with a mock Convex
 * client and an arbitrary verified caller (task k17d6s1fsfy9fg7p339gq3rqnx8hc4qh).
 */

import {
	type McpServer,
	ProtocolError,
	ProtocolErrorCode,
	ResourceTemplate,
} from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { isMasterScope, type OAuthContext } from "../auth.js";
import {
	listUiResources,
	readUiResource,
	type UiResourceCallerIdentity,
} from "./index.js";

/** The slice of a ConvexHttpClient the primitives read through. */
export type UiResourceConvexClient = Pick<ConvexHttpClient, "query">;

/**
 * Fail-closed admission for resources/read of ui://vp/v1/* (task
 * k17d6s1fsfy9fg7p339gq3rqnx8hc4qh). The primitives apply no tenant gate of
 * their own, so the read is admitted only when Convex itself scopes it:
 *
 *   (a) a Clerk-JWT caller (`clerkJwt` set, auth.ts case 2.5): its OWN verified
 *       token reaches Convex (selectConvexClientForRequest), which resolves
 *       its own org — never cross-tenant;
 *   (b) a master caller (`isMasterScope`): fleet-wide by right.
 *
 * Every other caller (a non-master OAuth bearer) would be served through the
 * fleet SERVICE-ACCOUNT client, which Convex resolves as master/fleet-wide, so
 * it is refused. An undefined context is refused too: absence is never master.
 * The proper per-tenant scoping of these primitives is a follow-up; this gate
 * only closes the leak.
 */
export function isUiResourceReadAdmitted(
	oauthCtx: OAuthContext | undefined,
): boolean {
	if (oauthCtx === undefined) return false;
	if (oauthCtx.clerkJwt) return true;
	return isMasterScope(oauthCtx);
}

/**
 * The refusal, as an MCP error (never an empty resource:
 * refusal-is-distinguishable-from-absence.md). Carries the RBAC_DENIED code
 * and the door in both the message and the structured `data`.
 */
export function uiResourceReadRefusal(uri: string): ProtocolError {
	const primitive = new URL(uri).pathname.replace(/^\/v1\//, "");
	const door = `resources/read ui://vp/v1/${primitive}`;
	return new ProtocolError(
		ProtocolErrorCode.InvalidRequest,
		`RBAC_DENIED: ${door} is served only to a Clerk-JWT or master caller. This is a refusal, NOT an empty resource.`,
		{ code: "RBAC_DENIED", door, reason: "ui-resource-not-tenant-scoped" },
	);
}

export function registerUiResources(
	server: McpServer,
	convex: UiResourceConvexClient,
	oauthCtx: OAuthContext | undefined,
	identity: UiResourceCallerIdentity,
): void {
	// Registered with a ResourceTemplate so that resources/list (via
	// listCallback) and resources/read both work.
	// URI pattern: ui://vp/v1/{primitive}  — query params read from the URL object.
	const uiResourceTemplate = new ResourceTemplate("ui://vp/v1/{primitive}", {
		list: async () => ({ resources: listUiResources() }),
	});
	server.registerResource(
		"vp-ui",
		uiResourceTemplate,
		{
			description:
				"SEP-1865 VantagePeers Generative UI primitives (HTML inline, Shadow DOM scoped)",
		},
		async (uri) => {
			// Gate BEFORE any Convex query: a refused caller reaches no backend.
			if (!isUiResourceReadAdmitted(oauthCtx)) {
				throw uiResourceReadRefusal(uri.toString());
			}
			const fetchConvex = async (
				functionName: string,
				args: Record<string, unknown>,
			) => {
				// biome-ignore lint/suspicious/noExplicitAny: Convex string API
				return convex.query(functionName as any, args as any);
			};
			// `identity` (master + callerIdentities) is computed by the caller
			// (server-http.ts) from the verified oauthCtx, as before the extraction.
			return await readUiResource(uri.toString(), fetchConvex, identity);
		},
	);
}
