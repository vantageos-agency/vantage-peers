#!/usr/bin/env node
/**
 * Ratchet on backend-doctor's mechanical rule counts (task
 * k179600rsb4xsv7a975cjkqwhs8g7qhv): a count may only go down.
 *
 *   node scripts/doctor-ratchet.mjs --baseline .backend-doctor/ratchet.json \
 *     --evidence out.json [--report report.txt] [--previous-baseline prev.json]
 *
 * --evidence           the file written by `backend-doctor <repo> --json-evidence`.
 * --report             the doctor's text output; any FALLBACK line is a refusal to judge.
 * --previous-baseline  the baseline on main; the PR's baseline may not exceed it.
 *
 * A rule absent from `mechanical_rule_counts` is green (the doctor lists red rules
 * only), so it counts 0. A rule absent from the baseline has a baseline of 0.
 *
 * Exit: 0 no count above its baseline; 1 a count or the baseline was raised;
 * 2 could not judge (bad usage, unreadable input, uncertified evidence, FALLBACK).
 */
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
	if (!out.baseline || !out.evidence) {
		couldNotJudge(
			"usage: doctor-ratchet.mjs --baseline <file> --evidence <file> [--report <file>] [--previous-baseline <file>]",
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

if (args.report) {
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

let failed = false;
const rules = [...new Set([...Object.keys(baseline), ...Object.keys(measured)])].sort();
const lines = ["rule    baseline  head  delta"];
let lowered = false;
for (const rule of rules) {
	const base = baseline[rule] ?? 0;
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
	lines.push(`${rule.padEnd(7)} ${String(base).padStart(8)}  ${String(head).padStart(4)}  ${sign}${mark}`);
}
console.log(lines.join("\n"));

if (args["previous-baseline"]) {
	const prev = baselineCounts(readJson(args["previous-baseline"], "previous baseline"), "previous baseline");
	for (const rule of Object.keys({ ...prev, ...baseline })) {
		const before = prev[rule] ?? 0;
		const now = baseline[rule] ?? 0;
		if (now > before) {
			console.error(`doctor-ratchet: baseline raised for ${rule}: ${before} on main -> ${now} here. The baseline only goes down.`);
			failed = true;
		}
	}
}

if (failed) {
	console.error("doctor-ratchet: FAIL — a mechanical count is above its baseline. Fix the new site; never raise the baseline.");
	process.exit(1);
}
if (lowered) {
	console.log("doctor-ratchet: PASS — counts went down; lower the baseline in .backend-doctor/ratchet.json in this PR.");
} else {
	console.log("doctor-ratchet: PASS — no count above its baseline.");
}
