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
 *    The gate names three outcomes, never one: STALE (bun says the lockfile is frozen but would
 *    change: regenerate it), NETWORK (the registry was unreachable or the run timed out: the
 *    lockfile was NOT judged, re-run with network access), UNRECOGNISED (any other failure: read
 *    the output). Every non-zero outcome stays RED; only the message differs.
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

const STALE_RE = /lockfile had changes, but lockfile is frozen/;
const NETWORK_LINE_RES = [
	/^error: \w+ downloading (tarball|manifest)/m,
	/^error: .*\b(ConnectionRefused|ConnectionClosed|ConnectionTimedOut|NetworkUnreachable|DNS\w*)\b/m,
];

/**
 * Classify a finished `bun install --frozen-lockfile` run. Pure.
 * STALE is checked before NETWORK: when both appear, the lockfile defect is real.
 * @param {{status: number|null, signal: string|null, error?: {code?: string}, stdout?: string, stderr?: string}} r
 * @returns {{kind: "pass"|"stale"|"network"|"unrecognised", detail?: string}}
 */
function classifyLockfileRun(r) {
	if (r.status === 0) return { kind: "pass" };
	const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
	if (STALE_RE.test(output)) return { kind: "stale" };
	if (r.error?.code === "ETIMEDOUT" || (r.signal && r.status == null)) {
		return { kind: "network", detail: "timed out" };
	}
	for (const re of NETWORK_LINE_RES) {
		const m = output.match(re);
		if (m) {
			const line = output.slice(m.index).split("\n")[0];
			return { kind: "network", detail: line };
		}
	}
	return { kind: "unrecognised" };
}

function lockfileFailureMessage(r, verdict) {
	const dump = `\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
	const head = `bun install --frozen-lockfile exited ${r.status} (signal ${r.signal}) in an isolated copy of mcp-server/package.json + mcp-server/bun.lock.`;
	if (verdict.kind === "stale") {
		return `${head} Regenerate the lockfile FROM AN ISOLATED TREE (copy both files to an empty directory, run 'bun install' there, copy bun.lock back), never from inside the monorepo, where bun resolves the parent workspace.${dump}`;
	}
	if (verdict.kind === "network") {
		return `${head} could not judge: the npm registry was unreachable (${verdict.detail}); the lockfile was NOT judged stale. Re-run with network access.${dump}`;
	}
	return `${head} could not judge: bun install failed for a reason this gate does not recognise; read the output below.${dump}`;
}

describe("mcp-server isolated lockfile gate classifier", () => {
	const shape = (o) => ({
		status: 1,
		signal: null,
		stdout: "",
		stderr: "",
		...o,
	});
	it("tells pass, stale, network (refused / timed out) and unrecognised apart", () => {
		expect(classifyLockfileRun(shape({ status: 0 })).kind).toBe("pass");
		expect(
			classifyLockfileRun(
				shape({
					stderr:
						"error: lockfile had changes, but lockfile is frozen\nerror: ConnectionRefused downloading tarball x@1.0.0",
				}),
			).kind,
		).toBe("stale");
		const refused = classifyLockfileRun(
			shape({
				stderr: "error: ConnectionRefused downloading tarball left-pad@1.3.0",
			}),
		);
		expect(refused.kind).toBe("network");
		expect(refused.detail).toContain("ConnectionRefused downloading tarball");
		expect(
			classifyLockfileRun(shape({ stderr: "error: DNSError resolving host" }))
				.kind,
		).toBe("network");
		expect(
			classifyLockfileRun(
				shape({
					status: null,
					signal: "SIGTERM",
					error: { code: "ETIMEDOUT" },
				}),
			),
		).toEqual({ kind: "network", detail: "timed out" });
		expect(
			classifyLockfileRun(shape({ status: null, signal: "SIGTERM" })).kind,
		).toBe("network");
		expect(
			classifyLockfileRun(shape({ stderr: "error: something else broke" }))
				.kind,
		).toBe("unrecognised");
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
			if (result.error && result.error.code !== "ETIMEDOUT") {
				throw new Error(
					`bun install could not be spawned: ${result.error.message}`,
				);
			}
			const verdict = classifyLockfileRun(result);
			expect(
				verdict.kind,
				verdict.kind === "pass" ? "" : lockfileFailureMessage(result, verdict),
			).toBe("pass");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 300_000);
});
