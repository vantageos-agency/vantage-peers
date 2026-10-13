/**
 * convex-public-functions.mjs -- the PUBLIC function surface of convex/, read
 * from source. One definition, shared by the manifest generator
 * (scripts/gen-backend-manifest.mjs) and the tests that pin the manifest.
 *
 * Population (same definition as scripts/check-public-registrations-resolve-
 * caller.py): every module named by `import type * as X from "../<mod>.js"` in
 * convex/_generated/api.d.ts, and in it every top-level
 * `export const X = query|mutation|action(`. `internalQuery` /
 * `internalMutation` / `internalAction` are NOT public: a ConvexHttpClient
 * cannot call them, so the MCP can neither depend on them nor be broken by
 * their absence.
 *
 * It reads source, not the runtime registrations, on purpose: "use node"
 * modules (convex/search.ts, okfBundleNode.ts, ...) cannot be imported under
 * the test runtime, and the MCP calls several of them.
 *
 * Identifier form: `<module path>:<export name>`, nested modules `a/b:fn` --
 * exactly the string a ConvexHttpClient is given.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const PUBLIC_BUILDERS = new Set(["query", "mutation", "action"]);

/** Module names published by convex/_generated/api.d.ts. */
export function apiModuleNames(convexDir) {
	const text = readFileSync(join(convexDir, "_generated", "api.d.ts"), "utf8");
	const names = [];
	const re = /^import type \* as [\w$]+ from "\.\.\/([^"]+)\.js";/gm;
	for (let m = re.exec(text); m !== null; m = re.exec(text)) names.push(m[1]);
	return names;
}

/** Sorted `module:export` of every public registration under `convexDir`. */
export function listPublicConvexFunctions(convexDir) {
	const ids = new Set();
	for (const mod of apiModuleNames(convexDir)) {
		const file = join(convexDir, `${mod}.ts`);
		const sf = ts.createSourceFile(
			file,
			readFileSync(file, "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		for (const st of sf.statements) {
			if (!ts.isVariableStatement(st)) continue;
			if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
				continue;
			for (const d of st.declarationList.declarations) {
				let init = d.initializer;
				while (
					init &&
					(ts.isAsExpression(init) || ts.isParenthesizedExpression(init))
				)
					init = init.expression;
				if (
					init &&
					ts.isCallExpression(init) &&
					ts.isIdentifier(init.expression) &&
					PUBLIC_BUILDERS.has(init.expression.text) &&
					ts.isIdentifier(d.name)
				) {
					ids.add(`${mod}:${d.name.text}`);
				}
			}
		}
	}
	return [...ids].sort();
}
