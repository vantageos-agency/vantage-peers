import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Full-suite gates for the Python test suites two disabled workflows ran.
 *
 * GitHub Actions are disabled on this repository, so .github/workflows/pytest-hooks.yml and
 * .github/workflows/plugin-vr-parity.yml run no job. These tests ARE the gates: `npx vitest run`
 * at the repo root collects them and runs the same pytest targets, requiring exit code 0.
 *
 * Ported: `pytest tests/hooks/` (pytest-hooks.yml) and the two plugin files that need no secret
 * (plugin-vr-parity.yml: test_source_prose_identity_guard.py, test_check_outward_contribution_verdict.py).
 *
 * NOT ported (declared here, where the reader sees it): tests/plugin/test_leak_guard.py needs the
 * client-identity vocabulary (VANTAGE_CLIENT_IDENTITIES or VANTAGE_CLIENT_HASHES) and
 * tests/plugin/test_vr_parity.py needs VANTAGE_REGISTRY_TOKEN. The full suite holds no secret, so
 * both refuse to judge there; they stay tied to the workflow header and to task
 * k178k1e07c9tq1k2vb2wgxzw0x8jvx5d.
 *
 * Fail-closed: no python3, no pytest, or a spawn error FAILS the test. A gate that cannot run is red.
 * Paths are derived from this file's location, never from the cwd.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function pytest(targets) {
	for (const t of targets) {
		expect(
			existsSync(join(repoRoot, t)),
			`${t} not found; the pytest gate cannot run.`,
		).toBe(true);
	}
	const result = spawnSync("python3", ["-m", "pytest", "-q", ...targets], {
		cwd: repoRoot,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		timeout: 240_000,
	});
	if (result.error) {
		throw new Error(
			`python3 -m pytest could not be spawned: ${result.error.message}`,
		);
	}
	expect(
		result.status,
		`pytest ${targets.join(" ")} exited ${result.status} (signal ${result.signal}); exit 1 = a test failed, 2+ = pytest could not run or collect.\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
	).toBe(0);
}

describe("pytest gates (ported from pytest-hooks.yml and plugin-vr-parity.yml)", () => {
	it("tests/hooks/ passes", () => {
		pytest(["tests/hooks/"]);
	}, 300_000);

	it("the secret-free plugin checks pass", () => {
		pytest([
			"tests/plugin/test_source_prose_identity_guard.py",
			"tests/plugin/test_check_outward_contribution_verdict.py",
		]);
	}, 300_000);
});
