/// <reference types="vite/client" />
//
// Intra-org acting-identity sweep, follow-up to PR #1400 (messages:sendMessage).
// VantagePeers Cloud (multi-tenant).
//
// DEFECT: org-scoped writes took an identity-bearing name from the client and
// checked it only at the MCP layer, which the service-account path bypasses. A
// member of org B could author as / assign to "eta" (an orchestrator of another
// org). Now: the ACTING field (createdBy) must be on the caller's own roster,
// and an ASSIGNMENT target (pilot, assignedTo) must be too.
//
// Poles per site: REFUSED (name off roster -> RBAC_DENIED naming the door),
// SERVED (own-roster name), MASTER unchanged (any name).
//
// DELETION PROBE (not committed): remove the requireOrchestratorOnRoster call
// in a site and that site's REFUSED pole goes RED.

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";
import {
	actingWith,
	insertTaskRow,
	seedFleetAgents,
	seedOrgAgents,
} from "../../tests/lib/seedFleetAgents";

const FILE_LABELS = ["BEA", "bea", "bob", "eta", "pi", "sigma"];
import { findAgentId } from "../../tests/lib/agentIdOf";
import { seedRosterAgents } from "../../tests/lib/seedRosterAgents";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

type T = ReturnType<typeof convexTest>;
type Identity = Parameters<T["withIdentity"]>[0];
const createT = (): T =>
	convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;

// `org-b/<name>` -> credential of that org-b agent (written by fixture): a member
// acting as an agent of its org presents it (the task doors decide on agent IDs).
const secrets = new Map<string, string>();

// `agents: false` leaves the roster names unregistered (the recurringTasks doors
// take no per-agent credential, so they are exercised on bare roster names).
async function fixture(opts: { agents?: boolean } = {}) {
	const t = createT();
	await seedFleetAgents(t, FILE_LABELS);
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-b",
			clerkOrgId: testClerkOrgId("org-b"),
			allowedOrchestrators: ["bob", "bea"],
			scopes: ["view-own-tasks", "view-own-missions"],
			displayName: "org-b",
			isActive: true,
			createdAt: Date.now(),
		});
		// Admin CRUD B2: a member without callerOrchestrator is the human path
		// (writer role from the allowlist), so this member carries one.
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: Date.now(),
		});
	});
	if (opts.agents !== false) {
		for (const [k, v] of await seedOrgAgents(t, [
			["org-b", "bob"],
			["org-b", "bea"],
		])) {
			secrets.set(k, v);
		}
	}
	return t;
}

// The mission doors judge pilot and creator by agents-row ID (module M10e) on the
// org's ID roster: `seedRosterAgents` reuses the agents `fixture` registered for the
// task doors (M7) and sets `allowedAgentIds` to them.
async function missionFixture() {
	const t = await fixture();
	await seedRosterAgents(t);
	return t;
}

const member = (t: T) =>
	actingWith(
		t.withIdentity({ subject: "member-of-org-b", organizationId: "org-b", org_id: testClerkOrgId("org-b"), org_role: "org:editor" } as Identity),
		(name) => secrets.get(`org-b/${name}`),
	);
const master = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);

async function refusalOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		return typeof data === "string" ? data : String(e);
	}
	throw new Error("expected a refusal, got a success");
}

async function expectDenied(p: Promise<unknown>, door: string, kind: string) {
	const refusal = await refusalOf(p);
	expect(refusal).toContain("RBAC_DENIED");
	expect(refusal).toContain(door);
	expect(refusal).toMatch(new RegExp(`reason\\\\*":\\\\*"${kind}-not-on-roster`));
}

async function seedMission(t: T, orgId: string | undefined) {
	const pilotId = orgId === undefined ? null : await findAgentId(t, orgId, "bob");
	return await t.run((ctx) =>
		ctx.db.insert("missions", {
			name: "m",
			project: "p",
			status: "plan",
			priority: "medium",
			pilot: "bob",
			agents: [],
			createdBy: "bob",
			...(pilotId !== null ? { pilotId, createdById: pilotId } : {}),
			createdAt: Date.now(),
			updatedAt: Date.now(),
			orgId,
			clerkOrgId: testClerkOrgId(orgId),
		}),
	);
}

describe("briefingNotes:create — author is the caller's own", () => {
	const args = (createdBy: string) => ({
		title: "t",
		topic: "x",
		participants: ["bob"],
		content: "c",
		createdBy,
	});
	test("REFUSED: member authoring as 'eta'", async () => {
		const t = await fixture();
		await expectDenied(
			member(t).mutation(api.briefingNotes.create, args("eta")),
			"briefingNotes:create",
			"actor",
		);
		expect(await t.run((c) => c.db.query("briefingNotes").collect())).toHaveLength(0);
	});
	test("SERVED: member authoring as own-roster 'bob'", async () => {
		const t = await fixture();
		await member(t).mutation(api.briefingNotes.create, args("bob"));
		expect(await t.run((c) => c.db.query("briefingNotes").collect())).toHaveLength(1);
	});
	test("MASTER unchanged: any author", async () => {
		const t = await fixture();
		await master(t).mutation(api.briefingNotes.create, args("eta"));
		expect(await t.run((c) => c.db.query("briefingNotes").collect())).toHaveLength(1);
	});
});

