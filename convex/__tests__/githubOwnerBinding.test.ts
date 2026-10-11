/// <reference types="vite/client" />
// githubOwnerBinding.test.ts — a repo is routed to an org only on PROOF from
// GitHub, never on first claim. Squat found by Argus: org-a's add of
// "org-b/newrepo" was accepted and org-b's issues then landed in org-a.
//
// Ordinary org identities throughout (never master / service account) except
// where the master door is the subject.

import { ConvexError } from "convex/values";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
	collectUnprovenMappings,
	OWNER_LIST_DEFAULT_LIMIT,
	OWNER_LIST_MAX_LIMIT,
	pageSize,
} from "../githubOwnerBinding";
import schema from "../schema";
import { TEST_WEBHOOK_SECRET, signGithubBody } from "../../tests/lib/githubWebhookSignature";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;
const ORCH = "eta";

const member = (t: T, slug: string) =>
	t.withIdentity({ subject: `member-${slug}`, organizationSlug: slug, org_id: testClerkOrgId(slug), orgRole: "org:member" } as Parameters<
		T["withIdentity"]
	>[0]);
const master = (t: T) => t.withIdentity({ subject: "test-service-account-user-id" });

async function seed(t: T, opts: { bind?: boolean } = { bind: true }) {
	await t.run(async (ctx) => {
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [ORCH],
				scopes: ["view-own-tasks", "manage-repo-mappings"],
				displayName: slug,
				isActive: true,
				createdAt: 1,
			});
			if (opts.bind !== false) {
				await ctx.db.insert("githubOwnerBindings", {
					owner: slug,
					orgId: slug,
					installationId: slug === "org-a" ? 11 : 22,
					accountType: "Organization",
					githubUserLogin: `gh-${slug}`,
					boundBy: `admin-${slug}`,
					boundAt: 1,
					active: true,
				});
			}
		}
	});
}

const denied = (e: unknown, reason?: string) => {
	expect(e).toBeInstanceOf(ConvexError);
	expect((e as ConvexError<string>).message).toContain("RBAC_DENIED");
	if (reason) expect((e as ConvexError<string>).message).toContain(reason);
};
const addMapping = (c: ReturnType<typeof member>, repo: string) =>
	c.mutation(api.githubRepoMapping.add, { repo, orchestrator: ORCH, project: "p" }).catch((e: unknown) => e);
const mappingOf = (t: T, repo: string) =>
	t.run(async (ctx) =>
		ctx.db.query("githubRepoMapping").withIndex("by_repo", (q) => q.eq("repo", repo)).unique(),
	);

describe("add: a repo is mapped to an org only when its GitHub owner is bound to THAT org", () => {
	test("PRESENT: own bound owner is allowed (and case does not matter)", async () => {
		const t = makeT();
		await seed(t);
		expect(await addMapping(member(t, "org-a"), "org-a/newrepo")).not.toBeInstanceOf(Error);
		expect(await addMapping(member(t, "org-a"), "Org-A/CasedRepo")).not.toBeInstanceOf(Error);
		expect((await mappingOf(t, "org-a/newrepo"))?.orgId).toBe("org-a");
	});

	test("REFUSED (the squat): org-a mapping org-b's owner's new repo; no row, and org-b's issues never land in org-a", async () => {
		const t = makeT();
		await seed(t);
		denied(await addMapping(member(t, "org-a"), "org-b/newrepo"), "github-owner-not-bound");
		expect(await mappingOf(t, "org-b/newrepo")).toBeNull();
		await t.mutation(internal.issues.upsertFromGitHub, {
			repo: "org-b/newrepo",
			issueNumber: 1,
			title: "t",
			body: "b",
			htmlUrl: "https://example.test/1",
			labels: [],
			status: "open",
			githubCreatedAt: 1,
			githubUpdatedAt: 1,
		});
		const issue = await t.run(async (ctx) =>
			ctx.db.query("issues").withIndex("by_repo_number", (q) => q.eq("repo", "org-b/newrepo").eq("issueNumber", 1)).unique(),
		);
		expect(issue?.orgId).toBeUndefined(); // never stamped org-a
	});

	test("REFUSED: an owner bound to nobody", async () => {
		const t = makeT();
		await seed(t);
		denied(await addMapping(member(t, "org-a"), "ghost/x"), "github-owner-not-bound");
		expect(await mappingOf(t, "ghost/x")).toBeNull();
	});

	test("REFUSED: org with no bindings at all", async () => {
		const t = makeT();
		await seed(t, { bind: false });
		denied(await addMapping(member(t, "org-a"), "org-a/newrepo"), "github-owner-not-bound");
	});

	test("REFUSED: a deactivated binding no longer proves anything", async () => {
		const t = makeT();
		await seed(t);
		await t.mutation(internal.githubOwnerBinding.deactivateInstallation, { installationId: 11 });
		denied(await addMapping(member(t, "org-a"), "org-a/newrepo"), "github-owner-not-bound");
	});

	test("REFUSED: malformed repo string", async () => {
		const t = makeT();
		await seed(t);
		const err = await addMapping(member(t, "org-a"), "not-a-repo");
		expect((err as ConvexError<string>).message).toContain("INVALID_REPO");
	});

	test("FLEET: master still maps any repo with no binding", async () => {
		const t = makeT();
		await seed(t, { bind: false });
		const r = await master(t)
			.mutation(api.githubRepoMapping.add, { repo: "anyone/fleet-repo", orchestrator: ORCH, project: "p" })
			.catch((e: unknown) => e);
		expect(r).not.toBeInstanceOf(Error);
		expect((await mappingOf(t, "anyone/fleet-repo"))?.orgId).toBeUndefined();
	});
});

