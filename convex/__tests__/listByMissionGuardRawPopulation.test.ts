/// <reference types="vite/client" />
//
// listByMissionGuardRawPopulation.test.ts — the SCAN_CAP_EXCEEDED overflow guard
// of `tasks.listByMission` must count the population the INDEX RETURNED, never
// the population left after the in-memory status filter.
//
// Sibling of tasksListGuardRawPopulation.test.ts (tasks.list). On the master
// multi-status / no-status branch, `by_mission` is taken at cap+1, status is
// filtered in memory and the filtered array was reassigned to `allRows`, which
// the guard then measured: a truncated window with no requested-status row
// filtered to nothing and returned [] with no throw.
//
// Contract: the call returns EVERY matching row or raises SCAN_CAP_EXCEEDED
// naming the cap. Never an empty/short list presented as complete.
//
// Fictitious identifiers only.

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";
import { TASK_LIST_SCAN_CAP } from "../tasks";
import { insertTaskRow, seedFleetAgents } from "../../tests/lib/seedFleetAgents";

const ASSIGNEE = "guard-mission-assignee";
const ORG = "guard-mission-org";
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

type Row = Record<string, unknown>;
const MATCHING = 5;
const NEWER_UNREQUESTED = TASK_LIST_SCAN_CAP + 50;

async function seed(matchingStatuses: string[], unrequested: string, orgId?: string) {
	const t = convexTest(schema, modules);
	await seedFleetAgents(t, [ASSIGNEE]);
	const now = Date.now();
	const missionId = await t.run(async (ctx) =>
		ctx.db.insert("missions", {
			name: "guard-mission",
			description: "d",
			status: "execute",
			priority: "medium",
			pilot: ASSIGNEE,
			project: "guard-mission-proj",
			agents: [],
			createdBy: ASSIGNEE,
			createdAt: 1,
			updatedAt: 1,
		} as never),
	);
	const stampOrg = orgId !== undefined ? { orgId, clerkOrgId: testClerkOrgId(orgId) } : {};
	const insert = async (title: string, status: string, updatedAt: number) =>
		t.run(async (ctx) => {
			await insertTaskRow(ctx, {
				title,
				assignedTo: ASSIGNEE,
				priority: "medium",
				status,
				createdBy: ASSIGNEE,
				createdAt: now,
				updatedAt,
				missionId,
				...stampOrg,
			} as never);
		});
	for (let i = 0; i < MATCHING; i++) {
		await insert(`wanted-${i}`, matchingStatuses[i % matchingStatuses.length], now - 10_000 + i);
	}
	const CHUNK = 500;
	for (let from = 0; from < NEWER_UNREQUESTED; from += CHUNK) {
		await t.run(async (ctx) => {
			for (let i = from; i < Math.min(from + CHUNK, NEWER_UNREQUESTED); i++) {
				await insertTaskRow(ctx, {
					title: `unwanted-${i}`,
					assignedTo: ASSIGNEE,
					priority: "medium",
					status: unrequested,
					createdBy: ASSIGNEE,
					createdAt: now,
					updatedAt: now - 5_000 + i,
					missionId,
					...stampOrg,
				} as never);
			}
		});
	}
	return { t, missionId, since: now - 20_000 };
}

const asMaster = (t: Awaited<ReturnType<typeof seed>>["t"]) =>
	t.withIdentity({ subject: "test-service-account-user-id" });
const asMember = (t: Awaited<ReturnType<typeof seed>>["t"]) =>
	t.withIdentity({
		subject: `${ORG}-member`,
		org_slug: ORG,
		org_id: testClerkOrgId(ORG),
		org_role: "org:editor",
	} as never);

async function seedOrg(t: Awaited<ReturnType<typeof seed>>["t"]) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			scopes: ["view-own-tasks", "view-own-missions", "view-stats-aggregated"],
			isActive: true,
			createdAt: Date.now(),
			allowedOrchestrators: [ASSIGNEE],
			clerkOrgSlug: ORG,
			clerkOrgId: testClerkOrgId(ORG),
			displayName: ORG,
			orgKind: "client",
		} as never);
	});
}

async function expectCompleteOrLoud(
	run: () => Promise<unknown>,
) {
	let items: Row[];
	try {
		items = (await run()) as Row[];
	} catch (e) {
		const msg = String((e as { data?: unknown; message?: string }).data ?? (e as Error).message);
		expect(msg).toMatch(/SCAN_CAP_EXCEEDED/);
		expect(msg).toContain(String(TASK_LIST_SCAN_CAP));
		return;
	}
	const wanted = items.filter((r) => String(r.title).startsWith("wanted-"));
	expect(wanted.length, `short list presented as complete: got ${items.length} rows`).toBe(MATCHING);
}

describe("tasks.listByMission — master branch overflow guard reads the raw index population", () => {
	test("2 statuses: complete or SCAN_CAP_EXCEEDED", async () => {
		const { t, missionId } = await seed(["blocked", "cancelled"], "todo");
		await expectCompleteOrLoud(() =>
			asMaster(t).query(api.tasks.listByMission, {
				missionId,
				status: ["blocked", "cancelled"],
				limit: 50,
				fields: "full",
			}),
		);
	});

	test("2 statuses + updatedSince: complete or SCAN_CAP_EXCEEDED", async () => {
		const { t, missionId, since } = await seed(["blocked", "cancelled"], "todo");
		await expectCompleteOrLoud(() =>
			asMaster(t).query(api.tasks.listByMission, {
				missionId,
				status: ["blocked", "cancelled"],
				updatedSince: since,
				limit: 50,
				fields: "full",
			}),
		);
	});

	// Quiet pole: a single status sits in the index, the same population is exact.
	test("single status pole: returns the matches, no throw", async () => {
		const { t, missionId } = await seed(["blocked"], "todo");
		const rows = (await asMaster(t).query(api.tasks.listByMission, {
			missionId,
			status: "blocked",
			limit: 50,
			fields: "full",
		})) as Row[];
		expect(rows.length).toBe(MATCHING);
	});
});

describe("tasks.listByMission — member (org-keyed) branch", () => {
	// One bucket query per requested status: the newest unrequested window cannot
	// hide a requested row, so the member is served every match without a throw.
	test("2 statuses over a mission larger than the cap: every match, no throw", async () => {
		const { t, missionId } = await seed(["blocked", "cancelled"], "todo", ORG);
		await seedOrg(t);
		const rows = (await asMember(t).query(api.tasks.listByMission, {
			missionId,
			status: ["blocked", "cancelled"],
			limit: 50,
			fields: "full",
		})) as Row[];
		expect(rows.length).toBe(MATCHING);
	});

	test("2 statuses + updatedSince (wide): every match, no throw", async () => {
		const { t, missionId, since } = await seed(["blocked", "cancelled"], "todo", ORG);
		await seedOrg(t);
		const rows = (await asMember(t).query(api.tasks.listByMission, {
			missionId,
			status: ["blocked", "cancelled"],
			updatedSince: since,
			limit: 50,
			fields: "full",
		})) as Row[];
		expect(rows.length).toBe(MATCHING);
	});
});
