/// <reference types="vite/client" />
/**
 * convex/__tests__/inboxByAgentId.test.ts
 *
 * Cloud security, class of the Iris RH incident (task k17c5q842gm1gbh0j2qjtc80g18fx5kb).
 * The inbox doors (checkNewMessages, checkNewMessagesEnvelope, getUnreadCount,
 * markAsRead, deleteMessage) used to key on the `recipient` NAME. The wire shape
 * of ANOTHER org's same-named agent's seat calling check_messages (the fleet
 * service account, a name, no tenant) read iris-rh's mail. The inbox is now read
 * by the caller's VERIFIED agent ID (`verifiedActor`), in the caller's verified
 * org; a name only ever NARROWS (it must equal the verified agent) and a mismatch
 * is a raised RBAC_DENIED naming the door.
 *
 * World: two client orgs (iris-rh, acme) each with an agent named "hélios", one
 * operator org (vantage-fleet) whose roles pi / eta have NO agents row (the
 * fleet-role gap, task k17a1yprfca2cfjc4cnz4ynvvs8fwe5m) and whose agent "sigma"
 * has one.
 *
 * Poles (per door where it applies):
 *   REFUSED  acme's hélios reads NOTHING of iris's inbox, whatever recipient it
 *            passes (hélios / helios / iris's agent ID / nothing);
 *   PRESENT  iris's hélios reads its own mail: sent by ID and legacy by-name
 *            receipts (served by verified org + exact name until backfilled);
 *   FLEET    the service account with a name and no tenant reads the FLEET's
 *            tenant only; pi / eta still work; a client tenant is refused;
 *   OWNED    a receipt / message of another agent is refused on mark / delete.
 */

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
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
const IRIS = "iris-rh";
const ACME = "acme";
const NOW = 1_700_000_000_000;

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
	irisHelios: Id<"agents">;
	acmeHelios: Id<"agents">;
	irisClio: Id<"agents">;
	sigma: Id<"agents">;
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
		await mapping(FLEET, ["pi", "eta", "sigma"], true);
		const irisRow = await mapping(IRIS, ["hélios", "clio"], false);
		await mapping(ACME, ["hélios"], false);
		const agent = (orgSlug: string, name: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId: testClerkOrgId(orgSlug),
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: NOW,
			});
		const irisHelios = await agent(IRIS, "hélios");
		const acmeHelios = await agent(ACME, "hélios");
		const irisClio = await agent(IRIS, "clio");
		const sigma = await agent(FLEET, "sigma");
		// M1: the roster is stored BY ID (the name roster above stays beside it).
		await ctx.db.patch(irisRow, { allowedAgentIds: [irisHelios, irisClio] });

		const message: Record<string, Id<"messages">> = {};
		const receipt: Record<string, Id<"messageReceipts">> = {};
		const put = async (
			key: string,
			o: {
				from: string;
				fromId?: string;
				recipient: string;
				recipientId?: string;
				tenantId?: string;
			},
		) => {
			message[key] = await ctx.db.insert("messages", {
				from: o.from,
				...(o.fromId !== undefined ? { fromId: o.fromId } : {}),
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
		// iris-rh: one stamped with the agent ID, one LEGACY (name only).
		await put("IRIS-BY-ID", {
			from: "clio",
			fromId: irisClio,
			recipient: "hélios",
			recipientId: irisHelios,
			tenantId: IRIS,
		});
		await put("IRIS-LEGACY", {
			from: "clio",
			recipient: "hélios",
			tenantId: IRIS,
		});
		// acme: the same pair under the SAME name.
		await put("ACME-BY-ID", {
			from: "x",
			recipient: "hélios",
			recipientId: acmeHelios,
			tenantId: ACME,
		});
		await put("ACME-LEGACY", {
			from: "x",
			recipient: "hélios",
			tenantId: ACME,
		});
		// the fleet: roles with NO agents row, unstamped and operator-stamped.
		await put("FLEET-PI", { from: "eta", recipient: "pi" });
		await put("FLEET-ETA", { from: "pi", recipient: "eta", tenantId: FLEET });
		// a fleet-owned mailbox that happens to be called "hélios" too.
		await put("FLEET-HELIOS", { from: "pi", recipient: "hélios" });
		// an operator-org AGENT: one legacy unstamped, one stamped with its ID.
		await put("SIGMA-LEGACY", { from: "pi", recipient: "sigma" });
		await put("SIGMA-BY-ID", {
			from: "pi",
			recipient: "sigma",
			recipientId: sigma,
			tenantId: FLEET,
		});
		// a message iris's hélios SENT (deleteMessage is sender-keyed).
		message["IRIS-SENT"] = await ctx.db.insert("messages", {
			from: "hélios",
			fromId: irisHelios,
			channel: "clio",
			content: "IRIS-SENT",
			tenantId: IRIS,
			tenantOrgId: testClerkOrgId(IRIS),
			createdAt: NOW,
		});
		return { irisHelios, acmeHelios, irisClio, sigma, receipt, message };
	});
	return { t, ...world };
}

