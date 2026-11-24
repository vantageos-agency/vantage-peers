/**
 * The counter for "no published Convex registration is open to an unresolved
 * caller" is scripts/check-public-registrations-resolve-caller.py. This suite
 * does NOT assert that the count is zero — that would be a tolerated-count
 * baseline by another name, and the instrument deliberately has none. It pins
 * that the INSTRUMENT is sound: it reads what it claims to read, it can be red,
 * it can be green, and it goes red on its own coverage.
 *
 *   1. its own --self-test passes (three states reachable, coverage assertion
 *      fires, declarations are verified, not merely accepted);
 *   2. on THIS tree its population equals a THIRD, independent extraction done
 *      here in TypeScript over the raw bytes (the instrument has its own naive
 *      cross-check in Python; this is the one it cannot share a bug with), and
 *      it has no coverage error and no could-not-judge;
 *   3. bipolar by measurement on the real corpus: an injected unguarded
 *      registration raises the accused count by exactly one and turns the exit
 *      code red; guarding it, or declaring it `@open`, brings it back to the
 *      baseline. Nothing here writes to the repository — the corpus is copied.
 */

import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const CONVEX_DIR = join(__dirname, "..");
const REPO_ROOT = join(CONVEX_DIR, "..");
const SCRIPT = join(
	REPO_ROOT,
	"scripts",
	"check-public-registrations-resolve-caller.py",
);
// Each measurement of the real corpus is ~5 CPU-seconds. The instrument runs
// at normal priority: under `nice -n 19` its wall time was unbounded on a
// loaded host (measured: 2 CPU-s in 12 min beside 8 CPU burners; 207 s for the
// whole file at 8 burners). The cost is bounded by the NUMBER of corpus
// measurements per file (two: the live tree and one probed copy), and the
// timeout is sized for two of them with headroom, never relied on alone.
const SLOW = 180_000;

type Row = { id: string; state: string; via: string; reason: string };
type Report = {
	population: number;
	"resolves-a-caller": number;
	"does-not-resolve": number;
	"could-not-judge": number;
	coverage_errors: string[];
	registrations: Row[];
	exit: number;
};

