/// <reference types="vite/client" />
/**
 * BATCH E, fleet-internal doors (issues, errorMonitor, fixPatterns,
 * errorMonitorFilters): the page is cut from a range that is ALREADY narrowed.
 *
 * R-55: a read narrows by every predicate before it bounds the result. Before,
 * `issues:listByProject` cut `limit` rows and THEN dropped the ones whose status
 * was not asked for, so a page came back short (or empty) while matching rows
 * existed; the `createdBefore` cursor of the other lists was applied after an
 * over-fetch capped at a fixed window. The cursor and the status are now part of
 * the range the page is cut from.
 *
 * Callers, said apart (.claude/rules/refusal-is-distinguishable-from-absence.md):
 *   fleet service account  - admitted, real figures
 *   operator org admin     - admitted on READS only (a human; a write door refuses it)
 *   client org admin/member - refused (RAISED at, or the typed empty list where
 *                             the door still answers a member that way)
 *   anonymous              - refused (RAISED at)
 *
 * And `issues:createExternal` assigns an AGENT BY ID: the row is judged by the
 * package (active, of the operator organisation), a same-label agent of a client
 * org is another agent, and the display label is read from the row.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { seedRosterAgent } from "../../tests/fixtures/rosterAgent";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

// The first test of a file pays the cold start of the whole Convex module graph.
vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const A = "org-a";
const OP = "fleet-op";
const NOW = 1_700_000_000_000;

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asHuman = (t: T, org: string, role: string) =>
	t.withIdentity({
		subject: `user-${org}-${role}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: role,
	} as Identity);

type World = { sigmaOp: Id<"agents">; piOp: Id<"agents">; sigmaA: Id<"agents"> };

async function seedWorld(t: T): Promise<World> {
	return await t.run(async (ctx) => {
		const mapping = (slug: string, kind?: "operator") =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...(kind ? { orgKind: kind } : {}),
			});
		await mapping(OP, "operator");
		await mapping(A);
		const sigmaOp = await seedRosterAgent(ctx, OP, "sigma");
		const piOp = await seedRosterAgent(ctx, OP, "pi");
		const sigmaA = await seedRosterAgent(ctx, A, "sigma");
		return { sigmaOp, piOp, sigmaA };
	});
}

type Status = "open" | "in_progress" | "fixed" | "verified" | "closed";

async function seedIssues(
	t: T,
	rows: Array<{
		n: number;
		status: Status;
		project?: string;
		assignee?: string;
	}>,
) {
	await t.run(async (ctx) => {
		for (const r of rows) {
			await ctx.db.insert("issues", {
				repo: "fleet/core",
				issueNumber: r.n,
				title: `issue ${r.n}`,
				body: "b",
				htmlUrl: `https://example.invalid/${r.n}`,
				labels: [],
				status: r.status,
				priority: "low",
				assignedOrchestrator: r.assignee ?? "sigma",
				project: r.project ?? "core",
				githubCreatedAt: NOW,
				githubUpdatedAt: NOW,
			});
		}
	});
}

describe("issues:listByProject narrows by status BEFORE it cuts the page", () => {
	test("PRESENT: the newest rows are another status, the page still holds `limit` matching rows", async () => {
		const t = createT();
		await seedWorld(t);
		// Oldest first: 1-2 open, then 3-6 closed (the newest four).
		await seedIssues(t, [
			{ n: 1, status: "open" },
			{ n: 2, status: "open" },
			{ n: 3, status: "closed" },
			{ n: 4, status: "closed" },
			{ n: 5, status: "closed" },
			{ n: 6, status: "closed" },
		]);
		const page = await asService(t).query(api.issues.listByProject, {
			project: "core",
			status: "open",
			limit: 2,
		});
		expect(page.map((r) => r.issueNumber)).toEqual([2, 1]);
	});

	test("PRESENT: paging by createdBefore reaches every row exactly once", async () => {
		const t = createT();
		await seedWorld(t);
		await seedIssues(
			t,
			Array.from({ length: 7 }, (_, i) => ({ n: i + 1, status: "open" as const })),
		);
		const seen: number[] = [];
		let createdBefore: number | undefined;
		for (let pages = 0; pages < 8; pages++) {
			const page = await asService(t).query(api.issues.listByProject, {
				project: "core",
				limit: 3,
				createdBefore,
			});
			seen.push(...page.map((r) => r.issueNumber));
			if (page.length < 3) break;
			createdBefore = page[page.length - 1]._creationTime;
		}
		expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]);
	});

	test("ABSENT: a project with no issue reads an empty success for the fleet", async () => {
		const t = createT();
		await seedWorld(t);
		const page = await asService(t).query(api.issues.listByProject, {
			project: "no-such-project",
		});
		expect(page).toEqual([]);
	});

	test("REFUSED: an anonymous caller is RAISED at, never served an empty success", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			t.query(api.issues.listByProject, { project: "core" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test.each([
		["client org admin", "org:admin"],
		["client org member", "org:member"],
	])("CROSS-ORG: a %s is refused, not handed the fleet's issues", async (_n, role) => {
		const t = createT();
		await seedWorld(t);
		await seedIssues(t, [{ n: 1, status: "open" }]);
		await expect(
			asHuman(t, A, role).query(api.issues.listByProject, { project: "core" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("PRESENT: the operator org admin human is served on a READ", async () => {
		const t = createT();
		await seedWorld(t);
		await seedIssues(t, [{ n: 1, status: "open" }]);
		const page = await asHuman(t, OP, "org:admin").query(
			api.issues.listByProject,
			{ project: "core" },
		);
		expect(page).toHaveLength(1);
	});
});

describe("issues:listByOrchestrator / listByStatus page by the cursor of the range", () => {
	test("PRESENT: listByOrchestrator with a status pages to the end", async () => {
		const t = createT();
		await seedWorld(t);
		await seedIssues(t, [
			...Array.from({ length: 5 }, (_, i) => ({
				n: i + 1,
				status: "open" as const,
				assignee: "pi",
			})),
			{ n: 6, status: "closed" as const, assignee: "pi" },
			{ n: 7, status: "open" as const, assignee: "sigma" },
		]);
		const seen: number[] = [];
		let createdBefore: number | undefined;
		for (let pages = 0; pages < 8; pages++) {
			const page = await asService(t).query(api.issues.listByOrchestrator, {
				assignedOrchestrator: "pi",
				status: "open",
				limit: 2,
				createdBefore,
			});
			seen.push(...page.map((r) => r.issueNumber));
			if (page.length < 2) break;
			createdBefore = page[page.length - 1]._creationTime;
		}
		expect(seen).toEqual([5, 4, 3, 2, 1]);
	});

	test("PRESENT: listByOrchestrator without a status pages to the end", async () => {
		const t = createT();
		await seedWorld(t);
		await seedIssues(t, [
			{ n: 1, status: "open", assignee: "pi" },
			{ n: 2, status: "closed", assignee: "pi" },
			{ n: 3, status: "open", assignee: "pi" },
			{ n: 4, status: "open", assignee: "sigma" },
		]);
		const seen: number[] = [];
		let createdBefore: number | undefined;
		for (let pages = 0; pages < 6; pages++) {
			const page = await asService(t).query(api.issues.listByOrchestrator, {
				assignedOrchestrator: "pi",
				limit: 2,
				createdBefore,
			});
			seen.push(...page.map((r) => r.issueNumber));
			if (page.length < 2) break;
			createdBefore = page[page.length - 1]._creationTime;
		}
		expect(seen).toEqual([3, 2, 1]);
	});

	test("PRESENT: listByStatus pages to the end", async () => {
		const t = createT();
		await seedWorld(t);
		await seedIssues(
			t,
			Array.from({ length: 5 }, (_, i) => ({ n: i + 1, status: "fixed" as const })),
		);
		const seen: number[] = [];
		let createdBefore: number | undefined;
		for (let pages = 0; pages < 6; pages++) {
			const page = await asService(t).query(api.issues.listByStatus, {
				status: "fixed",
				limit: 2,
				createdBefore,
			});
			seen.push(...page.map((r) => r.issueNumber));
			if (page.length < 2) break;
			createdBefore = page[page.length - 1]._creationTime;
		}
		expect(seen).toEqual([5, 4, 3, 2, 1]);
	});

	test("ABSENT: an orchestrator with no issue reads an empty success", async () => {
		const t = createT();
		await seedWorld(t);
		await seedIssues(t, [{ n: 1, status: "open", assignee: "pi" }]);
		expect(
			await asService(t).query(api.issues.listByOrchestrator, {
				assignedOrchestrator: "nobody",
			}),
		).toEqual([]);
	});

	test.each([
		["listByOrchestrator", () => api.issues.listByOrchestrator, { assignedOrchestrator: "pi" }],
		["listByStatus", () => api.issues.listByStatus, { status: "open" as const }],
	])("REFUSED: %s raises RBAC_DENIED at an anonymous caller and a client org member", async (_n, ref, args) => {
		const t = createT();
		await seedWorld(t);
		await expect(t.query(ref() as never, args as never)).rejects.toThrow(
			/RBAC_DENIED/,
		);
		await expect(
			asHuman(t, A, "org:member").query(ref() as never, args as never),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

describe("errorMonitor:listErrors narrows by the deployment and the cursor", () => {
	const seedErrors = async (t: T) => {
		await t.run(async (ctx) => {
			for (let i = 1; i <= 6; i++) {
				await ctx.db.insert("errorLogs", {
					hash: `h${i}`,
					deployment: i % 2 === 0 ? "dep-even" : "dep-odd",
					functionName: "f:g",
					errorMessage: `error ${i}`,
					firstSeen: NOW,
					lastSeen: NOW,
					count: 1,
				});
			}
		});
	};

	test("PRESENT: a deployment's errors page to the end by the cursor", async () => {
		const t = createT();
		await seedWorld(t);
		await seedErrors(t);
		const seen: string[] = [];
		let createdBefore: number | undefined;
		for (let pages = 0; pages < 5; pages++) {
			const page = await asService(t).query(api.errorMonitor.listErrors, {
				deployment: "dep-even",
				limit: 2,
				createdBefore,
			});
			seen.push(...page.map((r) => r.hash));
			if (page.length < 2) break;
			createdBefore = page[page.length - 1]._creationTime;
		}
		expect(seen).toEqual(["h6", "h4", "h2"]);
	});

	test("PRESENT: with no deployment the whole table pages to the end by the cursor", async () => {
		const t = createT();
		await seedWorld(t);
		await seedErrors(t);
		const seen: string[] = [];
		let createdBefore: number | undefined;
		for (let pages = 0; pages < 8; pages++) {
			const page = await asService(t).query(api.errorMonitor.listErrors, {
				limit: 4,
				createdBefore,
			});
			seen.push(...page.map((r) => r.hash));
			if (page.length < 4) break;
			createdBefore = page[page.length - 1]._creationTime;
		}
		expect(seen).toEqual(["h6", "h5", "h4", "h3", "h2", "h1"]);
	});

	test("ABSENT: a deployment with no error reads an empty success", async () => {
		const t = createT();
		await seedWorld(t);
		await seedErrors(t);
		expect(
			await asService(t).query(api.errorMonitor.listErrors, {
				deployment: "dep-none",
			}),
		).toEqual([]);
	});

	test("REFUSED: an anonymous caller is RAISED at; a client org member is served the typed empty list", async () => {
		const t = createT();
		await seedWorld(t);
		await seedErrors(t);
		await expect(t.query(api.errorMonitor.listErrors, {})).rejects.toThrow(
			/RBAC_DENIED/,
		);
		expect(
			await asHuman(t, A, "org:member").query(api.errorMonitor.listErrors, {}),
		).toEqual([]);
	});
});

describe("fixPatterns:listByProject / listAll narrow by the project and the cursor", () => {
	const seedPatterns = async (t: T) => {
		await t.run(async (ctx) => {
			for (let i = 1; i <= 5; i++) {
				await ctx.db.insert("fixPatterns", {
					symptom: `symptom ${i}`,
					rootCause: "root",
					tags: [],
					stack: ["convex"],
					sourceProject: i % 2 === 0 ? "proj-even" : "proj-odd",
					createdBy: "sigma",
					severity: "minor",
					createdAt: NOW,
					updatedAt: NOW,
				});
			}
		});
	};

	test("PRESENT: listByProject pages to the end by the cursor", async () => {
		const t = createT();
		await seedWorld(t);
		await seedPatterns(t);
		const seen: string[] = [];
		let createdBefore: number | undefined;
		for (let pages = 0; pages < 5; pages++) {
			const page = await asService(t).query(api.fixPatterns.listByProject, {
				sourceProject: "proj-odd",
				limit: 2,
				createdBefore,
			});
			seen.push(...page.map((r) => r.symptom));
			if (page.length < 2) break;
			createdBefore = page[page.length - 1]._creationTime;
		}
		expect(seen).toEqual(["symptom 5", "symptom 3", "symptom 1"]);
	});

	test("PRESENT: listAll pages to the end by the cursor", async () => {
		const t = createT();
		await seedWorld(t);
		await seedPatterns(t);
		const seen: string[] = [];
		let createdBefore: number | undefined;
		for (let pages = 0; pages < 5; pages++) {
			const page = await asService(t).query(api.fixPatterns.listAll, {
				limit: 2,
				createdBefore,
			});
			seen.push(...page.map((r) => r.symptom));
			if (page.length < 2) break;
			createdBefore = page[page.length - 1]._creationTime;
		}
		expect(seen).toEqual([
			"symptom 5",
			"symptom 4",
			"symptom 3",
			"symptom 2",
			"symptom 1",
		]);
	});

	test("ABSENT: a project with no pattern reads an empty success", async () => {
		const t = createT();
		await seedWorld(t);
		expect(
			await asService(t).query(api.fixPatterns.listByProject, {
				sourceProject: "none",
			}),
		).toEqual([]);
	});

	test("REFUSED: an anonymous caller is RAISED at on both lists", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			t.query(api.fixPatterns.listByProject, { sourceProject: "p" }),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(t.query(api.fixPatterns.listAll, {})).rejects.toThrow(
			/RBAC_DENIED/,
		);
	});

	test("CROSS-ORG: a client org admin is refused by listByProject and served the typed empty list by listAll", async () => {
		const t = createT();
		await seedWorld(t);
		await seedPatterns(t);
		await expect(
			asHuman(t, A, "org:admin").query(api.fixPatterns.listByProject, {
				sourceProject: "proj-odd",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(
			await asHuman(t, A, "org:admin").query(api.fixPatterns.listAll, {}),
		).toEqual([]);
	});
});

describe("errorMonitorFilters:listFilterRules reads the fleet standing from the package", () => {
	const seedRules = async (t: T) => {
		await t.run(async (ctx) => {
			await ctx.db.insert("errorMonitorFilterRules", {
				functionName: "tasks:complete",
				errorMessageRegex: "Unauthorized",
				reason: "expected refusal",
				severity: "skip",
				active: true,
				createdAt: NOW,
			});
		});
	};

	test("PRESENT: the fleet service account and the operator admin human are served the rules", async () => {
		const t = createT();
		await seedWorld(t);
		await seedRules(t);
		expect(
			await asService(t).query(api.errorMonitorFilters.listFilterRules, {}),
		).toHaveLength(1);
		expect(
			await asHuman(t, OP, "org:admin").query(
				api.errorMonitorFilters.listFilterRules,
				{},
			),
		).toHaveLength(1);
	});

	test("ABSENT: the fleet reads an empty success when no rule exists", async () => {
		const t = createT();
		await seedWorld(t);
		expect(
			await asService(t).query(api.errorMonitorFilters.listFilterRules, {}),
		).toEqual([]);
	});

	test("CROSS-ORG: a client org admin and member are served the typed empty list, never the rules", async () => {
		const t = createT();
		await seedWorld(t);
		await seedRules(t);
		for (const role of ["org:admin", "org:member"]) {
			expect(
				await asHuman(t, A, role).query(
					api.errorMonitorFilters.listFilterRules,
					{},
				),
			).toEqual([]);
		}
	});

	test("REFUSED: an anonymous caller is RAISED at", async () => {
		const t = createT();
		await seedWorld(t);
		await expect(
			t.query(api.errorMonitorFilters.listFilterRules, {}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

describe("issues:createExternal assigns an agent BY ID", () => {
	const external = (assignedOrchestratorId: Id<"agents">) => ({
		externalRepo: "get-convex/better-auth",
		externalIssueNumber: 7,
		externalIssueUrl: "https://example.invalid/7",
		title: "external",
		body: "b",
		assignedOrchestratorId,
	});

	test("PRESENT: an agent of the operator org is assigned and its label is read from the row", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const id = await t.mutation(
			internal.issues.createExternal,
			external(w.piOp),
		);
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.assignedOrchestrator).toBe("pi");
	});

	test("CROSS-ORG: a same-label agent of a client org is another agent and is refused", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await expect(
			t.mutation(internal.issues.createExternal, external(w.sigmaA)),
		).rejects.toThrow(/INVALID_ASSIGNEE/);
		const rows = await t.run((ctx) => ctx.db.query("issues").collect());
		expect(rows).toHaveLength(0);
	});

	test("REFUSED: a deactivated operator agent is refused", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await t.run((ctx) => ctx.db.patch(w.piOp, { isActive: false }));
		await expect(
			t.mutation(internal.issues.createExternal, external(w.piOp)),
		).rejects.toThrow(/INVALID_ASSIGNEE/);
	});

	test("ABSENT: an ID that names no agent is refused, not silently stored", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const gone = await t.run(async (ctx) => {
			const id = await ctx.db.insert("agents", {
				orgSlug: OP,
				name: "ghost",
				normalizedName: "ghost",
				isActive: true,
				createdAt: 0,
			});
			await ctx.db.delete(id);
			return id;
		});
		expect(gone).not.toBe(w.piOp);
		await expect(
			t.mutation(internal.issues.createExternal, external(gone)),
		).rejects.toThrow(/INVALID_ASSIGNEE/);
	});
});
