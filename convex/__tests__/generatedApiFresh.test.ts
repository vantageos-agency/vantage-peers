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

// Every non-test, non-declaration .ts source under convex/ that Convex would
// register as a module.
function modulesOnDisk(dir: string, prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "_generated" || entry.name === "node_modules") continue;
		if (entry.name === "__tests__") continue;
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
});
