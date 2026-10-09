/// <reference types="vite/client" />
// orgKeyById.test.ts - M4: a row belongs to an organisation by its permanent Clerk
// org ID, never by the renamable `clerkOrgSlug`.
//
// Every pole runs under a SCOPED member identity (an ordinary member of an org),
// never the master or the service account. The identity carries the claims a
// Clerk session carries after a rename: the CURRENT slug and the permanent
// `org_id`.
//
// Poles:
//   RENAMED   the mapping was renamed; rows stamped with the old slug still
//             belong to the org (they follow the ID).
//   AHEAD     the token already carries the new slug while the mapping row still
//             holds the old one; the ID finds the org.
//   REUSED    the old slug is taken by ANOTHER org; that org must not reach the
//             first org's rows just because the slug strings are equal.
//   CONTRADICTED / UNKNOWN  an org ID that names no org (or contradicts the
//             mapping the slug names) is refused with a typed refusal, never
//             served and never an empty success.
//   AUDIENCE  the repo-mapping audience of a task follows the org ID: the operator
//             org keeps reaching fleet rows after a rename, a client org keeps
//             reaching its own rows, and still no one else's.
// Hermetic: fictitious identifiers only.

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;

const LEAD = "lead-seat";
const NOW = 1_700_000_000_000;
const ACME = { slug: "acme", id: "org_ACME1" };
const OTHER = { slug: "other", id: "org_OTHER1" };
const OP = { slug: "fleet-org", id: "org_FLEET1" };

/** A member after Clerk delivered a token: current slug AND permanent org id. */
const member = (t: T, slug: string, id: string) =>
	t.withIdentity({
		subject: `member-of-${id}`,
		organizationSlug: slug,
		org_id: id,
	} as Parameters<T["withIdentity"]>[0]);

const mapping = (
	slug: string,
	id: string | undefined,
	extra: { operator?: boolean; scopes?: string[] } = {},
) => ({
	clerkOrgSlug: slug,
	allowedOrchestrators: [LEAD],
	scopes: extra.scopes ?? ["view-own-tasks", "view-own-missions"],
	displayName: slug,
	isActive: true,
	createdAt: NOW,
	...(id !== undefined ? { clerkOrgId: id } : {}),
	...(extra.operator ? { orgKind: "operator" as const } : {}),
});

async function seedBusinessUnit(t: T, org: { slug: string; id: string }) {
	return await t.run(async (ctx) =>
		ctx.db.insert("businessUnits", {
			name: "bu",
			description: "d",
			purpose: "p",
			domain: "x",
			orchestratorId: LEAD,
			status: "live",
			businessModel: "m",
			targetCustomers: "c",
			services: [],
			pricing: "p",
			revenueProjections: { y1: 1, y2: 2, y3: 3 },
			coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
			coreProcesses: [],
			dependencies: [],
			kpis: [],
			managementFee: 10,
			createdAt: NOW,
			updatedAt: NOW,
			orgId: org.slug,
			clerkOrgId: org.id,
		} as never),
	);
}

const rename = (t: T, from: string, to: string) =>
	t.run(async (ctx) => {
		const row = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", from))
			.unique();
		if (row) await ctx.db.patch(row._id, { clerkOrgSlug: to });
	});

const buName = (t: T, id: string) =>
	t.run(async (ctx) => ((await ctx.db.get(id as never)) as { name: string }).name);

const errorData = (e: unknown): string =>
	e instanceof ConvexError ? JSON.stringify(e.data) : String(e);

