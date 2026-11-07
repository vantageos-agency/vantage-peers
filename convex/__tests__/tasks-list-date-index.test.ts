/// <reference types="vite/client" />
/**
 * tasks.list SERVES updatedSince / createdBy / createdBefore FROM AN INDEX RANGE.
 *
 * Measured on prod 2026-11-07:
 *   list_tasks {status:[done], updatedSince, limit:200}
 *     -> SCAN_CAP_EXCEEDED (2000 newest done rows read, THEN the date filter ran)
 * and `assignedTo` + `status` failed for the large assignees (pi, eta, sigma).
 *
 * The cap bounded the population of the status bucket, not the answer. These
 * poles seed a bucket LARGER than TASK_LIST_SCAN_CAP in one org and walk the
 * cursor to the end: every matching row exactly once (count equal to the seeded
 * matching count, no duplicate, no gap), never another org's row.
 *
 * Callers: org members (scoped, NOT master) and the fleet master (service
 * account). Refusal poles pin the paths that cannot be served by a range.
 */

import { convexTest } from "convex-test";
import { beforeAll, describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedServiceAccount } from "../../tests/fixtures/seedServiceAccount";
import { seedAgents } from "../../tests/lib/agentIdOf";
import { insertTaskRow } from "../../tests/lib/seedFleetAgents";
import { api } from "../_generated/api";
import schema from "../schema";
import { TASK_LIST_SCAN_CAP } from "../tasks";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const FLEET = "fleet-org";
const OTHER = "other-org";

// The seeded population of org FLEET. DONE_OLD alone exceeds the scan cap.
const DONE_OLD = TASK_LIST_SCAN_CAP + 400; // done, updated long ago, createdBy sigma, assigned sigma
const DONE_RECENT_SIGMA = 70; // done, updated recently, createdBy sigma, assigned sigma
const DONE_RECENT_ETA = 30; // done, updated recently, createdBy eta, assigned eta
const TODO_RECENT_ETA = 10; // todo, updated recently, createdBy eta, assigned eta
const FOREIGN_DONE_RECENT = 120; // org OTHER, done, updated recently

const LONG_AGO = 1_000_000;
const RECENT = 1_800_000_000_000;
const SINCE = RECENT - 1_000;

const FLEET_DONE_RECENT = DONE_RECENT_SIGMA + DONE_RECENT_ETA;
const FLEET_DONE_ALL = DONE_OLD + FLEET_DONE_RECENT;

type Row = {
	_id: string;
	_creationTime: number;
	title: string;
	status: string;
	updatedAt?: number;
	orgId?: string;
	createdBy?: string;
};

async function seedOrgs(t: T) {
	await t.run(async (ctx) => {
		const base = {
			scopes: ["view-own-tasks"],
			isActive: true,
			createdAt: Date.now(),
		};
		await ctx.db.insert("client_org_mapping", {
			...base,
			clerkOrgSlug: FLEET,
			clerkOrgId: testClerkOrgId(FLEET),
			displayName: FLEET,
			orgKind: "operator",
			allowedOrchestrators: ["sigma", "eta"],
		});
		await ctx.db.insert("client_org_mapping", {
			...base,
			clerkOrgSlug: OTHER,
			clerkOrgId: testClerkOrgId(OTHER),
			displayName: OTHER,
			orgKind: "client",
			allowedOrchestrators: ["sigma"],
		});
	});
	await seedAgents(t, [
		[FLEET, "sigma"],
		[FLEET, "eta"],
		[OTHER, "sigma"],
	]);
	// The fleet master is the service account linked to the operator org (FLEET).
	await seedServiceAccount(t, "test-service-account-user-id");
}

type Seed = {
	tag: string;
	count: number;
	org: string;
	status: "done" | "todo";
	updatedAt: number;
	by: "sigma" | "eta";
	project?: string;
};

async function seed(t: T, s: Seed) {
	const CHUNK = 500;
	for (let from = 0; from < s.count; from += CHUNK) {
		await t.run(async (ctx) => {
			for (let i = from; i < Math.min(from + CHUNK, s.count); i++) {
				await insertTaskRow(ctx, {
					title: `${s.tag}-${i}`,
					assignedTo: s.by,
					priority: "medium",
					status: s.status,
					createdBy: s.by,
					createdAt: Date.now(),
					updatedAt: s.updatedAt,
					orgId: s.org,
					clerkOrgId: testClerkOrgId(s.org),
					...(s.project !== undefined ? { project: s.project } : {}),
				} as never);
			}
		});
	}
}

const asMember = (t: T, org: string) =>
	t.withIdentity({
		subject: `${org}-member`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:editor",
	} as Identity);

const asMaster = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