describe("installation webhook (HMAC-verified)", () => {
	const post = (t: T, body: Record<string, unknown>, event = "installation") => {
		const raw = JSON.stringify(body);
		return t.fetch("/github/webhook", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-github-event": event,
				"x-hub-signature-256": signGithubBody(raw),
			},
			body: raw,
		});
	};
	test("deleted installation deactivates its bindings; add is refused afterwards", async () => {
		vi.stubEnv("GITHUB_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
		const t = makeT();
		await seed(t);
		const res = await post(t, { action: "deleted", installation: { id: 11 } });
		expect(res.status).toBe(200);
		denied(await addMapping(member(t, "org-a"), "org-a/after"), "github-owner-not-bound");
		// other org untouched
		expect(await addMapping(member(t, "org-b"), "org-b/still")).not.toBeInstanceOf(Error);
	});

	test("unsigned installation event is refused and changes nothing", async () => {
		vi.stubEnv("GITHUB_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
		const t = makeT();
		await seed(t);
		const res = await t.fetch("/github/webhook", {
			method: "POST",
			headers: { "x-github-event": "installation", "x-hub-signature-256": "sha256=bad" },
			body: JSON.stringify({ action: "deleted", installation: { id: 11 } }),
		});
		expect(res.status).toBe(401);
		expect(await addMapping(member(t, "org-a"), "org-a/ok")).not.toBeInstanceOf(Error);
	});
});