describe("a row follows its org ID through a slug rename", () => {
	test("RENAMED: the mapping was renamed; the member updates its own pre-rename row", async () => {
		const t = makeT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", mapping(ACME.slug, ACME.id));
		});
		const bu = await seedBusinessUnit(t, ACME);
		await rename(t, ACME.slug, "acme-renamed");
		await member(t, "acme-renamed", ACME.id).mutation(api.businessUnits.update, {
			buId: bu as never,
			callerOrchestrator: LEAD,
			name: "renamed-ok",
		});
		expect(await buName(t, bu)).toBe("renamed-ok");
	});

	test("AHEAD: the token carries the new slug, the mapping still the old one; the ID finds the org", async () => {
		const t = makeT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", mapping(ACME.slug, ACME.id));
		});
		const bu = await seedBusinessUnit(t, ACME);
		await member(t, "acme-renamed", ACME.id).mutation(api.businessUnits.update, {
			buId: bu as never,
			callerOrchestrator: LEAD,
			name: "ahead-ok",
		});
		expect(await buName(t, bu)).toBe("ahead-ok");
	});

	test("REUSED: another org that now holds the old slug does not reach the first org's row", async () => {
		const t = makeT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", mapping(ACME.slug, ACME.id));
		});
		const bu = await seedBusinessUnit(t, ACME);
		// ACME is renamed away; a DIFFERENT org takes the freed slug "acme".
		await rename(t, ACME.slug, "acme-renamed");
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", mapping("acme", "org_NEWCOMER1"));
		});
		let refusal: unknown;
		try {
			await member(t, "acme", "org_NEWCOMER1").mutation(api.businessUnits.update, {
				buId: bu as never,
				callerOrchestrator: LEAD,
				name: "taken-over",
			});
		} catch (e) {
			refusal = e;
		}
		expect(errorData(refusal)).toContain("RBAC_DENIED");
		expect(errorData(refusal)).toContain("row-not-in-caller-org");
		expect(await buName(t, bu)).toBe("bu");
	});
});

describe("an org ID that names no org is refused, never served and never empty", () => {
	test("CONTRADICTED: the slug names a real org but the org ID is another's; refused with its code", async () => {
		const t = makeT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", mapping(ACME.slug, ACME.id));
		});
		const bu = await seedBusinessUnit(t, ACME);
		const caller = member(t, ACME.slug, "org_GHOST1");
		let refusal: unknown;
		try {
			await caller.mutation(api.businessUnits.update, {
				buId: bu as never,
				callerOrchestrator: LEAD,
				name: "ghost-wrote",
			});
		} catch (e) {
			refusal = e;
		}
		expect(errorData(refusal)).toContain("RBAC_DENIED");
		expect(await buName(t, bu)).toBe("bu");
		// The read door raises too: a refusal must not read as "no business units".
		let readRefusal: unknown;
		try {
			await caller.query(api.businessUnits.list, {});
		} catch (e) {
			readRefusal = e;
		}
		expect(errorData(readRefusal)).toContain("RBAC_DENIED");
	});

	test("UNKNOWN: an org ID and a slug that name nothing are refused with the typed code", async () => {
		const t = makeT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", mapping(ACME.slug, ACME.id));
		});
		let refusal: unknown;
		try {
			await member(t, "nobody", "org_NOBODY1").query(api.businessUnits.list, {});
		} catch (e) {
			refusal = e;
		}
		expect(errorData(refusal)).toContain("RBAC_DENIED");
	});

	test("ABSENT: a legitimate member of an org with no rows gets an empty SUCCESS", async () => {
		const t = makeT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", mapping(ACME.slug, ACME.id));
		});
		const r = await member(t, ACME.slug, ACME.id).query(api.businessUnits.list, {});
		expect(r.items).toEqual([]);
	});
});

