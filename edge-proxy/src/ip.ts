import { isIP } from "node:net";

/** Parses an IPv6 text address into 8 groups of 16 bits, or null when it is not one. */
export function ipv6Groups(address: string): number[] | null {
	let text = address.split("%")[0];
	if (isIP(text) !== 6) return null;
	// A dotted IPv4 tail (::ffff:1.2.3.4) is two groups.
	const lastColon = text.lastIndexOf(":");
	const tail = text.slice(lastColon + 1);
	if (tail.includes(".")) {
		const o = tail.split(".").map(Number);
		text = `${text.slice(0, lastColon + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
	if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
	const groups = [...head, ...Array(fill).fill("0"), ...rest].map((g) =>
		Number.parseInt(g, 16),
	);
	return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff)
		? groups
		: null;
}

export interface PoolKey {
	/** Pool name: which prefix length, e.g. "v4/32", "v6/48". */
	pool: string;
	/** The prefix value inside that pool. */
	key: string;
	/** Requests allowed per window for this key. */
	limit: number;
}

/**
 * The limits (per window of 60 s), by prefix:
 *   IPv4 /32 and IPv6 /64 : 20   one client
 *   IPv4 /24 and IPv6 /48 : 60   one site / one subscriber allocation
 *   IPv6 /32              : 200  one provider allocation
 */
export const LIMIT_PER_CLIENT = 20;
export const LIMIT_PER_SITE = 60;
export const LIMIT_PER_V6_PROVIDER = 200;
export const WINDOW_MS = 60_000;

/**
 * The pool keys a client address counts against, or null when the text is not
 * an IP address at all. A mapped IPv4 (::ffff:a.b.c.d) is that IPv4.
 */
export function poolKeysOf(address: string): PoolKey[] | null {
	const bare = address.split("%")[0].trim();
	const family = isIP(bare);
	if (family === 4) return v4Keys(bare.split(".").map(Number));
	if (family === 6) {
		const g = ipv6Groups(bare);
		if (!g) return null;
		if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)
			return v4Keys([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
		const hex = (n: number) => g.slice(0, n).map((x) => x.toString(16));
		return [
			{ pool: "v6/64", key: hex(4).join(":"), limit: LIMIT_PER_CLIENT },
			{ pool: "v6/48", key: hex(3).join(":"), limit: LIMIT_PER_SITE },
			{ pool: "v6/32", key: hex(2).join(":"), limit: LIMIT_PER_V6_PROVIDER },
		];
	}
	return null;
}

function v4Keys(o: number[]): PoolKey[] {
	return [
		{ pool: "v4/32", key: o.join("."), limit: LIMIT_PER_CLIENT },
		{ pool: "v4/24", key: o.slice(0, 3).join("."), limit: LIMIT_PER_SITE },
	];
}

/**
 * The one spelling of a client address that is signed and keyed: an IPv4-mapped
 * IPv6 address (any spelling) is its IPv4; any other address is lower-cased
 * without a zone id. Null when the text is not an address.
 */
export function canonicalIp(address: string): string | null {
	const bare = address.split("%")[0].trim();
	const family = isIP(bare);
	if (family === 4) return bare;
	if (family !== 6) return null;
	const g = ipv6Groups(bare);
	if (g && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)
		return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
	return bare.toLowerCase();
}
