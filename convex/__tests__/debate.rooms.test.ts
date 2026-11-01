/// <reference types="vite/client" />
/**
 * Debate room, backend functions: tests B1-B20 of
 * /root/coding/sigma-scratch/debate/design.md section 9 (B15 golden frame and
 * B21 validateTemplate live in debate.template.test.ts).
 *
 * Every authorization test runs under a SCOPED identity that is not the room's
 * creator (and never the configured service account, except to carry an agent's
 * `verifiedActor`, which the door believes from the service account only and
 * which does not make the agent a fleet master for the room: that is pinned in
 * B10). Both poles are present: the allowed caller and the refused one.
 *
 * Timers are faked so that nothing scheduled (deliverTurn, expireTurn) fires on
 * its own: each test calls the internal function it is about, explicitly.
 */
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { seedRosterAgent } from "../../tests/fixtures/rosterAgent";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import type { DebateSettings, DebateTemplate } from "../lib/debateTemplate";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);
// Raw source of every convex/*.ts, for the B1 single-writer sweep.
const sources = import.meta.glob("../*.ts", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

type T = ReturnType<typeof convexTest>;
const createT = (): T =>
	convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;

const SERVICE = "test-service-account-user-id";
const ORG = "acme";
const OTHER_ORG = "globex";
const ADMIN = "user_admin_acme"; // org:admin of acme, the room creator
const ADMIN_2 = "user_admin2_acme"; // a second org:admin of acme, NOT the creator
const STRANGER = "user_member_acme"; // org:member of acme, not listed, not admin
const OUTSIDER = "user_admin_globex"; // org:admin of ANOTHER organisation

if ([ADMIN, ADMIN_2, STRANGER, OUTSIDER].includes(SERVICE)) {
	throw new Error("test-integrity: a scoped caller must never be the service account");
}

const as = (t: T, subject: string, org: string, role: string) =>
	t.withIdentity({
		subject,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: role,
	});
const asAdmin = (t: T) => as(t, ADMIN, ORG, "org:admin");
const asAdmin2 = (t: T) => as(t, ADMIN_2, ORG, "org:admin");
const asStranger = (t: T) => as(t, STRANGER, ORG, "org:member");
const asOutsider = (t: T) => as(t, OUTSIDER, OTHER_ORG, "org:admin");
const svc = (t: T) => t.withIdentity({ subject: SERVICE });

const SETTINGS: DebateSettings = {
	maxRoundLimit: 5,
	maxParticipants: 6,
	maxRefusalRows: 2,
	maxTurnMessageChars: 4000,
	pollSeconds: 5,
	maxAnswerCharsCeiling: 500,
	maxLabelChars: 40,
	maxTurnInstructionChars: 400,
	maxActiveRooms: 10,
};

// The agent IDs of the world under test (set by `world()`): a template names its
// agents by ID, so the builders read them here.
let AGENT = {} as Record<"sigma" | "eta" | "foreignSigma", Id<"agents">>;

const withHuman = (over: Partial<DebateTemplate> = {}): DebateTemplate => ({
	id: "review",
	name: "Review",
	language: "en",
	turnInstruction: "Answer in one paragraph.",
	participants: [
		{ id: "p1", label: "operator", kind: "human", transport: "human", deadlineSeconds: null },
		{ id: "p2", label: "sigma", kind: "agent", agentId: AGENT.sigma, transport: "waker" },
		{ id: "p3", label: "eta", kind: "agent", agentId: AGENT.eta, transport: "waker" },
	],
	roundLimit: 2,
	maxAnswerChars: 100,
	turnDeadlineSeconds: 3600,
	maxConsecutiveSkips: 2,
	voiceEnabled: false,
	...over,
});

const agentsOnly = (over: Partial<DebateTemplate> = {}): DebateTemplate =>
	withHuman({
		id: "agents",
		participants: [
			{ id: "p2", label: "sigma", kind: "agent", agentId: AGENT.sigma, transport: "waker" },
			{ id: "p3", label: "eta", kind: "agent", agentId: AGENT.eta, transport: "waker" },
		],
		...over,
	});

type World = {
	t: T;
	agents: Record<"sigma" | "eta" | "foreignSigma", Id<"agents">>;
};

async function world(settings: Partial<DebateSettings> = {}): Promise<World> {
	const t = createT();
	const agents = await t.run(async (ctx) => {
		for (const [slug, roster] of [
			[ORG, ["sigma", "eta"]],
			[OTHER_ORG, ["sigma"]],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [...roster],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: 1,
			});
		}
		const sigma = await seedRosterAgent(ctx, ORG, "sigma");
		const eta = await seedRosterAgent(ctx, ORG, "eta");
		const foreignSigma = await seedRosterAgent(ctx, OTHER_ORG, "sigma");
		for (const name of ["sigma", "eta"]) {
			await ctx.db.insert("profiles", {
				orchestratorId: name,
				name,
				static: { role: name, workspace: "w", capabilities: [] },
				dynamic: { lastSeen: 1, sessionCount: 1 },
			});
		}
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:member"],
			updatedAt: 1,
		});
		return { sigma, eta, foreignSigma };
	});
	AGENT = agents;
	await asAdmin(t).mutation(api.debate.upsertSettings, { ...SETTINGS, ...settings });
	return { t, agents };
}

/** Creates a room from `template` as the creator (ADMIN). */
async function makeRoom(
	w: World,
	template: DebateTemplate,
	subject = "Should we ship?",
): Promise<Id<"debateRooms">> {
	const templateId = await asAdmin(w.t).mutation(api.debate.upsertTemplate, { template });
	return await asAdmin(w.t).mutation(api.debate.createRoom, { templateId, subject });
}

type Name = "sigma" | "eta";
const postAgent = (
	w: World,
	name: Name,
	roomId: Id<"debateRooms">,
	turnSeq: number,
	text = "an answer",
	extra: { done?: boolean } = {},
) =>
	svc(w.t).mutation(api.debate.postTurn, {
		roomId,
		turnSeq,
		text,
		...extra,
		verifiedActor: { agentId: w.agents[name], orgSlug: ORG },
	});
const postOperator = (w: World, roomId: Id<"debateRooms">, turnSeq: number, text = "go") =>
	asAdmin(w.t).mutation(api.debate.postTurn, { roomId, turnSeq, text });
const deliver = (w: World, roomId: Id<"debateRooms">, turnSeq: number) =>
	w.t.mutation(internal.debate.deliverTurn, { roomId, turnSeq });
const expire = (w: World, roomId: Id<"debateRooms">, turnSeq: number) =>
	w.t.mutation(internal.debate.expireTurn, { roomId, turnSeq });

const roomOf = (w: World, id: Id<"debateRooms">) =>
	w.t.run(async (ctx) => {
		const r = await ctx.db.get(id);
		if (r === null) throw new Error("room vanished");
		return r;
	});
const turnsOf = (w: World, id: Id<"debateRooms">): Promise<Doc<"debateTurns">[]> =>
	w.t.run((ctx) =>
		// convexTest's loosely typed ctx has no schema indexes: type the reader once here.
		(ctx.db as unknown as DatabaseReader)
			.query("debateTurns")
			.withIndex("by_room_seq", (q) => q.eq("roomId", id))
			.collect(),
	);
const scheduledNames = (w: World): Promise<string[]> =>
	w.t.run(async (ctx) =>
		(await ctx.db.system.query("_scheduled_functions").collect()).map(
			(s) => `${s.name} ${JSON.stringify(s.args)}`,
		),
	);

/** The refusal payload or "NO_ERROR". */
async function failure(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "NO_ERROR";
	} catch (e) {
		if (e instanceof ConvexError) return String(e.data);
		return `NOT_A_CONVEX_ERROR: ${String(e)}`;
	}
}

