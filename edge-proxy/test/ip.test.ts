import { describe, expect, it } from "vitest";
import { ipv6Groups, poolKeysOf } from "../src/ip.js";

describe("poolKeysOf", () => {
	it("IPv4 counts in its /32 (20) and its /24 (60)", () => {
		expect(poolKeysOf("203.0.113.9")).toEqual([
			{ pool: "v4/32", key: "203.0.113.9", limit: 20 },
			{ pool: "v4/24", key: "203.0.113", limit: 60 },
		]);
	});

	it("IPv6 counts in its /64 (20), /48 (60) and /32 (200)", () => {
		expect(poolKeysOf("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toEqual([
			{ pool: "v6/64", key: "2001:db8:1:2", limit: 20 },
			{ pool: "v6/48", key: "2001:db8:1", limit: 60 },
			{ pool: "v6/32", key: "2001:db8", limit: 200 },
		]);
	});

	it("compressed and expanded spellings of one address share keys", () => {
		const a = poolKeysOf("2001:db8::1");
		const b = poolKeysOf("2001:0db8:0000:0000:0000:0000:0000:0001");
		expect(a).toEqual(b);
		expect(a?.[0].key).toBe("2001:db8:0:0");
	});

	it("addresses in one /64 share the /64 key; one /48 shares the /48 key", () => {
		const a = poolKeysOf("2001:db8:1:2::1");
		const b = poolKeysOf("2001:db8:1:2:ffff:ffff:ffff:ffff");
		const c = poolKeysOf("2001:db8:1:3::1");
		expect(a?.[0]).toEqual(b?.[0]);
		expect(a?.[0].key).not.toBe(c?.[0].key);
		expect(a?.[1]).toEqual(c?.[1]);
	});

	it("a mapped IPv4 is that IPv4, in both spellings", () => {
		const v4 = poolKeysOf("198.51.100.7");
		expect(poolKeysOf("::ffff:198.51.100.7")).toEqual(v4);
		expect(poolKeysOf("::ffff:c633:6407")).toEqual(v4);
	});

	it("a zone id is dropped, and a non-address has no keys", () => {
		expect(poolKeysOf("fe80::1%eth0")?.[0].key).toBe("fe80:0:0:0");
		for (const bad of ["", "unknown", "1.2.3", "1.2.3.4.5", "::g", "999.1.1.1"])
			expect(poolKeysOf(bad)).toBeNull();
	});

	it("ipv6Groups parses the edge cases", () => {
		expect(ipv6Groups("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
		expect(ipv6Groups("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
		expect(ipv6Groups("1::")).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
		expect(ipv6Groups("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(ipv6Groups("1:2:3:4:5:6:1.2.3.4")).toEqual([
			1, 2, 3, 4, 5, 6, 0x102, 0x304,
		]);
	});
});
