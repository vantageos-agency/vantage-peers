/// <reference types="vite/client" />
/**
 * RED reproduction of the R1 audit (messages:* doors), main @16f0907.
 * Every test asserts what the door MUST do. A test that FAILS here reproduces
 * the audited defect. Origin of every case: audit row in
 * scratchpad/audit/doors/defects-R1.jsonl (static audit of VantagePeers main
 * 16f0907); harness: convex/__tests__/inboxByAgentId.test.ts and
 * convex/__tests__/markAsReadTenant.test.ts (tracked paths).
 *
 * Identities (named per test in the test name):
 *   SA      = the fleet service account, NO claim (every MCP seat's transport)
 *   MEMBER  = a Clerk org member (organizationSlug + org_role), scoped
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { normalizeOrchestratorId } from "../../_helpers/normalizeOrchestratorId";
import schema from "../../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const FLEET = "vantage-fleet";
const C1 = "client-a";
const C2 = "client-b";
const NARROW = "org-narrow";
const ORGAB = "org-a";
const NOW = 1_700_000_000_000;

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const asSA = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });
const asMember = (t: T, org: string, role: string, subject = "user_member") =>
	t.withIdentity({
		subject,
		organizationSlug: org,
		org_role: role,
	} as Parameters<T["withIdentity"]>[0]);

type World = {
	t: T;
	piAgent: Id<"agents">;
	c1Atlas: Id<"agents">;
	c2Atlas: Id<"agents">;
	m: Record<string, Id<"messages">>;
	r: Record<string, Id<"messageReceipts">>;
};

async function seedWorld(): Promise<World> {
	const t = createT();
	const w = await t.run(async (ctx) => {
		const mapping = (
			slug: string,
			names: string[],
			operator = false,
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: names,
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...(operator ? { orgKind: "operator" as const } : {}),
			});
		await mapping(FLEET, ["pi", "eta"], true);
		await mapping(C1, ["pi", "atlas", "vega", "scribe"]);
		await mapping(C2, ["atlas"]);
		await mapping(NARROW, ["sigma"]);
		await mapping(ORGAB, ["sigma"]);
		const agent = (orgSlug: string, name: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: NOW,
			});
		// profiles: the recipient resolver derives the known roles from them
		for (const role of ["pi", "eta", "atlas", "vega", "scribe", "sigma"]) {
			await ctx.db.insert("profiles", {
				orchestratorId: role,
				name: role,
				static: { role, workspace: "w", capabilities: [] },
				dynamic: { lastSeen: NOW, sessionCount: 0 },
			});
		}
		const piAgent = await agent(FLEET, "pi");
		const c1Atlas = await agent(C1, "atlas");
		const c1Vega = await agent(C1, "vega");
		const c2Atlas = await agent(C2, "atlas");

		const m: Record<string, Id<"messages">> = {};
		const r: Record<string, Id<"messageReceipts">> = {};
		const put = async (
			key: string,
			o: {
				from: string;
				recipient: string;
				recipientId?: string;
				tenantId?: string;
				content?: string;
				at?: number;
			},
		) => {
			m[key] = await ctx.db.insert("messages", {
				from: o.from,
				channel: o.recipient,
				content: o.content ?? `${key} probe`,
				tenantId: o.tenantId,
				createdAt: o.at ?? NOW,
			});
			r[key] = await ctx.db.insert("messageReceipts", {
				messageId: m[key],
				recipient: o.recipient,
				...(o.recipientId !== undefined ? { recipientId: o.recipientId } : {}),
				tenantId: o.tenantId,
				readAt: undefined,
			});
		};
		// client mail to a fleet agent: stamped in the CLIENT tenant, with the
		// operator-org agent's ID (the write path of 16f0907)
		await put("C1-TO-PI", {
			from: "vega",
			recipient: "pi",
			recipientId: piAgent,
			tenantId: C1,
		});
		// mail to another roster agent of C1 (a colleague's mailbox)
		await put("C1-TO-VEGA", {
			from: "atlas",
			recipient: "vega",
			recipientId: c1Vega,
			tenantId: C1,
		});
		await put("C1-TO-USER", {
			from: "atlas",
			recipient: "user:colleague",
			tenantId: C1,
		});
		await put("C2-TO-ATLAS", {
			from: "atlas",
			recipient: "atlas",
			recipientId: c2Atlas,
			tenantId: C2,
		});
		await put("FLEET-TO-ETA", { from: "pi", recipient: "eta" });
		return { piAgent, c1Atlas, c2Atlas, m, r };
	});
	return { t, ...w };
}

const contents = (rows: Array<{ content: string }>) =>
	rows.map((x) => x.content).sort();

// ─────────────────────────────────────────────────────────────────────────────
describe("messages:sendMessage", () => {
	test("messages:sendMessage — the claimless service account cannot write into a client tenant named by a free tenantId argument (SA, no claim)", async () => {
		const { t } = await seedWorld();
		await expect(
			asSA(t).mutation(api.messages.sendMessage, {
				from: "pi",
				channel: "atlas",
				content: "claimless-write-probe",
				tenantId: C1,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		const stamped = await t.run(async (ctx) =>
			(await ctx.db.query("messages").collect()).filter(
				(x) => x.content === "claimless-write-probe",
			),
		);
		expect(stamped).toHaveLength(0);
	});

	test("messages:sendMessage — a fleet sender (SA) addressing a client agent BY ID is delivered to that agent (SA, no tenantId)", async () => {
		const { t, c1Atlas } = await seedWorld();
		await asSA(t).mutation(api.messages.sendMessage, {
			from: "pi",
			recipientAgentIds: [c1Atlas],
			content: "fleet-to-client-by-id",
		});
		const receipts = await t.run(async (ctx) => {
			const msgs = (await ctx.db.query("messages").collect()).filter(
				(x) => x.content === "fleet-to-client-by-id",
			);
			return msgs.length === 0
				? []
				: await ctx.db
						.query("messageReceipts")
						.withIndex("by_message", (q) => q.eq("messageId", msgs[0]._id))
						.collect();
		});
		expect(receipts.map((x) => x.recipientId)).toEqual([c1Atlas]);
	});

	test("messages:sendMessage — a fleet sender (verifiedActor pi of the operator org) addressing a client agent BY ID is delivered (SA + verifiedActor)", async () => {
		const { t, piAgent, c1Atlas } = await seedWorld();
		await asSA(t).mutation(api.messages.sendMessage, {
			from: "pi",
			recipientAgentIds: [c1Atlas],
			content: "fleet-actor-to-client-by-id",
			verifiedActor: { agentId: piAgent, orgSlug: FLEET },
		} as never);
		const n = await t.run(
			async (ctx) =>
				(await ctx.db.query("messages").collect()).filter(
					(x) => x.content === "fleet-actor-to-client-by-id",
				).length,
		);
		expect(n).toBe(1);
	});

	test("messages:sendMessage — a viewer member cannot send as a roster orchestrator that has no agents row (MEMBER org:viewer)", async () => {
		const { t } = await seedWorld();
		await expect(
			asMember(t, C1, "org:viewer").mutation(api.messages.sendMessage, {
				from: "scribe",
				channel: "vega",
				content: "viewer-send-probe",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("messages:checkNewMessages / checkNewMessagesEnvelope", () => {
	test("messages:checkNewMessages — the claimless fleet station pi receives client-tenant mail stamped with its agent ID (SA, no claim)", async () => {
		const { t } = await seedWorld();
		const got = await asSA(t).query(api.messages.checkNewMessages, {
			recipient: "pi",
		} as never);
		expect(contents(got)).toEqual(["C1-TO-PI probe"]);
	});

	test("messages:checkNewMessages — a member cannot read another roster agent's mailbox by naming it (MEMBER org:editor)", async () => {
		const { t } = await seedWorld();
		let got: Array<{ content: string }> | undefined;
		try {
			got = await asMember(t, C1, "org:editor").query(
				api.messages.checkNewMessages,
				{ recipient: "vega" } as never,
			);
		} catch (e) {
			expect(String(e)).toMatch(/RBAC_DENIED/);
			return;
		}
		expect(contents(got ?? [])).not.toContain("C1-TO-VEGA probe");
	});

	test("messages:checkNewMessagesEnvelope — the claimless fleet station pi receives client-tenant mail stamped with its agent ID (SA, no claim)", async () => {
		const { t } = await seedWorld();
		const got = await asSA(t).query(api.messages.checkNewMessagesEnvelope, {
			recipient: "pi",
		} as never);
		expect(contents(got.messages)).toEqual(["C1-TO-PI probe"]);
	});

	test("messages:checkNewMessagesEnvelope — a member cannot read another roster agent's mailbox by naming it (MEMBER org:editor)", async () => {
		const { t } = await seedWorld();
		let got: { messages: Array<{ content: string }> } | undefined;
		try {
			got = await asMember(t, C1, "org:editor").query(
				api.messages.checkNewMessagesEnvelope,
				{ recipient: "vega" } as never,
			);
		} catch (e) {
			expect(String(e)).toMatch(/RBAC_DENIED/);
			return;
		}
		expect(contents(got?.messages ?? [])).not.toContain("C1-TO-VEGA probe");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("messages:markAsRead", () => {
	test("messages:markAsRead — the fleet station pi (SA naming pi) marks the client-tenant receipt addressed to its agent ID (SA, callerOrchestrator pi)", async () => {
		const { t, r } = await seedWorld();
		const n = await asSA(t).mutation(api.messages.markAsRead, {
			receiptIds: [r["C1-TO-PI"]],
			callerOrchestrator: "pi",
		});
		expect(n).toBe(1);
	});

	test("messages:markAsRead — a viewer member cannot mark another roster agent's receipt by passing its name (MEMBER org:viewer)", async () => {
		const { t, r } = await seedWorld();
		await expect(
			asMember(t, C1, "org:viewer").mutation(api.messages.markAsRead, {
				receiptIds: [r["C1-TO-VEGA"]],
				callerOrchestrator: "vega",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		const row = await t.run((ctx) => ctx.db.get(r["C1-TO-VEGA"]));
		expect(row?.readAt).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("messages:deleteMessage", () => {
	test("messages:deleteMessage — typing 'system' as the claimless service account cannot delete a client tenant's message (SA, no claim)", async () => {
		const { t, m } = await seedWorld();
		await expect(
			asSA(t).mutation(api.messages.deleteMessage, {
				messageId: m["C1-TO-VEGA"],
				callerOrchestrator: "system",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await t.run((ctx) => ctx.db.get(m["C1-TO-VEGA"]))).not.toBeNull();
	});

	test("messages:deleteMessage — a viewer member cannot delete a roster orchestrator's message by typing its name (MEMBER org:viewer)", async () => {
		const { t, m } = await seedWorld();
		await expect(
			asMember(t, C1, "org:viewer").mutation(api.messages.deleteMessage, {
				messageId: m["C1-TO-VEGA"],
				callerOrchestrator: "atlas",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await t.run((ctx) => ctx.db.get(m["C1-TO-VEGA"]))).not.toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("messages:listMessages", () => {
	test("messages:listMessages — the claimless service account is not served client tenants' rows (SA, no claim)", async () => {
		const { t } = await seedWorld();
		const rows = await asSA(t).query(api.messages.listMessages, {});
		const tenants = new Set(rows.map((x) => x.tenantId));
		expect(tenants.has(C1)).toBe(false);
		expect(tenants.has(C2)).toBe(false);
	});

	test("messages:listMessages — a member does not see a message addressed to a colleague's user:<subject> inbox (MEMBER org:editor)", async () => {
		const { t } = await seedWorld();
		const rows = await asMember(t, C1, "org:editor").query(
			api.messages.listMessages,
			{},
		);
		expect(contents(rows)).not.toContain("C1-TO-USER probe");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("messages:getUnreadCount", () => {
	test("messages:getUnreadCount — the claimless fleet station pi counts the client-tenant mail addressed to its agent ID (SA, orchestratorId pi)", async () => {
		const { t } = await seedWorld();
		const n = await asSA(t).query(api.messages.getUnreadCount, {
			orchestratorId: "pi",
		});
		expect(n).toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("messages:listBroadcastStatus", () => {
	test("messages:listBroadcastStatus — the claimless service account cannot read a client tenant message's recipients (SA, no claim)", async () => {
		const { t, m } = await seedWorld();
		await expect(
			asSA(t).query(api.messages.listBroadcastStatus, {
				messageId: m["C1-TO-VEGA"],
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("messages:listBroadcastStatus — channel team/org-ab is not on org-a's channels (MEMBER of org-a, no segment boundary)", async () => {
		const { t } = await seedWorld();
		const id = await t.run((ctx) =>
			ctx.db.insert("messages", {
				from: "sigma",
				channel: "team/org-ab",
				content: "other-team probe",
				tenantId: ORGAB,
				createdAt: NOW,
			}),
		);
		await expect(
			asMember(t, ORGAB, "org:editor").query(api.messages.listBroadcastStatus, {
				messageId: id,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
async function seedNarrow(t: T, other: number, sigma: number) {
	await t.run(async (ctx) => {
		for (let i = 0; i < sigma; i++) {
			await ctx.db.insert("messages", {
				from: "sigma",
				channel: "sigma",
				content: `sigma-${i}`,
				tenantId: NARROW,
				createdAt: NOW + i,
			});
		}
		for (let i = 0; i < other; i++) {
			await ctx.db.insert("messages", {
				from: "x",
				channel: "other",
				content: `other-${i}`,
				tenantId: NARROW,
				createdAt: NOW + 1000 + i,
			});
		}
	});
}

describe("messages:listByChannel", () => {
	test("messages:listByChannel — the claimless service account is not served client tenants' rows (SA, no claim)", async () => {
		const { t } = await seedWorld();
		const rows = await asSA(t).query(api.messages.listByChannel, {});
		const list = Array.isArray(rows) ? rows : rows.items;
		const tenants = new Set(list.map((x) => x.tenantId));
		expect(tenants.has(C1)).toBe(false);
		expect(tenants.has(C2)).toBe(false);
	});

	test("messages:listByChannel — a narrow-roster member still gets the roster rows when newer non-roster rows exist (MEMBER org:editor, 150 other newer than 5 sigma)", async () => {
		const { t } = await seedWorld();
		await seedNarrow(t, 150, 5);
		const rows = await asMember(t, NARROW, "org:editor").query(
			api.messages.listByChannel,
			{ limit: 100 },
		);
		const list = Array.isArray(rows) ? rows : rows.items;
		expect(list.map((x) => x.channel)).toEqual(Array(5).fill("sigma"));
	});
});

describe("messages:listByChannelPaginated", () => {
	test("messages:listByChannelPaginated — the claimless service account is not served client tenants' rows (SA, no claim)", async () => {
		const { t } = await seedWorld();
		const res = await asSA(t).query(api.messages.listByChannelPaginated, {
			paginationOpts: { numItems: 100, cursor: null },
		});
		const tenants = new Set(res.page.map((x) => x.tenantId));
		expect(tenants.has(C1)).toBe(false);
		expect(tenants.has(C2)).toBe(false);
	});

	test("messages:listByChannelPaginated — a page is never empty while rows remain (MEMBER org:editor, 120 non-roster newer than 3 roster)", async () => {
		const { t } = await seedWorld();
		await seedNarrow(t, 120, 3);
		const res = await asMember(t, NARROW, "org:editor").query(
			api.messages.listByChannelPaginated,
			{ paginationOpts: { numItems: 100, cursor: null } },
		);
		expect(res.page.length === 0 && !res.isDone).toBe(false);
	});
});

describe("messages:getById", () => {
	test("messages:getById — the claimless service account cannot read a client tenant's message by ID (SA, no claim)", async () => {
		const { t, m } = await seedWorld();
		await expect(
			asSA(t).query(api.messages.getById, { messageId: m["C1-TO-VEGA"] }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("messages:getById — channel team/org-ab is not readable by a member of org-a (MEMBER of org-a, no segment boundary)", async () => {
		const { t } = await seedWorld();
		const id = await t.run((ctx) =>
			ctx.db.insert("messages", {
				from: "sigma",
				channel: "team/org-ab",
				content: "other-team probe",
				tenantId: ORGAB,
				createdAt: NOW,
			}),
		);
		await expect(
			asMember(t, ORGAB, "org:editor").query(api.messages.getById, {
				messageId: id,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

describe("messages:searchMessagesByKeyword", () => {
	test("messages:searchMessagesByKeyword — the claimless service account is not served client tenants' content (SA, no claim)", async () => {
		const { t } = await seedWorld();
		const rows = (await asSA(t).query(api.messages.searchMessagesByKeyword, {
			query: "probe",
		})) as Array<{ content: string }>;
		expect(rows.filter((x) => /^C[12]-/.test(x.content))).toEqual([]);
	});

	test("messages:searchMessagesByKeyword — a member's search does not return a colleague's user:<subject> message (MEMBER org:editor)", async () => {
		const { t } = await seedWorld();
		const rows = (await asMember(t, C1, "org:editor").query(
			api.messages.searchMessagesByKeyword,
			{ query: "probe" },
		)) as Array<{ content: string }>;
		expect(contents(rows)).not.toContain("C1-TO-USER probe");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLS: the same fixtures, served to the rightful caller. They prove the
// seeded world carries the data the RED tests above look for, so a RED there is
// the door withholding/leaking, never an empty fixture.
describe("controls (must PASS today: the fixture is readable by the rightful caller)", () => {
	const pi = (w: World) => ({ agentId: w.piAgent, orgSlug: FLEET });

	test("CONTROL checkNewMessages — verifiedActor pi (SA transport) reads the client-tenant mail stamped with its ID", async () => {
		const w = await seedWorld();
		const got = await asSA(w.t).query(api.messages.checkNewMessages, {
			verifiedActor: pi(w),
		} as never);
		expect(contents(got)).toEqual(["C1-TO-PI probe"]);
	});

	test("CONTROL getUnreadCount — verifiedActor pi counts 1", async () => {
		const w = await seedWorld();
		expect(
			await asSA(w.t).query(api.messages.getUnreadCount, {
				verifiedActor: pi(w),
			} as never),
		).toBe(1);
	});

	test("CONTROL markAsRead — verifiedActor pi marks its client-tenant receipt", async () => {
		const w = await seedWorld();
		expect(
			await asSA(w.t).mutation(api.messages.markAsRead, {
				receiptIds: [w.r["C1-TO-PI"]],
				callerOrchestrator: "pi",
				verifiedActor: pi(w),
			}),
		).toBe(1);
	});

	test("CONTROL getById/listBroadcastStatus — the deny pole fires for a member of client-b on client-a's message, the allow pole serves client-a's member", async () => {
		const w = await seedWorld();
		await expect(
			asMember(w.t, C2, "org:editor").query(api.messages.getById, {
				messageId: w.m["C1-TO-VEGA"],
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(
			asMember(w.t, C2, "org:editor").query(api.messages.listBroadcastStatus, {
				messageId: w.m["C1-TO-VEGA"],
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		const own = await asMember(w.t, C1, "org:editor").query(
			api.messages.getById,
			{ messageId: w.m["C1-TO-VEGA"] },
		);
		expect(own).not.toBeNull();
	});

	test("CONTROL listByChannel/Paginated — a narrow-roster member with no newer non-roster rows is served its roster rows", async () => {
		const { t } = await seedWorld();
		await seedNarrow(t, 0, 5);
		const rows = await asMember(t, NARROW, "org:editor").query(
			api.messages.listByChannel,
			{ limit: 100 },
		);
		const list = Array.isArray(rows) ? rows : rows.items;
		expect(list).toHaveLength(5);
		const page = await asMember(t, NARROW, "org:editor").query(
			api.messages.listByChannelPaginated,
			{ paginationOpts: { numItems: 100, cursor: null } },
		);
		expect(page.page).toHaveLength(5);
	});

	test("CONTROL deleteMessage — the sender's own org agent identity deletes its message (verifiedActor c1 atlas)", async () => {
		const w = await seedWorld();
		const res = await asSA(w.t).mutation(api.messages.deleteMessage, {
			messageId: w.m["C1-TO-VEGA"],
			callerOrchestrator: "atlas",
			verifiedActor: { agentId: w.c1Atlas, orgSlug: C1 },
		} as never);
		expect(res.deleted).toBe(true);
	});

	test("CONTROL sendMessage — a client-tenant editor sends to a roster peer (positive pole of the member send door; a known agent name demands a credential, hence 'scribe')", async () => {
		const { t } = await seedWorld();
		await asMember(t, C1, "org:editor").mutation(api.messages.sendMessage, {
			from: "scribe",
			channel: "vega",
			content: "editor-send-control",
		});
		const n = await t.run(
			async (ctx) =>
				(await ctx.db.query("messages").collect()).filter(
					(x) => x.content === "editor-send-control",
				).length,
		);
		expect(n).toBe(1);
	});
});
