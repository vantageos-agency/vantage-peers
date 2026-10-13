/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// tasksBatchBIdentityById.test.ts — identity-by-ID plan, BATCH B (tasks,
// recurring tasks, review routing, task actors).
//
// Every pole below is RED at 2bcb966 and GREEN with this change:
//
//   BY ID, NOT BY NAME
//     - a `createdBy` filter selects the agent's ID, not its label (list,
//       listByMission)
//     - the roster a member's acting agent must be on is the org's agent-ID
//       roster (`allowedAgentIds`), not the name list
//     - the review-reassign grant and the automation-cancel grant name the
//       OPERATOR-org agent the configured label resolves to, so a same-named
//       agent of a client org gets nothing
//     - the bulk-complete assignee filter resolves the label in ONE org
//     - a schedule is recorded under the label its agent row carries, and cannot
//       be assigned to a typed person name
//     - searchTasksByKeyword filters on the assignee's ID (a renamed agent is
//       still found by its new label)
//
//   NARROWED BEFORE BOUNDED (R-55)
//     - tasks:list, tasks:listPaginated, tasks:listOverdue and
//       recurringTasks:list return a FULL page when matching rows exist beyond
//       the first window, instead of a short page cut down afterwards
// ─────────────────────────────────────────────────────────────────────────────

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { findAgentId } from "../../tests/lib/agentIdOf";
import {
	actingWith,
	insertTaskRow,
	mintAgentSecret,
	seedFleetAgents,
} from "../../tests/lib/seedFleetAgents";
import { seedRosterAgents } from "../../tests/lib/seedRosterAgents";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("backfill") &&
			!path.includes("internal"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const CLIENT = "client-batch-b";
const svc = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });
const member = (t: T, org: string, role = "org:editor") =>
	t.withIdentity({
		subject: `${org}-member`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: role,
	} as Identity);

async function addClientOrg(
	t: T,
	roster: string[],
	slug = CLIENT,
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			displayName: slug,
			orgKind: "client",
			allowedOrchestrators: roster,
			scopes: ["view-own-tasks", "view-own-missions"],
			isActive: true,
			createdAt: 1,
		});
		for (const name of roster) {
			await ctx.db.insert("agents", {
				orgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				name,
				normalizedName: name.toLowerCase(),
				isActive: true,
				createdAt: 1,
			});
		}
	});
}