describe("existing mappings without proof are REPORTED", () => {
	test("master lists org-owned rows whose owner is unbound or bound elsewhere; members are refused", async () => {
		const t = makeT();
		await seed(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("githubRepoMapping", { repo: "org-a/ok", orchestrator: ORCH, project: "p", active: true, orgId: "org-a", clerkOrgId: testClerkOrgId("org-a") });
			await ctx.db.insert("githubRepoMapping", { repo: "squat/x", orchestrator: ORCH, project: "p", active: true, orgId: "org-a", clerkOrgId: testClerkOrgId("org-a") });
			await ctx.db.insert("githubRepoMapping", { repo: "org-b/y", orchestrator: ORCH, project: "p", active: true, orgId: "org-a", clerkOrgId: testClerkOrgId("org-a") });
			await ctx.db.insert("githubRepoMapping", { repo: "fleet/z", orchestrator: ORCH, project: "p", active: true });
		});
		const list = await master(t).query(api.githubOwnerBinding.listUnprovenMappings, {});
		expect(list.nextCursor).toBeNull();
		expect(list.items.map((r) => [r.repo, r.reason]).sort()).toEqual([
			["org-b/y", "owner-bound-to-another-org"],
			["squat/x", "owner-not-bound"],
		]);
		const err = await member(t, "org-a").query(api.githubOwnerBinding.listUnprovenMappings, {}).catch((e: unknown) => e);
		denied(err);
	});

	test("listBindings: a member sees only its own org's bindings; master sees all", async () => {
		const t = makeT();
		await seed(t);
		const mine = await member(t, "org-a").query(api.githubOwnerBinding.listBindings, {});
		expect(mine.nextCursor).toBeNull();
		expect(mine.items.map((b) => b.owner)).toEqual(["org-a"]);
		expect((await master(t).query(api.githubOwnerBinding.listBindings, {})).items.length).toBe(2);
	});

	// R-3: both reads are cursor-paginated with a named default and maximum.
	// Poles: empty -> exhausted; more rows than a page -> a cursor that walks every
	// row exactly once; the limit is clamped to the named maximum.
	test("listBindings pages by cursor: every row exactly once, null cursor ends it, empty is exhausted", async () => {
		const t = makeT();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "org-a",
				clerkOrgId: testClerkOrgId("org-a"),
				allowedOrchestrators: [ORCH],
				scopes: ["view-own-tasks", "manage-repo-mappings"],
				displayName: "org-a",
				isActive: true,
				createdAt: 1,
			});
		});
		const empty = await member(t, "org-a").query(api.githubOwnerBinding.listBindings, {});
		expect(empty).toEqual({ items: [], nextCursor: null });
		await t.run(async (ctx) => {
			for (let i = 0; i < 5; i++) {
				await ctx.db.insert("githubOwnerBindings", {
					owner: `own${i}`,
					orgId: "org-a",
					installationId: i,
					accountType: "Organization",
					githubUserLogin: `gh${i}`,
					boundBy: "admin-org-a",
					boundAt: 1,
					active: true,
				});
			}
		});
		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		for (;;) {
			const page = await member(t, "org-a").query(api.githubOwnerBinding.listBindings, {
				limit: 2,
				...(cursor !== undefined ? { cursor } : {}),
			});
			expect(page.items.length).toBeLessThanOrEqual(2);
			seen.push(...page.items.map((b) => b.owner));
			pages++;
			if (page.nextCursor === null) break;
			cursor = page.nextCursor;
		}
		expect(pages).toBe(3);
		expect([...seen].sort()).toEqual(["own0", "own1", "own2", "own3", "own4"]);
		const asMaster = await master(t).query(api.githubOwnerBinding.listBindings, { limit: 3 });
		expect(asMaster.items.length).toBe(3);
		expect(asMaster.nextCursor).not.toBeNull();
	});

	test("pageSize: default when absent or not finite; clamped to [1, named max]", () => {
		expect(pageSize(undefined)).toBe(OWNER_LIST_DEFAULT_LIMIT);
		expect(pageSize(Number.NaN)).toBe(OWNER_LIST_DEFAULT_LIMIT);
		expect(pageSize(0)).toBe(1);
		expect(pageSize(-5)).toBe(1);
		expect(pageSize(7.9)).toBe(7);
		expect(pageSize(OWNER_LIST_MAX_LIMIT + 1000)).toBe(OWNER_LIST_MAX_LIMIT);
	});

	test("listUnprovenMappings pages by cursor: a page scans `limit` mappings, null cursor ends the scan", async () => {
		const t = makeT();
		await t.run(async (ctx) => {
			for (let i = 0; i < 5; i++) {
				await ctx.db.insert("githubRepoMapping", {
					repo: `sq${i}/r`,
					orchestrator: ORCH,
					project: "p",
					active: true,
					orgId: "org-a",
					clerkOrgId: testClerkOrgId("org-a"),
				});
			}
			// a fleet row is scanned but never reported
			await ctx.db.insert("githubRepoMapping", { repo: "fleet/z", orchestrator: ORCH, project: "p", active: true });
		});
		expect(await t.run((ctx) => collectUnprovenMappings(ctx, 50, null))).toMatchObject({ nextCursor: null });
		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const page: Awaited<ReturnType<typeof collectUnprovenMappings>> = await t.run((ctx) =>
				collectUnprovenMappings(ctx, 2, cursor),
			);
			seen.push(...page.items.map((m) => m.repo));
			cursor = page.nextCursor;
			pages++;
		} while (cursor !== null);
		expect(pages).toBe(3);
		expect([...seen].sort()).toEqual(["sq0/r", "sq1/r", "sq2/r", "sq3/r", "sq4/r"]);
		const viaQuery = await master(t).query(api.githubOwnerBinding.listUnprovenMappings, { limit: 2 });
		expect(viaQuery.items.length).toBe(2);
		expect(viaQuery.nextCursor).not.toBeNull();
		const all = await master(t).query(api.githubOwnerBinding.listUnprovenMappings, {});
		expect(all.items.length).toBe(5);
		expect(all.nextCursor).toBeNull();
	});
});

