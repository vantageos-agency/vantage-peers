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
const FIX = join(REPO, "scripts", "__tests__", "fixtures", "doctor-ratchet");
// A fixture baseline (doctorVersion 0.4.5), not the live .backend-doctor/ratchet.json:
// a re-baseline must not rewrite these tests. The fixtures' cli_commit names 0.4.5.
const BASELINE = join(FIX, "baseline.json");

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

	it("RED: lowered counts with the baseline left unlowered fail, naming the value to write", () => {
		const r = withBaseline("lowered.json");
		expect(r.status).toBe(1);
		expect(r.out).toMatch(/R-53\s+369\s+360\s+-9/);
		expect(r.out).toContain('"R-53": 360');
		expect(r.out.trim().split("\n").at(-1)).toMatch(/^RATCHET: .* rise=0$/);
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
			spawnSync("ln", [
				"-s",
				"../../elsewhere/k.ts",
				join(repo.tree, "mcp-server/src/k.ts"),
			]);
			spawnSync("git", ["-C", repo.tree, "add", "-A"]);
			spawnSync("git", [
				"-C",
				repo.tree,
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@t",
				"commit",
				"-q",
				"--amend",
				"--no-edit",
			]);
			repo.head = spawnSync("git", ["-C", repo.tree, "rev-parse", "HEAD"], {
				encoding: "utf8",
			}).stdout.trim();
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

	// The counts mean something only under the doctor version that printed them
	// (task k172gy1ykcbz6drqb4n85q5a1n8gkaf3, Eta on #1544): 0.4.7 evidence read
	// against a 0.4.5 baseline printed FAIL rise=1 without naming the cause.
	describe("the evidence's doctor version must be the baseline's", () => {
		const base = () => JSON.parse(readFileSync(BASELINE, "utf8"));
		function evidenceWith(cli, counts) {
			const doc = JSON.parse(readFileSync(join(FIX, "equal.json"), "utf8"));
			const out = join(tmp(), "evidence.json");
			const next = {
				...doc,
				mechanical_rule_counts: counts ?? doc.mechanical_rule_counts,
			};
			if (cli === undefined) delete next.cli_commit;
			else next.cli_commit = cli;
			writeFileSync(out, JSON.stringify(next));
			return out;
		}
		function baselineFile(doc) {
			const out = join(tmp(), "ratchet.json");
			writeFileSync(out, JSON.stringify(doc));
			return out;
		}
		const judge = (baseline, evidence, previous = BASELINE) =>
			run([
				"--baseline",
				baseline,
				"--evidence",
				evidence,
				"--previous-baseline",
				previous,
			]);
		const last = (r) => r.out.trim().split("\n").at(-1);

		it("RED: evidence from another doctor version is refused, naming both versions", () => {
			const r = judge(
				BASELINE,
				evidenceWith("npm @vantageos/backend-doctor@0.4.7"),
			);
			expect(r.status).toBe(2);
			expect(r.out).toMatch(/could-not-judge/);
			expect(r.out).toContain("0.4.7");
			expect(r.out).toContain("0.4.5");
			expect(r.out).toMatch(/re-measured/);
			expect(r.out).not.toMatch(/^RATCHET:/m);
		});

		for (const cli of [
			undefined,
			"x",
			"245eddf447c5e933cd2e66afda5d9febc3e3e9c1",
			"npm @vantageos/backend-doctor@0.4",
			" npm @vantageos/backend-doctor@0.4.5",
			"npm @vantageos/backend-doctor@0.4.5 ",
			"npm @other/backend-doctor@0.4.5",
		]) {
			it(`RED: an underivable version (cli_commit=${JSON.stringify(cli)}) cannot judge, naming the value`, () => {
				const r = judge(BASELINE, evidenceWith(cli));
				expect(r.status).toBe(2);
				expect(r.out).toMatch(/could-not-judge/);
				expect(r.out).toMatch(/cli_commit/);
				expect(r.out).toContain(JSON.stringify(cli ?? null));
				expect(r.out).not.toMatch(/^RATCHET:/m);
			});
		}

		it("RED: a baseline without doctorVersion cannot judge", () => {
			const { doctorVersion: _drop, ...unversioned } = base();
			const r = judge(baselineFile(unversioned), join(FIX, "equal.json"));
			expect(r.status).toBe(2);
			expect(r.out).toMatch(/could-not-judge/);
			expect(r.out).toMatch(/doctorVersion/);
		});

		it("RED: a baseline whose doctorVersion is not an exact semver cannot judge", () => {
			const r = judge(
				baselineFile({ ...base(), doctorVersion: "v0.4.5" }),
				join(FIX, "equal.json"),
			);
			expect(r.status).toBe(2);
			expect(r.out).toMatch(/doctorVersion/);
		});

		it("GREEN: a raise against main licensed by a strictly newer doctorVersion passes, measured against the re-baseline", () => {
			const counts = { ...base().counts, "CR-2": 264 };
			const head = baselineFile({ ...base(), doctorVersion: "0.4.7", counts });
			const r = judge(
				head,
				evidenceWith("npm @vantageos/backend-doctor@0.4.7", counts),
			);
			expect(r.status).toBe(0);
			expect(r.out).toMatch(/0\.4\.5 -> 0\.4\.7/);
			expect(last(r)).toMatch(
				new RegExp(`^RATCHET: ${CLEAN_HEAD} CR-2=264 .* rise=0$`),
			);
		});

		it("GREEN: numeric semver order — 0.4.9 on main, 0.4.10 here licenses the raise", () => {
			const counts = { ...base().counts, "CR-2": 264 };
			const prev = baselineFile({ ...base(), doctorVersion: "0.4.9" });
			const head = baselineFile({ ...base(), doctorVersion: "0.4.10", counts });
			const r = judge(
				head,
				evidenceWith("npm @vantageos/backend-doctor@0.4.10", counts),
				prev,
			);
			expect(r.status).toBe(0);
			expect(last(r)).toMatch(/ rise=0$/);
		});

		it("RED: under a re-baseline, a count above the NEW baseline still fails", () => {
			const counts = { ...base().counts, "CR-2": 264 };
			const head = baselineFile({ ...base(), doctorVersion: "0.4.7", counts });
			const r = judge(
				head,
				evidenceWith("npm @vantageos/backend-doctor@0.4.7", {
					...counts,
					"CR-2": 265,
				}),
			);
			expect(r.status).toBe(1);
			expect(r.out).toMatch(/CR-2\s+264\s+265\s+\+1\s+RAISED/);
			expect(last(r)).toMatch(/ rise=1$/);
		});

		for (const [label, mainVersion, headVersion] of [
			["the same version", "0.4.7", "0.4.7"],
			["an older version", "0.4.7", "0.4.5"],
			["numeric order: 0.4.10 on main, 0.4.9 here", "0.4.10", "0.4.9"],
		]) {
			it(`RED: a raise against main with ${label} is refused, naming both versions`, () => {
				const counts = { ...base().counts, "CR-2": 264 };
				const prev = baselineFile({ ...base(), doctorVersion: mainVersion });
				const head = baselineFile({
					...base(),
					doctorVersion: headVersion,
					counts,
				});
				const r = judge(
					head,
					evidenceWith(`npm @vantageos/backend-doctor@${headVersion}`, counts),
					prev,
				);
				expect(r.status).toBe(1);
				expect(r.out).toMatch(
					/baseline raised for CR-2: 200 on main -> 264 here/,
				);
				expect(r.out).toContain(`doctorVersion ${mainVersion}`);
				expect(r.out).toContain(`names ${headVersion}`);
				expect(last(r)).toMatch(/ rise=1$/);
			});
		}

		it("RED: a raise against an unversioned main baseline is refused, saying main names no version", () => {
			const counts = { ...base().counts, "CR-2": 264 };
			const { doctorVersion: _drop, ...unversioned } = base();
			const prev = baselineFile(unversioned);
			const head = baselineFile({ ...base(), doctorVersion: "0.4.7", counts });
			const r = judge(
				head,
				evidenceWith("npm @vantageos/backend-doctor@0.4.7", counts),
				prev,
			);
			expect(r.status).toBe(1);
			expect(r.out).toMatch(/baseline raised for CR-2/);
			expect(r.out).toMatch(/names no doctorVersion/);
		});
	});

	// A drop left unlowered is headroom a later PR spends with rise=0 (#1566 CR-2
	// 262->256, #1567 CR-2 262->261 both shipped through a PASS that only asked).
	describe("a count below the PR's own baseline must be written into it", () => {
		const base = () => JSON.parse(readFileSync(BASELINE, "utf8"));
		const CR2_BASE = 262;
		const counts = (cr2) => ({ ...base().counts, "CR-2": cr2 });
		function evidenceCr2(cr2) {
			const doc = JSON.parse(readFileSync(join(FIX, "equal.json"), "utf8"));
			const out = join(tmp(), "evidence.json");
			writeFileSync(
				out,
				JSON.stringify({ ...doc, mechanical_rule_counts: counts(cr2) }),
			);
			return out;
		}
		function baselineCr2(cr2, extra = {}) {
			const out = join(tmp(), "ratchet.json");
			writeFileSync(
				out,
				JSON.stringify({ ...base(), counts: counts(cr2), ...extra }),
			);
			return out;
		}
		// main says 262; the PR's baseline says `own`; the doctor measured `measured`.
		const judge = (own, measured) =>
			run([
				"--baseline",
				baselineCr2(own),
				"--evidence",
				evidenceCr2(measured),
				"--previous-baseline",
				baselineCr2(CR2_BASE),
			]);
		const last = (r) => r.out.trim().split("\n").at(-1);

		it("RED (#1566): CR-2 measured 256, ratchet.json still 262 -> exit 1 naming rule, count and value to write", () => {
			const r = judge(262, 256);
			expect(r.status).toBe(1);
			expect(r.out).toContain(
				'CR-2: measured 256, ratchet.json says 262 -> write "CR-2": 256',
			);
			expect(last(r)).toMatch(/^RATCHET: .* CR-2=256 .* rise=0$/);
		});

		it("GREEN (#1566): the same tree with ratchet.json lowered to 256 passes", () => {
			const r = judge(256, 256);
			expect(r.status).toBe(0);
			expect(last(r)).toMatch(/^RATCHET: .* CR-2=256 .* rise=0$/);
		});

		it("RED (#1567): CR-2 261 vs 262 unlowered -> exit 1", () => {
			const r = judge(262, 261);
			expect(r.status).toBe(1);
			expect(r.out).toContain(
				'CR-2: measured 261, ratchet.json says 262 -> write "CR-2": 261',
			);
		});

		it("GREEN (#1567): CR-2 261 with ratchet.json lowered to 261 passes", () => {
			expect(judge(261, 261).status).toBe(0);
		});

		it("GREEN: an unchanged count passes", () => {
			expect(judge(262, 262).status).toBe(0);
		});

		it("RED: a rise above main's baseline still fails", () => {
			expect(judge(263, 263).status).toBe(1);
		});

		it("RED: every unlowered rule is named, not only the first", () => {
			const doc = JSON.parse(readFileSync(join(FIX, "lowered.json"), "utf8"));
			const out = join(tmp(), "evidence.json");
			writeFileSync(
				out,
				JSON.stringify({
					...doc,
					mechanical_rule_counts: { ...counts(256), "R-5": 60 },
				}),
			);
			const r = run([
				"--baseline",
				baselineCr2(262),
				"--evidence",
				out,
				"--previous-baseline",
				baselineCr2(262),
			]);
			expect(r.status).toBe(1);
			expect(r.out).toContain('write "CR-2": 256');
			expect(r.out).toContain('write "R-5": 60');
		});

		it("GREEN: a marker count below main does not need a baseline edit (markers are not in ratchet.json)", () => {
			// covered by "fewer markers than main pass"; asserted here as the separation pole
			expect(judge(262, 262).out).not.toMatch(/write "M-/);
		});

		it("could-not-judge: missing evidence still exits 2", () => {
			const r = runRaw([
				"--baseline",
				baselineCr2(262),
				"--evidence",
				join(tmp(), "absent.json"),
				"--previous-baseline",
				baselineCr2(262),
				"--report",
				CLEAN_REPORT,
				"--tree",
				CLEAN_TREE,
			]);
			expect(r.status).toBe(2);
		});

		it("GREEN: a re-baseline (doctorVersion raise) lowering nothing still passes", () => {
			const prev = baselineCr2(262);
			const head = baselineCr2(264, { doctorVersion: "0.4.7" });
			const doc = JSON.parse(readFileSync(join(FIX, "equal.json"), "utf8"));
			const ev = join(tmp(), "evidence.json");
			writeFileSync(
				ev,
				JSON.stringify({
					...doc,
					cli_commit: "npm @vantageos/backend-doctor@0.4.7",
					mechanical_rule_counts: counts(264),
				}),
			);
			const r = run([
				"--baseline",
				head,
				"--evidence",
				ev,
				"--previous-baseline",
				prev,
			]);
			expect(r.status).toBe(0);
		});
	});
});

describe("doctor-ratchet: the RATCHET line names every ratcheted key", () => {
	it("a key outside the historical six (CR-3) is printed with its measured count", () => {
		const dir = mkdtempSync(join(tmpdir(), "ratchet-line-"));
		try {
			const base = JSON.parse(readFileSync(BASELINE, "utf8"));
			base.counts["CR-3"] = 16;
			const ev = JSON.parse(readFileSync(join(FIX, "equal.json"), "utf8"));
			ev.mechanical_rule_counts["CR-3"] = 16;
			const basePath = join(dir, "baseline.json");
			const evPath = join(dir, "evidence.json");
			writeFileSync(basePath, JSON.stringify(base));
			writeFileSync(evPath, JSON.stringify(ev));
			const r = run([
				"--baseline",
				basePath,
				"--evidence",
				evPath,
				"--previous-baseline",
				basePath,
			]);
			const last = r.out.trim().split("\n").at(-1);
			expect(last).toMatch(/^RATCHET: /);
			expect(last).toContain("CR-3=16");
			expect(last).toContain(
				"CR-2=200 R-5=62 R-53=369 R-54=148 R-55=31 R-56=2",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
