/**
 * Registration of the SEP-1865 `ui://vp/v1/{primitive}` resource template on a
 * per-request McpServer. VantagePeers Cloud (HTTP /mcp entry, server-http.ts).
 *
 * Extracted from server-http.ts so the resources/read callback can be driven
 * through the real SDK in a test (in-memory transport) with a mock Convex
 * client and an arbitrary verified caller (task k17d6s1fsfy9fg7p339gq3rqnx8hc4qh).
 */

import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { isMasterScope, type OAuthContext } from "../auth.js";
import { listUiResources, readUiResource } from "./index.js";

/** The slice of a ConvexHttpClient the primitives read through. */
export type UiResourceConvexClient = Pick<ConvexHttpClient, "query">;

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
			const fetchConvex = async (
				functionName: string,
				args: Record<string, unknown>,
			) => {
				// biome-ignore lint/suspicious/noExplicitAny: Convex string API
				return convex.query(functionName as any, args as any);
			};
			// Day-165-parity — thread the caller identity into the ui-resource
			// primitives the same way tools.ts does (mirrors the
			// master/callerIdentities computation at tools.ts:5712/5808/5934), so
			// briefingNotes:get/list resolve visibility inside Convex instead of
			// falling into the `callerIdentities === undefined` legacy-open branch.
			const master = oauthCtx === undefined || isMasterScope(oauthCtx);
			const callerIdentities = master ? undefined : oauthCtx.fromAllowList;
			return await readUiResource(uri.toString(), fetchConvex, {
				master,
				callerIdentities,
			});
		},
	);
}
