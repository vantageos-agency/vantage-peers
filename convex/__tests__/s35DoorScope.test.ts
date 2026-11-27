/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, task k17d4vqbcwfz297b3p9g639av18k1pj1 (mcp-server-standard
// S-35: the scope is applied INSIDE the read, never after).
//
// Four tenant doors reached by the MCP as the fleet service account used to take
// no scope argument, so the MCP read the row as master and narrowed afterwards.
// Each now takes `verifiedOrg` (believed from the service account only) and the
// read runs under that organisation.
//
//   tasks:getBulkCompleteRun   missions:get   recurringTasks:getById   tasks:getById
//
// Poles per door:
//   PRESENT   the service account carrying verifiedOrg A reads A's row
//   REFUSED   verifiedOrg B gets the door's EXISTING refusal for A's row
//             (null; recurringTasks:getById raises RBAC_DENIED as it always did)
//   CLAIMLESS the service account with no verifiedOrg is refused (R-54)
//   MEMBER    an ordinary member of A without verifiedOrg reads as before

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const NOW = 1_700_000_000_000;
const SEAT = "seat-x";
const A_ID = "org_S35A1";
const B_ID = "org_S35B1";
const A_SLUG = "s35-a";
const B_SLUG = "s35-b";
const RUN = "run-s35-a";

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asMemberOfA = (t: T) =>
	t.withIdentity({
		subject: "user-s35-a",
		organizationSlug: A_SLUG,
		org_id: A_ID,
		org_role: "org:editor",
	} as Identity);
const claimA = { orgSlug: A_SLUG, orgId: A_ID };
const claimB = { orgSlug: B_SLUG, orgId: B_ID };

async function world() {
	const t = createT();
	const ids = {} as {
		task: Id<"tasks">;
		mission: Id<"missions">;
		recurring: Id<"recurringTasks">;
	};
	await t.run(async (ctx) => {
		const agent = (orgSlug: string, clerkOrgId: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId,
				name: SEAT,
				normalizedName: normalizeOrchestratorId(SEAT),
				isActive: true,
				createdAt: NOW,
			});
		const aAgent = await agent(A_SLUG, A_ID);
		const bAgent = await agent(B_SLUG, B_ID);
		const mapping = (
			clerkOrgSlug: string,
			clerkOrgId: string,
			agentId: Id<"agents">,
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug,
				clerkOrgId,
				allowedOrchestrators: [SEAT],
				allowedAgentIds: [agentId],
				scopes: ["view-own-tasks"],
				displayName: clerkOrgSlug,
				isActive: true,
				createdAt: NOW,
			});
		await mapping(A_SLUG, A_ID, aAgent);
		await mapping(B_SLUG, B_ID, bAgent);
		ids.task = await ctx.db.insert("tasks", {
			title: "A-PRIVATE-TASK",
			assignedTo: SEAT,
			assignedToId: aAgent,
			priority: "medium",
			status: "todo",
			createdBy: SEAT,
			createdById: aAgent,
			createdAt: NOW,
			updatedAt: NOW,
			orgId: A_SLUG,
			clerkOrgId: A_ID,
		});
		ids.mission = await ctx.db.insert("missions", {
			name: "A-PRIVATE-MISSION",
			project: "p",
			status: "execute",
			priority: "medium",
			pilot: SEAT,
			pilotId: aAgent,
			agents: [SEAT],
			agentIds: [aAgent],
			createdBy: SEAT,
			createdById: aAgent,
			createdAt: NOW,
			updatedAt: NOW,
			orgId: A_SLUG,
			clerkOrgId: A_ID,
		});
		ids.recurring = await ctx.db.insert("recurringTasks", {
			title: "A-PRIVATE-ROUTINE",
			assignedTo: SEAT,
			assignedToId: aAgent,
			priority: "medium",
			cronExpression: "0 9 * * *",
			nextRunAt: NOW + 1000,
			active: true,
			createdBy: SEAT,
			createdById: aAgent,
			createdAt: NOW,
			updatedAt: NOW,
			orgId: A_SLUG,
			clerkOrgId: A_ID,
		});
		await ctx.db.insert("bulk_complete_runs", {
			bulkRunId: RUN,
			orgId: A_SLUG,
			clerkOrgId: A_ID,
			createdBy: SEAT,
			status: "complete",
			closed: 3,
			remaining: false,
			startedAt: NOW,
			updatedAt: NOW,
		});
	});
	return { t, ids };
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

async function denial(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (err) {
		const e = err as { data?: unknown; message?: string };
		return String(e.data ?? e.message);
	}
	throw new Error("expected the call to be refused, it was served");
}

