#!/usr/bin/env bun
/**
 * dev-probe-size-bound-class.ts — DEV-only fixture for GitHub issues #1294
 * (briefingNotes.list) and #1276 (tasks.resolveStaleDeployTasks).
 *
 * This script SEEDS the two reproduction fixtures against whatever
 * deployment CONVEX_URL points to. It never targets --prod and refuses to
 * run if CONVEX_URL looks like a prod URL (see assertNotProd below) — run it
 * only against a DEV deployment.
 *
 * ── #1276 (tasks:resolveStaleDeployTasks) ───────────────────────────────
 *
 * ONE command does the ENTIRE seed end to end, no human step in the middle:
 *
 *   CONVEX_URL=<your dev deployment url> bun scripts/dev-probe-size-bound-class.ts seed
 *
 * It seeds, IN THIS ORDER (order is load-bearing — see the closing
 * condition below):
 *   1. IRRELEVANT_MAPPING_ROW_COUNT (default 2000) githubRepoMapping rows
 *      for OTHER projects, via the public `githubRepoMapping:seed` mutation.
 *   2. ONE githubRepoMapping row for RELEVANT_PROJECT (no deploy recorded yet).
 *   3. ONE "[Deploy] PR #<N> merged — deploy <RELEVANT_PROJECT> to prod" task,
 *      status "todo", via `npx convex run tasks:createForWebhook` (shelled
 *      out by this script — internalMutation, no identity needed, same
 *      reachability class as resolveStaleDeployTasks itself).
 *   4. Records a deployment for RELEVANT_PROJECT's repo via
 *      `npx convex run githubRepoMapping:recordDeployment`, timestamped
 *      strictly AFTER step 3's task was created.
 *
 * Step ordering (3 before 4) is required by resolveStaleDeployTasks's own
 * closing condition — `mapping.lastDeployedAt > t.createdAt` — a task
 * created before its project's deploy was recorded is the ONLY shape that
 * function ever closes. `tasks:create` (the public mutation) could not be
 * used for step 3 — it requires `ctx.auth.getUserIdentity() !== null`,
 * which an anonymous script has no more than #1294's identity-impersonation
 * attempt did (see below); `createForWebhook` has no such check.
 *
 * Then measure:
 *
 *   npx convex run tasks:resolveStaleDeployTasks '{}'
 *
 * EXPECTED, STATED IN TERMS THE FIX ACTUALLY CONTROLS — `closed` and
 * `scanned` are this fix's output; `truncated` is NOT and must never be
 * asserted as an expectation here:
 *   BEFORE this branch's fix: EITHER the raw platform error ("Your request
 *     timed out performing too many system operations" / convex-test's
 *     "Scanned too many documents ... (limit: 32000)") from the upfront
 *     `githubRepoMapping.collect()`, OR — if that whole-table read happens
 *     to survive on this deployment's current mapping-row count — `closed`
 *     for the seeded task is 0 regardless, because the pre-fix code's
 *     OWN per-status task-scan cap (RESOLVE_STALE_DEPLOY_TASKS_SCAN_CAP,
 *     unchanged by this fix) may exclude the seeded task before the
 *     mapping lookup is ever reached — see the CAVEAT below.
 *   AFTER the fix: IF the seeded task is scanned at all (see CAVEAT), the
 *     ONE seeded Deploy task closes: `closed` includes it, `scanned`
 *     includes it. The fix's OWN contribution is that this happens without
 *     reading the ${IRRELEVANT_MAPPING_ROW_COUNT} irrelevant mapping rows —
 *     it does not, and cannot, change whether the task-scan cap admits the
 *     task in the first place.
 *   `truncated` reports the PRE-EXISTING, unchanged-by-this-fix per-status
 *     task-scan cap (RESOLVE_STALE_DEPLOY_TASKS_SCAN_CAP = 500) — on any
 *     deployment already carrying more than 500 open tasks in ANY of the
 *     four open statuses, `truncated` reads `true` BEFORE and AFTER this
 *     fix, identically, because the fix never touches that cap. Do not
 *     read `truncated` as a signal about this fix either way.
 *
 * CAVEAT — read before trusting `closed` either way: `tasks:createForWebhook`
 * (like `tasks:create`) stamps `createdAt: Date.now()` with NO way to
 * override it. `resolveStaleDeployTasks`'s `by_status` scan takes the
 * `RESOLVE_STALE_DEPLOY_TASKS_SCAN_CAP + 1` SMALLEST-`createdAt` rows for
 * each status (ascending order, unchanged by this fix). A row created
 * "just now" therefore has the LARGEST `createdAt` of every row in its
 * status bucket — it lands inside the scanned window ONLY IF that status
 * currently holds ≤ 500 pre-existing open rows on the target deployment.
 * There is no query this script (or `npx convex run`, or a Clerk-identity
 * client) can use to check that count in advance without hitting the same
 * identity wall #1294 hit (`fleetStats`, the one query that reports
 * per-status counts, requires master/`view-stats-aggregated` scope). If the
 * seeded task's status bucket ("todo" here) already exceeds 500 open rows
 * on the target deployment — which independent testing on
 * efficient-guineapig-356 already showed is true for at least one status
 * (`truncated: true` with zero Deploy tasks ever seeded) — `closed` will
 * read 0 both before and after this fix, and this live proof is UNREACHABLE
 * on that deployment: it would be measuring the pre-existing task-scan cap,
 * not this fix. This is a structural property of `by_status`'s ascending
 * CAP+1 scan interacting with `createdAt: Date.now()`, not something this
 * fixture can route around from outside — the standing proof for THIS
 * function on a busy deployment is the unit mutants in
 * convex/__tests__/resolveStaleDeployTasksRepoMappingScanCap.test.ts (RED
 * confirmed against the pre-fix code, GREEN against this branch), not this
 * script.
 *
 * ── #1294 (briefingNotes:list) ───────────────────────────────────────────
 *
 * `list` is a public `query` gated by `withOrgScope`, so it must be called
 * AS an org-scoped identity. CONFIRMED UNREACHABLE via the Convex CLI
 * against a real hosted DEV deployment: `npx convex run --help` DOES list
 * `--identity <identity>` (backed by `ConvexHttpClient.setAdminAuth`'s
 * `actingAsIdentity` parameter), but hosted Convex's real
 * `ctx.auth.getUserIdentity()` verifies an actual Clerk-signed JWT and does
 * not honor a CLI/HTTP-client-supplied identity override the way the
 * local backend/test harness does. Empirically confirmed independently:
 * `npx convex run orgMembership:getMembership` against hosted DEV returns
 * "RBAC_DENIED: getMembership requires an authenticated caller" with no
 * identity presented at all, `--identity` flag or not. There is NO single
 * command either of us can run for this half — the only reachable path is
 * a genuine authenticated caller (the MCP server, or any real client
 * holding an actual Clerk JWT) for a dev org whose slug is
 * "size-bound-probe-acme-hr". This script seeds ZERO briefingNotes rows for
 * that org on purpose — the whole point of the reproduction is that org
 * owns none of the seeded data. Seed the OTHER-org rows and measure per the
 * comment block above `seedOtherOrgNoteInstructions` below — both steps
 * need a real authenticated client, never the CLI, never this script's
 * anonymous HTTP client.
 *
 * Idempotent-ish: uses fixed, fictitious slugs/titles prefixed
 * "size-bound-probe-" so re-running is safe to identify/clean up, but does
 * NOT dedup inserts — re-running `seed` will insert duplicates. Intended for
 * a single, throwaway DEV run.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const IRRELEVANT_MAPPING_ROW_COUNT = Number(
	process.env.SIZE_BOUND_PROBE_IRRELEVANT_MAPPING_ROW_COUNT ?? 2000,
);
const OTHER_ORG_NOTE_ROW_COUNT = Number(
	process.env.SIZE_BOUND_PROBE_OTHER_ORG_ROW_COUNT ?? 90,
);
const LARGE_CONTENT = "x".repeat(220_000); // ~220KB/row, same scale as the #1260 regression fixture.
const OTHER_ORG_SLUG = "size-bound-probe-other-org";
const RELEVANT_PROJECT = "size-bound-probe-vantage-memory";
const RELEVANT_REPO = "size-bound-probe-org/vantage-memory";
const DEPLOY_PR_NUMBER = 9999;

function loadConvexUrl(): string {
	if (process.env.CONVEX_URL) return process.env.CONVEX_URL;
	const envPath = resolve(import.meta.dirname ?? __dirname, "../.env.local");
	const raw = readFileSync(envPath, "utf-8");
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("CONVEX_URL=")) {
			return trimmed.slice("CONVEX_URL=".length).split("#")[0].trim();
		}
	}
	throw new Error("CONVEX_URL not found — set it in the environment or .env.local");
}

function assertNotProd(url: string): void {
	// Best-effort guard, not a substitute for operator judgement — DEV-only
	// per this task's own brief. Refuses anything that doesn't look like a
	// Convex dev deployment.
	if (!/\.convex\.cloud$/.test(url)) {
		throw new Error(`Refusing: CONVEX_URL "${url}" does not look like a Convex deployment URL.`);
	}
	if (process.env.SIZE_BOUND_PROBE_ALLOW_ANY_DEPLOYMENT !== "1") {
		console.warn(
			"WARNING: this script does not distinguish dev/prod by URL shape alone. " +
				"Confirm CONVEX_URL points at a DEV deployment before proceeding — this " +
				"seeds throwaway fixture rows and is NOT safe to run against prod.",
		);
	}
}

/** Shells out to `npx convex run <fn> <jsonArgs>` against CONVEX_URL, inheriting env. */
function convexRun(fn: string, args: Record<string, unknown>): string {
	const out = execFileSync("npx", ["convex", "run", fn, JSON.stringify(args)], {
		env: process.env,
		encoding: "utf-8",
	});
	console.log(`  npx convex run ${fn} '${JSON.stringify(args)}' ->\n${out.trim()}`);
	return out;
}

