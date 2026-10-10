/// <reference types="vite/client" />
/**
 * convex/__tests__/inboxOldMcpWire.test.ts
 *
 * VantagePeers Cloud. No-interruption contract for the inbox-by-agent-ID change
 * (task k17aypc5cr3edmvvbvwhb32evx8fz1x1, PRs #1491 Convex + #1492 MCP).
 *
 * The Convex doors and the MCP server deploy independently. Between the Convex
 * deploy and the MCP redeploy, the MCP that serves every seat is the OLD one
 * (main 71510d2). Its inbox tools send NO claim: every non-Clerk seat reaches
 * Convex as the fleet service account with only the wire arguments below,
 * copied from mcp-server/src/tools.ts at 71510d2:
 *
 *   check_messages  -> messages:checkNewMessagesEnvelope
 *                      { recipient, recipientInstanceId, tenantId, since, limit }
 *                      (tenantId is a free tool argument, never a verified org)
 *   mark_as_read    -> messages:markAsRead { receiptIds, callerOrchestrator }
 *   delete_message  -> messages:deleteMessage { messageId, callerOrchestrator }
 *   (the old MCP never calls messages:getUnreadCount; the dashboard does, with
 *    { orchestratorId })
 *
 * A Clerk-JWT seat reaches Convex with its OWN identity (member of its org).
 *
 * Every caller the old MCP serves today must still read, count and mark its own
 * inbox against the new doors. The claimless service account is therefore
 * served exactly as production 90cbb97 serves it (every tenant, exact name)
 * until the MCP that sends claims is live; the switch to the fleet tenant only
 * is the contract step, gated by UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT.
 *
 * The rows marked NEW WIRE drive the shape #1492 sends (verifiedActor /
 * verifiedOrg) against the same world: the same-named agent of another org reads
 * only its own, and cross-org stays refused.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import { UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT } from "../lib/inboxReader";
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
const PERSON = "user:user_person_a";
const NOW = 1_700_000_000_000;

const FLEET_WITH_AGENT_ROW = ["pi", "sigma", "eta", "argus"] as const;
const FLEET_WITHOUT_AGENT_ROW = "tau";

const asServiceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });
const asMember = (t: T, org: string, subject: string) =>
	t.withIdentity({
		subject,
		organizationSlug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:editor",
	} as Parameters<T["withIdentity"]>[0]);

type World = {
	t: T;
	agentA: Id<"agents">;
	agentB: Id<"agents">;
	fleetAgents: Record<string, Id<"agents">>;
	receipt: Record<string, Id<"messageReceipts">>;
	message: Record<string, Id<"messages">>;
};

async function seedWorld(): Promise<World> {
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
		await mapping(
			FLEET,
			[...FLEET_WITH_AGENT_ROW, FLEET_WITHOUT_AGENT_ROW],
			true,
		);
		await mapping(ORG_A, ["hélios", "nova"], false);
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
		const fleetAgents: Record<string, Id<"agents">> = {};
		for (const name of FLEET_WITH_AGENT_ROW) {
			fleetAgents[name] = await agent(FLEET, name);
		}
		const agentA = await agent(ORG_A, "hélios");
		const agentB = await agent(ORG_B, "hélios");

		const message: Record<string, Id<"messages">> = {};
		const receipt: Record<string, Id<"messageReceipts">> = {};
		const put = async (
			key: string,
			o: {
				from: string;
				recipient: string;
				recipientId?: string;
				tenantId?: string;
			},
		) => {
			message[key] = await ctx.db.insert("messages", {
				from: o.from,
				channel: o.recipient,
				content: key,
				tenantId: o.tenantId,
				tenantOrgId: testClerkOrgId(o.tenantId),
				createdAt: NOW,
			});
			receipt[key] = await ctx.db.insert("messageReceipts", {
				messageId: message[key],
				recipient: o.recipient,
				...(o.recipientId !== undefined ? { recipientId: o.recipientId } : {}),
				tenantId: o.tenantId,
				tenantOrgId: testClerkOrgId(o.tenantId),
				readAt: undefined,
			});
		};
		// Fleet stations: one unstamped legacy receipt each, and one stamped with
		// the operator tenant (with the agent ID where an agents row exists).
		for (const name of [...FLEET_WITH_AGENT_ROW, FLEET_WITHOUT_AGENT_ROW]) {
			await put(`${name}-UNSTAMPED`, { from: "omega", recipient: name });
			await put(`${name}-FLEET`, {
				from: "omega",
				recipient: name,
				tenantId: FLEET,
				...(fleetAgents[name] !== undefined
					? { recipientId: fleetAgents[name] }
					: {}),
			});
		}
		// org A's hélios and org B's hélios: one by ID, one legacy each.
		await put("A-BY-ID", {
			from: "nova",
			recipient: "hélios",
			recipientId: agentA,
			tenantId: ORG_A,
		});
		await put("A-LEGACY", {
			from: "nova",
			recipient: "hélios",
			tenantId: ORG_A,
		});
		await put("B-BY-ID", {
			from: "x",
			recipient: "hélios",
			recipientId: agentB,
			tenantId: ORG_B,
		});
		await put("B-LEGACY", { from: "x", recipient: "hélios", tenantId: ORG_B });
		// A person of org A (a reply addressed to it).
		await put("PERSON-A", {
			from: "hélios",
			recipient: PERSON,
			tenantId: ORG_A,
		});
		// A message org A's hélios SENT (delete_message is sender-keyed).
		message["A-SENT"] = await ctx.db.insert("messages", {
			from: "hélios",
			channel: "nova",
			content: "A-SENT",
			tenantId: ORG_A,
			tenantOrgId: testClerkOrgId(ORG_A),
			createdAt: NOW,
		});
		return { agentA, agentB, fleetAgents, receipt, message };
	});
	return { t, ...world };
}

// ── the old MCP's wire shapes (mcp-server/src/tools.ts at 71510d2) ──────────

type CheckToolArgs = {
	recipient: string;
	recipientInstanceId?: string;
	tenantId?: string;
	since?: number;
	limit?: number;
};

/** check_messages, old MCP: the tool's args forwarded verbatim, no claim. */
const oldCheckMessages = async (
	client: ReturnType<typeof asServiceAccount>,
	{ recipient, recipientInstanceId, tenantId, since, limit }: CheckToolArgs,
) =>
	(
		await client.query(api.messages.checkNewMessagesEnvelope, {
			recipient,
			recipientInstanceId,
			tenantId,
			since,
			limit,
		})
	).messages
		.map((m) => m.content)
		.sort();

