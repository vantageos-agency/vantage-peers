/// <reference types="vite/client" />
/**
 * Recipient names resolve diacritic-insensitively WITHIN the caller's own
 * reachable set (task k1716f01f9g1a0scz7nj30118h8fx32c, Iris RH incident):
 * "helios" typed by an LLM reaches the stored "hélios". The sender (`from`) is
 * never folded, and a fold never reaches a name the caller could not already
 * address. Refusals keep the existing bounce (no new refusal mechanism).
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([p]) =>
			!p.includes("ragSync") &&
			!p.includes("search") &&
			!p.includes("backfill"),
	),
);
const newWorld = () => convexTest(schema, modules);
type T = ReturnType<typeof newWorld>;
const sa = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

async function seedOrg(
	t: T,
	slug: string,
	roster: string[],
	extra: { addressableFleetCoordinators?: string[] } = {},
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			allowedOrchestrators: roster,
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
			...extra,
		});
	});
}

async function seedProfiles(t: T, names: string[]) {
	await t.run(async (ctx) => {
		for (const n of names) {
			await ctx.db.insert("profiles", {
				orchestratorId: n,
				name: n,
				static: { role: "r", capabilities: [], workspace: "" },
				dynamic: { lastSeen: Date.now(), sessionCount: 0 },
			} as never);
		}
	});
}

const send = (
	t: T,
	channel: string,
	opts: { from?: string; seat?: string } = {},
) =>
	sa(t).mutation(api.messages.sendMessage, {
		from: opts.from ?? "clio",
		channel,
		content: "x",
		seatOrgSlug: opts.seat ?? "iris-rh",
	} as never);

async function receiptsOf(t: T, messageId: unknown) {
	return await t.run(async (ctx) => {
		const rows = await ctx.db.query("messageReceipts").collect();
		return rows
			.filter((r) => r.messageId === messageId)
			.map((r) => r.recipient)
			.sort();
	});
}

async function irisWorld() {
	const t = newWorld();
	await seedOrg(t, "iris-rh", ["clio", "hélios", "marie"]);
	await seedProfiles(t, ["clio", "hélios", "marie"]);
	return t;
}

describe("diacritic fold on the recipient, inside the caller's scope", () => {
	test('"helios" is delivered to the stored "hélios"', async () => {
		const t = await irisWorld();
		const id = await send(t, "helios");
		expect(await receiptsOf(t, id)).toEqual(["hélios"]);
	});

	test.each([
		["HÉLIOS", "upper-case accented"],
		["Helios", "capitalised, unaccented"],
		["HELIOS", "upper-case, unaccented"],
		["hélios", "NFD accented"],
		["hélios", "NFC accented, unchanged"],
	])('"%s" (%s) is delivered to "hélios"', async (typed) => {
		const t = await irisWorld();
		const id = await send(t, typed);
		expect(await receiptsOf(t, id)).toEqual(["hélios"]);
	});

	test("a comma list folds each part and keeps exact parts", async () => {
		const t = await irisWorld();
		const id = await send(t, "helios,marie");
		expect(await receiptsOf(t, id)).toEqual(["hélios", "marie"]);
	});

	test("two spellings of the same agent yield ONE receipt", async () => {
		const t = await irisWorld();
		const id = await send(t, "helios,hélios");
		expect(await receiptsOf(t, id)).toEqual(["hélios"]);
	});
});

describe("ambiguity is never guessed", () => {
	async function dupWorld() {
		const t = newWorld();
		await seedOrg(t, "dup-org", ["clio", "helios", "hélios"]);
		await seedProfiles(t, ["clio", "helios", "hélios"]);
		return t;
	}

	test('exact "helios" wins over the accented sibling', async () => {
		const t = await dupWorld();
		const id = await send(t, "helios", { seat: "dup-org" });
		expect(await receiptsOf(t, id)).toEqual(["helios"]);
	});

	test('exact "hélios" wins over the unaccented sibling', async () => {
		const t = await dupWorld();
		const id = await send(t, "hélios", { seat: "dup-org" });
		expect(await receiptsOf(t, id)).toEqual(["hélios"]);
	});

	test('"hèlios" folds to BOTH: bounces, names both, delivers nothing', async () => {
		const t = await dupWorld();
		const err = await send(t, "hèlios", { seat: "dup-org" }).then(
			() => null,
			(e: { data?: unknown; message?: string }) => e,
		);
		expect(err).not.toBeNull();
		const text = String(err?.data ?? err?.message);
		expect(text).toContain("recipient error");
		expect(text).toContain("did you mean");
		expect(text).toContain("helios");
		expect(text).toContain("hélios");
		const n = await t.run(
			async (ctx) => (await ctx.db.query("messageReceipts").collect()).length,
		);
		expect(n).toBe(0);
	});
});

describe("the fold never leaves the caller's reachable set", () => {
	async function twoOrgWorld() {
		const t = newWorld();
		// "helios" (unaccented) is ANOTHER org's agent; iris only has "hélios".
		await seedOrg(t, "iris-rh", ["clio", "hélios"]);
		await seedOrg(t, "acme", ["bob", "helios"]);
		await seedOrg(t, "zeta", ["zed"]);
		await seedProfiles(t, ["clio", "hélios", "bob", "helios", "zed"]);
		return t;
	}

	test("iris reaches ONLY iris's hélios, not acme's helios, and is not ambiguous", async () => {
		const t = await twoOrgWorld();
		// exact "helios" is NOT on iris's roster, so it is not an exact match for
		// iris: the fold resolves inside iris's set to hélios alone.
		const id = await send(t, "helios", { seat: "iris-rh" });
		expect(await receiptsOf(t, id)).toEqual(["hélios"]);
	});

	test("acme sending to helios reaches acme's helios", async () => {
		const t = await twoOrgWorld();
		const id = await send(t, "helios", { seat: "acme", from: "bob" });
		expect(await receiptsOf(t, id)).toEqual(["helios"]);
	});

	test("a caller whose org has no hélios is bounced without hearing of another org's agent", async () => {
		const t = await twoOrgWorld();
		const err = await send(t, "helios", { seat: "zeta", from: "zed" }).then(
			() => null,
			(e: { data?: unknown; message?: string }) => e,
		);
		expect(err).not.toBeNull();
		const text = String(err?.data ?? err?.message);
		expect(text).toContain("recipient error");
		expect(text).not.toContain("hélios");
		expect(text).not.toContain("did you mean");
		const n = await t.run(
			async (ctx) => (await ctx.db.query("messageReceipts").collect()).length,
		);
		expect(n).toBe(0);
	});

	test("an ambiguity inside iris's set does not name a name outside it", async () => {
		const t = newWorld();
		await seedOrg(t, "dup-org", ["clio", "helios", "hélios"]);
		await seedOrg(t, "other", ["bob", "hèlios"]);
		await seedProfiles(t, ["clio", "helios", "hélios", "bob", "hèlios"]);
		const err = await send(t, "hêlios", { seat: "dup-org" }).then(
			() => null,
			(e: { data?: unknown; message?: string }) => e,
		);
		const text = String(err?.data ?? err?.message);
		expect(text).toContain("hélios");
		expect(text).not.toContain("hèlios");
	});
});

describe("unchanged refusals", () => {
	test('unknown "victor" still bounces, with no suggestion', async () => {
		const t = await irisWorld();
		const err = await send(t, "victor").then(
			() => null,
			(e: { data?: unknown; message?: string }) => e,
		);
		expect(err).not.toBeNull();
		const text = String(err?.data ?? err?.message);
		expect(text).toContain("recipient error");
		expect(text).not.toContain("did you mean");
	});

	test("the sender is not folded: an unaccented `from` is stored verbatim, never rewritten to hélios", async () => {
		const t = await irisWorld();
		// The sender gates are NOT part of this change. Measured on main
		// (540310d) and here alike: the seat path admits the unaccented spelling
		// as an unregistered sender label. What this pins is that the recipient
		// fold does not reach `from`.
		const id = await send(t, "marie", { from: "helios" });
		const row = await t.run(async (ctx) => ctx.db.get(id as never));
		expect((row as { from: string }).from).toBe("helios");
		expect(await receiptsOf(t, id)).toEqual(["marie"]);
	});

	test("an agent addressing its own folded name is a self-send: bounced, nothing delivered", async () => {
		const t = await irisWorld();
		const err = await send(t, "helios", { from: "hélios" }).then(
			() => null,
			(e: { data?: unknown; message?: string }) => e,
		);
		expect(String(err?.data ?? err?.message)).toContain("recipient error");
		const n = await t.run(
			async (ctx) => (await ctx.db.query("messageReceipts").collect()).length,
		);
		expect(n).toBe(0);
	});
});
