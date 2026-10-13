/// <reference types="vite/client" />
/**
 * convex/__tests__/messagesBatchA.test.ts
 *
 * Batch A (messaging), identity-by-ID plan modules M5 and M6, backend-doctor 0.4.4
 * (R-53, R-54, R-55 and CR-2 on convex/messages.ts and convex/lib/inboxReader.ts).
 *
 * What changed, and the pole that pins it. Every door is read at the three poles
 * (REFUSED / ABSENT / PRESENT) and across two organisations.
 *
 *  R-55  A history read narrows by every predicate BEFORE it bounds the window.
 *        - listMessages: the `createdBefore` cursor and the sender sit in the query
 *          builder. The old shape read a 2001-row window and cut it afterwards, so a
 *          cursor deeper than 2001 rows returned NOTHING while rows existed.
 *        - listByChannel / listByChannelPaginated: the caller's channel scope sits in
 *          the query builder. The old shape cut the newest `take` rows of the tenant
 *          and dropped the off-scope ones afterwards, so a page could be empty while
 *          older readable rows existed.
 *  R-53  An organisation is decided by its stored ID: a message or receipt stamped
 *        with the caller's slug but ANOTHER organisation's permanent ID is not the
 *        caller's row (markAsRead tenant gate, the person-recipient proof).
 *  R-54  listMyInbox refuses the fleet service account that presents no person.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const SERVICE = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
const ALPHA = "batcha-alpha";
const BRAVO = "batcha-bravo";
const EMPTY = "batcha-empty";

const asService = (t: T) => t.withIdentity({ subject: SERVICE });
const asMember = (t: T, org: string, subject = `member-${org}`) =>
	t.withIdentity({
		subject,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:editor",
	} as Identity);

async function expectCode(p: Promise<unknown>, code: string): Promise<string> {
	let caught: unknown;
	try {
		await p;
	} catch (err) {
		caught = err;
	}
	expect(caught, `expected a refusal carrying ${code}`).toBeDefined();
	const data = (caught as { data?: unknown }).data;
	const text = `${(caught as Error).message} ${typeof data === "string" ? data : JSON.stringify(data ?? "")}`;
	expect(text).toContain(code);
	return text;
}

async function seedOrgs(t: T) {
	await t.run(async (ctx) => {
		for (const slug of [ALPHA, BRAVO, EMPTY]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: ["phi", "neo"],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: 1,
				orgKind: "client",
			});
		}
		for (const role of ["phi", "neo"]) {
			await ctx.db.insert("profiles", {
				orchestratorId: role,
				name: role,
				static: { role, workspace: "w", capabilities: [] },
				dynamic: { lastSeen: 1, sessionCount: 0 },
			});
		}
	});
}

type RowSpec = {
	from: string;
	channel: string;
	tenant: string;
	createdAt: number;
};

async function insertRows(t: T, rows: RowSpec[]): Promise<Id<"messages">[]> {
	return await t.run(async (ctx) => {
		const ids: Id<"messages">[] = [];
		for (const r of rows) {
			ids.push(
				await ctx.db.insert("messages", {
					from: r.from,
					channel: r.channel,
					content: `${r.from}->${r.channel}@${r.createdAt}`,
					tenantId: r.tenant,
					tenantOrgId: testClerkOrgId(r.tenant),
					createdAt: r.createdAt,
				}),
			);
		}
		return ids;
	});
}

describe("R-55 listMessages: the cursor and the sender are cut BEFORE the window", () => {
	const DEEP = 2005; // deeper than the old 2001-row wide scan

	test("a member's cursor deeper than the old wide scan still finds the older rows", async () => {
		const t = createT();
		await seedOrgs(t);
		const old = await insertRows(
			t,
			[1, 2, 3].map((n) => ({
				from: "phi",
				channel: "phi",
				tenant: ALPHA,
				createdAt: n,
			})),
		);
		const fresh = await insertRows(
			t,
			Array.from({ length: DEEP }, (_, i) => ({
				from: "phi",
				channel: "phi",
				tenant: ALPHA,
				createdAt: 100 + i,
			})),
		);
		// A row of another organisation among the old ones: never returned.
		await insertRows(t, [
			{ from: "phi", channel: "phi", tenant: BRAVO, createdAt: 2 },
		]);
		const anchor = (await t.run(async (ctx) => ctx.db.get(fresh[0])))
			?._creationTime as number;

		const page = await asMember(t, ALPHA).query(api.messages.listMessages, {
			limit: 3,
			createdBefore: anchor,
		});
		expect(page.map((r) => r._id)).toEqual([...old].reverse());
		expect(page.every((r) => r.tenantId === ALPHA)).toBe(true);
	});

	test("the sender filter and the cursor together, for a member", async () => {
		const t = createT();
		await seedOrgs(t);
		const mine = await insertRows(t, [
			{ from: "phi", channel: "phi", tenant: ALPHA, createdAt: 1 },
			{ from: "other", channel: "phi", tenant: ALPHA, createdAt: 2 },
			{ from: "phi", channel: "phi", tenant: ALPHA, createdAt: 3 },
		]);
		const later = await insertRows(
			t,
			Array.from({ length: DEEP }, (_, i) => ({
				from: "phi",
				channel: "phi",
				tenant: ALPHA,
				createdAt: 100 + i,
			})),
		);
		const anchor = (await t.run(async (ctx) => ctx.db.get(later[0])))
			?._creationTime as number;
		const page = await asMember(t, ALPHA).query(api.messages.listMessages, {
			limit: 5,
			from: "phi",
			createdBefore: anchor,
		});
		expect(page.map((r) => r._id)).toEqual([mine[2], mine[0]]);
	});

	test("the fleet master's cursor read (all tenants) is cut before the window too", async () => {
		const t = createT();
		await seedOrgs(t);
		const old = await insertRows(
			t,
			[1, 2, 3].map((n) => ({
				from: "sigma",
				channel: "pi",
				tenant: ALPHA,
				createdAt: n,
			})),
		);
		const fresh = await insertRows(
			t,
			Array.from({ length: DEEP }, (_, i) => ({
				from: "sigma",
				channel: "pi",
				tenant: BRAVO,
				createdAt: 100 + i,
			})),
		);
		const anchor = (await t.run(async (ctx) => ctx.db.get(fresh[0])))
			?._creationTime as number;
		const all = await asService(t).query(api.messages.listMessages, {
			limit: 3,
			createdBefore: anchor,
		});
		expect(all.map((r) => r._id)).toEqual([...old].reverse());
		const bySender = await asService(t).query(api.messages.listMessages, {
			limit: 3,
			from: "sigma",
			createdBefore: anchor,
		});
		expect(bySender.map((r) => r._id)).toEqual([...old].reverse());
	});

	test("ABSENT: an organisation with no rows reads an empty success; PRESENT without a cursor: the newest rows", async () => {
		const t = createT();
		await seedOrgs(t);
		const rows = await insertRows(
			t,
			[1, 2, 3, 4].map((n) => ({
				from: "phi",
				channel: "phi",
				tenant: ALPHA,
				createdAt: n,
			})),
		);
		expect(await asMember(t, EMPTY).query(api.messages.listMessages, {})).toEqual(
			[],
		);
		const newest = await asMember(t, ALPHA).query(api.messages.listMessages, {
			limit: 2,
		});
		expect(newest.map((r) => r._id)).toEqual([rows[3], rows[2]]);
	});
});

describe("R-55 listByChannel and listByChannelPaginated: the channel scope is cut BEFORE the window", () => {
	async function seedChannels(t: T) {
		await seedOrgs(t);
		const readable = await insertRows(
			t,
			[1, 2, 3].map((n) => ({
				from: "phi",
				channel: "phi",
				tenant: ALPHA,
				createdAt: n,
			})),
		);
		// Newer, but on a channel ALPHA's roster does not hold: they crowd the
		// newest window and used to leave the page empty.
		await insertRows(
			t,
			[4, 5, 6, 7, 8].map((n) => ({
				from: "phi",
				channel: "stranger",
				tenant: ALPHA,
				createdAt: n,
			})),
		);
		await insertRows(t, [
			{ from: "phi", channel: "phi", tenant: BRAVO, createdAt: 9 },
		]);
		return readable;
	}

	test("listByChannel: the newest `limit` READABLE rows, not the readable part of the newest `limit`", async () => {
		const t = createT();
		const readable = await seedChannels(t);
		const rows = await asMember(t, ALPHA).query(api.messages.listByChannel, {
			limit: 3,
		});
		const list = Array.isArray(rows) ? rows : rows.items;
		expect(list.map((r) => r._id)).toEqual([...readable].reverse());
	});

	test("listByChannel: a channel the roster does not hold is an empty success; its own channel is served", async () => {
		const t = createT();
		const readable = await seedChannels(t);
		const off = await asMember(t, ALPHA).query(api.messages.listByChannel, {
			channel: "stranger",
		});
		expect(off).toEqual([]);
		const own = await asMember(t, ALPHA).query(api.messages.listByChannel, {
			channel: "phi",
		});
		expect((own as { _id: Id<"messages"> }[]).map((r) => r._id)).toEqual(
			[...readable].reverse(),
		);
	});

	test("listByChannel: broadcast and the org's own team/<slug> prefix are readable, another org's team prefix is not", async () => {
		const t = createT();
		await seedOrgs(t);
		const ids = await insertRows(t, [
			{ from: "phi", channel: "broadcast", tenant: ALPHA, createdAt: 1 },
			{ from: "phi", channel: `team/${ALPHA}`, tenant: ALPHA, createdAt: 2 },
			{ from: "phi", channel: `team/${ALPHA}/ops`, tenant: ALPHA, createdAt: 3 },
			{ from: "phi", channel: `team/${BRAVO}`, tenant: ALPHA, createdAt: 4 },
			{ from: "phi", channel: "team/", tenant: ALPHA, createdAt: 5 },
			{ from: "phi", channel: "stranger", tenant: ALPHA, createdAt: 6 },
		]);
		const rows = await asMember(t, ALPHA).query(api.messages.listByChannel, {});
		const list = (Array.isArray(rows) ? rows : rows.items) as {
			_id: Id<"messages">;
		}[];
		expect(list.map((r) => r._id)).toEqual([ids[2], ids[1], ids[0]]);
		const page = await asMember(t, ALPHA).query(
			api.messages.listByChannelPaginated,
			{ paginationOpts: { numItems: 10, cursor: null } },
		);
		expect(page.page.map((r) => r._id)).toEqual([ids[2], ids[1], ids[0]]);
	});

	test("listByChannel: another organisation's rows are never served (cross-org deny)", async () => {
		const t = createT();
		await seedChannels(t);
		const rows = await asMember(t, BRAVO).query(api.messages.listByChannel, {});
		const list = (Array.isArray(rows) ? rows : rows.items) as {
			tenantId?: string;
		}[];
		expect(list.length).toBe(1);
		expect(list.every((r) => r.tenantId === BRAVO)).toBe(true);
	});

	test("listByChannelPaginated: a page is `numItems` readable rows", async () => {
		const t = createT();
		const readable = await seedChannels(t);
		const page = await asMember(t, ALPHA).query(
			api.messages.listByChannelPaginated,
			{ paginationOpts: { numItems: 3, cursor: null } },
		);
		expect(page.page.map((r) => r._id)).toEqual([...readable].reverse());
	});

	test("listByChannelPaginated: the sender narrows the page before it is cut", async () => {
		const t = createT();
		await seedOrgs(t);
		const ids = await insertRows(t, [
			{ from: "phi", channel: "phi", tenant: ALPHA, createdAt: 1 },
			{ from: "x", channel: "phi", tenant: ALPHA, createdAt: 2 },
			{ from: "x", channel: "phi", tenant: ALPHA, createdAt: 3 },
			{ from: "x", channel: "phi", tenant: ALPHA, createdAt: 4 },
		]);
		const page = await asMember(t, ALPHA).query(
			api.messages.listByChannelPaginated,
			{ paginationOpts: { numItems: 2, cursor: null }, from: "phi" },
		);
		expect(page.page.map((r) => r._id)).toEqual([ids[0]]);
		const master = await asService(t).query(
			api.messages.listByChannelPaginated,
			{
				paginationOpts: { numItems: 2, cursor: null },
				channel: "phi",
				from: "phi",
			},
		);
		expect(master.page.map((r) => r._id)).toEqual([ids[0]]);
	});

	test("listByChannelPaginated: an out-of-scope channel is an empty page for a member; the master reads it", async () => {
		const t = createT();
		await seedChannels(t);
		const member = await asMember(t, ALPHA).query(
			api.messages.listByChannelPaginated,
			{ paginationOpts: { numItems: 10, cursor: null }, channel: "stranger" },
		);
		expect(member.page).toEqual([]);
		const master = await asService(t).query(
			api.messages.listByChannelPaginated,
			{ paginationOpts: { numItems: 10, cursor: null }, channel: "stranger" },
		);
		expect(master.page).toHaveLength(5);
	});
});

describe("R-53 an organisation is its stored ID, not the slug a row carries", () => {
	test("markAsRead: a receipt stamped with the caller's slug and ANOTHER org's ID is not the caller's", async () => {
		const t = createT();
		await seedOrgs(t);
		const { foreign, own } = await t.run(async (ctx) => {
			const message = await ctx.db.insert("messages", {
				from: "x",
				channel: "phi",
				content: "c",
				tenantId: ALPHA,
				tenantOrgId: testClerkOrgId(ALPHA),
				createdAt: 1,
			});
			const foreign = await ctx.db.insert("messageReceipts", {
				messageId: message,
				recipient: "phi",
				tenantId: ALPHA,
				tenantOrgId: testClerkOrgId(BRAVO),
				readAt: undefined,
			});
			const own = await ctx.db.insert("messageReceipts", {
				messageId: message,
				recipient: "phi",
				tenantId: ALPHA,
				tenantOrgId: testClerkOrgId(ALPHA),
				readAt: undefined,
			});
			return { foreign, own };
		});
		await expectCode(
			asMember(t, ALPHA).mutation(api.messages.markAsRead, {
				receiptIds: [foreign],
			}),
			"RBAC_DENIED",
		);
		expect(
			(await t.run(async (ctx) => ctx.db.get(foreign)))?.readAt,
		).toBeUndefined();
		const count = await asMember(t, ALPHA).mutation(api.messages.markAsRead, {
			receiptIds: [own],
		});
		expect(count).toBe(1);
	});

	const PERSON = "user:person-batcha";
	async function personWrote(t: T, tenantOrgId: string) {
		await t.run(async (ctx) => {
			await ctx.db.insert("messages", {
				from: PERSON,
				fromId: PERSON,
				channel: "phi",
				content: "hello",
				tenantId: ALPHA,
				tenantOrgId,
				createdAt: 1,
			});
		});
	}
	const reply = (t: T) =>
		asService(t).mutation(api.messages.sendMessage, {
			from: "phi",
			channel: PERSON,
			content: "answer",
			seatOrgSlug: ALPHA,
		});

	test("a person who wrote under the sender's slug but another org's ID is not a person of the sender's org", async () => {
		const t = createT();
		await seedOrgs(t);
		await personWrote(t, testClerkOrgId(BRAVO));
		await expectCode(reply(t), "person-recipient-not-in-org");
	});

	test("PRESENT: a person who wrote in the sender's own org (slug and ID) is answered", async () => {
		const t = createT();
		await seedOrgs(t);
		await personWrote(t, testClerkOrgId(ALPHA));
		const id = await reply(t);
		expect(id).toBeDefined();
	});

	test("ABSENT: a person nobody has heard from is refused with the same code", async () => {
		const t = createT();
		await seedOrgs(t);
		await expectCode(reply(t), "person-recipient-not-in-org");
	});
});

describe("R-54 listMyInbox: the fleet service account that presents no person is refused", () => {
	test("REFUSED: raised with RBAC_DENIED and the door, never an empty success", async () => {
		const t = createT();
		await seedOrgs(t);
		const text = await expectCode(
			asService(t).query(api.messages.listMyInbox, {}),
			"RBAC_DENIED",
		);
		expect(text).toContain("messages:listMyInbox");
		expect(text).toContain("not-a-person");
	});

	test("ABSENT: a member with no mail reads an empty success (no refused key)", async () => {
		const t = createT();
		await seedOrgs(t);
		const r = await asMember(t, ALPHA, "someone").query(
			api.messages.listMyInbox,
			{},
		);
		expect(r).toEqual({ items: [] });
	});

	test("PRESENT: a member reads the mail addressed to it, in its own org only", async () => {
		const t = createT();
		await seedOrgs(t);
		await t.run(async (ctx) => {
			const mail = async (tenant: string) => {
				const messageId = await ctx.db.insert("messages", {
					from: "phi",
					channel: "user:someone",
					content: `to someone in ${tenant}`,
					tenantId: tenant,
					tenantOrgId: testClerkOrgId(tenant),
					createdAt: 1,
				});
				await ctx.db.insert("messageReceipts", {
					messageId,
					recipient: "user:someone",
					tenantId: tenant,
					tenantOrgId: testClerkOrgId(tenant),
					readAt: undefined,
				});
			};
			await mail(ALPHA);
			await mail(BRAVO);
		});
		const r = await asMember(t, ALPHA, "someone").query(
			api.messages.listMyInbox,
			{},
		);
		expect(r.items).toHaveLength(1);
		expect(r.items[0].content).toBe(`to someone in ${ALPHA}`);
	});
});

describe("R-53 the seat's verified org and a declared tenant are one organisation row", () => {
	test("REFUSED: a tenantId naming another organisation than the seat's", async () => {
		const t = createT();
		await seedOrgs(t);
		await expectCode(
			asService(t).mutation(api.messages.sendMessage, {
				from: "phi",
				channel: "phi",
				content: "x",
				seatOrgSlug: ALPHA,
				tenantId: BRAVO,
			}),
			"seat-org-tenant-mismatch",
		);
	});

	test("PRESENT: the seat's own org as tenantId stamps the message in that org", async () => {
		const t = createT();
		await seedOrgs(t);
		const id = await asService(t).mutation(api.messages.sendMessage, {
			from: "phi",
			channel: "neo",
			content: "x",
			seatOrgSlug: ALPHA,
			tenantId: ALPHA,
		});
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.tenantId).toBe(ALPHA);
		expect(row?.tenantOrgId).toBe(testClerkOrgId(ALPHA));
	});

	test("REFUSED: a seat org that names no organisation, and an empty tenantId", async () => {
		const t = createT();
		await seedOrgs(t);
		await expectCode(
			asService(t).mutation(api.messages.sendMessage, {
				from: "phi",
				channel: "phi",
				content: "x",
				seatOrgSlug: "no-such-org",
			}),
			"seat-org-not-active",
		);
		await expectCode(
			asService(t).mutation(api.messages.sendMessage, {
				from: "phi",
				channel: "phi",
				content: "x",
				seatOrgSlug: ALPHA,
				tenantId: "",
			}),
			"seat-org-tenant-mismatch",
		);
	});
});
