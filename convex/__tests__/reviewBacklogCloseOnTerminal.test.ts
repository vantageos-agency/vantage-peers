/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// reviewBacklogCloseOnTerminal.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Task k17bh19d6zzf73417j6a9623nn8dh8ek (Pi) — review rows never reaching a
// terminal state when their PR merges/closes.
//
// TWO independent lineages mint review rows for the same conceptual step:
//   - "automation" — internal.tasks.createOrUpdateReviewTask (GitHub-webhook
//     PR-sync), title "[Review] <repo> PR #<n>: <prTitle>", origin:
//     "automation". This row carries a reliable PR link EMBEDDED IN THE
//     TITLE (repoFullName + prNumber) — closeReviewTasksForPr keys on that,
//     parsed via parseReviewTitle, never on `createdBy`/`origin`.
//   - "bootstrap" — the IRP mission-template "Code Review" step
//     (missionTemplates.ts), created via convex/http.ts's issues.opened
//     cascade. Title "[#<issueNumber>] T<i> — Code Review", tags include
//     "review" (so isReviewTask is true), assignedTo the orchestrator (not
//     "eta"). CONFIRMED BY INVESTIGATION: this row carries NO repoFullName /
//     prNumber field and NO "PR #<n>" substring in its title anywhere — it
//     links only to a GitHub ISSUE (via missionId), never to a PR. Its
//     actual closer is issueClosedSweepDb.cascadeCloseMission, fired by the
//     issueClosedSweep cron when the linked GH ISSUE (not PR) closes — a
//     DIFFERENT terminal signal than this suite is about.
//
// Because the bootstrap row has no PR link, closeReviewTasksForPr correctly
// (and necessarily) does NOT touch it on a PR-closed event — there is no
// link to key on. That is not a defect in the closer; it is the STOP
// condition the brief called out ("if the bootstrap rows carry NO reliable
// PR link at all, STOP and report"). This suite documents that boundary
// with an explicit assertion (not a TODO) so a future change that adds a
// second sweep mechanism has a pinned baseline to diff against.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createTestConvex = () => convexTest(schema, modules);

const reviewArgs = (
	repoFullName: string,
	prNumber: number,
	prTitle: string,
) => ({
	repoFullName,
	prNumber,
	prTitle,
	description: `Review needed for PR #${prNumber}`,
	assignedTo: "eta",
	project: repoFullName,
	priority: "high" as const,
	createdBy: "system" as const,
	tags: ["github", "pr-review"],
});

