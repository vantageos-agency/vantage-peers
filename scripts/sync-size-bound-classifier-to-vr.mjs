/**
 * scripts/sync-size-bound-classifier-to-vr.mjs
 *
 * Publish-back tool that makes the VantageRegistry-hosted content of
 * scripts/classify-size-bound-collects.py BYTE-EXACT with this repo's own
 * canonical file. Task k17e952wjt6fdxzjktzh8r9tws8ezv39 (coordinator
 * ruling): the DETECTOR is Convex knowledge and is published ONCE, shared
 * fleet-wide; each consuming product PULLS the byte-exact content (never
 * copies it by hand) and supplies its OWN --root/--scan/--triage — its
 * verdicts stay local, never shared. Mirrors
 * scripts/sync-agents-skills-to-vr.mjs and scripts/sync-standards-to-vr.mjs
 * in vantage-registry exactly, generalized to one piece, kind "hook"
 * (VR's existing content-bearing-script mechanism — see
 * vantage-registry/docs/HOOKS.md "canonical pull/push pattern").
 *
 * DOCTRINE (derive-never-type):
 *   The content is read from FILE BYTES on disk in THIS repo (never
 *   hand-copied into VR). The built-in proof of a correct publish is
 *   sha256(VR content) === sha256(repo bytes), asserted after the write.
 *
 * WRITE PATH: the public `hookContentDb:upsertHookContent` mutation
 * (createIfMissing: true on first publish), gated by VR_ADMIN_WRITE_SECRET
 * (assertAdminSecret in vantage-registry/convex/lib/adminAuth.ts) — the
 * same least-privilege catalog-write gate the sibling sync scripts use.
 * The raw CONVEX_DEPLOY_KEY is deliberately NOT used.
 *
 * PULL PATTERN (consumer side, e.g. the CRM):
 *   A consumer NEVER copies this file by hand and never round-trips
 *   get_hook_content -> write-back (vantage-registry/docs/HOOKS.md's
 *   "FORBIDDEN — MCP roundtrip drift" section). It reads the content field
 *   from `get_hook_content({ name: "classify-size-bound-collects" })` (or
 *   detects drift first via `detectHookDrift`) and writes those bytes to
 *   its OWN scripts/classify-size-bound-collects.py, then invokes it with
 *   its OWN --root/--scan/--triage. Nothing about the detection logic is
 *   forked per consumer; only the triage file is.
 *
 * MODES:
 *   (default)   Sync: upsert byte-exact (createIfMissing=true), then
 *               re-read VR and assert sha256(VR) === sha256(repo).
 *   --dry-run   Print the planned diff + hashes (repo vs VR) WITHOUT writing.
 *   --check     Drift gate. Read repo bytes + VR contentHash, compare. Exit
 *               non-zero on mismatch. No write.
 *
 * USAGE:
 *   node scripts/sync-size-bound-classifier-to-vr.mjs --check
 *   node scripts/sync-size-bound-classifier-to-vr.mjs --dry-run
 *   node scripts/sync-size-bound-classifier-to-vr.mjs               # live sync (gated)
 *
 * ENV:
 *   CONVEX_URL              — VantageRegistry Convex deployment
 *   VR_ADMIN_WRITE_SECRET   — scoped catalog-write secret (required for sync only)
 *
 * EXIT CODES:
 *   0 — in sync (or sync completed + verified)
 *   1 — drift detected (--check), a post-write hash mismatch, or an error
 *
 * NOT RUN LIVE by this task: this DEV-only subagent never holds
 * VR_ADMIN_WRITE_SECRET and never touches VantageRegistry prod. This file
 * is the mechanism, ready for an operator holding that secret to invoke.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { ConvexHttpClient } from "convex/browser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const HOOK_NAME = "classify-size-bound-collects";
const REPO_FILE = "scripts/classify-size-bound-collects.py";

export function sha256hex(content) {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

export function hashesEqual(repoHash, vrHash) {
	if (!repoHash || !vrHash) return false;
	return repoHash === vrHash;
}

export function readRepoBytes(repoRoot = REPO_ROOT) {
	const path = join(repoRoot, REPO_FILE);
	if (!existsSync(path)) {
		throw new Error(`Repo file not found: ${path}`);
	}
	return readFileSync(path, "utf-8");
}

async function main() {
	const { values } = parseArgs({
		options: {
			"dry-run": { type: "boolean", default: false },
			check: { type: "boolean", default: false },
			url: { type: "string" },
		},
	});

	const convexUrl = values.url ?? process.env.CONVEX_URL;
	if (!convexUrl) {
		console.error("FATAL: CONVEX_URL not set and --url not passed.");
		process.exit(1);
	}

	const repoContent = readRepoBytes();
	const repoHash = sha256hex(repoContent);

	const client = new ConvexHttpClient(convexUrl);
	const drift = await client.query("hookContentDb:detectHookDrift", {});
	const existing = drift.find((r) => r.name === HOOK_NAME) ?? null;
	const vrHash = existing?.vrHash ?? null;
	const drifted = !hashesEqual(repoHash, vrHash);

	console.log(`name=${HOOK_NAME} repoHash=${repoHash} vrHash=${vrHash ?? "(none)"} drifted=${drifted}`);

	if (values.check) {
		if (drifted) {
			console.error(`[DRIFT] ${HOOK_NAME}: repo and VR content hash differ.`);
			process.exit(1);
		}
		console.log("PASS: repo and VR content are byte-identical.");
		process.exit(0);
	}

	if (values["dry-run"]) {
		console.log(drifted ? "Would upsert (drift detected)." : "Would no-op (already in sync).");
		process.exit(0);
	}

	const adminSecret = process.env.VR_ADMIN_WRITE_SECRET;
	if (!adminSecret) {
		console.error("FATAL: VR_ADMIN_WRITE_SECRET not set — required for a live sync.");
		process.exit(1);
	}

	const result = await client.mutation("hookContentDb:upsertHookContent", {
		adminSecret,
		name: HOOK_NAME,
		content: repoContent,
		createIfMissing: true,
	});

	if (result.contentHash !== repoHash) {
		console.error(
			`FATAL: post-write hash mismatch — VR returned ${result.contentHash}, repo sha256 is ${repoHash}.`,
		);
		process.exit(1);
	}

	console.log(
		`OK: ${HOOK_NAME} ${result.created ? "created" : "updated"} in VR, contentVersion=${result.contentVersion}, contentHash=${result.contentHash} (verified byte-exact).`,
	);
	process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