const actor = (agentId: Id<"agents">, orgSlug: string) => ({
	verifiedActor: { agentId, orgSlug },
});

const contentsOf = (rows: Array<{ content: string }>) =>
	rows.map((r) => r.content).sort();

type Check = (
	t: T,
	args: Record<string, unknown>,
) => Promise<Array<{ content: string }>>;

const viaCheck: Check = async (t, args) =>
	await asServiceAccount(t).query(api.messages.checkNewMessages, args as never);
const viaEnvelope: Check = async (t, args) =>
	(
		await asServiceAccount(t).query(
			api.messages.checkNewMessagesEnvelope,
			args as never,
		)
	).messages;
const DOORS: Array<[string, Check, string]> = [
	["checkNewMessages", viaCheck, "messages:checkNewMessages"],
	[
		"checkNewMessagesEnvelope",
		viaEnvelope,
		"messages:checkNewMessagesEnvelope",
	],
];

const countOf = async (t: T, args: Record<string, unknown>) =>
	await asServiceAccount(t).query(api.messages.getUnreadCount, args as never);

describe("REFUSED: the namesake in another org reads nothing of iris's inbox", () => {
	describe.each(DOORS)("%s", (_name, check, door) => {
		// CONTRACT pole (inboxReader.ts UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT):
		// armed when the flag is flipped to false, after the claim-sending MCP is
		// observed live. Until then the claimless service account is served as
		// production served it; inboxOldMcpWire.test.ts pins that.
		test.runIf(!UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT)(
			"the measured defect: the service account, a name, NO tenant, reads the fleet tenant only",
			async () => {
				const { t } = await seedWorld();
				const got = contentsOf(await check(t, { recipient: "hélios" }));
				expect(got).toEqual(["FLEET-HELIOS"]);
			},
		);

		test("acme's hélios, recipient 'hélios' or nothing: reads acme's two, never iris's", async () => {
			const { t, acmeHelios } = await seedWorld();
			for (const args of [
				{ recipient: "hélios", ...actor(acmeHelios, ACME) },
				{ ...actor(acmeHelios, ACME) },
			]) {
				expect(contentsOf(await check(t, args))).toEqual([
					"ACME-BY-ID",
					"ACME-LEGACY",
				]);
			}
		});

		test("acme's hélios naming 'helios' or iris hélios's ID is REFUSED, RBAC_DENIED naming the door", async () => {
			const { t, acmeHelios, irisHelios } = await seedWorld();
			for (const recipient of ["helios", irisHelios]) {
				await expect(
					check(t, { recipient, ...actor(acmeHelios, ACME) }),
				).rejects.toThrow(new RegExp(`RBAC_DENIED.*${door}`));
			}
		});

		test("acme's hélios naming iris-rh as the tenant is REFUSED", async () => {
			const { t, acmeHelios } = await seedWorld();
			await expect(
				check(t, { tenantId: IRIS, ...actor(acmeHelios, ACME) }),
			).rejects.toThrow(new RegExp(`RBAC_DENIED.*${door}`));
		});

		test("a verifiedActor lying about its org is refused (the agent row is read by ID)", async () => {
			const { t, acmeHelios } = await seedWorld();
			await expect(check(t, { ...actor(acmeHelios, IRIS) })).rejects.toThrow(
				/ORG_MISMATCH/,
			);
		});
	});

	test("getUnreadCount: acme's hélios counts its own two, never iris's; a mismatch is refused", async () => {
		const { t, acmeHelios, irisHelios } = await seedWorld();
		expect(await countOf(t, { ...actor(acmeHelios, ACME) })).toBe(2);
		expect(
			await countOf(t, {
				orchestratorId: "hélios",
				...actor(acmeHelios, ACME),
			}),
		).toBe(2);
		await expect(
			countOf(t, { orchestratorId: irisHelios, ...actor(acmeHelios, ACME) }),
		).rejects.toThrow(/RBAC_DENIED.*messages:getUnreadCount/);
		await expect(
			countOf(t, { orchestratorId: "helios", ...actor(acmeHelios, ACME) }),
		).rejects.toThrow(/RBAC_DENIED.*messages:getUnreadCount/);
	});

	// CONTRACT pole (inboxReader.ts UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT):
	// armed when the flag is flipped to false, after the claim-sending MCP is
	// observed live. Until then the claimless service account is served as
	// production served it; inboxOldMcpWire.test.ts pins that.
	test.runIf(!UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT)(
		"getUnreadCount: the service account by name, no tenant, counts the fleet's mailbox only",
		async () => {
			const { t } = await seedWorld();
			expect(await countOf(t, { orchestratorId: "hélios" })).toBe(1);
		},
	);

	test("a verifiedActor from a non-service-account caller is refused, not ignored", async () => {
		const { t, acmeHelios } = await seedWorld();
		await expect(
			asMember(t, ACME, "user_a").query(api.messages.checkNewMessages, {
				recipient: "hélios",
				...actor(acmeHelios, ACME),
			} as never),
		).rejects.toThrow(/RBAC_DENIED.*verified-actor-not-trusted/);
	});

	test("the envelope's task blocks are the reader's own org's: iris's stuck task never reaches acme's hélios", async () => {
		const { t, acmeHelios, irisHelios } = await seedWorld();
		await t.run(async (ctx) => {
			await ctx.db.insert("tasks", {
				title: "IRIS-PRIVATE-TASK",
				assignedTo: "hélios",
				assignedToId: irisHelios,
				createdBy: "clio",
				orgId: IRIS,
				clerkOrgId: testClerkOrgId(IRIS),
				priority: "medium",
				status: "in_progress",
				createdAt: NOW - 90 * 3_600_000,
				updatedAt: NOW - 90 * 3_600_000,
			} as never);
		});
		const mine = await asServiceAccount(t).query(
			api.messages.checkNewMessagesEnvelope,
			{ ...actor(irisHelios, IRIS) } as never,
		);
		expect(JSON.stringify(mine.stuckInProgress)).toContain("IRIS-PRIVATE-TASK");
		// The claimless form is a CONTRACT pole (inboxReader.ts
		// UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT), armed after the flip.
		const readers: Array<Record<string, unknown>> = [
			{ ...actor(acmeHelios, ACME) },
		];
		if (!UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT) {
			readers.push({ recipient: "hélios" });
		}
		for (const args of readers) {
			const theirs = await asServiceAccount(t).query(
				api.messages.checkNewMessagesEnvelope,
				args as never,
			);
			expect(JSON.stringify(theirs)).not.toContain("IRIS-PRIVATE-TASK");
		}
	});
});