async function insertBootstrapCodeReviewRow(
	t: ReturnType<typeof createTestConvex>,
	issueNumber: number,
) {
	return await t.run(async (ctx) => {
		const missionId = await ctx.db.insert("missions", {
			name: `Fix #${issueNumber} — bug`,
			project: "elpiarthera/vantage-memory",
			pilot: "sigma",
			priority: "high",
			createdBy: "system",
			agents: ["sigma"],
			status: "execute",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const taskId = await ctx.db.insert("tasks", {
			title: `[#${issueNumber}] T8 — Code Review`,
			description: "Run the code-reviewer agent on the diff.",
			project: "elpiarthera/vantage-memory",
			assignedTo: "sigma",
			priority: "high",
			status: "todo",
			createdBy: "system",
			missionId,
			tags: ["review", "quality", "github", "irp"],
			isReviewTask: true,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		return { missionId, taskId };
	});
}

describe("RED-before — a merged PR leaves rows OPEN across both lineages (pinned baseline)", () => {
	test("automation row is OPEN before closeReviewTasksForPr runs", async () => {
		const t = createTestConvex();
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-memory", 2001, "fix: close review rows"),
		);
		const all = await t.run(async (ctx) => ctx.db.query("tasks").collect());
		expect(all[0].status).toBe("todo");
	});

	test("bootstrap row is OPEN and has NO PR link at all (no field, no title substring)", async () => {
		const t = createTestConvex();
		const { taskId } = await insertBootstrapCodeReviewRow(t, 2001);
		const row = await t.run(async (ctx) => ctx.db.get(taskId));
		expect(row?.status).toBe("todo");
		expect(row?.title).not.toMatch(/PR #\d+/);
		expect((row as unknown as { repoFullName?: string }).repoFullName).toBeUndefined();
		expect((row as unknown as { prNumber?: number }).prNumber).toBeUndefined();
	});
});

describe("GREEN — closeReviewTasksForPr closes the automation-lineage row, keyed on the row's title-embedded PR link", () => {
	test("closes the row and carries the merge commit sha on completionNote", async () => {
		const t = createTestConvex();
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-memory", 2002, "fix: close review rows"),
		);

		const result = await t.mutation(internal.tasks.closeReviewTasksForPr, {
			repoFullName: "elpiarthera/vantage-memory",
			prNumber: 2002,
			completionNote: "[PR-MERGED] https://github.com/elpiarthera/vantage-memory/pull/2002",
			mergeCommitSha: "abc1234def5678901234567890abcdef1234567",
		});
		expect(result.closed).toBe(1);

		const all = await t.run(async (ctx) => ctx.db.query("tasks").collect());
		expect(all[0].status).toBe("done");
		expect(all[0].completionOutcome).toBe("succeeded");
		expect(all[0].completionNote).toContain("abc1234def5678901234567890abcdef1234567");
	});

	test("does NOT close a bootstrap row for the SAME issue/PR pairing — no link exists to key on", async () => {
		const t = createTestConvex();
		await insertBootstrapCodeReviewRow(t, 2003);
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-memory", 2003, "fix: pr for issue #2003"),
		);

		await t.mutation(internal.tasks.closeReviewTasksForPr, {
			repoFullName: "elpiarthera/vantage-memory",
			prNumber: 2003,
			completionNote: "[PR-MERGED] closed",
		});

		const all = await t.run(async (ctx) => ctx.db.query("tasks").collect());
		const automationRow = all.find((r) => r.title.includes("PR #2003"));
		const bootstrapRow = all.find((r) => r.title.includes("Code Review"));
		expect(automationRow?.status).toBe("done");
		// Pinned STOP condition: bootstrap lineage is untouched by this closer.
		expect(bootstrapRow?.status).toBe("todo");
	});

	test("does NOT close a row whose PR is still OPEN", async () => {
		const t = createTestConvex();
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-memory", 2004, "still in review"),
		);

		const result = await t.mutation(internal.tasks.closeReviewTasksForPr, {
			repoFullName: "elpiarthera/vantage-memory",
			prNumber: 2005, // different PR — 2004 is still open
			completionNote: "[PR-MERGED] closed",
		});
		expect(result.closed).toBe(0);

		const all = await t.run(async (ctx) => ctx.db.query("tasks").collect());
		expect(all[0].status).toBe("todo");
	});

	test("a row already closed by hand STAYS closed — not reopened or duplicated", async () => {
		const t = createTestConvex();
		const taskId = await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-memory", 2006, "hand-closed"),
		);
		await t.run(async (ctx) =>
			ctx.db.patch(taskId, {
				status: "done" as const,
				completionOutcome: "succeeded" as const,
				completedAt: Date.now(),
				updatedAt: Date.now(),
				completionNote: "[MANUAL] closed by hand before webhook fired",
			}),
		);

		const result = await t.mutation(internal.tasks.closeReviewTasksForPr, {
			repoFullName: "elpiarthera/vantage-memory",
			prNumber: 2006,
			completionNote: "[PR-MERGED] webhook close attempt",
		});
		expect(result.closed).toBe(0); // findOpenReviewTasks excludes "done"

		const all = await t.run(async (ctx) => ctx.db.query("tasks").collect());
		expect(all.length).toBe(1); // no duplicate row
		expect(all[0].completionNote).toBe("[MANUAL] closed by hand before webhook fired");
	});
});

describe("IDEMPOTENCE — the same webhook delivered twice changes nothing the second time", () => {
	test("second closeReviewTasksForPr call for the same PR has delta zero", async () => {
		const t = createTestConvex();
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-memory", 2007, "idempotence check"),
		);

		const first = await t.mutation(internal.tasks.closeReviewTasksForPr, {
			repoFullName: "elpiarthera/vantage-memory",
			prNumber: 2007,
			completionNote: "[PR-MERGED] first delivery",
		});
		expect(first.closed).toBe(1);

		const before = await t.run(async (ctx) => ctx.db.query("tasks").collect());

		const second = await t.mutation(internal.tasks.closeReviewTasksForPr, {
			repoFullName: "elpiarthera/vantage-memory",
			prNumber: 2007,
			completionNote: "[PR-MERGED] second delivery (duplicate webhook)",
		});
		expect(second.closed).toBe(0); // delta zero

		const after = await t.run(async (ctx) => ctx.db.query("tasks").collect());
		expect(after.length).toBe(before.length);
		// The first delivery's note is preserved — the duplicate delivery did
		// not re-patch the row.
		expect(after[0].completionNote).toBe("[PR-MERGED] first delivery");
	});
});

describe("listReviewBacklogByLineage — backlog-sweep support query splits rows by PR-linkage", () => {
	test("automation rows carry repoFullName/prNumber; bootstrap rows are reported separately with none", async () => {
		const t = createTestConvex();
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-memory", 2008, "sweep target"),
		);
		await insertBootstrapCodeReviewRow(t, 2009);

		const backlog = await t.query(internal.tasks.listReviewBacklogByLineage, {});

		expect(backlog.automation).toHaveLength(1);
		expect(backlog.automation[0].repoFullName).toBe("elpiarthera/vantage-memory");
		expect(backlog.automation[0].prNumber).toBe(2008);

		expect(backlog.bootstrapNoPrLink).toHaveLength(1);
		expect(backlog.bootstrapNoPrLink[0].title).toContain("Code Review");
	});
});
