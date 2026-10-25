/// <reference types="vite/client" />
//
// task k1791fcdxk3ha55vgsbmjtpbm18cpv89, deliverable A (audit; no production fix here).
//
// THE CLASS. A row carries a field naming who is granted access (assignee, pilot,
// participants, owner, recipient) and the READ path never consults it: the grant
// exists in the data and yields nothing for a scoped, non-creator grantee. It stays
// invisible because internal callers authenticate as master, and master bypasses
// the filter. Known fixed instance: briefingNotes.participants (PR #1200).
//
// THE IDENTITY EVERY TEST RUNS UNDER (never master, never the fleet service
// account, never the creator):
//   GRANTEE = an ordinary member of org "org-grants": Clerk subject
//   "user_grantee", org_role "org:member", org_id = testClerkOrgId("org-grants").
//   Its person actor is "user:user_grantee" (memberActorOf). The ROW is created by
//   a different actor ("creator", an agent of the same org, on the roster).
//
// `it.fails` marks a test that asserts the grantee CAN read and is expected to be
// RED today; each is the RED for the next step. A plain `test` is a pole that
// holds today (CONSULTED, in-query or via org scope).

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { seedRosterAgents } from "../../tests/lib/seedRosterAgents";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const ORG = "org-grants";
const GRANTEE_SUBJECT: string = "user_grantee";
const GRANTEE_PERSON = `user:${GRANTEE_SUBJECT}`;
const SERVICE = "test-service-account-user-id";
const NOW = 1_700_000_000_000;

if (GRANTEE_SUBJECT === SERVICE) {
	throw new Error("test-integrity: the grantee must be an ordinary member");
}

/** The GRANTEE: ordinary org member, not master, not the creator. */
const asGrantee = (t: T) =>
	t.withIdentity({
		subject: GRANTEE_SUBJECT,
		organizationSlug: ORG,
		org_id: testClerkOrgId(ORG),
		org_role: "org:member",
	} as Identity);

type World = {
	t: T;
	creator: Id<"agents">;
	granteeAgent: Id<"agents">;
	offRoster: Id<"agents">;
};

/** Org with roster [creator, grantee-agent]; "off-roster" is an active agent NOT on it. */
async function world(): Promise<World> {
	const t = createT();
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: ORG,
			clerkOrgId: testClerkOrgId(ORG),
			allowedOrchestrators: ["creator", "grantee-agent"],
			scopes: ["view-own-tasks", "view-own-missions"],
			displayName: ORG,
			isActive: true,
			createdAt: NOW,
		});
	});
	const ids = await seedRosterAgents(t);
	const offRoster = await t.run(async (ctx) =>
		ctx.db.insert("agents", {
			orgSlug: ORG,
			clerkOrgId: testClerkOrgId(ORG),
			name: "off-roster",
			normalizedName: "off-roster",
			isActive: true,
			createdAt: NOW,
		}),
	);
	return {
		t,
		creator: ids[`${ORG}/creator`],
		granteeAgent: ids[`${ORG}/grantee-agent`],
		offRoster,
	};
}

const stamp = { orgId: ORG, clerkOrgId: testClerkOrgId(ORG) };

// ── tasks.assignedTo / assignedToId ─────────────────────────────────────────

async function seedTask(
	w: World,
	assignee: { label: string; id: string },
): Promise<Id<"tasks">> {
	return await w.t.run(async (ctx) =>
		ctx.db.insert("tasks", {
			title: "task granted to the grantee",
			assignedTo: assignee.label,
			assignedToId: assignee.id,
			createdBy: "creator",
			createdById: w.creator,
			priority: "low",
			status: "todo",
			...stamp,
			createdAt: NOW,
			updatedAt: NOW,
		}),
	);
}

describe("tasks.assignedTo", () => {
	test("CONTROL (CONSULTED-VIA-ORG-SCOPE): tasks:get, assignee is an agent on the org roster, caller is another member", async () => {
		const w = await world();
		const taskId = await seedTask(w, { label: "grantee-agent", id: w.granteeAgent });
		const row = await asGrantee(w.t).query(api.tasks.get, { taskId });
		expect(row?._id).toBe(taskId);
	});

	// The grantee is the PERSON named by the row (assignedTo "user:<subject>", a
	// shape the doors themselves write: requireAssigneeId admits a person).
	// filterByOrgScope admits `allowedOrchestrators.includes(assignedTo)` and a
	// person is never on that name roster.
	test.fails("RED: tasks:get returns a task assigned to the calling person (user:user_grantee)", async () => {
		const w = await world();
		const taskId = await seedTask(w, { label: GRANTEE_PERSON, id: GRANTEE_PERSON });
		const row = await asGrantee(w.t).query(api.tasks.get, { taskId });
		expect(row?._id).toBe(taskId);
	});

	test.fails("RED: tasks:list {assignedTo: person} returns a task assigned to the calling person", async () => {
		const w = await world();
		const taskId = await seedTask(w, { label: GRANTEE_PERSON, id: GRANTEE_PERSON });
		const rows = await asGrantee(w.t).query(api.tasks.list, {
			assignedTo: GRANTEE_PERSON,
		} as never);
		expect((rows as unknown as { _id: Id<"tasks"> }[]).map((r) => r._id)).toEqual([taskId]);
	});

	test.fails("RED: tasks:list {} (unfiltered) returns a task assigned to the calling person", async () => {
		const w = await world();
		const taskId = await seedTask(w, { label: GRANTEE_PERSON, id: GRANTEE_PERSON });
		const rows = await asGrantee(w.t).query(api.tasks.list, {} as never);
		expect((rows as unknown as { _id: Id<"tasks"> }[]).map((r) => r._id)).toEqual([taskId]);
	});
});

