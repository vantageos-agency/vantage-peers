/// <reference types="vite/client" />
/**
 * AUDIT RED reproduction, group R2 — tasks doors.
 *
 * Every test asserts what the door MUST do; a FAIL means the audited defect is
 * real on this tree. Two orgs (org-a, org-b) carry the SAME roster names
 * (sigma, eta, alpha) so only the tenant stamp separates them.
 *
 * Identities (named per test):
 *   member(org-a)  Clerk org member, NOT master, NOT the service account.
 *   service        the claimless fleet service account (only where the audited
 *                  defect IS "the claimless service account reaches a tenant").
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const asMember = (t: T, org: "org-a" | "org-b", n = 1) =>
	t.withIdentity({
		subject: `member-${n}-of-${org}`,
		organizationSlug: org,
		org_role: "org:editor",
	} as Identity);
const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);

async function world(): Promise<T> {
	const t = createT();
	await t.run(async (ctx) => {
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: Date.now(),
		});
		await ctx.db.insert("taskClosureConfig", {
			key: "billableProjects",
			value: [],
			updatedAt: Date.now(),
		});
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: ["sigma", "eta", "alpha"],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
	return t;
}

const seedMission = (t: T, orgId: string) =>
	t.run(async (ctx) =>
		ctx.db.insert("missions", {
			name: `mission of ${orgId}`,
			project: "p",
			status: "execute",
			priority: "low",
			pilot: "sigma",
			agents: ["sigma"],
			createdBy: "sigma",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			orgId,
		}),
	);

type SeedTask = {
	orgId: string;
	title?: string;
	assignedTo?: string;
	createdBy?: string;
	status?: "todo" | "in_progress" | "blocked" | "done";
	dependsOn?: Id<"tasks">[];
	missionId?: Id<"missions">;
	project?: string;
	actualMinutes?: number;
	completedAt?: number;
};
const seedTask = (t: T, o: SeedTask) =>
	t.run(async (ctx) =>
		ctx.db.insert("tasks", {
			title: o.title ?? `task of ${o.orgId}`,
			assignedTo: o.assignedTo ?? "sigma",
			createdBy: o.createdBy ?? "sigma",
			priority: "low",
			status: o.status ?? "todo",
			orgId: o.orgId,
			...(o.dependsOn ? { dependsOn: o.dependsOn } : {}),
			...(o.missionId ? { missionId: o.missionId } : {}),
			...(o.project ? { project: o.project } : {}),
			...(o.actualMinutes !== undefined ? { actualMinutes: o.actualMinutes } : {}),
			...(o.completedAt !== undefined ? { completedAt: o.completedAt } : {}),
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);

const errText = (e: unknown) => {
	const x = e as { data?: unknown; message?: string };
	return `${typeof x.data === "string" ? x.data : JSON.stringify(x.data ?? "")} ${x.message ?? ""}`;
};
async function outcomeOf(p: Promise<unknown>): Promise<{ ok: boolean; text: string }> {
	try {
		await p;
		return { ok: true, text: "" };
	} catch (e) {
		return { ok: false, text: errText(e) };
	}
}

describe("tasks:create — tenant boundary on missionId / dependsOn", () => {
	test("tasks:create — a member of org A can attach a task to its OWN mission and dependency (positive control)", async () => {
		const t = await world();
		const m = await seedMission(t, "org-a");
		const d = await seedTask(t, { orgId: "org-a" });
		const id = await asMember(t, "org-a").mutation(api.tasks.create, {
			title: "x",
			assignedTo: "sigma",
			createdBy: "sigma",
			priority: "low",
			status: "todo",
			missionId: m,
			dependsOn: [d],
		});
		expect(id).toBeDefined();
	});

	test("tasks:create — a member of org A cannot attach a task to org B's mission or depend on org B's task (RBAC_DENIED)", async () => {
		const t = await world();
		const mB = await seedMission(t, "org-b");
		const dB = await seedTask(t, { orgId: "org-b", assignedTo: "eta" });
		const r = await outcomeOf(
			asMember(t, "org-a").mutation(api.tasks.create, {
				title: "planted",
				assignedTo: "sigma",
				createdBy: "sigma",
				priority: "low",
				status: "todo",
				missionId: mB,
				dependsOn: [dB],
			}),
		);
		const planted = (await t.run((ctx) => ctx.db.query("tasks").collect())).filter(
			(x) => x.title === "planted",
		);
		expect(
			{ ok: r.ok, planted: planted.length },
			"task created in org A pointing at org B's mission and task",
		).toEqual({ ok: false, planted: 0 });
		expect(r.text).toMatch(/RBAC_DENIED/);
	});
});

describe("tasks:update — tenant boundary on re-pointed missionId / dependsOn", () => {
	test("tasks:update — a member of org A cannot re-point its own task at org B's mission or task (RBAC_DENIED)", async () => {
		const t = await world();
		const mB = await seedMission(t, "org-b");
		const dB = await seedTask(t, { orgId: "org-b", assignedTo: "eta" });
		const own = await seedTask(t, { orgId: "org-a" });
		const r = await outcomeOf(
			asMember(t, "org-a").mutation(api.tasks.update, {
				taskId: own,
				callerOrchestrator: "sigma",
				missionId: mB,
				dependsOn: [dB],
			}),
		);
		const row = await t.run((ctx) => ctx.db.get(own));
		expect(
			{ ok: r.ok, missionId: row?.missionId, dependsOn: row?.dependsOn },
			"org A task re-pointed at org B's mission / task",
		).toEqual({ ok: false, missionId: undefined, dependsOn: undefined });
		expect(r.text).toMatch(/RBAC_DENIED/);
	});

	test("tasks:update — a member of org A can re-point its own task at its OWN mission (positive control)", async () => {
		const t = await world();
		const mA = await seedMission(t, "org-a");
		const own = await seedTask(t, { orgId: "org-a" });
		await asMember(t, "org-a").mutation(api.tasks.update, {
			taskId: own,
			callerOrchestrator: "sigma",
			missionId: mA,
		});
		expect((await t.run((ctx) => ctx.db.get(own)))?.missionId).toBe(mA);
	});
});

describe("tasks:attachReviewArtifact — first writer wins", () => {
	test("tasks:attachReviewArtifact — a second member typing the first attacher's name cannot overwrite the artifact (members 1 and 2 of org-a)", async () => {
		const t = await world();
		const id = await seedTask(t, { orgId: "org-a", title: "[REVIEW] x" });
		await asMember(t, "org-a", 1).mutation(api.tasks.attachReviewArtifact, {
			taskId: id,
			callerOrchestrator: "alpha",
			artifactRef: "https://example.test/pr/1",
		});
		// deny pole already enforced for a different name
		await expect(
			asMember(t, "org-a", 2).mutation(api.tasks.attachReviewArtifact, {
				taskId: id,
				callerOrchestrator: "eta",
				artifactRef: "https://example.test/pr/EVIL-eta",
			}),
		).rejects.toThrow(/REVIEW_ARTIFACT_ALREADY_ATTACHED/);
		// the audited bypass: same typed name, different person
		const r = await outcomeOf(
			asMember(t, "org-a", 2).mutation(api.tasks.attachReviewArtifact, {
				taskId: id,
				callerOrchestrator: "alpha",
				artifactRef: "https://example.test/pr/EVIL-alpha",
			}),
		);
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(
			{ ok: r.ok, ref: row?.reviewArtifactRef },
			"first attacher's artifact overwritten by another member typing the same name",
		).toEqual({ ok: false, ref: "https://example.test/pr/1" });
	});
});

describe("tasks:blockTask — blockedOnTaskId tenant", () => {
	test("tasks:blockTask — a member of org A cannot cite org B's task as its blocker (RBAC_DENIED, row unchanged)", async () => {
		const t = await world();
		const own = await seedTask(t, { orgId: "org-a", status: "in_progress", assignedTo: "sigma" });
		const foreign = await seedTask(t, { orgId: "org-b", assignedTo: "eta", title: "ORG-B-SECRET-TITLE" });
		const r = await outcomeOf(
			asMember(t, "org-a").mutation(api.tasks.blockTask, {
				taskId: own,
				callerOrchestrator: "sigma",
				blockedOnTaskId: foreign,
			}),
		);
		const row = await t.run((ctx) => ctx.db.get(own));
		expect(
			{ ok: r.ok, status: row?.status, blockedOn: row?.blockedOnTaskId },
			"org A task blocked on org B's task",
		).toEqual({ ok: false, status: "in_progress", blockedOn: undefined });
		expect(r.text).toMatch(/RBAC_DENIED/);
	});

	test("tasks:blockTask — a member of org A can cite its own org's task (positive control)", async () => {
		const t = await world();
		const own = await seedTask(t, { orgId: "org-a", status: "in_progress", assignedTo: "sigma" });
		const peer = await seedTask(t, { orgId: "org-a", assignedTo: "eta" });
		await asMember(t, "org-a").mutation(api.tasks.blockTask, {
			taskId: own,
			callerOrchestrator: "sigma",
			blockedOnTaskId: peer,
		});
		expect((await t.run((ctx) => ctx.db.get(own)))?.blockedOnTaskId).toBe(peer);
	});
});

describe("tasks:start — dependency gate must not disclose a foreign task", () => {
	test("tasks:start — the DEPENDENCY_NOT_DONE refusal for a member of org A never carries org B's title (planted dependsOn)", async () => {
		const t = await world();
		const foreign = await seedTask(t, { orgId: "org-b", assignedTo: "eta", title: "ORG-B-SECRET-TITLE" });
		const own = await seedTask(t, { orgId: "org-a", dependsOn: [foreign] });
		const r = await outcomeOf(
			asMember(t, "org-a").mutation(api.tasks.start, {
				taskId: own,
				callerOrchestrator: "sigma",
			}),
		);
		expect(r.text, "org A start() error disclosed org B's task title").not.toContain(
			"ORG-B-SECRET-TITLE",
		);
	});

	test("tasks:start — the gate does name an in-org dependency (positive control: the path is reachable)", async () => {
		const t = await world();
		const dep = await seedTask(t, { orgId: "org-a", assignedTo: "eta", title: "ORG-A-DEP-TITLE" });
		const own = await seedTask(t, { orgId: "org-a", dependsOn: [dep] });
		const r = await outcomeOf(
			asMember(t, "org-a").mutation(api.tasks.start, {
				taskId: own,
				callerOrchestrator: "sigma",
			}),
		);
		expect(r.text).toContain("ORG-A-DEP-TITLE");
	});
});

describe("tasks:checkout — creator/assignee rule", () => {
	test("tasks:checkout — sigma (roster member, neither creator nor assignee) cannot claim eta's task (member of org-a)", async () => {
		const t = await world();
		const id = await seedTask(t, { orgId: "org-a", assignedTo: "eta", createdBy: "eta" });
		const r = await outcomeOf(
			asMember(t, "org-a").mutation(api.tasks.checkout, {
				taskId: id,
				callerOrchestrator: "sigma",
			}),
		);
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(
			{ ok: r.ok, status: row?.status },
			"sigma claimed and started eta's task",
		).toEqual({ ok: false, status: "todo" });
		expect(r.text).toMatch(/RBAC_DENIED/);
	});

	test("tasks:checkout — the assignee can claim its own task (positive control)", async () => {
		const t = await world();
		const id = await seedTask(t, { orgId: "org-a", assignedTo: "eta", createdBy: "eta" });
		const res = await asMember(t, "org-a").mutation(api.tasks.checkout, {
			taskId: id,
			callerOrchestrator: "eta",
		});
		expect(res.claimed).toBe(true);
	});
});

describe("tasks:bulkComplete — same-named orchestrators of two orgs", () => {
	test("tasks:bulkComplete — a claimless service-account call as 'eta' does not close BOTH orgs' eta tasks (service account, no verifiedOrg)", async () => {
		const t = await world();
		await seedTask(t, { orgId: "org-a", assignedTo: "eta" });
		await seedTask(t, { orgId: "org-b", assignedTo: "eta" });
		const r = await outcomeOf(
			asService(t).mutation(api.tasks.bulkComplete, {
				filter: { assignedTo: "eta" },
				dryRun: false,
				callerOrchestrator: "eta",
			}),
		);
		const rows = await t.run((ctx) => ctx.db.query("tasks").collect());
		const doneOrgs = rows.filter((x) => x.status === "done").map((x) => x.orgId).sort();
		expect(
			{ ok: r.ok, doneOrgs },
			"one claimless call closed eta's tasks in both org-a and org-b",
		).not.toEqual({ ok: true, doneOrgs: ["org-a", "org-b"] });
	});

	test("tasks:bulkComplete — with verifiedOrg org-a only org-a's tasks close (positive control for the narrowing that exists)", async () => {
		const t = await world();
		await seedTask(t, { orgId: "org-a", assignedTo: "eta" });
		await seedTask(t, { orgId: "org-b", assignedTo: "eta" });
		await asService(t).mutation(api.tasks.bulkComplete, {
			filter: { assignedTo: "eta" },
			dryRun: false,
			callerOrchestrator: "eta",
			verifiedOrg: { orgSlug: "org-a" },
		});
		const rows = await t.run((ctx) => ctx.db.query("tasks").collect());
		expect(rows.filter((x) => x.status === "done").map((x) => x.orgId)).toEqual(["org-a"]);
	});
});

const WINDOW_START = 1_000_000;
const WINDOW_END = 9_000_000;
async function seedBillingWorld(t: T, foreign: number) {
	await t.run(async (ctx) => {
		for (let i = 0; i < foreign; i++) {
			await ctx.db.insert("tasks", {
				title: "foreign",
				assignedTo: "omega",
				createdBy: "omega",
				priority: "low",
				status: "done",
				orgId: "org-b",
				project: "pb",
				actualMinutes: 1,
				completedAt: WINDOW_START + 1 + i,
				createdAt: 1,
				updatedAt: 1,
			});
		}
		for (let i = 0; i < 3; i++) {
			await ctx.db.insert("tasks", {
				title: "mine",
				assignedTo: "sigma",
				createdBy: "sigma",
				priority: "low",
				status: "done",
				orgId: "org-a",
				project: "pa",
				actualMinutes: 10,
				completedAt: WINDOW_END - 100 + i,
				createdAt: 1,
				updatedAt: 1,
			});
		}
	});
}

describe("tasks:billingSummaryByProject — tenant predicate inside the read", () => {
	test("tasks:billingSummaryByProject — positive control: a member of org A with no foreign rows gets all 3 of its rows summed", async () => {
		const t = await world();
		await seedBillingWorld(t, 0);
		const res = await asMember(t, "org-a").query(api.tasks.billingSummaryByProject, {
			startDate: WINDOW_START,
			endDate: WINDOW_END,
		});
		expect(res.byProject.find((p) => p.project === "pa")?.totalMinutes).toBe(30);
	});

	test("tasks:billingSummaryByProject — a member of org A is served all 3 of its rows when 5001 older foreign rows fill the scan window", async () => {
		const t = await world();
		await seedBillingWorld(t, 5001);
		const res = await asMember(t, "org-a").query(api.tasks.billingSummaryByProject, {
			startDate: WINDOW_START,
			endDate: WINDOW_END,
		});
		expect(
			{ minutes: res.byProject.find((p) => p.project === "pa")?.totalMinutes, truncated: res.truncated },
			"org A's invoice total is short because the tenant filter runs after the capped fleet-wide read",
		).toEqual({ minutes: 30, truncated: false });
	});
});

describe("tasks:taskDurationDistribution — tenant predicate inside the read", () => {
	test("tasks:taskDurationDistribution — positive control: a member of org A with no foreign rows is counted 3", async () => {
		const t = await world();
		await seedBillingWorld(t, 0);
		const res = await asMember(t, "org-a").query(api.tasks.taskDurationDistribution, {
			from: WINDOW_START,
			to: WINDOW_END,
		});
		expect(res.count).toBe(3);
	});

	test("tasks:taskDurationDistribution — a member of org A is counted 3 when 5001+ older foreign rows fill the scan window", async () => {
		const t = await world();
		await seedBillingWorld(t, 5001);
		const res = await asMember(t, "org-a").query(api.tasks.taskDurationDistribution, {
			from: WINDOW_START,
			to: WINDOW_END,
		});
		expect(
			{ count: res.count, truncated: res.truncated },
			"org A's percentiles computed over a truncated fleet slice",
		).toEqual({ count: 3, truncated: false });
	});
});
