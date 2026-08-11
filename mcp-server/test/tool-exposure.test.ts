/**
 * mcp-server/test/tool-exposure.test.ts
 *
 * S8 (mission vp-mcp-alias-cleanup-v1) — DATA-DRIVEN CORE-tool-exposure
 * ALLOWLIST at the VantagePeers MCP server's single registration surface
 * (registerTools() in src/tools.ts, shared by both server.ts stdio and
 * server-http.ts). Nothing is deleted from the server or the DB — a tool
 * whose name is NOT in the `core` allowlist is simply not
 * registered/advertised to clients. Reverting = removing a line from
 * tool-exposure.json.
 *
 * The exposed set is DERIVED from
 * analysis/vantagepeers/vp-restructuring/vp-by-tool-day158.csv (outil column
 * where T2_verdict == "CORE"), intersected with the actually-registered
 * tool-name set (PR #1169 removed 14 duplicate aliases after the CSV was
 * dated — 5 CORE names in the CSV are condemned aliases whose CORE
 * survivors are also CORE and remain registered, so zero capability is
 * lost). tool-exposure.json IS that derived intersection — see its own
 * header comment for the exact derivation command.
 *
 * Strategy ported from vantage-registry/mcp-server/tests/tool-exposure.test.ts
 * (Omega's PR #293 registration-point interception pattern): spawn a CHILD
 * PROCESS (test/support/dump-tool-names.mjs) that registers a Node ESM
 * loader (test/support/mcp-stub-loader.mjs) BEFORE dynamically importing the
 * built dist/server.js bundle. The loader stubs the
 * McpServer/StdioServerTransport/ConvexHttpClient externals so the import
 * records every attempted `s.tool(name, ...)` call on
 * globalThis.__VP_TOOLS__ instead of starting a real server or touching the
 * network. A CHILD PROCESS is required (not an in-process dynamic import())
 * because vitest's vite-node SSR transform rewrites dynamic import() inside
 * test files and bypasses native Node `node:module` register() loader hooks.
 *
 * Run with:
 *   cd mcp-server && npx vitest run test/tool-exposure.test.ts
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const HERE = new URL(".", import.meta.url);
const DUMP_SCRIPT = new URL("./support/dump-tool-names.mjs", HERE);
// mcp-server package root (this file lives at mcp-server/test/)
const PKG_ROOT = fileURLToPath(new URL("..", HERE));
const DIST_ENTRY = join(PKG_ROOT, "dist", "server.js");

// This test imports the BUILT bundle (dist/server.js) via a child-process
// dump harness — it needs a real compiled server, not source, because the
// registration-point interception loader stubs modules at import time.
// A fresh clone / clean CI checkout has no dist/ yet, so build it once here
// before any test runs. Guarded on existence so repeated local runs (with a
// still-fresh dist/) stay fast.
beforeAll(() => {
	if (existsSync(DIST_ENTRY)) return;
	const build = spawnSync("npm", ["run", "build"], {
		cwd: PKG_ROOT,
		encoding: "utf-8",
		shell: process.platform === "win32",
	});
	if (build.status !== 0) {
		throw new Error(
			`tool-exposure.test.ts: "npm run build" failed (status ${build.status}) while ` +
				`preparing dist/server.js for the fresh-clone test harness.\n--- stdout ---\n${build.stdout}\n--- stderr ---\n${build.stderr}`,
		);
	}
	if (!existsSync(DIST_ENTRY)) {
		throw new Error(
			`tool-exposure.test.ts: "npm run build" reported success but ${DIST_ENTRY} is still missing.`,
		);
	}
}, 120_000);

// The core (exposed) names ARE the data file — read it, never duplicate it
// in code. The arbitration (which tools are CORE) can grow without touching
// this test.
const CORE_NAMES: string[] = JSON.parse(
	readFileSync(new URL("../tool-exposure.json", HERE), "utf-8"),
).core;

const tempPaths: string[] = [];

afterEach(() => {
	for (const p of tempPaths.splice(0)) {
		try {
			rmSync(p, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

function runDumpToolNames(extraEnv: Record<string, string> = {}) {
	return spawnSync(process.execPath, [DUMP_SCRIPT.pathname], {
		env: { ...process.env, ...extraEnv },
		encoding: "utf-8",
	});
}

describe("tool-exposure filter (data-driven allowlist, registration-point)", () => {
	it("advertises only tool-exposure.json's core names, hides every other registered tool", () => {
		const result = runDumpToolNames();
		expect(result.status).toBe(0);
		const registeredNames: string[] = JSON.parse(result.stdout);
		const registeredSet = new Set(registeredNames);

		// A representative CORE tool stays advertised.
		expect(registeredSet.has("store_memory")).toBe(true);
		expect(registeredSet.has("recall")).toBe(true);

		// A representative non-CORE tool (not in tool-exposure.json's core list)
		// is masked — present in the codebase/DB, absent from the advertised set.
		const maskedSample = "accept_mandate";
		expect(CORE_NAMES.includes(maskedSample)).toBe(false);
		expect(registeredSet.has(maskedSample)).toBe(false);

		// Exactly the core list is advertised, derived from the data file —
		// never a hardcoded count.
		expect(registeredNames.length).toBe(CORE_NAMES.length);
		expect(registeredSet).toEqual(new Set(CORE_NAMES));
	});

	it("throws at startup naming an unknown core name, refusing to start", () => {
		const dir = mkdtempSync(join(tmpdir(), "vp-tool-exposure-"));
		tempPaths.push(dir);
		const fixturePath = join(dir, "tool-exposure.json");
		writeFileSync(
			fixturePath,
			JSON.stringify({ core: ["__does_not_exist__"] }),
		);

		const result = runDumpToolNames({ VP_TOOL_EXPOSURE_PATH: fixturePath });

		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(
			/tool-exposure: core name\(s\) not found among registered tools: __does_not_exist__/,
		);
	});
});
