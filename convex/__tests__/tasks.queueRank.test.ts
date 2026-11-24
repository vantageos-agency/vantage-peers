/// <reference types="vite/client" />
//
// Explicit per-assignee task queue order (task k174gp4nejkdmh4wt6zb7tgy1x8jvhpc).
// VantagePeers Cloud (multi-tenant) and Self-host share this backend.
//
// Additive change: `tasks.queueRank`, `client_org_mapping.queueCoordinatorIds`,
// `tasks:reorderQueue`, `tasks:nextForAssignee`, `tasks:list { sort: "queue" }`,
// `clientOrgMapping:setQueueCoordinators`.
//
// Authority (rule authority-attached-to-anonymous-object): a reorder is allowed
// iff the caller IS the assignee, or is a listed queue coordinator of the task's
// org (read live from client_org_mapping), or is the org:admin person of that org.
// The creator of a task, another org's admin and an unresolved caller are refused.
// Cross-tenant poles carry RBAC_DENIED assertions.

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { findAgentId } from "../../tests/lib/agentIdOf";
import { insertTaskRow, seedOrgAgents } from "../../tests/lib/seedFleetAgents";
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

type Priority = "urgent" | "high" | "medium" | "low";

async function mapping(t: T, slug: string, allowed: string[]) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: allowed,
			scopes: ["view-own-tasks", "view-own-missions"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function fixture() {
	const t = createT();
	await mapping(t, "org-b", ["bob", "bea", "cal", "dan"]);
	await mapping(t, "org-c", ["zed"]);
	await t.run(async (ctx) => {
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: Date.now(),
		});
	});
	await seedOrgAgents(t, [
		["org-b", "bob"],
		["org-b", "bea"],
		["org-b", "cal"],
		["org-b", "dan"],
		["org-c", "zed"],
	]);
	await t.run(async (ctx) => {
		for (const slug of ["org-b", "org-c"]) {
			const agents = await ctx.db
				.query("agents")
				.withIndex("by_org", (q) => q.eq("orgSlug", slug))
				.collect();
			const row = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", slug))
				.first();
			if (row !== null) {
				await ctx.db.patch(row._id, { allowedAgentIds: agents.map((a) => a._id) });
			}
		}
	});
	return t;
}

const service = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const person = (t: T, role: string, slug = "org-b", subject = `p-${role}-${slug}`) =>
	t.withIdentity({
		subject,
		organizationId: slug,
		org_id: testClerkOrgId(slug),
		org_role: role,
	} as Identity);

// An agent acting through the service account: the transport verified its ID and org.
async function asAgent(t: T, slug: string, name: string) {
	const agentId = (await findAgentId(t, slug, name)) as Id<"agents">;
	return {
		callerOrchestrator: name,
		verifiedActor: { agentId, orgSlug: slug },
		verifiedOrg: { orgSlug: slug, orgId: testClerkOrgId(slug) },
	};
}

async function seedTask(
	t: T,
	o: {
		title: string;
		assignedTo?: string;
		createdBy?: string;
		priority?: Priority;
		status?: "todo" | "in_progress" | "review" | "done";
		org?: string;
		queueRank?: number;
		dependsOn?: Id<"tasks">[];
	},
): Promise<Id<"tasks">> {
	const org = o.org ?? "org-b";
	return await t.run((ctx) =>
		insertTaskRow(ctx, {
			title: o.title,
			assignedTo: o.assignedTo ?? "bob",
			createdBy: o.createdBy ?? "bea",
			priority: o.priority ?? "medium",
			status: o.status ?? "todo",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			orgId: org,
			clerkOrgId: testClerkOrgId(org),
			...(o.queueRank !== undefined ? { queueRank: o.queueRank } : {}),
			...(o.dependsOn !== undefined ? { dependsOn: o.dependsOn } : {}),
		}),
	);
}

