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
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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

// ─── Refusal-text scan ──────────────────────────────────────────────────────
// Scope is DERIVED from the source tree: every non-test .ts file under
// convex/ (minus _generated/ and __tests__/) and under mcp-server/src (minus
// __tests__/). Refusal texts are the string/template literals inside the
// arguments of `throw ...`, `new <X>Error(...)` (ConvexError, Error,
// McpError, ...), the MCP error-result helpers `mcpError(...)` /
// `mcpConvexError(...)`, and any REFUSAL HELPER derived from the tree: a
// function with a parameter used only inside its own refusals (e.g.
// `requireId(..., hint)` throws `${base} ${hint}`), iterated to a fixed
// point so helpers of helpers count too. A refusal inside a tool's own
// registration that names that same tool is exempt (it can only fire once
// the tool is callable). A message stored in a local variable before being
// thrown is not followed (no data flow); inline literals are the
// established style.
const REPO_ROOT = join(PKG_ROOT, "..");
const SEED_REFUSAL_CALLEES = ["mcpError", "mcpConvexError"];
const LITERAL_KINDS = new Set([
	ts.SyntaxKind.StringLiteral,
	ts.SyntaxKind.NoSubstitutionTemplateLiteral,
	ts.SyntaxKind.TemplateHead,
	ts.SyntaxKind.TemplateMiddle,
	ts.SyntaxKind.TemplateTail,
]);

function listSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (["_generated", "__tests__", "node_modules"].includes(entry.name))
				continue;
			out.push(...listSourceFiles(full));
		} else if (
			entry.name.endsWith(".ts") &&
			!entry.name.endsWith(".test.ts") &&
			!entry.name.endsWith(".d.ts")
		) {
			out.push(full);
		}
	}
	return out;
}

function isRefusalNode(node: ts.Node, callees: Set<string>): boolean {
	if (ts.isThrowStatement(node)) return true;
	if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
		return node.expression.text.endsWith("Error");
	}
	if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
		return callees.has(node.expression.text);
	}
	return false;
}

// Arguments only, never the callee itself.
function refusalPayloads(node: ts.Node): ts.Node[] {
	if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
		return [...(node.arguments ?? [])];
	}
	return [node];
}

type NamedFn = { name: string; params: Set<string>; body: ts.Node };

function paramNames(fn: ts.SignatureDeclarationBase): Set<string> {
	const names = new Set<string>();
	for (const p of fn.parameters) {
		if (ts.isIdentifier(p.name)) names.add(p.name.text);
	}
	return names;
}