describe("tasks:getBulkCompleteRun", () => {
	test("PRESENT: same-org verifiedOrg reads the run", async () => {
		const { t } = await world();
		const r = await asService(t).query(api.tasks.getBulkCompleteRun, {
			bulkRunId: RUN,
			verifiedOrg: claimA,
		});
		expect(r?.closed).toBe(3);
	});
	test("REFUSED: cross-org verifiedOrg gets null", async () => {
		const { t } = await world();
		expect(
			await asService(t).query(api.tasks.getBulkCompleteRun, {
				bulkRunId: RUN,
				verifiedOrg: claimB,
			}),
		).toBeNull();
	});
	test("CLAIMLESS: the service account with no verifiedOrg is refused", async () => {
		const { t } = await world();
		const d = await denial(
			asService(t).query(api.tasks.getBulkCompleteRun, { bulkRunId: RUN }),
		);
		expect(d).toContain("RBAC_DENIED");
		expect(d).toContain("verified-org-required");
		expect(d).toContain("tasks:getBulkCompleteRun");
	});
	test("MEMBER: an ordinary member of A without verifiedOrg reads as before", async () => {
		const { t } = await world();
		const r = await asMemberOfA(t).query(api.tasks.getBulkCompleteRun, {
			bulkRunId: RUN,
		});
		expect(r?.closed).toBe(3);
	});
});

describe("missions:get", () => {
	test("PRESENT: same-org verifiedOrg reads the mission", async () => {
		const { t, ids } = await world();
		const r = await asService(t).query(api.missions.get, {
			missionId: ids.mission,
			verifiedOrg: claimA,
		});
		expect(r?.name).toBe("A-PRIVATE-MISSION");
	});
	test("REFUSED: cross-org verifiedOrg gets null", async () => {
		const { t, ids } = await world();
		expect(
			await asService(t).query(api.missions.get, {
				missionId: ids.mission,
				verifiedOrg: claimB,
			}),
		).toBeNull();
	});
	test("CLAIMLESS: the service account with no verifiedOrg is refused", async () => {
		const { t, ids } = await world();
		const d = await denial(
			asService(t).query(api.missions.get, { missionId: ids.mission }),
		);
		expect(d).toContain("verified-org-required");
		expect(d).toContain("missions:get");
	});
	test("MEMBER: an ordinary member of A without verifiedOrg reads as before", async () => {
		const { t, ids } = await world();
		const r = await asMemberOfA(t).query(api.missions.get, {
			missionId: ids.mission,
		});
		expect(r?.name).toBe("A-PRIVATE-MISSION");
	});
});

describe("recurringTasks:getById", () => {
	test("PRESENT: same-org verifiedOrg reads the routine", async () => {
		const { t, ids } = await world();
		const r = await asService(t).query(api.recurringTasks.getById, {
			recurringTaskId: ids.recurring,
			verifiedOrg: claimA,
		});
		expect(r?.title).toBe("A-PRIVATE-ROUTINE");
	});
	test("REFUSED: cross-org verifiedOrg is raised RBAC_DENIED (its existing refusal)", async () => {
		const { t, ids } = await world();
		const d = await denial(
			asService(t).query(api.recurringTasks.getById, {
				recurringTaskId: ids.recurring,
				verifiedOrg: claimB,
			}),
		);
		expect(d).toContain("RBAC_DENIED");
	});
	test("CLAIMLESS: the service account with no verifiedOrg is refused", async () => {
		const { t, ids } = await world();
		const d = await denial(
			asService(t).query(api.recurringTasks.getById, {
				recurringTaskId: ids.recurring,
			}),
		);
		expect(d).toContain("verified-org-required");
		expect(d).toContain("recurringTasks:getById");
	});
	test("MEMBER: an ordinary member of A without verifiedOrg reads as before", async () => {
		const { t, ids } = await world();
		const r = await asMemberOfA(t).query(api.recurringTasks.getById, {
			recurringTaskId: ids.recurring,
		});
		expect(r?.title).toBe("A-PRIVATE-ROUTINE");
	});
});

describe("tasks:getById", () => {
	test("PRESENT: same-org verifiedOrg reads the task", async () => {
		const { t, ids } = await world();
		const r = await asService(t).query(api.tasks.getById, {
			taskId: ids.task,
			verifiedOrg: claimA,
		});
		expect(r?.title).toBe("A-PRIVATE-TASK");
	});
	test("REFUSED: cross-org verifiedOrg gets null", async () => {
		const { t, ids } = await world();
		expect(
			await asService(t).query(api.tasks.getById, {
				taskId: ids.task,
				verifiedOrg: claimB,
			}),
		).toBeNull();
	});
	test("CLAIMLESS: the service account with no verifiedOrg is refused", async () => {
		const { t, ids } = await world();
		const d = await denial(
			asService(t).query(api.tasks.getById, { taskId: ids.task }),
		);
		expect(d).toContain("verified-org-required");
		expect(d).toContain("tasks:getById");
	});
	test("MEMBER: an ordinary member of A without verifiedOrg reads as before", async () => {
		const { t, ids } = await world();
		const r = await asMemberOfA(t).query(api.tasks.getById, {
			taskId: ids.task,
		});
		expect(r?.title).toBe("A-PRIVATE-TASK");
	});
});
