/// <reference types="vite/client" />
/**
 * convex/__tests__/inboxSenderId.test.ts
 *
 * VantagePeers Cloud (task k17bxcx1wz2c7sn86k25nx3j718ggf9f). A message sent with
 * `verifiedActor` is STORED with `fromId` = the sender's agent _id, and each inbox
 * return validator already declares `fromId: v.optional(v.string())`, but the three
 * receipt -> row projections (checkNewMessages, checkNewMessagesEnvelope,
 * listMyInbox) dropped it, so the recipient saw the sender by label only.
 *
 * Poles (per door):
 *   PRESENT  agent A sends to agent B by verifiedActor; B's inbox item carries
 *            fromId === A's _id;
 *   ABSENT   a legacy message with no fromId yields an item WITHOUT a fromId key.
 */

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
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

const ORG = "acme-hr";
const NOW = 1_700_000_000_000;
const SERVICE = "test-service-account-user-id";
const PERSON = "user_portal1";
const PERSON_ACTOR = `user:${PERSON}`;

async function seedWorld() {
	const t = createT();
	const ids = await t.run(async (ctx) => {
		const row = await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: ORG,
			clerkOrgId: testClerkOrgId(ORG),
			allowedOrchestrators: ["clio", "helios"],
			scopes: ["view-own-tasks"],
			displayName: ORG,
			isActive: true,
			createdAt: NOW,
		});
		const agent = (name: string) =>
			ctx.db.insert("agents", {
				orgSlug: ORG,
				clerkOrgId: testClerkOrgId(ORG),
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: NOW,
			});
		const a = await agent("clio");
		const b = await agent("helios");
		await ctx.db.patch(row, { allowedAgentIds: [a, b] });
		return { a, b };
	});
	return { t, ...ids };
}

const asService = (t: T) => t.withIdentity({ subject: SERVICE } as Identity);

/** Legacy row: no fromId on the message, stamped receipt for `recipientId`. */
async function seedLegacy(
	t: T,
	o: { recipient: string; recipientId?: Id<"agents"> },
) {
	await t.run(async (ctx) => {
		const messageId = await ctx.db.insert("messages", {
			from: "legacy-sender",
			channel: o.recipient,
			content: "LEGACY",
			tenantId: ORG,
			tenantOrgId: testClerkOrgId(ORG),
			createdAt: NOW,
		});
		await ctx.db.insert("messageReceipts", {
			messageId,
			recipient: o.recipient,
			...(o.recipientId !== undefined ? { recipientId: o.recipientId } : {}),
			tenantId: ORG,
			tenantOrgId: testClerkOrgId(ORG),
			readAt: undefined,
		});
	});
}

type Item = { content: string; fromId?: string };
type Door = (t: T, reader: Id<"agents">) => Promise<Item[]>;

const readerArgs = (reader: Id<"agents">) => ({
	verifiedActor: { agentId: reader, orgSlug: ORG },
});

const DOORS: Array<[string, Door]> = [
	[
		"checkNewMessages",
		(t, reader) =>
			asService(t).query(
				api.messages.checkNewMessages,
				readerArgs(reader) as never,
			),
	],
	[
		"checkNewMessagesEnvelope",
		async (t, reader) =>
			(
				await asService(t).query(
					api.messages.checkNewMessagesEnvelope,
					readerArgs(reader) as never,
				)
			).messages,
	],
];

describe.each(DOORS)("%s", (_name, door) => {
	test("PRESENT: a verifiedActor send by A reaches B carrying fromId === A", async () => {
		const { t, a, b } = await seedWorld();
		await asService(t).mutation(api.messages.sendMessage, {
			from: "clio",
			content: "BY-A",
			recipientAgentIds: [b],
			verifiedActor: { agentId: a, orgSlug: ORG },
		} as never);
		const items = await door(t, b);
		expect(items.map((i) => i.content)).toEqual(["BY-A"]);
		expect(items[0].fromId).toBe(a);
	});

	test("ABSENT: a legacy message without fromId yields an item without a fromId key", async () => {
		const { t, b } = await seedWorld();
		await seedLegacy(t, { recipient: "helios", recipientId: b });
		const items = await door(t, b);
		expect(items.map((i) => i.content)).toEqual(["LEGACY"]);
		expect("fromId" in items[0]).toBe(false);
	});
});

describe("checkNewMessagesEnvelope byte budget", () => {
	test("fromId is inside the projected item, so the byte budget counts it", async () => {
		const { t, a, b } = await seedWorld();
		await asService(t).mutation(api.messages.sendMessage, {
			from: "clio",
			content: "x",
			recipientAgentIds: [b],
			verifiedActor: { agentId: a, orgSlug: ORG },
		} as never);
		const env = await asService(t).query(
			api.messages.checkNewMessagesEnvelope,
			readerArgs(b) as never,
		);
		const bytes = JSON.stringify(env.messages[0]).length;
		expect(JSON.stringify(env.messages[0])).toContain(`"fromId":"${a}"`);
		expect(bytes).toBeGreaterThan(0);
	});
});

describe("listMyInbox", () => {
	async function personWorld(withFromId: boolean) {
		const { t, a } = await seedWorld();
		await t.run(async (ctx) => {
			await ctx.db.insert("memberWriterRoles", {
				roles: ["org:admin", "org:editor"],
				updatedAt: NOW,
			});
			const messageId = await ctx.db.insert("messages", {
				from: "clio",
				...(withFromId ? { fromId: a } : {}),
				channel: PERSON_ACTOR,
				content: "TO-PERSON",
				tenantId: ORG,
				tenantOrgId: testClerkOrgId(ORG),
				createdAt: NOW,
			});
			await ctx.db.insert("messageReceipts", {
				messageId,
				recipient: PERSON_ACTOR,
				tenantId: ORG,
				tenantOrgId: testClerkOrgId(ORG),
				readAt: undefined,
			});
		});
		const person = t.withIdentity({
			subject: PERSON,
			org_slug: ORG,
			org_id: testClerkOrgId(ORG),
			org_role: "org:editor",
		} as Identity);
		return { person, a };
	}

	test("PRESENT: the item carries the sender's agent _id", async () => {
		const { person, a } = await personWorld(true);
		const r = await person.query(api.messages.listMyInbox, {});
		expect(r.refused).toBeUndefined();
		expect(r.items.map((i) => i.content)).toEqual(["TO-PERSON"]);
		expect(r.items[0].fromId).toBe(a);
	});

	test("ABSENT: a message without fromId yields an item without a fromId key", async () => {
		const { person } = await personWorld(false);
		const r = await person.query(api.messages.listMyInbox, {});
		expect(r.items).toHaveLength(1);
		expect("fromId" in r.items[0]).toBe(false);
	});
});
