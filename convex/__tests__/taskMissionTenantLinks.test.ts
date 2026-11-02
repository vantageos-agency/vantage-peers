/// <reference types="vite/client" />
// taskMissionTenantLinks.test.ts — task k175x770r9f6h01xt0wg0hdd798hf8m4.
//
// migrations/taskMissionTenantLinks:count is a READ-ONLY, COUNTS-ONLY measurement
// of how many stored tasks reference a mission of another tenant, or a mission
// that does not exist. Seeded rows: own, foreign (both directions), fleet,
// dangling, and a task with no mission. The output carries counts and org slugs
// only: no task or mission id, no title, no content.

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { insertTaskRow } from "../../tests/lib/seedFleetAgents";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync"),
	),
);
const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;
type PageResult = {
	examined: number;
	foreign: number;
	truncated: boolean;
	nextCursor: string | null;
};

const stamp = (org: string | undefined) =>
	org === undefined ? {} : { orgId: org, clerkOrgId: testClerkOrgId(org) };

const mission = (t: T, org: string | undefined) =>
	t.run((ctx) =>
		ctx.db.insert("missions", {
			name: "SECRET-MISSION-NAME",
			project: "p",
			status: "execute" as const,
			priority: "medium" as const,
			pilot: "x",
			agents: ["x"],
			createdBy: "x",
			createdAt: 1,
			updatedAt: 1,
			...stamp(org),
		}),
	);

const task = (
	t: T,
	org: string | undefined,
	missionId: Id<"missions"> | undefined,
	title = "SECRET-TASK-TITLE",
) =>
	t.run((ctx) =>
		insertTaskRow(ctx, {
			title,
			assignedTo: "x",
			createdBy: "x",
			priority: "low",
			status: "todo",
			createdAt: 1,
			updatedAt: 1,
			...stamp(org),
			...(missionId !== undefined ? { missionId } : {}),
		}),
	);

async function seed(t: T) {
	const mA = await mission(t, "org-a");
	const mB = await mission(t, "org-b");
	const gone = await t.run(async (ctx) => {
		const id = await ctx.db.insert("missions", {
			name: "gone",
			project: "p",
			status: "execute" as const,
			priority: "medium" as const,
			pilot: "x",
			agents: ["x"],
			createdBy: "x",
			createdAt: 1,
			updatedAt: 1,
			...stamp("org-a"),
		});
		await ctx.db.delete(id);
		return id;
	});
	await task(t, "org-a", mA); // own
	await task(t, "org-a", mA); // own
	await task(t, "org-a", mB); // foreign (a -> b)
	await task(t, "org-a", mB); // foreign (a -> b)
	await task(t, "org-b", mA); // foreign (b -> a)
	await task(t, "org-b", gone); // dangling
	await task(t, "org-a", gone); // dangling
	await task(t, "org-a", undefined); // no mission
	await task(t, undefined, mA); // fleet task on an org mission: foreign
}

describe("migrations/taskMissionTenantLinks:count", () => {
	test("counts foreign, dangling and own per org; no id or content in the output", async () => {
		const t = makeT();
		await seed(t);
		const out = await t.query(internal.migrations.taskMissionTenantLinks.count, {});
		expect(out.truncated).toBe(false);
		expect(out.examined).toBe(9);
		expect(out.withMissionId).toBe(8);
		expect(out.own).toBe(2);
		expect(out.foreign).toBe(4);
		expect(out.dangling).toBe(2);
		const by = Object.fromEntries(out.perOrg.map((o) => [o.org, o]));
		expect(by["org-a"]).toEqual({ org: "org-a", foreign: 2, dangling: 1 });
		expect(by["org-b"]).toEqual({ org: "org-b", foreign: 1, dangling: 1 });
		expect(by["(none)"]).toEqual({ org: "(none)", foreign: 1, dangling: 0 });
		const text = JSON.stringify(out);
		expect(text).not.toMatch(/SECRET|;tasks|;missions/);
		expect(Object.keys(out).sort()).toEqual(
			["dangling", "examined", "foreign", "nextCursor", "own", "perOrg", "truncated", "withMissionId"].sort(),
		);
	});

	test("bounded: a limit below the table size reports truncated and a cursor; pages sum to the whole", async () => {
		const t = makeT();
		await seed(t);
		let cursor: string | null = null;
		let foreign = 0;
		let examined = 0;
		let pages = 0;
		let firstTruncated: boolean | undefined;
		do {
			const out: PageResult = await t.query(
				internal.migrations.taskMissionTenantLinks.count,
				{
					limit: 4,
					...(cursor !== null ? { cursor } : {}),
				},
			);
			if (firstTruncated === undefined) firstTruncated = out.truncated;
			foreign += out.foreign;
			examined += out.examined;
			cursor = out.nextCursor;
			pages++;
		} while (cursor !== null && pages < 10);
		expect(firstTruncated).toBe(true);
		expect(pages).toBe(3);
		expect(examined).toBe(9);
		expect(foreign).toBe(4);
	});
});