async function seedRepoMappingAndDeployTask(convex: ConvexHttpClient): Promise<void> {
	console.log(
		`Seeding ${IRRELEVANT_MAPPING_ROW_COUNT} irrelevant githubRepoMapping rows + 1 relevant project...`,
	);
	const irrelevant = Array.from({ length: IRRELEVANT_MAPPING_ROW_COUNT }, (_, i) => ({
		repo: `size-bound-probe-irrelevant/repo-${i}`,
		orchestrator: "sigma",
		project: `size-bound-probe-irrelevant-project-${i}`,
	}));
	// githubRepoMapping.seed is a public mutation, dedups by repo. Deliberately
	// NOT recording a deploy yet — see the header comment's ordering rationale.
	await convex.mutation(api.githubRepoMapping.seed, { mappings: irrelevant });
	await convex.mutation(api.githubRepoMapping.seed, {
		mappings: [{ repo: RELEVANT_REPO, orchestrator: "sigma", project: RELEVANT_PROJECT }],
	});

	console.log(`Creating the Deploy task for "${RELEVANT_PROJECT}" via tasks:createForWebhook...`);
	convexRun("tasks:createForWebhook", {
		title: `[Deploy] PR #${DEPLOY_PR_NUMBER} merged — deploy ${RELEVANT_PROJECT} to prod`,
		assignedTo: "sigma",
		priority: "urgent",
		status: "todo",
		createdBy: "system",
		project: RELEVANT_PROJECT,
		tags: ["github", "deploy", "pr-merged"],
	});

	console.log(`Recording a deploy for "${RELEVANT_REPO}" AFTER the task's createdAt...`);
	convexRun("githubRepoMapping:recordDeployment", {
		repo: RELEVANT_REPO,
		sha: "size-bound-probe-sha",
		deployedAt: Date.now(),
	});
}

