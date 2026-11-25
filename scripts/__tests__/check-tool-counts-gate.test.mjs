import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Full-suite gate for scripts/check-tool-counts.mjs: MCP tool tallies in mcp-server/README.md (and the docs catalogues when present) equal the registered tool surface.
 *
 * GitHub Actions are disabled on this repository, so .github/workflows/check-tool-counts.yml runs no job.
 * This test IS the gate: `npx vitest run` at the repo root collects it and runs the same script
 * the workflow ran, requiring exit code 0. A non-zero exit turns it red with the script's own output.
 *
 * Fail-closed: a missing script or a spawn error FAILS the test. A gate that cannot run is red.
 * Paths are derived from this file's location, never from the cwd.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repoRoot, "scripts", "check-tool-counts.mjs");

describe("check-tool-counts gate (ported from .github/workflows/check-tool-counts.yml)", () => {
	it("scripts/check-tool-counts.mjs exits 0", () => {
		expect(existsSync(script), `${script} not found; the check-tool-counts gate cannot run.`).toBe(true);
		const result = spawnSync(process.execPath, [script], {
			cwd: repoRoot,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
		if (result.error) {
			throw new Error(`check-tool-counts could not be spawned: ${result.error.message}`);
		}
		expect(
			result.status,
			`check-tool-counts exited ${result.status} (signal ${result.signal}).\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
		).toBe(0);
	}, 60_000);
});
