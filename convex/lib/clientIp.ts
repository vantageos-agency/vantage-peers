/**
 * Client address derivation for Convex HTTP actions.
 *
 * TRUST ASSUMPTION (an inference, not a documented guarantee): the Convex
 * HTTP edge appends the address it observed to `x-forwarded-for`, as a
 * standard reverse proxy does. Every entry to the LEFT of the last one is
 * written by the client or an upstream hop and is attacker-controlled, so
 * the FIRST entry must never be used. The rightmost entry is the one the
 * nearest proxy observed. docs.convex.dev (http-actions) does not document
 * these headers.
 *
 * `x-real-ip` is NOT trusted over `x-forwarded-for`: nothing establishes
 * that the Convex edge overwrites a client-supplied value, so it is only a
 * fallback when `x-forwarded-for` carries no entry. Treat the result as an
 * audit hint, never as an authentication or authorization input.
 *
 * Mirrors `clientIpForRateLimit` (mcp-server/server-http.ts) except for the
 * x-real-ip precedence, which is Railway-specific there (documented edge).
 */
export function clientIpFromHeaders(headers: Headers): string | undefined {
	const entries = (headers.get("x-forwarded-for") ?? "")
		.split(",")
		.map((e) => e.trim())
		.filter(Boolean);
	const last = entries.at(-1);
	if (last) return last;
	const realIp = headers.get("x-real-ip")?.trim();
	return realIp ? realIp : undefined;
}
