/// <reference types="vite/client" />
/**
 * Task k17ec64enc1wpghww9mrahvm4s8hf0gh -- the backend is the authority.
 *
 * Seven MCP tools are `kind: master` at the MCP layer. This suite calls the
 * Convex function behind each one DIRECTLY (no MCP in the path), as:
 *   - an ordinary org member (Clerk session, org_id of org A);
 *   - a seat: the fleet service account acting for org A (`__actingOrg`);
 *   - the fleet master (service account, no acting org).
 *
 * Five doors are fleet-master-only at Convex and must refuse both scoped
 * callers with RBAC_DENIED and leave the row untouched:
 *   issues:updateStatus, issues:linkCommit, issues:verify,
 *   errorMonitor:addDeployment, errorMonitor:removeDeployment.
 *
 * Two doors are scoped BY DESIGN at Convex and stay scoped (their MCP kind is
 * a second, narrower layer): missions:updateStatus (dashboard member with a
 * writer role, own org only) and memories:softDeleteMemory (own org's memory
 * only). Pinned here so neither is widened to a foreign org nor narrowed to
 * master-only without a test failing.
 */

import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { findAgentId } from "../../tests/lib/agentIdOf";
import { seedRosterAgents } from "../../tests/lib/seedRosterAgents";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("search") && !path.includes("backfill"),
	),
);

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const A = "mo-org-a";
const B = "mo-org-b";
const A_ID = testClerkOrgId(A);

const member = (t: T) =>
	t.withIdentity({
		subject: "member-of-a",
		organizationId: A,
		org_id: A_ID,
		org_role: "org:admin",
	} as Parameters<T["withIdentity"]>[0]);
const service = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

/** Call shape that reaches the Convex door as the seat of org A. */
const asSeat = <Args extends Record<string, unknown>>(args: Args) => ({
	...args,
	__actingOrg: A_ID,
});

async function seedOrgs(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: 1,
		});
		for (const [org, seat] of [
			[A, "alice"],
			[B, "bob"],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: org,
				clerkOrgId: testClerkOrgId(org),
				allowedOrchestrators: [seat],
				scopes: ["view-own-missions"],
				displayName: org,
				isActive: true,
				createdAt: 1,
			});
		}
	});
	await seedRosterAgents(t);
}

