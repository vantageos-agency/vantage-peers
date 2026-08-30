#!/usr/bin/env node
/**
 * scripts/vp-fleet-stats.mjs — real VP fleet totals (VP task
 * k177xw1r3qr5fkv3dr5f2jcfhs8bqz7f).
 *
 * Invokes the server-side `stats:fleetStats` Convex query, which counts
 * bus/missions/tasks/missionTemplates/messages via streaming `for await`
 * counters (never a single unbounded `.collect()` — see convex/stats.ts for
 * the approach). These are TRUE totals — no MCP SCAN_CAP floors ("at least
 * N") anywhere.
 *
 * messages.byReadStatus counts `messageReceipts` rows split on `readAt`
 * (undefined = unread, set = read) — one receipt per recipient per message.
 *
 * Idempotent, read-only. Never prints CONVEX_DEPLOY_KEY or any other token.
 *
 * Usage:
 *   CONVEX_URL=https://<deployment>.convex.cloud node scripts/vp-fleet-stats.mjs
 *   CONVEX_URL=https://<deployment>.convex.cloud node scripts/vp-fleet-stats.mjs --json
 *
 * CSV mode — TRUE, non-page-capped, per-orchestrator OPEN task counts (VP task
 * k17f9ssm4jbpc4jyfwembkdmnd8dfekn). Calls `stats:openTaskCountsByOrchestrator`
 * (streamed `for await`, no `.collect()`, see convex/stats.ts) and writes one
 * CSV row per orchestrator, INCLUDING zero-open stations (positive control —
 * a station with an empty queue is a 0-row, never silently absent):
 *   CONVEX_URL=https://<deployment>.convex.cloud node scripts/vp-fleet-stats.mjs --csv qa/fleet-open-task-counts-2026-08-30.csv
 *
 * Read-only; idempotent (re-running overwrites the same path with fresh
 * counts); never prints CONVEX_DEPLOY_KEY or any other token.
 *
 * Equivalent direct invocation (no script, via Convex CLI):
 *   npx convex run stats:fleetStats
 *   npx convex run stats:openTaskCountsByOrchestrator
 */

import { ConvexHttpClient } from "convex/browser";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const CONVEX_URL = process.env.CONVEX_URL;
if (!CONVEX_URL) {
	console.error("Missing CONVEX_URL env var. Set it to the target deployment URL.");
	process.exit(1);
}
if (!/^https:\/\//.test(CONVEX_URL)) {
	console.error(`CONVEX_URL must be an https:// deployment URL, got: ${CONVEX_URL}`);
	process.exit(1);
}

const jsonOnly = process.argv.includes("--json");

const csvFlagIndex = process.argv.indexOf("--csv");
const csvPath = csvFlagIndex !== -1 ? process.argv[csvFlagIndex + 1] : null;
if (csvFlagIndex !== -1 && !csvPath) {
	console.error("--csv requires a file path argument, e.g. --csv qa/fleet-open-task-counts-2026-08-30.csv");
	process.exit(1);
}