type Caller = ReturnType<typeof asMember>;
type ListArgs = Record<string, unknown>;

/** Walk the cursor the MCP layer uses (createdBefore = last _creationTime) to the end. */
async function walk(caller: Caller, args: ListArgs, limit: number): Promise<Row[]> {
	const out: Row[] = [];
	let cursor: number | undefined;
	for (let page = 0; page < 200; page++) {
		const rows = (await caller.query(api.tasks.list, {
			...args,
			limit,
			fields: "full",
			...(cursor !== undefined ? { createdBefore: cursor } : {}),
		} as never)) as Row[];
		out.push(...rows);
		if (rows.length < limit) return out;
		cursor = rows[rows.length - 1]._creationTime;
	}
	throw new Error("cursor walk did not terminate in 200 pages");
}

/**
 * Walk the cursor the MCP layer emits for an updatedSince read: the LAST ROW's
 * position, both halves of it (createdBefore = its _creationTime, updatedCursor =
 * its updatedAt). This is the exact pair list_tasks encodes into its opaque token.
 */
async function walkPos(caller: Caller, args: ListArgs, limit: number): Promise<Row[]> {
	const out: Row[] = [];
	let pos: { createdBefore: number; updatedCursor: number } | undefined;
	for (let page = 0; page < 400; page++) {
		const rows = (await caller.query(api.tasks.list, {
			...args,
			limit,
			fields: "full",
			...(pos ?? {}),
		} as never)) as Row[];
		out.push(...rows);
		if (rows.length < limit) return out;
		const last = rows[rows.length - 1];
		pos = { createdBefore: last._creationTime, updatedCursor: last.updatedAt as number };
	}
	throw new Error("position walk did not terminate in 400 pages");
}

/** updatedAt desc, then _creationTime desc: the order of the (status, updatedAt) index read backwards. */
function expectUpdatedOrder(rows: Row[]) {
	for (let i = 1; i < rows.length; i++) {
		const a = rows[i - 1];
		const b = rows[i];
		const au = a.updatedAt as number;
		const bu = b.updatedAt as number;
		expect(bu < au || (bu === au && b._creationTime < a._creationTime)).toBe(true);
	}
}

function expectExactly(
	rows: Row[],
	expected: number,
	orgs: string[],
	order: "created" | "updated" = "created",
) {
	expect(rows).toHaveLength(expected);
	expect(new Set(rows.map((r) => r._id)).size).toBe(rows.length);
	for (const r of rows) expect(orgs).toContain(r.orgId);
	if (order === "updated") {
		expectUpdatedOrder(rows);
		return;
	}
	// newest-created first across pages
	for (let i = 1; i < rows.length; i++) {
		expect(rows[i]._creationTime).toBeLessThan(rows[i - 1]._creationTime);
	}
}

let t: T;

beforeAll(async () => {
	t = createT();
	await seedOrgs(t);
	await seed(t, { tag: "old", count: DONE_OLD, org: FLEET, status: "done", updatedAt: LONG_AGO, by: "sigma", project: "big" });
	await seed(t, { tag: "rs", count: DONE_RECENT_SIGMA, org: FLEET, status: "done", updatedAt: RECENT, by: "sigma" });
	await seed(t, { tag: "re", count: DONE_RECENT_ETA, org: FLEET, status: "done", updatedAt: RECENT, by: "eta" });
	await seed(t, { tag: "te", count: TODO_RECENT_ETA, org: FLEET, status: "todo", updatedAt: RECENT, by: "eta" });
	await seed(t, { tag: "foreign", count: FOREIGN_DONE_RECENT, org: OTHER, status: "done", updatedAt: RECENT, by: "sigma" });
}, 300_000);