async function rankOf(t: T, id: Id<"tasks">): Promise<number | undefined> {
	const row = await t.run((ctx) => ctx.db.get(id));
	return (row as { queueRank?: number } | null)?.queueRank;
}

async function refusalOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		return typeof data === "string" ? data : String(e);
	}
	throw new Error("expected a refusal, got a success");
}

// A queue of bob's: q1 (oldest) .. q4, plus an in-progress and a done one.
async function queue(t: T) {
	const q1 = await seedTask(t, { title: "q1", priority: "low" });
	const q2 = await seedTask(t, { title: "q2", priority: "urgent" });
	const q3 = await seedTask(t, { title: "q3", priority: "high" });
	const q4 = await seedTask(t, { title: "q4", priority: "urgent" });
	const wip = await seedTask(t, { title: "wip", status: "in_progress" });
	const done = await seedTask(t, { title: "done", status: "done" });
	return { q1, q2, q3, q4, wip, done };
}

// ─── D1: schema + validators ────────────────────────────────────────────────

describe("D1 — queueRank is an optional, additive field", () => {
	test("a ranked row passes tasks.get's strict returns validator; an unranked row has no queueRank key", async () => {
		const t = await fixture();
		const ranked = await seedTask(t, { title: "ranked", queueRank: 3 });
		const plain = await seedTask(t, { title: "plain" });
		const reader = person(t, "org:editor");
		const a = await reader.query(api.tasks.get, { taskId: ranked });
		const b = await reader.query(api.tasks.get, { taskId: plain });
		expect((a as { queueRank?: number } | null)?.queueRank).toBe(3);
		expect(b).not.toBeNull();
		expect("queueRank" in (b as object)).toBe(false);
	});

	test("lite projection carries queueRank only when set; an unranked lite row is byte-identical to today", async () => {
		const t = await fixture();
		await seedTask(t, { title: "ranked", queueRank: 1 });
		await seedTask(t, { title: "plain" });
		const rows = await person(t, "org:editor").query(api.tasks.list, {
			assignedTo: "bob",
			status: "todo",
			fields: "lite",
		});
		const ranked = rows.find((r) => r.title === "ranked");
		const plain = rows.find((r) => r.title === "plain");
		expect(ranked && "queueRank" in ranked ? ranked.queueRank : undefined).toBe(1);
		expect(Object.keys(plain ?? {}).sort()).toEqual(
			["_creationTime", "_id", "assignedTo", "priority", "status", "title"].sort(),
		);
	});

	test("client_org_mapping accepts queueCoordinatorIds", async () => {
		const t = await fixture();
		const cal = (await findAgentId(t, "org-b", "cal")) as Id<"agents">;
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "org-b"))
				.first();
			await ctx.db.patch(row!._id, { queueCoordinatorIds: [cal] });
			const back = await ctx.db.get(row!._id);
			expect(back?.queueCoordinatorIds).toEqual([cal]);
		});
	});
});

// ─── D2: reorderQueue ───────────────────────────────────────────────────────

