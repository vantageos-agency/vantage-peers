import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Biome lint gate for mcp-server/.
 *
 * GitHub Actions are disabled on this repository, so no workflow gates lint.
 * This test IS the gate, beside biome-format-gate.test.ts: it runs inside the
 * full-suite command (`npx vitest run` at the repo root, and `vitest run` in
 * mcp-server/).
 *
 * Two properties:
 * 1. ERRORS: `biome lint mcp-server --diagnostic-level=error` exits 0. Any lint
 *    error turns it red, with Biome's own output naming the file and rule.
 * 2. WARNINGS NEVER RISE: the warning count reported by `biome lint mcp-server`
 *    is at most the ceiling recorded in mcp-server/biome-lint-baseline.json.
 *    The ceiling is a measurement, taken with the same command; when the count
 *    falls, the ceiling is lowered in the same change (the message says by how
 *    much), so the counter can only go down.
 *
 * Fail-closed: a Biome binary that cannot be found or spawned, a run that
 * prints no "Checked N file(s)" summary (it did not lint anything), or a
 * baseline file that does not parse, is red. A gate that cannot read is never
 * green. No "Found N warnings" line after a summary means zero warnings: Biome
 * prints the line only when there is at least one.
 *
 * Paths are derived from this file's location, never from the cwd.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const biomeBin = join(
	repoRoot,
	"node_modules",
	".bin",
	process.platform === "win32" ? "biome.cmd" : "biome",
);
const baselinePath = join(repoRoot, "mcp-server", "biome-lint-baseline.json");

function runBiome(args: string[]) {
	expect(
		existsSync(biomeBin),
		`Biome binary not found at ${biomeBin}; the lint gate cannot run. Install root dependencies (bun install --frozen-lockfile at the repo root).`,
	).toBe(true);
	const result = spawnSync(biomeBin, args, {
		cwd: repoRoot,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error) {
		throw new Error(
			`Biome could not be spawned (${biomeBin}): ${result.error.message}`,
		);
	}
	const out = `${result.stdout}\n${result.stderr}`;
	expect(
		/Checked \d+ files?/.test(out),
		`biome ${args.join(" ")} printed no "Checked N files" summary: it linted nothing, so this gate cannot read.\n${out}`,
	).toBe(true);
	return { status: result.status, out };
}

describe("biome lint gate (mcp-server)", () => {
	it("mcp-server/ has no Biome lint error", () => {
		const { status, out } = runBiome([
			"lint",
			"mcp-server",
			"--diagnostic-level=error",
		]);
		expect(
			status,
			`biome lint --diagnostic-level=error exited ${status}. Run \`./node_modules/.bin/biome lint mcp-server --diagnostic-level=error\` at the repo root.\n${out}`,
		).toBe(0);
	}, 60_000);

	it("the Biome warning count never rises above the recorded ceiling", () => {
		const raw = readFileSync(baselinePath, "utf8");
		const baseline = JSON.parse(raw) as { warnings?: unknown };
		expect(
			Number.isInteger(baseline.warnings),
			`${baselinePath} must hold an integer "warnings" ceiling; read: ${raw}`,
		).toBe(true);
		const ceiling = baseline.warnings as number;

		const { out } = runBiome(["lint", "mcp-server", "--max-diagnostics=0"]);
		const m = /Found (\d+) warnings?\./.exec(out);
		const warnings = m ? Number(m[1]) : 0;

		expect(
			warnings,
			`biome lint mcp-server reports ${warnings} warnings, above the ceiling ${ceiling} in mcp-server/biome-lint-baseline.json. A change may not add lint warnings.`,
		).toBeLessThanOrEqual(ceiling);
		expect(
			warnings,
			`biome lint mcp-server reports ${warnings} warnings, below the ceiling ${ceiling}: lower "warnings" in mcp-server/biome-lint-baseline.json to ${warnings} in this change, so the counter cannot rise back.`,
		).toBe(ceiling);
	}, 60_000);
});