describe("PRESENT: a reader is served what is its own", () => {
	describe.each(DOORS)("%s", (_name, check) => {
		test("iris's hélios reads its ID-stamped and its legacy by-name receipts", async () => {
			const { t, irisHelios } = await seedWorld();
			expect(
				contentsOf(await check(t, { ...actor(irisHelios, IRIS) })),
			).toEqual(["IRIS-BY-ID", "IRIS-LEGACY"]);
			expect(
				contentsOf(
					await check(t, { recipient: "hélios", ...actor(irisHelios, IRIS) }),
				),
			).toEqual(["IRIS-BY-ID", "IRIS-LEGACY"]);
		});

		test("the operator org's agent reads its unstamped legacy and its stamped receipts", async () => {
			const { t, sigma } = await seedWorld();
			expect(contentsOf(await check(t, { ...actor(sigma, FLEET) }))).toEqual([
				"SIGMA-BY-ID",
				"SIGMA-LEGACY",
			]);
		});

		test("a fleet orchestrator without an agents row (pi, eta) still reads its inbox", async () => {
			const { t } = await seedWorld();
			expect(contentsOf(await check(t, { recipient: "pi" }))).toEqual([
				"FLEET-PI",
			]);
			expect(contentsOf(await check(t, { recipient: "eta" }))).toEqual([
				"FLEET-ETA",
			]);
		});

		test("the verified-org form (a multi-name token) resolves the name IN that org only", async () => {
			const { t } = await seedWorld();
			expect(
				contentsOf(
					await check(t, {
						recipient: "hélios",
						verifiedOrg: { orgSlug: IRIS },
					}),
				),
			).toEqual(["IRIS-BY-ID", "IRIS-LEGACY"]);
			expect(
				contentsOf(
					await check(t, {
						recipient: "hélios",
						verifiedOrg: { orgSlug: ACME },
					}),
				),
			).toEqual(["ACME-BY-ID", "ACME-LEGACY"]);
		});

		test("a Clerk member of acme reading 'hélios' is confined to acme", async () => {
			const { t } = await seedWorld();
			const rows = await (check === viaCheck
				? asMember(t, ACME, "user_a").query(api.messages.checkNewMessages, {
						recipient: "hélios",
					})
				: asMember(t, ACME, "user_a")
						.query(api.messages.checkNewMessagesEnvelope, {
							recipient: "hélios",
						})
						.then((r) => r.messages));
			expect(contentsOf(rows)).toEqual(["ACME-BY-ID", "ACME-LEGACY"]);
		});
	});

	test("a message sent BY ID (#1489) reaches exactly that agent and nobody of the same name", async () => {
		const { t, irisHelios, acmeHelios, irisClio } = await seedWorld();
		await asServiceAccount(t).mutation(api.messages.sendMessage, {
			from: "clio",
			recipientAgentIds: [irisHelios],
			content: "SENT-BY-ID",
			verifiedActor: { agentId: irisClio, orgSlug: IRIS },
		} as never);
		const iris = await viaCheck(t, { ...actor(irisHelios, IRIS) });
		const acme = await viaCheck(t, { ...actor(acmeHelios, ACME) });
		expect(contentsOf(iris)).toContain("SENT-BY-ID");
		expect(contentsOf(acme)).not.toContain("SENT-BY-ID");
	});

	test("getUnreadCount: iris's hélios counts both; sigma counts both; pi counts one", async () => {
		const { t, irisHelios, sigma } = await seedWorld();
		expect(await countOf(t, { ...actor(irisHelios, IRIS) })).toBe(2);
		expect(await countOf(t, { ...actor(sigma, FLEET) })).toBe(2);
		expect(await countOf(t, { orchestratorId: "pi" })).toBe(1);
	});
});