async function fleetSlug(t: T): Promise<string> {
	return await t.run(async (ctx) => {
		const op = (await ctx.db.query("client_org_mapping").collect()).find(
			(m) => m.orgKind === "operator" && m.isActive,
		);
		return op?.clerkOrgSlug ?? "fleet-operator";
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// createdBy — selected by the agent's ID
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks:list / tasks:listByMission — `createdBy` selects an agent ID, never a label", () => {
	async function setup() {
		const t = createT();
		await seedFleetAgents(t, ["sigma", "pi"]);
		await addClientOrg(t, ["sigma", "victor"]);
		await seedRosterAgents(t);
		const fleet = await fleetSlug(t);
		await t.run(async (ctx) => {
			const missionId = await ctx.db.insert("missions", {
				name: "m",
				description: "m",
				project: "batch-b",
				status: "execute",
				priority: "medium",
				pilot: "pi",
				agents: [],
				createdBy: "pi",
				createdAt: 1,
				updatedAt: 1,
			});
			await insertTaskRow(ctx, {
				title: "fleet-by-sigma",
				createdBy: "sigma",
				assignedTo: "pi",
				priority: "medium",
				status: "todo",
				missionId,
				createdAt: 1,
				updatedAt: 1,
			});
			await insertTaskRow(ctx, {
				title: "client-by-sigma",
				orgId: CLIENT,
				clerkOrgId: testClerkOrgId(CLIENT),
				createdBy: "sigma",
				assignedTo: "victor",
				priority: "medium",
				status: "todo",
				missionId,
				createdAt: 2,
				updatedAt: 2,
			});
		});
		return { t, fleet };
	}

	test("the fleet master listing `createdBy: sigma` is served the OPERATOR org's sigma, not the client org's same-named agent", async () => {
		const { t } = await setup();
		const rows = (await svc(t).query(api.tasks.list, {
			createdBy: "sigma",
			fields: "full",
		})) as Array<{ title: string }>;
		expect(rows.map((r) => r.title)).toEqual(["fleet-by-sigma"]);
	});

	test("a renamed agent is found by its NEW label, and its old label selects nothing", async () => {
		const { t, fleet } = await setup();
		await t.run(async (ctx) => {
			const sigma = await ctx.db
				.query("agents")
				.withIndex("by_org", (q) => q.eq("orgSlug", fleet))
				.collect();
			const row = sigma.find((a) => a.name === "sigma");
			await ctx.db.patch(row!._id, { name: "sigma-two", normalizedName: "sigma-two" });
		});
		const byNew = (await svc(t).query(api.tasks.list, {
			createdBy: "sigma-two",
			fields: "full",
		})) as Array<{ title: string }>;
		expect(byNew.map((r) => r.title)).toEqual(["fleet-by-sigma"]);
		const byOld = (await svc(t).query(api.tasks.list, {
			createdBy: "sigma",
			fields: "full",
		})) as unknown[];
		expect(byOld).toEqual([]);
	});

	test("a label that names no agent selects nothing (an absence, not an error)", async () => {
		const { t } = await setup();
		const rows = (await svc(t).query(api.tasks.list, {
			createdBy: "nobody-at-all",
			fields: "full",
		})) as unknown[];
		expect(rows).toEqual([]);
	});

	test("an org member is served its own org's rows for its own agent label (PRESENT pole)", async () => {
		const { t } = await setup();
		const rows = (await member(t, CLIENT).query(api.tasks.list, {
			createdBy: "sigma",
			fields: "full",
		})) as Array<{ title: string }>;
		expect(rows.map((r) => r.title)).toEqual(["client-by-sigma"]);
	});

	test("listByMission: the master's `createdBy: sigma` is the operator org's sigma only", async () => {
		const { t } = await setup();
		const missionId = await t.run(async (ctx) => {
			const m = await ctx.db.query("missions").first();
			return m!._id;
		});
		const rows = (await svc(t).query(api.tasks.listByMission, {
			missionId,
			createdBy: "sigma",
			fields: "full",
		})) as Array<{ title: string }>;
		expect(rows.map((r) => r.title)).toEqual(["fleet-by-sigma"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// R-55 — a page is `limit` rows the caller may see, never a short page
// ─────────────────────────────────────────────────────────────────────────────

describe("R-55 — narrowed before bounded: full pages", () => {
	test("tasks:list { priority, limit } returns `limit` matching rows although newer rows do not match", async () => {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		await t.run(async (ctx) => {
			for (let i = 0; i < 3; i++) {
				await insertTaskRow(ctx, {
					title: `high-${i}`,
					createdBy: "sigma",
					assignedTo: "sigma",
					priority: "high",
					status: "todo",
					createdAt: i,
					updatedAt: i,
				});
			}
			for (let i = 0; i < 12; i++) {
				await insertTaskRow(ctx, {
					title: `low-${i}`,
					createdBy: "sigma",
					assignedTo: "sigma",
					priority: "low",
					status: "todo",
					createdAt: 100 + i,
					updatedAt: 100 + i,
				});
			}
		});
		const rows = (await svc(t).query(api.tasks.list, {
			priority: "high",
			limit: 3,
			fields: "full",
		})) as Array<{ title: string }>;
		expect(rows.map((r) => r.title).sort()).toEqual(["high-0", "high-1", "high-2"]);
	});

	test("tasks:list { excludeAutoGenerated, limit } is not emptied by newer cron rows", async () => {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		await t.run(async (ctx) => {
			for (let i = 0; i < 2; i++) {
				await insertTaskRow(ctx, {
					title: `real-${i}`,
					createdBy: "sigma",
					assignedTo: "sigma",
					priority: "medium",
					status: "todo",
					createdAt: i,
					updatedAt: i,
				});
			}
			for (let i = 0; i < 6; i++) {
				await insertTaskRow(ctx, {
					title: `cron-${i}`,
					createdBy: "cron-pulse",
					assignedTo: "sigma",
					priority: "medium",
					status: "todo",
					createdAt: 100 + i,
					updatedAt: 100 + i,
				});
			}
		});
		const rows = (await svc(t).query(api.tasks.list, {
			excludeAutoGenerated: true,
			limit: 2,
			fields: "full",
		})) as Array<{ title: string }>;
		expect(rows.map((r) => r.title).sort()).toEqual(["real-0", "real-1"]);
	});

	test("tasks:listPaginated { priority } gives a member a full page", async () => {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		await addClientOrg(t, ["victor"]);
		await seedRosterAgents(t);
		await t.run(async (ctx) => {
			for (let i = 0; i < 2; i++) {
				await insertTaskRow(ctx, {
					title: `high-${i}`,
					orgId: CLIENT,
					clerkOrgId: testClerkOrgId(CLIENT),
					createdBy: "victor",
					assignedTo: "victor",
					priority: "high",
					status: "todo",
					createdAt: i,
					updatedAt: i,
				});
			}
			for (let i = 0; i < 6; i++) {
				await insertTaskRow(ctx, {
					title: `low-${i}`,
					orgId: CLIENT,
					clerkOrgId: testClerkOrgId(CLIENT),
					createdBy: "victor",
					assignedTo: "victor",
					priority: "low",
					status: "todo",
					createdAt: 100 + i,
					updatedAt: 100 + i,
				});
			}
		});
		const res = (await member(t, CLIENT).query(api.tasks.listPaginated, {
			priority: "high",
			paginationOpts: { numItems: 2, cursor: null },
		})) as { page: Array<{ title: string }> };
		expect(res.page.map((r) => r.title).sort()).toEqual(["high-0", "high-1"]);
	});

	test("tasks:listOverdue: rows the roster drops do not shrink a member's page", async () => {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		// "outsider" is an agent of the org that is NOT on its roster.
		await addClientOrg(t, ["victor"]);
		await t.run(async (ctx) => {
			await ctx.db.insert("agents", {
				orgSlug: CLIENT,
				clerkOrgId: testClerkOrgId(CLIENT),
				name: "outsider",
				normalizedName: "outsider",
				isActive: true,
				createdAt: 1,
			});
		});
		await seedRosterAgents(t);
		await t.run(async (ctx) => {
			// oldest first: the first rows a bounded read meets are the outsider's.
			for (let i = 0; i < 3; i++) {
				await insertTaskRow(ctx, {
					title: `outsider-${i}`,
					orgId: CLIENT,
					clerkOrgId: testClerkOrgId(CLIENT),
					createdBy: "outsider",
					assignedTo: "outsider",
					priority: "medium",
					status: "todo",
					dueDate: 1,
					createdAt: i,
					updatedAt: i,
				});
			}
			for (let i = 0; i < 2; i++) {
				await insertTaskRow(ctx, {
					title: `victor-${i}`,
					orgId: CLIENT,
					clerkOrgId: testClerkOrgId(CLIENT),
					createdBy: "victor",
					assignedTo: "victor",
					priority: "medium",
					status: "todo",
					dueDate: 1,
					createdAt: 100 + i,
					updatedAt: 100 + i,
				});
			}
		});
		const rows = (await member(t, CLIENT).query(api.tasks.listOverdue, {
			limit: 2,
		})) as Array<{ title: string }>;
		expect(rows.map((r) => r.title).sort()).toEqual(["victor-0", "victor-1"]);
	});

	test("recurringTasks:list { active, assignedTo, limit } is not emptied by newer inactive schedules", async () => {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		await addClientOrg(t, ["victor"]);
		await seedRosterAgents(t);
		const victorId = (await findAgentId(t, CLIENT, "victor"))!;
		await t.run(async (ctx) => {
			const base = {
				description: "d",
				assignedTo: "victor",
				assignedToId: victorId,
				priority: "medium" as const,
				cronExpression: "0 9 * * *",
				nextRunAt: 1,
				createdBy: "victor",
				createdById: victorId,
				orgId: CLIENT,
				clerkOrgId: testClerkOrgId(CLIENT),
				createdAt: 1,
				updatedAt: 1,
			};
			for (let i = 0; i < 2; i++) {
				await ctx.db.insert("recurringTasks", {
					...base,
					title: `active-${i}`,
					active: true,
				});
			}
			for (let i = 0; i < 6; i++) {
				await ctx.db.insert("recurringTasks", {
					...base,
					title: `inactive-${i}`,
					active: false,
				});
			}
		});
		const rows = (await member(t, CLIENT).query(api.recurringTasks.list, {
			assignedTo: "victor",
			active: true,
			limit: 2,
		})) as Array<{ title: string }>;
		expect(rows.map((r) => r.title).sort()).toEqual(["active-0", "active-1"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// the roster an acting agent must be on is the org's agent-ID roster
// ─────────────────────────────────────────────────────────────────────────────

describe("requireAuthenticatedCaller — a member's acting agent is held to the agent-ID roster", () => {
	async function setup(opts: { nameRoster: string[]; idRoster: boolean }) {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		await addClientOrg(t, opts.nameRoster);
		if (opts.idRoster) await seedRosterAgents(t);
		const secret = await mintAgentSecret(t, CLIENT, "victor");
		if (!opts.idRoster) {
			// the agent exists and carries a credential, but the org stores no ID
			// roster: it lists nobody by ID.
			await t.run(async (ctx) => {
				const m = (await ctx.db.query("client_org_mapping").collect()).find(
					(x) => x.clerkOrgSlug === CLIENT,
				);
				await ctx.db.patch(m!._id, { allowedAgentIds: [] });
			});
		}
		return { t, acting: actingWith(member(t, CLIENT), secret) };
	}

	test("a name on the name roster but not listed by ID is REFUSED (CALLER_IDENTITY_MISMATCH)", async () => {
		const { acting } = await setup({ nameRoster: ["victor"], idRoster: false });
		const err = await acting
			.mutation(api.tasks.create, {
				title: "t",
				assignedTo: "victor",
				priority: "medium",
				status: "todo",
				createdBy: "victor",
			})
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConvexError);
		expect((err as ConvexError<string>).message).toContain("CALLER_IDENTITY_MISMATCH");
	});

	test("an agent listed by ID acts although the name list is empty (PRESENT pole)", async () => {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		await addClientOrg(t, ["victor"]);
		await seedRosterAgents(t);
		const secret = await mintAgentSecret(t, CLIENT, "victor");
		// the legacy NAME roster no longer admits anyone; the ID roster still lists victor.
		await t.run(async (ctx) => {
			const m = (await ctx.db.query("client_org_mapping").collect()).find(
				(x) => x.clerkOrgSlug === CLIENT,
			);
			await ctx.db.patch(m!._id, { allowedOrchestrators: [] });
		});
		const acting = actingWith(member(t, CLIENT), secret);
		const id = await acting.mutation(api.tasks.create, {
			title: "t",
			assignedTo: "victor",
			priority: "medium",
			status: "todo",
			createdBy: "victor",
		} as never);
		expect(id).toBeDefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// review routing grants name the operator-org agent the label resolves to
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks:update — review-reassign and automation-cancel grants are decided by ID", () => {
	const REPO = "vantageos-agency/batch-b-repo";

	async function setup() {
		const t = createT();
		await seedFleetAgents(t, ["pi", "argus", "eta"]);
		await addClientOrg(t, ["pi"]);
		await seedRosterAgents(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("githubRepoMapping", {
				repo: REPO,
				orchestrator: "sigma-owner",
				project: "batch-b-repo",
				active: true,
			});
			await ctx.db.insert("taskClosureConfig", {
				key: "reviewCoordinators",
				value: ["pi"],
				updatedAt: Date.now(),
			});
			await ctx.db.insert("taskClosureConfig", {
				key: "automationTaskCancellers",
				value: ["pi"],
				updatedAt: Date.now(),
			});
		});
		const taskId = (await t.mutation(internal.tasks.createOrUpdateReviewTask, {
			repoFullName: REPO,
			prNumber: 9,
			prTitle: "change",
			assignedTo: "argus",
			priority: "high",
			createdBy: "system",
		}))!;
		const clientPi = (await findAgentId(t, CLIENT, "pi"))!;
		const fleetPi = (await findAgentId(t, await fleetSlug(t), "pi"))!;
		return { t, taskId, clientPi, fleetPi };
	}

	test("the OPERATOR-org coordinator may reassign the system review task", async () => {
		const { t, taskId, fleetPi } = await setup();
		const fleet = await fleetSlug(t);
		await svc(t).mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "pi",
			assignedTo: "eta",
			verifiedActor: { agentId: fleetPi, orgSlug: fleet },
		});
		const row = await t.run(async (ctx) => await ctx.db.get(taskId));
		expect(row?.assignedTo).toBe("eta");
	});

	test("a CLIENT-org agent labelled like the coordinator may NOT reassign it", async () => {
		const { t, taskId, clientPi } = await setup();
		const err = await svc(t)
			.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "pi",
				assignedTo: "eta",
				verifiedActor: { agentId: clientPi, orgSlug: CLIENT },
			})
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConvexError);
		const row = await t.run(async (ctx) => await ctx.db.get(taskId));
		expect(row?.assignedTo).toBe("argus");
	});

	test("a CLIENT-org agent labelled like a configured canceller may NOT cancel an automation task", async () => {
		const { t, taskId, clientPi } = await setup();
		const err = await svc(t)
			.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "pi",
				status: "cancelled",
				cancelReason: "not mine to cancel",
				verifiedActor: { agentId: clientPi, orgSlug: CLIENT },
			})
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConvexError);
		const row = await t.run(async (ctx) => await ctx.db.get(taskId));
		expect(row?.status).not.toBe("cancelled");
	});

	test("the OPERATOR-org canceller may cancel it", async () => {
		const { t, taskId, fleetPi } = await setup();
		const fleet = await fleetSlug(t);
		await svc(t).mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "pi",
			status: "cancelled",
			cancelReason: "superseded by a newer push",
			verifiedActor: { agentId: fleetPi, orgSlug: fleet },
		});
		const row = await t.run(async (ctx) => await ctx.db.get(taskId));
		expect(row?.status).toBe("cancelled");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// bulkComplete — the assignee filter resolves the label in ONE org
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks:bulkComplete — `assignedTo` is resolved to one agent ID", () => {
	test("the fleet master's preview matches the operator org's sigma, not the client org's same-named agent", async () => {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		await addClientOrg(t, ["sigma"]);
		await seedRosterAgents(t);
		await t.run(async (ctx) => {
			for (let i = 0; i < 2; i++) {
				await insertTaskRow(ctx, {
					title: `fleet-${i}`,
					createdBy: "sigma",
					assignedTo: "sigma",
					priority: "medium",
					status: "todo",
					createdAt: i,
					updatedAt: i,
				});
			}
			for (let i = 0; i < 3; i++) {
				await insertTaskRow(ctx, {
					title: `client-${i}`,
					orgId: CLIENT,
					clerkOrgId: testClerkOrgId(CLIENT),
					createdBy: "sigma",
					assignedTo: "sigma",
					priority: "medium",
					status: "todo",
					createdAt: 10 + i,
					updatedAt: 10 + i,
				});
			}
		});
		const preview = await svc(t).mutation(api.tasks.bulkComplete, {
			filter: { assignedTo: "sigma", status: "todo" },
			dryRun: true,
		});
		expect(preview.count).toBe(2);
	});

	test("an org member's live bulk close reaches only rows whose assignee is on the org's agent-ID roster", async () => {
		const t = createT();
		await seedFleetAgents(t, ["sigma"]);
		await addClientOrg(t, ["victor"]);
		await seedRosterAgents(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("agents", {
				orgSlug: CLIENT,
				clerkOrgId: testClerkOrgId(CLIENT),
				name: "outsider",
				normalizedName: "outsider",
				isActive: true,
				createdAt: 1,
			});
			await insertTaskRow(ctx, {
				title: "victors",
				orgId: CLIENT,
				clerkOrgId: testClerkOrgId(CLIENT),
				createdBy: "victor",
				assignedTo: "victor",
				priority: "medium",
				status: "todo",
				createdAt: 1,
				updatedAt: 1,
			});
			await insertTaskRow(ctx, {
				title: "outsiders",
				orgId: CLIENT,
				clerkOrgId: testClerkOrgId(CLIENT),
				createdBy: "outsider",
				assignedTo: "outsider",
				priority: "medium",
				status: "todo",
				createdAt: 2,
				updatedAt: 2,
			});
		});
		const secret = await mintAgentSecret(t, CLIENT, "victor");
		const preview = await actingWith(member(t, CLIENT), secret).mutation(
			api.tasks.bulkComplete,
			{
				filter: { status: "todo" },
				dryRun: true,
				callerOrchestrator: "victor",
			} as never,
		);
		expect((preview as { count: number }).count).toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// searchTasksByKeyword — the assignee filter is the assignee's ID
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks:searchTasksByKeyword — `assignedTo` filters on the assignee ID", () => {
	test("a renamed agent is found by its new label", async () => {
		const t = createT();
		const ids = await seedFleetAgents(t, ["sigma", "pi"]);
		await t.run(async (ctx) => {
			await insertTaskRow(ctx, {
				title: "launch checklist",
				createdBy: "pi",
				assignedTo: "sigma",
				priority: "medium",
				status: "todo",
				createdAt: 1,
				updatedAt: 1,
			});
			await ctx.db.patch(ids.sigma, {
				name: "sigma-renamed",
				normalizedName: "sigma-renamed",
			});
		});
		const rows = (await svc(t).query(api.tasks.searchTasksByKeyword, {
			query: "launch",
			assignedTo: "sigma-renamed",
			fields: "full",
		})) as Array<{ title: string }>;
		expect(rows.map((r) => r.title)).toEqual(["launch checklist"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// recurring schedules — the label comes from the agent row; a typed person is not an agent
// ─────────────────────────────────────────────────────────────────────────────

describe("recurringTasks — the assignee is an agent, recorded under its row's label", () => {
	test("create records the label the agent row carries, not the typed spelling", async () => {
		const t = createT();
		const ids = await seedFleetAgents(t, ["pi", "sigma"]);
		const fleet = await fleetSlug(t);
		const id = await svc(t).mutation(api.recurringTasks.create, {
			title: "daily",
			assignedTo: "  SIGMA ",
			priority: "medium",
			cronExpression: "0 9 * * *",
			createdBy: "pi",
			verifiedActor: { agentId: ids.pi, orgSlug: fleet },
		});
		const row = await t.run(async (ctx) => await ctx.db.get(id));
		expect(row?.assignedTo).toBe("sigma");
		expect(row?.assignedToId).toBe(ids.sigma);
	});

	test("create refuses a typed person name as the assignee", async () => {
		const t = createT();
		const ids = await seedFleetAgents(t, ["pi"]);
		const fleet = await fleetSlug(t);
		const err = await svc(t)
			.mutation(api.recurringTasks.create, {
				title: "daily",
				assignedTo: "user:someone-else",
				priority: "medium",
				cronExpression: "0 9 * * *",
				createdBy: "pi",
				verifiedActor: { agentId: ids.pi, orgSlug: fleet },
			})
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConvexError);
		expect((err as ConvexError<string>).message).toContain("RBAC_DENIED");
	});
});
