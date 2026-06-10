"use node";
//
// PR C — (c1) Issue-closed external sweep
//
// Problem: GH issue closed externally (manual `gh issue close`) → linked IRP
// missions + T0..T12 cascade tasks stay zombie in VP.
//
// Fix: This node-runtime action:
//   1. Lists active missions that have a GH issue ref in their brief or name.
//   2. For each, fetches the GH issue state via GitHub REST API.
//   3. If state="closed", cascade-closes: updates mission status to "complete"
//      + completes all child tasks with VOID note "issue-closed-externally".
//
// Wired as a 6h cron in convex/crons.ts.
//
// NOTE: cascadeCloseMission + listActiveMissionsForSweep live in
// issueClosedSweepDb.ts (no "use node" — Convex rule: node files = actions only).
//

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type SweepResult = {
	scanned: number;
	closed: number;
	skipped: number;
	errors: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseGitHubIssueRef(
	text: string,
): { owner: string; repo: string; issueNumber: number } | null {
	const urlMatch = text.match(
		/https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)/,
	);
	if (urlMatch) {
		return {
			owner: urlMatch[1],
			repo: urlMatch[2],
			issueNumber: parseInt(urlMatch[3], 10),
		};
	}
	return null;
}

async function fetchGitHubIssueState(
	owner: string,
	repo: string,
	issueNumber: number,
	githubToken: string | undefined,
): Promise<"open" | "closed" | null> {
	const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (githubToken) {
		headers["Authorization"] = `Bearer ${githubToken}`;
	}

	const response = await fetch(url, { headers });

	if (!response.ok) {
		console.warn(
			`[issueClosedSweep] GH API ${url} returned ${response.status}`,
		);
		return null;
	}

	const data = (await response.json()) as { state?: string };
	if (data.state === "closed") return "closed";
	if (data.state === "open") return "open";
	return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main sweep action — node runtime for fetch()
// ─────────────────────────────────────────────────────────────────────────────

export const sweepIssueClosed = internalAction({
	args: {},
	returns: v.object({
		scanned: v.number(),
		closed: v.number(),
		skipped: v.number(),
		errors: v.number(),
	}),
	handler: async (ctx): Promise<SweepResult> => {
		const githubToken = process.env.GITHUB_TOKEN;

		const missions = (await ctx.runMutation(
			internal.issueClosedSweepDb.listActiveMissionsForSweep,
			{},
		)) as Array<{
			_id: Id<"missions">;
			name: string;
			brief?: string;
			status: string;
		}>;

		let scanned = 0;
		let closed = 0;
		let skipped = 0;
		let errors = 0;

		for (const mission of missions) {
			const textToSearch = [mission.brief, mission.name]
				.filter(Boolean)
				.join(" ");
			const ref = parseGitHubIssueRef(textToSearch);

			if (!ref) {
				skipped++;
				continue;
			}

			scanned++;

			const issueRef = `https://github.com/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}`;

			let state: "open" | "closed" | null;
			try {
				state = await fetchGitHubIssueState(
					ref.owner,
					ref.repo,
					ref.issueNumber,
					githubToken,
				);
			} catch (err) {
				console.error(
					`[issueClosedSweep] fetch error for ${issueRef}: ${err}`,
				);
				errors++;
				continue;
			}

			if (state === null) {
				errors++;
				continue;
			}

			if (state === "open") {
				continue;
			}

			try {
				await ctx.runMutation(internal.issueClosedSweepDb.cascadeCloseMission, {
					missionId: mission._id,
					issueRef,
				});
				closed++;
				console.log(
					`[issueClosedSweep] closed mission ${mission._id} (issue ${issueRef})`,
				);
			} catch (err) {
				console.error(
					`[issueClosedSweep] cascade close error for mission ${mission._id}: ${err}`,
				);
				errors++;
			}
		}

		console.log(
			`[issueClosedSweep] sweep complete scanned=${scanned} closed=${closed} skipped=${skipped} errors=${errors}`,
		);

		return { scanned, closed, skipped, errors };
	},
});
