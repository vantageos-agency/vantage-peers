#!/usr/bin/env node
/**
 * check-convex-node-builtins.mjs — no Convex entry point imports a Node builtin
 * without a top-level "use node" directive.
 *
 * Class of bug it prevents: the Convex CLI bundler treats files under convex/
 * as function entry points and refuses the whole deploy, before anything is
 * pushed, when one of them imports a Node API from a file without the
 * "use node" directive. A test-only helper (an AST scanner importing node:fs
 * and node:path) sat under convex/__tests__/lib/ with a single-dot name, was
 * bundled as an entry point, and refused a prod deploy. Unit tests never see
 * this: vitest runs every file under Node, so the defect only surfaces at
 * deploy time. This guard moves the refusal to CI.
 *
 * WHY the entry-point rule below mirrors the bundler: whether a file is an
 * entry point is decided by `entryPoints()` in
 * node_modules/convex/dist/cjs/bundler/index.js, not by anything in this repo.
 * A guard with its own idea of "entry point" would either flag files the
 * bundler never loads (noise that gets ignored) or, worse, skip files the
 * bundler does load (a green check on a tree that cannot deploy). So the rule
 * is copied from `entryPoints()` as it stands:
 *   - extension in ENTRY_POINT_EXTENSIONS (.js .mjs .cjs .ts .tsx .mts .cts .jsx)
 *   - not under the top-level `_generated/` directory
 *   - basename not a dotfile, not starting with `#` (editor tempfile)
 *   - basename not `schema.ts` / `schema.js`
 *   - basename containing at most one dot (this is why `*.test.ts` is skipped)
 *   - relative path containing no space
 *   - directories holding a `convex.config.ts` (nested components) are not
 *     descended into (`walkDir` with `looksLikeNestedComponent`)
 * Two deliberate differences, both toward flagging MORE, never less:
 *   - `entryPoints()` later drops .ts/.tsx files with no line-leading
 *     import/export. This guard does not: a file whose only builtin use is a
 *     `require(...)` is still flagged.
 *   - `node_modules/` under convex/ is skipped, since it holds dependencies,
 *     not user modules.
 * The "use node" test mirrors `hasUseNodeDirective()` in the same file: the
 * string must be a directive in the program prologue, not merely present.
 *
 * NAMED GAP: a non-entry file (e.g. a `*.helper.ts`) that imports a builtin
 * and is itself imported by an entry point also breaks the bundle; this guard
 * checks entry points only and does not follow imports.
 *
 * Exit codes — THREE outcomes, not two (same contract as check-tool-counts.mjs):
 *   0  PASS: at least one entry point scanned, no violation
 *   1  VIOLATION: each offending file:line and imported module is named
 *   2  REFUSAL TO JUDGE: convex/ missing or unreadable, a file unreadable, or
 *      zero entry points scanned (an empty scan never passes)
 *
 * Usage:
 *   node scripts/check-convex-node-builtins.mjs                     # scans <repo>/convex
 *   node scripts/check-convex-node-builtins.mjs --convex-dir=<dir>  # scans another tree
 *
 * Stdlib only (Node >= 20). Read-only.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

// ─── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const convexDirArg =
	(args.find((a) => a.startsWith("--convex-dir=")) || "").slice(13) || null;
const CONVEX_DIR = convexDirArg
	? resolve(convexDirArg)
	: join(REPO_ROOT, "convex");

// ─── Bundler mirror (see header) ─────────────────────────────────────────────
const ENTRY_POINT_EXTENSIONS = [
	".js",
	".mjs",
	".cjs",
	".ts",
	".tsx",
	".mts",
	".cts",
	".jsx",
];
const BUILTINS = new Set(builtinModules);

const VIOLATIONS = [];
const REFUSALS = [];

function info(msg) {
	process.stdout.write(`${msg}\n`);
}

function isEntryPoint(relPath, base) {
	if (!ENTRY_POINT_EXTENSIONS.some((ext) => relPath.endsWith(ext)))
		return false;
	if (relPath.startsWith(`_generated${sep}`)) return false;
	if (base.startsWith(".")) return false;
	if (base.startsWith("#")) return false;
	if (base === "schema.ts" || base === "schema.js") return false;
	if ((base.match(/\./g) || []).length > 1) return false;
	if (relPath.includes(" ")) return false;
	return true;
}

function walk(dir, out) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		refuse(`cannot read directory ${dir}: ${err.message}`);
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") continue;
			let isComponent = false;
			try {
				statSync(join(full, "convex.config.ts"));
				isComponent = true;
			} catch {
				isComponent = false;
			}
			if (isComponent) continue;
			walk(full, out);
		} else if (entry.isFile()) {
			out.push(full);
		}
	}
}

function refuse(msg) {
	REFUSALS.push(msg);
}

// ─── Source analysis ─────────────────────────────────────────────────────────
/**
 * Replace comments with spaces (newlines kept, so offsets and line numbers are
 * preserved). String and template literal contents are left intact so module
 * specifiers survive; a comment marker inside a string is not treated as one.
 */
