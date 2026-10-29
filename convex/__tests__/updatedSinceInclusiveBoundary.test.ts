/// <reference types="vite/client" />
//
// updatedSinceInclusiveBoundary.test.ts — the `updatedSince` contract of the
// task reads is INCLUSIVE: a row with `updatedAt === updatedSince` is
// returned. An incremental poller passing `updatedSince = last seen` would
// otherwise silently drop the very row it last saw changing again at that
// instant. Every existing pole uses threshold -1 / +1 and never touches the
// edge, so flipping a comparison to exclusive stayed green.
//
// One test per comparison site, none inferred from another:
//   tasks.list       index range  `.gte("updatedAt", updatedSince)`  (assignee, no project)
//   tasks.list       in-memory    `>= updatedSince`                  (every other branch;
//                                  one test per distinct branch below)
//   tasks.listByMission in-memory `>= updatedSince`                  (master + org member)
//
// Each test seeds a row at EXACTLY the threshold (must be returned) and a row
// at threshold - 1 (must be absent).
//
// Fictitious identifiers only.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { insertTaskRow, seedFleetAgents } from "../../tests/lib/seedFleetAgents";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const LABEL = "test-orch-inclusive-edge";
const SERVICE_ACCOUNT = "test-service-account-user-id";
const THRESHOLD = 1_800_000_000_000;
const AT_EDGE = "row-at-threshold";
const BELOW_EDGE = "row-below-threshold";

type Row = Record<string, unknown>;

function extractItems(result: unknown): Row[] {
	if (Array.isArray(result)) return result as Row[];
	if (result !== null && typeof result === "object") {
		const r = result as Record<string, unknown>;
		if (Array.isArray(r.items)) return r.items as Row[];
	}
	return [];
}

const titles = (result: unknown): string[] =>
	extractItems(result).map((r) => r.title as string);

/** Seeds one row exactly at the threshold and one at threshold - 1. */
async function seedEdgePair(
	t: ReturnType<typeof newT>,
	extra: Record<string, unknown>,
): Promise<void> {
	await t.run(async (ctx) => {
		for (const [title, updatedAt] of [
			[AT_EDGE, THRESHOLD],
			[BELOW_EDGE, THRESHOLD - 1],
		] as const) {
			await insertTaskRow(ctx, {
				title,
				assignedTo: LABEL,
				priority: "medium",
				status: "todo",
				createdBy: LABEL,
				createdAt: THRESHOLD - 10,
				updatedAt,
				...extra,
			} as never);
		}
	});
}

const newT = () => convexTest(schema, modules);
const asService = (t: ReturnType<typeof newT>) =>
	t.withIdentity({ subject: SERVICE_ACCOUNT });

async function freshFleet() {
	const t = newT();
	await seedFleetAgents(t, ["eta", "sigma", LABEL]);
	return t;
}

function expectEdgeIncluded(result: unknown): void {
	const got = titles(result);
	expect(got).toContain(AT_EDGE);
	expect(got).not.toContain(BELOW_EDGE);
}

describe("tasks.list — updatedSince is inclusive at the exact threshold", () => {
	test("SITE tasks.ts index range .gte (master, assignedTo, no project, status bucket)", async () => {
		const t = await freshFleet();
		await seedEdgePair(t, {});
		const result = await asService(t).query(api.tasks.list, {
			assignedTo: LABEL,
			status: "todo",
			updatedSince: THRESHOLD,
			limit: 10,
			fields: "full",
		});
		expectEdgeIncluded(result);
	});

	test("SITE tasks.ts index range .gte (master, assignedTo, no status: every bucket)", async () => {
		const t = await freshFleet();
		await seedEdgePair(t, {});
		const result = await asService(t).query(api.tasks.list, {
			assignedTo: LABEL,
			updatedSince: THRESHOLD,
			limit: 10,
			fields: "full",
		});
		expectEdgeIncluded(result);
	});

	test("SITE tasks.ts in-memory >= (master, assignedTo + project)", async () => {
		const t = await freshFleet();
		await seedEdgePair(t, { project: "inclusive-edge-project" });
		const result = await asService(t).query(api.tasks.list, {
			assignedTo: LABEL,
			project: "inclusive-edge-project",
			status: "todo",
			updatedSince: THRESHOLD,
			limit: 10,
			fields: "full",
		});
		expectEdgeIncluded(result);
	});

	test("SITE tasks.ts in-memory >= (master, assignedToInstance)", async () => {
		const t = await freshFleet();
		await seedEdgePair(t, { assignedToInstance: "inclusive-edge-instance" });
		const result = await asService(t).query(api.tasks.list, {
			assignedToInstance: "inclusive-edge-instance",
			status: "todo",
			updatedSince: THRESHOLD,
			limit: 10,
			fields: "full",
		});
		expectEdgeIncluded(result);
	});

	test("SITE tasks.ts in-memory >= (master, project only)", async () => {
		const t = await freshFleet();
		await seedEdgePair(t, { project: "inclusive-edge-project-only" });
		const result = await asService(t).query(api.tasks.list, {
			project: "inclusive-edge-project-only",
			status: "todo",
			updatedSince: THRESHOLD,
			limit: 10,
			fields: "full",
		});
		expectEdgeIncluded(result);
	});

	test("SITE tasks.ts in-memory >= (master, no assignee / instance / project filter)", async () => {
		const t = await freshFleet();
		await seedEdgePair(t, {});
		const result = await asService(t).query(api.tasks.list, {
			status: "todo",
			updatedSince: THRESHOLD,
			limit: 10,
			fields: "full",
		});
		expectEdgeIncluded(result);
	});
});

