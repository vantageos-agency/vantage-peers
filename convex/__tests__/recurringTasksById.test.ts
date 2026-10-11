/// <reference types="vite/client" />
// allow-missing-refs: new files this agent creates -- recurringTasksById.test.ts and convex/migrations/backfill_recurring_task_actor_ids.ts
/**
 * Module M10h: the recurring-task doors decide on actor IDs, never on names.
 *
 * POLES
 *   (a) ASSIGN   assignedToId is an agents-row ID of the schedule's own org. A
 *                label with no active agent there (unknown, or registered only in
 *                another org) is refused RBAC_DENIED assignee-not-an-agent-of-org,
 *                nothing is written. Same for a reassignment through `update`.
 *   (b) CREATE   createdById is the VERIFIED caller's ID (credential / verifiedActor
 *                / person), never a value the client typed.
 *   (c) DOORS    update / pause / resume / remove, on the agent path, authorise on
 *                createdById / assignedToId: a row whose LABEL equals the caller's
 *                name but whose ID is another agent's is refused, the row untouched.
 *   (d) SPAWN    processDueTasks stamps the schedule's STORED IDs on the task (the
 *                stored ID wins over a label that now names another agent); a
 *                schedule with no IDs is resolved once in its own org.
 *   (e) LIST     the assignee filter is by ID; a label naming an agent of another
 *                org is refused; a scoped caller with no schedules gets an empty
 *                SUCCESS.
 *   (f) FLEET    the fleet service account keeps its grants (create / list /
 *                pause / resume / remove across the fleet).
 */

import { describe, expect, test, beforeEach } from "vitest";
import { agentIdOf } from "../../tests/lib/agentIdOf";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedFleetAgents } from "../../tests/lib/seedFleetAgents";
import { api, internal } from "../_generated/api";
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
const createT = (): T => convexTest(schema, modules);

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
		org_role: "org:editor",
	} as Parameters<typeof t.withIdentity>[0]);

const asServiceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

let t: T;
let secretClioA: string;
let secretVeraA: string;
let clioA: Id<"agents">;
let veraA: Id<"agents">;
let clioB: Id<"agents">;

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
	await t.run(async (ctx) => {
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: Date.now(),
		});
	});
	// "ghost" is on org-a's roster but has no agents row anywhere; "zed" is on
	// org-a's roster but is registered only in org-b.
	await seedOrg("org-a", ["clio", "vera", "ghost", "zed"]);
	await seedOrg("org-b", ["clio", "vera", "zed"]);
	await register("org-a", "clio");
	await register("org-a", "vera");
	await register("org-b", "clio");
	await register("org-b", "zed");
	clioA = await agentIdOf(t, "org-a", "clio");
	veraA = await agentIdOf(t, "org-a", "vera");
	clioB = await agentIdOf(t, "org-b", "clio");
	secretClioA = (
		await adminOf(t, "org-a").mutation(api.agentCredentials.mintAgentCredential, {
			orgSlug: "org-a",
			agentId: clioA,
		})
	).secret;
	secretVeraA = (
		await adminOf(t, "org-a").mutation(api.agentCredentials.mintAgentCredential, {
			orgSlug: "org-a",
			agentId: veraA,
		})
	).secret;
});

async function refusal(p: Promise<unknown>): Promise<string> {
	const err = await p.then(
		() => null,
		(e: Error) => e,
	);
	expect(err, "expected a refusal").not.toBeNull();
	return `${(err as Error).message} ${JSON.stringify((err as { data?: unknown }).data ?? "")}`;
}

const rowCount = () =>
	t.run(async (ctx) => (await ctx.db.query("recurringTasks").collect()).length);
const getRow = (id: Id<"recurringTasks">) => t.run((ctx) => ctx.db.get(id));

const createArgs = (over: Record<string, unknown> = {}) => ({
	title: "standup",
	assignedTo: "vera",
	priority: "medium" as const,
	cronExpression: "0 9 * * *",
	createdBy: "clio",
	agentCredentialSecret: secretClioA,
	...over,
});

