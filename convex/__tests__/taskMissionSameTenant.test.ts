/// <reference types="vite/client" />
// taskMissionSameTenant.test.ts — task k175x770r9f6h01xt0wg0hdd798hf8m4.
//
// A task may reference only a mission of its OWN tenant (the R-52 rule:
// sameTenantStamp over server-stamped rows). tasks:create and tasks:update
// share one predicate (lib/missionTenant.ts); a foreign missionId is refused
// MISSION_FOREIGN_TENANT and nothing is written. The auto-complete
// all-done count reads only the mission's own tenant's tasks.
//
// Poles: REFUSED (foreign / fleet mission for an org member), PRESENT (own
// mission; master keeps today's behaviour), ALL-DONE (a foreign task row does
// not hold the mission open). Fictitious identifiers only.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { seedRosterAgent } from "../../tests/fixtures/rosterAgent";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import {
	insertTaskRow,
	mintAgentSecret,
	seedFleetAgents,
} from "../../tests/lib/seedFleetAgents";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync"),
	),
);

const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const SEAT = "seat-x";
const asOrg = (t: T, slug: string) =>
	t.withIdentity({
		subject: `user-${slug}`,
		organizationId: slug,
		org_id: testClerkOrgId(slug),
		org_role: "org:editor",
	} as Parameters<T["withIdentity"]>[0]);
const asMaster = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Parameters<
		T["withIdentity"]
	>[0]);

const seatSecrets = new Map<string, string>();

async function seedOrgs(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("taskClosureConfig", {
			key: "billableProjects",
			value: [],
			updatedAt: 0,
		});
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [SEAT],
				scopes: ["view-own-tasks", "view-own-missions"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
			await seedRosterAgent(ctx, slug, SEAT);
		}
	});
	for (const slug of ["org-a", "org-b"]) {
		seatSecrets.set(slug, await mintAgentSecret(t, slug, SEAT));
	}
}

const missionRow = (orgId: string | undefined) => ({
	name: "m",
	project: "p",
	status: "execute" as const,
	priority: "medium" as const,
	pilot: SEAT,
	agents: [SEAT],
	createdBy: SEAT,
	createdAt: 1,
	updatedAt: 1,
	...(orgId !== undefined ? { orgId, clerkOrgId: testClerkOrgId(orgId) } : {}),
});

const NOTE =
	"Completed the work in commit abcdef1234567 with regression test, 3/3 pass";
const REFUSAL = /MISSION_FOREIGN_TENANT/;

const createIn = (t: T, org: string, missionId: Id<"missions"> | undefined) =>
	asOrg(t, org).mutation(api.tasks.create, {
		agentCredentialSecret: seatSecrets.get(org),
		title: "t",
		assignedTo: SEAT,
		priority: "high",
		status: "todo",
		createdBy: SEAT,
		...(missionId !== undefined ? { missionId } : {}),
	});

const ownTask = (t: T, org: string) =>
	t.run((ctx) =>
		insertTaskRow(ctx, {
			title: `${org} task`,
			assignedTo: SEAT,
			createdBy: SEAT,
			priority: "low",
			status: "todo",
			orgId: org,
			clerkOrgId: testClerkOrgId(org),
			createdAt: 1,
			updatedAt: 1,
		}),
	);

describe("tasks:create — foreign missionId", () => {
	test("REFUSED: org-a creating a task on org-b's mission, nothing written", async () => {
		const t = makeT();
		await seedOrgs(t);
		const missionId = await t.run((ctx) =>
			ctx.db.insert("missions", missionRow("org-b")),
		);
		await expect(createIn(t, "org-a", missionId)).rejects.toThrow(REFUSAL);
		expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toEqual([]);
	});

	test("REFUSED: org-a creating a task on a fleet (unstamped) mission", async () => {
		const t = makeT();
		await seedOrgs(t);
		const missionId = await t.run((ctx) =>
			ctx.db.insert("missions", missionRow(undefined)),
		);
		await expect(createIn(t, "org-a", missionId)).rejects.toThrow(REFUSAL);
	});

	test("PRESENT: org-a creating a task on its own mission, or on none", async () => {
		const t = makeT();
		await seedOrgs(t);
		const missionId = await t.run((ctx) =>
			ctx.db.insert("missions", missionRow("org-a")),
		);
		const id = await createIn(t, "org-a", missionId);
		expect((await t.run((ctx) => ctx.db.get(id)))?.missionId).toBe(missionId);
		await createIn(t, "org-a", undefined);
	});

	test("PRESENT: master (fleet service account) keeps today's behaviour, any mission is accepted", async () => {
		const t = makeT();
		await seedOrgs(t);
		await seedFleetAgents(t, ["sigma"]);
		const missionId = await t.run((ctx) =>
			ctx.db.insert("missions", missionRow("org-b")),
		);
		const id = await asMaster(t).mutation(api.tasks.create, {
			title: "master task",
			assignedTo: "sigma",
			priority: "high",
			status: "todo",
			createdBy: "sigma",
			missionId,
		});
		expect((await t.run((ctx) => ctx.db.get(id)))?.missionId).toBe(missionId);
	});
});