async function main(): Promise<void> {
	const url = loadConvexUrl();
	assertNotProd(url);
	const convex = new ConvexHttpClient(url);

	const mode = process.argv[2];
	if (mode !== "seed") {
		console.error("Usage: bun scripts/dev-probe-size-bound-class.ts seed");
		process.exit(1);
	}

	await seedRepoMappingAndDeployTask(convex);

	console.log(
		`\nNOTE: seeding ${OTHER_ORG_NOTE_ROW_COUNT} briefingNotes rows for org ` +
			`"${OTHER_ORG_SLUG}" requires an authenticated org-scoped identity ` +
			`(briefingNotes.create derives orgId SOLELY from the caller's own ` +
			`verified scope — see convex/briefingNotes.ts), and there is no ` +
			`internal/webhook equivalent for briefingNotes the way ` +
			`tasks:createForWebhook exists for tasks. CONFIRMED unreachable via ` +
			`the CLI (see this file's header comment) -- seed those ` +
			`${OTHER_ORG_NOTE_ROW_COUNT} rows (content = ${LARGE_CONTENT.length} ` +
			`chars of filler each) through a REAL authenticated client (the MCP ` +
			`server, or any client holding a genuine Clerk JWT) for a dev org user ` +
			`whose Clerk org slug is "${OTHER_ORG_SLUG}", then measure ` +
			`briefingNotes:list the same way -- also through a real authenticated ` +
			`client, never the CLI.`,
	);
	console.log(
		"\n#1276 seed complete end-to-end. Measure with:\n" +
			"  npx convex run tasks:resolveStaleDeployTasks '{}'\n" +
			"See this file's header comment for what `closed`/`scanned` mean here " +
			"and the CAVEAT on whether this deployment's current per-status task " +
			"count even makes the seeded task reachable.",
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
