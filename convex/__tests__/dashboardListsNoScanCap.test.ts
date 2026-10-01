/// <reference types="vite/client" />
/**
 * THE DASHBOARD'S OWN LIST SHAPES NEVER HIT SCAN_CAP_EXCEEDED.
 *
 * Measured at vantage-peers-dashboard origin/main e2dc58f
 * (`git grep -n "api.tasks.list\|api.briefingNotes.list" origin/main -- components`):
 *   components/activity/unified-activity-feed.tsx:154   useQuery(api.tasks.list, {})
 *   components/dashboard/critical-blockers-widget.tsx:192 useQuery(api.tasks.list, {})
 *   components/briefings/briefing-list.tsx:189          useQuery(api.briefingNotes.list, { limit: 50 })
 * (no call site sends updatedSince or createdBy — the cap message names them
 * generically). Both shapes carry NO pre-slice filter, so the widened scan
 * protected nothing and threw once a table (tasks) or an org's bodies
 * (briefingNotes) outgrew the cap.
 *
 * Poles:
 *   tasks.list {}        master (operator-org admin) over > cap rows -> served   [RED before]
 *   tasks.list {}        member of a small org, table > cap elsewhere -> own rows [RED before]
 *   tasks.list {createdBy} over > cap rows -> STILL refused SCAN_CAP_EXCEEDED (loud, unchanged)
 *   briefingNotes.list {limit} member, own org byte-heavy -> served             [RED before]
 *   briefingNotes.list {limit:50} operator-org admin over > cap rows -> served
 *   briefingNotes.list {updatedSince} over cap -> STILL refused (unchanged)
 */

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { BRIEFING_NOTES_LIST_SCAN_CAP } from "../briefingNotes";
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

const OPERATOR_ORG = "operator-scan-org";
const SMALL_ORG = "small-scan-org";
const BIG_ORG = "big-scan-org";
const ROWS = TASK_LIST_SCAN_CAP + 5;

async function seedOrgs(t: T) {
	await t.run(async (ctx) => {
		const base = {
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks", "view-own-missions"],
			isActive: true,
			createdAt: Date.now(),
		};
		await ctx.db.insert("client_org_mapping", {
			...base,
			clerkOrgSlug: OPERATOR_ORG,
			displayName: OPERATOR_ORG,
			orgKind: "operator",
		});
		await ctx.db.insert("client_org_mapping", {
			...base,
			clerkOrgSlug: SMALL_ORG,
			displayName: SMALL_ORG,
			orgKind: "client",
		});
	});
}

const operator = (t: T) =>
	t.withIdentity({
		subject: "operator-user",
		org_slug: OPERATOR_ORG,
		org_role: "org:admin",
	} as Identity);
const member = (t: T) =>
	t.withIdentity({
		subject: "small-member",
		org_slug: SMALL_ORG,
		org_role: "org:member",
	} as Identity);

async function seedTasks(t: T, orgId: string, count: number) {
	const CHUNK = 500;
	for (let from = 0; from < count; from += CHUNK) {
		await t.run(async (ctx) => {
			for (let i = from; i < Math.min(from + CHUNK, count); i++) {
				await ctx.db.insert("tasks", {
					title: `${orgId}-task-${i}`,
					assignedTo: "sigma",
					priority: "medium",
					status: "todo",
					createdBy: "sigma",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					orgId,
				} as never);
			}
		});
	}
}

async function refusalText(p: Promise<unknown>): Promise<string> {
	let caught: unknown;
	try {
		await p;
	} catch (e) {
		caught = e;
	}
	expect(caught).toBeInstanceOf(ConvexError);
	return String((caught as ConvexError<string>).data);
}

describe("tasks.list {} — the dashboard's shape", () => {
	test("operator-org admin (master) over more than the cap -> served the newest page", async () => {
		const t = convexTest(schema, modules);
		await seedOrgs(t);
		await seedTasks(t, BIG_ORG, ROWS);
		const rows = await operator(t).query(api.tasks.list, {});
		expect(rows).toHaveLength(30);
	});

	test("member of a small org while another org holds more than the cap -> its own rows", async () => {
		const t = convexTest(schema, modules);
		await seedOrgs(t);
		await seedTasks(t, BIG_ORG, ROWS);
		await seedTasks(t, SMALL_ORG, 3);
		const rows = (await member(t).query(api.tasks.list, {})) as Array<{
			orgId?: string;
		}>;
		expect(rows).toHaveLength(3);
		expect(rows.every((r) => r.orgId === SMALL_ORG)).toBe(true);
	});

	test("createdBy over more than the cap is STILL refused loudly", async () => {
		const t = convexTest(schema, modules);
		await seedOrgs(t);
		await seedTasks(t, BIG_ORG, ROWS);
		const text = await refusalText(
			operator(t).query(api.tasks.list, { createdBy: "sigma" }),
		);
		expect(text).toContain("SCAN_CAP_EXCEEDED");
	});
});

const BODY = "x".repeat(220_000);

async function seedNotes(
	t: T,
	orgId: string,
	count: number,
	content: string,
	chunk: number,
) {
	for (let from = 0; from < count; from += chunk) {
		await t.run(async (ctx) => {
			for (let i = from; i < Math.min(from + chunk, count); i++) {
				await ctx.db.insert("briefingNotes", {
					title: `${orgId}-note-${i}`,
					topic: "scan-topic",
					participants: [],
					content,
					createdBy: "system",
					createdAt: Date.now() + i,
					orgId,
				} as never);
			}
		});
	}
}

describe("briefingNotes.list { limit } — the dashboard's shape", () => {
	test("member whose own org holds byte-heavy bodies -> served `limit` rows, not SCAN_CAP_EXCEEDED", async () => {
		const t = (convexTest({ schema, modules, transactionLimits: true }) as unknown as T);
		await seedOrgs(t);
		await seedNotes(t, SMALL_ORG, 90, BODY, 30);
		const rows = await member(t).query(api.briefingNotes.list, { limit: 5 });
		expect(rows).toHaveLength(5);
	});

	test("operator-org admin (master) over more than the cap -> served 50", async () => {
		const t = convexTest(schema, modules);
		await seedOrgs(t);
		await seedNotes(t, BIG_ORG, BRIEFING_NOTES_LIST_SCAN_CAP + 5, "b", 500);
		const rows = await operator(t).query(api.briefingNotes.list, { limit: 50 });
		expect(rows).toHaveLength(50);
	});

	test("a byte-ceiling trip on a narrow read is a refusal, never an empty success", async () => {
		const t = (convexTest({ schema, modules, transactionLimits: true }) as unknown as T);
		await seedOrgs(t);
		await seedNotes(t, SMALL_ORG, 90, BODY, 30);
		const text = await refusalText(
			member(t).query(api.briefingNotes.list, { limit: 90 }),
		);
		expect(text).toContain("SCAN_CAP_EXCEEDED");
	});

	test("updatedSince over more than the cap is STILL refused loudly", async () => {
		const t = convexTest(schema, modules);
		await seedOrgs(t);
		await seedNotes(t, BIG_ORG, BRIEFING_NOTES_LIST_SCAN_CAP + 5, "b", 500);
		const text = await refusalText(
			operator(t).query(api.briefingNotes.list, {
				limit: 50,
				updatedSince: 0,
			}),
		);
		expect(text).toContain("SCAN_CAP_EXCEEDED");
	});
});