// CONTRACT pole (inboxReader.ts UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT):
// armed when the flag is flipped to false, after the claim-sending MCP is
// observed live. Until then the claimless service account is served as
// production served it; inboxOldMcpWire.test.ts pins that.
describe.runIf(!UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT)(
	"FLEET: the service account names no client tenant",
	() => {
		test.each(
			DOORS,
		)("%s: a client tenant by name is REFUSED", async (_n, check, door) => {
			const { t } = await seedWorld();
			await expect(
				check(t, { recipient: "hélios", tenantId: IRIS }),
			).rejects.toThrow(new RegExp(`RBAC_DENIED.*${door}`));
		});

		test("getUnreadCount: a client tenant has no name-keyed door; the call is the fleet's", async () => {
			const { t } = await seedWorld();
			expect(await countOf(t, { orchestratorId: "hélios" })).toBe(1);
		});
	},
);

describe("OWNED: a receipt / message of another agent is refused", () => {
	const markAs = (t: T, args: Record<string, unknown>) =>
		asServiceAccount(t).mutation(api.messages.markAsRead, args as never);

	test("markAsRead: acme's hélios cannot mark iris's receipt, whatever name it asserts", async () => {
		const { t, acmeHelios, receipt } = await seedWorld();
		for (const callerOrchestrator of ["hélios", undefined]) {
			await expect(
				markAs(t, {
					receiptIds: [receipt["IRIS-BY-ID"], receipt["IRIS-LEGACY"]],
					...(callerOrchestrator !== undefined ? { callerOrchestrator } : {}),
					...actor(acmeHelios, ACME),
				}),
			).rejects.toThrow(/RBAC_DENIED.*messages:markAsRead/);
		}
		const left = await t.run(async (ctx) => ({
			byId: (await ctx.db.get(receipt["IRIS-BY-ID"]))?.readAt ?? null,
			legacy: (await ctx.db.get(receipt["IRIS-LEGACY"]))?.readAt ?? null,
		}));
		expect(left).toEqual({ byId: null, legacy: null });
	});

	// A seat reaches Convex as the service account, carries `verifiedActor`, and
	// OMITS `callerOrchestrator` (the tool description says so for a seat). A
	// claimed caller must never take the claimless master marking path, which
	// marks every receipt id it lists across tenants. Holds in BOTH deploy phases.
	test("markAsRead: a seat's claim without callerOrchestrator never takes the master path (org B's seat, org A's receipt)", async () => {
		const { t, acmeHelios, receipt } = await seedWorld();
		for (const key of ["IRIS-BY-ID", "IRIS-LEGACY"]) {
			await expect(
				markAs(t, { receiptIds: [receipt[key]], ...actor(acmeHelios, ACME) }),
			).rejects.toThrow(/RBAC_DENIED.*messages:markAsRead/);
			const readAt = await t.run(
				async (ctx) => (await ctx.db.get(receipt[key]))?.readAt ?? null,
			);
			expect(readAt).toBeNull();
		}
	});

	// CONTRACT pole (inboxReader.ts UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT):
	// armed when the flag is flipped to false, after the claim-sending MCP is
	// observed live. Until then the claimless service account is served as
	// production served it; inboxOldMcpWire.test.ts pins that.
	test.runIf(!UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT)(
		"markAsRead: the service account naming 'hélios' cannot mark iris's receipt either",
		async () => {
			const { t, receipt } = await seedWorld();
			await expect(
				markAs(t, {
					receiptIds: [receipt["IRIS-BY-ID"]],
					callerOrchestrator: "hélios",
				}),
			).rejects.toThrow(/RBAC_DENIED.*messages:markAsRead/);
		},
	);

	test("markAsRead: a reader marks its own (ID-stamped and legacy), and only those", async () => {
		const { t, irisHelios, receipt } = await seedWorld();
		expect(
			await markAs(t, {
				receiptIds: [receipt["IRIS-BY-ID"], receipt["IRIS-LEGACY"]],
				...actor(irisHelios, IRIS),
			}),
		).toBe(2);
		const acme = await t.run(
			async (ctx) => (await ctx.db.get(receipt["ACME-BY-ID"]))?.readAt ?? null,
		);
		expect(acme).toBeNull();
	});

	test("markAsRead: a fleet orchestrator marks its own receipt", async () => {
		const { t, receipt } = await seedWorld();
		expect(
			await markAs(t, {
				receiptIds: [receipt["FLEET-PI"]],
				callerOrchestrator: "pi",
			}),
		).toBe(1);
	});

	// CONTRACT poles (inboxReader.ts UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT
	// `false`): the claimless service account naming no owner (the check-messages
	// skill's call) marks the FLEET's receipts and is refused a client tenant's.
	// While the flag is true the claimless service account is served as
	// production served it; inboxOldMcpWire.test.ts pins that.
	test.runIf(!UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT)(
		"markAsRead: the service account naming no owner marks a fleet receipt",
		async () => {
			const { t, receipt } = await seedWorld();
			expect(await markAs(t, { receiptIds: [receipt["FLEET-PI"]] })).toBe(1);
		},
	);

	test.runIf(!UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT)(
		"markAsRead: the service account naming no owner cannot mark a client tenant's receipt",
		async () => {
			const { t, receipt } = await seedWorld();
			await expect(
				markAs(t, { receiptIds: [receipt["ACME-BY-ID"]] }),
			).rejects.toThrow(/RBAC_DENIED.*messages:markAsRead/);
			const row = await t.run((ctx) => ctx.db.get(receipt["ACME-BY-ID"]));
			expect(row?.readAt).toBeUndefined();
		},
	);

	test("deleteMessage: acme's hélios cannot delete the message iris's hélios sent", async () => {
		const { t, acmeHelios, message } = await seedWorld();
		await expect(
			asServiceAccount(t).mutation(api.messages.deleteMessage, {
				messageId: message["IRIS-SENT"],
				callerOrchestrator: "hélios",
				...actor(acmeHelios, ACME),
			} as never),
		).rejects.toThrow(/RBAC_DENIED.*messages:deleteMessage/);
		expect(
			await t.run((ctx) => ctx.db.get(message["IRIS-SENT"])),
		).not.toBeNull();
	});

	// CONTRACT pole (inboxReader.ts UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT):
	// armed when the flag is flipped to false, after the claim-sending MCP is
	// observed live. Until then the claimless service account is served as
	// production served it; inboxOldMcpWire.test.ts pins that.
	test.runIf(!UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT)(
		"deleteMessage: the service account asserting 'hélios' cannot delete iris's message",
		async () => {
			const { t, message } = await seedWorld();
			await expect(
				asServiceAccount(t).mutation(api.messages.deleteMessage, {
					messageId: message["IRIS-SENT"],
					callerOrchestrator: "hélios",
				}),
			).rejects.toThrow(/RBAC_DENIED.*messages:deleteMessage/);
		},
	);

	test("deleteMessage: its own sender, by ID, deletes it", async () => {
		const { t, irisHelios, message } = await seedWorld();
		const out = await asServiceAccount(t).mutation(api.messages.deleteMessage, {
			messageId: message["IRIS-SENT"],
			...actor(irisHelios, IRIS),
		} as never);
		expect(out.deleted).toBe(true);
	});
});

