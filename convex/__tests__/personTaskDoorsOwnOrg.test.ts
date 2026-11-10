/// <reference types="vite/client" />
/**
 * VantagePeers Cloud, task k1726h1v7hqdbk818bn8s1rgdx8hy0ts.
 *
 * Defect (measured on prod): a PERSON connection of a client org whose consent
 * chose an org agent ("Ada") created a task that the same caller then could not
 * read or act on: get_task "Task not found", every write door RBAC_DENIED
 * "outside the caller's organisation (tenant boundary)", list_tasks [].
 *
 * Cause shape: the MCP lowercases `assignedTo` (normalizeOrchestratorId) before
 * tasks:create, so the row stores "bram"; the client org's roster holds the EXACT
 * stored agent names ("Ada", "Bram", written by the consent create path). The
 * tenant gate then compared the two by exact string (filterByOrgScope), which
 * never matches a mixed-case agent name.
 *
 * The caller is built the way the MCP builds it: the fleet service account acting
 * for the org (`__actingOrg`) with the door proofs the MCP forwards.
 *
 * Poles: OWN (served on every door) / FOREIGN (another org's person refused,
 * row unchanged) / ABSENT (an org-mate name not on the roster is still refused).
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

const SERVICE = "test-service-account-user-id";
const A = "vp-directory-review";
const B = "other-client-org";
const A_ID = testClerkOrgId(A);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

async function seed(t: T): Promise<Record<string, Id<"agents">>> {
	return await t.run(async (ctx) => {
		const byName: Record<string, Id<"agents">> = {};
		const now = Date.now();
		for (const [slug, names] of [
			[A, ["Ada", "Bram"]],
			[B, ["Cleo", "Dov"]],
		] as const) {
			const ids: Id<"agents">[] = [];
			for (const name of names) {
				const agentId = await ctx.db.insert("agents", {
					orgSlug: slug,
					clerkOrgId: testClerkOrgId(slug),
					name,
					normalizedName: name.toLowerCase(),
					isActive: true,
					createdAt: now,
				});
				ids.push(agentId);
				byName[name] = agentId;
			}
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [...names],
				allowedAgentIds: ids,
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				orgKind: "client",
				createdAt: now,
			});
		}
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: now,
		});
		await ctx.db.insert("taskClosureConfig", {
			key: "billableProjects",
			value: [],
			updatedAt: now,
		});
		return byName;
	});
}

// What the MCP sends for a person acting as its consent agent of `slug`.
const as = (t: T, slug: string, actor: Id<"agents">) => {
	const orgId = testClerkOrgId(slug);
	const base = { __actingOrg: orgId };
	const org = { verifiedOrg: { orgSlug: slug, orgId } };
	// The consent agent the person acts as: its ID rides every actor-taking door.
	const proof = { verifiedActor: { agentId: actor, orgSlug: slug } };
	const svc = t.withIdentity({ subject: SERVICE });
	return {
		create: (name: string, assignee: string) =>
			svc.mutation(api.tasks.create, {
				title: "person task",
				project: "vp",
				assignedTo: assignee.toLowerCase(),
				priority: "medium",
				status: "todo",
				createdBy: name.toLowerCase(),
				...org,
				...proof,
				...base,
			} as never),
		getById: (taskId: Id<"tasks">) =>
			svc.query(api.tasks.getById, { taskId, ...base } as never),
		get: (taskId: Id<"tasks">) =>
			svc.query(api.tasks.get, { taskId, ...base } as never),
		list: () => svc.query(api.tasks.list, { ...org, ...base } as never),
		start: (taskId: Id<"tasks">, name: string) =>
			svc.mutation(api.tasks.start, {
				taskId,
				callerOrchestrator: name,
				...org,
				...proof,
				...base,
			} as never),
		complete: (taskId: Id<"tasks">, name: string) =>
			svc.mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: name,
				completionNote: "closed by the person agent, 1 row",
				...org,
				...proof,
				...base,
			} as never),
	};
};

async function code(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "SERVED";
	} catch (e) {
		const d = (e as { data?: unknown }).data;
		const text = typeof d === "string" ? d : String(e);
		const m = /([A-Z][A-Z_]{3,}):/.exec(text);
		return m ? m[1] : `OTHER(${text.slice(0, 120)})`;
	}
}

describe("person of a client org with a mixed-case consent agent, on its OWN task", () => {
	const fresh = async () => {
		const t = createT();
		const ag = await seed(t);
		const a = as(t, A, ag.Ada);
		const id = (await a.create("Ada", "Bram")) as Id<"tasks">;
		return { t, a, id };
	};
	test("OWN getById (get_task) serves the row create wrote", async () => {
		const { a, id } = await fresh();
		expect(await a.getById(id)).not.toBeNull();
	});
	test("OWN get serves the row create wrote", async () => {
		const { a, id } = await fresh();
		expect(await a.get(id)).not.toBeNull();
	});
	test("OWN list (list_tasks) contains the row create wrote", async () => {
		const { a, id } = await fresh();
		const listed = (await a.list()) as unknown as Array<{ _id: Id<"tasks"> }>;
		expect(listed.map((r) => r._id)).toContain(id);
	});
	test("OWN start serves", async () => {
		const { a, id } = await fresh();
		expect(await code(a.start(id, "Ada"))).toBe("SERVED");
	});
	test("OWN complete serves and the row is done", async () => {
		const { t, a, id } = await fresh();
		expect(await code(a.complete(id, "Ada"))).toBe("SERVED");
		expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("done");
	});
});

describe("FOREIGN: another org's person cannot reach it", () => {
	test("org B person: get null, list empty, start/complete RBAC_DENIED, row unchanged", async () => {
		const t = createT();
		const ag = await seed(t);
		const id = (await as(t, A, ag.Ada).create("Ada", "Bram")) as Id<"tasks">;
		const before = JSON.stringify(await t.run((ctx) => ctx.db.get(id)));
		const b = as(t, B, ag.Cleo);
		expect(await b.getById(id)).toBeNull();
		expect(await b.get(id)).toBeNull();
		expect(await b.list()).toEqual([]);
		expect(await code(b.start(id, "Cleo"))).toBe("RBAC_DENIED");
		expect(await code(b.complete(id, "Cleo"))).toBe("RBAC_DENIED");
		expect(JSON.stringify(await t.run((ctx) => ctx.db.get(id)))).toBe(before);
	});
});

describe("ABSENT: the roster still narrows inside the org", () => {
	test("a row assigned to a name NOT on the org's roster stays unreadable to the org", async () => {
		const t = createT();
		const ag = await seed(t);
		const id = await t.run(async (ctx) =>
			ctx.db.insert("tasks", {
				title: "off-roster",
				assignedTo: "mallory",
				createdBy: "mallory",
				priority: "low",
				status: "todo",
				orgId: A,
				clerkOrgId: A_ID,
				createdAt: 1,
				updatedAt: 1,
			}),
		);
		const a = as(t, A, ag.Ada);
		expect(await a.getById(id)).toBeNull();
		expect(await a.get(id)).toBeNull();
		const listed = (await a.list()) as unknown as Array<{ _id: Id<"tasks"> }>;
		expect(listed.map((r) => r._id)).not.toContain(id);
	});
});
