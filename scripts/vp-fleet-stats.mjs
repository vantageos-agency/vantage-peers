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
 * Equivalent direct invocation (no script, via Convex CLI):
 *   npx convex run stats:fleetStats
 */

import { ConvexHttpClient } from "convex/browser";

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

async function main() {
	const client = new ConvexHttpClient(CONVEX_URL);
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
