/// <reference types="vite/client" />
/**
 * A create the fleet service account makes FOR a verified org is stamped in
 * that org, or refused; never stored unstamped (task
 * k176y0q5jcz3m8m673bf61kva98h49js).
 *
 * Measured on production: a person acting as its personal agent created a task
 * through the MCP (service account + verifiedActor of a client-org agent); the
 * row was stored with no orgId and no clerkOrgId, and every org-scoped read
 * filtered it out.
 *
 * POLES, over tasks:create AND missions:create, every caller SCOPED (never the
 * operator org, never a master bearer):
 *   STAMPED (verifiedActor)  client-org agent proven by ID -> row in that org, read back by it
 *   STAMPED (verifiedOrg)    bearer's verified org, no agent ID -> row in that org
 *   OTHER ORG                a reader verified for another org does not see it
 *   REFUSED (unresolved)     client-org agent whose org has no ACTIVE mapping -> RBAC_DENIED write-org-unresolved, nothing written
 *   REFUSED (contradiction)  agent of org A + verifiedOrg of org B -> RBAC_DENIED actor-outside-verified-org, nothing written
 *   FLEET (unchanged)        service account with no proof, or an operator-org agent -> unstamped, as before
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
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

type T = ReturnType<typeof convexTest>;
const createT = (): T =>
	convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;
const asServiceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

async function seed(t: T): Promise<Record<string, Id<"agents">>> {
	return await t.run(async (ctx) => {
		const ids: Record<string, Id<"agents">> = {};
		for (const [slug, name, isActive] of [
			["org-a", "telemaque", true],
			["org-b", "mentor", true],
			["org-off", "ghost", false],
		] as const) {
			const agent = await ctx.db.insert("agents", {
				orgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				name,
				normalizedName: name,
				isActive: true,
				createdAt: Date.now(),
			});
			ids[slug] = agent;
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [name],
				allowedAgentIds: [agent],
				scopes: ["view-own-tasks", "view-own-missions"],
				displayName: slug,
				isActive,
				createdAt: Date.now(),
			});
		}
		return ids;
	});
}

const TASK = {
	title: "t",
	assignedTo: "telemaque",
	priority: "high" as const,
	status: "todo" as const,
	createdBy: "telemaque",
};
const MISSION = {
	name: "m",
	project: "p",
	status: "brainstorm" as const,
	priority: "high" as const,
	pilot: "telemaque",
	agents: ["telemaque"],
	createdBy: "telemaque",
};

const tasksRows = (t: T) => t.run((ctx) => ctx.db.query("tasks").collect());
const missionRows = (t: T) =>
	t.run((ctx) => ctx.db.query("missions").collect());

describe("tasks:create — a service-account write for a verified org", () => {
	test("STAMPED (verifiedActor): a client-org agent's task lands in its org and that org reads it back", async () => {
		const t = createT();
		const ids = await seed(t);
		const taskId = await asServiceAccount(t).mutation(api.tasks.create, {
			...TASK,
			verifiedActor: { agentId: ids["org-a"], orgSlug: "org-a" },
		});
		const [row] = await tasksRows(t);
		expect(row.orgId).toBe("org-a");
		expect(row.clerkOrgId).toBe(testClerkOrgId("org-a"));
		const listed = await asServiceAccount(t).query(api.tasks.list, {
			verifiedOrg: { orgSlug: "org-a" },
		});
		const items = Array.isArray(listed)
			? listed
			: (listed as { items: { _id: string }[] }).items;
		expect(items.map((r: { _id: string }) => r._id)).toContain(taskId);
	});

	test("STAMPED (verifiedOrg): an org-level bearer's task lands in its org", async () => {
		const t = createT();
		await seed(t);
		await asServiceAccount(t).mutation(api.tasks.create, {
			...TASK,
			verifiedOrg: { orgSlug: "org-a" },
		});
		const [row] = await tasksRows(t);
		expect(row.orgId).toBe("org-a");
		expect(row.clerkOrgId).toBe(testClerkOrgId("org-a"));
	});

	test("OTHER ORG: a reader verified for org-b does not see org-a's task", async () => {
		const t = createT();
		const ids = await seed(t);
		const taskId = await asServiceAccount(t).mutation(api.tasks.create, {
			...TASK,
			verifiedActor: { agentId: ids["org-a"], orgSlug: "org-a" },
		});
		const listed = await asServiceAccount(t).query(api.tasks.list, {
			verifiedOrg: { orgSlug: "org-b" },
		});
		const items = Array.isArray(listed)
			? listed
			: (listed as { items: { _id: string }[] }).items;
		expect(items.map((r: { _id: string }) => r._id)).not.toContain(taskId);
	});

	test("REFUSED (unresolved): an agent whose org has no active mapping is refused, nothing written", async () => {
		const t = createT();
		const ids = await seed(t);
		await expect(
			asServiceAccount(t).mutation(api.tasks.create, {
				...TASK,
				assignedTo: "ghost",
				createdBy: "ghost",
				verifiedActor: { agentId: ids["org-off"], orgSlug: "org-off" },
			}),
		).rejects.toThrow(
			/RBAC_DENIED[\s\S]*write-org-unresolved[\s\S]*tasks:create/,
		);
		expect(await tasksRows(t)).toEqual([]);
	});

	test("REFUSED (contradiction): an agent of org-a with a bearer verified for org-b", async () => {
		const t = createT();
		const ids = await seed(t);
		await expect(
			asServiceAccount(t).mutation(api.tasks.create, {
				...TASK,
				verifiedActor: { agentId: ids["org-a"], orgSlug: "org-a" },
				verifiedOrg: { orgSlug: "org-b" },
			}),
		).rejects.toThrow(/RBAC_DENIED[\s\S]*actor-outside-verified-org/);
		expect(await tasksRows(t)).toEqual([]);
	});

	test("FLEET (unchanged): an operator-org agent, or no proof at all, writes a fleet row", async () => {
		const t = createT();
		await seed(t);
		// The first service-account call seeds the operator org (fixture).
		await asServiceAccount(t).query(api.tasks.list, {});
		const sigma = await t.run(async (ctx) => {
			const op = (await ctx.db.query("client_org_mapping").collect()).find(
				(m) => m.orgKind === "operator",
			);
			if (op === undefined) throw new Error("operator org not seeded");
			const id = await ctx.db.insert("agents", {
				orgSlug: op.clerkOrgSlug,
				...(op.clerkOrgId !== undefined ? { clerkOrgId: op.clerkOrgId } : {}),
				name: "sigma",
				normalizedName: "sigma",
				isActive: true,
				createdAt: Date.now(),
			});
			return { id, orgSlug: op.clerkOrgSlug };
		});
		const fleetTask = { ...TASK, assignedTo: "sigma", createdBy: "sigma" };
		await asServiceAccount(t).mutation(api.tasks.create, {
			...fleetTask,
			verifiedActor: { agentId: sigma.id, orgSlug: sigma.orgSlug },
		});
		await asServiceAccount(t).mutation(api.tasks.create, fleetTask);
		// What the NEW MCP sends for an operator-org agent credential: the proven
		// actor AND the bearer's verified org (the operator org). Still a fleet row.
		await asServiceAccount(t).mutation(api.tasks.create, {
			...fleetTask,
			verifiedActor: { agentId: sigma.id, orgSlug: sigma.orgSlug },
			verifiedOrg: { orgSlug: sigma.orgSlug },
		});
		const rows = await tasksRows(t);
		expect(rows).toHaveLength(3);
		for (const row of rows) {
			expect(row.orgId).toBeUndefined();
			expect(row.clerkOrgId).toBeUndefined();
		}
	});
});

describe("missions:create — a service-account write for a verified org", () => {
	test("STAMPED (verifiedActor): the mission lands in the agent's org", async () => {
		const t = createT();
		const ids = await seed(t);
		await asServiceAccount(t).mutation(api.missions.create, {
			...MISSION,
			verifiedActor: { agentId: ids["org-a"], orgSlug: "org-a" },
		});
		const [row] = await missionRows(t);
		expect(row.orgId).toBe("org-a");
		expect(row.clerkOrgId).toBe(testClerkOrgId("org-a"));
	});

	test("STAMPED (verifiedOrg): the mission lands in the bearer's org", async () => {
		const t = createT();
		await seed(t);
		await asServiceAccount(t).mutation(api.missions.create, {
			...MISSION,
			verifiedOrg: { orgSlug: "org-a" },
		});
		const [row] = await missionRows(t);
		expect(row.orgId).toBe("org-a");
	});

	test("FLEET (unchanged): an operator-org agent, with or without the verifiedOrg the new MCP sends, writes a fleet mission", async () => {
		const t = createT();
		await seed(t);
		await asServiceAccount(t).query(api.tasks.list, {});
		const sigma = await t.run(async (ctx) => {
			const op = (await ctx.db.query("client_org_mapping").collect()).find(
				(m) => m.orgKind === "operator",
			);
			if (op === undefined) throw new Error("operator org not seeded");
			const id = await ctx.db.insert("agents", {
				orgSlug: op.clerkOrgSlug,
				...(op.clerkOrgId !== undefined ? { clerkOrgId: op.clerkOrgId } : {}),
				name: "sigma",
				normalizedName: "sigma",
				isActive: true,
				createdAt: Date.now(),
			});
			return { id, orgSlug: op.clerkOrgSlug };
		});
		const fleetMission = {
			...MISSION,
			pilot: "sigma",
			agents: ["sigma"],
			createdBy: "sigma",
		};
		await asServiceAccount(t).mutation(api.missions.create, {
			...fleetMission,
			name: "m-actor",
			verifiedActor: { agentId: sigma.id, orgSlug: sigma.orgSlug },
		});
		await asServiceAccount(t).mutation(api.missions.create, {
			...fleetMission,
			name: "m-actor-and-org",
			verifiedActor: { agentId: sigma.id, orgSlug: sigma.orgSlug },
			verifiedOrg: { orgSlug: sigma.orgSlug },
		});
		const rows = await missionRows(t);
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.orgId).toBeUndefined();
			expect(row.clerkOrgId).toBeUndefined();
		}
	});

	test("REFUSED (unresolved): an agent whose org has no active mapping, nothing written", async () => {
		const t = createT();
		const ids = await seed(t);
		await expect(
			asServiceAccount(t).mutation(api.missions.create, {
				...MISSION,
				pilot: "ghost",
				agents: ["ghost"],
				createdBy: "ghost",
				verifiedActor: { agentId: ids["org-off"], orgSlug: "org-off" },
			}),
		).rejects.toThrow(
			/RBAC_DENIED[\s\S]*write-org-unresolved[\s\S]*missions:create/,
		);
		expect(await missionRows(t)).toEqual([]);
	});

	test("REFUSED (contradiction): agent of org-a, bearer verified for org-b", async () => {
		const t = createT();
		const ids = await seed(t);
		await expect(
			asServiceAccount(t).mutation(api.missions.create, {
				...MISSION,
				verifiedActor: { agentId: ids["org-a"], orgSlug: "org-a" },
				verifiedOrg: { orgSlug: "org-b" },
			}),
		).rejects.toThrow(/RBAC_DENIED[\s\S]*actor-outside-verified-org/);
		expect(await missionRows(t)).toEqual([]);
	});
});

describe("githubRepoMapping:add/remove — a service-account write for a verified org", () => {
	const MAPPING = { repo: "acme/app", orchestrator: "telemaque", project: "p" };
	const mappingRows = (t: T) =>
		t.run((ctx) => ctx.db.query("githubRepoMapping").collect());

	test("REFUSED as a member: a bearer verified for org-a is judged by org-a's scope, never written as a fleet row", async () => {
		const t = createT();
		await seed(t);
		await expect(
			asServiceAccount(t).mutation(api.githubRepoMapping.add, {
				...MAPPING,
				verifiedOrg: { orgSlug: "org-a" },
			}),
		).rejects.toThrow(/RBAC_DENIED[\s\S]*manage-repo-mappings/);
		expect(await mappingRows(t)).toEqual([]);
	});

	test("FLEET (unchanged): the service account with no verifiedOrg writes a fleet row", async () => {
		const t = createT();
		await seed(t);
		await asServiceAccount(t).mutation(api.githubRepoMapping.add, MAPPING);
		const [row] = await mappingRows(t);
		expect(row.orgId).toBeUndefined();
		const removed = await asServiceAccount(t)
			.mutation(api.githubRepoMapping.remove, {
				repo: MAPPING.repo,
				verifiedOrg: { orgSlug: "org-a" },
			})
			.catch((e: unknown) => e);
		// A bearer verified for org-a may not remove the fleet's mapping.
		expect(String(removed)).toMatch(/RBAC_DENIED/);
		expect(await mappingRows(t)).toHaveLength(1);
	});
});
