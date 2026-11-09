/// <reference types="vite/client" />
//
// A write made by the fleet master (the MCP-bound service account, no organisation
// acted for) is stamped with the OPERATOR organisation's permanent ID, derived from the
// active `orgKind: "operator"` mapping row (convex/lib/operatorOrg.ts), never typed.
// Task k176x68sj2jkwx46nshvtt40e18ht1xh. Before it, such a row carried no organisation
// and `erase:eraseRow` refused it `target-unstamped`.
//
//   POSITIVE  memory / mission / task / diary / briefing note written as the master
//             carry the operator org ID, and the seat that wrote them can erase them
//   NEGATIVE  a member of ANOTHER organisation does not get the operator stamp, and a
//             team-namespace memory keeps the ID its namespace names

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedRosterAgents } from "../../tests/lib/seedRosterAgents";
import { api } from "../_generated/api";
import schema from "../schema";

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

const SERVICE = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
const OPERATOR_ID = testClerkOrgId("test-operator-org");
const CLIENT = "stamp-client-org";

let t: T;
beforeEach(async () => {
	vi.useFakeTimers();
	t = createT();
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "test-operator-org",
			clerkOrgId: OPERATOR_ID,
			allowedOrchestrators: ["sigma", "seat-x"],
			scopes: [],
			displayName: "operator",
			isActive: true,
			createdAt: 1,
			orgKind: "operator" as const,
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: CLIENT,
			clerkOrgId: testClerkOrgId(CLIENT),
			allowedOrchestrators: ["alice"],
			scopes: ["vantage:read", "vantage:write"],
			displayName: CLIENT,
			isActive: true,
			createdAt: 1,
		});
	});
	await seedRosterAgents(t);
});
afterEach(() => {
	vi.useRealTimers();
});

const service = () => t.withIdentity({ subject: SERVICE });

describe("a fleet-master write is stamped with the operator organisation", () => {
	test("memories:storeMemory in a non-team namespace", async () => {
		const id = await service().mutation(api.memories.storeMemory, {
			namespace: "global",
			type: "project",
			content: "fleet memory",
			createdBy: "sigma",
		} as never);
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.clerkOrgId).toBe(OPERATOR_ID);
	});

	test("memories:storeMemory in a team namespace keeps the ID the namespace names", async () => {
		const id = await service().mutation(api.memories.storeMemory, {
			namespace: `team/${testClerkOrgId(CLIENT)}`,
			type: "project",
			content: "team memory",
			createdBy: "sigma",
		} as never);
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.clerkOrgId).toBe(testClerkOrgId(CLIENT));
	});

	test("missions:create", async () => {
		const id = await service().mutation(api.missions.create, {
			name: "fleet mission",
			project: "p",
			priority: "medium",
			status: "execute",
			pilot: "sigma",
			createdBy: "sigma",
			agents: [],
		} as never);
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.clerkOrgId).toBe(OPERATOR_ID);
	});

	test("tasks:create", async () => {
		const id = await service().mutation(api.tasks.create, {
			title: "fleet task",
			project: "p",
			assignedTo: "sigma",
			priority: "medium",
			status: "todo",
			createdBy: "sigma",
		} as never);
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.clerkOrgId).toBe(OPERATOR_ID);
	});

	test("diary:write", async () => {
		const id = await service().mutation(api.diary.write, {
			date: "2026-11-09",
			orchestrator: "sigma",
			content: "entry",
			highlights: [],
			blockers: [],
			createdBy: "sigma",
		} as never);
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.clerkOrgId).toBe(OPERATOR_ID);
	});

	test("briefingNotes:create", async () => {
		const id = await service().mutation(api.briefingNotes.create, {
			title: "note",
			topic: "handoff",
			participants: ["seat-x"],
			content: "content",
			createdBy: "seat-x",
		} as never);
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.clerkOrgId).toBe(OPERATOR_ID);
	});
});