/** Escapes a CSV field: wraps in quotes and doubles any embedded quote. */
function csvField(value) {
	const s = String(value);
	if (/[",\n]/.test(s)) {
		return `"${s.replace(/"/g, '""')}"`;
	}
	return s;
}

async function runOpenCountsCsv(client, outPath) {
	// TRUE totals — streamed server-side, never MCP page-capped at 200.
	const rows = await client.query("stats:openTaskCountsByOrchestrator", {});

	const nowIso = new Date().toISOString();
	const countDate = nowIso.slice(0, 10);

	const header = [
		"orchestrator",
		"todo",
		"in_progress",
		"blocked",
		"review",
		"total_open",
		"oldest_open_iso",
		"oldest_open_age_days",
		"count_date",
	];

	const lines = [header.map(csvField).join(",")];
	for (const row of rows) {
		const oldestIso = row.oldestOpenMs === null ? "" : new Date(row.oldestOpenMs).toISOString();
		const ageDays =
			row.oldestOpenMs === null
				? ""
				: ((Date.now() - row.oldestOpenMs) / 86_400_000).toFixed(2);
		lines.push(
			[
				row.orchestrator,
				row.todo,
				row.inProgress,
				row.blocked,
				row.review,
				row.totalOpen,
				oldestIso,
				ageDays,
				countDate,
			]
				.map(csvField)
				.join(","),
		);
	}

	const csv = `${lines.join("\n")}\n`;
	const dir = dirname(outPath);
	if (dir && dir !== ".") {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(outPath, csv, "utf8");
	console.log(`Wrote ${rows.length} orchestrator row(s) to ${outPath}`);
}

/**
 * Best-effort Clerk service-account auth (see
 * mcp-server/src/serviceAccountAuth.ts for the full mechanism doc). Both
 * `fleetStats` and `openTaskCountsByOrchestrator` are gated behind
 * withOrgScope's "view-stats-aggregated" master-scope check, which requires a
 * verified Clerk identity — an unauthenticated ConvexHttpClient call resolves
 * to no identity and is rejected with RBAC_DENIED.
 *
 * When CLERK_SECRET_KEY + CLERK_SERVICE_ACCOUNT_USER_ID are present in the
 * environment, this mints a short-lived master-scope JWT via the same
 * service-account flow the MCP server uses in production and attaches it to
 * the client. If those env vars are absent (e.g. a self-host deployment with
 * no Clerk configured, or auth.config.ts not wired), this is a silent no-op —
 * the query call proceeds unauthenticated and Convex enforces whatever gate
 * is configured for that deployment.
 */
async function attachServiceAccountAuthIfConfigured(client) {
	if (!process.env.CLERK_SECRET_KEY || !process.env.CLERK_SERVICE_ACCOUNT_USER_ID) {
		return;
	}
	try {
		const { getServiceAccountToken } = await import(
			"../mcp-server/dist/src/serviceAccountAuth.js"
		);
		const token = await getServiceAccountToken();
		if (token) {
			client.setAuth(token);
		}
	} catch {
		// Best-effort only — proceed unauthenticated if the compiled mcp-server
		// module isn't available (e.g. `npm run build` hasn't been run yet).
	}
}

async function main() {
	const client = new ConvexHttpClient(CONVEX_URL);
	await attachServiceAccountAuthIfConfigured(client);

	if (csvPath) {
		await runOpenCountsCsv(client, csvPath);
		return;
	}

	// fleetStats is a Convex query that streams counts via
	// `for await (const row of query)` (see convex/stats.ts) — never buffers
	// unbounded result sets, cannot OOM. Invoked here via `.query()`, using the
	// function name string to avoid requiring the generated `api` module
	// bundle in a standalone script context.
	const stats = await client.query("stats:fleetStats", {});

	if (jsonOnly) {
		console.log(JSON.stringify(stats, null, 2));
		return;
	}

	console.log("VantagePeers Cloud — real fleet totals");
	console.log(`generated at: ${new Date(stats.generatedAt).toISOString()}`);
	console.log("");
	console.log(`bus (businessUnits):      ${stats.bus.total}`);
	console.log(`missionTemplates:         ${stats.missionTemplates.total}`);
	console.log("");
	console.log(`missions total:           ${stats.missions.total}`);
	for (const [status, count] of Object.entries(stats.missions.byStatus)) {
		console.log(`  ${status.padEnd(12)} ${count}`);
	}
	console.log("");
	console.log(`tasks total:              ${stats.tasks.total}`);
	for (const [status, count] of Object.entries(stats.tasks.byStatus)) {
		console.log(`  ${status.padEnd(12)} ${count}`);
	}
	console.log("");
	console.log(`messages total:           ${stats.messages.total}`);
	console.log(`  read         ${stats.messages.byReadStatus.read}`);
	console.log(`  unread       ${stats.messages.byReadStatus.unread}`);
	console.log("");
	console.log("--- raw JSON ---");
	console.log(JSON.stringify(stats, null, 2));
}

main().catch((err) => {
	console.error("vp-fleet-stats failed:", err instanceof Error ? err.message : err);
	process.exit(1);
});