describe("a revoked binding stops routing (it stays REPORTED)", () => {
	const NOTE = "Fixed the defect in commit abcdef1234567 with regression test, 3/3 pass";
	const upsert = (t: T, n: number) =>
		t.mutation(internal.issues.upsertFromGitHub, {
			repo: "org-a/repo",
			issueNumber: n,
			title: "t",
			body: "b",
			htmlUrl: "https://example.test/x",
			labels: [],
			status: "open",
			githubCreatedAt: 1,
			githubUpdatedAt: 1,
		});
	const issueOf = (t: T, n: number) =>
		t.run(async (ctx) =>
			ctx.db.query("issues").withIndex("by_repo_number", (q) => q.eq("repo", "org-a/repo").eq("issueNumber", n)).unique(),
		);
	// The verified writer of a binding is not part of this change, so the proof
	// row is seeded directly: a (re-)bind is an active row for org-a's owner.
	const bind = async (t: T, installationId: number) => {
		await t.run(async (ctx) => {
			const current = await ctx.db
				.query("githubOwnerBindings")
				.withIndex("by_owner", (q) => q.eq("owner", "org-a"))
				.first();
			if (current !== null) {
				await ctx.db.patch(current._id, { installationId, active: true, boundAt: Date.now() });
				return;
			}
			await ctx.db.insert("githubOwnerBindings", {
				owner: "org-a",
				orgId: "org-a",
				installationId,
				accountType: "Organization",
				githubUserLogin: "octocat",
				boundBy: "admin-org-a",
				boundAt: Date.now(),
				active: true,
			});
		});
		return { ok: true as const };
	};
	const autoLink = async (t: T) => {
		const c = member(t, "org-a");
		const id = await c.mutation(api.tasks.create, {
			title: "Fix thing #5",
			assignedTo: ORCH,
			priority: "high",
			status: "todo",
			createdBy: ORCH,
			project: "pa",
		});
		await c.mutation(api.tasks.complete, { taskId: id, callerOrchestrator: ORCH, completionNote: NOTE });
	};
	const webhook = (t: T, event: string, body: Record<string, unknown>) => {
		const raw = JSON.stringify(body);
		return t.fetch("/github/webhook", {
			method: "POST",
			headers: { "content-type": "application/json", "x-github-event": event, "x-hub-signature-256": signGithubBody(raw) },
			body: raw,
		});
	};
	const setup = async (t: T) => {
		await seed(t, { bind: false });
		await t.run(async (ctx) => {
			await ctx.db.insert("taskClosureConfig", { key: "billableProjects", value: [], updatedAt: 0 });
		});
		expect((await bind(t, 11)).ok).toBe(true);
		expect(await addMapping(member(t, "org-a"), "org-a/repo")).not.toBeInstanceOf(Error);
		await t.run(async (ctx) => {
			const m = await ctx.db.query("githubRepoMapping").withIndex("by_repo", (q) => q.eq("repo", "org-a/repo")).unique();
			if (m) await ctx.db.patch(m._id, { project: "pa" });
			await ctx.db.insert("issues", {
				repo: "org-a/repo", issueNumber: 5, title: "i", body: "", htmlUrl: "https://example.test/5", labels: [],
				status: "open", priority: "medium", assignedOrchestrator: ORCH, project: "pa",
				githubCreatedAt: 1, githubUpdatedAt: 1, orgId: "org-a",
				clerkOrgId: testClerkOrgId("org-a"),
			});
		});
	};

	test("bound: routes; installation deleted: nothing reaches org-a's rows, add refused, still listed; re-bind restores", async () => {
		vi.stubEnv("GITHUB_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
		const t = makeT();
		await setup(t);
		// routed while bound
		await autoLink(t);
		expect((await issueOf(t, 5))?.status).toBe("fixed");
		await upsert(t, 9);
		expect((await issueOf(t, 9))?.orgId).toBe("org-a");

		// the installation is deleted (HMAC-verified webhook)
		expect((await webhook(t, "installation", { action: "deleted", installation: { id: 11 } })).status).toBe(200);
		await t.run(async (ctx) => {
			const i = await ctx.db
				.query("issues")
				.withIndex("by_repo_number", (q) => q.eq("repo", "org-a/repo").eq("issueNumber", 5))
				.unique();
			if (i) await ctx.db.patch(i._id, { status: "open", linkedTaskIds: [], fixedBy: undefined, fixedAt: undefined, fixCommits: undefined });
		});
		const before = await issueOf(t, 5);
		await autoLink(t);
		expect(await issueOf(t, 5)).toEqual(before); // auto-link no longer reaches it
		const err = await upsert(t, 10).catch((e: unknown) => e);
		expect((err as ConvexError<string>).message).toContain("MAPPING_UNPROVEN");
		expect(await issueOf(t, 10)).toBeNull();
		// webhook routing for the repo stops: no issue row, no task
		const tasksBefore = await t.run(async (ctx) => (await ctx.db.query("tasks").collect()).length);
		const res = await webhook(t, "issues", {
			action: "opened",
			repository: { full_name: "org-a/repo" },
			issue: { number: 11, title: "t", body: "b", html_url: "https://example.test/11", labels: [], created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", user: { login: "u" } },
		});
		expect(await res.text()).toContain("unproven");
		expect(await issueOf(t, 11)).toBeNull();
		expect(await t.run(async (ctx) => (await ctx.db.query("tasks").collect()).length)).toBe(tasksBefore);
		// a new add is refused; the row is still REPORTED
		denied(await addMapping(member(t, "org-a"), "org-a/second"), "github-owner-not-bound");
		const listed = await master(t).query(api.githubOwnerBinding.listUnprovenMappings, {});
		expect(listed.items.map((r) => [r.repo, r.reason])).toEqual([["org-a/repo", "owner-not-bound"]]);

		// re-bind restores routing
		expect((await bind(t, 12)).ok).toBe(true);
		await autoLink(t);
		expect((await issueOf(t, 5))?.status).toBe("fixed");
		await upsert(t, 12);
		expect((await issueOf(t, 12))?.orgId).toBe("org-a");
		expect(await master(t).query(api.githubOwnerBinding.listUnprovenMappings, {})).toEqual({ items: [], nextCursor: null });
	});

	test("deploy-task routing: a cron-closed deploy task stops using an unproven mapping's deploy state", async () => {
		const t = makeT();
		await setup(t);
		await t.run(async (ctx) => {
			const m = await ctx.db.query("githubRepoMapping").withIndex("by_repo", (q) => q.eq("repo", "org-a/repo")).unique();
			if (m) await ctx.db.patch(m._id, { lastDeployedAt: Date.now() + 60_000, lastDeployedSHA: "a-sha" });
		});
		await t.mutation(internal.githubOwnerBinding.deactivateInstallation, { installationId: 11 });
		const id = await member(t, "org-a").mutation(api.tasks.create, {
			title: "[Deploy] PR #3 merged — deploy pa to prod",
			assignedTo: ORCH,
			priority: "low",
			status: "todo",
			createdBy: ORCH,
		});
		await t.mutation(internal.tasks.resolveStaleDeployTasks, {});
		expect((await t.run(async (ctx) => ctx.db.get(id)))?.status).toBe("todo");
	});

	test("unsuspend does NOT reactivate: re-binding is required", async () => {
		vi.stubEnv("GITHUB_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
		const t = makeT();
		await setup(t);
		await webhook(t, "installation", { action: "suspend", installation: { id: 11 } });
		expect((await webhook(t, "installation", { action: "unsuspend", installation: { id: 11 } })).status).toBe(200);
		denied(await addMapping(member(t, "org-a"), "org-a/second"), "github-owner-not-bound");
		expect((await bind(t, 11)).ok).toBe(true);
		expect(await addMapping(member(t, "org-a"), "org-a/second")).not.toBeInstanceOf(Error);
	});
});
