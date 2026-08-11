#!/usr/bin/env node
// deploy-preflight.mjs — executable deploy preflight for the vantage-peers repo.
//
// Source of truth: deploy/env-manifest.json (NAMES only, never values).
// This script names exactly which required env-var NAMES are PRESENT / MISSING
// on a deploy target BEFORE a deploy runs. It NEVER reads or prints any env VALUE.
//
// Usage: node scripts/deploy-preflight.mjs <project> <target>
//   target ∈ { convex-dev, convex-prod, railway-prod }

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

/**
 * Map a deploy `target` to the manifest section it validates.
 * @returns {{ kind: "convex"|"railway", env: "dev"|"prod", node: object }}
 */
export function resolveTarget(manifest, project, target) {
	const proj = manifest?.[project];
	if (!proj) throw new Error(`unknown project: ${project}`);
	switch (target) {
		case "convex-dev":
			return { kind: "convex", env: "dev", node: proj.convex.dev };
		case "convex-prod":
			return { kind: "convex", env: "prod", node: proj.convex.prod };
		case "railway-prod":
			return { kind: "railway", env: "prod", node: proj.railway.prod };
		default:
			throw new Error(`unknown target: ${target}`);
	}
}

/**
 * PURE core. No IO. Given the manifest, project, target, and the set of env-var
 * NAMES observed present, decide which required names are PRESENT/MISSING.
 *
 * @param {object} args
 * @param {object} args.manifest  parsed env-manifest.json
 * @param {string} args.project   e.g. "vantage-peers"
 * @param {string} args.target    convex-dev | convex-prod | railway-prod
 * @param {Iterable<string>} args.presentNames  env-var NAMES observed present
 * @returns {{ ok: boolean, required: Array<{name:string,status:string,source?:string}>, missing: string[] }}
 */
export function resolvePreflight({ manifest, project, target, presentNames }) {
	const { node } = resolveTarget(manifest, project, target);
	const present = new Set(presentNames ?? []);
	const requiredNames = node.required ?? [];

	const required = requiredNames.map((name) => {
		const isPresent = present.has(name);
		return isPresent
			? { name, status: "PRESENT" }
			: { name, status: "MISSING" };
	});
	const missing = required
		.filter((r) => r.status === "MISSING")
		.map((r) => r.name);

	return { ok: missing.length === 0, required, missing };
}

/**
 * Resolve a logical local-cred key to its real env-var NAME via localCredsMap.
 * Divergence-absorbing: returns the mapped bare/real name, never a guessed suffix.
 */
export function resolveLocalCredName(manifest, project, logicalKey) {
	const map = manifest?.[project]?.localCredsMap ?? {};
	if (!(logicalKey in map)) {
		throw new Error(`unknown local cred key: ${logicalKey}`);
	}
	return map[logicalKey];
}

// ---------------------------------------------------------------------------
// IO layer (CLI only). NAMES only in reports — the ONE exception is the deploy
// key VALUE read from .env.local purely to authenticate the CLI; it is never printed.
// ---------------------------------------------------------------------------

/**
 * Read a single env-var VALUE from .env.local by exact NAME.
 * Used ONLY to obtain the target's deploy key to authenticate `convex env list`.
 * The returned value is passed to the child process env and is NEVER printed.
 * @returns {string|undefined}
 */
function readEnvLocalValue(name) {
	let raw;
	try {
		raw = readFileSync(resolve(REPO_ROOT, ".env.local"), "utf8");
	} catch {
		return undefined;
	}
	for (const line of raw.split("\n")) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
		if (m && m[1] === name) {
			// strip surrounding quotes and trailing comment/whitespace
			let v = m[2].trim();
			if (
				(v.startsWith('"') && v.endsWith('"')) ||
				(v.startsWith("'") && v.endsWith("'"))
			) {
				v = v.slice(1, -1);
			}
			return v;
		}
	}
	return undefined;
}

