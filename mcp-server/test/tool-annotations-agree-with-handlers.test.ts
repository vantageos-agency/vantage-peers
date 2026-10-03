/**
 * TOOL_ANNOTATIONS_AGREE_WITH_HANDLERS — a tool declared `readOnlyHint: true`
 * must have a handler that reaches no write.
 *
 * Why: the person-token writer-role gate (src/registerTool.ts) lets a viewer
 * call every tool declared read-only. That gate is only as honest as the hint,
 * and a hint is typed by hand: annotating `update_mission` as read-only used to
 * leave the whole suite green and hand a viewer a write.
 *
 * Derivation (ported in approach from vantageos-crm #248,
 * mcp-server/tests/registry.test.ts `derivedFacts`: per-file function map +
 * fixed-point closure over same-file calls; here on the TypeScript AST instead
 * of regexes, because VP handlers are inline arrow functions passed to
 * `defineTool(...)`):
 *
 *   - the TOOL LIST comes from the registration itself: `registerTools()` is run
 *     against a recording server, so a tool added tomorrow is covered without
 *     anyone touching a list here;
 *   - each registered name is matched to its `defineTool(..., "<name>", ...)`
 *     call in src/tools.ts and src/tools/*.ts; a registered tool whose handler
 *     cannot be found fails loudly (never a silent pass);
 *   - a handler REACHES A WRITE when its body, or the body of a same-file helper
 *     it calls (transitively), mentions `.mutation` / `.action` / `runMutation` /
 *     `runAction`;
 *   - a call to a function imported from another file that is handed the
 *     `convex` client is UNRESOLVED: it counts as a possible write, so a
 *     read-only tool may not hide a write behind an import.
 *
 * DECLARED LIMITS: textual by name (a same-file helper shadowed by a local of
 * the same name is over-approximated, never under-approximated); a write
 * reached only through an imported helper that is not handed `convex` is not
 * seen. The converse is allowed: a tool that only reads may declare
 * `readOnlyHint: false`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { registerTools } from "../src/tools.js";

const SRC = join(__dirname, "..", "src");

type Registered = { name: string; readOnly: boolean | undefined };

function registeredTools(): Registered[] {
	const out: Registered[] = [];
	const server = {
		tool() {},
		registerTool: (
			name: string,
			config: { annotations?: { readOnlyHint?: boolean } },
		) => {
			out.push({ name, readOnly: config.annotations?.readOnlyHint });
		},
	} as never;
	const convex = {
		query: async () => null,
		mutation: async () => null,
		action: async () => null,
	} as never;
	registerTools(server, convex, undefined);
	return out;
}

const WRITE_PROPS = new Set(["mutation", "action", "runMutation", "runAction"]);

type FnNode = ts.FunctionLikeDeclaration;

function sourceFiles(): string[] {
	return [
		join(SRC, "tools.ts"),
		...readdirSync(join(SRC, "tools"))
			.filter((f) => f.endsWith(".ts"))
			.map((f) => join(SRC, "tools", f)),
	];
}

function parse(file: string): ts.SourceFile {
	return ts.createSourceFile(
		file,
		readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
}

/** Every named function of the file: declarations and `const x = () => ...`. */
/** Module-level `const NAME = "literal"` (tool names are often held in a const). */
function stringConsts(sf: ts.SourceFile): Map<string, string> {
	const out = new Map<string, string>();
	for (const st of sf.statements) {
		if (!ts.isVariableStatement(st)) continue;
		for (const d of st.declarationList.declarations) {
			if (
				ts.isIdentifier(d.name) &&
				d.initializer &&
				ts.isStringLiteralLike(d.initializer)
			) {
				out.set(d.name.text, d.initializer.text);
			}
		}
	}
	return out;
}

