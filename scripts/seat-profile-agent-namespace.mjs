#!/usr/bin/env node
/**
 * seat-profile-agent-namespace.mjs -- add `orchestrator/<agentId>` to the EXISTING seat scope
 * profiles (task k1701vj2gxbacdjqr1avpxx7en8hdw2q, Pi ruling (c) on #1652).
 *
 *   node scripts/seat-profile-agent-namespace.mjs            # DRY RUN (default): plan + counts
 *   node scripts/seat-profile-agent-namespace.mjs --apply    # write
 *   [--guard <path>] [--agents-limit N] [--mappings-limit N]
 *
 * Every Convex call goes through the prod guard, `.claude/scripts/convex-prod.sh`, and nothing else:
 *   reads   run oauth:listScopeProfiles          (internalQuery; carries clerkOrgSlug)
 *           data agents --limit N --format json
 *           data client_org_mapping --limit N --format json
 *   writes  run oauth:upsertScopeProfile '{"profile":{...}}'   (one JSON object per profile)
 * The guard refuses anything its allow list does not name, so this script cannot do more than
 * those four calls. The selection rule is scripts/lib/seat-profile-plan.mjs. Idempotent: a profile
 * that already lists the prefix is counted `alreadyDone` and never rewritten.
 *
 * A read that returns exactly as many rows as its limit may be truncated; the script then
 * refuses (exit 2) instead of deciding from part of a table.
 *
 * Exit: 0 done (or nothing to do), 2 refused / could not judge.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planSeatProfiles } from "./lib/seat-profile-plan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_GUARD = join(here, "..", ".claude", "scripts", "convex-prod.sh");
const DEFAULT_AGENTS_LIMIT = 5000;
const DEFAULT_MAPPINGS_LIMIT = 1000;

/** Parse the JSON a `convex run` / `convex data` prints, tolerating log lines before it. */
function parseJson(text) {
	const t = String(text).trim();
	try {
		return JSON.parse(t);
	} catch {
		const start = t.search(/[[{"]/);
		return JSON.parse(t.slice(start));
	}
}

function guardExec(guard) {
	return (args) => execFileSync(guard, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });
}

export async function main({ argv = process.argv.slice(2), exec, out = console.log } = {}) {
	const flag = (k, d) => {
		const i = argv.indexOf(`--${k}`);
		return i >= 0 ? argv[i + 1] : d;
	};
	const apply = argv.includes("--apply");
	const agentsLimit = Number(flag("agents-limit", DEFAULT_AGENTS_LIMIT));
	const mappingsLimit = Number(flag("mappings-limit", DEFAULT_MAPPINGS_LIMIT));
	const run = exec ?? guardExec(flag("guard", DEFAULT_GUARD));
	try {
		const profiles = parseJson(run(["run", "oauth:listScopeProfiles"]));
		const agents = parseJson(run(["data", "agents", "--limit", String(agentsLimit), "--format", "json"]));
		const mappings = parseJson(run(["data", "client_org_mapping", "--limit", String(mappingsLimit), "--format", "json"]));
		if (agents.length >= agentsLimit || mappings.length >= mappingsLimit) {
			out(`REFUSED: a read returned as many rows as its limit (agents ${agents.length}/${agentsLimit}, client_org_mapping ${mappings.length}/${mappingsLimit}): truncated, not deciding from part of a table. Raise --agents-limit / --mappings-limit.`);
			return 2;
		}
		const plan = planSeatProfiles({ profiles, agents, mappings });
		out(`${apply ? "APPLY" : "DRY RUN"}: profiles=${profiles.length} toUpdate=${plan.updates.length} alreadyDone=${plan.alreadyDone}`);
		out(`skipped: ${Object.entries(plan.skipped).map(([k, n]) => `${k}=${n}`).join(" ")}`);
		for (const o of plan.orgs) out(`${o.slug}: toUpdate=${o.toUpdate} sample=${o.sampleProfileIds.join(",")}`);
		if (plan.updates.length === 0) {
			out("nothing to update");
			return 0;
		}
		if (!apply) {
			out("dry run: nothing written. Re-run with --apply.");
			return 0;
		}
		let written = 0;
		for (const u of plan.updates) {
			run(["run", "oauth:upsertScopeProfile", JSON.stringify({ profile: u.profile })]);
			written++;
		}
		out(`updated=${written}`);
		return 0;
	} catch (e) {
		out(`${e instanceof Error ? e.message : String(e)}`);
		return 2;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exit(await main());
}
