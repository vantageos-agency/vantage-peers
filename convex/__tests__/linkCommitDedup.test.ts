/// <reference types="vite/client" />
/**
 * issues:linkCommit must not duplicate a fix commit (task k17adacqev89cc8pzkgaz5fn9s8hdee0).
 *
 * Identity rule: two SHAs are the same commit when, trimmed and lowercased, one is a
 * prefix of the other. A short SHA therefore matches a stored full SHA and vice versa.
 *
 * Poles: DUPLICATE (exact, case, whitespace, short-of-full, full-of-short) stays one entry;
 * DISTINCT shas both kept in order; fixedBy is still refreshed on a repeat.
 */
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const FULL = "abc1234def5678abc1234def5678abc1234def56";
const key = { repo: "acme/widgets", issueNumber: 42 };

function setup() {
	const t = convexTest(schema, modules);
	const master = t.withIdentity({ subject: "test-service-account-user-id" } as Parameters<
		typeof t.withIdentity
	>[0]);
	const seed = () =>
		t.run((ctx) =>
			ctx.db.insert("issues", {
				...key,
				title: "seed",
				body: "b",
				htmlUrl: "https://github.com/acme/widgets/issues/42",
				labels: [],
				status: "open",
				priority: "medium",
				assignedOrchestrator: "sigma",
				project: "widgets",
				githubCreatedAt: 1,
				githubUpdatedAt: 1,
			}),
		);
	return { t, master, seed };
}

describe("issues:linkCommit dedup", () => {
	test("DUPLICATE: the same SHA linked twice is one entry", async () => {
		const { t, master, seed } = setup();
		const id = await seed();
		await master.mutation(api.issues.linkCommit, { ...key, commitSha: "abc1234", fixedBy: "sigma" });
		await master.mutation(api.issues.linkCommit, { ...key, commitSha: "abc1234", fixedBy: "sigma" });
		expect((await t.run((c) => c.db.get(id)))?.fixCommits).toEqual(["abc1234"]);
	});

	test("DUPLICATE: case and surrounding whitespace do not make a new entry", async () => {
		const { t, master, seed } = setup();
		const id = await seed();
		await master.mutation(api.issues.linkCommit, { ...key, commitSha: "abc1234", fixedBy: "sigma" });
		await master.mutation(api.issues.linkCommit, { ...key, commitSha: "  ABC1234\n", fixedBy: "sigma" });
		expect((await t.run((c) => c.db.get(id)))?.fixCommits).toEqual(["abc1234"]);
	});

	test("DUPLICATE: a short SHA of a stored full SHA, and a full SHA of a stored short one", async () => {
		const { t, master, seed } = setup();
		const id = await seed();
		await master.mutation(api.issues.linkCommit, { ...key, commitSha: FULL, fixedBy: "sigma" });
		await master.mutation(api.issues.linkCommit, { ...key, commitSha: FULL.slice(0, 7), fixedBy: "sigma" });
		expect((await t.run((c) => c.db.get(id)))?.fixCommits).toEqual([FULL]);
		await master.mutation(api.issues.linkCommit, { ...key, commitSha: "9999999", fixedBy: "sigma" });
		await master.mutation(api.issues.linkCommit, {
			...key,
			commitSha: `9999999${"0".repeat(33)}`,
			fixedBy: "sigma",
		});
		expect((await t.run((c) => c.db.get(id)))?.fixCommits).toEqual([FULL, "9999999"]);
	});

	test("DISTINCT: different SHAs are both kept, in order; a repeat still refreshes fixedBy", async () => {
		const { t, master, seed } = setup();
		const id = await seed();
		await master.mutation(api.issues.linkCommit, { ...key, commitSha: "abc1234", fixedBy: "alpha" });
		await master.mutation(api.issues.linkCommit, { ...key, commitSha: "def5678", fixedBy: "beta" });
		await master.mutation(api.issues.linkCommit, { ...key, commitSha: "abc1234", fixedBy: "gamma" });
		const row = await t.run((c) => c.db.get(id));
		expect(row?.fixCommits).toEqual(["abc1234", "def5678"]);
		expect(row?.fixedBy).toBe("gamma");
	});
});
