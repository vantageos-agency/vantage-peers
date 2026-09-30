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
	mkdirSync,
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

// ─── Skill-body tool-name scan ──────────────────────────────────────────────
// A skill file (`.claude/skills/<name>/SKILL.md`) is the same broken promise
// as a refusal text: it names a tool a client is told to call, and if that
// name is masked (registered but non-core), the client following the skill
// hits a wall. Scope is every `SKILL.md` under `.claude/skills/` (the skill
// BODY — the file a client actually loads — not `evals/`/`references/`
// sidecar files, which are examples, not instructions).
//
// THE DISCRIMINATOR IS THE REGISTRATION SURFACE, NOT THE SPELLING. A skill
// body is prose: it names tool verbs, but also parameters, status values and
// ordinary words, in the same snake_case shape. What separates a tool
// reference from a parameter name is not how it is punctuated — it is whether
// the server REGISTERS that name at all. So every form below is gated on the
// `registered` set (core + masked, from VP_DUMP_ALL_REGISTERED), and a name
// the server does not register is not a tool reference in any form.
// Measured on this corpus: of the bare snake_case names appearing in skill
// bodies that the exposure artifact does not list, 12 are distinct and only
// ONE (`list_repo_mappings`) is a registered tool; the other 11 are
// parameters (`base_branch`, `default_namespace`, `subagent_type`, ...) and a
// task status (`in_progress`). The registered-set gate excludes all 11 by
// construction — there is no exemption list here, and adding one would be the
// instrument admitting it cannot tell a verb from a parameter.
//
// THREE FORMS ARE READ, all registered-gated:
//   1. `mcp__vantage-peers__<name>` — fully qualified (103 hits in this tree).
//   2. A whole backtick span whose entire content is a registered name —
//      `` `list_repo_mappings` `` — the bare-backtick form. This is the form
//      the previous revision of this scan claimed did not exist; it does, in
//      `open-pr/SKILL.md`, and it named a masked tool while this guard stayed
//      green. That false claim is why the reasoning below is stated as what
//      the extraction DOES, never as a census of what happens to occur today.
//   3. A bare snake_case token anywhere on the line (no delimiter required),
//      i.e. one containing at least one `_`. This reaches the undelimited
//      command-line/comment form (`# derived from list_repo_mappings`), which
//      is the form a caller is most likely to copy verbatim.
//
// DELIBERATELY NOT READ, and why — a NAMED limit, not a "none exist today":
//   * A bare, UNDELIMITED single-word name with no underscore (`recall`,
//     `whoami`). Such a name is indistinguishable from the ordinary English
//     word, and this corpus already contains the noun: "exploration, recall,
//     doc reading" (`dispatch-subagent/SKILL.md`). Reading form 3 without the
//     underscore requirement would accuse that sentence the moment arbitration
//     masked `recall`, and the only repair would be an exemption list. Such a
//     name is therefore read ONLY when qualified (form 1) or fully delimited
//     in backticks (form 2), where the author's intent to name the tool is
//     explicit. A masked one-word tool named in undelimited prose is the one
//     reference this scan does not see.
//   * Sidecar files under a skill directory (`evals/`, `references/`): only
//     `SKILL.md`, the body a client actually loads, is scanned.
//   * Multi-token backtick spans (`` `create_task assignedTo=eta` ``) are not
//     split; form 3 reaches the name inside them anyway, since it scans the
//     raw line.
//
// A name matched by several forms on one line is ONE hit (deduplicated per
// line), so the offender count is a count of places, not of patterns.
//
// Escape hatch: a skill may legitimately document a tool that is
// deliberately hidden. An inline marker on the SAME LINE as the reference —
// `<!-- tool-exposure-allow: <name> -->` — excuses that one occurrence. The
// marker names the excused tool explicitly so it can't accidentally shadow a
// different hidden name mentioned elsewhere on the same line.
const SKILL_QUALIFIED_REF_PATTERN = /mcp__vantage-peers__([a-z][a-z0-9_]*)/g;
const SKILL_BACKTICK_SPAN_PATTERN = /`([^`\n]+)`/g;
// At least one underscore — see "DELIBERATELY NOT READ" above.
const SKILL_SNAKE_TOKEN_PATTERN = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g;
const SKILL_ESCAPE_MARKER_PATTERN =
	/<!--\s*tool-exposure-allow:\s*([a-z][a-z0-9_]*)\s*-->/g;

type SkillHit = { file: string; line: number; tool: string; marked: boolean };

// Lists every `<skillDir>/SKILL.md` directly under `dir`. Throws (refuses)
// if `dir` itself cannot be read — a scan that cannot see the skills
// directory must fail loudly, never report "0 offenders" as if it looked.
function listSkillFiles(dir: string): string[] {
	const entries = readdirSync(dir, { withFileTypes: true }); // throws if unreadable
	const out: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const skillFile = join(dir, entry.name, "SKILL.md");
		if (existsSync(skillFile)) out.push(skillFile);
	}
	return out.sort();
}

// Every registered tool name referenced on ONE line, in any of the three read
// forms, deduplicated. Registered-set gated throughout: the set the server
// actually registers (core + masked) is what makes a token a tool reference,
// rather than the punctuation around it. Returned in first-seen order.
function extractToolRefsFromLine(
	lineText: string,
	registered: Set<string>,
): string[] {
	const found = new Set<string>();
	// Form 1 — fully qualified. Consumed first, then removed, so the prefix's
	// own underscores cannot be re-read as a bare snake_case token by form 3.
	for (const m of lineText.matchAll(SKILL_QUALIFIED_REF_PATTERN)) {
		if (registered.has(m[1])) found.add(m[1]);
	}
	const bare = lineText.replace(SKILL_QUALIFIED_REF_PATTERN, " ");
	// Form 2 — a backtick span whose ENTIRE content is a registered name. This
	// is the only form that can reach a one-word name (`recall`), because the
	// delimiter is what proves the author meant the tool and not the word.
	for (const m of bare.matchAll(SKILL_BACKTICK_SPAN_PATTERN)) {
		const inner = m[1].trim();
		if (registered.has(inner)) found.add(inner);
	}
	// Form 3 — a bare snake_case token, undelimited. The underscore is what
	// makes it unambiguous; see the header's "DELIBERATELY NOT READ".
	for (const m of bare.matchAll(SKILL_SNAKE_TOKEN_PATTERN)) {
		if (registered.has(m[0])) found.add(m[0]);
	}
	return [...found];
}

function scanSkillFile(
	path: string,
	rel: string,
	registered: Set<string>,
): SkillHit[] {
	const lines = readFileSync(path, "utf-8").split("\n");
	const hits: SkillHit[] = [];
	lines.forEach((lineText, idx) => {
		const markedNames = new Set<string>();
		for (const m of lineText.matchAll(SKILL_ESCAPE_MARKER_PATTERN)) {
			markedNames.add(m[1]);
		}
		for (const tool of extractToolRefsFromLine(lineText, registered)) {
			hits.push({
				file: rel,
				line: idx + 1,
				tool,
				marked: markedNames.has(tool),
			});
		}
	});
	return hits;
}

function scanSkillsDir(skillsDir: string, registered: Set<string>) {
	const files = listSkillFiles(skillsDir); // throws (refuses) if skillsDir is unreadable
	const hits: SkillHit[] = [];
	for (const file of files) {
		hits.push(...scanSkillFile(file, relative(skillsDir, file), registered));
	}
	const namesExtracted = new Set(hits.map((h) => h.tool));
	return { files, hits, namesExtracted };
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

	it("advertises every tool named in a skill body (.claude/skills/*/SKILL.md), so a skill never points a caller at a masked verb", () => {
		const all = runDumpToolNames({ VP_DUMP_ALL_REGISTERED: "1" });
		expect(all.status).toBe(0);
		const registered = new Set<string>(JSON.parse(all.stdout));

		const skillsDir = join(REPO_ROOT, ".claude", "skills");
		const { files, hits, namesExtracted } = scanSkillsDir(
			skillsDir,
			registered,
		);

		const core = new Set(CORE_NAMES);
		const nonCore = [...namesExtracted].filter((n) => !core.has(n));
		const offenders = hits
			.filter((h) => !core.has(h.tool) && !h.marked)
			.map((h) => `${h.file}:${h.line} -> ${h.tool}`);

		// Scope line — printed on every run, never silent.
		console.log(
			`skill-body scan: ${files.length} skill files read, ` +
				`${namesExtracted.size} distinct tool names extracted, ` +
				`${nonCore.length} non-core names found`,
		);

		// Positive control: the scan reaches the known defect site.
		expect(
			hits.some(
				(h) =>
					h.file === "fix-pattern-cycle/SKILL.md" &&
					h.tool === "create_fix_pattern",
			),
			"scan did not reach fix-pattern-cycle/SKILL.md's create_fix_pattern reference",
		).toBe(true);

		expect(offenders, "skill body names non-core (masked) tools").toEqual([]);
	}, 60_000);

	it("refuses (fails) rather than passing silently when the skills directory cannot be read", () => {
		const registered = new Set<string>(["whatever"]);
		expect(() =>
			scanSkillsDir(
				join(tmpdir(), "vp-tool-exposure-nonexistent-dir"),
				registered,
			),
		).toThrow();
	});

	it("escape hatch: a skill naming a hidden tool WITHOUT the marker fails the scan", () => {
		const all = runDumpToolNames({ VP_DUMP_ALL_REGISTERED: "1" });
		expect(all.status).toBe(0);
		const registered = new Set<string>(JSON.parse(all.stdout));
		const core = new Set(CORE_NAMES);
		const hiddenTool = [...registered].find((t) => !core.has(t));
		expect(
			hiddenTool,
			"no masked tool available to build the fixture",
		).toBeTruthy();

		const dir = mkdtempSync(join(tmpdir(), "vp-tool-exposure-skill-"));
		tempPaths.push(dir);
		const skillSubdir = join(dir, "fixture-skill");
		mkdirSync(skillSubdir, { recursive: true });
		writeFileSync(
			join(skillSubdir, "SKILL.md"),
			`Call \`mcp__vantage-peers__${hiddenTool}\` to do the thing.\n`,
		);

		const { hits } = scanSkillsDir(dir, registered);
		const offenders = hits.filter((h) => !core.has(h.tool) && !h.marked);
		expect(offenders.length).toBe(1);
		expect(offenders[0].tool).toBe(hiddenTool);
	});

	it("escape hatch: the SAME skill WITH the marker on the same line passes the scan", () => {
		const all = runDumpToolNames({ VP_DUMP_ALL_REGISTERED: "1" });
		expect(all.status).toBe(0);
		const registered = new Set<string>(JSON.parse(all.stdout));
		const core = new Set(CORE_NAMES);
		const hiddenTool = [...registered].find((t) => !core.has(t));
		expect(
			hiddenTool,
			"no masked tool available to build the fixture",
		).toBeTruthy();

		const dir = mkdtempSync(join(tmpdir(), "vp-tool-exposure-skill-"));
		tempPaths.push(dir);
		const skillSubdir = join(dir, "fixture-skill");
		mkdirSync(skillSubdir, { recursive: true });
		writeFileSync(
			join(skillSubdir, "SKILL.md"),
			`Call \`mcp__vantage-peers__${hiddenTool}\` to do the thing. <!-- tool-exposure-allow: ${hiddenTool} -->\n`,
		);

		const { hits, namesExtracted } = scanSkillsDir(dir, registered);
		const offenders = hits.filter((h) => !core.has(h.tool) && !h.marked);
		expect(offenders).toEqual([]);
		// The marker excuses the OFFENSE, not the SIGHTING — the name is still
		// extracted (visible for the scope line), just not an offender.
		expect(namesExtracted.has(hiddenTool as string)).toBe(true);
	});

	// ─── Poles for the two forms beyond the fully-qualified one ───────────────
	// Each builds its fixture from the LIVE masked set, so none of them can
	// pass by naming a tool that stopped being masked.
	function maskedWithUnderscore(registered: Set<string>, core: Set<string>) {
		return [...registered].find((t) => !core.has(t) && t.includes("_"));
	}

	it("reads the BARE-BACKTICK form: a skill naming a masked tool in backticks alone, with no mcp__vantage-peers__ prefix, is an offender", () => {
		const all = runDumpToolNames({ VP_DUMP_ALL_REGISTERED: "1" });
		expect(all.status).toBe(0);
		const registered = new Set<string>(JSON.parse(all.stdout));
		const core = new Set(CORE_NAMES);
		const hidden = maskedWithUnderscore(registered, core);
		expect(
			hidden,
			"no masked underscored tool to build the fixture",
		).toBeTruthy();

		const dir = mkdtempSync(join(tmpdir(), "vp-tool-exposure-skill-"));
		tempPaths.push(dir);
		mkdirSync(join(dir, "fixture-skill"), { recursive: true });
		writeFileSync(
			join(dir, "fixture-skill", "SKILL.md"),
			`Derive it from \`${hidden}\` for \`repo\`; never type it.\n`,
		);

		const { hits } = scanSkillsDir(dir, registered);
		const offenders = hits.filter((h) => !core.has(h.tool) && !h.marked);
		expect(offenders.length, "bare-backtick form not read").toBe(1);
		expect(offenders[0].tool).toBe(hidden);
	}, 60_000);

	it("reads the UNDELIMITED snake_case form: a masked tool named in a bare command-line comment is an offender", () => {
		const all = runDumpToolNames({ VP_DUMP_ALL_REGISTERED: "1" });
		expect(all.status).toBe(0);
		const registered = new Set<string>(JSON.parse(all.stdout));
		const core = new Set(CORE_NAMES);
		const hidden = maskedWithUnderscore(registered, core);
		expect(
			hidden,
			"no masked underscored tool to build the fixture",
		).toBeTruthy();

		const dir = mkdtempSync(join(tmpdir(), "vp-tool-exposure-skill-"));
		tempPaths.push(dir);
		mkdirSync(join(dir, "fixture-skill"), { recursive: true });
		writeFileSync(
			join(dir, "fixture-skill", "SKILL.md"),
			`  project="<project>"   # derived from ${hidden}, never typed\n`,
		);

		const { hits } = scanSkillsDir(dir, registered);
		const offenders = hits.filter((h) => !core.has(h.tool) && !h.marked);
		expect(offenders.length, "undelimited snake_case form not read").toBe(1);
		expect(offenders[0].tool).toBe(hidden);
	}, 60_000);

	it("does NOT accuse a snake_case name the server never registers (a parameter or a status value), because the registered set is the discriminator", () => {
		const all = runDumpToolNames({ VP_DUMP_ALL_REGISTERED: "1" });
		expect(all.status).toBe(0);
		const registered = new Set<string>(JSON.parse(all.stdout));

		// The exact names measured in the real corpus as bare snake_case
		// non-tools. None is registered, so none may be extracted at all.
		const nonTools = [
			"in_progress",
			"base_branch",
			"head_branch",
			"default_limit",
			"default_namespace",
			"run_in_background",
			"subagent_type",
			"eta_approved_evidence",
			"owner_orchestrator",
			"scope_description",
			"fix_path",
		];
		for (const name of nonTools) {
			expect(
				registered.has(name),
				`${name} is registered — fixture stale`,
			).toBe(false);
		}

		const dir = mkdtempSync(join(tmpdir(), "vp-tool-exposure-skill-"));
		tempPaths.push(dir);
		mkdirSync(join(dir, "fixture-skill"), { recursive: true });
		writeFileSync(
			join(dir, "fixture-skill", "SKILL.md"),
			`${nonTools.map((n) => `- \`${n}\`: set status ${n} inline.`).join("\n")}\n`,
		);

		const { hits } = scanSkillsDir(dir, registered);
		expect(
			hits.map((h) => h.tool),
			"a non-registered snake_case name was read as a tool reference",
		).toEqual([]);
	}, 60_000);

	it("names its limit: an UNDELIMITED one-word tool name is deliberately NOT read (it is indistinguishable from the English word), while the SAME name in backticks IS", () => {
		const all = runDumpToolNames({ VP_DUMP_ALL_REGISTERED: "1" });
		expect(all.status).toBe(0);
		const registered = new Set<string>(JSON.parse(all.stdout));
		const oneWord = [...registered].find((t) => !t.includes("_"));
		expect(
			oneWord,
			"no one-word registered tool to build the fixture",
		).toBeTruthy();

		const dir = mkdtempSync(join(tmpdir(), "vp-tool-exposure-skill-"));
		tempPaths.push(dir);
		mkdirSync(join(dir, "fixture-skill"), { recursive: true });
		// Same name twice: once as bare prose (NOT read), once in backticks (read).
		writeFileSync(
			join(dir, "fixture-skill", "SKILL.md"),
			`exploration, ${oneWord}, doc reading\nthen call \`${oneWord}\`\n`,
		);

		const { hits } = scanSkillsDir(dir, registered);
		expect(
			hits.map((h) => h.line),
			"undelimited one-word name was read, or the backticked one was not",
		).toEqual([2]);
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
