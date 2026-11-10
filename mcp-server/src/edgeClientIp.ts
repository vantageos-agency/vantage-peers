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
	return canonicalClientIp(ip);
}

/**
 * The spelling the rate-limit keys use: an IPv4-mapped IPv6 address (any
 * spelling) is its IPv4, a zone id is dropped. Mirrors the proxy's
 * canonicalIp, so the key is the same on both sides.
 */
export function canonicalClientIp(address: string): string {
	const bare = address.split("%")[0];
	const dotted = /^(?:0{1,4}:){0,5}:?(?:ffff):(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(
		bare.replace(/^::/, "0:0:0:0:0:"),
	);
	if (dotted) return dotted[1];
	const hex = /^(?:0{1,4}:){5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(
		bare.replace(/^::/, "0:0:0:0:0:").replace(/^(::)/, "0:0:0:0:0:"),
	);
	if (hex) {
		const hi = Number.parseInt(hex[1], 16);
		const lo = Number.parseInt(hex[2], 16);
		return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
	}
	return bare;
}
