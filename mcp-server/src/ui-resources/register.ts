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
	type ProtocolError,
	ResourceTemplate,
} from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import type { OAuthContext } from "../auth.js";
import { listUiResources, readUiResource } from "./index.js";
import { callerOrgResolves, uiReadRefusal, uiReadScopeOf } from "./scope.js";

/** The slice of a ConvexHttpClient the primitives read through. */
export type UiResourceConvexClient = Pick<ConvexHttpClient, "query">;

/**
 * Admission for resources/read of ui://vp/v1/* (task
 * k17d6s1fsfy9fg7p339gq3rqnx8hc4qh, widened by k17apssqnw2xcf72r27c83338s8hc180).
 * A read is admitted only when Convex can be told WHOSE organisation it is for
 * (scope.ts callerOrgResolves):
 *
 *   (a) a Clerk-JWT caller (`clerkJwt` set, auth.ts case 2.5): its OWN verified
 *       token reaches Convex (selectConvexClientForRequest), which resolves
 *       its own org;
 *   (b) a master caller (`isMasterScope`): fleet-wide by right;
 *   (c) a non-master bearer whose verified org resolved (verifiedOrgSlugOf):
 *       it reaches Convex as the fleet service account, and every primitive
 *       hands its door that org through the tools' resolver (scope.ts), then
 *       applies its tool's MCP-side gate.
 *
 * Every other caller (an undefined context, or a bearer whose organisation
 * resolves to nothing) is refused before any Convex query: absence is never
 * master, and a lookup miss is a DENY.
 */
export function isUiResourceReadAdmitted(
	oauthCtx: OAuthContext | undefined,
): boolean {
	return callerOrgResolves(oauthCtx);
}

/**
 * The admission refusal, as an MCP error (never an empty resource:
 * refusal-is-distinguishable-from-absence.md). Carries the RBAC_DENIED code
 * and the door in both the message and the structured `data`.
 */
export function uiResourceReadRefusal(uri: string): ProtocolError {
	const primitive = new URL(uri).pathname.replace(/^\/v1\//, "");
	return uiReadRefusal(
		`resources/read ui://vp/v1/${primitive}`,
		"verified-org-unresolved",
		"needs the caller's verified organisation and this caller resolves none (served to a Clerk-JWT caller, the master, or a bearer whose organisation resolved)",
	);
}

export function registerUiResources(
	server: McpServer,
	convex: UiResourceConvexClient,
	oauthCtx: OAuthContext | undefined,
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
			// The caller's scope, built by the tools' own resolver (scope.ts). The
			// gate above already refused an undefined context, so `oauthCtx` is
			// the verified caller here, never absence read as master.
			if (oauthCtx === undefined) throw uiResourceReadRefusal(uri.toString());
			return await readUiResource(
				uri.toString(),
				fetchConvex,
				uiReadScopeOf(oauthCtx),
			);
		},
	);
}