function namedFunctions(sf: ts.SourceFile): NamedFn[] {
	const out: NamedFn[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isFunctionDeclaration(node) && node.name && node.body) {
			out.push({
				name: node.name.text,
				params: paramNames(node),
				body: node.body,
			});
		} else if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			(ts.isArrowFunction(node.initializer) ||
				ts.isFunctionExpression(node.initializer))
		) {
			out.push({
				name: node.name.text,
				params: paramNames(node.initializer),
				body: node.initializer.body,
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return out;
}

// A refusal helper has a MESSAGE parameter: one referenced in its body, and
// only ever inside a refusal payload (requireId's `hint`). A parameter that
// also drives other logic (defineTool's tool `name`) does not qualify.
function hasMessageParam(fn: NamedFn, callees: Set<string>): boolean {
	const total = new Map<string, number>();
	const inRefusal = new Map<string, number>();
	const bump = (m: Map<string, number>, k: string) =>
		m.set(k, (m.get(k) ?? 0) + 1);
	const countIn = (m: Map<string, number>) => (node: ts.Node) => {
		const walk = (n: ts.Node) => {
			if (ts.isIdentifier(n) && fn.params.has(n.text)) bump(m, n.text);
			ts.forEachChild(n, walk);
		};
		walk(node);
	};
	countIn(total)(fn.body);
	const visit = (node: ts.Node) => {
		if (isRefusalNode(node, callees)) {
			for (const payload of refusalPayloads(node)) countIn(inRefusal)(payload);
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(fn.body);
	for (const [param, n] of total) {
		if (n > 0 && inRefusal.get(param) === n) return true;
	}
	return false;
}

type RefusalHit = { file: string; line: number; tool: string };

function scanRefusalToolNames(registered: Set<string>): RefusalHit[] {
	const parsed = [
		...listSourceFiles(join(REPO_ROOT, "convex")),
		...listSourceFiles(join(PKG_ROOT, "src")),
	].map((path) =>
		ts.createSourceFile(
			path,
			readFileSync(path, "utf-8"),
			ts.ScriptTarget.Latest,
			true,
		),
	);

	// Derive refusal helpers from the tree, to a fixed point.
	const callees = new Set(SEED_REFUSAL_CALLEES);
	const fns = parsed.flatMap(namedFunctions);
	let grew = true;
	while (grew) {
		grew = false;
		for (const fn of fns) {
			if (!callees.has(fn.name) && hasMessageParam(fn, callees)) {
				callees.add(fn.name);
				grew = true;
			}
		}
	}

	const hits = new Map<string, RefusalHit>();
	for (const sf of parsed) {
		const rel = relative(REPO_ROOT, sf.fileName);
		const collect = (node: ts.Node, self: Set<string>) => {
			if (LITERAL_KINDS.has(node.kind)) {
				const raw = node.getText(sf);
				const base = node.getStart(sf);
				for (const m of raw.matchAll(/[a-z][a-z0-9_]*/g)) {
					if (!registered.has(m[0]) || self.has(m[0])) continue;
					const line =
						sf.getLineAndCharacterOfPosition(base + (m.index ?? 0)).line + 1;
					hits.set(`${rel}:${line}:${m[0]}`, { file: rel, line, tool: m[0] });
				}
			}
			ts.forEachChild(node, (child) => collect(child, self));
		};
		// Names carried as a direct string argument by an ENCLOSING call (the
		// tool's own registration, e.g. defineTool(..., "delete_bu", ...)).
		// A refusal inside tool X's own handler that names X can only fire
		// once X is callable, so it never points a caller at a dead verb.
		const enclosing: string[][] = [];
		const visit = (node: ts.Node) => {
			if (isRefusalNode(node, callees)) {
				const self = new Set(enclosing.flat());
				for (const payload of refusalPayloads(node)) collect(payload, self);
			}
			const own =
				ts.isCallExpression(node) || ts.isNewExpression(node)
					? (node.arguments ?? []).filter(ts.isStringLiteral).map((a) => a.text)
					: [];
			enclosing.push(own);
			ts.forEachChild(node, visit);
			enclosing.pop();
		};
		visit(sf);
	}
	return [...hits.values()].sort(
		(a, b) => a.file.localeCompare(b.file) || a.line - b.line,
	);
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
	}, 60_000);

	it("advertises pause_task, resume_task and correct_task_segment: the closure gate's SEGMENT_DURATION_IMPLAUSIBLE refusal names the segment verbs, so a client must be able to call them", () => {
		const result = runDumpToolNames();
		expect(result.status).toBe(0);
		const advertised = new Set<string>(JSON.parse(result.stdout));

		for (const verb of ["pause_task", "resume_task", "correct_task_segment"]) {
			expect(CORE_NAMES, `${verb} missing from core`).toContain(verb);
			expect(advertised.has(verb), `${verb} not advertised`).toBe(true);
		}
	}, 60_000);

	it("advertises every registered tool named in any refusal text in the source tree, so no refusal points at an uncallable verb", () => {
		// Every tool the server REGISTERS, enabled or masked.
		const all = runDumpToolNames({ VP_DUMP_ALL_REGISTERED: "1" });
		expect(all.status).toBe(0);
		const registered = new Set<string>(JSON.parse(all.stdout));
		expect(registered.has("fail_task")).toBe(true);

		const hits = scanRefusalToolNames(registered);
		const found = (file: string, tool: string) =>
			hits.some((h) => h.file === file && h.tool === tool);
		// Positive controls: the scan reaches both known refusal sites.
		expect(found("convex/lib/taskClosureGate.ts", "pause_task")).toBe(true);
		expect(found("convex/tasks.ts", "fail_task")).toBe(true);
		// A derived refusal helper (requireId's hint argument) is scanned too.
		expect(found("convex/missions.ts", "list_missions")).toBe(true);

		const core = new Set(CORE_NAMES);
		const offenders = hits
			.filter((h) => !core.has(h.tool))
			.map((h) => `${h.file}:${h.line} -> ${h.tool}`);
		const namedTools = new Set(hits.map((h) => h.tool));
		console.log(
			`refusal-named tools: ${namedTools.size} (${hits.length} sites); offenders: ${offenders.length}`,
		);
		expect(offenders, `refusal text names non-core tools`).toEqual([]);
	}, 60_000);

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
	}, 60_000);
});
