import { describe, expect, it } from "vitest";
import { poolKeysOf } from "../src/ip.js";
import { RateLimiter } from "../src/limiter.js";

function clock() {
	let t = 1_000_000;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
	};
}
const keys = (ip: string) => {
	const k = poolKeysOf(ip);
	if (!k) throw new Error(`not an address: ${ip}`);
	return k;
};

describe("RateLimiter", () => {
	it("one IPv4 gets 20 per window; the 21st is refused with Retry-After", () => {
		const c = clock();
		const l = new RateLimiter(c.now);
		for (let i = 0; i < 20; i++)
			expect(l.take(keys("203.0.113.9")).allowed).toBe(true);
		c.advance(10_000);
		const d = l.take(keys("203.0.113.9"));
		expect(d).toEqual({ allowed: false, retryAfterSeconds: 50, pool: "v4/32" });
	});

	it("the window resets after 60 s", () => {
		const c = clock();
		const l = new RateLimiter(c.now);
		for (let i = 0; i < 21; i++) l.take(keys("203.0.113.9"));
		c.advance(60_000);
		expect(l.take(keys("203.0.113.9")).allowed).toBe(true);
	});

	it("IPv6: 20 per /64, however the low 64 bits rotate", () => {
		const l = new RateLimiter(clock().now);
		for (let i = 0; i < 20; i++)
			expect(l.take(keys(`2001:db8:1:2::${i + 1}`)).allowed).toBe(true);
		const d = l.take(keys("2001:db8:1:2:dead:beef::1"));
		expect(d.allowed).toBe(false);
		expect(l.take(keys("2001:db8:1:3::1")).allowed).toBe(true);
	});

	it("IPv4 /24: 60 across many addresses of one /24, the 61st is refused", () => {
		const l = new RateLimiter(clock().now);
		for (let i = 0; i < 60; i++)
			expect(l.take(keys(`203.0.113.${i + 1}`)).allowed).toBe(true);
		const d = l.take(keys("203.0.113.200"));
		expect(d).toMatchObject({ allowed: false, pool: "v4/24" });
		expect(l.take(keys("203.0.114.1")).allowed).toBe(true);
	});

	it("IPv6 /48: 60 across many /64s of one /48, the 61st is refused", () => {
		const l = new RateLimiter(clock().now);
		for (let i = 0; i < 60; i++)
			expect(l.take(keys(`2001:db8:1:${i.toString(16)}::1`)).allowed).toBe(
				true,
			);
		const d = l.take(keys("2001:db8:1:ffff::1"));
		expect(d).toMatchObject({ allowed: false, pool: "v6/48" });
		expect(l.take(keys("2001:db8:2::1")).allowed).toBe(true);
	});

	it("IPv6 /32: 200 across many /48s of one /32, the 201st is refused", () => {
		const l = new RateLimiter(clock().now);
		for (let i = 0; i < 200; i++)
			expect(l.take(keys(`2001:db8:${i.toString(16)}::1`)).allowed).toBe(true);
		const d = l.take(keys("2001:db8:ffff::1"));
		expect(d).toMatchObject({ allowed: false, pool: "v6/32" });
		expect(l.take(keys("2001:db9::1")).allowed).toBe(true);
	});

	it("a refused request is not counted: it costs its /24 neighbours nothing", () => {
		const l = new RateLimiter(clock().now);
		for (let i = 0; i < 20; i++) l.take(keys("203.0.113.1"));
		// 1000 refused attempts from the exhausted address.
		for (let i = 0; i < 1000; i++)
			expect(l.take(keys("203.0.113.1")).allowed).toBe(false);
		// The /24 holds 20, not 1020: 40 neighbours still fit.
		let ok = 0;
		for (let i = 0; i < 40; i++)
			if (l.take(keys(`203.0.113.${i + 10}`)).allowed) ok++;
		expect(ok).toBe(40);
	});

	it("Retry-After is the longest wait among the pools that refused", () => {
		const c = clock();
		const l = new RateLimiter(c.now);
		l.take(keys("203.0.113.1"));
		c.advance(30_000);
		for (let i = 0; i < 19; i++) l.take(keys("203.0.113.1"));
		const d = l.take(keys("203.0.113.1"));
		expect(d).toMatchObject({ allowed: false, retryAfterSeconds: 30 });
	});

	it("memory is bounded: the oldest bucket is evicted past the cap", () => {
		const l = new RateLimiter(clock().now, 60_000, 3);
		for (let i = 1; i <= 5; i++) l.take(keys(`10.${i}.0.1`));
		// 10.1.0.1 was evicted: it starts a fresh window instead of being refused.
		for (let i = 0; i < 19; i++) l.take(keys("10.1.0.1"));
		expect(l.take(keys("10.1.0.1")).allowed).toBe(true);
	});
});