describe("(a) assign: the assignee is an agent of the schedule's own org", () => {
	test("own org: assignedToId is the assignee's row ID, createdById the credential holder's", async () => {
		const id = await memberOf(t, "org-a").mutation(
			api.recurringTasks.create,
			createArgs(),
		);
		const row = await getRow(id);
		expect(row?.assignedToId).toBe(veraA);
		expect(row?.createdById).toBe(clioA);
		expect(row?.orgId).toBe("org-a");
	});

	test("an assignee label registered only in ANOTHER org is refused by name across orgs", async () => {
		const out = await refusal(
			memberOf(t, "org-a").mutation(
				api.recurringTasks.create,
				createArgs({ assignedTo: "zed" }),
			),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("assignee-not-an-agent-of-org");
		expect(await rowCount()).toBe(0);
	});

	test("an assignee label naming no agent anywhere is refused, nothing written", async () => {
		const out = await refusal(
			memberOf(t, "org-a").mutation(
				api.recurringTasks.create,
				createArgs({ assignedTo: "ghost" }),
			),
		);
		expect(out).toContain("assignee-not-an-agent-of-org");
		expect(await rowCount()).toBe(0);
	});

	test("update: reassigning to a label with no agent in the row's org is refused, the row untouched", async () => {
		const id = await memberOf(t, "org-a").mutation(
			api.recurringTasks.create,
			createArgs(),
		);
		const out = await refusal(
			memberOf(t, "org-a").mutation(api.recurringTasks.update, {
				recurringTaskId: id,
				assignedTo: "zed",
			}),
		);
		expect(out).toContain("assignee-not-an-agent-of-org");
		const row = await getRow(id);
		expect(row?.assignedTo).toBe("vera");
		expect(row?.assignedToId).toBe(veraA);
	});

	test("update: reassigning to an agent of the org moves the ID with the label", async () => {
		const id = await memberOf(t, "org-a").mutation(
			api.recurringTasks.create,
			createArgs(),
		);
		await memberOf(t, "org-a").mutation(api.recurringTasks.update, {
			recurringTaskId: id,
			assignedTo: "clio",
		});
		const row = await getRow(id);
		expect(row?.assignedTo).toBe("clio");
		expect(row?.assignedToId).toBe(clioA);
	});
});

describe("(b) create: the creator is the verified caller", () => {
	test("the human path records the person as its own ID", async () => {
		const id = await memberOf(t, "org-a").mutation(api.recurringTasks.create, {
			title: "h",
			assignedTo: "vera",
			priority: "low",
			cronExpression: "0 9 * * *",
		});
		const row = await getRow(id);
		expect(row?.createdBy).toBe("user:reader-of-org-a");
		expect(row?.createdById).toBe("user:reader-of-org-a");
		expect(row?.assignedToId).toBe(veraA);
	});

	test("a credential for another agent cannot be used to author as 'clio'", async () => {
		const out = await refusal(
			memberOf(t, "org-a").mutation(
				api.recurringTasks.create,
				createArgs({ agentCredentialSecret: secretVeraA }),
			),
		);
		expect(out).toMatch(/AGENT_IDENTITY_MISMATCH/);
		expect(await rowCount()).toBe(0);
	});
});

describe("(c) doors on the agent path decide on IDs", () => {
	test("the creator agent pauses, resumes and removes its schedule", async () => {
		const id = await memberOf(t, "org-a").mutation(
			api.recurringTasks.create,
			createArgs(),
		);
		const proof = {
			taskId: id,
			callerOrchestrator: "clio",
			agentCredentialSecret: secretClioA,
		};
		await memberOf(t, "org-a").mutation(api.recurringTasks.pause, proof);
		expect((await getRow(id))?.active).toBe(false);
		await memberOf(t, "org-a").mutation(api.recurringTasks.resume, proof);
		expect((await getRow(id))?.active).toBe(true);
		await memberOf(t, "org-a").mutation(api.recurringTasks.remove, proof);
		expect(await getRow(id)).toBeNull();
	});

	test("an agent that is neither creator nor assignee is refused, the row untouched", async () => {
		const id = await memberOf(t, "org-a").mutation(
			api.recurringTasks.create,
			createArgs({ assignedTo: "clio" }),
		);
		// vera (org-a) is neither the creator (clio) nor the assignee (clio).
		const out = await refusal(
			memberOf(t, "org-a").mutation(api.recurringTasks.pause, {
				taskId: id,
				callerOrchestrator: "vera",
				agentCredentialSecret: secretVeraA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect((await getRow(id))?.active).toBe(true);
	});

	test("a row whose LABEL equals the caller's name but whose ID is another agent's is refused", async () => {
		// Seeded as a legacy/renamed row: label "clio", IDs of org-b's clio.
		const id = await t.run((ctx) =>
			ctx.db.insert("recurringTasks", {
				title: "renamed",
				assignedTo: "clio",
				assignedToId: clioB,
				createdBy: "clio",
				createdById: clioB,
				priority: "low",
				cronExpression: "0 9 * * *",
				nextRunAt: Date.now() + 1000,
				active: true,
				orgId: "org-a",
				clerkOrgId: testClerkOrgId("org-a"),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const out = await refusal(
			memberOf(t, "org-a").mutation(api.recurringTasks.update, {
				recurringTaskId: id,
				title: "hijack",
				callerOrchestrator: "clio",
				agentCredentialSecret: secretClioA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect((await getRow(id))?.title).toBe("renamed");
	});

	test("a member of another org cannot reach the schedule at all", async () => {
		const id = await memberOf(t, "org-a").mutation(
			api.recurringTasks.create,
			createArgs(),
		);
		const out = await refusal(
			memberOf(t, "org-b").mutation(api.recurringTasks.pause, { taskId: id }),
		);
		expect(out).toContain("RBAC_DENIED");
		expect((await getRow(id))?.active).toBe(true);
	});
});

describe("(d) spawn: the task carries the schedule's IDs", () => {
	const dueRow = (over: Record<string, unknown>) => ({
		title: "spawned",
		assignedTo: "vera",
		createdBy: "clio",
		priority: "low" as const,
		cronExpression: "0 9 * * *",
		nextRunAt: 1,
		active: true,
		orgId: "org-a",
		clerkOrgId: testClerkOrgId("org-a"),
		createdAt: 1,
		updatedAt: 1,
		...over,
	});
	const tasks = () => t.run((ctx) => ctx.db.query("tasks").collect());

	test("stored IDs are stamped on the spawned task (and win over a label that now names another agent)", async () => {
		await t.run((ctx) =>
			// label says vera, the stored ID is clio's: the ID is the assignee.
			ctx.db.insert(
				"recurringTasks",
				dueRow({ assignedToId: clioA, createdById: veraA }) as never,
			),
		);
		const r = await t.mutation(internal.recurringTasks.processDueTasks, {});
		expect(r).toEqual({ created: 1, failed: 0 });
		const [task] = await tasks();
		expect(task.assignedToId).toBe(clioA);
		expect(task.createdById).toBe(veraA);
		expect(task.orgId).toBe("org-a");
	});

	test("a schedule written before the ID columns is resolved once in its own org", async () => {
		await t.run((ctx) =>
			ctx.db.insert("recurringTasks", dueRow({}) as never),
		);
		await t.mutation(internal.recurringTasks.processDueTasks, {});
		const [task] = await tasks();
		expect(task.assignedToId).toBe(veraA);
		expect(task.createdById).toBe(clioA);
	});

	test("the same label in another org never crosses over", async () => {
		await t.run((ctx) =>
			ctx.db.insert(
				"recurringTasks",
				dueRow({ orgId: "org-b", clerkOrgId: testClerkOrgId("org-b"), assignedTo: "clio" }) as never,
			),
		);
		await t.mutation(internal.recurringTasks.processDueTasks, {});
		const [task] = await tasks();
		expect(task.assignedToId).toBe(clioB);
		expect(task.assignedToId).not.toBe(clioA);
	});
});

describe("(e) list: assignee by ID, absence stays an absence", () => {
	test("by assignee: own org's schedule is served; a label that names an agent only in another org is an absence, never that org's rows", async () => {
		await memberOf(t, "org-a").mutation(api.recurringTasks.create, createArgs());
		await memberOf(t, "org-b").mutation(api.recurringTasks.create, {
			title: "theirs",
			assignedTo: "zed",
			priority: "low",
			cronExpression: "0 9 * * *",
		});
		const rows = await memberOf(t, "org-a").query(api.recurringTasks.list, {
			assignedTo: "vera",
		});
		expect(rows.map((r) => r.title)).toEqual(["standup"]);
		// "zed" is org-b's agent: org-a resolves the label in org-a only.
		const foreign = await memberOf(t, "org-a").query(api.recurringTasks.list, {
			assignedTo: "zed",
		});
		expect(foreign).toEqual([]);
	});

	test("a scoped caller with no schedules gets an empty SUCCESS", async () => {
		const rows = await memberOf(t, "org-b").query(api.recurringTasks.list, {});
		expect(rows).toEqual([]);
		const byAssignee = await memberOf(t, "org-b").query(api.recurringTasks.list, {
			assignedTo: "clio",
		});
		expect(byAssignee).toEqual([]);
	});
});

describe("(f) the fleet service account keeps its grants", () => {
	test("create / list / pause / resume / remove across the fleet", async () => {
		const fleet = await seedFleetAgents(t, ["sigma", "eta"]);
		const svc = asServiceAccount(t);
		const id = await svc.mutation(api.recurringTasks.create, {
			title: "fleet",
			assignedTo: "eta",
			priority: "low",
			cronExpression: "0 9 * * *",
			createdBy: "sigma",
		});
		const row = await getRow(id);
		expect(row?.assignedToId).toBe(fleet.eta);
		expect(row?.createdById).toBe(fleet.sigma);
		expect(row?.orgId).toBeUndefined();

		await memberOf(t, "org-a").mutation(api.recurringTasks.create, createArgs());
		const all = await svc.query(api.recurringTasks.list, {});
		expect(all.map((r) => r.title).sort()).toEqual(["fleet", "standup"]);
		const byEta = await svc.query(api.recurringTasks.list, { assignedTo: "eta" });
		expect(byEta.map((r) => r.title)).toEqual(["fleet"]);

		await svc.mutation(api.recurringTasks.pause, { taskId: id });
		await svc.mutation(api.recurringTasks.resume, { taskId: id });
		await svc.mutation(api.recurringTasks.remove, { taskId: id });
		expect(await getRow(id)).toBeNull();
	});
});
