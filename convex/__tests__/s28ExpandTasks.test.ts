/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, task k17bcj237901qqfghbzsnj13258k0adb (mcp-server-standard
// S-28 expand: tasks:get, tasks:listByMission, tasks:billingSummaryByProject).
//
// Each door below takes `verifiedOrg` (believed from the fleet service account
// only) and answers the claim as a member of that organisation is answered.
// Doors: tasks:get, tasks:listByMission, tasks:billingSummaryByProject
//
// Poles per door:
//   OWN        the claim names the row's organisation -> served / write applied
//   FOREIGN    the claim names another active organisation -> the member's answer
//   UNCHANGED  the service account with no claim -> as before (expand only)
//   REFUSED    a non-service caller presenting the claim -> RBAC_DENIED
//   INACTIVE   a claim naming an inactive organisation -> RBAC_DENIED

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedRosterAgents } from "../../tests/lib/seedRosterAgents";
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

// Writes schedule RAG-sync functions; fake timers keep the scheduler under the
// test's control (same pattern as s28DoorDecisions.test.ts).
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];
type Client = ReturnType<T["withIdentity"]>;

const OP = "s28x-op";
const A = "s28x-a";
const B = "s28x-b";
const D = "s28x-dead";
const OP_ID = testClerkOrgId(OP);
const A_ID = testClerkOrgId(A);
const B_ID = testClerkOrgId(B);
const D_ID = testClerkOrgId(D);
const claimA = { orgSlug: A, orgId: A_ID };
const claimB = { orgSlug: B, orgId: B_ID };
const claimDead = { orgSlug: D, orgId: D_ID };
const NOW = 1_780_000_000_000;

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const memberOf = (t: T, slug: string) =>
	t.withIdentity({
		subject: `member-of-${slug}`,
		org_slug: slug,
		org_id: testClerkOrgId(slug),
		org_role: "org:admin",
	} as Identity);

const q = <R>(c: Client, ref: unknown, args: Record<string, unknown>) =>
	c.query(ref as never, args as never) as Promise<R>;

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		return `${(e as Error).message} ${typeof data === "string" ? data : JSON.stringify(data ?? "")}`;
	}
	return "NO-REFUSAL";
}

// One operator organisation, two client organisations and one inactive one, each
// active org with its roster agent (by ID).
async function seedOrgs(t: T): Promise<Record<string, Id<"agents">>> {
	await t.run(async (ctx) => {
		const org = (
			slug: string,
			id: string,
			roster: string,
			isActive: boolean,
			orgKind: "operator" | "client",
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: id,
				allowedOrchestrators: [roster],
				scopes: [
					"view-own-tasks",
					"view-own-missions",
					"view-stats-aggregated",
				],
				displayName: slug,
				isActive,
				orgKind,
				createdAt: 1,
			});
		await org(OP, OP_ID, "opa", true, "operator");
		await org(A, A_ID, "alice", true, "client");
		await org(B, B_ID, "bob", true, "client");
		await org(D, D_ID, "dan", false, "client");
	});
	return await seedRosterAgents(t);
}

async function world() {
	const t = createT();
	const agents = await seedOrgs(t);
	const rows = await t.run(async (ctx) => {
		const out: Record<string, { mission: Id<"missions">; task: Id<"tasks"> }> =
			{};
		for (const [slug, id, name] of [
			[A, A_ID, "alice"],
			[B, B_ID, "bob"],
		] as const) {
			const agentId = agents[`${slug}/${name}`];
			const stamp = { orgId: slug, clerkOrgId: id };
			const mission = await ctx.db.insert("missions", {
				name: `${slug} mission`,
				project: `${slug}-project`,
				status: "execute",
				priority: "medium",
				agents: [name],
				pilot: name,
				pilotId: agentId,
				agentIds: [agentId],
				createdBy: name,
				createdAt: NOW,
				updatedAt: NOW,
				...stamp,
			} as never);
			const task = await ctx.db.insert("tasks", {
				title: `${slug} task`,
				assignedTo: name,
				assignedToId: agentId,
				priority: "medium",
				status: "done",
				completedAt: 1000,
				actualMinutes: 30,
				durationSource: "segments",
				project: `${slug}-project`,
				missionId: mission,
				createdBy: name,
				createdAt: NOW,
				updatedAt: NOW,
				...stamp,
			} as never);
			out[slug] = { mission, task };
		}
		return out;
	});
	return { t, rows };
}

