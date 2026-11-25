import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * TypeScript typecheck gate for mcp-server/.
 *
 * GitHub Actions are disabled on this repository, so no workflow gates the
 * typecheck. This test IS the gate: it runs inside the full-suite command
 * (`npx vitest run` at the repo root, and `vitest run` in mcp-server/).
 *
 * It runs `tsc --noEmit -p mcp-server` and requires exit code 0. The retired
 * typecheck workflow ran `npx tsc --noEmit` at the root, whose tsconfig includes
 * convex/ only, so mcp-server/ had no typecheck gate at all before this test. On red,
 * the failure message carries tsc's own diagnostics, which name the files.
 *
 * It also runs `tsc --noEmit -p convex` (convex/tsconfig.json, the Convex
 * functions project), which is clean on main.
 *
 * And it runs the ROOT project (`tsc --noEmit -p .`, tsconfig "include":
 * ["convex"], which adds convex/__tests__/): the exact command the retired
 * typecheck workflow ran. It was red with 3 errors in convex/__tests__/ until
 * PR #1767 (task k17ebtntz80wst04av4b6ae6sn8jtb9v) cleared them; it is clean on
 * main since, so the gate holds all three projects.
 *
 * Fail-closed: if the tsc binary cannot be found or cannot be spawned, the
 * test FAILS. A gate that cannot run is red, never green.
 *
 * Paths are derived from this file's location, never from the cwd.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tscBin = join(
	repoRoot,
	"node_modules",
	".bin",
	process.platform === "win32" ? "tsc.cmd" : "tsc",
);

function runTsc(project: string) {
	expect(
		existsSync(tscBin),
		`tsc binary not found at ${tscBin}; the typecheck gate cannot run. Install root dependencies (bun install --frozen-lockfile at the repo root).`,
	).toBe(true);

	const result = spawnSync(tscBin, ["--noEmit", "-p", project], {
		cwd: repoRoot,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		timeout: 240_000,
	});

	if (result.error) {
		throw new Error(
			`tsc could not be run (${tscBin}): ${result.error.message}`,
		);
	}
	expect(
		result.status,
		`tsc --noEmit -p ${project} exited ${result.status} (signal ${result.signal}). Fix the type errors below.\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
	).toBe(0);
}

describe("typecheck gate", () => {
	it("mcp-server/ typechecks clean under mcp-server/tsconfig.json", () => {
		runTsc("mcp-server");
	}, 300_000);

	it("convex/ typechecks clean under convex/tsconfig.json", () => {
		runTsc("convex");
	}, 300_000);

	it("the root project typechecks clean under tsconfig.json (the retired workflow's command)", () => {
		runTsc(".");
	}, 300_000);
});