type Refused = { refused: string; awaiting: string | null; turnSeq: number };
type Accepted = { accepted: true; turnSeq: number; closed: boolean; closeReason?: string; workDuringTurn: string };
const asRefused = (r: unknown): Refused => {
	if (typeof r !== "object" || r === null || !("refused" in r)) {
		throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
	}
	return r as Refused;
};
const asAccepted = (r: unknown): Accepted => {
	if (typeof r !== "object" || r === null || !("accepted" in r)) {
		throw new Error(`expected an acceptance, got ${JSON.stringify(r)}`);
	}
	return r as Accepted;
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
});
afterEach(() => {
	vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("anonymous callers are refused by raising, never by an empty success", () => {
	test("createRoom, postTurn, getRoom and the template/settings doors raise RBAC_DENIED naming the door", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		const templateId = (await asAdmin(w.t).query(api.debate.listTemplates, {}))[0]._id;
		const calls: Array<[string, Promise<unknown>]> = [
			["debate:createRoom", w.t.mutation(api.debate.createRoom, { templateId, subject: "s" })],
			["debate:postTurn", w.t.mutation(api.debate.postTurn, { roomId, turnSeq: 1, text: "x" })],
			["debate:getRoom", w.t.query(api.debate.getRoom, { roomId })],
			["debate:closeRoom", w.t.mutation(api.debate.closeRoom, { roomId })],
			["debate:listTemplates", w.t.query(api.debate.listTemplates, {})],
			["debate:getSettings", w.t.query(api.debate.getSettings, {})],
		];
		for (const [door, call] of calls) {
			const msg = await failure(call);
			expect(msg, door).toContain("RBAC_DENIED");
			expect(msg, door).toContain(door);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("settings and templates (data, tenant-scoped)", () => {
	test("an org:admin writes settings and reads them back; a plain member is refused; another tenant sees none", async () => {
		const w = await world();
		expect(await asAdmin(w.t).query(api.debate.getSettings, {})).toMatchObject(SETTINGS);
		const refused = await failure(asStranger(w.t).mutation(api.debate.upsertSettings, SETTINGS));
		expect(refused).toContain("RBAC_DENIED");
		expect(refused).toContain("role-not-admin");
		// a member may READ its own tenant's settings; another tenant has none
		expect(await asStranger(w.t).query(api.debate.getSettings, {})).toMatchObject(SETTINGS);
		expect(await asOutsider(w.t).query(api.debate.getSettings, {})).toBeNull();
	});

	test("invalid settings are refused with the field path and nothing is stored", async () => {
		const w = await world();
		const msg = await failure(
			asAdmin(w.t).mutation(api.debate.upsertSettings, { ...SETTINGS, maxRoundLimit: 0 }),
		);
		expect(msg).toContain("DEBATE_SETTINGS_INVALID");
		expect(msg).toContain("maxRoundLimit");
		expect((await asAdmin(w.t).query(api.debate.getSettings, {}))?.maxRoundLimit).toBe(
			SETTINGS.maxRoundLimit,
		);
	});

	test("upsertTemplate validates (field path in the refusal), is admin-only and tenant-scoped", async () => {
		const w = await world();
		const bad = withHuman({ roundLimit: 99 });
		const msg = await failure(asAdmin(w.t).mutation(api.debate.upsertTemplate, { template: bad }));
		expect(msg).toContain("DEBATE_TEMPLATE_INVALID");
		expect(msg).toContain("roundLimit");
		const denied = await failure(
			asStranger(w.t).mutation(api.debate.upsertTemplate, { template: withHuman() }),
		);
		expect(denied).toContain("role-not-admin");

		await asAdmin(w.t).mutation(api.debate.upsertTemplate, { template: withHuman() });
		expect(await asAdmin(w.t).query(api.debate.listTemplates, {})).toHaveLength(1);
		expect(await asOutsider(w.t).query(api.debate.listTemplates, {})).toHaveLength(0);
	});

	test("upserting the same template id updates the row instead of adding one", async () => {
		const w = await world();
		const a = await asAdmin(w.t).mutation(api.debate.upsertTemplate, { template: withHuman() });
		const b = await asAdmin(w.t).mutation(api.debate.upsertTemplate, {
			template: withHuman({ turnInstruction: "Answer in two lines." }),
		});
		expect(b).toBe(a);
		const list = await asAdmin(w.t).query(api.debate.listTemplates, {});
		expect(list).toHaveLength(1);
		expect(list[0].template.turnInstruction).toBe("Answer in two lines.");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("createRoom", () => {
	test("ALLOW: stamps the tenant, freezes template and settings, points at position 0 and schedules the first delivery", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		const room = await roomOf(w, roomId);
		expect(room).toMatchObject({
			tenantId: ORG,
			tenantOrgId: testClerkOrgId(ORG),
			status: "active",
			round: 1,
			position: 0,
			turnSeq: 1,
			createdBy: `user:${ADMIN}`,
			createdById: `user:${ADMIN}`,
			subject: "Should we ship?",
			refusalRows: 0,
			refusalsOverflow: 0,
		});
		expect(room.awaiting?.participantId).toBe("p1");
		expect(room.template.participants).toHaveLength(3);
		expect(room.settings).toMatchObject(SETTINGS);
		const scheduled = await scheduledNames(w);
		expect(scheduled.some((s) => s.includes("deliverTurn") && s.includes('"turnSeq":1'))).toBe(true);
	});

	test("DENY: a seat naming an agent that is not an active agent of this organisation is refused at save and at creation, and no room is written", async () => {
		const w = await world();
		const seat = (agentId: Id<"agents">): DebateTemplate =>
			withHuman({
				participants: [
					{ id: "p1", label: "operator", kind: "human", transport: "human", deadlineSeconds: null },
					{ id: "p2", label: "zeta", kind: "agent", agentId, transport: "waker" },
				],
			});
		// another organisation's agent
		const foreign = await failure(makeRoom(w, seat(w.agents.foreignSigma)));
		expect(foreign).toContain("RBAC_DENIED");
		// an agent of this organisation that was switched off
		const off = await w.t.run((ctx) => seedRosterAgent(ctx, ORG, "zeta"));
		await w.t.run((ctx) => ctx.db.patch(off, { isActive: false }));
		const inactive = await failure(makeRoom(w, seat(off)));
		expect(inactive).toContain("RBAC_DENIED");
		expect(inactive).toContain("principal-inactive");
		// a row that is no agent at all
		const gone = await w.t.run(async (ctx) => {
			const id = await seedRosterAgent(ctx, ORG, "ghost");
			await ctx.db.delete(id);
			return id;
		});
		expect(await failure(makeRoom(w, seat(gone)))).toContain("RBAC_DENIED");
		expect(await w.t.run((ctx) => ctx.db.query("debateRooms").collect())).toHaveLength(0);
		expect(await asAdmin(w.t).query(api.debate.listTemplates, {})).toHaveLength(0);
	});

	test("DENY: a template saved while its agent was valid is judged again at creation (the agent was switched off since)", async () => {
		const w = await world();
		const templateId = await asAdmin(w.t).mutation(api.debate.upsertTemplate, { template: withHuman() });
		await w.t.run((ctx) => ctx.db.patch(w.agents.eta, { isActive: false }));
		const msg = await failure(asAdmin(w.t).mutation(api.debate.createRoom, { templateId, subject: "s" }));
		expect(msg).toContain("principal-inactive");
		expect(await w.t.run((ctx) => ctx.db.query("debateRooms").collect())).toHaveLength(0);
	});

	test("DENY: no settings row for the tenant -> DEBATE_SETTINGS_MISSING (the mechanism holds no default limits)", async () => {
		const w = await world();
		await w.t.run(async (ctx) => {
			for (const s of await ctx.db.query("debateSettings").collect()) await ctx.db.delete(s._id);
		});
		const msg = await failure(makeRoom(w, withHuman()));
		expect(msg).toContain("DEBATE_SETTINGS_MISSING");
	});

	test("DENY: another tenant's template id is not found (same refusal as a missing one)", async () => {
		const w = await world();
		const templateId = await asAdmin(w.t).mutation(api.debate.upsertTemplate, { template: withHuman() });
		const msg = await failure(asOutsider(w.t).mutation(api.debate.createRoom, { templateId, subject: "s" }));
		expect(msg).toContain("DEBATE_TEMPLATE_NOT_FOUND");
	});

	test("DENY: an empty or oversized subject", async () => {
		const w = await world();
		const templateId = await asAdmin(w.t).mutation(api.debate.upsertTemplate, { template: withHuman() });
		expect(await failure(asAdmin(w.t).mutation(api.debate.createRoom, { templateId, subject: "  " }))).toContain(
			"DEBATE_SUBJECT_INVALID",
		);
		expect(
			await failure(
				asAdmin(w.t).mutation(api.debate.createRoom, { templateId, subject: "x".repeat(SETTINGS.maxAnswerCharsCeiling + 1) }),
			),
		).toContain("DEBATE_SUBJECT_INVALID");
	});

	test("DENY: a caller without a writer role cannot create a room", async () => {
		const w = await world();
		const templateId = await asAdmin(w.t).mutation(api.debate.upsertTemplate, { template: withHuman() });
		await w.t.run(async (ctx) => {
			for (const r of await ctx.db.query("memberWriterRoles").collect()) await ctx.db.patch(r._id, { roles: ["org:admin"] });
		});
		const msg = await failure(
			as(w.t, "user_viewer_acme", ORG, "org:viewer").mutation(api.debate.createRoom, { templateId, subject: "s" }),
		);
		expect(msg).toContain("RBAC_DENIED");
		expect(await w.t.run((ctx) => ctx.db.query("debateRooms").collect())).toHaveLength(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("B14 deliverTurn: exactly one message, one receipt, to the participant's channel", () => {
	test("sends one message from the creator, stores messageId/deliveredAt/deadlineAt and schedules the expiry", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		await postOperator(w, roomId, 1, "Start with the risks.");
		await deliver(w, roomId, 2);

		const messages = await w.t.run((ctx) => ctx.db.query("messages").collect());
		const receipts = await w.t.run((ctx) => ctx.db.query("messageReceipts").collect());
		expect(messages).toHaveLength(1);
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({ recipient: "sigma", tenantId: ORG });
		expect(receipts[0].messageId).toBe(messages[0]._id);
		expect(messages[0]).toMatchObject({ channel: "sigma", from: `user:${ADMIN}`, tenantId: ORG });
		expect(messages[0].content).toContain("[DEBATE-TURN]");
		expect(messages[0].content).toContain(`room ${roomId}`);
		expect(messages[0].content).toContain("turnSeq 2");
		expect(messages[0].content).toContain("Start with the risks.");

		const room = await roomOf(w, roomId);
		const now = Date.now();
		expect(room.awaiting).toMatchObject({ participantId: "p2", messageId: messages[0]._id, deliveredAt: now });
		expect(room.awaiting?.deadlineAt).toBe(now + 3600 * 1000);
		const scheduled = await scheduledNames(w);
		expect(scheduled.some((s) => s.includes("expireTurn") && s.includes('"turnSeq":2'))).toBe(true);
	});

	test("a second delivery of the same turn sends nothing more (idempotent)", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		await postOperator(w, roomId, 1);
		await deliver(w, roomId, 2);
		await deliver(w, roomId, 2);
		expect(await w.t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(1);
		expect(await w.t.run((ctx) => ctx.db.query("messageReceipts").collect())).toHaveLength(1);
	});

	test("a delivery for a turn that is no longer the current one sends nothing", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		await postOperator(w, roomId, 1);
		await deliver(w, roomId, 1); // the room is already at seq 2
		expect(await w.t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(0);
	});

	test("a human seat's turn sends no message and schedules no expiry (it waits, shown as waiting)", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		await deliver(w, roomId, 1);
		expect(await w.t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(0);
		const room = await roomOf(w, roomId);
		expect(room.awaiting?.deliveredAt).toBe(Date.now());
		expect(room.awaiting?.deadlineAt).toBeUndefined();
		expect((await scheduledNames(w)).some((s) => s.includes("expireTurn"))).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("B2 / B3 / B4 / B5 postTurn refusals, in the order of design section 2", () => {
	test("B2 not_your_turn: a listed agent that is not awaited is refused AND a body-less refused row exists; the awaited one is accepted", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		await postOperator(w, roomId, 1);
		const wrong = asRefused(await postAgent(w, "eta", roomId, 2, "I jump the queue"));
		expect(wrong).toEqual({ refused: "not_your_turn", awaiting: "sigma", turnSeq: 2 });
		const rows = await turnsOf(w, roomId);
		const refusedRow = rows.find((r) => r.kind === "refused");
		expect(refusedRow).toBeDefined();
		expect(refusedRow).toMatchObject({ participantId: "p3", reason: "not_your_turn", round: 1 });
		expect(refusedRow?.text).toBeUndefined();
		expect(JSON.stringify(rows)).not.toContain("I jump the queue");
		expect((await roomOf(w, roomId)).turnSeq).toBe(2);

		const ok = asAccepted(await postAgent(w, "sigma", roomId, 2, "my answer"));
		expect(ok.turnSeq).toBe(2);
		const room = await roomOf(w, roomId);
		expect(room.turnSeq).toBe(3);
		expect(room.awaiting?.participantId).toBe("p3");
		expect((await turnsOf(w, roomId)).filter((r) => r.kind === "answer")).toMatchObject([
			{ participantId: "p2", text: "my answer", turnSeq: 2, round: 1, position: 1 },
		]);
	});

	test("the operator's own seat posts as a human: kind operator", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		const r = asAccepted(await postOperator(w, roomId, 1, "Start with the risks."));
		expect(r.closed).toBe(false);
		expect((await turnsOf(w, roomId))[0]).toMatchObject({ kind: "operator", participantId: "p1", text: "Start with the risks." });
	});

	test("B3 stale_turn: an earlier, a later and an equal turnSeq", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		await postOperator(w, roomId, 1);
		expect(asRefused(await postAgent(w, "sigma", roomId, 1))).toMatchObject({ refused: "stale_turn", turnSeq: 2 });
		expect(asRefused(await postAgent(w, "sigma", roomId, 9))).toMatchObject({ refused: "stale_turn", turnSeq: 2 });
		expect(asAccepted(await postAgent(w, "sigma", roomId, 2)).turnSeq).toBe(2);
	});

	test("B4 room_closed / room_stalled: a closed or stalled room refuses every post", async () => {
		const w = await world();
		const closed = await makeRoom(w, withHuman());
		await asAdmin(w.t).mutation(api.debate.closeRoom, { roomId: closed });
		expect(asRefused(await postOperator(w, closed, 1)).refused).toBe("room_closed");

		const stalled = await makeRoom(w, withHuman({ id: "second" }));
		await w.t.run((ctx) => ctx.db.patch(stalled, { status: "stalled" }));
		expect(asRefused(await postOperator(w, stalled, 1)).refused).toBe("room_stalled");
	});

	test("B5 a second post for the same turnSeq is refused", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		await postOperator(w, roomId, 1);
		asAccepted(await postAgent(w, "sigma", roomId, 2));
		expect(asRefused(await postAgent(w, "sigma", roomId, 2, "again")).refused).toBe("stale_turn");
		expect((await turnsOf(w, roomId)).filter((r) => r.kind === "answer")).toHaveLength(1);
	});

	test("empty and too_long are refused after the turn checks; the limit is the room's frozen maxAnswerChars", async () => {
		const w = await world();
		const roomId = await makeRoom(w, agentsOnly({ maxAnswerChars: 10 }));
		expect(asRefused(await postAgent(w, "sigma", roomId, 1, "   ")).refused).toBe("empty");
		expect(asRefused(await postAgent(w, "sigma", roomId, 1, "x".repeat(11))).refused).toBe("too_long");
		expect(asAccepted(await postAgent(w, "sigma", roomId, 1, "x".repeat(10))).turnSeq).toBe(1);
		// order: a not-awaited caller with an empty text gets not_your_turn, not empty
		expect(asRefused(await postAgent(w, "sigma", roomId, 2, "")).refused).toBe("not_your_turn");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("B6 / B7 expireTurn", () => {
	test("B6 at the deadline with a matching turnSeq: a skipped row, the pointer moves and the next delivery is scheduled", async () => {
		const w = await world();
		const roomId = await makeRoom(w, agentsOnly());
		await deliver(w, roomId, 1);
		const deadline = (await roomOf(w, roomId)).awaiting?.deadlineAt;
		await expire(w, roomId, 1);
		const rows = await turnsOf(w, roomId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "skipped",
			participantId: "p2",
			text: "no answer by deadline",
			deadlineAt: deadline,
			turnSeq: 1,
		});
		const room = await roomOf(w, roomId);
		expect(room.turnSeq).toBe(2);
		expect(room.awaiting?.participantId).toBe("p3");
		expect(room.participantState.find((s: Doc<"debateRooms">["participantState"][number]) => s.participantId === "p2")).toMatchObject({
			consecutiveSkips: 1,
			dropped: false,
		});
		expect((await scheduledNames(w)).some((s) => s.includes("deliverTurn") && s.includes('"turnSeq":2'))).toBe(true);
	});

	test("B7 after the turn was answered, expireTurn writes no row and does not advance (positive pole of B6)", async () => {
		const w = await world();
		const roomId = await makeRoom(w, agentsOnly());
		await deliver(w, roomId, 1);
		asAccepted(await postAgent(w, "sigma", roomId, 1));
		const before = { rows: await turnsOf(w, roomId), room: await roomOf(w, roomId) };
		await expire(w, roomId, 1);
		expect(await turnsOf(w, roomId)).toEqual(before.rows);
		expect(await roomOf(w, roomId)).toEqual(before.room);
	});

	test("expireTurn on a closed room is a no-op", async () => {
		const w = await world();
		const roomId = await makeRoom(w, agentsOnly());
		await asAdmin(w.t).mutation(api.debate.closeRoom, { roomId });
		const rows = await turnsOf(w, roomId);
		await expire(w, roomId, 1);
		expect(await turnsOf(w, roomId)).toEqual(rows);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("B8 pointer and wrap-around", () => {
	test("after the last position the pointer wraps to round+1, position 0", async () => {
		const w = await world();
		const roomId = await makeRoom(w, agentsOnly({ roundLimit: 3 }));
		await postAgent(w, "sigma", roomId, 1);
		let room = await roomOf(w, roomId);
		expect([room.round, room.position, room.turnSeq]).toEqual([1, 1, 2]);
		await postAgent(w, "eta", roomId, 2);
		room = await roomOf(w, roomId);
		expect([room.round, room.position, room.turnSeq]).toEqual([2, 0, 3]);
		expect(room.awaiting?.participantId).toBe("p2");
	});

	test("a dropped participant is skipped in the order", async () => {
		const w = await world();
		const roomId = await makeRoom(w, agentsOnly({ roundLimit: 3, maxConsecutiveSkips: 1 }));
		await postAgent(w, "sigma", roomId, 1);
		await expire(w, roomId, 2); // eta skipped once -> dropped (limit 1)
		let room = await roomOf(w, roomId);
		expect(room.participantState.find((s: Doc<"debateRooms">["participantState"][number]) => s.participantId === "p3")?.dropped).toBe(true);
		expect([room.round, room.position]).toEqual([2, 0]);
		await postAgent(w, "sigma", roomId, 3);
		room = await roomOf(w, roomId);
		// sigma was the last LIVE position of round 2: the pointer wraps over dropped eta
		expect([room.round, room.position, room.status]).toEqual([3, 0, "active"]);
		expect(room.awaiting?.participantId).toBe("p2");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("B9 / B11 / B12 / B13 stop rules", () => {
	test("B9 round_limit closes only when the last position of the last round is resolved", async () => {
		const w = await world();
		const roomId = await makeRoom(w, agentsOnly({ roundLimit: 2 }));
		await postAgent(w, "sigma", roomId, 1);
		await postAgent(w, "eta", roomId, 2);
		await postAgent(w, "sigma", roomId, 3);
		let room = await roomOf(w, roomId);
		expect(room.status).toBe("active"); // eta of round 2 is still awaited
		expect(room.awaiting?.participantId).toBe("p3");
		const last = asAccepted(await postAgent(w, "eta", roomId, 4));
		expect(last).toMatchObject({ closed: true, closeReason: "round_limit" });
		room = await roomOf(w, roomId);
		expect(room).toMatchObject({ status: "closed", closeReason: "round_limit" });
		expect(room.awaiting).toBeUndefined();
		const final = (await turnsOf(w, roomId)).at(-1);
		expect(final).toMatchObject({ kind: "system", reason: "round_limit" });
	});

	test("B10 closeRoom: creator and a second org:admin close (operator_stop); a plain member, a participant agent and another tenant are refused", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		// refused poles first: nothing may change
		const stranger = await failure(asStranger(w.t).mutation(api.debate.closeRoom, { roomId }));
		expect(stranger).toContain("RBAC_DENIED");
		expect(stranger).toContain("role-not-admin"); // the package: a member of the room's organisation is no administrator
		const agent = await failure(svc(w.t).mutation(api.debate.closeRoom, { roomId })); // an agent never closes: the door is session-only
		expect(agent).toContain("RBAC_DENIED");
		expect(agent).toContain("debate:closeRoom");
		const outsider = await failure(asOutsider(w.t).mutation(api.debate.closeRoom, { roomId }));
		expect(outsider).toContain("RBAC_DENIED");
		expect(outsider).toContain("debate:closeRoom");
		// a room that does not exist is refused exactly like another organisation's room
		const absent = await makeRoom(w, withHuman({ id: "to-delete" }));
		await w.t.run((ctx) => ctx.db.delete(absent));
		expect(await failure(asOutsider(w.t).mutation(api.debate.closeRoom, { roomId: absent }))).toBe(outsider);
		expect((await roomOf(w, roomId)).status).toBe("active");

		// allowed poles
		await asAdmin2(w.t).mutation(api.debate.closeRoom, { roomId });
		const room = await roomOf(w, roomId);
		expect(room).toMatchObject({ status: "closed", closeReason: "operator_stop" });
		const final = (await turnsOf(w, roomId)).at(-1);
		expect(final).toMatchObject({ kind: "system", reason: "operator_stop", writer: "closeRoom" });

		const second = await makeRoom(w, withHuman({ id: "second" }));
		await asAdmin(w.t).mutation(api.debate.closeRoom, { roomId: second });
		expect((await roomOf(w, second)).closeReason).toBe("operator_stop");
	});

	test("closeRoom on an already closed room writes nothing more", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		await asAdmin(w.t).mutation(api.debate.closeRoom, { roomId });
		const rows = await turnsOf(w, roomId);
		await asAdmin(w.t).mutation(api.debate.closeRoom, { roomId });
		expect(await turnsOf(w, roomId)).toEqual(rows);
	});

	test("B11 all_done: every live agent answered done:true in the same round closes; one without done does not", async () => {
		const w = await world();
		const open = await makeRoom(w, agentsOnly({ roundLimit: 5 }));
		await postAgent(w, "sigma", open, 1, "nothing to add", { done: true });
		const r1 = asAccepted(await postAgent(w, "eta", open, 2, "one more point", { done: false }));
		expect(r1.closed).toBe(false);
		expect((await roomOf(w, open)).round).toBe(2);

		const done = await makeRoom(w, agentsOnly({ id: "agents-b", roundLimit: 5 }));
		await postAgent(w, "sigma", done, 1, "nothing to add", { done: true });
		const r2 = asAccepted(await postAgent(w, "eta", done, 2, "nothing to add", { done: true }));
		expect(r2).toMatchObject({ closed: true, closeReason: "all_done" });
		expect((await roomOf(w, done)).closeReason).toBe("all_done");
	});

	test("B11 the operator's own seat does not count toward all_done", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman({ roundLimit: 5 }));
		await postOperator(w, roomId, 1, "go"); // human, no done flag
		await postAgent(w, "sigma", roomId, 2, "x", { done: true });
		const r = asAccepted(await postAgent(w, "eta", roomId, 3, "x", { done: true }));
		expect(r).toMatchObject({ closed: true, closeReason: "all_done" });
	});

	test("B12 all_silent: every agent row of the round skipped closes; one answer keeps it open", async () => {
		const w = await world();
		const silent = await makeRoom(w, agentsOnly({ roundLimit: 5, maxConsecutiveSkips: 5 }));
		await expire(w, silent, 1);
		await expire(w, silent, 2);
		expect(await roomOf(w, silent)).toMatchObject({ status: "closed", closeReason: "all_silent" });

		const mixed = await makeRoom(w, agentsOnly({ id: "agents-b", roundLimit: 5, maxConsecutiveSkips: 5 }));
		await postAgent(w, "sigma", mixed, 1);
		await expire(w, mixed, 2);
		expect(await roomOf(w, mixed)).toMatchObject({ status: "active", round: 2 });
	});

	test("B13 dropped row at maxConsecutiveSkips, none before; no live agent left closes all_silent", async () => {
		const w = await world();
		const roomId = await makeRoom(w, agentsOnly({ roundLimit: 5, maxConsecutiveSkips: 2 }));
		await expire(w, roomId, 1); // sigma skip 1 (before the limit)
		expect((await turnsOf(w, roomId)).some((r) => r.kind === "dropped")).toBe(false);
		await postAgent(w, "eta", roomId, 2);
		await expire(w, roomId, 3); // sigma skip 2 -> at the limit
		const dropped = (await turnsOf(w, roomId)).filter((r) => r.kind === "dropped");
		expect(dropped).toHaveLength(1);
		expect(dropped[0].participantId).toBe("p2");
		expect((await roomOf(w, roomId)).status).toBe("active"); // eta still live

		const lone = await makeRoom(w, agentsOnly({ id: "agents-b", roundLimit: 5, maxConsecutiveSkips: 1 }));
		await expire(w, lone, 1); // sigma dropped, eta live
		expect((await roomOf(w, lone)).status).toBe("active");
		await expire(w, lone, 2); // eta dropped, nobody live
		const room = await roomOf(w, lone);
		expect(room).toMatchObject({ status: "closed", closeReason: "all_silent" });
		expect((await turnsOf(w, lone)).map((r) => r.kind)).toEqual(["skipped", "dropped", "skipped", "dropped", "system"]);
	});

	test("an answer resets the consecutive-skip counter", async () => {
		const w = await world();
		const roomId = await makeRoom(w, agentsOnly({ roundLimit: 5, maxConsecutiveSkips: 2 }));
		await expire(w, roomId, 1); // sigma skip 1
		await postAgent(w, "eta", roomId, 2);
		await postAgent(w, "sigma", roomId, 3); // answers: counter back to 0
		await postAgent(w, "eta", roomId, 4);
		await expire(w, roomId, 5); // sigma skip 1 again, not 2
		expect((await turnsOf(w, roomId)).some((r) => r.kind === "dropped")).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("B16 tenancy and listing", () => {
	test("readers: creator and listed agents read; an unlisted member of the same tenant, another tenant and a same-named agent of another tenant read nothing", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		await postOperator(w, roomId, 1, "Start with the risks.");

		const asCreator = await asAdmin(w.t).query(api.debate.getRoom, { roomId });
		expect(asCreator?.room.subject).toBe("Should we ship?");
		expect(asCreator?.turns).toHaveLength(1);

		const listedAgent = await svc(w.t).query(api.debate.getRoom, {
			roomId,
			verifiedActor: { agentId: w.agents.eta, orgSlug: ORG },
		});
		expect(listedAgent?.turns).toHaveLength(1);

		expect(await asStranger(w.t).query(api.debate.getRoom, { roomId })).toBeNull();
		expect(await asOutsider(w.t).query(api.debate.getRoom, { roomId })).toBeNull();
		expect(
			await svc(w.t).query(api.debate.getRoom, {
				roomId,
				verifiedActor: { agentId: w.agents.foreignSigma, orgSlug: OTHER_ORG },
			}),
		).toBeNull();
	});

	test("writers: an unlisted member, another tenant's admin and another tenant's same-named agent are refused not_a_participant, with no row and no awaiting leak", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		await postOperator(w, roomId, 1);
		const before = await turnsOf(w, roomId);
		const callers: Array<[string, Promise<unknown>]> = [
			["unlisted member", asStranger(w.t).mutation(api.debate.postTurn, { roomId, turnSeq: 2, text: "hi" })],
			["other tenant admin", asOutsider(w.t).mutation(api.debate.postTurn, { roomId, turnSeq: 2, text: "hi" })],
			[
				"other tenant agent named sigma",
				svc(w.t).mutation(api.debate.postTurn, {
					roomId,
					turnSeq: 2,
					text: "hi",
					verifiedActor: { agentId: w.agents.foreignSigma, orgSlug: OTHER_ORG },
				}),
			],
		];
		for (const [who, call] of callers) {
			expect(asRefused(await call), who).toEqual({ refused: "not_a_participant", awaiting: null, turnSeq: 2 });
		}
		expect(await turnsOf(w, roomId)).toEqual(before);
		expect(await roomOf(w, roomId)).toMatchObject({ turnSeq: 2, refusalRows: 0 });
	});

	test("a room id that does not exist answers like a room the caller may not see", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		await w.t.run((ctx) => ctx.db.delete(roomId));
		expect(asRefused(await postOperator(w, roomId, 1)).refused).toBe("not_a_participant");
		expect(await asAdmin(w.t).query(api.debate.getRoom, { roomId })).toBeNull();
	});

	test("the agent write goes through resolveAgentWriter: ALLOWED for a valid claim, REFUSED claimless, REFUSED across organisations", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		await postOperator(w, roomId, 1);
		// ALLOWED: the service account vouches for the room's own agent in its own organisation.
		const ok = await postAgent(w, "sigma", roomId, 2, "an answer");
		expect(ok).toMatchObject({ accepted: true });
		// REFUSED: the service account without a claim (it acts in an organisation only through one).
		const claimless = await failure(
			svc(w.t).mutation(api.debate.postTurn, { roomId, turnSeq: 3, text: "x" }),
		);
		expect(claimless).toContain("RBAC_DENIED");
		expect(claimless).toContain("debate:postTurn");
		// REFUSED: another organisation's agent (resolved by its stored IDs) is no participant; nothing is written.
		const before = await turnsOf(w, roomId);
		const crossOrg = await svc(w.t).mutation(api.debate.postTurn, {
			roomId,
			turnSeq: 3,
			text: "x",
			verifiedActor: { agentId: w.agents.foreignSigma, orgSlug: ORG },
		});
		expect(asRefused(crossOrg)).toEqual({ refused: "not_a_participant", awaiting: null, turnSeq: 3 });
		expect(await turnsOf(w, roomId)).toEqual(before);
		// REFUSED: the scoped member cannot vouch for an agent (covered by the next test); a deleted agent is refused by the package.
		const gone = await w.t.run(async (ctx) => {
			await ctx.db.delete(w.agents.eta);
			return w.agents.eta;
		});
		const missing = await failure(
			svc(w.t).mutation(api.debate.postTurn, {
				roomId,
				turnSeq: 3,
				text: "x",
				verifiedActor: { agentId: gone, orgSlug: ORG },
			}),
		);
		expect(missing).toContain("RBAC_DENIED");
	});

	test("an agent whose verifiedActor is not what the service account may vouch for is refused", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		// a SCOPED org member cannot vouch for an agent: verifiedActor is believed from the service account only
		const msg = await failure(
			asAdmin(w.t).mutation(api.debate.postTurn, {
				roomId,
				turnSeq: 1,
				text: "x",
				verifiedActor: { agentId: w.agents.sigma, orgSlug: ORG },
			}),
		);
		expect(msg).toContain("RBAC_DENIED");
		expect(msg).toContain("standing-not-allowed");
		expect(msg).toContain("debate:postTurn");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("B17 the room reads its frozen template", () => {
	test("editing the template afterwards changes neither the running room nor its limits", async () => {
		const w = await world();
		const roomId = await makeRoom(w, agentsOnly({ maxAnswerChars: 60, turnInstruction: "Original wording." }));
		const frozen = (await roomOf(w, roomId)).template;
		await asAdmin(w.t).mutation(api.debate.upsertTemplate, {
			template: agentsOnly({ maxAnswerChars: 5, turnInstruction: "Edited wording.", roundLimit: 1 }),
		});
		expect((await roomOf(w, roomId)).template).toEqual(frozen);
		// the running room still allows 60 characters
		expect(asAccepted(await postAgent(w, "sigma", roomId, 1, "y".repeat(60))).turnSeq).toBe(1);
		// and a NEW room picks up the edit
		const templateId = (await asAdmin(w.t).query(api.debate.listTemplates, {}))[0]._id;
		const fresh = await asAdmin(w.t).mutation(api.debate.createRoom, { templateId, subject: "again" });
		expect((await roomOf(w, fresh)).template).toMatchObject({ maxAnswerChars: 5, turnInstruction: "Edited wording." });
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("B18 refused rows are capped by settings.maxRefusalRows", () => {
	test("beyond the cap only refusalsOverflow grows, and the room shows both counters", async () => {
		const w = await world(); // maxRefusalRows = 2
		const roomId = await makeRoom(w, agentsOnly());
		for (let i = 0; i < 4; i++) {
			expect(asRefused(await postAgent(w, "eta", roomId, 1, `try ${i}`)).refused).toBe("not_your_turn");
		}
		expect((await turnsOf(w, roomId)).filter((r) => r.kind === "refused")).toHaveLength(2);
		const room = await roomOf(w, roomId);
		expect(room).toMatchObject({ refusalRows: 2, refusalsOverflow: 2 });
		const view = await asAdmin(w.t).query(api.debate.getRoom, { roomId });
		expect(view?.room.refusalsOverflow).toBe(2);
	});

	test("a cap of 0 writes no refused row at all", async () => {
		const w = await world({ maxRefusalRows: 0 });
		const roomId = await makeRoom(w, agentsOnly());
		await postAgent(w, "eta", roomId, 1);
		expect((await turnsOf(w, roomId)).filter((r) => r.kind === "refused")).toHaveLength(0);
		expect((await roomOf(w, roomId)).refusalsOverflow).toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("B19 delivery failure stalls the room", () => {
	test("an unknown recipient stalls the room with a system row carrying the backend's error", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		await postOperator(w, roomId, 1);
		await w.t.run(async (ctx) => {
			for (const p of await ctx.db.query("profiles").collect()) {
				if (p.orchestratorId === "sigma") await ctx.db.delete(p._id);
			}
		});
		await deliver(w, roomId, 2);
		const room = await roomOf(w, roomId);
		expect(room.status).toBe("stalled");
		const sys = (await turnsOf(w, roomId)).filter((r) => r.writer === "deliverTurn");
		expect(sys).toHaveLength(1);
		expect(sys[0].writer).toBe("deliverTurn");
		expect(sys[0].text).toContain("delivery failed");
		expect(sys[0].text).toContain("sigma");
		expect(await w.t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(0);
		expect(asRefused(await postAgent(w, "sigma", roomId, 2)).refused).toBe("room_stalled");
		// the operator can still end a stalled room
		await asAdmin(w.t).mutation(api.debate.closeRoom, { roomId });
		expect((await roomOf(w, roomId)).status).toBe("closed");
	});

	test("an agent no longer on the tenant's roster stalls the room instead of being messaged", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		await postOperator(w, roomId, 1);
		await w.t.run(async (ctx) => {
			const m = (await ctx.db.query("client_org_mapping").collect()).find((x) => x.clerkOrgSlug === ORG);
			if (m) await ctx.db.patch(m._id, { allowedOrchestrators: ["eta"] });
		});
		await deliver(w, roomId, 2);
		expect((await roomOf(w, roomId)).status).toBe("stalled");
		expect((await turnsOf(w, roomId)).at(-1)?.text).toContain("not on the roster");
		expect(await w.t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("B20 workDuringTurn is never 'none' by default", () => {
	test("there is no index on tasks by creator, so every accepted answer is could_not_judge, even with a task created in the window", async () => {
		const w = await world();
		const roomId = await makeRoom(w, agentsOnly());
		await deliver(w, roomId, 1);
		await w.t.run((ctx) =>
			ctx.db.insert("tasks", {
				title: "side work",
				assignedTo: "sigma",
				priority: "low",
				status: "in_progress",
				createdBy: "sigma",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				orgId: ORG,
				clerkOrgId: testClerkOrgId(ORG),
			}),
		);
		const r = asAccepted(await postAgent(w, "sigma", roomId, 1));
		expect(r.workDuringTurn).toBe("could_not_judge");
		const row = (await turnsOf(w, roomId)).find((x) => x.kind === "answer");
		expect(row?.workDuringTurn).toBe("could_not_judge");
		expect(row?.workDuringTurn).not.toBe("none");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("B15 (rows) the frame's turn count plus the omitted count equals the room's rows", () => {
	test("with a small maxTurnMessageChars the delivered message cuts whole old turns and the counts agree", async () => {
		const w = await world({ maxTurnMessageChars: 700 });
		const roomId = await makeRoom(w, agentsOnly({ roundLimit: 5, maxAnswerChars: 200 }));
		const long = (i: number) => `answer ${i} ${"z".repeat(90)}`;
		await postAgent(w, "sigma", roomId, 1, long(1));
		await postAgent(w, "eta", roomId, 2, long(2));
		await postAgent(w, "sigma", roomId, 3, long(3));
		await postAgent(w, "eta", roomId, 4, long(4));
		await deliver(w, roomId, 5);
		const msg = (await w.t.run((ctx) => ctx.db.query("messages").collect()))[0];
		const rows = await turnsOf(w, roomId);
		const shown = Number(/TRANSCRIPT \((\d+) turns/.exec(msg.content)?.[1]);
		const omittedMatch = /\[(\d+) earlier turns omitted; read them with debate_get_room/.exec(msg.content);
		const omitted = omittedMatch ? Number(omittedMatch[1]) : 0;
		expect(omitted).toBeGreaterThan(0);
		expect(shown + omitted).toBe(rows.length);
		expect(msg.content.length).toBeLessThanOrEqual(700);
		expect(msg.content).toContain("answer 4");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("B1 the only writers of debateTurns", () => {
	test("every row names a writer from the allowed set; deliverTurn writes only system rows", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman({ roundLimit: 3, maxConsecutiveSkips: 1 }));
		await postOperator(w, roomId, 1);
		await postAgent(w, "eta", roomId, 2); // refused row
		await expire(w, roomId, 2); // skipped + dropped (sigma)
		await postAgent(w, "eta", roomId, 3); // answer
		await w.t.run(async (ctx) => {
			for (const p of await ctx.db.query("profiles").collect()) await ctx.db.delete(p._id);
		});
		await postOperator(w, roomId, 4);
		await deliver(w, roomId, 5); // stalls
		const rows = await turnsOf(w, roomId);
		const kinds = new Set(rows.map((r) => r.kind));
		expect([...kinds].sort(), "fixture must exercise every row kind").toEqual([
			"answer",
			"dropped",
			"operator",
			"refused",
			"skipped",
			"system",
		]);
		const allowed = new Set(["postTurn", "expireTurn", "closeRoom", "deliverTurn"]);
		for (const r of rows) {
			expect(allowed.has(r.writer), `${r.kind} written by ${r.writer}`).toBe(true);
			if (r.writer === "deliverTurn") expect(r.kind).toBe("system");
		}
		expect(rows.filter((r) => r.kind === "answer" || r.kind === "operator").every((r) => r.writer === "postTurn")).toBe(true);
		expect(rows.filter((r) => r.kind === "skipped").every((r) => r.writer === "expireTurn")).toBe(true);
	});

	test("in the source, exactly one statement inserts into debateTurns, and it is in convex/debate.ts", () => {
		const hits = Object.entries(sources)
			.filter(([, src]) => /insert\(\s*["']debateTurns["']/.test(src))
			.map(([path]) => path);
		expect(hits).toEqual(["../debate.ts"]);
		const count = (sources["../debate.ts"].match(/insert\(\s*["']debateTurns["']/g) ?? []).length;
		expect(count).toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// R-53: a seat is admitted by the agents-row ID frozen at createRoom, never by a name
// ─────────────────────────────────────────────────────────────────────────────
describe("admission to an agent seat is by agent ID", () => {
	test("the room freezes each agent seat's agents-row ID as the template named it; a human seat carries none", async () => {
		const w = await world();
		const room = await roomOf(w, await makeRoom(w, withHuman()));
		const seat = (id: string) =>
			room.template.participants.find((p: DebateTemplate["participants"][number]) => p.id === id);
		expect(seat("p2")?.agentId).toBe(w.agents.sigma);
		expect(seat("p3")?.agentId).toBe(w.agents.eta);
		expect(seat("p1")?.agentId).toBeUndefined();
		expect(room.template.participants.every((p: DebateTemplate["participants"][number]) => p.kind === "human" || p.channel === undefined)).toBe(true);
	});

	test("DENY: a seat that names another organisation's agent by ID is refused, however the agent is called", async () => {
		const w = await world();
		const t = withHuman();
		t.participants[1] = { ...t.participants[1], agentId: w.agents.foreignSigma };
		const msg = await failure(asAdmin(w.t).mutation(api.debate.upsertTemplate, { template: t }));
		expect(msg).toContain("RBAC_DENIED");
		expect(await asAdmin(w.t).query(api.debate.listTemplates, {})).toHaveLength(0);
	});

	test("PRESENT: an agent renamed after the room was created keeps its seat", async () => {
		const w = await world();
		const roomId = await makeRoom(w, agentsOnly());
		await w.t.run((ctx) => ctx.db.patch(w.agents.sigma, { name: "sigma-renamed", normalizedName: "sigma-renamed" }));
		expect(asAccepted(await postAgent(w, "sigma", roomId, 1)).turnSeq).toBe(1);
	});

	test("DENY: a different agent of the same organisation that carries the listed NAME is not the seat", async () => {
		const w = await world();
		const roomId = await makeRoom(w, agentsOnly());
		const impostor = await w.t.run((ctx) =>
			ctx.db.insert("agents", {
				orgSlug: ORG,
				clerkOrgId: testClerkOrgId(ORG),
				name: "sigma",
				normalizedName: "sigma",
				isActive: true,
				createdAt: 1,
			}),
		);
		const before = await turnsOf(w, roomId);
		const call = { roomId, turnSeq: 1, text: "I am sigma" };
		const refused = await svc(w.t).mutation(api.debate.postTurn, {
			...call,
			verifiedActor: { agentId: impostor, orgSlug: ORG },
		});
		expect(asRefused(refused)).toEqual({ refused: "not_a_participant", awaiting: null, turnSeq: 1 });
		expect(
			await svc(w.t).query(api.debate.getRoom, { roomId, verifiedActor: { agentId: impostor, orgSlug: ORG } }),
		).toBeNull();
		expect(await turnsOf(w, roomId)).toEqual(before);
	});

	test("DENY: an agent of the same organisation that is not in the template is not_a_participant (and nothing is written)", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		const zeta = await w.t.run((ctx) => seedRosterAgent(ctx, ORG, "zeta"));
		const before = await turnsOf(w, roomId);
		const r = await svc(w.t).mutation(api.debate.postTurn, {
			roomId,
			turnSeq: 1,
			text: "let me in",
			verifiedActor: { agentId: zeta, orgSlug: ORG },
		});
		expect(asRefused(r)).toEqual({ refused: "not_a_participant", awaiting: null, turnSeq: 1 });
		expect(await turnsOf(w, roomId)).toEqual(before);
		expect(
			await svc(w.t).query(api.debate.getRoom, { roomId, verifiedActor: { agentId: zeta, orgSlug: ORG } }),
		).toBeNull();
	});

	test("DENY: a stored template whose two seats are one agent (past upsert) is refused at createRoom, no room written", async () => {
		const w = await world();
		const templateId = await asAdmin(w.t).mutation(api.debate.upsertTemplate, { template: agentsOnly() });
		await w.t.run(async (ctx) => {
			const row = await ctx.db.get(templateId);
			if (row === null) throw new Error("template vanished");
			const seats = row.template.participants.map((p: DebateTemplate["participants"][number], i: number) =>
				i === 1 ? { ...p, agentId: AGENT.sigma } : p,
			);
			await ctx.db.patch(templateId, { template: { ...row.template, participants: seats } });
		});
		const msg = await failure(asAdmin(w.t).mutation(api.debate.createRoom, { templateId, subject: "s" }));
		expect(msg).toContain("DEBATE_TEMPLATE_INVALID");
		expect(msg).toContain("participants[1].agentId");
		expect(await w.t.run((ctx) => ctx.db.query("debateRooms").collect())).toHaveLength(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("postTurn: the refusal for a non-participant says nothing about the room", () => {
	test("the turnSeq returned is the caller's own, for an existing room and for a missing one, whatever the room's live turn", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		await postOperator(w, roomId, 1); // the room is now at turnSeq 2
		const zeta = await w.t.run((ctx) => seedRosterAgent(ctx, ORG, "zeta"));
		const ASKED = 41;
		const callers: Array<[string, Promise<unknown>]> = [
			["unlisted member", asStranger(w.t).mutation(api.debate.postTurn, { roomId, turnSeq: ASKED, text: "x" })],
			["other tenant admin", asOutsider(w.t).mutation(api.debate.postTurn, { roomId, turnSeq: ASKED, text: "x" })],
			[
				"same-org agent not in the template",
				svc(w.t).mutation(api.debate.postTurn, {
					roomId,
					turnSeq: ASKED,
					text: "x",
					verifiedActor: { agentId: zeta, orgSlug: ORG },
				}),
			],
			[
				"other tenant agent",
				svc(w.t).mutation(api.debate.postTurn, {
					roomId,
					turnSeq: ASKED,
					text: "x",
					verifiedActor: { agentId: w.agents.foreignSigma, orgSlug: OTHER_ORG },
				}),
			],
		];
		for (const [who, call] of callers) {
			expect(asRefused(await call), who).toEqual({ refused: "not_a_participant", awaiting: null, turnSeq: ASKED });
		}
		await w.t.run((ctx) => ctx.db.delete(roomId));
		expect(asRefused(await postOperator(w, roomId, ASKED)).turnSeq).toBe(ASKED);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("a human seat other than the creator", () => {
	const seatFor = (subject: string, over: Partial<DebateTemplate> = {}): DebateTemplate =>
		withHuman({
			id: `seat-${subject}`,
			participants: [
				{ id: "p1", label: "reviewer", kind: "human", transport: "human", channel: `user:${subject}`, deadlineSeconds: null },
				{ id: "p2", label: "sigma", kind: "agent", agentId: AGENT.sigma, transport: "waker" },
				{ id: "p3", label: "eta", kind: "agent", agentId: AGENT.eta, transport: "waker" },
			],
			...over,
		});

	test("ALLOW: the person the seat names posts as that seat (kind operator, participant p1); the creator, who is not that person, may not", async () => {
		const w = await world();
		const roomId = await makeRoom(w, seatFor(ADMIN_2));
		expect(asRefused(await postOperator(w, roomId, 1)).refused).toBe("not_a_participant"); // ADMIN created it, is not the seat
		expect(asRefused(await asStranger(w.t).mutation(api.debate.postTurn, { roomId, turnSeq: 1, text: "x" })).refused).toBe(
			"not_a_participant",
		);
		const ok = asAccepted(await asAdmin2(w.t).mutation(api.debate.postTurn, { roomId, turnSeq: 1, text: "my view" }));
		expect(ok).toMatchObject({ turnSeq: 1, closed: false, workDuringTurn: "not_applicable" });
		expect((await turnsOf(w, roomId))[0]).toMatchObject({ kind: "operator", participantId: "p1", text: "my view" });
		expect((await roomOf(w, roomId)).awaiting?.participantId).toBe("p2");
	});

	test("the seat's person reads the room it sits in; a member who is not a seat reads nothing", async () => {
		const w = await world();
		const roomId = await makeRoom(w, seatFor(STRANGER));
		expect((await asStranger(w.t).query(api.debate.getRoom, { roomId }))?.room._id).toBe(roomId);
		const other = await makeRoom(w, seatFor(ADMIN_2, { id: "other" }));
		expect(await asStranger(w.t).query(api.debate.getRoom, { roomId: other })).toBeNull();
	});

	test("cloud-identity 0.31 standing: a member scope WITH orgClerkId is served at the seat; the same org's mapping row stripped of its Clerk ID (slug-only scope) reads nothing and posts nothing", async () => {
		const w = await world();
		const roomId = await makeRoom(w, seatFor(STRANGER));
		// member WITH the permanent ID: served
		expect((await asStranger(w.t).query(api.debate.getRoom, { roomId }))?.room._id).toBe(roomId);
		// strip the ID from the mapping row: the scope can now carry the slug alone
		await w.t.run(async (ctx) => {
			const row = (await ctx.db.query("client_org_mapping").collect()).find((x) => x.clerkOrgSlug === ORG);
			if (row === undefined) throw new Error("test-integrity: acme mapping row missing");
			const { _id, _creationTime, clerkOrgId: _dropped, ...rest } = row;
			await ctx.db.replace(_id, rest);
		});
		const stranger = asStranger(w.t);
		let read: unknown;
		try {
			read = (await stranger.query(api.debate.getRoom, { roomId }))?.room._id ?? null;
		} catch (e) {
			read = String(e);
		}
		expect(read === null || String(read).includes("RBAC_DENIED")).toBe(true);
		expect(read).not.toBe(roomId);
	});

	test("WRITER ROLE: a seat whose person has no writer role is refused at postTurn exactly as createRoom refuses it; a writer role posts", async () => {
		const w = await world();
		const VIEWER = "user_viewer_acme";
		const asViewer = as(w.t, VIEWER, ORG, "org:viewer");
		const roomId = await makeRoom(w, seatFor(VIEWER));
		const before = await turnsOf(w, roomId);
		const msg = await failure(asViewer.mutation(api.debate.postTurn, { roomId, turnSeq: 1, text: "viewing" }));
		expect(msg).toContain("RBAC_DENIED");
		expect(msg).toContain("role-not-writer");
		expect(msg).toContain("debate:postTurn");
		expect(await turnsOf(w, roomId)).toEqual(before);
		expect((await roomOf(w, roomId)).turnSeq).toBe(1);

		// the same seat with a writer role (org:member is on the list) is accepted
		const memberRoom = await makeRoom(w, seatFor(STRANGER, { id: "member-seat" }));
		expect(asAccepted(await asStranger(w.t).mutation(api.debate.postTurn, { roomId: memberRoom, turnSeq: 1, text: "ok" })).turnSeq).toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("limits that keep a room's data bounded", () => {
	test("template name, seat label and turn instruction above the settings caps are refused with their path; nothing is stored", async () => {
		const w = await world();
		const tooLong = withHuman({
			name: "n".repeat(SETTINGS.maxLabelChars + 1),
			turnInstruction: "i".repeat(SETTINGS.maxTurnInstructionChars + 1),
		});
		tooLong.participants[1] = { ...tooLong.participants[1], label: "l".repeat(SETTINGS.maxLabelChars + 1) };
		const msg = await failure(asAdmin(w.t).mutation(api.debate.upsertTemplate, { template: tooLong }));
		expect(msg).toContain("DEBATE_TEMPLATE_INVALID");
		for (const path of ["name", "turnInstruction", "participants[1].label"]) expect(msg).toContain(path);
		expect(await asAdmin(w.t).query(api.debate.listTemplates, {})).toHaveLength(0);
		// at the caps it is accepted
		const atCap = withHuman({
			name: "n".repeat(SETTINGS.maxLabelChars),
			turnInstruction: "i".repeat(SETTINGS.maxTurnInstructionChars),
		});
		await asAdmin(w.t).mutation(api.debate.upsertTemplate, { template: atCap });
		expect(await asAdmin(w.t).query(api.debate.listTemplates, {})).toHaveLength(1);
	});

	test("rooms that are not closed (active or stalled) are capped per organisation; closing one frees a place; another organisation is unaffected", async () => {
		const w = await world({ maxActiveRooms: 2 });
		const templateId = await asAdmin(w.t).mutation(api.debate.upsertTemplate, { template: withHuman() });
		const create = () => asAdmin(w.t).mutation(api.debate.createRoom, { templateId, subject: "s" });
		const first = await create();
		const second = await create();
		const refused = await failure(create());
		expect(refused).toContain("DEBATE_ROOM_LIMIT");
		expect(await w.t.run((ctx) => ctx.db.query("debateRooms").collect())).toHaveLength(2);

		// a stalled room still holds its place
		await w.t.run((ctx) => ctx.db.patch(second, { status: "stalled" }));
		expect(await failure(create())).toContain("DEBATE_ROOM_LIMIT");

		await asAdmin(w.t).mutation(api.debate.closeRoom, { roomId: first });
		await create();
		expect(await failure(create())).toContain("DEBATE_ROOM_LIMIT");

		// another organisation has its own count
		await asOutsider(w.t).mutation(api.debate.upsertSettings, { ...SETTINGS, maxActiveRooms: 1 });
		const otherTemplate = await asOutsider(w.t).mutation(api.debate.upsertTemplate, {
			template: withHuman({
				id: "g",
				participants: [
					{ id: "p1", label: "operator", kind: "human", transport: "human", deadlineSeconds: null },
					{ id: "p2", label: "sigma", kind: "agent", agentId: AGENT.foreignSigma, transport: "waker" },
				],
			}),
		});
		const theirs = await asOutsider(w.t).mutation(api.debate.createRoom, { templateId: otherTemplate, subject: "s" });
		expect((await roomOf(w, theirs)).tenantOrgId).toBe(testClerkOrgId(OTHER_ORG));
	});

	test("settings whose largest transcript would not fit the read bound are refused at upsert", async () => {
		const w = await world();
		const msg = await failure(
			asAdmin(w.t).mutation(api.debate.upsertSettings, { ...SETTINGS, maxRoundLimit: 5000 }),
		);
		expect(msg).toContain("DEBATE_SETTINGS_INVALID");
		expect(msg).toContain("maxRoundLimit");
		expect((await asAdmin(w.t).query(api.debate.getSettings, {}))?.maxRoundLimit).toBe(SETTINGS.maxRoundLimit);
	});

	test("a room read is whole or refused: 2000 rows are served, 2001 raise DEBATE_TRANSCRIPT_TOO_LARGE instead of dropping the newest", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		const seed = (n: number) =>
			w.t.run(async (ctx) => {
				for (let i = 0; i < n; i++) {
					await ctx.db.insert("debateTurns", {
						roomId,
						turnSeq: 1,
						round: 1,
						position: 0,
						kind: "system",
						writer: "deliverTurn",
						text: `row ${i}`,
						postedAt: i,
					});
				}
			});
		await seed(2000);
		const whole = await asAdmin(w.t).query(api.debate.getRoom, { roomId });
		expect(whole?.turns).toHaveLength(2000);
		await seed(1);
		const msg = await failure(asAdmin(w.t).query(api.debate.getRoom, { roomId }));
		expect(msg).toContain("DEBATE_TRANSCRIPT_TOO_LARGE");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// R-54: a door the service account can reach acts inside a transport-verified claim
// ─────────────────────────────────────────────────────────────────────────────
describe("the fleet service account is refused when it carries no claim", () => {
	test("all eight debate doors refuse a claimless service-account call with RBAC_DENIED, naming the door; nothing is written", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		const templateId = (await asAdmin(w.t).query(api.debate.listTemplates, {}))[0]._id;
		const calls: Array<[string, Promise<unknown>]> = [
			["debate:getSettings", svc(w.t).query(api.debate.getSettings, {})],
			["debate:listTemplates", svc(w.t).query(api.debate.listTemplates, {})],
			["debate:upsertSettings", svc(w.t).mutation(api.debate.upsertSettings, SETTINGS)],
			["debate:upsertTemplate", svc(w.t).mutation(api.debate.upsertTemplate, { template: withHuman() })],
			["debate:createRoom", svc(w.t).mutation(api.debate.createRoom, { templateId, subject: "s" })],
			["debate:getRoom", svc(w.t).query(api.debate.getRoom, { roomId })],
			["debate:closeRoom", svc(w.t).mutation(api.debate.closeRoom, { roomId })],
			["debate:postTurn", svc(w.t).mutation(api.debate.postTurn, { roomId, turnSeq: 1, text: "x" })],
		];
		for (const [door, call] of calls) {
			const msg = await failure(call);
			expect(msg, door).toContain("RBAC_DENIED");
			expect(msg, door).toContain(door);
		}
		expect((await roomOf(w, roomId)).turnSeq).toBe(1);
		expect(await turnsOf(w, roomId)).toEqual([]);
		expect(await w.t.run((ctx) => ctx.db.query("debateRooms").collect())).toHaveLength(1);
	});

	test("ALLOW: a verifiedActor lifts the refusal of the two doors an agent uses; the agent is then judged by its seat", async () => {
		const w = await world();
		const roomId = await makeRoom(w, withHuman());
		const asAgent = await svc(w.t).query(api.debate.getRoom, {
			roomId,
			verifiedActor: { agentId: w.agents.sigma, orgSlug: ORG },
		});
		expect(asAgent?.room._id).toBe(roomId);
		const posted = await svc(w.t).mutation(api.debate.postTurn, {
			roomId,
			turnSeq: 1,
			text: "not my turn",
			verifiedActor: { agentId: w.agents.sigma, orgSlug: ORG },
		});
		expect(asRefused(posted).refused).toBe("not_your_turn");
	});
});
