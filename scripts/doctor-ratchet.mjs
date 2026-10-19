#!/usr/bin/env node
/**
 * Ratchet on backend-doctor's mechanical rule counts (task
 * k179600rsb4xsv7a975cjkqwhs8g7qhv): a count may only go down.
 *
 *   node scripts/doctor-ratchet.mjs --baseline .backend-doctor/ratchet.json \
 *     --evidence out.json --previous-baseline main-ratchet.json --report report.txt --tree <dir> \
 *     [--main-ref origin/main]
 *
 * --evidence           the file written by `backend-doctor <repo> --json-evidence`.
 * --previous-baseline  REQUIRED: the baseline committed on main (`git show origin/main:.backend-doctor/ratchet.json`).
 *                      A rise is measured against IT, never against the PR's own baseline, so a PR
 *                      cannot raise a count and bump ratchet.json in the same diff (Eta, #1529).
 * --report             REQUIRED: the doctor's text output; any FALLBACK line is a refusal to judge
 *                      (a missing install prints "sinks: FALLBACK", and the counts move with it).
 * --tree               REQUIRED: the checkout the doctor measured. Its HEAD must be the commit the
 *                      evidence names (`sha`), and `git status --porcelain` there must be empty: an
 *                      untracked or modified file is counted by the doctor and is not in that commit.
 *                      Ignored files are not checked: node_modules is ignored and MUST be present.
 * --main-ref           the commit main is read at, in the --tree repo (default origin/main). An
 *                      unresolvable ref is a refusal to judge.
 *
 * Exemption markers (task k1778c2hvae8e8vz9f5bbbbbb98g62hw): `allow-local-identity:`,
 * `fleet-wide:` and `oracle-justified:` are counted (occurrences, not files) under convex/ and
 * mcp-server/src/ at HEAD and at --main-ref, by `git grep` on the two commits — never from an
 * argument or a baseline file. A marker count may only go down. Measured on a branch whose
 * every rule count looked fine: fleet-wide: 0 -> 66, allow-local-identity: 7 -> 29. An
 * exemption silences a rule, so the rule counts alone cannot see a branch adding them.
 *
 * A rule absent from `mechanical_rule_counts` is green (the doctor lists red rules
 * only), so it counts 0. A rule absent from the baseline has a baseline of 0.
 *
 * Exit: 0 no count above main's baseline; 1 a count, a marker or the baseline was raised;
 * 2 could not judge (bad usage, unreadable input, uncertified evidence, FALLBACK, a dirty tree,
 * an unresolvable --main-ref, a failing git grep).
 *
 * LAST line: `RATCHET: <sha> CR-2=.. R-5=.. R-53=.. R-54=.. R-55=.. R-56=.. M-allow-local-identity=..
 * M-fleet-wide=.. M-oracle-justified=.. rise=<n>`, followed by ` raised=<names>` when a marker rose.
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
		if (!key?.startsWith("--") || val === undefined)
			couldNotJudge(`bad argument ${key ?? ""}`);
		out[key.slice(2)] = val;
	}
	if (
		!out.baseline ||
		!out.evidence ||
		!out["previous-baseline"] ||
		!out.report ||
		!out.tree
	) {
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
	if (!counts || typeof counts !== "object")
		couldNotJudge(`${what} has no "counts" object`);
	for (const [rule, n] of Object.entries(counts)) {
		if (!Number.isInteger(n) || n < 0)
			couldNotJudge(`${what}: ${rule} is not a non-negative integer`);
	}
	return counts;
}

const args = parseArgs(process.argv.slice(2));
const baseline = baselineCounts(
	readJson(args.baseline, "baseline"),
	"baseline",
);
const evidence = readJson(args.evidence, "evidence");

if (
	evidence.mechanical_violations === null ||
	evidence.mechanical_rule_counts === null
) {
	couldNotJudge(
		"the doctor did not certify its counts (mechanical_violations / mechanical_rule_counts is null: an unclassified rule, incomplete coverage, a CRUD self-check failure, or a tree that differs from HEAD)",
	);
}
const measured = evidence.mechanical_rule_counts;
if (!measured || typeof measured !== "object")
	couldNotJudge("evidence has no mechanical_rule_counts");

{
	if (
		typeof evidence.sha !== "string" ||
		!/^[0-9a-f]{40}$/.test(evidence.sha)
	) {
		couldNotJudge(
			"the evidence names no commit (sha), so it cannot be bound to the measured tree",
		);
	}
	let head;
	try {
		head = execFileSync("git", ["-C", args.tree, "rev-parse", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (e) {
		couldNotJudge(
			`--tree ${args.tree} is not a readable git checkout: ${e.message.split("\n")[0]}`,
		);
	}
	if (head !== evidence.sha) {
		couldNotJudge(
			`--tree HEAD ${head} does not match the evidence commit ${evidence.sha}`,
		);
	}
	let status;
	try {
		status = execFileSync(
			"git",
			["-C", args.tree, "status", "--porcelain", "--untracked-files=all"],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	} catch (e) {
		couldNotJudge(
			`--tree ${args.tree} is not a readable git checkout: ${e.message.split("\n")[0]}`,
		);
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
	const fallback = report
		.split("\n")
		.filter((l) => /FALLBACK/.test(l) && !/\b0 FALLBACK\b/.test(l));
	if (fallback.length > 0) {
		couldNotJudge(
			`the doctor report carries ${fallback.length} FALLBACK line(s):\n${fallback.slice(0, 5).join("\n")}`,
		);
	}
}

// Exemption markers, counted by the script itself on the two commits.
const MARKERS = [
	["M-allow-local-identity", "allow-local-identity:"],
	["M-fleet-wide", "fleet-wide:"],
	["M-oracle-justified", "oracle-justified:"],
];
const MARKER_PATHS = ["convex", "mcp-server/src"];

function resolveCommit(ref) {
	if (typeof ref !== "string" || ref === "" || ref.startsWith("-"))
		couldNotJudge(`--main-ref ${ref} is not a ref`);
	try {
		return execFileSync(
			"git",
			["-C", args.tree, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		).trim();
	} catch {
		couldNotJudge(
			`--main-ref ${ref} does not resolve to a commit in ${args.tree}`,
		);
	}
}

function countMarker(commit, literal) {
	let out;
	try {
		out = execFileSync(
			"git",
			[
				"-C",
				args.tree,
				"grep",
				// -a: a path marked `binary` in .gitattributes would otherwise print one
				// "Binary file … matches" line instead of its matches (Eta, #1540).
				"-a",
				"-o",
				"-h",
				"-F",
				"-e",
				literal,
				commit,
				"--",
				...MARKER_PATHS,
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: 64 * 1024 * 1024,
			},
		);
	} catch (e) {
		if (e.status === 1 && !String(e.stderr ?? "").trim()) return 0; // git grep: no match
		couldNotJudge(
			`git grep ${literal} at ${commit} failed: ${String(e.stderr ?? e.message).split("\n")[0]}`,
		);
	}
	const lines = out.split("\n").filter(Boolean);
	// A grep form that collapses a file into one summary line counts that file as 1:
	// refuse to judge rather than under-read a marker count.
	const summary = lines.find((l) => l.startsWith("Binary file"));
	if (summary !== undefined) {
		couldNotJudge(`git grep ${literal} at ${commit} returned a summary line, not matches: ${summary}`);
	}
	return lines.length;
}

// git grep reads a symlink's own text and skips a gitlink, while the doctor and the
// oracle follow them: a marker reached that way is honoured and never counted
// (Eta, #1540 round 2). Every entry under a counted path must be a regular file, at
// both commits, or the run refuses to judge. One predicate on modes, not one per form.
function assertRegularFiles(commit) {
	let out;
	try {
		out = execFileSync("git", ["-C", args.tree, "ls-tree", "-r", commit, "--", ...MARKER_PATHS], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch (e) {
		couldNotJudge(`git ls-tree at ${commit} failed: ${String(e.stderr ?? e.message).split("\n")[0]}`);
	}
	const odd = out
		.split("\n")
		.filter(Boolean)
		.filter((l) => !/^100(644|755) /.test(l));
	if (odd.length > 0) {
		couldNotJudge(
			`at ${commit}, ${odd.length} entr${odd.length === 1 ? "y" : "ies"} under ${MARKER_PATHS.join(", ")} not a regular file (git grep cannot count markers through them):\n${odd.slice(0, 5).join("\n")}`,
		);
	}
}

const mainCommit = resolveCommit(args["main-ref"] ?? "origin/main");
assertRegularFiles(mainCommit);
assertRegularFiles("HEAD");
const markerCounts = MARKERS.map(([name, literal]) => ({
	name,
	main: countMarker(mainCommit, literal),
	head: countMarker("HEAD", literal),
}));

const mainBaseline = baselineCounts(
	readJson(args["previous-baseline"], "previous baseline"),
	"previous baseline",
);

let failed = false;
let lowered = false;
const rules = [
	...new Set([
		...Object.keys(mainBaseline),
		...Object.keys(baseline),
		...Object.keys(measured),
	]),
].sort();
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
	lines.push(
		`${rule.padEnd(7)} ${String(base).padStart(4)}  ${String(head).padStart(4)}  ${sign}${mark}`,
	);
}
for (const m of markerCounts) {
	const delta = m.head - m.main;
	const sign = delta > 0 ? `+${delta}` : `${delta}`;
	let mark = "";
	if (delta > 0) {
		mark = "  RAISED";
		failed = true;
	}
	lines.push(
		`${m.name.padEnd(7)} ${String(m.main).padStart(4)}  ${String(m.head).padStart(4)}  ${sign}${mark}`,
	);
}
console.log(lines.join("\n"));

for (const rule of Object.keys({ ...mainBaseline, ...baseline })) {
	const before = mainBaseline[rule] ?? 0;
	const now = baseline[rule] ?? 0;
	if (now > before) {
		console.log(
			`doctor-ratchet: baseline raised for ${rule}: ${before} on main -> ${now} here. The baseline only goes down.`,
		);
		failed = true;
	}
}

if (failed) {
	console.log(
		"doctor-ratchet: FAIL — a mechanical count or an exemption marker is above main's. Fix the new site; never raise the baseline.",
	);
} else if (lowered) {
	console.log(
		"doctor-ratchet: PASS — counts went down; lower the baseline in .backend-doctor/ratchet.json in this PR.",
	);
} else {
	console.log("doctor-ratchet: PASS — no count above main's baseline.");
}

// LAST line, read literally by reviewers and Pi's merge guard (task k179600rsb4xsv7a975cjkqwhs8g7qhv).
// rise = rules whose head count exceeds MAIN's baseline + markers whose head count exceeds main's.
// raised= (only when a marker rose) names every risen rule, then every risen marker.
const SIX = ["CR-2", "R-5", "R-53", "R-54", "R-55", "R-56"];
const risenRules = rules.filter(
	(r) => (measured[r] ?? 0) > (mainBaseline[r] ?? 0),
);
const risenMarkers = markerCounts
	.filter((m) => m.head > m.main)
	.map((m) => m.name);
const risen = [...risenRules, ...risenMarkers];
const raisedSuffix =
	risenMarkers.length > 0 ? ` raised=${risen.join(",")}` : "";
console.log(
	`RATCHET: ${evidence.sha ?? "unknown"} ${SIX.map((r) => `${r}=${measured[r] ?? 0}`).join(" ")} ${markerCounts
		.map((m) => `${m.name}=${m.head}`)
		.join(" ")} rise=${risen.length}${raisedSuffix}`,
);
process.exit(failed ? 1 : 0);
