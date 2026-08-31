"use node";
//
// reviewBacklogSweep — one-time backlog closer for dead "[Review]" rows
// (task k17bh19d6zzf73417j6a9623nn8dh8ek, Pi).
//
// Scope: this sweep closes ONLY the "automation" lineage — review rows whose
// title parses to "[Review] <repoFullName> PR #<prNumber>: …"
// (internal.tasks.createOrUpdateReviewTask's format). Those rows carry a
// reliable PR link (repoFullName + prNumber embedded in the title) and their
// terminal state can be verified against the GitHub REST API.
//
// The "bootstrap" lineage (the IRP mission-template "Code Review" step,
// missionTemplates.ts — title "[#<issueNumber>] T<i> — Code Review", tagged
// "review") is DELIBERATELY NOT swept here. Investigation (see
// convex/tasks.ts's listReviewBacklogByLineage doc comment) found these rows
// carry NO reliable PR link at all — no repoFullName/prNumber field, no PR
// number embedded in the title, only a GitHub ISSUE number via missionId. A
// PR-terminal-state sweep cannot key on a link that does not exist. Their
// existing closer is issueClosedSweepDb.cascadeCloseMission (triggered when
// the linked GH ISSUE itself closes, a DIFFERENT terminal signal). This
// sweep counts bootstrap rows and reports them as skipped-no-pr-link; it
// does not close them.
//
// Run on DEV only (never prod) via:
//   npx convex run reviewBacklogSweep:sweepReviewBacklog --once
//

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

type ByLineageCount = {
	before: number;
	closed: number;
	remaining: number;
};

type SweepResult = {
	automation: ByLineageCount;
	bootstrapSkippedNoPrLink: number;
	errors: number;
};

// Bound the fan-out of GitHub API calls in a single sweep run.
const SWEEP_ROW_FANOUT_CAP = 500;

export const sweepReviewBacklog = internalAction({
	args: {},
	returns: v.object({
		automation: v.object({
			before: v.number(),
			closed: v.number(),
			remaining: v.number(),
		}),
		bootstrapSkippedNoPrLink: v.number(),
		errors: v.number(),
	}),
	handler: async (ctx): Promise<SweepResult> => {
		const githubToken = process.env.GITHUB_TOKEN;
		const backlog = await ctx.runQuery(
			internal.tasks.listReviewBacklogByLineage,
			{},
		);

		const automationBefore = backlog.automation.length;
		const bootstrapSkippedNoPrLink = backlog.bootstrapNoPrLink.length;
		let closed = 0;
		let errors = 0;

		const rows = backlog.automation.slice(0, SWEEP_ROW_FANOUT_CAP);

		for (const row of rows) {
			try {
				if (!githubToken) {
					console.log(
						`[reviewBacklogSweep] no GITHUB_TOKEN — skipping ${row.repoFullName}#${row.prNumber}`,
					);
					continue;
				}
				const [owner, repo] = row.repoFullName.split("/");
				const resp = await fetch(
					`https://api.github.com/repos/${owner}/${repo}/pulls/${row.prNumber}`,
					{
						headers: {
							Authorization: `Bearer ${githubToken}`,
							Accept: "application/vnd.github.v3+json",
						},
					},
				);
				if (!resp.ok) {
					console.log(
						`[reviewBacklogSweep] GH API ${row.repoFullName}#${row.prNumber} returned ${resp.status}`,
					);
					errors++;
					continue;
				}
				const pr = (await resp.json()) as {
					state: string;
					merged: boolean;
					merge_commit_sha?: string | null;
				};
				if (pr.state !== "closed") {
					continue; // PR still open — must NOT be closed by the sweep.
				}
				const note = pr.merged
					? `[PR-MERGED] backlog sweep — ${row.repoFullName} PR #${row.prNumber}`
					: `[PR-CLOSED-NO-MERGE] backlog sweep — ${row.repoFullName} PR #${row.prNumber}`;
				const result = await ctx.runMutation(
					internal.tasks.closeReviewTasksForPr,
					{
						repoFullName: row.repoFullName,
						prNumber: row.prNumber,
						completionNote: note,
						mergeCommitSha: pr.merged ? pr.merge_commit_sha ?? undefined : undefined,
					},
				);
				closed += result.closed;
			} catch (err) {
				console.error(
					`[reviewBacklogSweep] error for ${row.repoFullName}#${row.prNumber}: ${err}`,
				);
				errors++;
			}
		}

		const after = await ctx.runQuery(
			internal.tasks.listReviewBacklogByLineage,
			{},
		);

		console.log(
			`[reviewBacklogSweep] automation before=${automationBefore} closed=${closed} remaining=${after.automation.length} bootstrapSkippedNoPrLink=${bootstrapSkippedNoPrLink} errors=${errors}`,
		);

		return {
			automation: {
				before: automationBefore,
				closed,
				remaining: after.automation.length,
			},
			bootstrapSkippedNoPrLink,
			errors,
		};
	},
});