function run(args: string[]): {
	status: number;
	stdout: string;
	stderr: string;
} {
	// No `nice`: it was added so this CPU-bound suite would not crowd siblings
	// near their 5s timeout (task k1759g5j6y3anzr2dnhfg5154h8fazb2), but it made
	// this suite's own wall time unbounded. The crowding came largely from
	// vitest also running every .claude/worktrees checkout; that is now excluded
	// in vitest.config.ts (task k1745b7rdfs6v7xxe9v4ph70nn8jtx19).
	const r = spawnSync("python3", [SCRIPT, ...args], {
		encoding: "utf-8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (r.error) throw r.error;
	return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** Run the instrument and parse its JSON; any other outcome says why, loudly. */
function runJson(args: string[]): { status: number; report: Report } {
	const r = run(args);
	if (!r.stdout || r.stdout.trim() === "") {
		throw new Error(
			`instrument produced no stdout (exit ${r.status}); stderr: ${r.stderr}`,
		);
	}
	try {
		return { status: r.status, report: JSON.parse(r.stdout) as Report };
	} catch (e) {
		throw new Error(
			`instrument stdout is not JSON (exit ${r.status}, ${r.stdout.length} bytes): ${String(e)}; stderr: ${r.stderr}`,
		);
	}
}

let realTree: Report | undefined;
/** One measurement of the real tree, shared by the tests that need it. */
function baseline(): Report {
	realTree ??= measure(CONVEX_DIR);
	return realTree;
}

function measure(convexDir: string): Report {
	return runJson(["--convex-dir", convexDir, "--json"]).report;
}

/** Independent population: api.d.ts module list, then every registration. */
function independentPopulation(): string[] {
	const api = readFileSync(join(CONVEX_DIR, "_generated", "api.d.ts"), "utf-8");
	const mods = [
		...api.matchAll(/^import type \* as [\w$]+ from "\.\.\/([^"]+)\.js";/gm),
	].map((m) => m[1]);
	const ids: string[] = [];
	for (const mod of mods) {
		let text: string;
		try {
			// Buffer -> latin1 so a raw NUL byte (errorMonitorFilters.ts) is data,
			// not a reason to skip the file.
			text = readFileSync(join(CONVEX_DIR, `${mod}.ts`)).toString("latin1");
		} catch {
			continue;
		}
		for (const m of text.matchAll(
			/^export const ([A-Za-z_$][\w$]*)\s*=\s*(?:query|mutation|action)\b/gm,
		)) {
			ids.push(`${mod}.${m[1]}`);
		}
	}
	return ids;
}

const scratch: string[] = [];
afterAll(() => {
	for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/**
 * A copy of the corpus: non-test sources plus the generated api.d.ts, beside a
 * link to the installed identity package. The instrument derives the package's
 * caller resolvers from its `@callerResolver` tags; without the package it
 * refuses to judge a hand-off (the absent-package pole is the instrument's own
 * self-test).
 */
function copyCorpus(): string {
	const dir = mkdtempSync(join(tmpdir(), "resolves-caller-corpus-"));
	scratch.push(dir);
	const dest = join(dir, "convex");
	const walk = (rel: string) => {
		for (const e of readdirSync(join(CONVEX_DIR, rel), {
			withFileTypes: true,
		})) {
			const r = rel ? join(rel, e.name) : e.name;
			if (e.isDirectory()) {
				if (e.name === "__tests__" || e.name === "node_modules") continue;
				if (e.name === "_generated") {
					mkdirSync(join(dest, r), { recursive: true });
					cpSync(join(CONVEX_DIR, r, "api.d.ts"), join(dest, r, "api.d.ts"));
					continue;
				}
				walk(r);
			} else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
				mkdirSync(join(dest, rel), { recursive: true });
				cpSync(join(CONVEX_DIR, r), join(dest, r));
			}
		}
	};
	walk("");
	mkdirSync(join(dir, "node_modules", "@vantageos"), { recursive: true });
	symlinkSync(
		join(REPO_ROOT, "node_modules", "@vantageos", "cloud-identity"),
		join(dir, "node_modules", "@vantageos", "cloud-identity"),
	);
	return dest;
}

const PROBE = `
export const zzProbeUnguarded = query({
	args: {},
	handler: async (ctx) => ctx.db.query("diary").collect(),
});
`;

describe("public-registration counter — the instrument itself", () => {
	test(
		"its own self-test passes",
		() => {
			const r = run(["--self-test"]);
			expect(r.stdout).toContain("self-test: PASS");
			expect(r.status).toBe(0);
		},
		SLOW,
	);

	test(
		"population on this tree equals an independent TypeScript extraction, with no coverage error and nothing it could not judge",
		() => {
			const rep = baseline();
			const independent = independentPopulation();
			expect(independent.length).toBeGreaterThan(0);
			expect(rep.population).toBe(independent.length);
			expect(rep.registrations.map((r) => r.id).sort()).toEqual(
				[...independent].sort(),
			);
			expect(rep.coverage_errors).toEqual([]);
			expect(rep["could-not-judge"]).toBe(0);
			// the three states partition the population
			expect(
				rep["resolves-a-caller"] +
					rep["does-not-resolve"] +
					rep["could-not-judge"],
			).toBe(rep.population);
			// exit 0 (all clear) or 1 (accused). 2 and 3 are the instrument failing.
			expect([0, 1]).toContain(rep.exit);
		},
		SLOW,
	);

	test(
		"bipolar on the real corpus: an unguarded registration is red, guarded or declared is back to baseline",
		() => {
			const base = baseline();

			const corpus = copyCorpus();
			const target = join(corpus, "diary.ts");
			const original = readFileSync(target, "utf-8");

			// ONE measurement of the corpus carries all three poles: an unguarded
			// probe (RED), one CLOSED (it now resolves its caller) and one DECLARED
			// in the code at its own registration (GREEN). Each run costs ~5
			// CPU-seconds and is starved on a loaded host, so the poles
			// are told apart by row, not by separate measurements.
			const closedProbe = PROBE.replace("zzProbeUnguarded", "zzProbeClosed")
				.replace(
					"handler: async (ctx) => ctx.db",
					"handler: async (ctx) => { await withOrgScope(ctx); return ctx.db",
				)
				.replace(".collect(),", ".collect(); },");
			const declaredProbe = PROBE.replace(
				"export const zzProbeUnguarded",
				"// @open a deliberately public probe with no tenant data in it\nexport const zzProbeDeclared",
			);
			writeFileSync(
				target,
				`${original}${PROBE}${closedProbe}${declaredProbe}`,
			);
			const probed = measure(corpus);
			const row = (id: string) =>
				probed.registrations.find((r) => r.id === `diary.${id}`);

			// RED pole: the unguarded one, and only it, is accused; the code is red.
			expect(probed.population).toBe(base.population + 3);
			expect(probed["does-not-resolve"]).toBe(base["does-not-resolve"] + 1);
			expect(probed.exit).toBe(1);
			expect(row("zzProbeUnguarded")?.state).toBe("does-not-resolve");

			// GREEN poles: guarded and declared add nothing to the accused count.
			expect(probed["could-not-judge"]).toBe(0);
			expect(row("zzProbeClosed")?.state).toBe("resolves-a-caller");
			expect(row("zzProbeDeclared")?.via).toBe("declared-open");
			expect(row("zzProbeDeclared")?.state).not.toBe("does-not-resolve");
		},
		SLOW,
	);

	test(
		"the instrument goes red on its own coverage: an api.d.ts that names nothing is exit 3, never zeros",
		() => {
			// A tiny tree, not a copy of the corpus: this test needs no real data
			// and the suite runs beside timing-sensitive siblings.
			const dir = mkdtempSync(join(tmpdir(), "resolves-caller-empty-"));
			scratch.push(dir);
			const corpus = join(dir, "convex");
			mkdirSync(join(corpus, "_generated"), { recursive: true });
			writeFileSync(
				join(corpus, "_generated", "api.d.ts"),
				"// every import removed\n",
			);
			writeFileSync(
				join(corpus, "x.ts"),
				"export const open = query({ args: {}, handler: async () => 1 });\n",
			);
			const { status, report: rep } = runJson([
				"--convex-dir",
				corpus,
				"--json",
			]);
			expect(status).toBe(3);
			expect(rep.coverage_errors.join(" ")).toContain("NON-VACUITY");
		},
		SLOW,
	);
});
