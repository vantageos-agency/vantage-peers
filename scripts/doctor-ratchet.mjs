#!/usr/bin/env node
/**
 * Ratchet on backend-doctor's mechanical rule counts (task
 * k179600rsb4xsv7a975cjkqwhs8g7qhv): a count may only go down.
 *
 *   node scripts/doctor-ratchet.mjs --baseline .backend-doctor/ratchet.json \
 *     --evidence out.json --previous-baseline main-ratchet.json --report report.txt --tree <dir>
 *
 * --evidence           the file written by `backend-doctor <repo> --json-evidence`.
 * --previous-baseline  REQUIRED: the baseline committed on main (`git show origin/main:.backend-doctor/ratchet.json`).
 *                      A rise is measured against IT, never against the PR's own baseline, so a PR
 *                      cannot raise a count and bump ratchet.json in the same diff (Eta, #1529).
 * --report             REQUIRED: the doctor's text output; any FALLBACK line is a refusal to judge
 *                      (a missing install prints "sinks: FALLBACK", and the counts move with it).
 * --tree               REQUIRED: the checkout the doctor measured. `git status --porcelain` there must
 *                      be empty: an untracked or modified file is counted by the doctor and is not
 *                      in the commit the RATCHET line names.
 *
 * A rule absent from `mechanical_rule_counts` is green (the doctor lists red rules
 * only), so it counts 0. A rule absent from the baseline has a baseline of 0.
 *
 * Exit: 0 no count above main's baseline; 1 a count or the baseline was raised;
 * 2 could not judge (bad usage, unreadable input, uncertified evidence, FALLBACK, a dirty tree).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function couldNotJudge(msg) {
	console.error(`doctor-ratchet: could-not-judge — ${msg}`);
	process.exit(2);
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i];
		const val = argv[i + 1];
		if (!key?.startsWith("--") || val === undefined) couldNotJudge(`bad argument ${key ?? ""}`);
		out[key.slice(2)] = val;
	}
	if (!out.baseline || !out.evidence || !out["previous-baseline"] || !out.report || !out.tree) {
		couldNotJudge(
			"usage: doctor-ratchet.mjs --baseline <file> --evidence <file> --previous-baseline <main's ratchet.json> --report <doctor output> --tree <measured checkout>",
		);
	}
	return out;
}

function readJson(path, what) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		couldNotJudge(`cannot read ${what} ${path}: ${e.message}`);
	}
}

function baselineCounts(doc, what) {
	const counts = doc?.counts;
	if (!counts || typeof counts !== "object") couldNotJudge(`${what} has no "counts" object`);
	for (const [rule, n] of Object.entries(counts)) {
		if (!Number.isInteger(n) || n < 0) couldNotJudge(`${what}: ${rule} is not a non-negative integer`);
	}
	return counts;
}

const args = parseArgs(process.argv.slice(2));
const baseline = baselineCounts(readJson(args.baseline, "baseline"), "baseline");
const evidence = readJson(args.evidence, "evidence");

if (evidence.mechanical_violations === null || evidence.mechanical_rule_counts === null) {
	couldNotJudge(
		"the doctor did not certify its counts (mechanical_violations / mechanical_rule_counts is null: an unclassified rule, incomplete coverage, a CRUD self-check failure, or a tree that differs from HEAD)",
	);
}
const measured = evidence.mechanical_rule_counts;
if (!measured || typeof measured !== "object") couldNotJudge("evidence has no mechanical_rule_counts");

{
	let status;
	try {
		status = execFileSync("git", ["-C", args.tree, "status", "--porcelain", "--untracked-files=all"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (e) {
		couldNotJudge(`--tree ${args.tree} is not a readable git checkout: ${e.message.split("\n")[0]}`);
	}
	const dirty = status.split("\n").filter(Boolean);
	if (dirty.length > 0) {
		couldNotJudge(
			`the measured tree is not clean (${dirty.length} path(s) differ from its commit):\n${dirty.slice(0, 10).join("\n")}`,
		);
	}
}

{
	let report;
	try {
		report = readFileSync(args.report, "utf8");
	} catch (e) {
		couldNotJudge(`cannot read report ${args.report}: ${e.message}`);
	}
	const fallback = report.split("\n").filter((l) => /FALLBACK/.test(l) && !/\b0 FALLBACK\b/.test(l));
	if (fallback.length > 0) {
		couldNotJudge(`the doctor report carries ${fallback.length} FALLBACK line(s):\n${fallback.slice(0, 5).join("\n")}`);
	}
}

const mainBaseline = baselineCounts(
	readJson(args["previous-baseline"], "previous baseline"),
	"previous baseline",
);

let failed = false;
let lowered = false;
const rules = [...new Set([...Object.keys(mainBaseline), ...Object.keys(baseline), ...Object.keys(measured)])].sort();
const lines = ["rule    main  head  delta"];
for (const rule of rules) {
	const base = mainBaseline[rule] ?? 0;
	const head = measured[rule] ?? 0;
	const delta = head - base;
	const sign = delta > 0 ? `+${delta}` : `${delta}`;
	let mark = "";
	if (delta > 0) {
		mark = "  RAISED";
		failed = true;
	} else if (delta < 0) {
		lowered = true;
	}
	lines.push(`${rule.padEnd(7)} ${String(base).padStart(4)}  ${String(head).padStart(4)}  ${sign}${mark}`);
}
console.log(lines.join("\n"));

for (const rule of Object.keys({ ...mainBaseline, ...baseline })) {
	const before = mainBaseline[rule] ?? 0;
	const now = baseline[rule] ?? 0;
	if (now > before) {
		console.log(`doctor-ratchet: baseline raised for ${rule}: ${before} on main -> ${now} here. The baseline only goes down.`);
		failed = true;
	}
}

if (failed) {
	console.log("doctor-ratchet: FAIL — a mechanical count is above main's baseline. Fix the new site; never raise the baseline.");
} else if (lowered) {
	console.log("doctor-ratchet: PASS — counts went down; lower the baseline in .backend-doctor/ratchet.json in this PR.");
} else {
	console.log("doctor-ratchet: PASS — no count above main's baseline.");
}

// LAST line, read literally by reviewers and Pi's merge guard (task k179600rsb4xsv7a975cjkqwhs8g7qhv).
// rise = rules whose head count exceeds MAIN's baseline.
const SIX = ["CR-2", "R-5", "R-53", "R-54", "R-55", "R-56"];
const risen = rules.filter((r) => (measured[r] ?? 0) > (mainBaseline[r] ?? 0)).length;
console.log(
	`RATCHET: ${evidence.sha ?? "unknown"} ${SIX.map((r) => `${r}=${measured[r] ?? 0}`).join(" ")} rise=${risen}`,
);
process.exit(failed ? 1 : 0);
