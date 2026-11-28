/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, task k17bcj237901qqfghbzsnj13258k0adb (mcp-server-standard
// S-28 expand: recurringTasks:list, pause, resume, remove, update).
//
// Each door below takes `verifiedOrg` (believed from the fleet service account
// only) and answers the claim as a member of that organisation is answered.
// Doors: recurringTasks:list, recurringTasks:pause, recurringTasks:resume, recurringTasks:remove, recurringTasks:update
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
const m = <R>(c: Client, ref: unknown, args: Record<string, unknown>) =>
	c.mutation(ref as never, args as never) as Promise<R>;

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
	const ids = await t.run(async (ctx) => {
		const out: Record<string, Id<"recurringTasks">> = {};
		for (const [slug, id, name] of [
			[A, A_ID, "alice"],
			[B, B_ID, "bob"],
		] as const) {
			const agentId = agents[`${slug}/${name}`];
			out[slug] = await ctx.db.insert("recurringTasks", {
				title: `${slug} recurring`,
				assignedTo: name,
				assignedToId: agentId,
				priority: "medium",
				cronExpression: "0 9 * * *",
				nextRunAt: NOW + 1000,
				active: true,
				createdBy: name,
				createdById: agentId,
				createdAt: NOW,
				updatedAt: NOW,
				orgId: slug,
				clerkOrgId: id,
			} as never);
		}
		return out;
	});
	return { t, ids };
}

const rowOf = (t: T, id: Id<"recurringTasks">) =>
	t.run(async (ctx) => await ctx.db.get(id));

describe("recurringTasks:list applies the verified org inside the read", () => {
	type Row = { title: string };
	test("OWN: verifiedOrg A lists only A's schedules", async () => {
		const { t } = await world();
		const r = await q<Row[]>(asService(t), api.recurringTasks.list, {
			verifiedOrg: claimA,
		});
		expect(r.map((x) => x.title)).toEqual([`${A} recurring`]);
	});
	test("FOREIGN: verifiedOrg B never lists A's schedule", async () => {
		const { t } = await world();
		const r = await q<Row[]>(asService(t), api.recurringTasks.list, {
			verifiedOrg: claimB,
		});
		expect(r.map((x) => x.title)).toEqual([`${B} recurring`]);
	});
	test("UNCHANGED: the service account with no claim lists both", async () => {
		const { t } = await world();
		const r = await q<Row[]>(asService(t), api.recurringTasks.list, {});
		expect(r.map((x) => x.title).sort()).toEqual([
			`${A} recurring`,
			`${B} recurring`,
		]);
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const { t } = await world();
		const out = await codeOf(
			q(memberOf(t, A), api.recurringTasks.list, { verifiedOrg: claimA }),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const { t } = await world();
		const out = await codeOf(
			q(asService(t), api.recurringTasks.list, { verifiedOrg: claimDead }),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
	});
});

type Write = {
	door: string;
	ref: unknown;
	args: (id: Id<"recurringTasks">) => Record<string, unknown>;
	applied: (row: Awaited<ReturnType<typeof rowOf>>) => boolean;
	untouched: (row: Awaited<ReturnType<typeof rowOf>>) => boolean;
};

const WRITES: Write[] = [
	{
		door: "pause",
		ref: api.recurringTasks.pause,
		args: (id) => ({ taskId: id }),
		applied: (r) => r?.active === false,
		untouched: (r) => r?.active === true,
	},
	{
		door: "resume",
		ref: api.recurringTasks.resume,
		args: (id) => ({ taskId: id }),
		// resume re-derives nextRunAt from the cron expression: the row moved off NOW + 1000
		applied: (r) => r?.active === true && r?.nextRunAt !== NOW + 1000,
		untouched: (r) => r?.nextRunAt === NOW + 1000,
	},
	{
		door: "update",
		ref: api.recurringTasks.update,
		args: (id) => ({ recurringTaskId: id, title: "renamed" }),
		applied: (r) => r?.title === "renamed",
		untouched: (r) => r?.title !== "renamed",
	},
	{
		door: "remove",
		ref: api.recurringTasks.remove,
		args: (id) => ({ taskId: id }),
		applied: (r) => r === null,
		untouched: (r) => r !== null,
	},
];

for (const w of WRITES) {
	describe(`recurringTasks:${w.door} applies the verified org inside the write`, () => {
		test("OWN: verifiedOrg A acts on A's schedule", async () => {
			const { t, ids } = await world();
			await m(asService(t), w.ref, { ...w.args(ids[A]), verifiedOrg: claimA });
			expect(w.applied(await rowOf(t, ids[A]))).toBe(true);
		});
		test("FOREIGN: verifiedOrg A cannot act on B's schedule (RBAC_DENIED, row unchanged)", async () => {
			const { t, ids } = await world();
			const out = await codeOf(
				m(asService(t), w.ref, { ...w.args(ids[B]), verifiedOrg: claimA }),
			);
			expect(out).toContain("RBAC_DENIED");
			expect(out).toContain("row-outside-verified-org");
			expect(w.untouched(await rowOf(t, ids[B]))).toBe(true);
		});
		test("UNCHANGED: the service account with no claim acts on B's schedule", async () => {
			const { t, ids } = await world();
			await m(asService(t), w.ref, w.args(ids[B]));
			expect(w.applied(await rowOf(t, ids[B]))).toBe(true);
		});
		test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
			const { t, ids } = await world();
			const out = await codeOf(
				m(memberOf(t, A), w.ref, { ...w.args(ids[A]), verifiedOrg: claimA }),
			);
			expect(out).toContain("RBAC_DENIED");
			expect(out).toContain("verified-org-not-trusted");
			expect(w.untouched(await rowOf(t, ids[A]))).toBe(true);
		});
		test("INACTIVE: a claim naming an inactive org is refused", async () => {
			const { t, ids } = await world();
			const out = await codeOf(
				m(asService(t), w.ref, { ...w.args(ids[A]), verifiedOrg: claimDead }),
			);
			expect(out).toContain("RBAC_DENIED");
			expect(out).toContain("org-not-active");
			expect(w.untouched(await rowOf(t, ids[A]))).toBe(true);
		});
	});
}
