/**
 * Ratchet on backend-doctor's mechanical rule counts (task
 * k179600rsb4xsv7a975cjkqwhs8g7qhv): a PR that raises any count fails before
 * review. Both poles run the real script as a child process against fixed
 * evidence files.
 */
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(REPO, "scripts", "doctor-ratchet.mjs");
const BASELINE = join(REPO, ".backend-doctor", "ratchet.json");
const FIX = join(REPO, "scripts", "__tests__", "fixtures", "doctor-ratchet");

const tmpDirs = [];
afterEach(() => {
	while (tmpDirs.length)
		rmSync(tmpDirs.pop(), { recursive: true, force: true });
});
function tmp() {
	const d = mkdtempSync(join(tmpdir(), "doctor-ratchet-"));
	tmpDirs.push(d);
	return d;
}

// A committed, clean git tree and an empty doctor report: the two inputs a run
// must now name. run() supplies them unless the test passes its own (or asks
// for the bare argument list with runRaw()).
let CLEAN_TREE;
let CLEAN_HEAD;
let CLEAN_REPORT;
beforeAll(() => {
	CLEAN_TREE = mkdtempSync(join(tmpdir(), "doctor-ratchet-tree-"));
	const git = (...a) =>
		spawnSync("git", ["-C", CLEAN_TREE, ...a], { encoding: "utf8" });
	git("init", "-q");
	writeFileSync(join(CLEAN_TREE, "a.ts"), "export const a = 1;\n");
	git("add", "a.ts");
	git(
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-q",
		"-m",
		"init",
	);
	CLEAN_HEAD = git("rev-parse", "HEAD").stdout.trim();
	// --main-ref defaults to origin/main; the clean tree is its own main.
	git("update-ref", "refs/remotes/origin/main", "HEAD");
	CLEAN_REPORT = join(
		CLEAN_TREE,
		"..",
		`${CLEAN_TREE.split("/").pop()}-report.txt`,
	);
	writeFileSync(CLEAN_REPORT, "MECHANICAL RULE COUNTS: CR-2 200\n");
});
afterAll(() => {
	rmSync(CLEAN_TREE, { recursive: true, force: true });
	rmSync(CLEAN_REPORT, { force: true });
});

