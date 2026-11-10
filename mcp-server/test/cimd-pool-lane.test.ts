/**
 * CIMD authorize/token pool vs hanging documents (sentinel passes 2 and 3).
 *
 * The pool is 8 slots per path (a fetch is at most 5 KB and 3 s), one prefix
 * (IPv4 /24, IPv6 /48) may hold at most CIMD_PER_PREFIX_IN_FLIGHT of them, and a
 * prefix that timed out twice within CIMD_SUSPECT_MS is SUSPECT: all suspect
 * prefixes together hold at most CIMD_SUSPECT_LANE slot of a pool. One timeout
 * marks nothing (a shared address with one slow document is not squeezed), and
 * the `unknown` source (no address header) is never marked. A refresh is never
 * held back. The lane keys on the source prefix, never on a domain or URL: a
 * stranger can only demote its own prefix, so it cannot cool a victim down.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	bodyOf,
	type CimdModule,
	loadCimd,
	scripted,
	validDocument,
} from "./lib/cimdFakes.js";

type Resolve = (h: string) => Promise<{ address: string; family: number }[]>;
let cimd: CimdModule;

afterEach(async () => {
	(await loadCimd().catch(() => null))?._setClientMetadataDepsForTest?.(null);
});

async function rig(now?: () => number) {
	cimd = await loadCimd();
	const rec = scripted({
		timeoutMs: 150,
		perSourceLimit: 1000,
		...(now ? { now } : {}),
		respond: (req) => ({
			body: bodyOf(
				JSON.stringify(validDocument({}, `https://${req.hostname}${req.path}`)),
			),
		}),
	});
	const base = rec.deps.resolveHost as Resolve;
	const queried: string[] = [];
	rec.deps.resolveHost = (h: string) => {
		queried.push(h);
		return h.includes("hang") ? new Promise<never>(() => undefined) : base(h);
	};
	cimd._setClientMetadataDepsForTest(rec.deps);
	return { queried };
}

let seq = 0;
/** A hanging URL on a registrable domain of its own. */
const hangUrl = () => {
	seq++;
	return `https://h.hang${seq}.com/c.json`;
};
const okUrl = () => {
	seq++;
	return `https://app.ok${seq}.com/oauth/client-metadata.json`;
};
const at = (
	url: string,
	source: string | undefined,
	purpose: "authorize" | "token" | "refresh" = "authorize",
) =>
	cimd.resolveClientMetadata(url, {
		purpose,
		...(source !== undefined ? { source } : {}),
	});
const reasonOf = (r: { ok: boolean; reason?: string }) =>
	r.ok ? "ok" : r.reason;
const settle = () => new Promise((r) => setTimeout(r, 25));

describe("the pool is wide enough that one prefix cannot fill it", () => {
	it("authorize and token have 8 slots, refresh keeps its 2", async () => {
		cimd = await loadCimd();
		expect(cimd.CIMD_POOL.authorize).toBeGreaterThanOrEqual(8);
		expect(cimd.CIMD_POOL.token).toBeGreaterThanOrEqual(8);
		expect(cimd.CIMD_POOL.refresh).toBe(2);
	});

	it("one /24 holds at most CIMD_PER_PREFIX_IN_FLIGHT slots, however many addresses it rotates; a victim elsewhere is served", async () => {
		const rec = await rig();
		const n = cimd.CIMD_PER_PREFIX_IN_FLIGHT;
		const flood = Array.from({ length: n + 2 }, (_, i) =>
			at(hangUrl(), `203.0.113.${10 + i}`),
		);
		await settle();
		expect(rec.queried).toHaveLength(n);
		const victim = await at(okUrl(), "198.51.100.9");
		expect(victim.ok).toBe(true);
		const out = await Promise.all(flood);
		expect(out.filter((r) => reasonOf(r) === "busy")).toHaveLength(2);
	});

	it("two attacker prefixes at the cap leave a fresh victim a slot", async () => {
		await rig();
		const n = cimd.CIMD_PER_PREFIX_IN_FLIGHT;
		const flood = [
			...Array.from({ length: n }, (_, i) =>
				at(hangUrl(), `203.0.113.${i + 1}`),
			),
			...Array.from({ length: n }, (_, i) => at(hangUrl(), `192.0.2.${i + 1}`)),
		];
		await settle();
		const victim = await at(okUrl(), "198.51.100.9");
		expect(victim.ok).toBe(true);
		await Promise.all(flood);
	});
});

