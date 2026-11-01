/// <reference types="vite/client" />
// allow-missing-refs: new test file created by the specialist
/**
 * The messages row reads after an org-slug takeover (task
 * k1783fk8r6p795x9fxrzyt9evd8hcxm7, PR (2b), sweep sites A-10 listMessages,
 * A-12 listBroadcastStatus, A-13 listByChannel, A-14 listByChannelPaginated,
 * A-15 getById, A-16 searchMessagesByKeyword, A-18 dashboard summary).
 *
 * Modelling: org A (id X) held SLUG and was renamed; org B (id Y) now holds SLUG.
 * A's rows carry tenantId SLUG and tenantOrgId X. A read keyed on the slug serves
 * B the rows of A. Each site is pinned by the takeover scenario AND by the three
 * row shapes of Pi's ruling 2:
 *   (a) no tenantId, no tenantOrgId  visible to a fleet caller, absent to every org caller
 *   (b) tenantId, no tenantOrgId     absent to every org caller
 *   (c) stamped                      its own org only
 */

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import {
	memberA,
	memberB,
	ORG_A,
	ORG_B,
	type Seeded,
	seedShapes,
	seedTakeoverOrgs,
	SLUG,
	TEXT,
} from "../../tests/lib/slugTakeoverMessagesWorld";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("backfill") &&
			!path.includes("Backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];
const SERVICE = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;

type World = { t: T; ids: Seeded };

async function world(): Promise<World> {
	const t = createT();
	const ids = await t.run(async (ctx) => {
		await seedTakeoverOrgs(ctx.db);
		return await seedShapes(ctx.db);
	});
	return { t, ids };
}

const asA = (t: T) => t.withIdentity(memberA() as Identity);
const asB = (t: T) => t.withIdentity(memberB() as Identity);
const asService = (t: T) => t.withIdentity({ subject: SERVICE });
// B's seat reaches Convex as the service account carrying B's label as the claim.
const viaBClaim = { verifiedOrg: { orgSlug: SLUG } };

async function denied(p: Promise<unknown>): Promise<boolean> {
	try {
		await p;
		return false;
	} catch (e) {
		const text = e instanceof ConvexError ? String(e.data) : String(e);
		return text.includes("RBAC_DENIED");
	}
}

const texts = (rows: Array<{ content: string }>): string[] =>
	rows.map((r) => r.content).sort();

describe("A-10 messages:listMessages", () => {
	test("TAKEOVER: B (new holder of the slug) reads its own row only, never A's, never an unstamped or id-less row", async () => {
		const { t } = await world();
		expect(texts(await asB(t).query(api.messages.listMessages, {}))).toEqual([
			TEXT.b,
		]);
		expect(
			texts(await asService(t).query(api.messages.listMessages, viaBClaim)),
		).toEqual([TEXT.b]);
	});

	test("PRESENT: A, renamed, still reads its own row (and only it)", async () => {
		const { t } = await world();
		expect(texts(await asA(t).query(api.messages.listMessages, {}))).toEqual([
			TEXT.a,
		]);
	});

	test("SHAPES: a fleet caller sees the unstamped row; no org caller sees shape (a) or (b)", async () => {
		const { t } = await world();
		const fleet = texts(await asService(t).query(api.messages.listMessages, {}));
		expect(fleet).toContain(TEXT.fleet);
		for (const org of [asA(t), asB(t)]) {
			const seen = texts(await org.query(api.messages.listMessages, {}));
			expect(seen).not.toContain(TEXT.fleet);
			expect(seen).not.toContain(TEXT.absent);
		}
	});
});

describe("A-12 messages:listBroadcastStatus", () => {
	test("TAKEOVER: B is refused A's message, the id-less row and the unstamped row; served its own", async () => {
		const { t, ids } = await world();
		for (const id of [ids.messages.a, ids.messages.absent, ids.messages.fleet]) {
			expect(
				await denied(
					asB(t).query(api.messages.listBroadcastStatus, { messageId: id }),
				),
			).toBe(true);
		}
		const own = await asB(t).query(api.messages.listBroadcastStatus, {
			messageId: ids.messages.b,
		});
		expect(own.messageId).toBe(ids.messages.b);
	});

	test("PRESENT: A, renamed, is served A's message and refused the id-less row", async () => {
		const { t, ids } = await world();
		const own = await asA(t).query(api.messages.listBroadcastStatus, {
			messageId: ids.messages.a,
		});
		expect(own.messageId).toBe(ids.messages.a);
		expect(
			await denied(
				asA(t).query(api.messages.listBroadcastStatus, {
					messageId: ids.messages.absent,
				}),
			),
		).toBe(true);
	});
});

describe("A-13 messages:listByChannel", () => {
	test("TAKEOVER + SHAPES: B reads its own row on the channel, never A's, (a) or (b)", async () => {
		const { t } = await world();
		const rows = await asB(t).query(api.messages.listByChannel, {
			channel: "sigma",
		});
		expect(Array.isArray(rows)).toBe(true);
		expect(texts(rows as Array<{ content: string }>)).toEqual([TEXT.b]);
		const all = await asB(t).query(api.messages.listByChannel, {});
		expect(texts(all as Array<{ content: string }>)).toEqual([TEXT.b]);
	});

	test("PRESENT: A, renamed, reads its own row; the fleet caller still reads the unstamped one", async () => {
		const { t } = await world();
		const a = await asA(t).query(api.messages.listByChannel, {
			channel: "sigma",
		});
		expect(texts(a as Array<{ content: string }>)).toEqual([TEXT.a]);
		const fleet = await asService(t).query(api.messages.listByChannel, {
			channel: "sigma",
		});
		expect(texts(fleet as Array<{ content: string }>)).toContain(TEXT.fleet);
	});
});

describe("A-14 messages:listByChannelPaginated", () => {
	const opts = { numItems: 50, cursor: null };

	test("TAKEOVER + SHAPES: B pages its own row only, with and without a channel", async () => {
		const { t } = await world();
		for (const args of [{ channel: "sigma" }, {}]) {
			const r = await asB(t).query(api.messages.listByChannelPaginated, {
				paginationOpts: opts,
				...args,
			});
			expect(texts(r.page)).toEqual([TEXT.b]);
		}
	});

	test("PRESENT: A, renamed, pages its own row", async () => {
		const { t } = await world();
		const r = await asA(t).query(api.messages.listByChannelPaginated, {
			paginationOpts: opts,
		});
		expect(texts(r.page)).toEqual([TEXT.a]);
	});
});

describe("A-15 messages:getById", () => {
	test("TAKEOVER: B is refused A's row, the id-less row and the unstamped row; served its own", async () => {
		const { t, ids } = await world();
		for (const id of [ids.messages.a, ids.messages.absent, ids.messages.fleet]) {
			expect(
				await denied(asB(t).query(api.messages.getById, { messageId: id })),
			).toBe(true);
		}
		const own = await asB(t).query(api.messages.getById, {
			messageId: ids.messages.b,
		});
		expect(own?.content).toBe(TEXT.b);
	});

	test("PRESENT: A, renamed, is served its own row; the fleet caller is served the unstamped row", async () => {
		const { t, ids } = await world();
		expect(
			(await asA(t).query(api.messages.getById, { messageId: ids.messages.a }))
				?.content,
		).toBe(TEXT.a);
		expect(
			(
				await asService(t).query(api.messages.getById, {
					messageId: ids.messages.fleet,
				})
			)?.content,
		).toBe(TEXT.fleet);
	});
});

describe("A-16 messages:searchMessagesByKeyword", () => {
	test("TAKEOVER + SHAPES: B finds its own row only (member session and the claimed seat)", async () => {
		const { t } = await world();
		const member = await asB(t).query(api.messages.searchMessagesByKeyword, {
			query: "probe",
		});
		expect(texts(member as Array<{ content: string }>)).toEqual([TEXT.b]);
		const seat = await asService(t).query(api.messages.searchMessagesByKeyword, {
			query: "probe",
			...viaBClaim,
		});
		expect(texts(seat as Array<{ content: string }>)).toEqual([TEXT.b]);
	});

	test("PRESENT: A, renamed, finds its own row; the fleet caller finds the unstamped one", async () => {
		const { t } = await world();
		const a = await asA(t).query(api.messages.searchMessagesByKeyword, {
			query: "probe",
		});
		expect(texts(a as Array<{ content: string }>)).toEqual([TEXT.a]);
		const fleet = await asService(t).query(api.messages.searchMessagesByKeyword, {
			query: "probe",
		});
		expect(texts(fleet as Array<{ content: string }>)).toContain(TEXT.fleet);
	});
});

describe("A-18 dashboard:getDashboardSummary", () => {
	test("TAKEOVER + SHAPES: B's unread count and recent messages are its own row only", async () => {
		const { t } = await world();
		const s = await asB(t).query(api.dashboard.getDashboardSummary, {});
		expect(s.unreadMessages).toBe(1);
		const messages = s.recentActivity.filter((e) => e.type === "message");
		expect(messages.map((m) => m.excerpt)).toEqual([TEXT.b]);
	});

	test("PRESENT: A, renamed, sees its own unread row and message", async () => {
		const { t } = await world();
		const s = await asA(t).query(api.dashboard.getDashboardSummary, {});
		expect(s.unreadMessages).toBe(1);
		expect(
			s.recentActivity
				.filter((e) => e.type === "message")
				.map((m) => m.excerpt),
		).toEqual([TEXT.a]);
	});
});

describe("A-19 improvisationDigest:scanWindow", () => {
	async function digestWorld(): Promise<T> {
		const t = createT();
		await t.run(async (ctx) => {
			await seedTakeoverOrgs(ctx.db);
			const now = Date.now();
			const shapes: Array<[string, string | undefined, string | undefined]> = [
				["merged A-secret", SLUG, ORG_A],
				["merged B-own", SLUG, ORG_B],
				["merged absent-slug", SLUG, undefined],
				["merged fleet", undefined, undefined],
			];
			let i = 0;
			for (const [content, tenantId, tenantOrgId] of shapes) {
				await ctx.db.insert("messages", {
					from: "sigma",
					channel: "sigma",
					content,
					createdAt: now + i++,
					...(tenantId !== undefined ? { tenantId } : {}),
					...(tenantOrgId !== undefined ? { tenantOrgId } : {}),
				});
			}
		});
		return t;
	}
	const snippets = (r: { samples: Array<{ snippet: string }> }): string[] =>
		r.samples.map((s) => s.snippet).sort();

	test("TAKEOVER + SHAPES: B's digest holds B's message only; A, renamed, holds A's", async () => {
		const t = await digestWorld();
		expect(
			snippets(
				await asB(t).query(api.improvisationDigest.scanWindow, { windowDays: 1 }),
			),
		).toEqual(["merged B-own"]);
		expect(
			snippets(
				await asA(t).query(api.improvisationDigest.scanWindow, { windowDays: 1 }),
			),
		).toEqual(["merged A-secret"]);
	});
});