/** mark_as_read, old MCP: { receiptIds, callerOrchestrator }, no claim. */
const oldMarkAsRead = (
	client: ReturnType<typeof asServiceAccount>,
	receiptIds: string[],
	callerOrchestrator?: string,
) =>
	client.mutation(api.messages.markAsRead, { receiptIds, callerOrchestrator });

/** delete_message, old MCP: { messageId, callerOrchestrator }, no claim. */
const oldDeleteMessage = (
	client: ReturnType<typeof asServiceAccount>,
	messageId: Id<"messages">,
	callerOrchestrator?: string,
) =>
	client.mutation(api.messages.deleteMessage, {
		messageId,
		callerOrchestrator,
	});

/** getUnreadCount: no MCP caller at 71510d2; the dashboard's { orchestratorId }. */
const unreadCount = async (
	client: ReturnType<typeof asServiceAccount>,
	orchestratorId: string,
) => await client.query(api.messages.getUnreadCount, { orchestratorId });

const deniedWith = async (p: Promise<unknown>, reason: string) => {
	let caught: unknown;
	try {
		await p;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeDefined();
	const e = caught as { data?: unknown; message?: string };
	const text = `${typeof e.data === "string" ? e.data : JSON.stringify(e.data ?? "")} ${e.message ?? ""}`;
	expect(text).toContain("RBAC_DENIED");
	expect(text).toContain(reason);
};

describe.runIf(UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT)(
	"OLD MCP WIRE (71510d2) against the new doors: every caller still reads its own inbox",
	() => {
		describe.each([
			...FLEET_WITH_AGENT_ROW,
			FLEET_WITHOUT_AGENT_ROW,
		])("fleet station %s (service account, a name, no claim)", (name) => {
			test("check_messages, getUnreadCount and mark_as_read serve its own two receipts", async () => {
				const w = await seedWorld();
				const sa = asServiceAccount(w.t);
				expect(await oldCheckMessages(sa, { recipient: name })).toEqual(
					[`${name}-FLEET`, `${name}-UNSTAMPED`].sort(),
				);
				expect(await unreadCount(sa, name)).toBe(2);
				expect(
					await oldMarkAsRead(
						sa,
						[w.receipt[`${name}-UNSTAMPED`], w.receipt[`${name}-FLEET`]],
						name,
					),
				).toBe(2);
				expect(await oldCheckMessages(sa, { recipient: name })).toEqual([]);
			});
		});

		test("a master token marking without callerOrchestrator is served as in production", async () => {
			const w = await seedWorld();
			const sa = asServiceAccount(w.t);
			expect(await oldMarkAsRead(sa, [w.receipt["pi-UNSTAMPED"]])).toBe(1);
		});

		test("check_messages with a credential carrying no agent ID: org A's seat reads its own inbox", async () => {
			// The TDD row named by the task. Before the compatibility leg this read
			// the fleet tenant only and returned nothing for a client seat.
			const w = await seedWorld();
			const sa = asServiceAccount(w.t);
			const read = await oldCheckMessages(sa, { recipient: "hélios" });
			expect(read).toEqual(expect.arrayContaining(["A-BY-ID", "A-LEGACY"]));
			expect(await unreadCount(sa, "hélios")).toBeGreaterThanOrEqual(2);
		});

		test("org A's seat passing its own tenantId (a tool argument) reads exactly its own two", async () => {
			const w = await seedWorld();
			const sa = asServiceAccount(w.t);
			expect(
				await oldCheckMessages(sa, { recipient: "hélios", tenantId: ORG_A }),
			).toEqual(["A-BY-ID", "A-LEGACY"]);
		});

		test("org A's seat marks its own receipts read (ID-stamped and legacy)", async () => {
			const w = await seedWorld();
			const sa = asServiceAccount(w.t);
			expect(
				await oldMarkAsRead(
					sa,
					[w.receipt["A-BY-ID"], w.receipt["A-LEGACY"]],
					"hélios",
				),
			).toBe(2);
			expect(
				await oldCheckMessages(sa, { recipient: "hélios", tenantId: ORG_A }),
			).toEqual([]);
		});

		test("org A's seat deletes the message it sent", async () => {
			const w = await seedWorld();
			const sa = asServiceAccount(w.t);
			expect(await oldDeleteMessage(sa, w.message["A-SENT"], "hélios")).toEqual(
				{
					deleted: true,
					receiptsDeleted: 0,
				},
			);
		});

		test("org B's seat, same name, identical bytes: served exactly as production 90cbb97 serves it", async () => {
			// The old wire carries nothing that tells org A's seat from org B's: the
			// two requests are byte-identical, so no Convex can answer them
			// differently. Production answers both with every tenant's "hélios"; the
			// new MCP (#1492) is what separates them (NEW WIRE rows below).
			const w = await seedWorld();
			const sa = asServiceAccount(w.t);
			expect(await oldCheckMessages(sa, { recipient: "hélios" })).toEqual([
				"A-BY-ID",
				"A-LEGACY",
				"B-BY-ID",
				"B-LEGACY",
			]);
			expect(
				await oldCheckMessages(sa, { recipient: "hélios", tenantId: ORG_B }),
			).toEqual(["B-BY-ID", "B-LEGACY"]);
		});

		test("a person behind the service account reads and marks its own receipt", async () => {
			const w = await seedWorld();
			const sa = asServiceAccount(w.t);
			expect(await oldCheckMessages(sa, { recipient: PERSON })).toEqual([
				"PERSON-A",
			]);
			expect(await oldMarkAsRead(sa, [w.receipt["PERSON-A"]], PERSON)).toBe(1);
		});

		test("a name that is not the receipt's owner still cannot mark it", async () => {
			const w = await seedWorld();
			const sa = asServiceAccount(w.t);
			await expect(
				oldMarkAsRead(sa, [w.receipt["A-LEGACY"]], "nova"),
			).rejects.toThrow();
		});
	},
);

describe("Clerk-JWT seat (its own identity): unchanged, confined to its org", () => {
	test("org B's member reads, counts and marks org B's hélios only", async () => {
		const w = await seedWorld();
		const member = asMember(w.t, ORG_B, "user_member_b");
		expect(
			(
				await member.query(api.messages.checkNewMessagesEnvelope, {
					recipient: "hélios",
				})
			).messages
				.map((m) => m.content)
				.sort(),
		).toEqual(["B-BY-ID", "B-LEGACY"]);
		expect(
			await member.query(api.messages.getUnreadCount, {
				orchestratorId: "hélios",
			}),
		).toBe(2);
		expect(
			await member.mutation(api.messages.markAsRead, {
				receiptIds: [w.receipt["B-BY-ID"], w.receipt["B-LEGACY"]],
				callerOrchestrator: "hélios",
			}),
		).toBe(2);
	});

	test("cross-org: org B's member marking org A's receipt is refused", async () => {
		const w = await seedWorld();
		const member = asMember(w.t, ORG_B, "user_member_b");
		await deniedWith(
			member.mutation(api.messages.markAsRead, {
				receiptIds: [w.receipt["A-LEGACY"]],
				callerOrchestrator: "hélios",
			}),
			"receipt-tenant-mismatch",
		);
	});
});

describe("NEW WIRE (#1492): the claim separates the two same-named seats", () => {
	test("org B's seat (verifiedActor) reads, counts and marks only its own", async () => {
		const w = await seedWorld();
		const sa = asServiceAccount(w.t);
		const verifiedActor = { agentId: w.agentB, orgSlug: ORG_B };
		expect(
			(
				await sa.query(api.messages.checkNewMessagesEnvelope, {
					recipient: "hélios",
					verifiedActor,
				})
			).messages
				.map((m) => m.content)
				.sort(),
		).toEqual(["B-BY-ID", "B-LEGACY"]);
		expect(
			await sa.query(api.messages.getUnreadCount, {
				orchestratorId: "hélios",
				verifiedActor,
			}),
		).toBe(2);
		await deniedWith(
			sa.mutation(api.messages.markAsRead, {
				receiptIds: [w.receipt["A-LEGACY"]],
				callerOrchestrator: "hélios",
				verifiedActor,
			}),
			"receipt-not-yours",
		);
		expect(
			await sa.mutation(api.messages.markAsRead, {
				receiptIds: [w.receipt["B-BY-ID"], w.receipt["B-LEGACY"]],
				callerOrchestrator: "hélios",
				verifiedActor,
			}),
		).toBe(2);
	});

	test("org A's org-level token (verifiedOrg) reads org A's hélios only", async () => {
		const w = await seedWorld();
		const sa = asServiceAccount(w.t);
		expect(
			(
				await sa.query(api.messages.checkNewMessagesEnvelope, {
					recipient: "hélios",
					verifiedOrg: { orgSlug: ORG_A },
				})
			).messages
				.map((m) => m.content)
				.sort(),
		).toEqual(["A-BY-ID", "A-LEGACY"]);
	});

	test("a person (verifiedOrg + its own name) reads its own receipt", async () => {
		const w = await seedWorld();
		const sa = asServiceAccount(w.t);
		expect(
			(
				await sa.query(api.messages.checkNewMessagesEnvelope, {
					recipient: PERSON,
					verifiedOrg: { orgSlug: ORG_A },
				})
			).messages.map((m) => m.content),
		).toEqual(["PERSON-A"]);
	});

	test("cross-org: org A's agent naming org B as the tenant is refused", async () => {
		const w = await seedWorld();
		const sa = asServiceAccount(w.t);
		await deniedWith(
			sa.query(api.messages.checkNewMessagesEnvelope, {
				recipient: "hélios",
				tenantId: ORG_B,
				verifiedActor: { agentId: w.agentA, orgSlug: ORG_A },
			}),
			"tenant-not-the-readers-org",
		);
	});
});