describe("tasks.list — a member is served date filters from an index range (org larger than the scan cap)", () => {
	test("status done + updatedSince: every matching row across pages, no scan-cap refusal", { timeout: 120_000 }, async () => {
		const rows = await walkPos(asMember(t, FLEET), { status: "done", updatedSince: SINCE }, 40);
		expectExactly(rows, FLEET_DONE_RECENT, [FLEET], "updated");
	});

	test("status [done] (array form) + updatedSince, the prod call shape", { timeout: 120_000 }, async () => {
		const rows = await walkPos(asMember(t, FLEET), { status: ["done"], updatedSince: SINCE }, 200);
		expectExactly(rows, FLEET_DONE_RECENT, [FLEET], "updated");
	});

	test("no status + updatedSince: every status bucket's window, merged by updatedAt", { timeout: 120_000 }, async () => {
		const rows = await walkPos(asMember(t, FLEET), { updatedSince: SINCE }, 25);
		expectExactly(rows, FLEET_DONE_RECENT + TODO_RECENT_ETA, [FLEET], "updated");
	});

	test("status done + createdBy: every row the creator made, across pages", { timeout: 120_000 }, async () => {
		const rows = await walk(asMember(t, FLEET), { status: "done", createdBy: "eta" }, 8);
		expectExactly(rows, DONE_RECENT_ETA, [FLEET]);
	});

	test("createdBy alone (no status): every status bucket of that creator", { timeout: 120_000 }, async () => {
		const rows = await walk(asMember(t, FLEET), { createdBy: "eta" }, 9);
		expectExactly(rows, DONE_RECENT_ETA + TODO_RECENT_ETA, [FLEET]);
	});

	test("createdBy + updatedSince + status", { timeout: 120_000 }, async () => {
		const rows = await walkPos(asMember(t, FLEET), { status: "done", createdBy: "sigma", updatedSince: SINCE }, 20);
		expectExactly(rows, DONE_RECENT_SIGMA, [FLEET], "updated");
	});

	test("createdBefore walk of the whole done bucket (> cap rows): every row once", { timeout: 200_000 }, async () => {
		const rows = await walk(asMember(t, FLEET), { status: "done" }, 200);
		expectExactly(rows, FLEET_DONE_ALL, [FLEET]);
	});

	test("assignedTo + status (bucket > cap): every assigned row across pages", { timeout: 200_000 }, async () => {
		const rows = await walk(asMember(t, FLEET), { assignedTo: "sigma", status: "done" }, 200);
		expectExactly(rows, DONE_OLD + DONE_RECENT_SIGMA, [FLEET]);
	});

	test("assignedTo + status + updatedSince", { timeout: 120_000 }, async () => {
		const rows = await walkPos(asMember(t, FLEET), { assignedTo: "sigma", status: "done", updatedSince: SINCE }, 30);
		expectExactly(rows, DONE_RECENT_SIGMA, [FLEET], "updated");
	});

	test("the other org's member sees only its own rows for the same filter", { timeout: 120_000 }, async () => {
		const rows = await walkPos(asMember(t, OTHER), { status: "done", updatedSince: SINCE }, 50);
		expectExactly(rows, FOREIGN_DONE_RECENT, [OTHER], "updated");
	});
});

describe("tasks.list — the fleet master is served date filters from an index range", () => {
	test("status done + updatedSince: every org's matching rows", { timeout: 120_000 }, async () => {
		const rows = await walkPos(asMaster(t), { status: "done", updatedSince: SINCE }, 60);
		expectExactly(rows, FLEET_DONE_RECENT + FOREIGN_DONE_RECENT, [FLEET, OTHER], "updated");
	});

	test("status done + createdBy", { timeout: 120_000 }, async () => {
		const rows = await walk(asMaster(t), { status: "done", createdBy: "eta" }, 7);
		expectExactly(rows, DONE_RECENT_ETA, [FLEET, OTHER]);
	});

	test("status done createdBefore walk (> cap rows)", { timeout: 300_000 }, async () => {
		const rows = await walk(asMaster(t), { status: "done" }, 250);
		expectExactly(rows, FLEET_DONE_ALL + FOREIGN_DONE_RECENT, [FLEET, OTHER]);
	});
});

describe("tasks.list — what a range cannot serve still refuses loudly", () => {
	test("assignedTo + createdBy over a bucket larger than the cap -> SCAN_CAP_EXCEEDED, never a partial page", async () => {
		await expect(
			asMember(t, FLEET).query(api.tasks.list, {
				assignedTo: "sigma",
				status: "done",
				createdBy: "eta",
				limit: 10,
			} as never),
		).rejects.toThrow(/SCAN_CAP_EXCEEDED/);
	});

	test("assignedTo + project over a bucket larger than the cap with createdBy -> SCAN_CAP_EXCEEDED naming what to drop", async () => {
		await expect(
			asMember(t, FLEET).query(api.tasks.list, {
				assignedTo: "sigma",
				project: "big",
				status: "done",
				createdBy: "sigma",
				limit: 10,
			} as never),
		).rejects.toThrow(/SCAN_CAP_EXCEEDED.*Drop/s);
	});
});