describe("LEGACY receipts: backfill stamps them, and nothing becomes unreadable", () => {
	test("backfill_actor_ids stamps recipientId by (tenant, exact name); the namesake's receipts are not touched", async () => {
		const { t, irisHelios, acmeHelios, receipt } = await seedWorld();
		const before = contentsOf(
			await viaCheck(t, { ...actor(irisHelios, IRIS) }),
		);
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
		const stamped = await t.run(async (ctx) => ({
			irisLegacy:
				(await ctx.db.get(receipt["IRIS-LEGACY"]))?.recipientId ?? null,
			acmeLegacy:
				(await ctx.db.get(receipt["ACME-LEGACY"]))?.recipientId ?? null,
			// the fleet has no "hélios" agent: undecidable, left unset, never guessed.
			fleetHelios:
				(await ctx.db.get(receipt["FLEET-HELIOS"]))?.recipientId ?? null,
		}));
		expect(stamped.irisLegacy).toBe(irisHelios);
		expect(stamped.acmeLegacy).toBe(acmeHelios);
		expect(stamped.fleetHelios).toBeNull();
		// the same inbox, before and after.
		expect(
			contentsOf(await viaCheck(t, { ...actor(irisHelios, IRIS) })),
		).toEqual(before);
		// and the fleet's own "hélios" mailbox is still its own (the claimless
		// form reads the fleet tenant only after the CONTRACT flip; before it,
		// every tenant, as production; the receipt is served either way).
		const fleetRead = contentsOf(await viaCheck(t, { recipient: "hélios" }));
		if (UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT) {
			expect(fleetRead).toContain("FLEET-HELIOS");
		} else {
			expect(fleetRead).toEqual(["FLEET-HELIOS"]);
		}
	});
});