describe("tasks:update — foreign missionId", () => {
	const updateIn = (
		t: T,
		org: string,
		taskId: Id<"tasks">,
		missionId: Id<"missions">,
	) =>
		asOrg(t, org).mutation(api.tasks.update, {
			agentCredentialSecret: seatSecrets.get(org),
			taskId,
			callerOrchestrator: SEAT,
			missionId,
		});

	test("REFUSED: org-a attaching its task to org-b's mission, row byte-identical", async () => {
		const t = makeT();
		await seedOrgs(t);
		const taskId = await ownTask(t, "org-a");
		const missionId = await t.run((ctx) =>
			ctx.db.insert("missions", missionRow("org-b")),
		);
		const before = await t.run((ctx) => ctx.db.get(taskId));
		await expect(updateIn(t, "org-a", taskId, missionId)).rejects.toThrow(
			REFUSAL,
		);
		expect(await t.run((ctx) => ctx.db.get(taskId))).toEqual(before);
	});

	test("PRESENT: org-a attaching its task to its own mission", async () => {
		const t = makeT();
		await seedOrgs(t);
		const taskId = await ownTask(t, "org-a");
		const missionId = await t.run((ctx) =>
			ctx.db.insert("missions", missionRow("org-a")),
		);
		await updateIn(t, "org-a", taskId, missionId);
		expect((await t.run((ctx) => ctx.db.get(taskId)))?.missionId).toBe(
			missionId,
		);
	});

	test("PRESENT: master keeps today's behaviour on update", async () => {
		const t = makeT();
		await seedOrgs(t);
		const taskId = await ownTask(t, "org-a");
		const missionId = await t.run((ctx) =>
			ctx.db.insert("missions", missionRow("org-b")),
		);
		await asMaster(t).mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "system",
			missionId,
		});
		expect((await t.run((ctx) => ctx.db.get(taskId)))?.missionId).toBe(
			missionId,
		);
	});
});

describe("tasks:complete all-done count — same-tenant tasks only", () => {
	async function complete(t: T, taskId: Id<"tasks">) {
		await asOrg(t, "org-a").mutation(api.tasks.complete, {
			agentCredentialSecret: seatSecrets.get("org-a"),
			taskId,
			callerOrchestrator: SEAT,
			completionNote: NOTE,
		});
	}
	const foreignOpenTasks = (t: T, missionId: Id<"missions">, n: number) =>
		t.run(async (ctx) => {
			for (let i = 0; i < n; i++) {
				await insertTaskRow(ctx, {
					title: `legacy foreign ${i}`,
					assignedTo: SEAT,
					createdBy: SEAT,
					priority: "low",
					status: "todo",
					orgId: "org-b",
					clerkOrgId: testClerkOrgId("org-b"),
					missionId,
					createdAt: 1,
					updatedAt: 1,
				});
			}
		});

	test("a foreign open task (already stored) does not hold org-a's mission open", async () => {
		const t = makeT();
		await seedOrgs(t);
		const missionId = await t.run((ctx) =>
			ctx.db.insert("missions", missionRow("org-a")),
		);
		const mine = await createIn(t, "org-a", missionId);
		await foreignOpenTasks(t, missionId, 3);
		await complete(t, mine);
		expect((await t.run((ctx) => ctx.db.get(missionId)))?.status).toBe(
			"complete",
		);
	});

	test("a same-tenant open task still holds the mission open", async () => {
		const t = makeT();
		await seedOrgs(t);
		const missionId = await t.run((ctx) =>
			ctx.db.insert("missions", missionRow("org-a")),
		);
		const mine = await createIn(t, "org-a", missionId);
		await createIn(t, "org-a", missionId);
		await foreignOpenTasks(t, missionId, 3);
		await complete(t, mine);
		expect((await t.run((ctx) => ctx.db.get(missionId)))?.status).toBe(
			"execute",
		);
	});
});

// A NONEXISTENT missionId is refused too (fail closed), typed MISSION_NOT_FOUND.
describe("nonexistent missionId — MISSION_NOT_FOUND", () => {
	const NOT_FOUND = /MISSION_NOT_FOUND/;
	const deletedMission = (t: T, org: string | undefined) =>
		t.run(async (ctx) => {
			const id = await ctx.db.insert("missions", missionRow(org));
			await ctx.db.delete(id);
			return id;
		});

	test("REFUSED: tasks:create with a deleted mission, nothing written", async () => {
		const t = makeT();
		await seedOrgs(t);
		const missionId = await deletedMission(t, "org-a");
		await expect(createIn(t, "org-a", missionId)).rejects.toThrow(NOT_FOUND);
		expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toEqual([]);
	});

	test("REFUSED: tasks:update with a deleted mission, row byte-identical", async () => {
		const t = makeT();
		await seedOrgs(t);
		const taskId = await ownTask(t, "org-a");
		const missionId = await deletedMission(t, "org-a");
		const before = await t.run((ctx) => ctx.db.get(taskId));
		await expect(
			asOrg(t, "org-a").mutation(api.tasks.update, {
				agentCredentialSecret: seatSecrets.get("org-a"),
				taskId,
				callerOrchestrator: SEAT,
				missionId,
			}),
		).rejects.toThrow(NOT_FOUND);
		expect(await t.run((ctx) => ctx.db.get(taskId))).toEqual(before);
	});

	test("REFUSED: the master too (fail closed on a dangling reference)", async () => {
		const t = makeT();
		await seedOrgs(t);
		await seedFleetAgents(t, ["sigma"]);
		const missionId = await deletedMission(t, "org-b");
		await expect(
			asMaster(t).mutation(api.tasks.create, {
				title: "master task",
				assignedTo: "sigma",
				priority: "high",
				status: "todo",
				createdBy: "sigma",
				missionId,
			}),
		).rejects.toThrow(NOT_FOUND);
	});
});