describe("the repo-mapping audience of a task follows the org ID", () => {
	const NOTE = "Fixed the defect in commit abcdef1234567 with regression test, 3/3 pass";
	const seedRepos = async (t: T) => {
		await t.run(async (ctx) => {
			await ctx.db.insert("taskClosureConfig", { key: "billableProjects", value: [], updatedAt: 0 });
			await ctx.db.insert("client_org_mapping", mapping(OP.slug, OP.id, { operator: true }));
			await ctx.db.insert("client_org_mapping", mapping(OTHER.slug, OTHER.id));
			const rows: Array<[string, string, string | undefined]> = [
				["fleet/repo", "fleet-proj", undefined],
				["other/repo", "other-proj", OTHER.slug],
			];
			for (const [repo, project, orgId] of rows) {
				await ctx.db.insert("githubRepoMapping", {
					repo,
					orchestrator: LEAD,
					project,
					active: true,
					...(orgId !== undefined ? { orgId } : {}),
				});
				await ctx.db.insert("issues", {
					repo,
					issueNumber: 5,
					title: `${repo} issue`,
					body: "",
					htmlUrl: `https://example.test/${repo}/5`,
					labels: [],
					status: "open",
					priority: "medium",
					assignedOrchestrator: LEAD,
					project,
					githubCreatedAt: 1,
					githubUpdatedAt: 1,
					...(orgId !== undefined ? { orgId } : {}),
				});
			}
		});
	};
	const issueOf = (t: T, repo: string) =>
		t.run(async (ctx) =>
			ctx.db
				.query("issues")
				.withIndex("by_repo_number", (q) => q.eq("repo", repo).eq("issueNumber", 5))
				.unique(),
		);
	const completes = async (caller: ReturnType<typeof member>, project: string) => {
		const taskId = await caller.mutation(api.tasks.create, {
			title: "Fix flaky thing #5",
			assignedTo: LEAD,
			priority: "high",
			status: "todo",
			createdBy: LEAD,
			project,
		});
		await caller.mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: LEAD,
			completionNote: NOTE,
		});
		return taskId;
	};

	test("RENAMED OPERATOR: the operator org, renamed, still reaches fleet rows through its task", async () => {
		const t = makeT();
		await seedRepos(t);
		// The task is created under the operator's OLD slug, then the org is renamed.
		const before = member(t, OP.slug, OP.id);
		const taskId = await before.mutation(api.tasks.create, {
			title: "Fix flaky thing #5",
			assignedTo: LEAD,
			priority: "high",
			status: "todo",
			createdBy: LEAD,
			project: "fleet-proj",
		});
		await rename(t, OP.slug, "fleet-org-renamed");
		await member(t, "fleet-org-renamed", OP.id).mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: LEAD,
			completionNote: NOTE,
		});
		const fleet = await issueOf(t, "fleet/repo");
		expect(fleet?.linkedTaskIds).toEqual([taskId]);
	});

	test("RENAMED CLIENT: a client org, renamed, keeps reaching ITS rows and never the fleet's or another org's", async () => {
		const t = makeT();
		await seedRepos(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", mapping(ACME.slug, ACME.id));
			// The GitHub-verified owner binding the mapping row's routing proof reads
			// (it is stamped with the slug it was bound under and is not renamed).
			await ctx.db.insert("githubOwnerBindings", {
				owner: "acme",
				orgId: ACME.slug,
				installationId: 1,
				accountType: "Organization",
				githubUserLogin: "gh-acme",
				boundBy: "admin-acme",
				boundAt: 1,
				active: true,
			});
			await ctx.db.insert("githubRepoMapping", {
				repo: "acme/repo",
				orchestrator: LEAD,
				project: "acme-proj",
				active: true,
				orgId: ACME.slug,
				clerkOrgId: ACME.id,
			} as never);
			await ctx.db.insert("issues", {
				repo: "acme/repo",
				issueNumber: 5,
				title: "acme issue",
				body: "",
				htmlUrl: "https://example.test/acme/repo/5",
				labels: [],
				status: "open",
				priority: "medium",
				assignedOrchestrator: LEAD,
				project: "acme-proj",
				githubCreatedAt: 1,
				githubUpdatedAt: 1,
				orgId: ACME.slug,
				clerkOrgId: ACME.id,
			} as never);
		});
		await rename(t, ACME.slug, "acme-renamed");
		const acme = member(t, "acme-renamed", ACME.id);
		const fleetBefore = await issueOf(t, "fleet/repo");
		const otherBefore = await issueOf(t, "other/repo");
		const taskId = await completes(acme, "acme-proj");
		expect((await issueOf(t, "acme/repo"))?.linkedTaskIds).toEqual([taskId]);
		await completes(acme, "fleet-proj");
		await completes(acme, "other-proj");
		expect(await issueOf(t, "fleet/repo")).toEqual(fleetBefore);
		expect(await issueOf(t, "other/repo")).toEqual(otherBefore);
	});
});
