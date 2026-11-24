import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Biome format gate for mcp-server/.
 *
 * GitHub Actions are disabled on this repository, so no workflow gates
 * formatting. This test IS the gate: it runs inside the full-suite command
 * (`npx vitest run` at the repo root, and `vitest run` in mcp-server/).
 *
 * It runs `biome format mcp-server biome.json` WITHOUT --write and requires
 * exit code 0. Any unformatted file turns it red and the failure message
 * carries Biome's own output, which names the files.
 *
 * Declared exclusion: mcp-server/src/tools.ts is excluded by an override in
 * biome.json (source-scanning tests read it by line position), so it is not
 * checked here either.
 *
 * Fail-closed: if the Biome binary cannot be found or cannot be spawned, the
 * test FAILS. A gate that cannot run is red, never green.
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

describe("biome format gate (mcp-server)", () => {
	it("mcp-server/ and biome.json are formatted per biome.json", () => {
		expect(
			existsSync(biomeBin),
			`Biome binary not found at ${biomeBin}; the format gate cannot run. Install root dependencies (bun install --frozen-lockfile at the repo root).`,
		).toBe(true);

		const result = spawnSync(biomeBin, ["format", "mcp-server", "biome.json"], {
			cwd: repoRoot,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});

		if (result.error) {
			throw new Error(
				`Biome could not be spawned (${biomeBin}): ${result.error.message}`,
			);
		}
		expect(
			result.status,
			`biome format exited ${result.status} (signal ${result.signal}). Run \`./node_modules/.bin/biome format --write mcp-server biome.json\` at the repo root.\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
		).toBe(0);
	}, 60_000);
});
