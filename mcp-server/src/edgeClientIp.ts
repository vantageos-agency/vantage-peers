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
 * canonicalIp (edge-proxy/src/ip.ts), so the key is the same on both sides.
 */
export function canonicalClientIp(address: string): string {
	const bare = address.split("%")[0];
	if (isIP(bare) !== 6) return bare;
	let text = bare;
	const lastColon = text.lastIndexOf(":");
	const tail = text.slice(lastColon + 1);
	if (tail.includes(".")) {
		const o = tail.split(".").map(Number);
		text = `${text.slice(0, lastColon + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) return bare;
	const head = halves[0] ? halves[0].split(":") : [];
	const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
	if (fill < 0) return bare;
	const g = [...head, ...Array(fill).fill("0"), ...rest].map((x) =>
		Number.parseInt(x, 16),
	);
	if (g.length !== 8 || g.some((x) => Number.isNaN(x))) return bare;
	if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)
		return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
	return bare;
}