/** The RBAC code (or SERVED) a call ends in -- the refusal is read by content. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
		return "SERVED";
	} catch (e) {
		const text = e instanceof ConvexError ? String(e.data) : String(e);
		return /RBAC_DENIED/.test(text) ? "RBAC_DENIED" : `OTHER(${text.slice(0, 160)})`;
	}
}

const seedIssue = (t: T) =>
	t.run((ctx) =>
		ctx.db.insert("issues", {
			repo: "acme/widgets",
			issueNumber: 7,
			title: "t",
			body: "b",
			htmlUrl: "https://github.com/acme/widgets/issues/7",
			labels: [],
			status: "open",
			priority: "medium",
			assignedOrchestrator: "sigma",
			project: "widgets",
			githubCreatedAt: 1,
			githubUpdatedAt: 1,
		}),
	);

const seedDeployment = (t: T) =>
	t.run((ctx) =>
		ctx.db.insert("monitoredDeployments", {
			name: "dep",
			deploymentUrl: "https://x.convex.cloud",
			deployKeyEnvVar: "K",
			githubRepo: "acme/widgets",
			orchestrator: "sigma",
			active: true,
			createdAt: 1,
		}),
	);

const DEPLOYMENT_ARGS = {
	name: "dep-new",
	deploymentUrl: "https://y.convex.cloud",
	deployKeyEnvVar: "K2",
	githubRepo: "acme/widgets",
	orchestrator: "sigma",
};

type MasterDoor = {
	door: string;
	call: (c: T | ReturnType<T["withIdentity"]>, seat: boolean) => Promise<unknown>;
	prepare: (t: T) => Promise<unknown>;
	table: "issues" | "monitoredDeployments";
};

const ISSUE = { repo: "acme/widgets", issueNumber: 7 };
const DOORS: MasterDoor[] = [
	{
		door: "issues:updateStatus (update_issue_status)",
		prepare: seedIssue,
		table: "issues",
		call: (c, seat) =>
			(c as ReturnType<T["withIdentity"]>).mutation(
				api.issues.updateStatus,
				seat ? asSeat({ ...ISSUE, status: "fixed" }) : { ...ISSUE, status: "fixed" },
			),
	},
	{
		door: "issues:linkCommit (link_commit_to_issue)",
		prepare: seedIssue,
		table: "issues",
		call: (c, seat) => {
			const a = { ...ISSUE, commitSha: "deadbeef", fixedBy: "mimir" };
			return (c as ReturnType<T["withIdentity"]>).mutation(
				api.issues.linkCommit,
				seat ? asSeat(a) : a,
			);
		},
	},
	{
		door: "issues:verify (verify_issue)",
		prepare: seedIssue,
		table: "issues",
		call: (c, seat) => {
			const a = { ...ISSUE, verifiedBy: "mimir" };
			return (c as ReturnType<T["withIdentity"]>).mutation(
				api.issues.verify,
				seat ? asSeat(a) : a,
			);
		},
	},
	{
		door: "errorMonitor:addDeployment (add_deployment)",
		prepare: seedDeployment,
		table: "monitoredDeployments",
		call: (c, seat) =>
			(c as ReturnType<T["withIdentity"]>).mutation(
				api.errorMonitor.addDeployment,
				seat ? asSeat(DEPLOYMENT_ARGS) : DEPLOYMENT_ARGS,
			),
	},
	{
		door: "errorMonitor:removeDeployment (remove_deployment)",
		prepare: seedDeployment,
		table: "monitoredDeployments",
		call: (c, seat) =>
			(c as ReturnType<T["withIdentity"]>).mutation(
				api.errorMonitor.removeDeployment,
				seat ? asSeat({ name: "dep" }) : { name: "dep" },
			),
	},
];

describe("fleet-master-only doors refuse a scoped caller at Convex", () => {
	for (const d of DOORS) {
		test(`${d.door}: org member -> RBAC_DENIED, row unchanged`, async () => {
			const t = createT();
			await seedOrgs(t);
			await d.prepare(t);
			const before = JSON.stringify(
				await t.run((ctx) => ctx.db.query(d.table).collect()),
			);
			expect(await outcome(() => d.call(member(t), false))).toBe("RBAC_DENIED");
			expect(
				JSON.stringify(await t.run((ctx) => ctx.db.query(d.table).collect())),
			).toBe(before);
		});

		test(`${d.door}: seat (service account acting for org A) -> RBAC_DENIED, row unchanged`, async () => {
			const t = createT();
			await seedOrgs(t);
			await d.prepare(t);
			const before = JSON.stringify(
				await t.run((ctx) => ctx.db.query(d.table).collect()),
			);
			expect(await outcome(() => d.call(service(t), true))).toBe("RBAC_DENIED");
			expect(
				JSON.stringify(await t.run((ctx) => ctx.db.query(d.table).collect())),
			).toBe(before);
		});

		test(`${d.door}: anonymous -> RBAC_DENIED`, async () => {
			const t = createT();
			await seedOrgs(t);
			await d.prepare(t);
			expect(await outcome(() => d.call(t, false))).toBe("RBAC_DENIED");
		});

		test(`${d.door}: fleet master is still served`, async () => {
			const t = createT();
			await seedOrgs(t);
			await d.prepare(t);
			expect(await outcome(() => d.call(service(t), false))).toBe("SERVED");
		});
	}
});

describe("doors kept scoped by design (doctrine grants a member its own org)", () => {
	const seedMission = async (t: T, org: string, seat: string) => {
		const creator = (await findAgentId(t, org, seat)) ?? undefined;
		return await t.run((ctx) =>
			ctx.db.insert("missions", {
				name: "m",
				project: "p",
				status: "plan",
				priority: "medium",
				pilot: seat,
				agents: [seat],
				createdBy: seat,
				pilotId: creator,
				createdById: creator,
				createdAt: 1,
				updatedAt: 1,
				orgId: org,
				clerkOrgId: testClerkOrgId(org),
			}),
		);
	};

	test("missions:updateStatus: member of A serves its own mission, is refused org B's", async () => {
		const t = createT();
		await seedOrgs(t);
		const own = await seedMission(t, A, "alice");
		const foreign = await seedMission(t, B, "bob");
		expect(
			await outcome(() =>
				member(t).mutation(api.missions.updateStatus, {
					missionId: own,
					status: "execute",
				}),
			),
		).toBe("SERVED");
		expect(
			await outcome(() =>
				member(t).mutation(api.missions.updateStatus, {
					missionId: foreign,
					status: "execute",
				}),
			),
		).toBe("RBAC_DENIED");
		expect((await t.run((ctx) => ctx.db.get(foreign)))?.status).toBe("plan");
	});

	test("missions:updateStatus: the seat of A is refused org B's mission", async () => {
		const t = createT();
		await seedOrgs(t);
		const foreign = await seedMission(t, B, "bob");
		expect(
			await outcome(() =>
				service(t).mutation(
					api.missions.updateStatus,
					asSeat({ missionId: foreign, status: "execute" }),
				),
			),
		).toBe("RBAC_DENIED");
		expect((await t.run((ctx) => ctx.db.get(foreign)))?.status).toBe("plan");
	});

	const seedMemory = (t: T, org: string) =>
		t.run((ctx) =>
			ctx.db.insert("memories", {
				namespace: `team/${testClerkOrgId(org)}`,
				type: "project",
				content: `memory of ${org}`,
				createdBy: "alice",
				isLatest: true,
				relations: [],
				createdAt: 1,
				updatedAt: 1,
				clerkOrgId: testClerkOrgId(org),
			}),
		);

	test("memories:softDeleteMemory: member of A deletes its own org's memory, not org B's", async () => {
		const t = createT();
		await seedOrgs(t);
		const own = await seedMemory(t, A);
		const foreign = await seedMemory(t, B);
		expect(
			await outcome(() =>
				member(t).mutation(api.memories.softDeleteMemory, { memoryId: own }),
			),
		).toBe("SERVED");
		expect(
			await outcome(() =>
				member(t).mutation(api.memories.softDeleteMemory, { memoryId: foreign }),
			),
		).toBe("RBAC_DENIED");
		expect((await t.run((ctx) => ctx.db.get(foreign)) as { isLatest: boolean }).isLatest).toBe(true);
	});

	test("memories:softDeleteMemory: the seat of A is refused org B's memory", async () => {
		const t = createT();
		await seedOrgs(t);
		const foreign = await seedMemory(t, B);
		expect(
			await outcome(() =>
				service(t).mutation(
					api.memories.softDeleteMemory,
					asSeat({ memoryId: foreign }),
				),
			),
		).toBe("RBAC_DENIED");
		expect((await t.run((ctx) => ctx.db.get(foreign)) as { isLatest: boolean }).isLatest).toBe(true);
	});
});