describe("missions:create — createdBy (actor) and pilot (assignee)", () => {
	const args = (createdBy: string, pilot: string) => ({
		name: "m",
		project: "p",
		status: "plan" as const,
		priority: "medium" as const,
		pilot,
		agents: [],
		createdBy,
	});
	test("REFUSED: foreign createdBy", async () => {
		const t = await missionFixture();
		await expectDenied(
			member(t).mutation(api.missions.create, args("eta", "bob")),
			"missions:create",
			"actor",
		);
	});
	test("REFUSED: foreign pilot", async () => {
		const t = await missionFixture();
		await expectDenied(
			member(t).mutation(api.missions.create, args("bob", "eta")),
			"missions:create",
			"assignee",
		);
		expect(await t.run((c) => c.db.query("missions").collect())).toHaveLength(0);
	});
	test("SERVED: own roster on both", async () => {
		const t = await missionFixture();
		await member(t).mutation(api.missions.create, args("bob", "bea"));
		expect(await t.run((c) => c.db.query("missions").collect())).toHaveLength(1);
	});
	test("MASTER unchanged", async () => {
		const t = await missionFixture();
		await master(t).mutation(api.missions.create, args("eta", "pi"));
		expect(await t.run((c) => c.db.query("missions").collect())).toHaveLength(1);
	});
});

describe("missions:update — pilot reassignment (assignee)", () => {
	test("REFUSED: member reassigns pilot to 'eta'", async () => {
		const t = await missionFixture();
		const missionId = await seedMission(t, "org-b");
		await expectDenied(
			member(t).mutation(api.missions.update, { missionId, pilot: "eta" }),
			"missions:update",
			"assignee",
		);
		expect((await t.run((c) => c.db.get(missionId)))?.pilot).toBe("bob");
	});
	test("SERVED: member reassigns pilot to own-roster 'bea'; a non-pilot update is untouched", async () => {
		const t = await missionFixture();
		const missionId = await seedMission(t, "org-b");
		await member(t).mutation(api.missions.update, { missionId, pilot: "bea" });
		await member(t).mutation(api.missions.update, { missionId, progress: 5 });
		expect((await t.run((c) => c.db.get(missionId)))?.pilot).toBe("bea");
	});
	test("MASTER unchanged: any pilot", async () => {
		const t = await missionFixture();
		const missionId = await seedMission(t, "org-b");
		await master(t).mutation(api.missions.update, { missionId, pilot: "eta" });
		expect((await t.run((c) => c.db.get(missionId)))?.pilot).toBe("eta");
	});
});

