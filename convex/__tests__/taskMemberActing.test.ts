/// <reference types="vite/client" />
/**
 * convex/__tests__/taskMemberActing.test.ts
 *
 * Task k170mdh8em4vdt2fztcejhz2618fkpm0 — Pi ruling (B): a resolved org MEMBER
 * (Clerk human, no orchestrator name) acts on tasks in its OWN name through
 * tasks.start / complete / blockTask. Bounded by the tenant gate alone; the
 * actor is recorded in `lastActedBy` as "user:<subject>", never an agent name.
 *
 * Poles per door: SERVED (own org) / CROSS-ORG refused / no identity refused /
 * signed-in no-org refused / master with no name still refused / agent path
 * unchanged. Subjects are scoped NON-creator members, never master.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
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

const SERVICE_ACCOUNT_SUBJECT = "test-service-account-user-id";
const MEMBER_A = "user_memberA";

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Caller = ReturnType<T["withIdentity"]>;

const idOf = (subject: string, org?: string, role?: string) =>
	({
		subject,
		...(org ? { organizationSlug: org } : {}),
		...(role ? { org_role: role } : {}),
	}) as Parameters<
		T["withIdentity"]
	>[0];

async function seedOrg(t: T, slug: string, allowed: string[] = ["sigma"]) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			allowedOrchestrators: allowed,
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedTask(
	t: T,
	orgId: string | undefined,
	status: "todo" | "in_progress",
): Promise<Id<"tasks">> {
	return await t.run(async (ctx) =>
		ctx.db.insert("tasks", {
			title: "Member-acting seed",
			assignedTo: "sigma",
			priority: "medium",
			status,
			createdBy: "sigma",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			...(orgId !== undefined ? { orgId } : {}),
			...(status === "in_progress"
				? { startedAt: Date.now(), workSegments: [{ start: Date.now() }] }
				: {}),
		}),
	);
}

const NOTE =
	"Closed by the member from the dashboard; evidence: 3 files, see qa/report.md and PR #1500";
const NOBODY = "# blocked-on-nobody: waiting on the operator's decision";

async function setup() {
	const t = createT();
	await seedOrg(t, "org-a");
	await seedOrg(t, "org-b");
	// Writer-role allowlist is DATA (memberWriterRoles): the fleet default row.
	// The member carries a LISTED role (org:editor) — the only change the
	// member-acting poles needed when the writer-role gate landed.
	await t.run(async (ctx) => {
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: Date.now(),
		});
	});
	return {
		t,
		member: t.withIdentity(idOf(MEMBER_A, "org-a", "org:editor")),
	};
}

type Door = {
	name: "start" | "complete" | "blockTask";
	seedStatus: "todo" | "in_progress";
	call: (c: Caller, taskId: Id<"tasks">, as?: string) => Promise<unknown>;
};

const doors: Door[] = [
	{
		name: "start",
		seedStatus: "todo",
		call: (c, taskId, as) =>
			c.mutation(api.tasks.start, { taskId, callerOrchestrator: as }),
	},
	{
		name: "complete",
		seedStatus: "in_progress",
		call: (c, taskId, as) =>
			c.mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: as,
				completionNote: NOTE,
			}),
	},
	{
		name: "blockTask",
		seedStatus: "in_progress",
		call: (c, taskId, as) =>
			c.mutation(api.tasks.blockTask, {
				taskId,
				callerOrchestrator: as,
				reason: NOBODY,
			}),
	},
];

describe.each(doors)("member acting — $name", (door) => {
	test("member of org A, no callerOrchestrator, org-A task -> served; actor is the human subject", async () => {
		const { t, member } = await setup();
		const taskId = await seedTask(t, "org-a", door.seedStatus);
		await door.call(member, taskId);
		const row = await t.run(async (ctx) => ctx.db.get(taskId));
		expect(row?.lastActedBy).toBe(`user:${MEMBER_A}`);
		expect(row?.lastActedBy).not.toBe("sigma");
		expect(row?.assignedTo).toBe("sigma");
		expect(row?.createdBy).toBe("sigma");
		expect(row?.lastAssignedTo).toBeUndefined();
	});

	test("member of org A on an org-B task -> refused (cross-org), row untouched", async () => {
		const { t, member } = await setup();
		const taskId = await seedTask(t, "org-b", door.seedStatus);
		await expect(door.call(member, taskId)).rejects.toThrow(
			/RBAC_DENIED.*outside the caller's organisation/,
		);
		const row = await t.run(async (ctx) => ctx.db.get(taskId));
		expect(row?.lastActedBy).toBeUndefined();
		expect(row?.status).toBe(door.seedStatus);
	});

	test("unstamped (no orgId) row -> refused for a member (absence grants nothing)", async () => {
		const { t, member } = await setup();
		const taskId = await seedTask(t, undefined, door.seedStatus);
		await expect(door.call(member, taskId)).rejects.toThrow(/RBAC_DENIED/);
	});

	test("no identity -> refused AUTH_REQUIRED", async () => {
		const { t } = await setup();
		const taskId = await seedTask(t, "org-a", door.seedStatus);
		await expect(door.call(t as unknown as Caller, taskId)).rejects.toThrow(
			/AUTH_REQUIRED/,
		);
	});

	test("signed-in, no organisation -> refused", async () => {
		const { t } = await setup();
		const taskId = await seedTask(t, "org-a", door.seedStatus);
		const noOrg = t.withIdentity(idOf("user_noorg"));
		await expect(door.call(noOrg, taskId)).rejects.toThrow(/RBAC_DENIED/);
		const row = await t.run(async (ctx) => ctx.db.get(taskId));
		expect(row?.lastActedBy).toBeUndefined();
	});

	test("master with no callerOrchestrator -> still refused (path unchanged)", async () => {
		const { t } = await setup();
		const taskId = await seedTask(t, "org-a", door.seedStatus);
		const master = t.withIdentity(idOf(SERVICE_ACCOUNT_SUBJECT));
		await expect(door.call(master, taskId)).rejects.toThrow(
			/callerOrchestrator is required/,
		);
	});

	test("agent path unchanged: named assignee served, no human actor written", async () => {
		const { t } = await setup();
		const taskId = await seedTask(t, "org-a", door.seedStatus);
		const proxy = t.withIdentity(idOf("user_agentproxy", "org-a"));
		await door.call(proxy, taskId, "sigma");
		const row = await t.run(async (ctx) => ctx.db.get(taskId));
		expect(row?.lastActedBy).toBeUndefined();
	});

	test("member naming an agent that is neither creator nor assignee -> still refused", async () => {
		const { t, member } = await setup();
		const taskId = await seedTask(t, "org-a", door.seedStatus);
		await expect(door.call(member, taskId, "eta")).rejects.toThrow(
			/CALLER_IDENTITY_MISMATCH|RBAC_DENIED/,
		);
	});
});

describe("member acting — door-specific requirements still bind a member", () => {
	test("complete: completionNote still required", async () => {
		const { t, member } = await setup();
		const taskId = await seedTask(t, "org-a", "in_progress");
		await expect(
			member.mutation(api.tasks.complete, { taskId }),
		).rejects.toThrow(/COMPLETION_NOTE_REQUIRED/);
	});

	test("blockTask: neither blockedOnTaskId nor a blocked-on-nobody marker -> BLOCKED_LINK_REQUIRED", async () => {
		const { t, member } = await setup();
		const taskId = await seedTask(t, "org-a", "in_progress");
		await expect(
			member.mutation(api.tasks.blockTask, { taskId, reason: "just because" }),
		).rejects.toThrow(/BLOCKED_LINK_REQUIRED/);
	});

	test("blockTask: blockedOnTaskId form accepted for a member", async () => {
		const { t, member } = await setup();
		const taskId = await seedTask(t, "org-a", "in_progress");
		const blocker = await t.run(async (ctx) =>
			ctx.db.insert("tasks", {
				title: "peer",
				assignedTo: "eta",
				priority: "medium",
				status: "todo",
				createdBy: "eta",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				orgId: "org-a",
			}),
		);
		await member.mutation(api.tasks.blockTask, {
			taskId,
			blockedOnTaskId: blocker,
		});
		const row = await t.run(async (ctx) => ctx.db.get(taskId));
		expect(row?.status).toBe("blocked");
		expect(row?.lastActedBy).toBe(`user:${MEMBER_A}`);
	});
});

// The opt-in is PER DOOR. Every other caller of assertTaskCallerAuthorized
// (update, failTask, pause, resume, correctSegment — enumerated by
// `grep -n "assertTaskCallerAuthorized(" convex/tasks.ts`) keeps refusing a
// member with no callerOrchestrator. Pins the `opts?.allowOrgMember === true`
// guard: replacing it with `true` opens every door and turns these red.
const otherDoors: {
	name: string;
	call: (c: Caller, taskId: Id<"tasks">) => Promise<unknown>;
}[] = [
	{
		name: "update",
		call: (c, taskId) =>
			c.mutation(api.tasks.update, { taskId, title: "renamed by member" }),
	},
	{
		name: "failTask",
		call: (c, taskId) =>
			c.mutation(api.tasks.failTask, { taskId, failureNote: NOTE }),
	},
	{ name: "pause", call: (c, taskId) => c.mutation(api.tasks.pause, { taskId }) },
	{ name: "resume", call: (c, taskId) => c.mutation(api.tasks.resume, { taskId }) },
	{
		name: "correctSegment",
		call: (c, taskId) =>
			c.mutation(api.tasks.correctSegment, {
				taskId,
				segmentIndex: 0,
				start: 1,
				end: 2,
				reason: "member correction attempt",
			}),
	},
];

describe.each(otherDoors)(
	"member acting is NOT opened on other doors — $name",
	(door) => {
		test("org-A member, no callerOrchestrator, org-A task -> refused 'callerOrchestrator is required', row untouched", async () => {
			const { t, member } = await setup();
			const taskId = await seedTask(t, "org-a", "in_progress");
			const before = await t.run(async (ctx) => ctx.db.get(taskId));
			await expect(door.call(member, taskId)).rejects.toThrow(
				/callerOrchestrator is required/,
			);
			const after = await t.run(async (ctx) => ctx.db.get(taskId));
			expect(after).toEqual(before);
		});
	},
);
