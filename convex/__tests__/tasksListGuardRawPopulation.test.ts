/// <reference types="vite/client" />
//
// tasksListGuardRawPopulation.test.ts — the SCAN_CAP_EXCEEDED overflow guard of
// `tasks.list` must count the population the INDEX RETURNED, never the
// population left after the in-memory status filter.
//
// Defect class (reported against 6abd599): a branch takes cap+1 rows, filters
// status in memory, reassigns the filtered result, and the guard
// (`> TASK_LIST_SCAN_CAP`) then reads the FILTERED length. A truncated scan whose
// window holds no row of the requested statuses returned an EMPTY list with no
// throw while matching rows existed beyond the window.
//
// Contract pinned on every path: the call either returns EVERY matching row or
// raises SCAN_CAP_EXCEEDED naming the cap. Never an empty/short list.
//
// Fictitious identifiers only.

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { TASK_LIST_SCAN_CAP } from "../tasks";
import { insertTaskRow, seedFleetAgents } from "../../tests/lib/seedFleetAgents";

const ASSIGNEE = "guard-raw-pop-assignee";
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

function extractItems(result: unknown): Row[] {
	if (Array.isArray(result)) return result as Row[];
	if (result !== null && typeof result === "object") {
		const r = result as Record<string, unknown>;
		if (Array.isArray(r.items)) return r.items as Row[];
	}
	return [];
}

// Older rows carry the requested statuses; the NEWEST cap+50 rows (by creation
// time AND by updatedAt) carry a status that is not requested.
async function seed(
	extra: Record<string, unknown>,
	matchingStatuses: string[],
	unrequested: string,
) {
	const t = convexTest(schema, modules);
	await seedFleetAgents(t, [ASSIGNEE]);
	const now = Date.now();
	await t.run(async (ctx) => {
		for (let i = 0; i < MATCHING; i++) {
			await insertTaskRow(ctx, {
				title: `wanted-${i}`,
				assignedTo: ASSIGNEE,
				priority: "medium",
				status: matchingStatuses[i % matchingStatuses.length],
				createdBy: ASSIGNEE,
				createdAt: now,
				updatedAt: now - 10_000 + i,
				...extra,
			} as never);
		}
		for (let i = 0; i < NEWER_UNREQUESTED; i++) {
			await insertTaskRow(ctx, {
				title: `unwanted-${i}`,
				assignedTo: ASSIGNEE,
				priority: "medium",
				status: unrequested,
				createdBy: ASSIGNEE,
				createdAt: now,
				updatedAt: now - 5_000 + i,
				...extra,
			} as never);
		}
	});
	return { t, since: now - 20_000 };
}

// Either every wanted row comes back, or the call raises SCAN_CAP_EXCEEDED naming the cap.
async function expectCompleteOrLoud(
	t: Awaited<ReturnType<typeof seed>>["t"],
	args: Record<string, unknown>,
) {
	let items: Row[] | undefined;
	try {
		items = extractItems(
			await t
				.withIdentity({ subject: "test-service-account-user-id" })
				.query(api.tasks.list, { limit: 50, fields: "full", ...args } as never),
		);
	} catch (e) {
		const msg = String((e as { data?: unknown; message?: string }).data ?? (e as Error).message);
		expect(msg).toMatch(/SCAN_CAP_EXCEEDED/);
		expect(msg).toContain(String(TASK_LIST_SCAN_CAP));
		return;
	}
	const wanted = items.filter((r) => String(r.title).startsWith("wanted-"));
	expect(wanted.length, `short list presented as complete: got ${items.length} rows`).toBe(MATCHING);
}

describe("tasks.list — overflow guard reads the raw index population", () => {
	test("assignedTo + 2 statuses + updatedSince: complete or SCAN_CAP_EXCEEDED", async () => {
		const { t, since } = await seed({}, ["blocked", "cancelled"], "todo");
		await expectCompleteOrLoud(t, {
			assignedTo: ASSIGNEE,
			status: ["blocked", "cancelled"],
			updatedSince: since,
		});
	});

	test("assignedTo + no status + updatedSince: complete or SCAN_CAP_EXCEEDED", async () => {
		const { t, since } = await seed({}, ["blocked", "cancelled"], "todo");
		await expectCompleteOrLoud(t, { assignedTo: ASSIGNEE, updatedSince: since });
	});

	test("project + 2 statuses (no assignee): complete or SCAN_CAP_EXCEEDED", async () => {
		const { t } = await seed({ project: "guard-raw-pop-proj" }, ["blocked", "cancelled"], "todo");
		await expectCompleteOrLoud(t, {
			project: "guard-raw-pop-proj",
			status: ["blocked", "cancelled"],
		});
	});

	test("assignedToInstance + 2 statuses: complete or SCAN_CAP_EXCEEDED", async () => {
		const { t } = await seed(
			{ assignedToInstance: "guard-raw-pop-inst" },
			["blocked", "cancelled"],
			"todo",
		);
		await expectCompleteOrLoud(t, {
			assignedToInstance: "guard-raw-pop-inst",
			status: ["blocked", "cancelled"],
		});
	});

	test("instance + project + 2 statuses: complete or SCAN_CAP_EXCEEDED", async () => {
		const { t } = await seed(
			{ assignedToInstance: "guard-raw-pop-inst", project: "guard-raw-pop-proj" },
			["blocked", "cancelled"],
			"todo",
		);
		await expectCompleteOrLoud(t, {
			assignedToInstance: "guard-raw-pop-inst",
			project: "guard-raw-pop-proj",
			status: ["blocked", "cancelled"],
		});
	});

	test("2 statuses alone (whole table): complete or SCAN_CAP_EXCEEDED", async () => {
		const { t } = await seed({}, ["blocked", "cancelled"], "todo");
		await expectCompleteOrLoud(t, { status: ["blocked", "cancelled"] });
	});

	// ── Quiet poles: a single status sits in the index, so the same shape of
	// population is exact and must NOT throw.
	test("single status pole, assignedTo + updatedSince: returns the matches, no throw", async () => {
		const { t, since } = await seed({}, ["blocked"], "todo");
		const items = extractItems(
			await t
				.withIdentity({ subject: "test-service-account-user-id" })
				.query(api.tasks.list, {
					assignedTo: ASSIGNEE,
					status: "blocked",
					updatedSince: since,
					limit: 50,
					fields: "full",
				}),
		);
		expect(items.length).toBe(MATCHING);
	});

	test("single status pole, project: returns the matches, no throw", async () => {
		const { t } = await seed({ project: "guard-raw-pop-proj" }, ["blocked"], "todo");
		const items = extractItems(
			await t
				.withIdentity({ subject: "test-service-account-user-id" })
				.query(api.tasks.list, {
					project: "guard-raw-pop-proj",
					status: "blocked",
					limit: 50,
					fields: "full",
				}),
		);
		expect(items.length).toBe(MATCHING);
	});
});
