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

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

type ByLineageCount = {
	before: number;
	closed: number;
	remaining: number;
};

type SweepResult = {
	automation: ByLineageCount;
	bootstrapSkippedNoPrLink: number;
	errors: number;
	// True when the automation backlog exceeded SWEEP_ROW_FANOUT_CAP and this run
	// processed only the first cap rows. Survivable — `remaining` is re-derived
	// from a fresh query after the sweep, so a follow-up run drains the rest — but
	// the result must SAY it truncated, never let a capped run read like a
	// complete one (Eta REVISE, measurement-integrity §4: absence of signal is an
	// event, not a silent default).
	fanoutCapped: boolean;
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
		fanoutCapped: v.boolean(),
	}),
	handler: async (ctx): Promise<SweepResult> => {
		const githubToken = process.env.GITHUB_TOKEN;
		// REFUSE BEFORE THE LOOP (Eta REVISE): a missing credential is not a
		// per-row condition — it means this sweep CANNOT LOOK at a single PR, so it
		// must not return a result at all. Returning {closed:0, errors:0} here is
		// byte-identical to a run that authenticated fine and found every PR still
		// open; the operator reads a clean run and the dead rows stay — the exact
		// failure k17bh19d6zzf73417j6a9623nn8dh8ek exists to end. A run that cannot
		// measure throws loudly (three-state-verdict.md; measurement-integrity §3),
		// never a silent zero, and 500 identical "skipping" log lines is not a
		// refusal.
		if (!githubToken) {
			throw new ConvexError(
				"REFUSING TO SWEEP: no GITHUB_TOKEN — the sweep verifies each PR's terminal state against the GitHub REST API and cannot look without a credential. A run that cannot measure must fail loudly, not return a clean {closed:0,errors:0} indistinguishable from an authenticated run that found every PR still open.",
			);
		}
		const backlog = await ctx.runQuery(
			internal.tasks.listReviewBacklogByLineage,
			{},
		);

		const automationBefore = backlog.automation.length;
		const bootstrapSkippedNoPrLink = backlog.bootstrapNoPrLink.length;
		const fanoutCapped = automationBefore > SWEEP_ROW_FANOUT_CAP;
		let closed = 0;
		let errors = 0;

		const rows = backlog.automation.slice(0, SWEEP_ROW_FANOUT_CAP);

		for (const row of rows) {
			try {
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
						mergeCommitSha: pr.merged
							? (pr.merge_commit_sha ?? undefined)
							: undefined,
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
			`[reviewBacklogSweep] automation before=${automationBefore} closed=${closed} remaining=${after.automation.length} bootstrapSkippedNoPrLink=${bootstrapSkippedNoPrLink} errors=${errors} fanoutCapped=${fanoutCapped}`,
		);

		return {
			automation: {
				before: automationBefore,
				closed,
				remaining: after.automation.length,
			},
			bootstrapSkippedNoPrLink,
			errors,
			fanoutCapped,
		};
	},
});