describe("F2 — one timeout marks nothing", () => {
	it("a second concurrent request from an address that timed out once is still fetched", async () => {
		const rec = await rig();
		const first = await at(hangUrl(), "198.51.100.7");
		expect(reasonOf(first)).toBe("fetch-timeout");
		const before = rec.queried.length;
		const pair = [at(hangUrl(), "198.51.100.7"), at(hangUrl(), "198.51.100.7")];
		await settle();
		expect(rec.queried.length - before).toBe(2);
		const out = await Promise.all(pair);
		expect(out.every((r) => reasonOf(r) === "fetch-timeout")).toBe(true);
	});
});

describe("F3 — the `unknown` source is never marked", () => {
	it("three timeouts without an address, then two concurrent requests are both fetched", async () => {
		const rec = await rig();
		for (let i = 0; i < 3; i++)
			expect(reasonOf(await at(hangUrl(), undefined))).toBe("fetch-timeout");
		const before = rec.queried.length;
		const pair = [at(hangUrl(), undefined), at(hangUrl(), undefined)];
		await settle();
		expect(rec.queried.length - before).toBe(2);
		await Promise.all(pair);
	});
});

describe("F1 — two timeouts mark the PREFIX, so rotating addresses inside it does not escape", () => {
	it("IPv4: after two timeouts from a /24, new addresses of it share one lane slot", async () => {
		const rec = await rig();
		await at(hangUrl(), "203.0.113.1");
		await at(hangUrl(), "203.0.113.2");
		const before = rec.queried.length;
		const next = [3, 4, 5].map((i) => at(hangUrl(), `203.0.113.${i}`));
		await settle();
		expect(rec.queried.length - before).toBe(cimd.CIMD_SUSPECT_LANE);
		const victim = await at(okUrl(), "198.51.100.9");
		expect(victim.ok).toBe(true);
		const out = await Promise.all(next);
		expect(out.filter((r) => reasonOf(r) === "busy")).toHaveLength(
			3 - cimd.CIMD_SUSPECT_LANE,
		);
	});

	it("IPv6: the prefix is the /48, so fresh /64s of it do not escape", async () => {
		const rec = await rig();
		await at(hangUrl(), "2001:db8:1:1::1");
		await at(hangUrl(), "2001:db8:1:2::1");
		const before = rec.queried.length;
		const next = [3, 4].map((i) => at(hangUrl(), `2001:db8:1:${i}::1`));
		await settle();
		expect(rec.queried.length - before).toBe(cimd.CIMD_SUSPECT_LANE);
		await Promise.all(next);
	});

	it("a refresh from a suspect prefix is served; the mark ends after the window; another prefix is untouched", async () => {
		let t = 2_000_000;
		await rig(() => t);
		await at(hangUrl(), "203.0.113.1");
		await at(hangUrl(), "203.0.113.2");
		const refreshed = await at(okUrl(), "203.0.113.3", "refresh");
		expect(refreshed.ok).toBe(true);
		t += cimd.CIMD_SUSPECT_MS + 1;
		const pair = [at(hangUrl(), "203.0.113.4"), at(hangUrl(), "203.0.113.5")];
		await settle();
		const out = await Promise.all(pair);
		expect(out.every((r) => reasonOf(r) === "fetch-timeout")).toBe(true);
		expect((await at(okUrl(), "192.0.2.9")).ok).toBe(true);
	});
});