describe("D2 — tasks:reorderQueue is a full replacement", () => {
	test("listed tasks get rank 1..N in order; every other open task of the assignee loses its rank", async () => {
		const t = await fixture();
		const { q1, q2, q3, q4, wip } = await queue(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(q4, { queueRank: 9 });
			await ctx.db.patch(wip, { queueRank: 4 });
		});
		const bob = await asAgent(t, "org-b", "bob");
		await service(t).mutation(api.tasks.reorderQueue, {
			assignedTo: "bob",
			taskIds: [q3, q1, q2],
			...bob,
		});
		expect(await rankOf(t, q3)).toBe(1);
		expect(await rankOf(t, q1)).toBe(2);
		expect(await rankOf(t, q2)).toBe(3);
		expect(await rankOf(t, q4)).toBeUndefined();
		expect(await rankOf(t, wip)).toBeUndefined();
	});

	test("assignedToAgentId names the assignee by ID", async () => {
		const t = await fixture();
		const { q1 } = await queue(t);
		const bobId = (await findAgentId(t, "org-b", "bob")) as Id<"agents">;
		await service(t).mutation(api.tasks.reorderQueue, {
			assignedToAgentId: bobId,
			taskIds: [q1],
			...(await asAgent(t, "org-b", "bob")),
		});
		expect(await rankOf(t, q1)).toBe(1);
	});

	test("a second call replaces the first; an empty list clears the whole queue", async () => {
		const t = await fixture();
		const { q1, q2 } = await queue(t);
		const bob = await asAgent(t, "org-b", "bob");
		await service(t).mutation(api.tasks.reorderQueue, { assignedTo: "bob", taskIds: [q1, q2], ...bob });
		await service(t).mutation(api.tasks.reorderQueue, { assignedTo: "bob", taskIds: [q2], ...bob });
		expect(await rankOf(t, q2)).toBe(1);
		expect(await rankOf(t, q1)).toBeUndefined();
		await service(t).mutation(api.tasks.reorderQueue, { assignedTo: "bob", taskIds: [], ...bob });
		expect(await rankOf(t, q2)).toBeUndefined();
	});

	test("REFUSED: a task of another assignee, naming the task; nothing is written", async () => {
		const t = await fixture();
		const { q1 } = await queue(t);
		const theirs = await seedTask(t, { title: "bea's", assignedTo: "bea" });
		const refusal = await refusalOf(
			service(t).mutation(api.tasks.reorderQueue, {
				assignedTo: "bob",
				taskIds: [q1, theirs],
				...(await asAgent(t, "org-b", "bob")),
			}),
		);
		expect(refusal).toContain("QUEUE_TASK_NOT_ASSIGNED");
		expect(refusal).toContain(theirs);
		expect(await rankOf(t, q1)).toBeUndefined();
	});

	test("REFUSED: a task that is not open (done)", async () => {
		const t = await fixture();
		const { q1, done } = await queue(t);
		const refusal = await refusalOf(
			service(t).mutation(api.tasks.reorderQueue, {
				assignedTo: "bob",
				taskIds: [q1, done],
				...(await asAgent(t, "org-b", "bob")),
			}),
		);
		expect(refusal).toContain("QUEUE_TASK_NOT_OPEN");
		expect(refusal).toContain(done);
	});

	test("REFUSED: a task listed twice", async () => {
		const t = await fixture();
		const { q1 } = await queue(t);
		const refusal = await refusalOf(
			service(t).mutation(api.tasks.reorderQueue, {
				assignedTo: "bob",
				taskIds: [q1, q1],
				...(await asAgent(t, "org-b", "bob")),
			}),
		);
		expect(refusal).toContain("QUEUE_TASK_DUPLICATE");
		expect(refusal).toContain(q1);
	});

	test("REFUSED: more than 100 tasks", async () => {
		const t = await fixture();
		const { q1 } = await queue(t);
		const refusal = await refusalOf(
			service(t).mutation(api.tasks.reorderQueue, {
				assignedTo: "bob",
				taskIds: Array.from({ length: 101 }, () => q1),
				...(await asAgent(t, "org-b", "bob")),
			}),
		);
		expect(refusal).toContain("QUEUE_TOO_LONG");
	});

	test("REFUSED (cross-tenant): a task of another organisation is RBAC_DENIED", async () => {
		const t = await fixture();
		const { q1 } = await queue(t);
		const foreign = await seedTask(t, { title: "zed's", assignedTo: "zed", createdBy: "zed", org: "org-c" });
		const refusal = await refusalOf(
			service(t).mutation(api.tasks.reorderQueue, {
				assignedTo: "bob",
				taskIds: [q1, foreign],
				...(await asAgent(t, "org-b", "bob")),
			}),
		);
		expect(refusal).toContain("RBAC_DENIED");
		expect(refusal).toContain(foreign);
		expect(await rankOf(t, foreign)).toBeUndefined();
	});
});

