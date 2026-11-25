import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Full-suite gate for scripts/grep-gate.sh: no legacy brand reference, no Buffer global in a V8-runtime Convex file.
 *
 * GitHub Actions are disabled on this repository, so .github/workflows/grep-gate.yml runs no job.
 * This test IS the gate: `npx vitest run` at the repo root collects it and runs the same script
 * the workflow ran, requiring exit code 0. A non-zero exit turns it red with the script's own output.
 *
 * Fail-closed: a missing script or a spawn error FAILS the test. A gate that cannot run is red.
 * Paths are derived from this file's location, never from the cwd.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repoRoot, "scripts", "grep-gate.sh");

describe("grep-gate gate (ported from .github/workflows/grep-gate.yml)", () => {
	it("scripts/grep-gate.sh exits 0", () => {
		expect(existsSync(script), `${script} not found; the grep-gate gate cannot run.`).toBe(true);
		const result = spawnSync("bash", [script], {
			cwd: repoRoot,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
		if (result.error) {
			throw new Error(`grep-gate could not be spawned: ${result.error.message}`);
		}
		expect(
			result.status,
			`grep-gate exited ${result.status} (signal ${result.signal}).\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
		).toBe(0);
	}, 60_000);
});