/** `npx convex env list` with the mapped deploy key; extract NAMES only. */
function readConvexEnvNames(manifest, project, env) {
	const names = new Set();
	const node = manifest[project].convex[env];
	const deployKeyEnvVar = node.deployKeyEnvVar;
	// The deploy key lives in .env.local (not exported into process.env). Read its
	// VALUE from there to authenticate the CLI; fall back to process.env if present.
	const deployKey =
		readEnvLocalValue(deployKeyEnvVar) ?? process.env[deployKeyEnvVar];
	if (!deployKey) {
		return {
			names,
			available: false,
			reason: `${deployKeyEnvVar} not found in .env.local or process.env`,
		};
	}
	let out;
	try {
		out = execFileSync("npx", ["convex", "env", "list"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			env: { ...process.env, CONVEX_DEPLOY_KEY: deployKey },
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (e) {
		return {
			names,
			available: false,
			reason: e?.message ?? "convex env list failed",
		};
	}
	for (const line of out.split("\n")) {
		// `convex env list` prints `NAME=value` — take the NAME only, drop the value.
		const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
		if (m) names.add(m[1]);
	}
	return { names, available: true };
}

/** Best-effort `railway variables` NAMES only. Never crashes on auth failure. */
function readRailwayEnvNames() {
	const names = new Set();
	let out;
	try {
		out = execFileSync("railway", ["variables"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (e) {
		return {
			names,
			available: false,
			reason: `railway CLI unavailable/unauthenticated (${e?.code ?? "error"}); Railway prod auto-deploys from main`,
		};
	}
	for (const line of out.split("\n")) {
		const m = /^\s*│?\s*([A-Za-z_][A-Za-z0-9_]*)\s*[│|=]/.exec(line);
		if (m) names.add(m[1]);
	}
	return { names, available: true };
}

function gatherPresentNames(manifest, project, target) {
	const sources = [];
	const present = new Set();

	// presentNames MUST come from the TARGET environment, not from .env.local.
	// .env.local only holds the deploy key + local Clerk minting creds — a separate
	// concern. The required vars live ON the target deployment/service.
	if (target === "convex-dev" || target === "convex-prod") {
		const env = target === "convex-dev" ? "dev" : "prod";
		const convex = readConvexEnvNames(manifest, project, env);
		sources.push({ source: `convex:${env}`, ...convex });
		for (const n of convex.names) present.add(n);
	}

	if (target === "railway-prod") {
		const railway = readRailwayEnvNames();
		sources.push({ source: "railway:prod", ...railway });
		for (const n of railway.names) present.add(n);
	}

	return { present, sources };
}

function sourceFor(sources, name) {
	for (const s of sources) {
		if (s.names.has(name)) return s.source;
	}
	return undefined;
}

function main() {
	const [, , project, target] = process.argv;
	if (!project || !target) {
		console.error(
			"Usage: node scripts/deploy-preflight.mjs <project> <target>",
		);
		console.error("  target ∈ { convex-dev, convex-prod, railway-prod }");
		process.exit(2);
	}

	const manifest = JSON.parse(
		readFileSync(resolve(REPO_ROOT, "deploy/env-manifest.json"), "utf8"),
	);

	let present;
	let sources;
	try {
		({ present, sources } = gatherPresentNames(manifest, project, target));
	} catch (e) {
		console.error(`ERROR gathering present names: ${e?.message ?? e}`);
		process.exit(2);
	}

	const result = resolvePreflight({
		manifest,
		project,
		target,
		presentNames: present,
	});

	console.log(`# deploy preflight — project=${project} target=${target}`);
	for (const s of sources) {
		console.log(
			`# source ${s.source}: ${s.available ? `available (${s.names.size} names)` : `unavailable — ${s.reason}`}`,
		);
	}
	for (const r of result.required.sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		if (r.status === "PRESENT") {
			console.log(`PRESENT  ${r.name} (${sourceFor(sources, r.name) ?? "?"})`);
		} else {
			console.log(`MISSING  ${r.name}`);
		}
	}

	if (!result.ok) {
		console.error(
			`BLOCKED: missing required env var(s): ${result.missing.join(", ")}`,
		);
		process.exit(1);
	}
	console.log("OK: all required env vars present");
	process.exit(0);
}

// Run main only when invoked as a script, not when imported by tests.
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main();
}