// ─── D3: authority ──────────────────────────────────────────────────────────

describe("D3 — who may reorder, read live", () => {
	test("ALLOWED: the assignee itself", async () => {
		const t = await fixture();
		const { q1 } = await queue(t);
		await service(t).mutation(api.tasks.reorderQueue, {
			assignedTo: "bob",
			taskIds: [q1],
			...(await asAgent(t, "org-b", "bob")),
		});
		expect(await rankOf(t, q1)).toBe(1);
	});

	test("ALLOWED: an org:admin person of the task's org", async () => {
		const t = await fixture();
		const { q1 } = await queue(t);
		await person(t, "org:admin").mutation(api.tasks.reorderQueue, {
			assignedTo: "bob",
			taskIds: [q1],
		});
		expect(await rankOf(t, q1)).toBe(1);
	});

	test("REFUSED: a non-admin person of the same org", async () => {
		const t = await fixture();
		const { q1 } = await queue(t);
		const refusal = await refusalOf(
			person(t, "org:editor").mutation(api.tasks.reorderQueue, { assignedTo: "bob", taskIds: [q1] }),
		);
		expect(refusal).toContain("RBAC_DENIED");
		expect(await rankOf(t, q1)).toBeUndefined();
	});

	test("REFUSED: the creator of the tasks, who is neither assignee nor coordinator", async () => {
		const t = await fixture();
		const { q1 } = await queue(t); // createdBy "bea"
		const refusal = await refusalOf(
			service(t).mutation(api.tasks.reorderQueue, {
				assignedTo: "bob",
				taskIds: [q1],
				...(await asAgent(t, "org-b", "bea")),
			}),
		);
		expect(refusal).toContain("RBAC_DENIED");
		expect(await rankOf(t, q1)).toBeUndefined();
	});

	test("REFUSED (cross-tenant): an org:admin of ANOTHER organisation", async () => {
		const t = await fixture();
		const { q1 } = await queue(t);
		const refusal = await refusalOf(
			person(t, "org:admin", "org-c").mutation(api.tasks.reorderQueue, { assignedTo: "bob", taskIds: [q1] }),
		);
		expect(refusal).toContain("RBAC_DENIED");
		expect(await rankOf(t, q1)).toBeUndefined();
	});

	test("REFUSED (cross-tenant): an agent of another organisation, even if it lists itself as coordinator there", async () => {
		const t = await fixture();
		const { q1 } = await queue(t);
		const zed = (await findAgentId(t, "org-c", "zed")) as Id<"agents">;
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "org-c"))
				.first();
			await ctx.db.patch(row!._id, { queueCoordinatorIds: [zed] });
		});
		const refusal = await refusalOf(
			service(t).mutation(api.tasks.reorderQueue, {
				assignedTo: "bob",
				taskIds: [q1],
				...(await asAgent(t, "org-c", "zed")),
			}),
		);
		expect(refusal).toContain("RBAC_DENIED");
		expect(await rankOf(t, q1)).toBeUndefined();
	});

	test("REFUSED: unresolved caller (no identity)", async () => {
		const t = await fixture();
		const { q1 } = await queue(t);
		await expect(
			t.mutation(api.tasks.reorderQueue, { assignedTo: "bob", taskIds: [q1] }),
		).rejects.toThrow(/AUTH_REQUIRED|RBAC_DENIED/);
		expect(await rankOf(t, q1)).toBeUndefined();
	});

	test("REFUSED: signed in with no organisation", async () => {
		const t = await fixture();
		const { q1 } = await queue(t);
		await expect(
			t
				.withIdentity({ subject: "drifter" } as Identity)
				.mutation(api.tasks.reorderQueue, { assignedTo: "bob", taskIds: [q1] }),
		).rejects.toThrow(/RBAC_DENIED|AUTH_REQUIRED/);
	});

	test("setQueueCoordinators: an org admin lists cal; cal may then reorder bob's queue, and loses it when unlisted (read live)", async () => {
		const t = await fixture();
		const { q1, q2 } = await queue(t);
		const cal = (await findAgentId(t, "org-b", "cal")) as Id<"agents">;
		const asCal = await asAgent(t, "org-b", "cal");
		// Not listed yet: refused.
		expect(
			await refusalOf(
				service(t).mutation(api.tasks.reorderQueue, { assignedTo: "bob", taskIds: [q1], ...asCal }),
			),
		).toContain("RBAC_DENIED");

		await person(t, "org:admin").mutation(api.clientOrgMapping.setQueueCoordinators, {
			clerkOrgSlug: "org-b",
			agentIds: [cal],
		});
		await service(t).mutation(api.tasks.reorderQueue, { assignedTo: "bob", taskIds: [q2, q1], ...asCal });
		expect(await rankOf(t, q2)).toBe(1);
		expect(await rankOf(t, q1)).toBe(2);

		await person(t, "org:admin").mutation(api.clientOrgMapping.setQueueCoordinators, {
			clerkOrgSlug: "org-b",
			agentIds: [],
		});
		expect(
			await refusalOf(
				service(t).mutation(api.tasks.reorderQueue, { assignedTo: "bob", taskIds: [q1], ...asCal }),
			),
		).toContain("RBAC_DENIED");
	});

	test("setQueueCoordinators REFUSED: non-admin member, another org's admin, unauthenticated", async () => {
		const t = await fixture();
		const cal = (await findAgentId(t, "org-b", "cal")) as Id<"agents">;
		const args = { clerkOrgSlug: "org-b", agentIds: [cal] };
		expect(
			await refusalOf(person(t, "org:editor").mutation(api.clientOrgMapping.setQueueCoordinators, args)),
		).toContain("RBAC_DENIED");
		expect(
			await refusalOf(person(t, "org:admin", "org-c").mutation(api.clientOrgMapping.setQueueCoordinators, args)),
		).toContain("RBAC_DENIED");
		await expect(t.mutation(api.clientOrgMapping.setQueueCoordinators, args)).rejects.toThrow(/RBAC_DENIED/);
		const row = await t.run((ctx) =>
			ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "org-b"))
				.first(),
		);
		expect(row?.queueCoordinatorIds).toBeUndefined();
	});

	test("setQueueCoordinators REFUSED: an agent of another organisation cannot be listed", async () => {
		const t = await fixture();
		const zed = (await findAgentId(t, "org-c", "zed")) as Id<"agents">;
		const refusal = await refusalOf(
			person(t, "org:admin").mutation(api.clientOrgMapping.setQueueCoordinators, {
				clerkOrgSlug: "org-b",
				agentIds: [zed],
			}),
		);
		expect(refusal).toContain("AGENT_NOT_IN_ORG");
	});
});

