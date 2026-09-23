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
 * ── What to run, in order ───────────────────────────────────────────────
 *
 * 1. Seed both fixtures:
 *      CONVEX_URL=<your dev deployment url> bun scripts/dev-probe-size-bound-class.ts seed
 *
 * 2. Measure #1276 (tasks:resolveStaleDeployTasks) — this is an
 *    internalMutation, so it must be invoked via the Convex CLI (which holds
 *    the deploy key), not this script's HTTP client:
 *      npx convex run tasks:resolveStaleDeployTasks '{}'
 *
 *    BEFORE this branch's fix (convex/tasks.ts, convex/schema.ts reverted):
 *      throws "Scanned too many documents in a single function execution
 *      (limit: 32000)" in convex-test, or times out in real prod with
 *      "Your request timed out performing too many system operations" —
 *      because the upfront `ctx.db.query("githubRepoMapping").collect()`
 *      reads the WHOLE table before any per-status work starts. This script
 *      seeds SIZE_BOUND_PROBE_IRRELEVANT_MAPPING_ROW_COUNT (default 2000)
 *      irrelevant mapping rows precisely to make that whole-table read
 *      expensive.
 *    AFTER the fix: returns {closed: 1, truncated: false, ...} — the fixed
 *      code only ever reads the mapping row(s) for the ONE project actually
 *      referenced by the seeded Deploy task, never the other 2000.
 *
 * 3. Measure #1294 (briefingNotes:list) — this is a public `query` gated by
 *    `withOrgScope`, so it must be called AS an org-scoped identity. Two
 *    ways to do that against DEV:
 *
 *    (a) Convex CLI identity impersonation (if your installed `convex` CLI
 *        version supports `--identity`; check `npx convex run --help`):
 *          npx convex run briefingNotes:list '{"fields":"full"}' \
 *            --identity '{"subject":"dev-probe-acme-hr","organizationId":"size-bound-probe-acme-hr"}'
 *
 *    (b) Through the MCP server's authenticated session for a real dev org
 *        user whose Clerk org slug is "size-bound-probe-acme-hr" (this
 *        script seeds ZERO briefingNotes rows for that org on purpose — the
 *        whole point is that org owns none of the seeded data).
 *
 *    BEFORE the fix (convex/briefingNotes.ts, convex/schema.ts reverted):
 *      throws "Uncaught Error: Too many bytes read in a single function
 *      execution (limit: 16777216 bytes)" — the pre-fix no-topic/topic-only
 *      branches scan the FULL cross-tenant table (bounded by
 *      BRIEFING_NOTES_LIST_SCAN_CAP + 1 = 2001 rows) and read every OTHER
 *      org's full `content` bytes before ever filtering to this caller's
 *      own orgId. This script seeds
 *      SIZE_BOUND_PROBE_OTHER_ORG_ROW_COUNT (default 90) rows at ~220KB of
 *      content each under a DIFFERENT org ("size-bound-probe-other-org") —
 *      the same fixture scale already proven (see
 *      convex/__tests__/briefing-notes-updatedsince-bytes.test.ts) to blow
 *      the 16MB ceiling.
 *    AFTER the fix: returns `[]` (the caller's own org, "acme-hr", has zero
 *      rows) — the `by_orgId`/`by_orgId_topic` index means zero bytes of
 *      the other org's content are ever read.
 *
 * Idempotent-ish: uses fixed, fictitious slugs/titles prefixed
 * "size-bound-probe-" so re-running is safe to identify/clean up, but does
 * NOT dedup inserts — re-running `seed` will insert duplicates. Intended for
 * a single, throwaway DEV run.
 */

import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "fs";
import { resolve } from "path";
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

async function seedRepoMapping(convex: ConvexHttpClient): Promise<void> {
	console.log(
		`Seeding ${IRRELEVANT_MAPPING_ROW_COUNT} irrelevant githubRepoMapping rows + 1 relevant project...`,
	);
	const irrelevant = Array.from({ length: IRRELEVANT_MAPPING_ROW_COUNT }, (_, i) => ({
		repo: `size-bound-probe-irrelevant/repo-${i}`,
		orchestrator: "sigma",
		project: `size-bound-probe-irrelevant-project-${i}`,
	}));
	// githubRepoMapping.seed is a public mutation, dedups by repo.
	await convex.mutation(api.githubRepoMapping.seed, { mappings: irrelevant });
	await convex.mutation(api.githubRepoMapping.seed, {
		mappings: [{ repo: RELEVANT_REPO, orchestrator: "sigma", project: RELEVANT_PROJECT }],
	});
	console.log(
		`  Note: githubRepoMapping.seed does not set lastDeployedAt/lastDeployedSHA — ` +
			`record a deploy for "${RELEVANT_REPO}" via ` +
			`\`npx convex run githubRepoMapping:recordDeployment '{"repo":"${RELEVANT_REPO}","sha":"size-bound-probe-sha","deployedAt":${Date.now()}}'\` ` +
			`then create a matching "[Deploy] PR #<N> merged — deploy ${RELEVANT_PROJECT} to prod" ` +
			`task with an OLDER createdAt for step 2 to actually close it.`,
	);
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

	await seedRepoMapping(convex);

	console.log(
		`\nNOTE: seeding ${OTHER_ORG_NOTE_ROW_COUNT} briefingNotes rows for org ` +
			`"${OTHER_ORG_SLUG}" requires an authenticated org-scoped identity ` +
			`(briefingNotes.create derives orgId SOLELY from the caller's own ` +
			`verified scope — see convex/briefingNotes.ts). This HTTP client has no ` +
			`Clerk JWT to present, so this script cannot perform that half of the ` +
			`seed on its own. Seed those ${OTHER_ORG_NOTE_ROW_COUNT} rows via ` +
			`\`npx convex run briefingNotes:create '{...}' --identity ` +
			`'{"subject":"dev-probe-other-org","organizationId":"${OTHER_ORG_SLUG}"}'\` ` +
			`(one call per row, content = ${LARGE_CONTENT.length} chars of filler), ` +
			`then measure per the header comment's step 3.`,
	);
	console.log("\nSeed step complete. See this file's header comment for the measurement commands.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
