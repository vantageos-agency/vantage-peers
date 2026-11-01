/// <reference types="vite/client" />
// allow-missing-refs: new test file created by the specialist
/**
 * The messages inbox doors after an org-slug takeover (task
 * k1783fk8r6p795x9fxrzyt9evd8hcxm7, PR (2b), sweep sites A-8 listMyInbox,
 * A-9 markAsRead / deleteMessage, A-11 getUnreadCount, A-17 inboxReader through
 * checkNewMessages and checkNewMessagesEnvelope).
 *
 * Modelling: org A (id X) held SLUG and was renamed; org B (id Y) now holds SLUG.
 * A's receipts and messages carry tenantId SLUG and tenantOrgId X. Row shapes of
 * Pi's ruling 2 are seeded beside them: (a) unstamped, (b) tenantId without
 * tenantOrgId, (c) stamped.
 */

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import {
	memberA,
	memberB,
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

async function world(
	opts: { recipient?: string } = {},
): Promise<{ t: T; ids: Seeded }> {
	const t = createT();
	const ids = await t.run(async (ctx) => {
		await seedTakeoverOrgs(ctx.db);
		return await seedShapes(ctx.db, opts);
	});
	return { t, ids };
}

const asA = (t: T, subject?: string) =>
	t.withIdentity(memberA(subject) as Identity);
const asB = (t: T, subject?: string) =>
	t.withIdentity(memberB(subject) as Identity);
const asService = (t: T) => t.withIdentity({ subject: SERVICE });
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

describe("A-17 inboxReader through checkNewMessages and checkNewMessagesEnvelope", () => {
	const bodies = (rows: Array<{ content: string }>): string[] =>
		rows.map((r) => r.content).sort();

	test("TAKEOVER: B's member reader and B's claimed seat read B's receipt only", async () => {
		const { t } = await world();
		expect(
			bodies(await asB(t).query(api.messages.checkNewMessages, { recipient: "sigma" })),
		).toEqual([TEXT.b]);
		expect(
			bodies(
				await asService(t).query(api.messages.checkNewMessages, {
					recipient: "sigma",
					...viaBClaim,
				}),
			),
		).toEqual([TEXT.b]);
		const env = await asB(t).query(api.messages.checkNewMessagesEnvelope, {
			recipient: "sigma",
		});
		expect(bodies(env.messages)).toEqual([TEXT.b]);
	});

	test("PRESENT: A, renamed, reads A's receipt", async () => {
		const { t } = await world();
		expect(
			bodies(await asA(t).query(api.messages.checkNewMessages, { recipient: "sigma" })),
		).toEqual([TEXT.a]);
	});

	test("SHAPES: the fleet reader sees the unstamped receipt only, never a stamped or id-less one", async () => {
		const { t } = await world();
		expect(
			bodies(
				await asService(t).query(api.messages.checkNewMessages, {
					recipient: "sigma",
				}),
			),
		).toEqual([TEXT.fleet]);
	});
});

describe("A-11 messages:getUnreadCount", () => {
	test("TAKEOVER: B's member count, B's claimed seat and A's renamed member each count their own receipt", async () => {
		const { t } = await world();
		expect(
			await asB(t).query(api.messages.getUnreadCount, { orchestratorId: "sigma" }),
		).toBe(1);
		expect(
			await asService(t).query(api.messages.getUnreadCount, {
				orchestratorId: "sigma",
				...viaBClaim,
			}),
		).toBe(1);
		expect(
			await asA(t).query(api.messages.getUnreadCount, { orchestratorId: "sigma" }),
		).toBe(1);
	});

	test("SHAPES: the fleet reader counts the unstamped receipt only", async () => {
		const { t } = await world();
		expect(
			await asService(t).query(api.messages.getUnreadCount, {
				orchestratorId: "sigma",
			}),
		).toBe(1);
	});
});

describe("A-8 messages:listMyInbox", () => {
	test("TAKEOVER + SHAPES: the same person subject in B reads B's receipt only; in renamed A, A's", async () => {
		const { t } = await world({ recipient: "user:user-p" });
		const b = await asB(t, "user-p").query(api.messages.listMyInbox, {});
		const a = await asA(t, "user-p").query(api.messages.listMyInbox, {});
		expect("items" in b ? b.items.map((i) => i.content).sort() : []).toEqual([
			TEXT.b,
		]);
		expect("items" in a ? a.items.map((i) => i.content).sort() : []).toEqual([
			TEXT.a,
		]);
	});
});

describe("A-9 messages:markAsRead", () => {
	test("TAKEOVER + SHAPES: B marks nothing of A's, of the id-less row or of the unstamped row; marks its own", async () => {
		for (const key of ["a", "absent", "fleet"] as const) {
			const { t, ids } = await world();
			expect(
				await denied(
					asB(t).mutation(api.messages.markAsRead, {
						receiptIds: [ids.receipts[key]],
						callerOrchestrator: "sigma",
					}),
				),
			).toBe(true);
			const row = await t.run(async (ctx) => ctx.db.get(ids.receipts[key]));
			expect(row?.readAt).toBeUndefined();
		}
		const { t, ids } = await world();
		expect(
			await asB(t).mutation(api.messages.markAsRead, {
				receiptIds: [ids.receipts.b],
				callerOrchestrator: "sigma",
			}),
		).toBe(1);
	});

	test("PRESENT: A, renamed, marks its own receipt", async () => {
		const { t, ids } = await world();
		expect(
			await asA(t).mutation(api.messages.markAsRead, {
				receiptIds: [ids.receipts.a],
				callerOrchestrator: "sigma",
			}),
		).toBe(1);
	});

	test("SHAPES: the claimless fleet account marks the unstamped receipt and is refused a client-stamped or id-less one", async () => {
		const { t, ids } = await world();
		expect(
			await asService(t).mutation(api.messages.markAsRead, {
				receiptIds: [ids.receipts.fleet],
			}),
		).toBe(1);
		for (const key of ["a", "absent"] as const) {
			expect(
				await denied(
					asService(t).mutation(api.messages.markAsRead, {
						receiptIds: [ids.receipts[key]],
					}),
				),
			).toBe(true);
		}
	});
});

describe("A-9 messages:deleteMessage", () => {
	test("TAKEOVER + SHAPES: B (as admin, and as the named sender) deletes none of A's, the id-less or the unstamped message", async () => {
		for (const caller of [undefined, "sigma"] as const) {
			for (const key of ["a", "absent", "fleet"] as const) {
				const { t, ids } = await world();
				expect(
					await denied(
						asB(t).mutation(api.messages.deleteMessage, {
							messageId: ids.messages[key],
							...(caller !== undefined ? { callerOrchestrator: caller } : {}),
						}),
					),
				).toBe(true);
				expect(await t.run(async (ctx) => ctx.db.get(ids.messages[key]))).not.toBeNull();
			}
		}
	});

	test("PRESENT: B deletes its own message (both paths); A, renamed, deletes its own", async () => {
		for (const caller of [undefined, "sigma"] as const) {
			const { t, ids } = await world();
			const r = await asB(t).mutation(api.messages.deleteMessage, {
				messageId: ids.messages.b,
				...(caller !== undefined ? { callerOrchestrator: caller } : {}),
			});
			expect(r.deleted).toBe(true);
		}
		const { t, ids } = await world();
		const r = await asA(t).mutation(api.messages.deleteMessage, {
			messageId: ids.messages.a,
			callerOrchestrator: "sigma",
		});
		expect(r.deleted).toBe(true);
	});
});
