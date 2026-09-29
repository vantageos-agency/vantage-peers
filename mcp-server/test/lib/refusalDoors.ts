/**
 * Derives the set of backend doors that can answer with a refusal ENVELOPE, and
 * every MCP call site of such a door, through the TypeScript AST.
 *
 * task k17... (REVISE of PR #1361). The previous sweep took its POPULATION from
 * the regex `refused:\s*true\s+as\s+const` over handler bodies: one spelling of
 * an implementation detail. `refused: true as true` typechecks identically and
 * vanished from the population, so its MCP reader was free to discard the
 * marker while the sweep reported every door covered.
 *
 * WHAT IS THE DOOR'S CONTRACT. The `returns` validator. It is what Convex
 * enforces at runtime and what every caller is promised, so a door is
 * envelope-capable when its declared `returns` admits a `refused` field whose
 * validator is `v.literal(true)`, however that is spelled:
 * optional, inside a `v.union`, hoisted into a named const, imported from
 * another module, or reached through `.extend`. The handler's spelling is never
 * read to DECIDE a door. It is read for exactly one other purpose: a handler
 * that emits `refused: true` from a builder whose `returns` does NOT declare it
 * is an UNDECLARED envelope (`undeclaredEnvelopes`), reported on its own, so a
 * door cannot escape by simply leaving the validator out.
 *
 * COVERED (call sites)
 *   - `convex.query("x:y" as any, ...)`, and the `mutation` / `action` /
 *     `fetchConvex` / `runQuery` / `runMutation` / `runAction` forms;
 *   - `api.x.y`, `internal.x.y`, `anyApi.x.y`, `api["x"]["y"]`,
 *     `makeFunctionReference("x:y")`;
 *   - a door name reached through a `const` string (`const D = "x:y"`);
 *   - the check is the ENCLOSING FUNCTION of the call, not a line window: a
 *     handler of any length is read whole;
 *   - when the result is bound (`const r = await convex.query(...)`), the
 *     handler must test THAT binding, not merely mention `isRefusedEnvelope`
 *     somewhere.
 *
 * NAMED, NOT COVERED — each is out of reach of a static read, and stated so:
 *   - a call whose door name is computed (template with substitutions, string
 *     concatenation, a function parameter): the door cannot be known
 *     statically. `unresolved` counts them so the number is visible.
 *   - an aliased client (`const q = convex.query.bind(convex)`), or a query
 *     issued by a caller outside `mcp-server/src`.
 *   - an unbound result (`return await convex.query(...)`): only the presence
 *     of `isRefusedEnvelope(` in the enclosing function is required.
 *   - the check is PRESENCE of a test on the binding, not that it runs BEFORE
 *     the coalescing (no control-flow analysis).
 *   - `refused: v.boolean()` is NOT a door: it is a scope-shaped flag on an
 *     answer that also says `false` (measured: `lib/auth:resolveOrgScopeForAction`,
 *     an internalQuery whose caller is a Convex action, not the MCP). Only the
 *     literal `true` is an envelope, because only it can never be a served result.
 *   - a builder with no `returns` validator has no contract to read; it is
 *     listed by `doorsWithoutReturns` rather than silently skipped.
 *   - identifier resolution of a named validator is by NAME across convex/*.ts:
 *     two consts of the same name in different modules are both followed
 *     (over-inclusion, never omission).
 */

import ts from "typescript";

export type Src = { name: string; text: string };

const BUILDER = /(?:query|mutation|action)$/i;
const CALLEES = new Set([
	"query",
	"mutation",
	"action",
	"fetchConvex",
	"runQuery",
	"runMutation",
	"runAction",
]);
const API_ROOTS = new Set(["api", "internal", "anyApi"]);

function parse(s: Src): ts.SourceFile {
	return ts.createSourceFile(s.name, s.text, ts.ScriptTarget.Latest, true);
}

function strip(e: ts.Expression): ts.Expression {
	let cur = e;
	for (;;) {
		if (
			ts.isParenthesizedExpression(cur) ||
			ts.isAsExpression(cur) ||
			ts.isNonNullExpression(cur) ||
			ts.isTypeAssertionExpression(cur) ||
			ts.isSatisfiesExpression(cur) ||
			ts.isAwaitExpression(cur)
		) {
			cur = cur.expression;
		} else return cur;
	}
}

