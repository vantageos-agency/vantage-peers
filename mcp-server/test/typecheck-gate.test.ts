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
 * NOT COVERED: convex/ is NOT typechecked by this gate. The root project
 * (`npx tsc --noEmit` at the repo root, which includes only convex/) is red on
 * main with 3 errors, all in convex/__tests__/ (a missing JsonWebKey type and
 * two untyped .mjs imports). That debt belongs to the Convex owner and is
 * traced in task k17ebtntz80wst04av4b6ae6sn8jtb9v. A gate that is red from day
 * one would be removed, so the convex half is added once that task lands.
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

describe("typecheck gate (mcp-server)", () => {
	it("mcp-server/ typechecks clean under mcp-server/tsconfig.json", () => {
		expect(
			existsSync(tscBin),
			`tsc binary not found at ${tscBin}; the typecheck gate cannot run. Install root dependencies (bun install --frozen-lockfile at the repo root).`,
		).toBe(true);

		const result = spawnSync(tscBin, ["--noEmit", "-p", "mcp-server"], {
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
			`tsc --noEmit -p mcp-server exited ${result.status} (signal ${result.signal}). Fix the type errors below.\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
		).toBe(0);
	}, 300_000);
});