describe("tasks.list — an updatedSince window above the scan cap is served COMPLETE across pages", () => {
	const WINDOW_DONE = DONE_OLD + FLEET_DONE_RECENT; // updatedSince 0: every done row of the org
	const WINDOW_ALL = WINDOW_DONE + TODO_RECENT_ETA;

	test("member, status done, window of 2500 rows (> cap), 2400 of them tied on updatedAt: complete, no duplicate, no gap", { timeout: 300_000 }, async () => {
		expect(WINDOW_DONE).toBeGreaterThan(TASK_LIST_SCAN_CAP);
		const rows = await walkPos(asMember(t, FLEET), { status: "done", updatedSince: 0 }, 200);
		expectExactly(rows, WINDOW_DONE, [FLEET], "updated");
	});

	test("member, every status (multi-status merge), small pages", { timeout: 300_000 }, async () => {
		const rows = await walkPos(asMember(t, FLEET), { updatedSince: 0 }, 137);
		expectExactly(rows, WINDOW_ALL, [FLEET], "updated");
	});

	test("the master's oversized window, same", { timeout: 300_000 }, async () => {
		const rows = await walkPos(asMaster(t), { status: "done", updatedSince: 0 }, 250);
		expectExactly(rows, WINDOW_DONE + FOREIGN_DONE_RECENT, [FLEET, OTHER], "updated");
	});

	test("assignedTo + status over the oversized window", { timeout: 300_000 }, async () => {
		const rows = await walkPos(asMember(t, FLEET), { assignedTo: "sigma", status: "done", updatedSince: 0 }, 200);
		expectExactly(rows, DONE_OLD + DONE_RECENT_SIGMA, [FLEET], "updated");
	});

	test("the other org never appears in a member's oversized window", { timeout: 300_000 }, async () => {
		const rows = await walkPos(asMember(t, OTHER), { updatedSince: 0 }, 100);
		expectExactly(rows, FOREIGN_DONE_RECENT, [OTHER], "updated");
	});

	test("an OLD cursor (createdBefore only) over an oversized window is refused naming the fix, never a partial page", async () => {
		await expect(
			asMember(t, FLEET).query(api.tasks.list, {
				status: "done",
				updatedSince: 0,
				createdBefore: RECENT,
				limit: 10,
			} as never),
		).rejects.toThrow(/SCAN_CAP_EXCEEDED.*without the cursor/s);
	});

	test("an OLD cursor (createdBefore only) over a window within the cap keeps its creation-time order", { timeout: 120_000 }, async () => {
		const rows = await walk(asMember(t, FLEET), { status: "done", updatedSince: SINCE }, 40);
		expectExactly(rows, FLEET_DONE_RECENT, [FLEET]);
	});

	test("createdBy + oversized window: every page that can be proven is served (the creator's rows sit at the top); the page that cannot is refused, never returned short", { timeout: 300_000 }, async () => {
		const caller = asMember(t, FLEET);
		const got: Row[] = [];
		let pos: { createdBefore: number; updatedCursor: number } | undefined;
		let refusal: unknown;
		for (let page = 0; page < 20 && refusal === undefined; page++) {
			try {
				const rows = (await caller.query(api.tasks.list, {
					status: "done",
					createdBy: "eta",
					updatedSince: 0,
					limit: 7,
					fields: "full",
					...(pos ?? {}),
				} as never)) as Row[];
				got.push(...rows);
				const last = rows[rows.length - 1];
				pos = { createdBefore: last._creationTime, updatedCursor: last.updatedAt as number };
			} catch (e) {
				refusal = e;
			}
		}
		// 4 full pages of 7 are provable; the 30 eta rows are the first 30 of the window, and the
		// rest of the window (2470 rows) cannot be scanned within the cap to prove there are no more.
		expect(got).toHaveLength(28);
		expectUpdatedOrder(got);
		expect(String((refusal as { data?: unknown }).data ?? refusal)).toMatch(/SCAN_CAP_EXCEEDED.*Raise updatedSince/s);
	});

	test("createdBy whose only row sits behind more than the cap of other rows in the window -> SCAN_CAP_EXCEEDED naming the remedy, never a short page", { timeout: 120_000 }, async () => {
		const t2 = createT();
		await seedOrgs(t2);
		await seed(t2, { tag: "bulk", count: TASK_LIST_SCAN_CAP + 100, org: FLEET, status: "done", updatedAt: RECENT, by: "sigma" });
		await seed(t2, { tag: "rare", count: 1, org: FLEET, status: "done", updatedAt: LONG_AGO, by: "eta" });
		await expect(
			asMember(t2, FLEET).query(api.tasks.list, {
				status: "done",
				createdBy: "eta",
				updatedSince: 0,
				limit: 10,
			} as never),
		).rejects.toThrow(/SCAN_CAP_EXCEEDED.*Raise updatedSince/s);
	});

	test("updatedCursor without createdBefore is refused (a position has two halves)", async () => {
		await expect(
			asMember(t, FLEET).query(api.tasks.list, {
				status: "done",
				updatedSince: 0,
				updatedCursor: RECENT,
				limit: 10,
			} as never),
		).rejects.toThrow(/updatedCursor/);
	});
});
