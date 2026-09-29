/// <reference types="vite/client" />
/**
 * THE MULTI-TENANT ISOLATION POLE — two organisations whose
 * `client_org_mapping.allowedOrchestrators` rosters share the SAME
 * orchestrator name.
 *
 * DEFECT (pre-fix): `convex/lib/auth.ts`'s `isRowVisibleToScope` has a leg
 * that hard-denies a row whose stated `orgId` differs from the caller's. That
 * leg was INERT for every task the product creates, because `insertTask`
 * stamped no `orgId` at all. What carried those rows instead was the roster
 * leg — `filterByOrgScope`, i.e. `allowedOrchestrators.includes(pilot ??
 * assignedTo)`. That is a STRING MEMBERSHIP, not a tenant boundary: two
 * organisations that both employ an orchestrator named "eta" reach each
 * other's rows, through `get` exactly as through `list`.
 *
 * Both poles are exercised under an ORDINARY org-scoped identity — never
 * master, never the service account — because a proof conducted under the
 * bypass exercises the bypass and not the control.
 *
 * BOTH DIRECTIONS, per site:
 *   LEAK      — org B must NOT read org A's row (the isolation pole).
 *   WITHHELD  — org A MUST still read its own row (the regression pole; the
 *               failure mode of stamping is a legitimate caller losing access
 *               to rows it created).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

/**
 * The shared orchestrator NAME that both rosters carry. This single constant
 * is the whole point of the suite: it is what makes the roster check pass for
 * both organisations, so only a real tenant stamp can separate them.
 */
const SHARED_ORCHESTRATOR = "eta";