type TaskRow = { title: string } | null;

describe("tasks:get applies the verified org inside the read", () => {
	test("OWN: verifiedOrg A serves A's task", async () => {
		const { t, rows } = await world();
		const r = await q<TaskRow>(asService(t), api.tasks.get, {
			taskId: rows[A].task,
			verifiedOrg: claimA,
		});
		expect(r?.title).toBe(`${A} task`);
	});
	test("FOREIGN: verifiedOrg A reading B's task is the member's null", async () => {
		const { t, rows } = await world();
		const r = await q<TaskRow>(asService(t), api.tasks.get, {
			taskId: rows[B].task,
			verifiedOrg: claimA,
		});
		expect(r).toBeNull();
	});
	test("UNCHANGED: the service account with no claim reads B's task", async () => {
		const { t, rows } = await world();
		const r = await q<TaskRow>(asService(t), api.tasks.get, {
			taskId: rows[B].task,
		});
		expect(r?.title).toBe(`${B} task`);
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const { t, rows } = await world();
		const out = await codeOf(
			q(memberOf(t, A), api.tasks.get, {
				taskId: rows[A].task,
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const { t, rows } = await world();
		const out = await codeOf(
			q(asService(t), api.tasks.get, {
				taskId: rows[A].task,
				verifiedOrg: claimDead,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
	});
});

describe("tasks:listByMission applies the verified org inside the read", () => {
	test("OWN: verifiedOrg A lists only A's mission tasks", async () => {
		const { t, rows } = await world();
		const r = await q<{ title: string }[]>(
			asService(t),
			api.tasks.listByMission,
			{ missionId: rows[A].mission, verifiedOrg: claimA },
		);
		expect(r.map((x) => x.title)).toEqual([`${A} task`]);
	});
	test("FOREIGN: verifiedOrg A listing B's mission is the member's empty list", async () => {
		const { t, rows } = await world();
		const r = await q<{ title: string }[]>(
			asService(t),
			api.tasks.listByMission,
			{ missionId: rows[B].mission, verifiedOrg: claimA },
		);
		expect(r).toEqual([]);
	});
	test("UNCHANGED: the service account with no claim lists B's mission", async () => {
		const { t, rows } = await world();
		const r = await q<{ title: string }[]>(
			asService(t),
			api.tasks.listByMission,
			{ missionId: rows[B].mission },
		);
		expect(r.map((x) => x.title)).toEqual([`${B} task`]);
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const { t, rows } = await world();
		const out = await codeOf(
			q(memberOf(t, A), api.tasks.listByMission, {
				missionId: rows[A].mission,
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const { t, rows } = await world();
		const out = await codeOf(
			q(asService(t), api.tasks.listByMission, {
				missionId: rows[A].mission,
				verifiedOrg: claimDead,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
	});
});

describe("tasks:billingSummaryByProject applies the verified org inside the read", () => {
	const range = { startDate: 0, endDate: 10_000 };
	type Summary = { byProject: { project: string }[] };
	test("OWN: verifiedOrg A sums only A's project", async () => {
		const { t } = await world();
		const r = await q<Summary>(
			asService(t),
			api.tasks.billingSummaryByProject,
			{ ...range, verifiedOrg: claimA },
		);
		expect(r.byProject.map((p) => p.project)).toEqual([`${A}-project`]);
	});
	test("FOREIGN: verifiedOrg B never sums A's project", async () => {
		const { t } = await world();
		const r = await q<Summary>(
			asService(t),
			api.tasks.billingSummaryByProject,
			{ ...range, verifiedOrg: claimB },
		);
		expect(r.byProject.map((p) => p.project)).toEqual([`${B}-project`]);
	});
	test("UNCHANGED: the service account with no claim sums both projects", async () => {
		const { t } = await world();
		const r = await q<Summary>(
			asService(t),
			api.tasks.billingSummaryByProject,
			range,
		);
		expect(r.byProject.map((p) => p.project).sort()).toEqual([
			`${A}-project`,
			`${B}-project`,
		]);
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const { t } = await world();
		const out = await codeOf(
			q(memberOf(t, A), api.tasks.billingSummaryByProject, {
				...range,
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const { t } = await world();
		const out = await codeOf(
			q(asService(t), api.tasks.billingSummaryByProject, {
				...range,
				verifiedOrg: claimDead,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
	});
});
