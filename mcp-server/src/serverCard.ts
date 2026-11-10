/**
 * Public MCP Server Card. VantagePeers Cloud (HTTP entry, server-http.ts).
 *
 * Shape: the ServerCard type of the MCP Server Card extension (SEP-2127),
 * modelcontextprotocol/experimental-ext-server-card `schema.ts` / `schema.json`
 * at commit 526201bbc80231daa40ffcdecfc9da4e54e5dc93 (schema.json sha256
 * 2c772b51edb367f154771d84ddbae87ddba00a624422c8e46f218a9ac03bf042, vendored at
 * test/fixtures/server-card.schema.json and validated in
 * test/server-metadata-discoverability.test.ts).
 *
 * The card is public metadata, read before any connection, and grants nothing:
 * every string comes from brand.ts (the same source as the initialize
 * `serverInfo`), and the origin is the one this request was served on
 * (resolveIssuer), never a per-deployment literal.
 *
 * Authentication: the extension removed its `authentication` member (spec PR
 * #2525), so the card says how to sign in only under a vendor `_meta` key; a
 * client discovers OAuth itself through the RFC 9728 document the 401 from
 * /mcp points at.
 *
 * Surface (mcp-doctor S-50, served discovery): `capabilities` and `tools` are
 * top-level members the extension schema does not define (it leaves additional
 * members open). They are READ from the running server's initialize and
 * tools/list (serverDiscovery.ts), never written here, and `tools` carries
 * names only.
 */

import { createHash } from "node:crypto";
import type { Icon, ServerCapabilities } from "@modelcontextprotocol/server";
import {
	mcpImplementation,
	SERVER_CONNECT_DOCS_URL,
	SERVER_NAME,
} from "./brand.js";
import type { ServedDiscovery } from "./serverDiscovery.js";

export const SERVER_CARD_SCHEMA_URL =
	"https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
export const SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json";

/** Reverse-DNS card name (schema pattern `^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$`). */
export const SERVER_CARD_NAME = `com.vantagepeers/${SERVER_NAME}`;

/** The vendor `_meta` key carrying the sign-in hint. */
export const SERVER_CARD_AUTH_META_KEY = "com.vantagepeers/auth";

/**
 * Where the card is served. `/mcp/server-card` is the location the extension
 * reserves (`<streamable-http-url>/server-card`); the others are the URLs
 * public scanners probe.
 */
export const SERVER_CARD_PATHS = [
	"/mcp/server-card",
	"/.well-known/mcp/server-card.json",
	"/.well-known/mcp-server-card",
	"/mcp.json",
	"/.well-known/mcp.json",
] as const;

export type ServerCard = {
	$schema: string;
	name: string;
	version: string;
	description: string;
	title?: string;
	websiteUrl?: string;
	icons?: Icon[];
	remotes: Array<{ type: "streamable-http"; url: string }>;
	/** What initialize declares (S-50). */
	capabilities: ServerCapabilities;
	/** The names tools/list serves, in its order (S-50). */
	tools: string[];
	_meta: Record<string, unknown>;
};

/** The card for the server reachable at `publicBaseUrl` (an origin, no path). */
export function buildServerCard(
	version: string,
	publicBaseUrl: string,
	discovery: ServedDiscovery,
): ServerCard {
	const impl = mcpImplementation(version, publicBaseUrl);
	return {
		$schema: SERVER_CARD_SCHEMA_URL,
		name: SERVER_CARD_NAME,
		version: impl.version,
		description: impl.description ?? "",
		title: impl.title,
		websiteUrl: impl.websiteUrl,
		icons: impl.icons,
		remotes: [{ type: "streamable-http", url: `${publicBaseUrl}/mcp` }],
		capabilities: discovery.capabilities,
		tools: discovery.tools,
		_meta: {
			[SERVER_CARD_AUTH_META_KEY]: {
				type: "oauth2",
				protectedResourceMetadata: `${publicBaseUrl}/.well-known/oauth-protected-resource/mcp`,
				documentation: SERVER_CONNECT_DOCS_URL,
			},
		},
	};
}

/**
 * The card as an HTTP response: the card media type when the client asks for
 * it, plain JSON otherwise; cacheable, with an ETag honoured by If-None-Match.
 */
export function serverCardResponse(
	req: Request,
	version: string,
	publicBaseUrl: string,
	discovery: ServedDiscovery,
): Response {
	const body = JSON.stringify(
		buildServerCard(version, publicBaseUrl, discovery),
	);
	const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
	const accept = req.headers.get("accept") ?? "";
	const headers = new Headers({
		"content-type": accept.includes(SERVER_CARD_MEDIA_TYPE)
			? SERVER_CARD_MEDIA_TYPE
			: "application/json",
		"cache-control": "public, max-age=3600",
		etag,
		"access-control-expose-headers": "ETag",
	});
	if (req.headers.get("if-none-match") === etag) {
		return new Response(null, { status: 304, headers });
	}
	return new Response(body, { status: 200, headers });
}
