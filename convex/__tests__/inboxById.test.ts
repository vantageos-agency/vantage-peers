/// <reference types="vite/client" />
/**
 * convex/__tests__/inboxById.test.ts   // allow-missing-refs: new file this agent creates
 *
 * VantagePeers Cloud, module M6 (task k179c26y9h456h8s5e85a1swrd8fy33v).
 * The inbox reader keys an agent on `recipientId` only. The name fallback is
 * gone: a receipt addressed by NAME (no `recipientId`) is delivered to nobody,
 * because a name is shared by same-named agents of different organisations, and
 * it is REPORTED (receiptRecipientIdAudit) until backfill_actor_ids stamps it.
 *
 * FAILS ON MAIN (8e57a83): there, the verified agent of the receipt's tenant is
 * served a by-name receipt (`normalizeOrchestratorId(receipt.recipient) ===
 * label`), so "REFUSED" below returns the by-name receipt. It passes after M6.
 *
 * World: operator org vantage-fleet (agent pi), client orgs org-a and org-b,
 * each with an agent called "hélios" (the same name in two organisations; the
 * name sits in both rosters, so a by-name receipt cannot say whose it is).
 *
 * Poles:
 *   PRESENT  an agent reads, counts and marks its own receipts by ID;
 *   REFUSED  the same-named agent of another org gets nothing of it; a receipt
 *            without recipientId is delivered to nobody, in either org;
 *   REPORTED a receipt without recipientId is listed by the audit page (an
 *            empty list is a real empty SUCCESS when every receipt has an ID);
 *   STEP 1   after backfill_actor_ids stamps the IDs, the same receipts are
 *            delivered, by ID, to the right agent of the right org.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const FLEET = "vantage-fleet";
const ORG_A = "org-a";
const ORG_B = "org-b";
const NOW = 1_700_000_000_000;

const asServiceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

type World = {
	t: T;
	agentA: Id<"agents">;
	agentB: Id<"agents">;
	pi: Id<"agents">;
	receipt: Record<string, Id<"messageReceipts">>;
};

async function seedWorld(opts: { withNameOnly: boolean }): Promise<World> {
	const t = createT();
	const world = await t.run(async (ctx) => {
		const mapping = (slug: string, names: string[], operator: boolean) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: names,
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...(operator ? { orgKind: "operator" as const } : {}),
			});
		await mapping(FLEET, ["pi"], true);
		await mapping(ORG_A, ["hélios"], false);
		await mapping(ORG_B, ["hélios"], false);
		const agent = (orgSlug: string, name: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId: testClerkOrgId(orgSlug),
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: NOW,
			});
		const pi = await agent(FLEET, "pi");
		const agentA = await agent(ORG_A, "hélios");
		const agentB = await agent(ORG_B, "hélios");

		const receipt: Record<string, Id<"messageReceipts">> = {};
		const put = async (
			key: string,
			o: {
				recipient: string;
				recipientId?: string;
				tenantId?: string;
				readAt?: number;
			},
		) => {
			const messageId = await ctx.db.insert("messages", {
				from: "omega",
				channel: o.recipient,
				content: key,
				tenantId: o.tenantId,
				tenantOrgId: testClerkOrgId(o.tenantId),
				createdAt: NOW,
			});
			receipt[key] = await ctx.db.insert("messageReceipts", {
				messageId,
				recipient: o.recipient,
				...(o.recipientId !== undefined ? { recipientId: o.recipientId } : {}),
				tenantId: o.tenantId,
				tenantOrgId: testClerkOrgId(o.tenantId),
				readAt: o.readAt,
			});
		};
		await put("A-BY-ID", { recipient: "hélios", recipientId: agentA, tenantId: ORG_A });
		await put("B-BY-ID", { recipient: "hélios", recipientId: agentB, tenantId: ORG_B });
		await put("PI-BY-ID", { recipient: "pi", recipientId: pi, tenantId: FLEET });
		if (opts.withNameOnly) {
			// Addressed by NAME only. "hélios" is in both rosters: nobody can say
			// whose these are without the ID.
			await put("A-NAME", { recipient: "hélios", tenantId: ORG_A });
			await put("B-NAME", { recipient: "hélios", tenantId: ORG_B });
			await put("PI-NAME", { recipient: "pi" }); // unstamped legacy fleet row
			// Read already: not unread, so not reported and not delivered.
			await put("B-NAME-READ", {
				recipient: "hélios",
				tenantId: ORG_B,
				readAt: NOW,
			});
		}
		return { agentA, agentB, pi, receipt };
	});
	return { t, ...world };
}

const actor = (agentId: Id<"agents">, orgSlug: string) => ({
	verifiedActor: { agentId, orgSlug },
});

const envelopeOf = async (t: T, args: Record<string, unknown>) =>
	(
		await asServiceAccount(t).query(
			api.messages.checkNewMessagesEnvelope,
			args as never,
		)
	).messages
		.map((m) => m.content)
		.sort();

const checkOf = async (t: T, args: Record<string, unknown>) =>
	(
		await asServiceAccount(t).query(api.messages.checkNewMessages, args as never)
	)
		.map((m) => m.content)
		.sort();

const DOORS: Array<
	[string, (t: T, a: Record<string, unknown>) => Promise<string[]>]
> = [
	["checkNewMessages", checkOf],
	["checkNewMessagesEnvelope", envelopeOf],
];

describe("PRESENT: an agent reads its own receipts by ID", () => {
	describe.each(DOORS)("%s", (_name, read) => {
		test("org-a's hélios reads A-BY-ID; org-b's reads B-BY-ID; pi reads PI-BY-ID", async () => {
			const { t, agentA, agentB, pi } = await seedWorld({ withNameOnly: false });
			expect(await read(t, actor(agentA, ORG_A))).toEqual(["A-BY-ID"]);
			expect(await read(t, { recipient: "hélios", ...actor(agentB, ORG_B) })).toEqual([
				"B-BY-ID",
			]);
			expect(await read(t, actor(pi, FLEET))).toEqual(["PI-BY-ID"]);
		});
	});

	test("getUnreadCount and markAsRead agree with the read", async () => {
		const { t, agentA, receipt } = await seedWorld({ withNameOnly: false });
		const sa = asServiceAccount(t);
		expect(
			await sa.query(api.messages.getUnreadCount, actor(agentA, ORG_A) as never),
		).toBe(1);
		expect(
			await sa.mutation(api.messages.markAsRead, {
				receiptIds: [receipt["A-BY-ID"]],
				...actor(agentA, ORG_A),
			} as never),
		).toBe(1);
	});
});

describe("REFUSED: a name delivers nothing, and a namesake gets nothing", () => {
	describe.each(DOORS)("%s", (_name, read) => {
		test("a by-name receipt is delivered to nobody (fails on main: delivered to the tenant's same-named agent)", async () => {
			const { t, agentA, agentB, pi } = await seedWorld({ withNameOnly: true });
			expect(await read(t, actor(agentA, ORG_A))).toEqual(["A-BY-ID"]);
			expect(await read(t, actor(agentB, ORG_B))).toEqual(["B-BY-ID"]);
			expect(await read(t, actor(pi, FLEET))).toEqual(["PI-BY-ID"]);
		});

		test("org-b's hélios never reads org-a's, and org-a's never reads org-b's", async () => {
			const { t, agentA, agentB } = await seedWorld({ withNameOnly: true });
			const b = await read(t, { recipient: "hélios", ...actor(agentB, ORG_B) });
			const a = await read(t, { recipient: "hélios", ...actor(agentA, ORG_A) });
			expect(b.filter((c) => c.startsWith("A-"))).toEqual([]);
			expect(a.filter((c) => c.startsWith("B-"))).toEqual([]);
		});

		test("the org-level token (verifiedOrg) resolves hélios to the agent and reads by ID too", async () => {
			const { t } = await seedWorld({ withNameOnly: true });
			expect(
				await read(t, { recipient: "hélios", verifiedOrg: { orgSlug: ORG_A } }),
			).toEqual(["A-BY-ID"]);
		});
	});

	test("a by-name receipt is not counted and cannot be marked by the namesake's tenant agent", async () => {
		const { t, agentB, receipt } = await seedWorld({ withNameOnly: true });
		const sa = asServiceAccount(t);
		expect(
			await sa.query(api.messages.getUnreadCount, actor(agentB, ORG_B) as never),
		).toBe(1);
		await expect(
			sa.mutation(api.messages.markAsRead, {
				receiptIds: [receipt["B-NAME"]],
				...actor(agentB, ORG_B),
			} as never),
		).rejects.toThrow(/RBAC_DENIED.*receipt-not-yours.*messages:markAsRead/s);
		const readAt = await t.run(
			async (ctx) => (await ctx.db.get(receipt["B-NAME"]))?.readAt ?? null,
		);
		expect(readAt).toBeNull();
	});
});

describe("REPORTED: a receipt without recipientId is listed, never silently dropped", () => {
	const audit = async (t: T, cursor: string | null = null) =>
		await t.query(internal.receiptRecipientIdAudit.unaddressedUnreadPage, {
			cursor,
		});

	test("PRESENT: the unread by-name receipts are listed with tenant and name; ID-stamped and read ones are not", async () => {
		const { t, receipt } = await seedWorld({ withNameOnly: true });
		const page = await audit(t);
		expect(page.isDone).toBe(true);
		expect(page.unaddressedCount).toBe(3);
		expect(page.unaddressed.map((r) => r.receiptId).sort()).toEqual(
			[receipt["A-NAME"], receipt["B-NAME"], receipt["PI-NAME"]].sort(),
		);
		expect(
			page.unaddressed.find((r) => r.receiptId === receipt["PI-NAME"]),
		).toEqual({ receiptId: receipt["PI-NAME"], tenantId: null, recipient: "pi" });
	});

	test("ABSENT: when every receipt carries an ID the report is an empty SUCCESS", async () => {
		const { t } = await seedWorld({ withNameOnly: false });
		const page = await audit(t);
		expect(page).toMatchObject({
			unaddressedCount: 0,
			unaddressed: [],
			isDone: true,
			nextCursor: null,
		});
	});

	test("pageSize out of range is refused, not clamped", async () => {
		const { t } = await seedWorld({ withNameOnly: false });
		await expect(
			t.query(internal.receiptRecipientIdAudit.unaddressedUnreadPage, {
				pageSize: 0,
			}),
		).rejects.toThrow(/out of expected range/);
	});
});

describe("STEP 1 then STEP 2: after the backfill the same receipts are delivered, by ID", () => {
	test("backfill_actor_ids stamps recipientId in each receipt's own org; the report empties; each agent reads its own", async () => {
		const { t, agentA, agentB, pi } = await seedWorld({ withNameOnly: true });
		expect(await envelopeOf(t, actor(agentB, ORG_B))).toEqual(["B-BY-ID"]);

		let cursor: string | null = null;
		for (let i = 0; i < 10; i++) {
			const page: { isDone: boolean; nextCursor: string | null } =
				await t.mutation(internal.migrations.backfill_actor_ids.run, {
					table: "messageReceipts",
					dryRun: false,
					cursor,
				});
			if (page.isDone) break;
			cursor = page.nextCursor;
		}

		expect(
			(await t.query(internal.receiptRecipientIdAudit.unaddressedUnreadPage, {}))
				.unaddressedCount,
		).toBe(0);
		expect(await envelopeOf(t, actor(agentA, ORG_A))).toEqual(["A-BY-ID", "A-NAME"]);
		expect(await envelopeOf(t, actor(agentB, ORG_B))).toEqual(["B-BY-ID", "B-NAME"]);
		expect(await envelopeOf(t, actor(pi, FLEET))).toEqual(["PI-BY-ID", "PI-NAME"]);
	});
});
