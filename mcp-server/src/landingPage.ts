/**
 * Public setup page for a browser that opens the MCP endpoint.
 * VantagePeers Cloud (HTTP entry, server-http.ts).
 *
 * A person who pastes https://mcp.vantagepeers.com/mcp into a browser gets a
 * short page saying what VantagePeers is and how to connect, instead of a bare
 * 401. The page is static text and grants nothing
 * (.claude/rules/http-boundary-derives-from-principal.md): it reads no
 * credential, calls no backend and attaches no context.
 *
 * Only a request that cannot be an MCP request is answered here. Every other
 * request on /mcp (any POST, any request carrying Authorization, any GET that
 * accepts text/event-stream) goes to bearerAuthMiddleware exactly as before,
 * including the 401 + WWW-Authenticate that OAuth discovery depends on.
 */

import {
	SERVER_CONNECT_DOCS_URL,
	SERVER_DESCRIPTION,
	SERVER_TITLE,
	SERVER_WEBSITE_URL,
} from "./brand.js";

/** The media ranges of an Accept header, lower-cased, parameters dropped. */
function mediaRanges(accept: string): string[] {
	return accept
		.split(",")
		.map((part) => part.split(";")[0].trim().toLowerCase())
		.filter((part) => part.length > 0);
}

/**
 * True only for a browser-style GET: no Authorization header, an Accept that
 * does not include text/event-stream, and an Accept that includes text/html or
 * is exactly `*` `/` `*`, or no Accept at all. RFC 9110 §12.5.1: an absent
 * Accept means any media type; an MCP client opening the SSE stream always
 * sends `Accept: text/event-stream`, so an absent Accept cannot be one.
 */
export function isBrowserLandingRequest(req: Request): boolean {
	if (req.method !== "GET") return false;
	if (req.headers.has("authorization")) return false;
	const accept = req.headers.get("accept");
	if (accept === null) return true;
	const ranges = mediaRanges(accept);
	if (ranges.includes("text/event-stream")) return false;
	if (ranges.includes("text/html")) return true;
	return ranges.length === 1 && ranges[0] === "*/*";
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** The page for the server served at `publicBaseUrl` (an origin, no path). */
export function renderLandingPage(publicBaseUrl: string): string {
	const endpoint = escapeHtml(`${publicBaseUrl}/mcp`);
	const title = escapeHtml(SERVER_TITLE);
	const docs = escapeHtml(SERVER_CONNECT_DOCS_URL);
	const site = escapeHtml(SERVER_WEBSITE_URL);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} MCP server</title>
<link rel="icon" href="/favicon.ico">
<style>
  body { font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; color: #1f2328; }
  code { background: #f6f8fa; padding: 0.1rem 0.35rem; border-radius: 4px; overflow-wrap: anywhere; }
  h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
  li { margin: 0.4rem 0; }
  @media (prefers-color-scheme: dark) { body { background: #0d1117; color: #e6edf3; } code { background: #161b22; } a { color: #58a6ff; } }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${escapeHtml(SERVER_DESCRIPTION)}</p>
<p>This address is a Model Context Protocol (MCP) server. Add it to your AI client as a remote MCP server:</p>
<p><code>${endpoint}</code></p>
<ul>
<li><strong>Claude.ai</strong>: add a custom MCP connector with this URL, then Connect.</li>
<li><strong>ChatGPT</strong>: add a custom MCP server with this URL and OAuth authentication.</li>
<li><strong>Claude Code</strong>: <code>claude mcp add --transport http vantage-peers ${endpoint}</code></li>
<li><strong>Any other MCP client</strong>: a Streamable HTTP server at the URL above.</li>
</ul>
<p>Your client then opens a VantagePeers sign-in (OAuth). No token to copy.</p>
<p>Step-by-step guide: <a href="${docs}">${docs}</a><br>Website: <a href="${site}">${site}</a></p>
</main>
</body>
</html>`;
}

/** The landing page as an HTTP response. */
export function landingPageResponse(publicBaseUrl: string): Response {
	return new Response(renderLandingPage(publicBaseUrl), {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "public, max-age=300",
			"content-security-policy":
				"default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
			"x-content-type-options": "nosniff",
			// The same URL answers MCP requests differently by method/Accept.
			vary: "Accept, Authorization",
		},
	});
}