// ─── D4: rank cleared on exit ───────────────────────────────────────────────

describe("D4 — the rank is cleared when the task leaves the queue", () => {
	async function ranked(t: T) {
		const ids = await queue(t);
		await service(t).mutation(api.tasks.reorderQueue, {
			assignedTo: "bob",
			taskIds: [ids.q1, ids.q2, ids.q3, ids.q4],
			...(await asAgent(t, "org-b", "bob")),
		});
		return ids;
	}

	test("update: reassigning clears the rank; an update that keeps the assignee keeps it", async () => {
		const t = await fixture();
		const { q1, q2 } = await ranked(t);
		const bob = await asAgent(t, "org-b", "bob");
		await service(t).mutation(api.tasks.update, { taskId: q2, title: "renamed", ...bob });
		expect(await rankOf(t, q2)).toBe(2);
		await service(t).mutation(api.tasks.update, { taskId: q1, assignedTo: "dan", ...bob });
		expect(await rankOf(t, q1)).toBeUndefined();
	});

	test("complete clears the rank", async () => {
		const t = await fixture();
		const { q1 } = await ranked(t);
		await service(t).mutation(api.tasks.complete, {
			taskId: q1,
			completionNote: "closed in test, 1 task",
			...(await asAgent(t, "org-b", "bob")),
		});
		expect(await rankOf(t, q1)).toBeUndefined();
	});

	test("failTask clears the rank", async () => {
		const t = await fixture();
		const { q2 } = await ranked(t);
		await service(t).mutation(api.tasks.failTask, {
			taskId: q2,
			failureNote: "could not finish this one in the test",
			...(await asAgent(t, "org-b", "bob")),
		});
		expect(await rankOf(t, q2)).toBeUndefined();
	});

	test("cancel (update status cancelled) clears the rank", async () => {
		const t = await fixture();
		const { q3 } = await ranked(t);
		await service(t).mutation(api.tasks.update, {
			taskId: q3,
			status: "cancelled",
			cancelReason: "no longer needed",
			...(await asAgent(t, "org-b", "bea")),
		});
		expect(await rankOf(t, q3)).toBeUndefined();
	});

	test("deleteTask removes the row, so no rank is left behind", async () => {
		const t = await fixture();
		const { q4, q1 } = await ranked(t);
		await service(t).mutation(api.tasks.deleteTask, { taskId: q4, ...(await asAgent(t, "org-b", "bea")) });
		expect(await t.run((ctx) => ctx.db.get(q4))).toBeNull();
		expect(await rankOf(t, q1)).toBe(1);
	});

	test("bulkComplete clears the rank", async () => {
		const t = await fixture();
		const { q1, q2 } = await ranked(t);
		await service(t).mutation(api.tasks.bulkComplete, {
			filter: { assignedTo: "bob", status: "todo" },
			dryRun: false,
			...(await asAgent(t, "org-b", "bob")),
		});
		expect(await rankOf(t, q1)).toBeUndefined();
		expect(await rankOf(t, q2)).toBeUndefined();
	});
});

