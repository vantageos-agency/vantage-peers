import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Full-suite gates for two disabled workflows.
 *
 * GitHub Actions are disabled on this repository, so .github/workflows/check-generated.yml and
 * .github/workflows/mcp-server-lockfile-isolated.yml run no job. These tests ARE the gates:
 * `npx vitest run` at the repo root collects them.
 *
 * 1. check-generated.yml, module-coverage step: every Convex module under convex/ (recursive,
 *    nested lib/, migrations/, _helpers/ included) has its `"../<path>.js"` import in
 *    convex/_generated/api.d.ts. Same exclusions as the workflow: *.test.ts, *.spec.ts, and the
 *    config-only modules schema.ts, auth.config.ts, convex.config.ts.
 *    NOT ported (declared here, where the reader sees it): the workflow's full drift check,
 *    `npx convex codegen && git diff --exit-code convex/_generated`. Codegen talks to a live
 *    deployment and needs CONVEX_DEPLOY_KEY; the full suite holds no secret. It stays tied to the
 *    workflow header and to task k178k1e07c9tq1k2vb2wgxzw0x8jvx5d.
 *
 * 2. mcp-server-lockfile-isolated.yml: Railway builds mcp-server with rootDirectory=/mcp-server,
 *    copying only mcp-server/package.json and mcp-server/bun.lock, then runs
 *    `bun install --frozen-lockfile` with no monorepo parent to resolve against. This test copies
 *    those two files into an empty temporary directory and runs the same command there.
 *
 * Fail-closed: a missing api.d.ts, zero modules found, no bun, or a spawn error FAILS the test.
 * Paths are derived from this file's location, never from the cwd.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const convexDir = join(repoRoot, "convex");
const apiDts = join(convexDir, "_generated", "api.d.ts");

const CONFIG_ONLY = new Set(["schema", "auth.config", "convex.config"]);

/** Every convex/ .ts module path, relative to convex/, without extension, "/"-separated. */
function convexModules(dir = convexDir) {
	const out = [];
	for (const entry of readdirSync(dir, {
		withFileTypes: true,
		recursive: true,
	})) {
		if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
		const full = join(entry.parentPath ?? entry.path, entry.name);
		const rel = relative(dir, full).split(sep).join("/").replace(/\.ts$/, "");
		if (rel.startsWith("_generated/")) continue;
		const base = rel.split("/").pop();
		if (base.endsWith(".test") || base.endsWith(".spec")) continue;
		if (CONFIG_ONLY.has(rel)) continue;
		out.push(rel);
	}
	return out.sort();
}

describe("check-generated gate (module coverage, ported from .github/workflows/check-generated.yml)", () => {
	it("every Convex module has its import in convex/_generated/api.d.ts", () => {
		expect(
			existsSync(apiDts),
			`${apiDts} not found; the module-coverage gate cannot run.`,
		).toBe(true);
		const api = readFileSync(apiDts, "utf8");
		const modules = convexModules();
		expect(
			modules.length,
			"no Convex module found under convex/; the walk read nothing, so the gate cannot judge.",
		).toBeGreaterThan(0);
		const missing = modules.filter((rel) => !api.includes(`"../${rel}.js"`));
		expect(
			missing,
			`${missing.length} Convex module(s) have no matching entry in convex/_generated/api.d.ts; run 'npx convex codegen' and commit the result:\n${missing.map((m) => `  convex/${m}.ts`).join("\n")}`,
		).toEqual([]);
	});
});

describe("mcp-server isolated lockfile gate (ported from .github/workflows/mcp-server-lockfile-isolated.yml)", () => {
	it("mcp-server/bun.lock installs frozen outside the monorepo, as Railway builds it", () => {
		const pkg = join(repoRoot, "mcp-server", "package.json");
		const lock = join(repoRoot, "mcp-server", "bun.lock");
		for (const f of [pkg, lock]) {
			expect(
				existsSync(f),
				`${f} not found; the isolated lockfile gate cannot run.`,
			).toBe(true);
		}
		const dir = mkdtempSync(join(tmpdir(), "mcp-server-isolated-"));
		try {
			copyFileSync(pkg, join(dir, "package.json"));
			copyFileSync(lock, join(dir, "bun.lock"));
			const result = spawnSync("bun", ["install", "--frozen-lockfile"], {
				cwd: dir,
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
				timeout: 240_000,
			});
			if (result.error) {
				throw new Error(
					`bun install could not be spawned: ${result.error.message}`,
				);
			}
			expect(
				result.status,
				`bun install --frozen-lockfile exited ${result.status} (signal ${result.signal}) in an isolated copy of mcp-server/package.json + mcp-server/bun.lock. Regenerate the lockfile FROM AN ISOLATED TREE (copy both files to an empty directory, run 'bun install' there, copy bun.lock back), never from inside the monorepo, where bun resolves the parent workspace.\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
			).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 300_000);
});