async function seedBothOrgsSharingOrchestrator(t: ReturnType<typeof createT>) {
	await t.run(async (ctx) => {
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: [SHARED_ORCHESTRATOR],
				scopes: ["view-own-tasks", "view-own-missions"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
}

function asOrg(t: ReturnType<typeof createT>, slug: string) {
	return t.withIdentity({
		subject: `user-${slug}`,
		organizationId: slug,
	} as Parameters<typeof t.withIdentity>[0]);
}

describe("cross-org isolation when two rosters share an orchestrator name", () => {
	describe("tasks.create -> tasks.get", () => {
		test("LEAK POLE: org B cannot read a task org A created", async () => {
			const t = createT();
			await seedBothOrgsSharingOrchestrator(t);

			const taskId = await asOrg(t, "org-a").mutation(api.tasks.create, {
				title: "org-a private task",
				assignedTo: SHARED_ORCHESTRATOR,
				priority: "high",
				status: "todo",
				createdBy: SHARED_ORCHESTRATOR,
			});

			const seenByB = await asOrg(t, "org-b").query(api.tasks.get, { taskId });
			expect(seenByB).toBeNull();
		});

		test("WITHHELD-GRANT POLE: org A still reads the task it created", async () => {
			const t = createT();
			await seedBothOrgsSharingOrchestrator(t);

			const taskId = await asOrg(t, "org-a").mutation(api.tasks.create, {
				title: "org-a private task",
				assignedTo: SHARED_ORCHESTRATOR,
				priority: "high",
				status: "todo",
				createdBy: SHARED_ORCHESTRATOR,
			});

			const seenByA = await asOrg(t, "org-a").query(api.tasks.get, { taskId });
			expect(seenByA).not.toBeNull();
			expect(seenByA?.title).toBe("org-a private task");
		});

		test("the created row carries org A's slug as its stated orgId", async () => {
			const t = createT();
			await seedBothOrgsSharingOrchestrator(t);

			const taskId = await asOrg(t, "org-a").mutation(api.tasks.create, {
				title: "org-a private task",
				assignedTo: SHARED_ORCHESTRATOR,
				priority: "high",
				status: "todo",
				createdBy: SHARED_ORCHESTRATOR,
			});

			const stored = await t.run(async (ctx) => ctx.db.get(taskId));
			expect(stored?.orgId).toBe("org-a");
		});
	});

	describe("tasks.getById (the same row through the string-id surface)", () => {
		test("LEAK POLE: org B cannot read org A's task by id string", async () => {
			const t = createT();
			await seedBothOrgsSharingOrchestrator(t);

			const taskId = await asOrg(t, "org-a").mutation(api.tasks.create, {
				title: "org-a private task",
				assignedTo: SHARED_ORCHESTRATOR,
				priority: "high",
				status: "todo",
				createdBy: SHARED_ORCHESTRATOR,
			});

			const seenByB = await asOrg(t, "org-b").query(api.tasks.getById, {
				taskId,
			});
			expect(seenByB).toBeNull();
		});

		test("WITHHELD-GRANT POLE: org A still reads its own task by id string", async () => {
			const t = createT();
			await seedBothOrgsSharingOrchestrator(t);

			const taskId = await asOrg(t, "org-a").mutation(api.tasks.create, {
				title: "org-a private task",
				assignedTo: SHARED_ORCHESTRATOR,
				priority: "high",
				status: "todo",
				createdBy: SHARED_ORCHESTRATOR,
			});

			const seenByA = await asOrg(t, "org-a").query(api.tasks.getById, {
				taskId,
			});
			expect(seenByA).not.toBeNull();
		});
	});

	describe("missions.create -> missions.get (stamped already; pinned here)", () => {
		test("LEAK POLE: org B cannot read a mission org A created", async () => {
			const t = createT();
			await seedBothOrgsSharingOrchestrator(t);

			const missionId = await asOrg(t, "org-a").mutation(api.missions.create, {
				name: "org-a private mission",
				project: "p",
				status: "execute",
				priority: "high",
				pilot: SHARED_ORCHESTRATOR,
				agents: [SHARED_ORCHESTRATOR],
				createdBy: SHARED_ORCHESTRATOR,
			});

			const seenByB = await asOrg(t, "org-b").query(api.missions.get, {
				missionId,
			});
			expect(seenByB).toBeNull();
		});

		test("WITHHELD-GRANT POLE: org A still reads its own mission", async () => {
			const t = createT();
			await seedBothOrgsSharingOrchestrator(t);

			const missionId = await asOrg(t, "org-a").mutation(api.missions.create, {
				name: "org-a private mission",
				project: "p",
				status: "execute",
				priority: "high",
				pilot: SHARED_ORCHESTRATOR,
				agents: [SHARED_ORCHESTRATOR],
				createdBy: SHARED_ORCHESTRATOR,
			});

			const seenByA = await asOrg(t, "org-a").query(api.missions.get, {
				missionId,
			});
			expect(seenByA).not.toBeNull();
		});
	});

	describe("absence of orgId must STOP MEANING MASTER", () => {
		test("an UNSTAMPED legacy row is not readable by an org caller whose roster names its orchestrator", async () => {
			const t = createT();
			await seedBothOrgsSharingOrchestrator(t);

			// A legacy row, written directly, carrying NO orgId — exactly the
			// shape every task in production carries today.
			const legacyId = await t.run(async (ctx) =>
				ctx.db.insert("tasks", {
					title: "legacy unstamped row",
					assignedTo: SHARED_ORCHESTRATOR,
					priority: "high",
					status: "todo",
					createdBy: SHARED_ORCHESTRATOR,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				}),
			);

			const seenByA = await asOrg(t, "org-a").query(api.tasks.get, {
				taskId: legacyId,
			});
			expect(seenByA).toBeNull();
		});
	});
});


// ─────────────────────────────────────────────────────────────────────────────
// THE COLLECTION READ. `tasks.get` and `tasks.list` must agree about who owns
// what. Inverting only the by-id read left the product HALF-INVERTED: `get`
// refusing a row that `list` still served to the same caller — the leak intact
// on the surface that returns rows in bulk. These poles hold `filterByOrgScope`
// to the same tenant gate as `isRowVisibleToScope`.
// ─────────────────────────────────────────────────────────────────────────────

describe("collection reads carry the SAME tenant boundary as by-id reads", () => {
	const makeTask = (t: ReturnType<typeof createT>, slug: string) =>
		asOrg(t, slug).mutation(api.tasks.create, {
			title: "org-a private task",
			assignedTo: SHARED_ORCHESTRATOR,
			priority: "high" as const,
			status: "todo" as const,
			createdBy: SHARED_ORCHESTRATOR,
		});

	const listedIds = async (t: ReturnType<typeof createT>, slug: string) =>
		((await asOrg(t, slug).query(api.tasks.list, {})) as Array<{ _id: string }>)
			.map((r) => r._id);

	test("LEAK POLE: org B's list does not contain org A's task", async () => {
		const t = createT();
		await seedBothOrgsSharingOrchestrator(t);
		const taskId = await makeTask(t, "org-a");

		expect(await listedIds(t, "org-b")).not.toContain(taskId);
	});

	test("WITHHELD-GRANT POLE: org A's list still contains its own task", async () => {
		const t = createT();
		await seedBothOrgsSharingOrchestrator(t);
		const taskId = await makeTask(t, "org-a");

		expect(await listedIds(t, "org-a")).toContain(taskId);
	});

	test("get and list AGREE for both orgs — neither surface is more permissive", async () => {
		const t = createT();
		await seedBothOrgsSharingOrchestrator(t);
		const taskId = await makeTask(t, "org-a");

		for (const [slug, expected] of [
			["org-a", true],
			["org-b", false],
		] as const) {
			const viaGet =
				(await asOrg(t, slug).query(api.tasks.get, { taskId })) !== null;
			const viaList = (await listedIds(t, slug)).includes(taskId);
			expect(viaGet).toBe(expected);
			expect(viaList).toBe(expected);
		}
	});
});