// ─── D5: nextForAssignee and list sort=queue ────────────────────────────────

describe("D5 — nextForAssignee and tasks:list sort=queue", () => {
	test("MANDATORY: a caller that never ranks gets exactly today's order", async () => {
		const t = await fixture();
		const { q1, q2, q3, q4 } = await queue(t);
		const reader = person(t, "org:editor");
		const listIds = async () =>
			(await reader.query(api.tasks.list, { assignedTo: "bob", status: "todo", fields: "lite" })).map((r) => r._id);

		const before = await listIds();
		// today's order: newest created first
		expect(before).toEqual([q4, q3, q2, q1]);

		// Ranking and then clearing the queue must leave the plain list untouched.
		const bob = await asAgent(t, "org-b", "bob");
		await service(t).mutation(api.tasks.reorderQueue, { assignedTo: "bob", taskIds: [q1, q3], ...bob });
		expect(await listIds()).toEqual(before); // sort absent: the rank changes nothing
		await service(t).mutation(api.tasks.reorderQueue, { assignedTo: "bob", taskIds: [], ...bob });
		expect(await listIds()).toEqual(before);

		// nextForAssignee on an unranked queue: priority, then age (urgent q2 before urgent q4).
		const next = await reader.query(api.tasks.nextForAssignee, { assignedTo: "bob" });
		expect(next.found).toBe(true);
		expect(next.task?._id).toBe(q2);
	});

	test("ranked first by rank asc, then unranked by priority then age", async () => {
		const t = await fixture();
		const { q1, q2, q3, q4 } = await queue(t);
		await service(t).mutation(api.tasks.reorderQueue, {
			assignedTo: "bob",
			taskIds: [q1, q3],
			...(await asAgent(t, "org-b", "bob")),
		});
		const reader = person(t, "org:editor");
		const rows = await reader.query(api.tasks.list, {
			assignedTo: "bob",
			status: "todo",
			fields: "lite",
			sort: "queue",
		});
		expect(rows.map((r) => r._id)).toEqual([q1, q3, q2, q4]);
		const next = await reader.query(api.tasks.nextForAssignee, { assignedTo: "bob" });
		expect(next.task?._id).toBe(q1);
	});

	test("sort=queue orders BEFORE the limit slice", async () => {
		const t = await fixture();
		const { q1, q2 } = await queue(t);
		await service(t).mutation(api.tasks.reorderQueue, {
			assignedTo: "bob",
			taskIds: [q1],
			...(await asAgent(t, "org-b", "bob")),
		});
		const reader = person(t, "org:editor");
		const plain = await reader.query(api.tasks.list, { assignedTo: "bob", status: "todo", fields: "lite", limit: 1 });
		expect(plain.map((r) => r._id)).not.toEqual([q1]); // newest-first would drop the oldest
		const queued = await reader.query(api.tasks.list, {
			assignedTo: "bob",
			status: "todo",
			fields: "lite",
			limit: 1,
			sort: "queue",
		});
		expect(queued.map((r) => r._id)).toEqual([q1]);
		await service(t).mutation(api.tasks.reorderQueue, {
			assignedTo: "bob",
			taskIds: [],
			...(await asAgent(t, "org-b", "bob")),
		});
		const urgent = await reader.query(api.tasks.list, {
			assignedTo: "bob",
			status: "todo",
			fields: "lite",
			limit: 1,
			sort: "queue",
		});
		expect(urgent.map((r) => r._id)).toEqual([q2]); // urgent, oldest of the urgent
	});

	test("a task whose dependsOn are not all done is skipped", async () => {
		const t = await fixture();
		const blocker = await seedTask(t, { title: "blocker", assignedTo: "bea", status: "in_progress" });
		const first = await seedTask(t, { title: "first", priority: "urgent", dependsOn: [blocker] });
		const second = await seedTask(t, { title: "second", priority: "low" });
		const reader = person(t, "org:editor");
		const next = await reader.query(api.tasks.nextForAssignee, { assignedTo: "bob" });
		expect(next.task?._id).toBe(second);
		await t.run(async (ctx) => {
			await ctx.db.patch(blocker, { status: "done" });
		});
		const after = await reader.query(api.tasks.nextForAssignee, { assignedTo: "bob" });
		expect(after.task?._id).toBe(first);
	});

	test("a ranked task with an unmet dependency is skipped too", async () => {
		const t = await fixture();
		const blocker = await seedTask(t, { title: "blocker", assignedTo: "bea", status: "todo" });
		const ranked = await seedTask(t, { title: "ranked", queueRank: 1, dependsOn: [blocker] });
		const free = await seedTask(t, { title: "free", queueRank: 2 });
		const next = await person(t, "org:editor").query(api.tasks.nextForAssignee, { assignedTo: "bob" });
		expect(next.task?._id).toBe(free);
		expect(next.task?._id).not.toBe(ranked);
	});

	test("found:false when the assignee has nothing ready", async () => {
		const t = await fixture();
		const next = await person(t, "org:editor").query(api.tasks.nextForAssignee, { assignedTo: "bob" });
		expect(next).toEqual({ found: false });
	});

	test("tenant gate: another organisation's member sees nothing of this org's queue", async () => {
		const t = await fixture();
		await queue(t);
		const next = await person(t, "org:admin", "org-c").query(api.tasks.nextForAssignee, { assignedTo: "bob" });
		expect(next.found).toBe(false);
		expect(next.task).toBeUndefined();
	});

	test("nextForAssignee by assignedToAgentId", async () => {
		const t = await fixture();
		const { q2 } = await queue(t);
		const bobId = (await findAgentId(t, "org-b", "bob")) as Id<"agents">;
		const next = await person(t, "org:editor").query(api.tasks.nextForAssignee, { assignedToAgentId: bobId });
		expect(next.task?._id).toBe(q2);
	});
});
