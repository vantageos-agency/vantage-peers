/**
 * CIMD authorize/token pool vs hanging documents (sentinel pass 2, the Medium
 * that predates the follow-up; probes B4a, B4b, B5).
 *
 * About 6 source addresses could keep every slot of a pool busy by hanging
 * distinct URLs: 10 fetches a minute each, 3 s a timeout, 3 slots. A source whose
 * fetch timed out is now SUSPECT for CIMD_SUSPECT_MS: all suspect sources
 * together may hold at most CIMD_SUSPECT_LANE slot of a pool, so the other
 * slots stay for sources that have not hung. The lane keys on the SOURCE, never
 * on a domain or a URL: a stranger can only demote itself, so it cannot cool
 * down a victim. A refresh is never held back by it.
 *
 * Residual, stated: an attacker with many fresh source addresses holds a slot
 * for one timeout per address and minute; filling 2 of 3 slots takes about 40
 * addresses, and the three that hang at the very same instant block a fresh
 * victim for one timeout (3 s).
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

async function rig(stalled: (h: string) => boolean, now?: () => number) {
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
	rec.deps.resolveHost = (h: string) =>
		stalled(h) ? new Promise<never>(() => undefined) : base(h);
	cimd._setClientMetadataDepsForTest(rec.deps);
	return rec;
}

const hang = (host: string) => host.endsWith(".hang.example");
const at = (
	url: string,
	source: string,
	purpose: "authorize" | "token" | "refresh" = "authorize",
) => cimd.resolveClientMetadata(url, { purpose, source });
const stalledUrl = (i: number, path = "c", sub = "s") =>
	`https://${sub}${i}.d${i}.hang.example/${path}.json`;
const VICTIM = "https://app.victim.example/oauth/client-metadata.json";

describe("B4a sustained: strangers that already hung cannot keep the pool full", () => {
	for (const purpose of ["authorize", "token"] as const) {
		it(`${purpose}: after their first timeout, three sources hanging new URLs hold one slot, and a fresh victim is served`, async () => {
			const rec = await rig(hang);
			const wave1 = [1, 2, 3].map((i) =>
				at(stalledUrl(i), `203.0.113.${i}`, purpose),
			);
			const out1 = await Promise.all(wave1);
			expect(out1.every((r) => !r.ok && r.reason === "fetch-timeout")).toBe(
				true,
			);
			const before = rec.requests.length;
			const wave2 = [1, 2, 3].flatMap((i) =>
				[0, 1].map((k) =>
					at(stalledUrl(i, `n${k}`, "t"), `203.0.113.${i}`, purpose),
				),
			);
			await new Promise((r) => setTimeout(r, 30));
			const victim = await at(VICTIM, "198.51.100.9", purpose);
			expect(victim.ok).toBe(true);
			const out2 = await Promise.all(wave2);
			expect(
				out2.filter((r) => !r.ok && r.reason === "busy").length,
			).toBeGreaterThanOrEqual(5);
			expect(rec.requests.length - before - 1).toBeLessThanOrEqual(
				cimd.CIMD_SUSPECT_LANE,
			);
		});
	}
});

describe("the lane demotes the source only", () => {
	it("a suspect source's refresh is served; a fresh source is unaffected; the demotion ends", async () => {
		let t = 2_000_000;
		await rig(hang, () => t);
		await at(stalledUrl(1), "203.0.113.1"); // times out: the source is suspect
		const lane = [
			at(stalledUrl(1, "x"), "203.0.113.1"), // takes the lane
			at(stalledUrl(2, "y"), "203.0.113.1"), // lane full
		];
		await new Promise((r) => setTimeout(r, 20));
		const refreshed = await at(VICTIM, "203.0.113.1", "refresh");
		expect(refreshed.ok).toBe(true);
		const second = await lane[1];
		expect(second).toMatchObject({ reason: "busy" });
		await lane[0];
		t += cimd.CIMD_SUSPECT_MS + 1;
		const later = await at("https://later.victim.example/c.json", "203.0.113.1");
		expect(later.ok).toBe(true);
		const other = await at("https://other.victim.example/c.json", "203.0.113.9");
		expect(other.ok).toBe(true);
	});
});