// ── missions.pilot/pilotId, missions.agents/agentIds ────────────────────────

async function seedMission(
	w: World,
	o: {
		pilot: string;
		pilotId: string;
		agents?: string[];
		agentIds?: string[];
	},
): Promise<Id<"missions">> {
	return await w.t.run(async (ctx) =>
		ctx.db.insert("missions", {
			name: "mission granted to the grantee",
			project: "p",
			status: "execute",
			priority: "low",
			pilot: o.pilot,
			pilotId: o.pilotId,
			agents: o.agents ?? [],
			...(o.agentIds !== undefined ? { agentIds: o.agentIds } : {}),
			createdBy: "creator",
			createdById: w.creator,
			...stamp,
			createdAt: NOW,
			updatedAt: NOW,
		}),
	);
}

describe("missions.pilot / missions.agents", () => {
	test("CONTROL (CONSULTED-VIA-ORG-SCOPE): missions:get, pilot is a roster agent, grantee only in agents[], caller is another member", async () => {
		const w = await world();
		const missionId = await seedMission(w, {
			pilot: "creator",
			pilotId: w.creator,
			agents: [GRANTEE_PERSON],
			agentIds: [GRANTEE_PERSON],
		});
		const row = await asGrantee(w.t).query(api.missions.get, { missionId });
		expect(row?._id).toBe(missionId);
	});

	test.fails("RED: missions:get returns a mission whose pilot is the calling person (pilotId user:user_grantee)", async () => {
		const w = await world();
		const missionId = await seedMission(w, {
			pilot: GRANTEE_PERSON,
			pilotId: GRANTEE_PERSON,
		});
		const row = await asGrantee(w.t).query(api.missions.get, { missionId });
		expect(row?._id).toBe(missionId);
	});

	test.fails("RED: missions:list returns a mission whose pilot is the calling person", async () => {
		const w = await world();
		const missionId = await seedMission(w, {
			pilot: GRANTEE_PERSON,
			pilotId: GRANTEE_PERSON,
		});
		const rows = await asGrantee(w.t).query(api.missions.list, {});
		expect((rows as unknown as { _id: Id<"missions"> }[]).map((r) => r._id)).toEqual([missionId]);
	});

	// agents[]/agentIds[] alone (pilot NOT on the org roster). Whether the product
	// WANTS membership of agents[] to widen past the roster is a ruling, not a
	// measurement: authority-attached-to-anonymous-object.md says a roster
	// narrows, intersect, never widen, but a listed participant is a grant to a
	// named principal, not a client-registration default.
	test.fails("RED (intent to be ruled): missions:get returns a mission whose pilot is off-roster but whose agents[]/agentIds[] name the calling person", async () => {
		const w = await world();
		const missionId = await seedMission(w, {
			pilot: "off-roster",
			pilotId: w.offRoster,
			agents: [GRANTEE_PERSON],
			agentIds: [GRANTEE_PERSON],
		});
		const row = await asGrantee(w.t).query(api.missions.get, { missionId });
		expect(row?._id).toBe(missionId);
	});
});

// ── recurringTasks.assignedTo / assignedToId ────────────────────────────────

async function seedRecurring(
	w: World,
	assignee: { label: string; id: string },
): Promise<Id<"recurringTasks">> {
	return await w.t.run(async (ctx) =>
		ctx.db.insert("recurringTasks", {
			title: "schedule granted to the grantee",
			assignedTo: assignee.label,
			assignedToId: assignee.id,
			priority: "medium",
			cronExpression: "0 9 * * *",
			nextRunAt: NOW + 3_600_000,
			active: true,
			createdBy: "creator",
			createdById: w.creator,
			...stamp,
			createdAt: NOW,
			updatedAt: NOW,
		}),
	);
}