function blankComments(src) {
	const out = src.split("");
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const n = src[i + 1];
		if (c === "/" && n === "/") {
			while (i < src.length && src[i] !== "\n") out[i++] = " ";
		} else if (c === "/" && n === "*") {
			out[i++] = " ";
			out[i++] = " ";
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
				if (src[i] !== "\n") out[i] = " ";
				i++;
			}
			if (i < src.length) {
				out[i++] = " ";
				out[i++] = " ";
			}
		} else if (c === '"' || c === "'" || c === "`") {
			i++;
			while (i < src.length && src[i] !== c) {
				if (src[i] === "\\") i++;
				i++;
			}
			i++;
		} else {
			i++;
		}
	}
	return out.join("");
}

/** True when "use node" is a directive in the program prologue. */
function hasUseNodeDirective(code) {
	let rest = code.replace(/^#![^\n]*/, "");
	const directive = /^\s*(["'])([^"'\n]*)\1\s*;?/;
	for (;;) {
		const m = rest.match(directive);
		if (!m) return false;
		if (m[2] === "use node") return true;
		rest = rest.slice(m[0].length);
	}
}

function isBuiltin(specifier) {
	if (specifier.startsWith("node:")) return true;
	return BUILTINS.has(specifier) || BUILTINS.has(specifier.split("/")[0]);
}

const IMPORT_PATTERNS = [
	// import x from "m" / import { a, b } from "m" (type-only imports are erased)
	/\bimport\s+(?!type\b)[\w$*{},\s]*?\bfrom\s*(["'])([^"'\n]+)\1/g,
	// import "m"
	/\bimport\s*(["'])([^"'\n]+)\1/g,
	// export * from "m" / export { a } from "m" (type-only re-exports are erased)
	/\bexport\s+(?!type\b)(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(["'])([^"'\n]+)\1/g,
	// require("m")
	/\brequire\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g,
	// import("m")
	/\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g,
];

function builtinImports(code) {
	const found = new Map();
	for (const pattern of IMPORT_PATTERNS) {
		pattern.lastIndex = 0;
		for (const m of code.matchAll(pattern)) {
			const specifier = m[2];
			if (!isBuiltin(specifier)) continue;
			const offset = m.index + m[0].lastIndexOf(specifier);
			const line = code.slice(0, offset).split("\n").length;
			found.set(`${line}:${specifier}`, { line, specifier });
		}
	}
	return [...found.values()].sort((a, b) => a.line - b.line);
}

// ─── Main ────────────────────────────────────────────────────────────────────
function main() {
	let dirStat;
	try {
		dirStat = statSync(CONVEX_DIR);
	} catch (err) {
		refuse(`convex directory not readable at ${CONVEX_DIR}: ${err.message}`);
	}
	if (dirStat && !dirStat.isDirectory()) {
		refuse(`convex path ${CONVEX_DIR} is not a directory`);
	}

	let scanned = 0;
	if (REFUSALS.length === 0) {
		const files = [];
		walk(CONVEX_DIR, files);
		for (const file of files) {
			const relPath = relative(CONVEX_DIR, file);
			const base = relPath.split(sep).pop();
			if (!isEntryPoint(relPath, base)) continue;
			let source;
			try {
				source = readFileSync(file, "utf8");
			} catch (err) {
				refuse(`cannot read entry point ${file}: ${err.message}`);
				continue;
			}
			scanned++;
			const code = blankComments(source);
			const imports = builtinImports(code);
			if (imports.length === 0 || hasUseNodeDirective(code)) continue;
			for (const { line, specifier } of imports) {
				VIOLATIONS.push(
					`${relative(REPO_ROOT, file)}:${line} imports Node builtin "${specifier}" without a top-level "use node" directive`,
				);
			}
		}
		if (REFUSALS.length === 0 && scanned === 0) {
			refuse(
				`zero Convex entry points found under ${CONVEX_DIR} — an empty scan cannot pass`,
			);
		}
	}

	info(`Scanned ${scanned} Convex entry-point file(s) under ${CONVEX_DIR}`);

	if (REFUSALS.length > 0) {
		process.stderr.write(
			`\nREFUSING TO JUDGE — ${REFUSALS.length} input(s) could not be read or established:\n`,
		);
		for (const r of REFUSALS) process.stderr.write(`  ${r}\n`);
		process.exit(2);
	}
	if (VIOLATIONS.length > 0) {
		info(
			`\nFAIL — ${VIOLATIONS.length} Node builtin import(s) in Convex entry points:`,
		);
		for (const v of VIOLATIONS) info(`  ${v}`);
		info(
			`\nThe Convex CLI bundles every such file and refuses the deploy. Either add "use node" as the first statement (the file then runs in the Node runtime), or move the file out of convex/ if it is not a Convex module.`,
		);
		process.exit(1);
	}
	info(
		`\nOK — no Node builtin import without "use node" in any Convex entry point.`,
	);
}

main();
