/**
 * The signed client-address header from the rate-limit proxy (edge-proxy/).
 *
 * Trusted only with a valid, fresh signature under EDGE_PROXY_HMAC_SECRET.
 * Both poles: forged unsigned, forged with a bad signature, a stale signature,
 * a future-dated one, and a valid signature under another secret are all
 * ignored (today's derivation applies unchanged); a valid one is used, and it
 * is what the CIMD pool keys receive.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientIpForRateLimit } from "../server-http.js";
import { sourceKeyOf } from "../src/clientMetadataDocument.js";
import {
	EDGE_CLIENT_HEADER,
	verifyEdgeClientHeader,
} from "../src/edgeClientIp.js";

const SECRET = "test-edge-secret-0123456789abcdef";
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

function sign(ip: string, atMs: number, secret = SECRET): string {
	const ts = Math.floor(atMs / 1000);
	const mac = createHmac("sha256", secret)
		.update(`v1|${ip}|${ts}`)
		.digest("hex");
	return `${ip}|${ts}|${mac}`;
}
const h = (o: Record<string, string>) => (n: string) => o[n];

describe("signed edge client header", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		vi.stubEnv("EDGE_PROXY_HMAC_SECRET", SECRET);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("a valid fresh signature is used, ahead of x-real-ip", () => {
		expect(
			clientIpForRateLimit(
				h({
					[EDGE_CLIENT_HEADER]: sign("203.0.113.9", NOW),
					"x-real-ip": "10.0.0.1",
				}),
			),
		).toBe("203.0.113.9");
	});

	it("a valid IPv6 signature reaches the pool key as its /64", () => {
		const ip = clientIpForRateLimit(
			h({ [EDGE_CLIENT_HEADER]: sign("2001:db8:1:2:aaaa::1", NOW) }),
		);
		expect(ip).toBe("2001:db8:1:2:aaaa::1");
		expect(sourceKeyOf(ip)).toBe("2001:db8:1:2::/64");
	});

	it("forged unsigned: a bare address in the header is ignored", () => {
		expect(
			clientIpForRateLimit(
				h({ [EDGE_CLIENT_HEADER]: "198.51.100.7", "x-real-ip": "10.0.0.1" }),
			),
		).toBe("10.0.0.1");
	});

	it("forged with a bad signature is ignored", () => {
		const good = sign("198.51.100.7", NOW);
		const bad = `${good.slice(0, -1)}${good.endsWith("0") ? "1" : "0"}`;
		expect(
			clientIpForRateLimit(
				h({ [EDGE_CLIENT_HEADER]: bad, "x-real-ip": "10.0.0.1" }),
			),
		).toBe("10.0.0.1");
	});

	it("a valid signature whose address was swapped is ignored", () => {
		const [, ts, mac] = sign("198.51.100.7", NOW).split("|");
		expect(
			clientIpForRateLimit(
				h({
					[EDGE_CLIENT_HEADER]: `192.0.2.1|${ts}|${mac}`,
					"x-real-ip": "10.0.0.1",
				}),
			),
		).toBe("10.0.0.1");
	});

	it("a stale signature is ignored, a future-dated one too", () => {
		for (const at of [NOW - 31_000, NOW + 31_000]) {
			expect(
				clientIpForRateLimit(
					h({
						[EDGE_CLIENT_HEADER]: sign("198.51.100.7", at),
						"x-real-ip": "10.0.0.1",
					}),
				),
			).toBe("10.0.0.1");
		}
		// The edge of the window is still trusted.
		expect(
			clientIpForRateLimit(
				h({ [EDGE_CLIENT_HEADER]: sign("198.51.100.7", NOW - 30_000) }),
			),
		).toBe("198.51.100.7");
	});

	it("a signature under another secret is ignored", () => {
		expect(
			clientIpForRateLimit(
				h({
					[EDGE_CLIENT_HEADER]: sign("198.51.100.7", NOW, "other-secret"),
					"x-forwarded-for": "6.6.6.6, 203.0.113.2",
				}),
			),
		).toBe("203.0.113.2");
	});

	it("with no secret configured the header is never trusted", () => {
		vi.stubEnv("EDGE_PROXY_HMAC_SECRET", "");
		expect(
			clientIpForRateLimit(
				h({
					[EDGE_CLIENT_HEADER]: sign("198.51.100.7", NOW),
					"x-real-ip": "10.0.0.1",
				}),
			),
		).toBe("10.0.0.1");
	});

	it("malformed values are refused, not thrown on", () => {
		for (const v of [
			"",
			"|",
			"a|b|c",
			"not-an-ip|1|00",
			`${sign("198.51.100.7", NOW)}|extra`,
			`198.51.100.7|${"9".repeat(40)}|${"0".repeat(64)}`,
		])
			expect(verifyEdgeClientHeader(v, SECRET, NOW)).toBeNull();
	});
});
