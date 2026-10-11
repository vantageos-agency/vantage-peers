/// <reference types="vite/client" />
// allow-missing-refs: new files this agent creates — tasksById.test.ts and convex/migrations/backfill_task_actor_ids.ts
/**
 * Module M7: the task doors decide on actor IDs, never on names.
 *
 * POLES
 *   (a) CREATE      createdById is the VERIFIED caller's agents-row ID; a client
 *                   `createdBy` string naming another agent cannot change it.
 *   (b) ASSIGN      assignedToId is an agents-row ID of the caller's org; an
 *                   assignee with no row there (unknown, or registered only in
 *                   another org) is refused RBAC_DENIED, nothing is written.
 *   (c) DOORS       start/pause/resume/complete/failTask/blockTask/update/
 *                   deleteTask/correctSegment authorise on assignedToId /
 *                   createdById. A row whose LABEL equals the caller's name but
 *                   whose ID is another agent's (a renamed agent; the same name
 *                   in another org) is refused, the row untouched.
 *   (c') LIST       list / listPaginated by assignee match the assignee's ID.
 *   (d) ABSENT      a scoped caller with no tasks gets an empty SUCCESS.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { agentIdOf } from "../../tests/lib/agentIdOf";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

type T = ReturnType<typeof convexTest>;
const createT = (): T =>
	convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;

const adminOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:admin",
	} as Parameters<typeof t.withIdentity>[0]);

const memberOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `reader-of-${org}`,
		organizationId: org,
		org_id: testClerkOrgId(org),
	} as Parameters<typeof t.withIdentity>[0]);

type Caller = ReturnType<typeof memberOf>;

const asServiceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

let t: T;
let secretA: string; // org-a "clio"
let clioA: Id<"agents">;
let clioB: Id<"agents">;
let veraA: Id<"agents">;
let veraB: Id<"agents">;
let retiredA: Id<"agents">; // org-a agent that once carried the label "clio"

async function seedOrg(slug: string, roster: string[]) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: roster,
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function register(org: string, name: string): Promise<Id<"agents">> {
	return await adminOf(t, org).mutation(api.agents.registerAgent, {
		orgSlug: org,
		name,
	});
}

beforeEach(async () => {
	t = createT();
	// "ghost" is on org-a's roster but has no agents row anywhere; "zed" is on
	// org-a's roster but is registered only in org-b.
	await seedOrg("org-a", ["clio", "vera", "ghost", "zed", "clio-retired"]);
	await seedOrg("org-b", ["clio", "vera", "zed"]);
	await register("org-a", "clio");
	await register("org-a", "vera");
	await register("org-a", "clio-retired");
	await register("org-b", "clio");
	await register("org-b", "vera");
	await register("org-b", "zed");
	clioA = await agentIdOf(t, "org-a", "clio");
	veraA = await agentIdOf(t, "org-a", "vera");
	retiredA = await agentIdOf(t, "org-a", "clio-retired");
	clioB = await agentIdOf(t, "org-b", "clio");
	veraB = await agentIdOf(t, "org-b", "vera");
	const minted = await adminOf(t, "org-a").mutation(
		api.agentCredentials.mintAgentCredential,
		{ orgSlug: "org-a", agentId: clioA },
	);
	secretA = minted.secret;
});

async function refusal(p: Promise<unknown>): Promise<string> {
	const err = await p.then(
		() => null,
		(e: Error) => e,
	);
	expect(err, "expected a refusal").not.toBeNull();
	return `${(err as Error).message} ${JSON.stringify((err as { data?: unknown }).data ?? "")}`;
}

const taskCount = () =>
	t.run(async (ctx) => (await ctx.db.query("tasks").collect()).length);

const createArgs = (over: Record<string, unknown>) => ({
	title: "work",
	assignedTo: "vera",
	priority: "medium" as const,
	status: "todo" as const,
	createdBy: "clio",
	agentCredentialSecret: secretA,
	...over,
});

describe("(a) create stamps the verified caller", () => {
	test("createdById is the credential holder's row ID, assignedToId the assignee's", async () => {
		const id = await memberOf(t, "org-a").mutation(
			api.tasks.create,
			createArgs({}),
		);
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.createdById).toBe(clioA);
		expect(row?.assignedToId).toBe(veraA);
		expect(row?.assignedToId).not.toBe(veraB);
	});

	test("a createdBy string naming another agent does not become createdById", async () => {
		const msg = await refusal(
			memberOf(t, "org-a").mutation(
				api.tasks.create,
				createArgs({ createdBy: "vera" }),
			),
		);
		expect(msg).toMatch(/AGENT_IDENTITY_MISMATCH|RBAC_DENIED/);
		expect(await taskCount()).toBe(0);
	});
});

describe("(b) assignment resolves to an agents row of the caller's org", () => {
	test("an assignee on the roster with no agents row is refused", async () => {
		const msg = await refusal(
			memberOf(t, "org-a").mutation(
				api.tasks.create,
				createArgs({ assignedTo: "ghost" }),
			),
		);
		expect(msg).toContain("RBAC_DENIED");
		expect(await taskCount()).toBe(0);
	});

	test("an assignee registered only in another org is refused", async () => {
		const msg = await refusal(
			memberOf(t, "org-a").mutation(
				api.tasks.create,
				createArgs({ assignedTo: "zed" }),
			),
		);
		expect(msg).toContain("RBAC_DENIED");
		expect(await taskCount()).toBe(0);
	});

	test("update refuses a reassignment to an assignee with no row in the org", async () => {
		const id = await memberOf(t, "org-a").mutation(
			api.tasks.create,
			createArgs({}),
		);
		const msg = await refusal(
			memberOf(t, "org-a").mutation(api.tasks.update, {
				taskId: id,
				callerOrchestrator: "clio",
				agentCredentialSecret: secretA,
				assignedTo: "ghost",
			}),
		);
		expect(msg).toContain("RBAC_DENIED");
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.assignedTo).toBe("vera");
		expect(row?.assignedToId).toBe(veraA);
	});
});

// A row whose LABELS read "clio" but whose IDs name ANOTHER agent.
async function labelOnlyRow(orgId: string, assigneeId: string, creatorId: string) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert("tasks", {
			title: "seeded",
			assignedTo: "clio",
			createdBy: "clio",
			assignedToId: assigneeId,
			createdById: creatorId,
			priority: "medium",
			status: "todo",
			orgId,
			clerkOrgId: testClerkOrgId(orgId),
			createdAt: now,
			updatedAt: now,
		});
	});
}

const DOORS: Array<{
	name: string;
	call: (as: Caller, taskId: Id<"tasks">, proof: Record<string, unknown>) => Promise<unknown>;
}> = [
	{ name: "start", call: (as, taskId, p) => as.mutation(api.tasks.start, { taskId, callerOrchestrator: "clio", ...p }) },
	{ name: "pause", call: (as, taskId, p) => as.mutation(api.tasks.pause, { taskId, callerOrchestrator: "clio", ...p }) },
	{ name: "resume", call: (as, taskId, p) => as.mutation(api.tasks.resume, { taskId, callerOrchestrator: "clio", ...p }) },
	{ name: "complete", call: (as, taskId, p) => as.mutation(api.tasks.complete, { taskId, callerOrchestrator: "clio", completionNote: "closed, 1 row", ...p }) },
	{ name: "failTask", call: (as, taskId, p) => as.mutation(api.tasks.failTask, { taskId, callerOrchestrator: "clio", failureNote: "n", ...p }) },
	{ name: "blockTask", call: (as, taskId, p) => as.mutation(api.tasks.blockTask, { taskId, callerOrchestrator: "clio", ...p }) },
	{ name: "update", call: (as, taskId, p) => as.mutation(api.tasks.update, { taskId, callerOrchestrator: "clio", title: "EDITED", ...p }) },
	{ name: "cancel", call: (as, taskId, p) => as.mutation(api.tasks.update, { taskId, callerOrchestrator: "clio", status: "cancelled", cancelReason: "no longer needed", ...p }) },
	{ name: "deleteTask", call: (as, taskId, p) => as.mutation(api.tasks.deleteTask, { taskId, callerOrchestrator: "clio", ...p }) },
	{ name: "correctSegment", call: (as, taskId, p) => as.mutation(api.tasks.correctSegment, { taskId, segmentIndex: 0, start: 1, end: 2, reason: "r", callerOrchestrator: "clio", ...p }) },
];

describe("(c) the doors decide on IDs", () => {
	for (const door of DOORS) {
		test(`${door.name}: a renamed agent's label is not its ID (same org)`, async () => {
			const taskId = await labelOnlyRow("org-a", retiredA, retiredA);
			const before = await t.run((ctx) => ctx.db.get(taskId));
			const msg = await refusal(
				door.call(memberOf(t, "org-a"), taskId, { agentCredentialSecret: secretA }),
			);
			expect(msg).toContain("RBAC_DENIED");
			expect(await t.run((ctx) => ctx.db.get(taskId))).toEqual(before);
		});

		test(`${door.name}: the same name in another org does not act on that org's row`, async () => {
			const taskId = await labelOnlyRow("org-b", clioB, clioB);
			const before = await t.run((ctx) => ctx.db.get(taskId));
			const msg = await refusal(
				door.call(asServiceAccount(t), taskId, {
					verifiedActor: { agentId: clioA, orgSlug: "org-a" },
				}),
			);
			expect(msg).toContain("RBAC_DENIED");
			expect(await t.run((ctx) => ctx.db.get(taskId))).toEqual(before);
		});
	}

	test("the creator-and-assignee by ID still acts (positive control)", async () => {
		const taskId = await labelOnlyRow("org-a", clioA, clioA);
		await memberOf(t, "org-a").mutation(api.tasks.start, {
			taskId,
			callerOrchestrator: "clio",
			agentCredentialSecret: secretA,
		});
		const row = await t.run((ctx) => ctx.db.get(taskId));
		expect(row?.status).toBe("in_progress");
	});
});

describe("(c') list by assignee matches the assignee's ID", () => {
	test("list returns the rows assigned to the caller org's agent, not a same-label row", async () => {
		const mine = await labelOnlyRow("org-a", clioA, veraA);
		await labelOnlyRow("org-a", retiredA, veraA);
		await labelOnlyRow("org-b", clioB, veraB);
		const rows = await memberOf(t, "org-a").query(api.tasks.list, {
			assignedTo: "clio",
		});
		expect(rows.map((r) => r._id)).toEqual([mine]);
	});

	test("listPaginated by assignee matches the ID", async () => {
		const mine = await labelOnlyRow("org-a", clioA, veraA);
		await labelOnlyRow("org-a", retiredA, veraA);
		const res = await memberOf(t, "org-a").query(api.tasks.listPaginated, {
			assignedTo: "clio",
			paginationOpts: { numItems: 20, cursor: null },
		});
		expect(res.page.map((r) => r._id)).toEqual([mine]);
	});
});

describe("(d) an absence stays an absence", () => {
	test("a scoped caller with no tasks gets an empty success", async () => {
		const all = await memberOf(t, "org-a").query(api.tasks.list, {});
		expect(all).toEqual([]);
		const byAssignee = await memberOf(t, "org-a").query(api.tasks.list, {
			assignedTo: "vera",
		});
		expect(byAssignee).toEqual([]);
		const paged = await memberOf(t, "org-a").query(api.tasks.listPaginated, {
			assignedTo: "vera",
			paginationOpts: { numItems: 20, cursor: null },
		});
		expect(paged.page).toEqual([]);
	});

	test("an assignee name that names no agent of the org lists as empty, not an error", async () => {
		await labelOnlyRow("org-a", clioA, veraA);
		const rows = await memberOf(t, "org-a").query(api.tasks.list, {
			assignedTo: "nobody-here",
		});
		expect(rows).toEqual([]);
	});
});
