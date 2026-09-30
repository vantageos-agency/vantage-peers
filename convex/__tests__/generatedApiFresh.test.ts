/// <reference types="vite/client" />
/**
 * The committed `convex/_generated/api.d.ts` must describe the modules that
 * exist on disk.
 *
 * WHY THIS IS A TEST AND NOT LEFT TO `tsc`. `convex/tsconfig.json` sets
 * `skipLibCheck: true`, and `api.d.ts` is a declaration file, so a dangling
 * `import type ... from "../migrations/<deleted>.js"` inside it is SKIPPED: the
 * symbol degrades to `any`, `api` turns permissive, and the repository's own
 * `tsc` returns 0 lines while `convex deploy` — which regenerates the file
 * before it typechecks — sees hundreds of errors. PR #1354 deleted
 * `migrations/populateOrgIds.ts` and left it imported here; production could
 * not be deployed. `tsc` cannot see this class, so this test does.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONVEX_DIR = path.join(__dirname, "..");
const API_DTS = path.join(CONVEX_DIR, "_generated", "api.d.ts");

// Convex config/schema files are not function modules; codegen never lists them.
const NOT_FUNCTION_MODULES = new Set(["auth.config", "convex.config", "schema"]);

const IMPORT_RE = /^import type \* as \S+ from "\.\.\/(.+)\.js";$/gm;

function importedModules(source: string): string[] {
	return [...source.matchAll(IMPORT_RE)].map((m) => m[1] as string);
}

// `api.d.ts` lists every module a SECOND time, as a key inside
// `declare const fullApi: ApiFromModules<{ ... }>`. That block is what `api`
// is actually built from; the import block only brings the symbols into scope.
const FULL_API_OPEN = "declare const fullApi: ApiFromModules<{";
const FULL_API_KEY_RE = /^\s+"?([^":\s]+)"?:\s*typeof \S+;$/gm;

function fullApiKeys(source: string): string[] {
	const start = source.indexOf(FULL_API_OPEN);
	if (start === -1) return [];
	const body = source.slice(start + FULL_API_OPEN.length);
	const end = body.indexOf("\n}>;");
	if (end === -1) return [];
	return [...body.slice(0, end).matchAll(FULL_API_KEY_RE)].map((m) => m[1] as string);
}

// Every non-test, non-declaration .ts source under convex/ that Convex would
// register as a module.
function modulesOnDisk(dir: string, prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "_generated" || entry.name === "node_modules") continue;
		// `__tests__` is walked like any other directory. It used to be skipped,
		// which made this guard blind to it by construction. It is safe to walk
		// because the pole "convex/__tests__ holds only *.test.ts files" below
		// makes a non-test file there impossible, and every `*.test.ts` is dropped
		// by the suffix filter further down. So the walk reports nothing from
		// there today, and reports a stray file by name if the pole were ever
		// bypassed: the skip was a hole, not a harmless exclusion, because it
		// hid the one directory where a test helper is tempting to park.
		if (entry.isDirectory()) {
			out.push(...modulesOnDisk(path.join(dir, entry.name), `${prefix}${entry.name}/`));
			continue;
		}
		if (!entry.name.endsWith(".ts")) continue;
		if (entry.name.endsWith(".d.ts") || entry.name.endsWith(".test.ts")) continue;
		out.push(`${prefix}${entry.name.slice(0, -".ts".length)}`);
	}
	return out;
}

// Convex treats every file under convex/ whose basename has a single dot as a
// deployable module, `__tests__/` included. A test helper parked there is
// bundled and pushed with the deployment (and, if it imports `typescript` or a
// Node builtin, breaks or bloats it). Test helpers live in `tests/lib/`, outside
// convex/. The population is found by walking the directory, never named.
const CODE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const TEST_FILE_RE = /\.test\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

function nonTestSourcesUnder(dir: string, prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		if (entry.isDirectory()) {
			out.push(...nonTestSourcesUnder(path.join(dir, entry.name), `${prefix}${entry.name}/`));
			continue;
		}
		if (CODE_EXT_RE.test(entry.name) && !TEST_FILE_RE.test(entry.name)) {
			out.push(`${prefix}${entry.name}`);
		}
	}
	return out;
}

describe("convex/__tests__ holds only *.test.ts files", () => {
	const testsDir = path.join(CONVEX_DIR, "__tests__");

	test("the walk sees the test files (a vacuous pass would prove nothing)", () => {
		const all: string[] = [];
		const count = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.isDirectory()) count(path.join(dir, entry.name));
				else if (TEST_FILE_RE.test(entry.name)) all.push(entry.name);
			}
		};
		count(testsDir);
		expect(all.length).toBeGreaterThan(20);
	});

	test("no non-test source file sits under convex/__tests__", () => {
		expect(
			nonTestSourcesUnder(testsDir),
			"these files would be deployed as Convex modules; move them to tests/lib/",
		).toEqual([]);
	});
});

describe("convex/_generated/api.d.ts is not stale", () => {
	const source = readFileSync(API_DTS, "utf-8");
	const imported = importedModules(source);

	test("the parser found the imports (a vacuous pass would prove nothing)", () => {
		expect(imported.length).toBeGreaterThan(20);
	});

	test("every module api.d.ts imports exists on disk", () => {
		const dangling = imported.filter(
			(mod) => !existsSync(path.join(CONVEX_DIR, `${mod}.ts`)),
		);
		expect(dangling).toEqual([]);
	});

	test("every module on disk is imported by api.d.ts", () => {
		const importedSet = new Set(imported);
		const missing = modulesOnDisk(CONVEX_DIR).filter(
			(mod) => !NOT_FUNCTION_MODULES.has(mod) && !importedSet.has(mod),
		);
		expect(missing).toEqual([]);
	});

	// The import block and the `fullApi` key block must name the same modules.
	//
	// WHAT THIS CATCHES: a module imported but absent from `fullApi` (the symbol
	// is in scope, `api` silently loses the module and every call into it
	// degrades), and a `fullApi` key with no matching import (a dangling
	// `typeof` that `skipLibCheck` hides). Neither block is read by the poles
	// above, which parse the import lines only, so a hand edit that updated one
	// block and not the other passed all of them.
	//
	// WHAT THIS DOES NOT CATCH: a type collapse INSIDE a correctly-listed
	// module (a function whose own signature resolves to `any`), or a module
	// listed in both blocks whose file is broken. That class is caught only by
	// the deploy-time typecheck, which regenerates the bindings first.
	describe("the import block and the fullApi block list the same modules", () => {
		const keys = fullApiKeys(source);

		test("the fullApi parser found keys (a vacuous pass would prove nothing)", () => {
			// The bound is the file itself: the import block lists N modules, and
			// fullApi must list the same N. Comparing two empty sets would pass
			// while proving nothing, so a parser that matches zero keys is a failure
			// of the detector, not a clean result.
			expect(
				keys.length,
				`fullApiKeys() matched 0 keys against ${imported.length} imports: ` +
					"the detector no longer reads api.d.ts and proves nothing",
			).toBeGreaterThan(0);
		});

		test("no module is in one block and missing from the other", () => {
			expect(keys.length, "detector reads nothing; proves nothing").toBeGreaterThan(0);
			const importSet = new Set(imported);
			const keySet = new Set(keys);
			const inImportsNotFullApi = [...importSet].filter((m) => !keySet.has(m)).sort();
			const inFullApiNotImports = [...keySet].filter((m) => !importSet.has(m)).sort();
			expect(
				{ inImportsNotFullApi, inFullApiNotImports },
				"in block 1 (imports) but not block 2 (fullApi), and the reverse",
			).toEqual({ inImportsNotFullApi: [], inFullApiNotImports: [] });
		});
	});
});
