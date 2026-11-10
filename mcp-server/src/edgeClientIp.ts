import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

/** The one header the rate-limit proxy (edge-proxy/) uses to carry the client address. */
export const EDGE_CLIENT_HEADER = "x-vp-edge-client";

/** A signature older (or newer) than this many seconds is not trusted. */
export const EDGE_CLIENT_MAX_SKEW_SECONDS = 30;

/**
 * The client address carried by a signed edge header, or null.
 *
 * Format: `<ip>|<unix seconds>|<hex HMAC-SHA256 of "v1|<ip>|<seconds>">` under
 * the secret shared with the proxy. Null (the caller then keeps its own
 * derivation) for: no secret configured, no header, a malformed header, a
 * value that is not an IP address, a signature that does not match, a
 * timestamp outside the skew window in either direction.
 */
export function verifyEdgeClientHeader(
	value: string | undefined,
	secret: string | undefined,
	nowMs: number = Date.now(),
): string | null {
	if (!secret || !value) return null;
	const parts = value.split("|");
	if (parts.length !== 3) return null;
	const [ip, tsText, mac] = parts;
	if (!isIP(ip.split("%")[0])) return null;
	if (!/^\d{1,12}$/.test(tsText) || !/^[0-9a-f]{64}$/.test(mac)) return null;
	const ts = Number(tsText);
	if (Math.abs(Math.floor(nowMs / 1000) - ts) > EDGE_CLIENT_MAX_SKEW_SECONDS)
		return null;
	const expected = createHmac("sha256", secret)
		.update(`v1|${ip}|${ts}`)
		.digest();
	const given = Buffer.from(mac, "hex");
	if (given.length !== expected.length || !timingSafeEqual(given, expected))
		return null;
	return ip;
}