function runRaw(args) {
	const r = spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: "utf8",
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
// The fixtures carry the placeholder sha 0{40}; a run against the default clean
// tree measures THAT tree, so its evidence is restamped with the tree's HEAD.
function stampEvidence(args, sha) {
	const i = args.indexOf("--evidence");
	if (i < 0) return args;
	const doc = JSON.parse(readFileSync(args[i + 1], "utf8"));
	if (doc.sha !== "0".repeat(40)) return args;
	const out = join(tmp(), "evidence.json");
	writeFileSync(out, JSON.stringify({ ...doc, sha }));
	return [...args.slice(0, i + 1), out, ...args.slice(i + 2)];
}
function run(args) {
	const extra = [];
	if (!args.includes("--report")) extra.push("--report", CLEAN_REPORT);
	let a = args;
	if (!args.includes("--tree")) {
		extra.push("--tree", CLEAN_TREE);
		a = stampEvidence(args, CLEAN_HEAD);
	}
	return runRaw([...a, ...extra]);
}
// main's baseline is the committed one unless a test passes its own.
const withBaseline = (evidence, extra = []) =>
	run([
		"--baseline",
		BASELINE,
		"--evidence",
		join(FIX, evidence),
		"--previous-baseline",
		BASELINE,
		...extra,
	]);

describe("doctor-ratchet: a count may only go down", () => {
	it("GREEN: counts equal to the baseline pass", () => {
		const r = withBaseline("equal.json");
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			`RATCHET: ${CLEAN_HEAD} CR-2=200 R-5=62 R-53=369 R-54=148 R-55=31 R-56=2 M-allow-local-identity=0 M-fleet-wide=0 M-oracle-justified=0 rise=0`,
		);
	});

	it("RED: the RATCHET line reports the number of risen rules", () => {
		const r = withBaseline("raised.json");
		expect(r.out).toMatch(
			new RegExp(`^RATCHET: ${CLEAN_HEAD} .*R-53=370 .*rise=1$`, "m"),
		);
	});

	it("GREEN: lowered counts pass and say the baseline can be lowered", () => {
		const r = withBaseline("lowered.json");
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/R-53\s+369\s+360\s+-9/);
		expect(r.out.trim().split("\n").at(-1)).toMatch(/^RATCHET: .* rise=0$/);
		expect(r.out).toMatch(/lower the baseline/i);
	});

	it("RED: one count raised fails and names the rule", () => {
		const r = withBaseline("raised.json");
		expect(r.status).toBe(1);
		expect(r.out).toMatch(/R-53\s+369\s+370\s+\+1/);
		expect(r.out).toMatch(/RAISED/);
	});

	it("RED: a rule absent from the baseline turning red fails (its baseline is 0)", () => {
		const r = withBaseline("new-rule.json");
		expect(r.status).toBe(1);
		expect(r.out).toMatch(/R-11\s+0\s+1\s+\+1/);
	});

	it("RED: uncertified evidence (counts null) fails as could-not-judge", () => {
		const r = withBaseline("uncertified.json");
		expect(r.status).toBe(2);
		expect(r.out).toMatch(/could-not-judge/i);
	});

	it("RED: a FALLBACK line in the doctor report fails as could-not-judge", () => {
		const d = tmp();
		const report = join(d, "report.txt");
		writeFileSync(
			report,
			"R-53 ... FALLBACK: oracle not derived from this tree\n",
		);
		const r = withBaseline("equal.json", ["--report", report]);
		expect(r.status).toBe(2);
		expect(r.out).toMatch(/FALLBACK/);
	});

	it("GREEN: a clean report with equal counts passes", () => {
		const d = tmp();
		const report = join(d, "report.txt");
		writeFileSync(report, "MECHANICAL RULE COUNTS: CR-2 200\n");
		expect(withBaseline("equal.json", ["--report", report]).status).toBe(0);
	});

	it("RED: a baseline raised above the previous (main) baseline fails", () => {
		const d = tmp();
		const prev = join(d, "prev.json");
		const raisedBaseline = join(d, "ratchet.json");
		const base = JSON.parse(readFileSync(BASELINE, "utf8"));
		writeFileSync(prev, JSON.stringify(base));
		writeFileSync(
			raisedBaseline,
			JSON.stringify({ ...base, counts: { ...base.counts, "R-53": 370 } }),
		);
		const r = run([
			"--baseline",
			raisedBaseline,
			"--evidence",
			join(FIX, "raised.json"),
			"--previous-baseline",
			prev,
		]);
		expect(r.status).toBe(1);
		expect(r.out).toMatch(/baseline raised/i);
	});

	it("GREEN: a baseline lowered below the previous one passes", () => {
		const d = tmp();
		const prev = join(d, "prev.json");
		const lowered = join(d, "ratchet.json");
		const base = JSON.parse(readFileSync(BASELINE, "utf8"));
		writeFileSync(prev, JSON.stringify(base));
		writeFileSync(
			lowered,
			JSON.stringify({
				...base,
				counts: { ...base.counts, "R-53": 360, "CR-2": 199 },
			}),
		);
		const r = run([
			"--baseline",
			lowered,
			"--evidence",
			join(FIX, "lowered.json"),
			"--previous-baseline",
			prev,
		]);
		expect(r.status).toBe(0);
	});

	it("usage error exits 2", () => {
		expect(runRaw([]).status).toBe(2);
	});

	it("RED: --previous-baseline (main's baseline) is required; without it the run cannot judge", () => {
		const r = runRaw([
			"--baseline",
			BASELINE,
			"--evidence",
			join(FIX, "equal.json"),
			"--report",
			CLEAN_REPORT,
			"--tree",
			CLEAN_TREE,
		]);
		expect(r.status).toBe(2);
		expect(r.out).toMatch(/previous-baseline/);
	});

	it("RED (Eta, #1529): a PR that raises a count AND bumps its own baseline still reads rise=1 against main", () => {
		const d = tmp();
		const bumped = join(d, "ratchet.json");
		const base = JSON.parse(readFileSync(BASELINE, "utf8"));
		writeFileSync(
			bumped,
			JSON.stringify({ ...base, counts: { ...base.counts, "R-53": 370 } }),
		);
		const r = run([
			"--baseline",
			bumped,
			"--evidence",
			join(FIX, "raised.json"),
			"--previous-baseline",
			BASELINE,
		]);
		expect(r.status).toBe(1);
		expect(r.out).toMatch(/R-53\s+369\s+370\s+\+1\s+RAISED/);
		expect(r.out.trim().split("\n").at(-1)).toMatch(
			new RegExp(`^RATCHET: ${CLEAN_HEAD} .*R-53=370 .*rise=1$`),
		);
	});

	// A reading is only a reading of the tree it names, with its dependencies
	// installed. Measured 2026-10-18: a checkout with no node_modules printed
	// "sinks: FALLBACK ... cloud-identity is not installed" and counted
	// CR-2 +2 / R-53 +2 on a clean main, because --report was optional and was
	// not passed.
	describe("the run refuses to judge anything but a clean, installed tree", () => {
		const required = [
			"--baseline",
			BASELINE,
			"--evidence",
			join(FIX, "equal.json"),
			"--previous-baseline",
			BASELINE,
		];

		it("RED: without --report the run cannot judge (the FALLBACK check would be skipped)", () => {
			const r = runRaw([...required, "--tree", CLEAN_TREE]);
			expect(r.status).toBe(2);
			expect(r.out).toMatch(/--report/);
		});

		it("RED: without --tree the run cannot judge (nothing says which tree was measured)", () => {
			const r = runRaw([...required, "--report", CLEAN_REPORT]);
			expect(r.status).toBe(2);
			expect(r.out).toMatch(/--tree/);
		});

		it("RED: the doctor's own missing-dependency line refuses", () => {
			const report = join(tmp(), "report.txt");
			writeFileSync(
				report,
				"sinks: FALLBACK (cloud-identity is not installed; static sink list)\n",
			);
			const r = run([...required, "--report", report]);
			expect(r.status).toBe(2);
			expect(r.out).toMatch(/FALLBACK/);
		});

		it("RED: an untracked file in the measured tree refuses, naming it", () => {
			const tree = tmp();
			const git = (...a) =>
				spawnSync("git", ["-C", tree, ...a], { encoding: "utf8" });
			git("init", "-q");
			writeFileSync(join(tree, "a.ts"), "export const a = 1;\n");
			git("add", "a.ts");
			git(
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@t",
				"commit",
				"-q",
				"-m",
				"init",
			);
			writeFileSync(join(tree, "stray.ts"), "export const b = 2;\n");
			const head = git("rev-parse", "HEAD").stdout.trim();
			const r = run([...stampEvidence(required, head), "--tree", tree]);
			expect(r.status).toBe(2);
			expect(r.out).toMatch(/not clean/);
			expect(r.out).toMatch(/stray\.ts/);
		});

		it("RED (Eta, #1532): a clean checkout of ANOTHER commit cannot stand in for the measured tree", () => {
			const other = tmp();
			const git = (...a) =>
				spawnSync("git", ["-C", other, ...a], { encoding: "utf8" });
			git("init", "-q");
			writeFileSync(join(other, "b.ts"), "export const b = 2;\n");
			git("add", "b.ts");
			git(
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@t",
				"commit",
				"-q",
				"-m",
				"other",
			);
			const evidence = stampEvidence(required, CLEAN_HEAD);
			const r = runRaw([
				...evidence,
				"--report",
				CLEAN_REPORT,
				"--tree",
				other,
			]);
			expect(r.status).toBe(2);
			expect(r.out).toMatch(/does not match/);
			expect(r.out).toContain(CLEAN_HEAD);
		});

		it("RED: evidence that names no commit cannot be bound to a tree", () => {
			const doc = JSON.parse(readFileSync(join(FIX, "equal.json"), "utf8"));
			delete doc.sha;
			const out = join(tmp(), "evidence.json");
			writeFileSync(out, JSON.stringify(doc));
			const r = run([
				"--baseline",
				BASELINE,
				"--evidence",
				out,
				"--previous-baseline",
				BASELINE,
			]);
			expect(r.status).toBe(2);
			expect(r.out).toMatch(/names no commit/);
		});

		it("RED: a --tree that is not a git checkout refuses", () => {
			const r = run([...required, "--tree", tmp()]);
			expect(r.status).toBe(2);
			expect(r.out).toMatch(/git/);
		});

		it("GREEN: a clean tree and a clean report pass", () => {
			const r = run(required);
			expect(r.status).toBe(0);
			expect(r.out.trim().split("\n").at(-1)).toMatch(/^RATCHET: .* rise=0$/);
		});
	});
	// The exemption markers (task k1778c2hvae8e8vz9f5bbbbbb98g62hw item 1). Measured on
	// a branch whose every rule count looked fine: fleet-wide: 0 -> 66 and
	// allow-local-identity: 7 -> 29. A marker count is derived by the script from the
	// two commits themselves, and may only go down against main.
	describe("exemption markers may only go down against main", () => {
		// A repo whose first commit is "main" and whose HEAD is the branch.
		function markerRepo(mainFiles, headFiles) {
			const tree = tmp();
			const git = (...a) =>
				spawnSync("git", ["-C", tree, ...a], { encoding: "utf8" });
			const write = (files) => {
				for (const [path, body] of Object.entries(files)) {
					const full = join(tree, path);
					mkdirSync(dirname(full), { recursive: true });
					writeFileSync(full, body);
				}
				git("add", "-A");
			};
			git("init", "-q");
			write(mainFiles);
			git(
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@t",
				"commit",
				"-q",
				"-m",
				"main",
			);
			const main = git("rev-parse", "HEAD").stdout.trim();
			write(headFiles);
			git(
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@t",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"head",
			);
			const head = git("rev-parse", "HEAD").stdout.trim();
			return { tree, main, head };
		}
		const MAIN = {
			"convex/a.ts": "// allow-local-identity: legacy\nexport const a = 1;\n",
			"mcp-server/src/b.ts":
				"// oracle-justified: one\n// oracle-justified: two\n",
		};
		function runMarkers(repo, evidence = "equal.json", mainRef = repo.main) {
			const args = [
				"--baseline",
				BASELINE,
				"--evidence",
				join(FIX, evidence),
				"--previous-baseline",
				BASELINE,
			];
			return runRaw([
				...stampEvidence(args, repo.head),
				"--report",
				CLEAN_REPORT,
				"--tree",
				repo.tree,
				"--main-ref",
				mainRef,
			]);
		}
		const last = (r) => r.out.trim().split("\n").at(-1);

		it("RED: a head adding one fleet-wide: marker over main fails and names it", () => {
			const repo = markerRepo(MAIN, {
				"convex/c.ts": "// fleet-wide: new exemption\n",
			});
			const r = runMarkers(repo);
			expect(r.status).toBe(1);
			expect(r.out).toMatch(/M-fleet-wide\s+0\s+1\s+\+1\s+RAISED/);
			expect(last(r)).toContain("M-fleet-wide=1");
			expect(last(r)).toMatch(/ rise=1 raised=M-fleet-wide$/);
		});

		it("RED: occurrences are counted, not files, and only under convex and mcp-server/src", () => {
			const repo = markerRepo(MAIN, {
				"mcp-server/src/d.ts":
					"// allow-local-identity: x allow-local-identity: y\n",
				"docs/e.md": "allow-local-identity: outside the scanned paths\n",
			});
			const r = runMarkers(repo);
			expect(r.status).toBe(1);
			expect(r.out).toMatch(/M-allow-local-identity\s+1\s+3\s+\+2\s+RAISED/);
			expect(last(r)).toMatch(
				/ M-allow-local-identity=3 M-fleet-wide=0 M-oracle-justified=2 rise=1 raised=M-allow-local-identity$/,
			);
		});

		it("RED: a risen rule and a risen marker are both counted and both named", () => {
			const repo = markerRepo(MAIN, {
				"convex/c.ts": "// fleet-wide: new exemption\n",
			});
			const r = runMarkers(repo, "raised.json");
			expect(r.status).toBe(1);
			expect(last(r)).toMatch(/R-53=370 .* rise=2 raised=R-53,M-fleet-wide$/);
		});

		it("GREEN: equal marker counts pass with rise=0", () => {
			const repo = markerRepo(MAIN, {
				"convex/a.ts": "// allow-local-identity: legacy\nexport const a = 2;\n",
			});
			const r = runMarkers(repo);
			expect(r.status).toBe(0);
			expect(last(r)).toMatch(
				/ M-allow-local-identity=1 M-fleet-wide=0 M-oracle-justified=2 rise=0$/,
			);
		});

		it("GREEN: fewer markers than main pass", () => {
			const repo = markerRepo(MAIN, {
				"mcp-server/src/b.ts": "// oracle-justified: one\n",
			});
			const r = runMarkers(repo);
			expect(r.status).toBe(0);
			expect(r.out).toMatch(/M-oracle-justified\s+2\s+1\s+-1/);
			expect(last(r)).toMatch(/ M-oracle-justified=1 rise=0$/);
		});

		it("RED (Eta, #1540): a .gitattributes binary attribute cannot hide markers from the count", () => {
			// `git grep -o` on a file git treats as binary prints one "Binary file … matches"
			// line instead of the matches, so 5 real markers would read as 1 at head and
			// main's 2 as 1, and a rise would read as "no change".
			const repo = markerRepo(MAIN, {
				".gitattributes": "mcp-server/src/b.ts binary\n",
				"mcp-server/src/b.ts":
					"// oracle-justified: one\n// oracle-justified: two\n// oracle-justified: three\n// oracle-justified: four\n// oracle-justified: five\n",
			});
			const r = runMarkers(repo);
			expect(r.status).toBe(1);
			expect(r.out).toMatch(/M-oracle-justified\s+2\s+5\s+\+3\s+RAISED/);
			expect(last(r)).toMatch(/ rise=1 raised=M-oracle-justified$/);
		});

		it("RED (Eta, #1540 round 2): a symlink under a counted path cannot hide markers; the run refuses to judge", () => {
			// git grep reads a symlink's TEXT (its target path), while the doctor and the
			// oracle follow the link: markers in the target would be honoured and not counted.
			const repo = markerRepo(MAIN, {
				"elsewhere/k.ts":
					"// oracle-justified: a\n// oracle-justified: b\n// oracle-justified: c\n",
			});
			spawnSync("ln", ["-s", "../../elsewhere/k.ts", join(repo.tree, "mcp-server/src/k.ts")]);
			spawnSync("git", ["-C", repo.tree, "add", "-A"]);
			spawnSync("git", ["-C", repo.tree, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--amend", "--no-edit"]);
			repo.head = spawnSync("git", ["-C", repo.tree, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
			const r = runMarkers(repo);
			expect(r.status).toBe(2);
			expect(r.out).toMatch(/could-not-judge/);
			expect(r.out).toMatch(/mcp-server\/src\/k\.ts/);
			expect(r.out).toMatch(/120000/);
		});

		it("RED: an unresolvable --main-ref cannot judge", () => {
			const repo = markerRepo(MAIN, {});
			const r = runMarkers(repo, "equal.json", "no-such-ref");
			expect(r.status).toBe(2);
			expect(r.out).toMatch(/could-not-judge/);
			expect(r.out).toMatch(/no-such-ref/);
		});

		it("GREEN: the RATCHET line always carries the three M- fields (default --main-ref origin/main)", () => {
			const r = withBaseline("equal.json");
			expect(r.status).toBe(0);
			expect(last(r)).toMatch(
				/ R-56=\d+ M-allow-local-identity=0 M-fleet-wide=0 M-oracle-justified=0 rise=0$/,
			);
		});
	});
});