describe("recurringTasks.assignedTo", () => {
	test("CONTROL (CONSULTED-VIA-ORG-SCOPE): recurringTasks:getById, assignee is a roster agent, caller is another member", async () => {
		const w = await world();
		const id = await seedRecurring(w, { label: "grantee-agent", id: w.granteeAgent });
		const row = await asGrantee(w.t).query(api.recurringTasks.getById, {
			recurringTaskId: id,
		});
		expect(row?._id).toBe(id);
	});

	test.fails("RED: recurringTasks:getById returns a schedule assigned to the calling person", async () => {
		const w = await world();
		const id = await seedRecurring(w, { label: GRANTEE_PERSON, id: GRANTEE_PERSON });
		const row = await asGrantee(w.t).query(api.recurringTasks.getById, {
			recurringTaskId: id,
		});
		expect(row?._id).toBe(id);
	});

	test.fails("RED: recurringTasks:list returns a schedule assigned to the calling person", async () => {
		const w = await world();
		const id = await seedRecurring(w, { label: GRANTEE_PERSON, id: GRANTEE_PERSON });
		const rows = await asGrantee(w.t).query(api.recurringTasks.list, {} as never);
		expect((rows as unknown as { _id: Id<"recurringTasks"> }[]).map((r) => r._id)).toEqual([id]);
	});
});

// ── briefingNotes.participants (the fixed instance, the measurement pattern) ─

describe("briefingNotes.participants", () => {
	test("CONSULTED (in-query, by_participantId_note): a scoped participant who is not the creator reads the note; a non-participant seat does not", async () => {
		const w = await world();
		const noteId = await w.t.run(async (ctx) => {
			const id = await ctx.db.insert("briefingNotes", {
				title: "note shared with grantee-agent",
				topic: "handoff",
				participants: ["grantee-agent"],
				participantIds: [w.granteeAgent],
				content: "c",
				createdBy: "creator",
				createdById: w.creator,
				...stamp,
				createdAt: NOW,
			});
			await ctx.db.insert("briefingNoteParticipants", {
				noteId: id,
				participant: "grantee-agent",
				participantId: w.granteeAgent,
			});
			return id;
		});
		const asMember = asGrantee(w.t);
		const granted = await asMember.query(api.briefingNotes.get, {
			noteId,
			callerIdentities: ["grantee-agent"],
		});
		expect(granted?._id).toBe(noteId);
		const other = await asMember.query(api.briefingNotes.get, {
			noteId,
			callerIdentities: ["off-roster"],
		});
		expect(other).toBeNull();
	});
});

// ── businessUnits.ownerId ───────────────────────────────────────────────────

describe("businessUnits.ownerId", () => {
	test("CONTROL (CONSULTED-VIA-ORG-SCOPE): businessUnits:get, owner is a roster agent, caller is another member", async () => {
		const w = await world();
		const buId = await w.t.run(async (ctx) =>
			ctx.db.insert("businessUnits", {
				name: "unit",
				description: "d",
				purpose: "p",
				orchestratorId: "grantee-agent",
				ownerId: w.granteeAgent,
				status: "idea",
				businessModel: "m",
				targetCustomers: "c",
				services: [],
				pricing: "x",
				revenueProjections: { y1: 1, y2: 2, y3: 3 },
				coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
				coreProcesses: [],
				dependencies: [],
				kpis: [],
				managementFee: 10,
				createdAt: NOW,
				updatedAt: NOW,
				...stamp,
			}),
		);
		const row = await asGrantee(w.t).query(api.businessUnits.get, { buId });
		expect(row?._id).toBe(buId);
	});
});

// ── messageReceipts.recipient (a person's direct message) ───────────────────

async function seedPersonMessage(w: World): Promise<Id<"messages">> {
	return await w.t.run(async (ctx) => {
		const messageId = await ctx.db.insert("messages", {
			from: "creator",
			fromId: w.creator,
			channel: GRANTEE_PERSON,
			content: "for the grantee",
			tenantId: ORG,
			tenantOrgId: testClerkOrgId(ORG),
			createdAt: NOW,
		});
		await ctx.db.insert("messageReceipts", {
			messageId,
			recipient: GRANTEE_PERSON,
			tenantId: ORG,
			tenantOrgId: testClerkOrgId(ORG),
			readAt: undefined,
		});
		return messageId;
	});
}

describe("messageReceipts.recipient", () => {
	test("CONSULTED (in-query, by_tenant_recipient_unread): messages:listMyInbox serves the receipt to the recipient person", async () => {
		const w = await world();
		const messageId = await seedPersonMessage(w);
		const inbox = await asGrantee(w.t).query(api.messages.listMyInbox, {});
		expect(inbox.items.map((i) => i.messageId)).toEqual([messageId]);
	});

	test.fails("RED: messages:getById returns the message addressed to the calling person (channel user:user_grantee)", async () => {
		const w = await world();
		const messageId = await seedPersonMessage(w);
		const row = await asGrantee(w.t).query(api.messages.getById, { messageId });
		expect(row?._id).toBe(messageId);
	});
});

// ── agentLinks.toAgentId ────────────────────────────────────────────────────

describe("agentLinks", () => {
	test.todo(
		"could-not-judge: agentLinks has no public read door (convex/agentLinks.ts exports only grant/revoke; the standing link is consumed by the send-reach check in messages.ts via lib/agentLinks.ts), so there is no read to measure under a grantee",
	);
});