function propName(n: ts.PropertyName): string | undefined {
	if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text;
	if (ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
	if (ts.isComputedPropertyName(n)) {
		const e = strip(n.expression);
		if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
	}
	return undefined;
}

type Consts = Map<string, ts.Expression[]>;

function collectConsts(files: ts.SourceFile[]): Consts {
	const m: Consts = new Map();
	for (const sf of files) {
		for (const st of sf.statements) {
			if (!ts.isVariableStatement(st)) continue;
			for (const d of st.declarationList.declarations) {
				if (ts.isIdentifier(d.name) && d.initializer) {
					const list = m.get(d.name.text) ?? [];
					list.push(d.initializer);
					m.set(d.name.text, list);
				}
			}
		}
	}
	return m;
}

function isReference(id: ts.Identifier): boolean {
	const p = id.parent;
	if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
	if (ts.isPropertyAssignment(p) && p.name === id) return false;
	return true;
}

/** Does this validator subtree carry `v.literal(true)`? (a `v.boolean()` is deliberately NOT one) */
function isFlagValidator(e: ts.Node, consts: Consts, seen: Set<string>): boolean {
	let found = false;
	const visit = (n: ts.Node): void => {
		if (found) return;
		if (ts.isCallExpression(n)) {
			const c = n.expression;
			const name = ts.isPropertyAccessExpression(c)
				? c.name.text
				: ts.isIdentifier(c)
					? c.text
					: "";
			if (name === "literal" && n.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword) {
				found = true;
				return;
			}
		}
		if (ts.isIdentifier(n) && isReference(n) && !seen.has(n.text)) {
			seen.add(n.text);
			for (const init of consts.get(n.text) ?? []) visit(init);
		}
		ts.forEachChild(n, visit);
	};
	visit(e);
	return found;
}

/** Does this `returns` validator admit a `refused` field? Follows named consts. */
export function admitsRefused(
	returns: ts.Node,
	consts: Consts,
	seen: Set<string> = new Set(),
	anyKey = false,
): boolean {
	let found = false;
	const visit = (n: ts.Node): void => {
		if (found) return;
		if (ts.isPropertyAssignment(n) && propName(n.name) === "refused") {
			if (anyKey || isFlagValidator(n.initializer, consts, new Set())) {
				found = true;
				return;
			}
		}
		if (ts.isShorthandPropertyAssignment(n) && n.name.text === "refused") {
			if (anyKey || isFlagValidator(n.name, consts, new Set())) {
				found = true;
				return;
			}
		}
		if (ts.isIdentifier(n) && isReference(n) && !seen.has(n.text)) {
			seen.add(n.text);
			for (const init of consts.get(n.text) ?? []) visit(init);
		}
		ts.forEachChild(n, visit);
	};
	visit(returns);
	return found;
}

type Builder = {
	module: string;
	exportName: string;
	config: ts.ObjectLiteralExpression;
	returns: ts.Expression | undefined;
	handler: ts.Node | undefined;
};

function builders(sf: ts.SourceFile, module: string): Builder[] {
	const out: Builder[] = [];
	for (const st of sf.statements) {
		if (!ts.isVariableStatement(st)) continue;
		if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
		for (const d of st.declarationList.declarations) {
			if (!ts.isIdentifier(d.name) || !d.initializer) continue;
			const init = strip(d.initializer);
			if (!ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) continue;
			if (!BUILDER.test(init.expression.text)) continue;
			const cfg = init.arguments[0];
			if (!cfg || !ts.isObjectLiteralExpression(cfg)) continue;
			let returns: ts.Expression | undefined;
			let handler: ts.Node | undefined;
			for (const p of cfg.properties) {
				if (ts.isPropertyAssignment(p) && propName(p.name) === "returns") returns = p.initializer;
				if (ts.isShorthandPropertyAssignment(p) && p.name.text === "returns") returns = p.name;
				if (
					(ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) &&
					propName(p.name) === "handler"
				)
					handler = p;
			}
			out.push({ module, exportName: d.name.text, config: cfg, returns, handler });
		}
	}
	return out;
}

export type Derivation = {
	/** `module:export` of every door whose `returns` admits `refused`. */
	doors: string[];
	/** Doors whose handler emits `refused: true` but whose `returns` does not admit it. */
	undeclaredEnvelopes: string[];
	/** Builders with no `returns` validator: no contract to read. */
	doorsWithoutReturns: string[];
};

export function deriveDoors(convexFiles: Src[]): Derivation {
	const sfs = convexFiles.map(parse);
	const consts = collectConsts(sfs);
	const doors = new Set<string>();
	const undeclared = new Set<string>();
	const without = new Set<string>();
	convexFiles.forEach((src, i) => {
		for (const b of builders(sfs[i], src.name.replace(/\.ts$/, ""))) {
			const id = `${b.module}:${b.exportName}`;
			if (!b.returns) {
				without.add(id);
				continue;
			}
			const declared = admitsRefused(b.returns, consts);
			if (declared) doors.add(id);
			// Undeclared = the validator does not name a `refused` key AT ALL. A
			// `refused: v.boolean()` scope flag is declared, just not an envelope.
			if (!admitsRefused(b.returns, consts, new Set(), true) && b.handler) {
				let emits = false;
				const visit = (n: ts.Node): void => {
					if (emits) return;
					if (ts.isPropertyAssignment(n) && propName(n.name) === "refused") {
						if (strip(n.initializer).kind === ts.SyntaxKind.TrueKeyword) emits = true;
					}
					ts.forEachChild(n, visit);
				};
				visit(b.handler);
				if (emits) undeclared.add(id);
			}
		}
	});
	return {
		doors: [...doors].sort(),
		undeclaredEnvelopes: [...undeclared].sort(),
		doorsWithoutReturns: [...without].sort(),
	};
}

// ── call sites ──────────────────────────────────────────────────────────────

function stringOf(e: ts.Expression, fileConsts: Map<string, ts.Expression>, depth = 0): string | undefined {
	const x = strip(e);
	if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return x.text;
	if (ts.isIdentifier(x) && depth < 4) {
		const init = fileConsts.get(x.text);
		if (init) return stringOf(init, fileConsts, depth + 1);
	}
	return undefined;
}

function apiPath(e: ts.Expression): string | undefined {
	const segs: string[] = [];
	let cur: ts.Expression = strip(e);
	for (;;) {
		if (ts.isPropertyAccessExpression(cur)) {
			segs.unshift(cur.name.text);
			cur = strip(cur.expression);
		} else if (ts.isElementAccessExpression(cur)) {
			const a = strip(cur.argumentExpression);
			if (!ts.isStringLiteral(a) && !ts.isNoSubstitutionTemplateLiteral(a)) return undefined;
			segs.unshift(a.text);
			cur = strip(cur.expression);
		} else break;
	}
	if (!ts.isIdentifier(cur) || !API_ROOTS.has(cur.text) || segs.length < 2) return undefined;
	return `${segs.slice(0, -1).join("/")}:${segs[segs.length - 1]}`;
}

function resolveDoor(arg: ts.Expression, fileConsts: Map<string, ts.Expression>): string | undefined {
	const s = stringOf(arg, fileConsts);
	if (s !== undefined) return s;
	const a = apiPath(arg);
	if (a) return a;
	const x = strip(arg);
	if (
		ts.isCallExpression(x) &&
		ts.isIdentifier(x.expression) &&
		x.expression.text === "makeFunctionReference" &&
		x.arguments[0]
	)
		return stringOf(x.arguments[0], fileConsts);
	return undefined;
}

function enclosingFunction(n: ts.Node): ts.Node {
	let cur: ts.Node = n;
	while (cur.parent) {
		cur = cur.parent;
		if (
			ts.isArrowFunction(cur) ||
			ts.isFunctionExpression(cur) ||
			ts.isFunctionDeclaration(cur) ||
			ts.isMethodDeclaration(cur)
		)
			return cur;
	}
	return n.getSourceFile();
}

function boundName(call: ts.CallExpression): string | undefined {
	let cur: ts.Node = call;
	while (
		cur.parent &&
		(ts.isParenthesizedExpression(cur.parent) ||
			ts.isAsExpression(cur.parent) ||
			ts.isNonNullExpression(cur.parent) ||
			ts.isAwaitExpression(cur.parent) ||
			ts.isTypeAssertionExpression(cur.parent) ||
			ts.isSatisfiesExpression(cur.parent))
	)
		cur = cur.parent;
	const p = cur.parent;
	if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
	return undefined;
}

export type CallSite = {
	file: string;
	line: number;
	door: string;
	ok: boolean;
	why: string;
};

export type CallSweep = { sites: CallSite[]; unresolved: number };

export function sweepCallSites(srcFiles: Src[], doors: string[]): CallSweep {
	const want = new Set(doors);
	const sites: CallSite[] = [];
	let unresolved = 0;
	for (const src of srcFiles) {
		const sf = parse(src);
		const fileConsts = new Map<string, ts.Expression>();
		for (const st of sf.statements) {
			if (!ts.isVariableStatement(st)) continue;
			for (const d of st.declarationList.declarations)
				if (ts.isIdentifier(d.name) && d.initializer) fileConsts.set(d.name.text, d.initializer);
		}
		const visit = (n: ts.Node): void => {
			if (ts.isCallExpression(n)) {
				const c = n.expression;
				const name = ts.isPropertyAccessExpression(c)
					? c.name.text
					: ts.isIdentifier(c)
						? c.text
						: "";
				if (CALLEES.has(name) && n.arguments[0]) {
					const door = resolveDoor(n.arguments[0], fileConsts);
					if (door === undefined) {
						unresolved += 1;
					} else if (want.has(door)) {
						const fn = enclosingFunction(n);
						const bound = boundName(n);
						let tested = false;
						const scan = (m: ts.Node): void => {
							if (tested) return;
							if (
								ts.isCallExpression(m) &&
								ts.isIdentifier(m.expression) &&
								m.expression.text === "isRefusedEnvelope"
							) {
								const a = m.arguments[0] ? strip(m.arguments[0]) : undefined;
								if (bound === undefined || (a && ts.isIdentifier(a) && a.text === bound))
									tested = true;
							}
							ts.forEachChild(m, scan);
						};
						scan(fn);
						sites.push({
							file: src.name,
							line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
							door,
							ok: tested,
							why: tested
								? "tests the envelope"
								: bound === undefined
									? `reads ${door} without isRefusedEnvelope in its function`
									: `reads ${door} into \`${bound}\` but never calls isRefusedEnvelope(${bound})`,
						});
					}
				}
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	return { sites, unresolved };
}