describe("missionTemplates:instantiateTemplateIntoMission — acting identity", () => {
	async function seeded() {
		const t = await fixture();
		await t.run((ctx) =>
			ctx.db.insert("missionTemplates", {
				name: "tpl",
				description: "d",
				steps: [{ title: "s1", description: "d1" }],
				isDefault: false,
				createdBy: "system",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const missionId = await seedMission(t, "org-b");
		return { t, missionId };
	}
	test("REFUSED: member names callerOrchestrator 'eta'", async () => {
		const { t, missionId } = await seeded();
		await expectDenied(
			member(t).mutation(api.missionTemplates.instantiateTemplateIntoMission, {
				templateName: "tpl",
				missionId,
				callerOrchestrator: "eta",
			}),
			"missionTemplates:instantiateTemplateIntoMission",
			"actor",
		);
		expect(await t.run((c) => c.db.query("tasks").collect())).toHaveLength(0);
	});
	test("SERVED: own-roster callerOrchestrator, and an omitted one", async () => {
		const { t, missionId } = await seeded();
		const a = await member(t).mutation(
			api.missionTemplates.instantiateTemplateIntoMission,
			{ templateName: "tpl", missionId, callerOrchestrator: "bob" },
		);
		const b = await member(t).mutation(
			api.missionTemplates.instantiateTemplateIntoMission,
			{ templateName: "tpl", missionId },
		);
		expect(a.count + b.count).toBe(2);
	});
	test("MASTER unchanged", async () => {
		const { t, missionId } = await seeded();
		const r = await master(t).mutation(
			api.missionTemplates.instantiateTemplateIntoMission,
			{ templateName: "tpl", missionId, callerOrchestrator: "eta" },
		);
		expect(r.count).toBe(1);
	});
});

describe("tasks:create — createdBy already guarded; assignedTo now bound", () => {
	const args = (createdBy: string, assignedTo: string) => ({
		title: "t",
		assignedTo,
		priority: "medium" as const,
		status: "todo" as const,
		createdBy,
	});
	test("ALREADY GUARDED: foreign createdBy is refused (requireAuthenticatedCaller)", async () => {
		const t = await fixture();
		const refusal = await refusalOf(
			member(t).mutation(api.tasks.create, args("eta", "bob")),
		);
		expect(refusal).toContain("CALLER_IDENTITY_MISMATCH");
	});
	test("REFUSED: member assigns to 'eta' (another org's orchestrator)", async () => {
		const t = await fixture();
		await expectDenied(
			member(t).mutation(api.tasks.create, args("bob", "eta")),
			"tasks:create",
			"assignee",
		);
		expect(await t.run((c) => c.db.query("tasks").collect())).toHaveLength(0);
	});
	test("SERVED: own roster on both", async () => {
		const t = await fixture();
		await member(t).mutation(api.tasks.create, args("bob", "bea"));
		expect(await t.run((c) => c.db.query("tasks").collect())).toHaveLength(1);
	});
	test("MASTER unchanged", async () => {
		const t = await fixture();
		await master(t).mutation(api.tasks.create, args("eta", "pi"));
		expect(await t.run((c) => c.db.query("tasks").collect())).toHaveLength(1);
	});
});

describe("tasks:update — assignedTo reassignment (assignee)", () => {
	async function seedTask(t: T, orgId: string | undefined) {
		return await t.run((ctx) =>
			insertTaskRow(ctx, {
				title: "t",
				assignedTo: "bob",
				priority: "medium",
				status: "todo",
				createdBy: "bob",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				orgId,
				clerkOrgId: testClerkOrgId(orgId),
			}),
		);
	}
	test("REFUSED: member reassigns to 'eta'", async () => {
		const t = await fixture();
		const taskId = await seedTask(t, "org-b");
		await expectDenied(
			member(t).mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "bob",
				assignedTo: "eta",
			}),
			"tasks:update",
			"assignee",
		);
		expect((await t.run((c) => c.db.get(taskId)))?.assignedTo).toBe("bob");
	});
	test("SERVED: own roster; non-assignment update untouched", async () => {
		const t = await fixture();
		const taskId = await seedTask(t, "org-b");
		await member(t).mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "bob",
			assignedTo: "bea",
		});
		expect((await t.run((c) => c.db.get(taskId)))?.assignedTo).toBe("bea");
		await member(t).mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "bob",
			title: "renamed",
		});
	});
	test("MASTER: an assignee must still be an agent of the task's own org (M7); an own-org agent is served", async () => {
		const t = await fixture();
		const taskId = await seedTask(t, "org-b");
		// "eta" is the fleet's agent, not org-b's: an assignment resolves to an
		// agents-row ID of the task's own org, even for the master.
		const refusal = await refusalOf(
			master(t).mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "system",
				assignedTo: "eta",
			}),
		);
		expect(refusal).toContain("RBAC_DENIED");
		expect(refusal).toContain("assignee-not-an-agent-of-org");
		expect((await t.run((c) => c.db.get(taskId)))?.assignedTo).toBe("bob");
		await master(t).mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "system",
			assignedTo: "bea",
		});
		expect((await t.run((c) => c.db.get(taskId)))?.assignedTo).toBe("bea");
	});
});

describe("recurringTasks — one roster rule (normalised, '*' names nobody)", () => {
	const args = (assignedTo: string) => ({
		title: "r",
		assignedTo,
		priority: "medium" as const,
		cronExpression: "0 9 * * *",
		createdBy: "bob",
	});
	test("REFUSED: create for foreign 'eta'", async () => {
		const t = await fixture({ agents: false });
		await expectDenied(
			member(t).mutation(api.recurringTasks.create, args("eta")),
			"recurringTasks:create",
			"assignee",
		);
	});
	test("SERVED: create for 'Bob' (normalisation) and own roster", async () => {
		const t = await fixture({ agents: false });
		await member(t).mutation(api.recurringTasks.create, args("Bob"));
		await member(t).mutation(api.recurringTasks.create, args("bea"));
		expect(await t.run((c) => c.db.query("recurringTasks").collect())).toHaveLength(2);
	});
	test("REFUSED: update reassigns to foreign; SERVED: to own roster", async () => {
		const t = await fixture({ agents: false });
		const id = await member(t).mutation(api.recurringTasks.create, args("bob"));
		await expectDenied(
			member(t).mutation(api.recurringTasks.update, {
				recurringTaskId: id,
				assignedTo: "eta",
			}),
			"recurringTasks:update",
			"assignee",
		);
		await member(t).mutation(api.recurringTasks.update, {
			recurringTaskId: id,
			assignedTo: "BEA",
		});
		expect((await t.run((c) => c.db.get(id)))?.assignedTo).toBe("BEA");
	});
	test("MASTER unchanged", async () => {
		const t = await fixture({ agents: false });
		await master(t).mutation(api.recurringTasks.create, args("eta"));
		expect(await t.run((c) => c.db.query("recurringTasks").collect())).toHaveLength(1);
	});
});
