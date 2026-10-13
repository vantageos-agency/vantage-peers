/**
 * Ratchet on backend-doctor's mechanical rule counts (task
 * k179600rsb4xsv7a975cjkqwhs8g7qhv): a PR that raises any count fails before
 * review. Both poles run the real script as a child process against fixed
 * evidence files.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(REPO, "scripts", "doctor-ratchet.mjs");
const BASELINE = join(REPO, ".backend-doctor", "ratchet.json");
const FIX = join(REPO, "scripts", "__tests__", "fixtures", "doctor-ratchet");

const tmpDirs = [];
afterEach(() => {
	while (tmpDirs.length) rmSync(tmpDirs.pop(), { recursive: true, force: true });
});
function tmp() {
	const d = mkdtempSync(join(tmpdir(), "doctor-ratchet-"));
	tmpDirs.push(d);
	return d;
}

function run(args) {
	const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
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
			`RATCHET: ${"0".repeat(40)} CR-2=200 R-5=62 R-53=369 R-54=148 R-55=31 R-56=2 rise=0`,
		);
	});

	it("RED: the RATCHET line reports the number of risen rules", () => {
		const r = withBaseline("raised.json");
		expect(r.out).toMatch(/^RATCHET: 0{40} .*R-53=370 .*rise=1$/m);
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
		writeFileSync(report, "R-53 ... FALLBACK: oracle not derived from this tree\n");
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
			JSON.stringify({ ...base, counts: { ...base.counts, "R-53": 360, "CR-2": 199 } }),
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
		expect(run([]).status).toBe(2);
	});

	it("RED: --previous-baseline (main's baseline) is required; without it the run cannot judge", () => {
		const r = run(["--baseline", BASELINE, "--evidence", join(FIX, "equal.json")]);
		expect(r.status).toBe(2);
		expect(r.out).toMatch(/previous-baseline/);
	});

	it("RED (Eta, #1529): a PR that raises a count AND bumps its own baseline still reads rise=1 against main", () => {
		const d = tmp();
		const bumped = join(d, "ratchet.json");
		const base = JSON.parse(readFileSync(BASELINE, "utf8"));
		writeFileSync(bumped, JSON.stringify({ ...base, counts: { ...base.counts, "R-53": 370 } }));
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
		expect(r.out.trim().split("\n").at(-1)).toMatch(/^RATCHET: 0{40} .*R-53=370 .*rise=1$/);
	});
});
