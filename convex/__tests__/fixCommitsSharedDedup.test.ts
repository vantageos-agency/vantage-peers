/// <reference types="vite/client" />
/**
 * One shared commit-identity rule for both writers of issues.fixCommits
 * (tasks k1786wcr1w5qndnpw92dwsz6ps8hfrct, k178dnwj26rdwxvqgsfyxqm0ns8hfae5):
 *   - issues:linkCommit refuses a commitSha that is not 7-40 hex (INVALID_COMMIT_SHA),
 *     and applies the prefix rule only between values of >= 7 chars;
 *   - tasks:complete appends the SHA cited in the completion note once, never twice.
 *
 * Poles: REFUSED ("ab", non-hex, 41 chars), DUPLICATE (7-char prefix of a stored full SHA,
 * task close citing a stored SHA), DISTINCT (two different 7-char SHAs, a new SHA on close).
 */
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { api } from "../_generated/api";
import { appendCommit, normaliseCommitSha, sameCommit } from "../lib/commitSha";
import schema from "../schema";
import { seedFleetAgents } from "../../tests/lib/seedFleetAgents";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const FULL = "abcdef1234567abcdef1234567abcdef1234567";
const key = { repo: "acme/widgets", issueNumber: 7 };

function setup(fixCommits?: string[]) {
	const t = convexTest(schema, modules);
	const svc = t.withIdentity({ subject: "test-service-account-user-id" } as Parameters<
		typeof t.withIdentity
	>[0]);
	const seed = async () => {
		await seedFleetAgents(t, ["sigma"]);
		return t.run(async (ctx) => {
			await ctx.db.insert("taskClosureConfig", { key: "billableProjects", value: [], updatedAt: 0 });
			await ctx.db.insert("githubRepoMapping", {
				repo: key.repo,
				orchestrator: "sigma",
				project: "widgets",
				active: true,
			});
			return ctx.db.insert("issues", {
				...key,
				title: "seed",
				body: "",
				htmlUrl: "https://github.com/acme/widgets/issues/7",
				labels: [],
				status: "open",
				priority: "medium",
				assignedOrchestrator: "sigma",
				project: "widgets",
				githubCreatedAt: 1,
				githubUpdatedAt: 1,
				...(fixCommits ? { fixCommits } : {}),
			});
		});
	};
	return { t, svc, seed };
}

async function closeCiting(svc: ReturnType<typeof setup>["svc"], note: string) {
	const taskId = await svc.mutation(api.tasks.create, {
		title: "Fix thing #7",
		assignedTo: "sigma",
		priority: "high",
		status: "todo",
		createdBy: "sigma",
		project: "widgets",
	});
	await svc.mutation(api.tasks.complete, { taskId, callerOrchestrator: "sigma", completionNote: note });
}

describe("issues:linkCommit refuses a malformed SHA", () => {
	for (const bad of ["ab", "abcdef", "zzzzzzzz", "a".repeat(41), "   ", ""]) {
		test(`REFUSED: ${JSON.stringify(bad)} names INVALID_COMMIT_SHA and the door; the row is untouched`, async () => {
			const { t, svc, seed } = setup(["abcdef1234567"]);
			const id = await seed();
			const before = await t.run((c) => c.db.get(id));
			const err = await svc
				.mutation(api.issues.linkCommit, { ...key, commitSha: bad, fixedBy: "sigma" })
				.then(
					() => null,
					(e: unknown) => e as { data?: unknown },
				);
			expect(err).not.toBeNull();
			expect(String(err?.data)).toContain("INVALID_COMMIT_SHA");
			expect(String(err?.data)).toContain("issues:linkCommit");
			expect(await t.run((c) => c.db.get(id))).toEqual(before);
		});
	}

	test("DUPLICATE: a 7-char prefix of a stored full SHA still dedups", async () => {
		const { t, svc, seed } = setup([FULL]);
		const id = await seed();
		await svc.mutation(api.issues.linkCommit, { ...key, commitSha: FULL.slice(0, 7), fixedBy: "sigma" });
		expect((await t.run((c) => c.db.get(id)))?.fixCommits).toEqual([FULL]);
	});

	test("DISTINCT: two different 7-char SHAs are both stored", async () => {
		const { t, svc, seed } = setup();
		const id = await seed();
		await svc.mutation(api.issues.linkCommit, { ...key, commitSha: "abcdef1", fixedBy: "sigma" });
		await svc.mutation(api.issues.linkCommit, { ...key, commitSha: "abcdef2", fixedBy: "sigma" });
		expect((await t.run((c) => c.db.get(id)))?.fixCommits).toEqual(["abcdef1", "abcdef2"]);
	});
});

describe("tasks:complete appends the cited SHA once", () => {
	test("DUPLICATE: closing a task that cites a stored SHA leaves [X]", async () => {
		const { t, svc, seed } = setup(["abcdef1234567"]);
		const id = await seed();
		await closeCiting(svc, "Fixed in commit abcdef1234567, 3/3 tests pass");
		const row = await t.run((c) => c.db.get(id));
		expect(row?.status).toBe("fixed");
		expect(row?.fixCommits).toEqual(["abcdef1234567"]);
	});

	test("DUPLICATE: citing the 7-char prefix of a stored full SHA leaves the full SHA only", async () => {
		const { t, svc, seed } = setup([FULL]);
		const id = await seed();
		await closeCiting(svc, `Fixed in commit ${FULL.slice(0, 7)}, 3/3 tests pass`);
		expect((await t.run((c) => c.db.get(id)))?.fixCommits).toEqual([FULL]);
	});

	test("DISTINCT: a new SHA Y is appended once", async () => {
		const { t, svc, seed } = setup(["abcdef1234567"]);
		const id = await seed();
		await closeCiting(svc, "Fixed in commit 1234567abcdef, 3/3 tests pass");
		expect((await t.run((c) => c.db.get(id)))?.fixCommits).toEqual(["abcdef1234567", "1234567abcdef"]);
	});
});

describe("commitSha helper", () => {
	test("normaliseCommitSha: 7-40 hex only, trimmed and lowercased", () => {
		expect(normaliseCommitSha("  ABCDEF1\n")).toBe("abcdef1");
		expect(normaliseCommitSha("abcdef")).toBeNull();
		expect(normaliseCommitSha("a".repeat(41))).toBeNull();
		expect(normaliseCommitSha("xyz1234")).toBeNull();
	});
	test("sameCommit: prefix only at >= 7 chars", () => {
		expect(sameCommit("abcdef1", FULL)).toBe(true);
		expect(sameCommit("ab", "abcdef1234567")).toBe(false);
		expect(sameCommit("abcdef1", "abcdef2")).toBe(false);
	});
	test("appendCommit returns the same array when the commit is present", () => {
		const stored = ["abcdef1234567"];
		expect(appendCommit(stored, "abcdef1")).toBe(stored);
		expect(appendCommit(stored, "1234567")).toEqual(["abcdef1234567", "1234567"]);
	});
});