// ── org member ──────────────────────────────────────────────────────────────

const MEMBER_ORG = "edge-org";
const MEMBER_ROSTER = "edge-member-orch";

async function seedMemberOrg(t: ReturnType<typeof newT>): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: MEMBER_ORG,
			clerkOrgId: testClerkOrgId(MEMBER_ORG),
			allowedOrchestrators: [MEMBER_ROSTER],
			scopes: ["view-own-tasks", "view-own-missions"],
			displayName: MEMBER_ORG,
			isActive: true,
			createdAt: 1,
		});
		await ctx.db.insert("agents", {
			orgSlug: MEMBER_ORG,
			clerkOrgId: testClerkOrgId(MEMBER_ORG),
			name: MEMBER_ROSTER,
			normalizedName: MEMBER_ROSTER,
			isActive: true,
			createdAt: 1,
		});
	});
}

const asMember = (t: ReturnType<typeof newT>) =>
	t.withIdentity({
		subject: `member-of-${MEMBER_ORG}`,
		organizationId: MEMBER_ORG,
		org_id: testClerkOrgId(MEMBER_ORG),
		organizationSlug: MEMBER_ORG,
	} as Parameters<ReturnType<typeof newT>["withIdentity"]>[0]);

async function seedMemberPair(
	t: ReturnType<typeof newT>,
	extra: Record<string, unknown>,
): Promise<void> {
	await t.run(async (ctx) => {
		for (const [title, updatedAt] of [
			[AT_EDGE, THRESHOLD],
			[BELOW_EDGE, THRESHOLD - 1],
		] as const) {
			await insertTaskRow(ctx, {
				title,
				orgId: MEMBER_ORG,
				clerkOrgId: testClerkOrgId(MEMBER_ORG),
				assignedTo: MEMBER_ROSTER,
				priority: "medium",
				status: "todo",
				createdBy: MEMBER_ROSTER,
				createdAt: THRESHOLD - 10,
				updatedAt,
				...extra,
			} as never);
		}
	});
}

describe("tasks.list — org member branch, updatedSince inclusive at the threshold", () => {
	test("SITE tasks.ts in-memory >= (org member, org-keyed index, no assignee)", async () => {
		const t = await freshFleet();
		await seedMemberOrg(t);
		await seedMemberPair(t, {});
		const result = await asMember(t).query(api.tasks.list, {
			status: "todo",
			updatedSince: THRESHOLD,
			limit: 10,
			fields: "full",
		});
		expectEdgeIncluded(result);
	});
});

// ── listByMission ───────────────────────────────────────────────────────────

async function insertMission(
	t: ReturnType<typeof newT>,
	orgId?: string,
): Promise<ReturnType<typeof t.run>> {
	return await t.run(async (ctx) =>
		ctx.db.insert("missions", {
			name: "fixture-mission-inclusive-edge",
			project: "fixture-project-inclusive-edge",
			status: "execute",
			priority: "medium",
			pilot: LABEL,
			agents: [LABEL],
			createdBy: LABEL,
			createdAt: THRESHOLD - 100,
			updatedAt: THRESHOLD - 100,
			...(orgId !== undefined
				? { orgId, clerkOrgId: testClerkOrgId(orgId) }
				: {}),
		} as never),
	);
}

describe("tasks.listByMission — updatedSince inclusive at the threshold", () => {
	test("SITE tasks.ts in-memory >= (master, by_mission)", async () => {
		const t = await freshFleet();
		const missionId = (await insertMission(t)) as never;
		await seedEdgePair(t, { missionId });
		const result = await asService(t).query(api.tasks.listByMission, {
			missionId,
			status: "todo",
			updatedSince: THRESHOLD,
			limit: 10,
			fields: "full",
		});
		expectEdgeIncluded(result);
	});

	test("SITE tasks.ts in-memory >= (org member, by_orgId_mission_status)", async () => {
		const t = await freshFleet();
		await seedMemberOrg(t);
		const missionId = (await insertMission(t, MEMBER_ORG)) as never;
		await seedMemberPair(t, { missionId });
		const result = await asMember(t).query(api.tasks.listByMission, {
			missionId,
			status: "todo",
			updatedSince: THRESHOLD,
			limit: 10,
			fields: "full",
		});
		expectEdgeIncluded(result);
	});
});