function functionMap(sf: ts.SourceFile): Map<string, FnNode> {
	const fns = new Map<string, FnNode>();
	const visit = (n: ts.Node) => {
		if (ts.isFunctionDeclaration(n) && n.name) fns.set(n.name.text, n);
		if (
			ts.isVariableDeclaration(n) &&
			ts.isIdentifier(n.name) &&
			n.initializer &&
			(ts.isArrowFunction(n.initializer) ||
				ts.isFunctionExpression(n.initializer))
		) {
			fns.set(n.name.text, n.initializer);
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return fns;
}

/** Names of functions imported into the file (their bodies are not visible here). */
function importedNames(sf: ts.SourceFile): Set<string> {
	const names = new Set<string>();
	for (const st of sf.statements) {
		if (
			ts.isImportDeclaration(st) &&
			st.importClause?.namedBindings &&
			ts.isNamedImports(st.importClause.namedBindings)
		) {
			for (const el of st.importClause.namedBindings.elements) {
				names.add(el.name.text);
			}
		}
	}
	return names;
}

type Reach = { writes: boolean; why: string[] };

const CONVEX = join(__dirname, "..", "..", "convex");

/** `"mod:fn" as unknown as X` -> "mod:fn". */
function literalOf(n: ts.Node | undefined): string | null {
	let cur = n;
	while (cur && (ts.isAsExpression(cur) || ts.isParenthesizedExpression(cur))) {
		cur = cur.expression;
	}
	return cur && ts.isStringLiteralLike(cur) ? cur.text : null;
}

/**
 * Does the Convex function `mod:fn` write? A mutation always does. An action is
 * a write only when it reaches `ctx.runMutation`, or `ctx.runAction` of a
 * function that does (a search action that only embeds and queries is a read).
 * Anything that cannot be resolved counts as a write.
 */
function convexFnWrites(ref: string, seen = new Set<string>()): string | null {
	if (seen.has(ref)) return null;
	seen.add(ref);
	const [mod, fn] = ref.split(":");
	let sf: ts.SourceFile;
	try {
		sf = parse(join(CONVEX, `${mod}.ts`));
	} catch {
		return `${ref} unresolved (no convex/${mod}.ts)`;
	}
	let def: ts.CallExpression | null = null;
	for (const st of sf.statements) {
		if (!ts.isVariableStatement(st)) continue;
		for (const d of st.declarationList.declarations) {
			if (
				ts.isIdentifier(d.name) &&
				d.name.text === fn &&
				d.initializer &&
				ts.isCallExpression(d.initializer)
			) {
				def = d.initializer;
			}
		}
	}
	if (!def) return `${ref} unresolved (no export ${fn})`;
	const kind = ts.isIdentifier(def.expression) ? def.expression.text : "";
	if (kind === "mutation" || kind === "internalMutation") {
		return `${ref} is a mutation`;
	}
	if (kind !== "action" && kind !== "internalAction") {
		return kind === "query" || kind === "internalQuery"
			? null
			: `${ref} unresolved (${kind})`;
	}
	const fns = functionMap(sf);
	const found: string[] = [];
	const walk = (n: ts.Node, visited: Set<string>) => {
		if (ts.isCallExpression(n)) {
			const callee = ts.isPropertyAccessExpression(n.expression)
				? n.expression.name.text
				: ts.isIdentifier(n.expression)
					? n.expression.text
					: "";
			if (callee === "runMutation") found.push(`${ref} reaches runMutation`);
			if (callee === "runAction") {
				const chain: string[] = [];
				let e: ts.Node | undefined = n.arguments[0];
				while (e && ts.isPropertyAccessExpression(e)) {
					chain.unshift(e.name.text);
					e = e.expression;
				}
				if (chain.length === 2) {
					const inner = convexFnWrites(chain.join(":"), seen);
					if (inner) found.push(inner);
				} else found.push(`${ref} runAction target unresolved`);
			}
			if (ts.isIdentifier(n.expression)) {
				const target = fns.get(n.expression.text);
				if (target && !visited.has(n.expression.text)) {
					visited.add(n.expression.text);
					walk(target, visited);
				}
			}
		}
		ts.forEachChild(n, (c) => walk(c, visited));
	};
	walk(def, new Set());
	return found.length ? found.join("; ") : null;
}

function reachOf(
	node: ts.Node,
	fns: Map<string, FnNode>,
	imported: Set<string>,
	seen = new Set<string>(),
): Reach {
	const why: string[] = [];
	const visit = (n: ts.Node) => {
		if (ts.isPropertyAccessExpression(n) && WRITE_PROPS.has(n.name.text)) {
			const call = ts.isCallExpression(n.parent) ? n.parent : null;
			if (n.name.text === "action" && call) {
				// A Convex action is a write only if the action itself writes.
				const ref = literalOf(call.arguments[0]);
				const w = ref
					? convexFnWrites(ref)
					: "action target is not a string literal";
				if (w) why.push(`.action -> ${w}`);
			} else {
				why.push(`.${n.name.text}`);
			}
		}
		if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
			const callee = n.expression.text;
			if (WRITE_PROPS.has(callee)) why.push(callee);
			const target = fns.get(callee);
			if (target && !seen.has(callee)) {
				seen.add(callee);
				const inner = reachOf(target, fns, imported, seen);
				if (inner.writes) why.push(`${callee}() -> ${inner.why.join(", ")}`);
			} else if (
				!target &&
				imported.has(callee) &&
				n.arguments.some((a) => ts.isIdentifier(a) && a.text === "convex")
			) {
				why.push(`${callee}(convex) imported, unresolved`);
			}
		}
		ts.forEachChild(n, visit);
	};
	visit(node);
	return { writes: why.length > 0, why };
}

type Declared = {
	file: string;
	handler: ts.Node;
	fns: Map<string, FnNode>;
	imported: Set<string>;
	readOnly: boolean | undefined;
	ownStateOnly: boolean;
};

/** Every `defineTool(server, ctx, scope, "<name>", desc, schema, [annotations,] handler)`. */
function declaredTools(): Map<string, Declared> {
	const found = new Map<string, Declared>();
	for (const file of sourceFiles()) {
		const sf = parse(file);
		const fns = functionMap(sf);
		const imported = importedNames(sf);
		const consts = stringConsts(sf);
		const visit = (n: ts.Node) => {
			if (
				ts.isCallExpression(n) &&
				ts.isIdentifier(n.expression) &&
				n.expression.text === "defineTool" &&
				n.arguments.length >= 7
			) {
				const nameArg = n.arguments[3];
				const toolName = ts.isStringLiteralLike(nameArg)
					? nameArg.text
					: ts.isIdentifier(nameArg)
						? consts.get(nameArg.text)
						: undefined;
				if (toolName !== undefined) {
					const rest = n.arguments.slice(6);
					const handler = rest[rest.length - 1];
					let readOnly: boolean | undefined;
					let ownStateOnly = false;
					if (rest.length === 2 && ts.isObjectLiteralExpression(rest[0])) {
						for (const p of rest[0].properties) {
							if (
								ts.isPropertyAssignment(p) &&
								ts.isIdentifier(p.name) &&
								p.name.text === "readOnlyHint"
							) {
								readOnly = p.initializer.kind === ts.SyntaxKind.TrueKeyword;
							}
							if (
								ts.isPropertyAssignment(p) &&
								ts.isIdentifier(p.name) &&
								p.name.text === "ownStateOnly"
							) {
								ownStateOnly = p.initializer.kind === ts.SyntaxKind.TrueKeyword;
							}
						}
					}
					found.set(toolName, {
						file,
						handler,
						fns,
						imported,
						readOnly,
						ownStateOnly,
					});
				}
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	return found;
}

describe("a read-only hint is checked against what the handler reaches", () => {
	const registered = registeredTools();
	const declared = declaredTools();

	it("the tool list comes from the registration and is not degenerate", () => {
		expect(registered.length).toBeGreaterThan(100);
		expect(
			registered.filter((t) => t.readOnly === true).length,
		).toBeGreaterThan(20);
		expect(
			registered.filter((t) => t.readOnly === false).length,
		).toBeGreaterThan(20);
	});

	it("every registered tool is matched to its handler source (no silent pass)", () => {
		const missing = registered
			.map((t) => t.name)
			.filter((n) => !declared.has(n));
		expect(
			missing,
			"registered tools with no defineTool handler found",
		).toEqual([]);
	});

	it("the source's readOnlyHint literal equals the registered one", () => {
		const drift = registered
			.filter((t) => declared.has(t.name))
			.filter(
				(t) =>
					(declared.get(t.name)?.readOnly ?? false) !== (t.readOnly ?? false),
			)
			.map((t) => t.name);
		expect(drift).toEqual([]);
	});

	it("the derivation sees real writes: a known writer reaches one", () => {
		const d = declared.get("update_mission");
		expect(d).toBeDefined();
		const r = reachOf(
			(d as Declared).handler,
			(d as Declared).fns,
			(d as Declared).imported,
		);
		expect(r.writes).toBe(true);
	});

	it("the action walk is bipolar: a writing action is seen, a search action is not", () => {
		expect(convexFnWrites("search:recall")).toBeNull();
		expect(convexFnWrites("search:searchFixPatterns")).toBeNull();
		expect(convexFnWrites("okfBundleNode:exportOkfBundle")).toBeNull();
		expect(convexFnWrites("okfBundleNode:importOkfBundle")).not.toBeNull();
		expect(convexFnWrites("nope:missing")).toMatch(/unresolved/);
	});

	it("own-state declarations are a reviewed set, never read-only, and never advertised", () => {
		const own = [...declared].filter(([, d]) => d.ownStateOnly).map(([n]) => n);
		// A new `ownStateOnly: true` widens what a viewer may write: it must be added
		// here on purpose, with the authority that bounds whose state it is.
		expect(own.sort()).toEqual(["mark_as_read"]);
		for (const n of own) expect(declared.get(n)?.readOnly).not.toBe(true);
	});

	it("no tool declared readOnlyHint=true reaches a mutation or an action", () => {
		const problems: string[] = [];
		let readOnly = 0;
		for (const t of registered) {
			if (t.readOnly !== true) continue;
			readOnly++;
			const d = declared.get(t.name);
			if (!d) continue;
			const r = reachOf(d.handler, d.fns, d.imported);
			if (r.writes) {
				problems.push(
					`${t.name}: readOnlyHint=true but reaches ${r.why.join(" | ")}`,
				);
			}
		}
		console.log(
			`ANNOTATION-DERIVATION registered=${registered.length} declaredReadOnly=${readOnly} disagreements=${problems.length}`,
		);
		expect(problems, "read-only tools whose handler writes").toEqual([]);
	});
});
