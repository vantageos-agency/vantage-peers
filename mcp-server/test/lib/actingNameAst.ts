/**
 * Classifies every occurrence of the acting-name token through the TypeScript
 * AST, never through a regex over a line of text.
 *
 * task k17dbtczxy047kav3qtxx1dpe18fbzf5 (REVISE of PR #1355). The previous
 * classifier matched lines with regexes and could be fooled in both
 * directions (measured before this rewrite): `{ callerOrchestrator: "system" }`
 * classified as PROSE, and `{ callerOrchestrator: <raw value> }` classified as
 * USE, so a suite that claimed to certify the surface stayed green with both
 * hostile shapes present. This module decides by SYNTAX and by SYMBOL FLOW:
 *
 *   prose        a comment, or a string/template literal whose text merely
 *                MENTIONS the token. Nothing else. A literal that is EXACTLY
 *                the token is a key name, not prose (see `key-literal` below).
 *   scope-decl   `fromArg: "callerOrchestrator"` inside a `kind: "from"` scope
 *                object that is the scope argument of a defineTool call.
 *   schema-decl  `callerOrchestrator: <zod expression>` inside the schema
 *                object that is the schema argument of a defineTool call.
 *   guard        `guardFrom(callerOrchestrator)` where the argument RESOLVES
 *                (symbol, not spelling) to the bound args.
 *   use          an identifier / property that provably flows from the bound
 *                args object: destructured from (or read off) the first
 *                parameter of a defineTool handler, or forwarded from such a
 *                binding. A same-spelled variable that is NOT that binding is
 *                not a use, it is a block.
 *   mechanism    the wrapper's own key derivation (`actingNameKeys` in
 *                registerTool.ts) and nothing else in that file.
 *
 * Anything else is `null` with a `reason` — the caller fails on it. The
 * MUST_BLOCK fixtures in the test file pin the shapes this must refuse.
 *
 * What `use` does NOT include (PR #1355, second REVISE). A binding that is
 * spelled like the args' key is a `use` only while its value can come from the
 * bound args ALONE. Two families of position break that, and both are BLOCK:
 *
 *   default-initializer   a default anywhere the acting name is bound or
 *                         assigned: `{ callerOrchestrator = d }` (parameter,
 *                         `const {..} = args`, any nesting depth),
 *                         `async ({..} = d)`, `async (args = d)`,
 *                         `({ callerOrchestrator = d } = o)`. When the args
 *                         omit the name (permissive mode does exactly that for
 *                         an organisation-only caller) the default becomes the
 *                         name. Literal or not: no exemption, no allow-list.
 *   write-target          the binding or the args' property is written after
 *                         the fact: `=`, any compound assignment, `++`/`--`,
 *                         a for-in/of target, a destructuring-assignment
 *                         target. The one write that stays a `use` is the plain
 *                         `x.callerOrchestrator = <bound args' value>`.
 *
 * Known limits, stated. The token is found by its spelling as an identifier or
 * a whole-literal key. A value built at runtime out of pieces
 * (`"caller" + "Orchestrator"`) has no such node and is not seen here. Neither
 * is a value that arrives through a spread, `Object.assign(args, x)` or a
 * JSON round trip: no acting-name token is spelled at the write. That is the
 * boundary of a syntactic instrument, and the runtime bind in registerTool.ts
 * (`bindActingNames`) is what covers it.
 */

import ts from "typescript";

export const ACTING_TOKEN = "callerOrchestrator";

export type SiteClass =
	| "scope-decl"
	| "schema-decl"
	| "guard"
	| "prose"
	| "use"
	| "mechanism";

export type Site = {
	file: string;
	line: number;
	column: number;
	node: "identifier" | "string" | "template" | "comment";
	cls: SiteClass | null;
	reason: string;
	text: string;
	/** Text of the physical line above (the ACTING-NAME marker is read from it). */
	prev: string;
};

const ZOD_ROOTS = new Set(["z", "creatorSchema"]);

// Reasons for the positions where a value can reach an acting-name binding
// WITHOUT flowing from the bound args. Each is a BLOCK (cls null); the
// `default-initializer` / `write-target` prefixes are what MUST_BLOCK pins.
const DEFAULT_INITIALIZER =
	"default-initializer: a default on the acting-name binding supplies the value when the args omit it, " +
	"so an omitted name becomes the default instead of staying omitted";
const DEFAULT_INITIALIZER_PARAM =
	"default-initializer: the handler's own parameter carries a default, so the whole args object can come from the default";
const WRITE_TARGET =
	"write-target: the acting-name binding is written (assignment, compound assignment, ++/--, " +
	"for-in/of target or destructuring-assignment target), so its value can come from somewhere other than the bound args";

function isDefineToolCall(n: ts.Node): n is ts.CallExpression {
	return (
		ts.isCallExpression(n) &&
		ts.isIdentifier(n.expression) &&
		n.expression.text === "defineTool"
	);
}

/** Argument index `i` of a defineTool call, when `obj` is exactly that argument. */
function isDefineToolArg(obj: ts.Node, index: number): boolean {
	const call = obj.parent;
	return (
		call !== undefined &&
		isDefineToolCall(call) &&
		call.arguments[index] === obj
	);
}

/** `z.object({ ... })` — the object literal is its first argument. */
function isZodObjectArg(obj: ts.Node): boolean {
	const call = obj.parent;
	return (
		call !== undefined &&
		ts.isCallExpression(call) &&
		ts.isPropertyAccessExpression(call.expression) &&
		ts.isIdentifier(call.expression.expression) &&
		call.expression.expression.text === "z" &&
		call.expression.name.text === "object" &&
		call.arguments[0] === obj
	);
}

/** A defineTool handler: the LAST argument of a defineTool call, as a function. */
function isHandlerFunction(
	n: ts.Node | undefined,
): n is ts.FunctionLikeDeclaration {
	if (!n || !(ts.isArrowFunction(n) || ts.isFunctionExpression(n)))
		return false;
	const call = n.parent;
	return (
		call !== undefined &&
		isDefineToolCall(call) &&
		call.arguments[call.arguments.length - 1] === n
	);
}

export function analyse(files: Record<string, string>): Site[] {
	const texts = new Map<string, string>();
	for (const [name, text] of Object.entries(files)) texts.set(`/${name}`, text);
	const options: ts.CompilerOptions = {
		noResolve: true,
		noLib: true,
		target: ts.ScriptTarget.ES2022,
		skipLibCheck: true,
		types: [],
	};
	const host: ts.CompilerHost = {
		getSourceFile: (fileName, languageVersion) => {
			const t = texts.get(fileName);
			return t === undefined
				? undefined
				: ts.createSourceFile(fileName, t, languageVersion, true);
		},
		getDefaultLibFileName: () => "/lib.d.ts",
		writeFile: () => {},
		getCurrentDirectory: () => "/",
		getCanonicalFileName: (f) => f,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => "\n",
		fileExists: (f) => texts.has(f),
		readFile: (f) => texts.get(f),
	};
	const program = ts.createProgram([...texts.keys()], options, host);
	const checker = program.getTypeChecker();
	const sites: Site[] = [];

	// ── symbol flow ──────────────────────────────────────────────────────────

	/** The declarations a name resolves to, or [] when it resolves to nothing. */
	function declsOf(id: ts.Identifier): ts.Declaration[] {
		const parent = id.parent;
		const sym =
			ts.isShorthandPropertyAssignment(parent) && parent.name === id
				? checker.getShorthandAssignmentValueSymbol(parent)
				: checker.getSymbolAtLocation(id);
		return sym?.declarations ?? [];
	}

	/** First parameter of a defineTool handler, whatever its pattern or default. */
	function isHandlerFirstParam(d: ts.Node): d is ts.ParameterDeclaration {
		return (
			ts.isParameter(d) &&
			isHandlerFunction(d.parent) &&
			d.parent.parameters[0] === d
		);
	}

	/**
	 * Is this node written to: the left of any assignment operator (`=`, `??=`,
	 * `||=`, `+=` ...), an `++`/`--` operand, a `for (x of|in ...)` target, or a
	 * target inside a destructuring ASSIGNMENT (`({ k: x } = o)`, `[x] = a`,
	 * `[...x] = a`, `({ x = d } = o)`). Type assertions, `!` and parentheses
	 * around the target are transparent. `plain` carries the assignment when the
	 * node is the direct left of a bare `=` that is not itself inside a pattern.
	 */
	function writeContext(
		n: ts.Node,
	): { kind: "plain"; assign: ts.BinaryExpression } | { kind: "other" } | null {
		let cur: ts.Node = n;
		let direct = true;
		for (;;) {
			const p: ts.Node | undefined = cur.parent;
			if (!p) return null;
			if (
				(ts.isParenthesizedExpression(p) ||
					ts.isNonNullExpression(p) ||
					ts.isAsExpression(p) ||
					ts.isSatisfiesExpression(p) ||
					ts.isTypeAssertionExpression(p)) &&
				p.expression === cur
			) {
				cur = p;
				continue;
			}
			if (
				ts.isBinaryExpression(p) &&
				p.left === cur &&
				p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
				p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
			) {
				// `x = d` INSIDE a pattern is a default, not a plain assignment.
				if (
					direct &&
					p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
					writeContext(p) === null
				) {
					return { kind: "plain", assign: p };
				}
				return { kind: "other" };
			}
			if (
				(ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
				(p.operator === ts.SyntaxKind.PlusPlusToken ||
					p.operator === ts.SyntaxKind.MinusMinusToken)
			) {
				return { kind: "other" };
			}
			if (
				(ts.isForInStatement(p) || ts.isForOfStatement(p)) &&
				p.initializer === cur
			) {
				return { kind: "other" };
			}
			if (
				(ts.isPropertyAssignment(p) && p.initializer === cur) ||
				(ts.isShorthandPropertyAssignment(p) && p.name === cur) ||
				((ts.isSpreadAssignment(p) || ts.isSpreadElement(p)) &&
					p.expression === cur) ||
				ts.isObjectLiteralExpression(p) ||
				ts.isArrayLiteralExpression(p)
			) {
				cur = p;
				direct = false;
				continue;
			}
			return null;
		}
	}

	/** Parameters of a handler that something reassigns (memoised by declaration). */
	const reassigned = new Map<ts.Node, boolean>();
	function isReassigned(param: ts.ParameterDeclaration): boolean {
		const hit = reassigned.get(param);
		if (hit !== undefined) return hit;
		let found = false;
		const scan = (n: ts.Node): void => {
			if (found) return;
			if (
				ts.isIdentifier(n) &&
				ts.isIdentifier(param.name) &&
				n.text === param.name.text &&
				declsOf(n).includes(param) &&
				writeContext(n) !== null
			) {
				found = true;
				return;
			}
			ts.forEachChild(n, scan);
		};
		const owner = param.parent;
		if (isHandlerFunction(owner) && owner.body) scan(owner.body);
		reassigned.set(param, found);
		return found;
	}

	/** First parameter of a defineTool handler, when a plain identifier that no default or write touches. */
	function isArgsParam(d: ts.Declaration): boolean {
		return (
			isHandlerFirstParam(d) &&
			ts.isIdentifier(d.name) &&
			d.initializer === undefined &&
			!isReassigned(d)
		);
	}

	/** `args` — an identifier that resolves to the handler's bound args parameter. */
	function isArgsObject(e: ts.Expression): boolean {
		if (!ts.isIdentifier(e)) return false;
		const decls = declsOf(e);
		return decls.length > 0 && decls.every(isArgsParam);
	}

	/**
	 * A BindingElement whose KEY is the token, taken out of the bound args:
	 * either the handler's own destructured first parameter, or
	 * `const { callerOrchestrator } = args` inside a handler.
	 */
	function bindingDefect(d: ts.Declaration): string | null {
		const notArgs =
			"destructures the acting name from something other than a defineTool handler's args";
		if (!ts.isBindingElement(d)) return notArgs;
		const key = d.propertyName ?? d.name;
		if (!ts.isIdentifier(key) || key.text !== ACTING_TOKEN) return notArgs;
		// A default on the binding itself: when the args omit the name (which
		// permissive mode allows for an organisation-only caller) the DEFAULT is
		// the value, so the binding no longer flows from the bound args.
		if (d.initializer !== undefined) return DEFAULT_INITIALIZER;
		const pattern = d.parent;
		if (!ts.isObjectBindingPattern(pattern)) return notArgs;
		const owner = pattern.parent;
		if (ts.isParameter(owner)) {
			if (!isHandlerFirstParam(owner)) return notArgs;
			// `async ({ callerOrchestrator } = <default>) =>` supplies the WHOLE args object.
			return owner.initializer === undefined ? null : DEFAULT_INITIALIZER_PARAM;
		}
		if (ts.isVariableDeclaration(owner) && owner.initializer) {
			return isArgsObject(owner.initializer) ? null : notArgs;
		}
		return notArgs;
	}

	function isArgsBinding(d: ts.Declaration): boolean {
		return bindingDefect(d) === null;
	}

	/** Does this expression provably carry the bound args' acting name? */
	function flowsFromArgs(e: ts.Expression): boolean {
		if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) {
			return flowsFromArgs(e.expression);
		}
		if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) {
			return flowsFromArgs(e.expression);
		}
		if (ts.isIdentifier(e)) {
			const decls = declsOf(e);
			return decls.length > 0 && decls.every(isArgsBinding);
		}
		if (ts.isPropertyAccessExpression(e)) {
			return e.name.text === ACTING_TOKEN && isArgsObject(e.expression);
		}
		return false;
	}

	function zodRoot(e: ts.Expression): string | null {
		let cur: ts.Expression = e;
		for (;;) {
			if (ts.isCallExpression(cur)) cur = cur.expression;
			else if (ts.isPropertyAccessExpression(cur)) cur = cur.expression;
			else if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
			else break;
		}
		return ts.isIdentifier(cur) ? cur.text : null;
	}

	// ── one file at a time ───────────────────────────────────────────────────

	for (const sf of program.getSourceFiles()) {
		const rel = sf.fileName.slice(1);
		if (!texts.has(sf.fileName)) continue;
		const lines = sf.text.split("\n");

		const push = (
			pos: number,
			node: Site["node"],
			cls: SiteClass | null,
			reason: string,
		): void => {
			const { line, character } = sf.getLineAndCharacterOfPosition(pos);
			sites.push({
				file: rel,
				line: line + 1,
				column: character + 1,
				node,
				cls,
				reason,
				text: (lines[line] ?? "").trim(),
				prev: lines[line - 1] ?? "",
			});
		};

		const enclosingFunctionName = (n: ts.Node): string | null => {
			for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
				if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
			}
			return null;
		};

		/** Classify a whole-literal key ("callerOrchestrator") at `lit`. */
		const classifyKeyLiteral = (
			lit: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral,
		): { cls: SiteClass | null; reason: string } => {
			const parent = lit.parent;
			if (
				ts.isPropertyAssignment(parent) &&
				parent.initializer === lit &&
				ts.isIdentifier(parent.name) &&
				parent.name.text === "fromArg" &&
				ts.isObjectLiteralExpression(parent.parent) &&
				isDefineToolArg(parent.parent, 2) &&
				parent.parent.properties.some(
					(p) =>
						ts.isPropertyAssignment(p) &&
						ts.isIdentifier(p.name) &&
						p.name.text === "kind" &&
						ts.isStringLiteral(p.initializer) &&
						p.initializer.text === "from",
				)
			) {
				return {
					cls: "scope-decl",
					reason: "fromArg of a from-kind defineTool scope",
				};
			}
			if (
				rel.endsWith("registerTool.ts") &&
				enclosingFunctionName(lit) === "actingNameKeys"
			) {
				return { cls: "mechanism", reason: "key derivation in actingNameKeys" };
			}
			return {
				cls: null,
				reason:
					"key-literal: the bare token used as a KEY (property/element/`in`/const) " +
					"outside a from-scope declaration is a way to read or write the acting name that no flow analysis follows",
			};
		};

		const visit = (n: ts.Node): void => {
			// Strings and templates: prose unless the whole literal IS the token.
			if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
				if (n.text.includes(ACTING_TOKEN)) {
					const at = n.getStart(sf);
					if (n.text === ACTING_TOKEN) {
						const r = classifyKeyLiteral(n);
						push(at, "string", r.cls, r.reason);
					} else {
						push(
							at,
							"string",
							"prose",
							"string literal that mentions the token",
						);
					}
				}
			} else if (
				ts.isTemplateHead(n) ||
				ts.isTemplateMiddle(n) ||
				ts.isTemplateTail(n)
			) {
				if (n.text.includes(ACTING_TOKEN)) {
					push(
						n.getStart(sf),
						"template",
						"prose",
						"template text that mentions the token",
					);
				}
			} else if (ts.isIdentifier(n) && n.text === ACTING_TOKEN) {
				const r = classifyIdentifier(n);
				push(n.getStart(sf), "identifier", r.cls, r.reason);
			}
			ts.forEachChild(n, visit);
		};

		const classifyIdentifier = (
			id: ts.Identifier,
		): { cls: SiteClass | null; reason: string } => {
			const parent = id.parent;

			// `{ callerOrchestrator, ... }` / `{ callerOrchestrator: alias }` pattern key.
			if (ts.isBindingElement(parent)) {
				const key = parent.propertyName ?? parent.name;
				if (key === id) {
					const defect = bindingDefect(parent);
					return defect === null
						? { cls: "use", reason: "destructured from the bound args" }
						: { cls: null, reason: defect };
				}
				// alias side: `{ x: callerOrchestrator }` rebinds ANOTHER key to the token.
				return {
					cls: null,
					reason: "another key is rebound under the acting-name spelling",
				};
			}

			// `callerOrchestrator: <value>` in an object literal.
			if (ts.isPropertyAssignment(parent) && parent.name === id) {
				const obj = parent.parent;
				if (
					ts.isObjectLiteralExpression(obj) &&
					(isDefineToolArg(obj, 5) || isZodObjectArg(obj)) &&
					ZOD_ROOTS.has(zodRoot(parent.initializer) ?? "")
				) {
					return {
						cls: "schema-decl",
						reason:
							"zod parameter in a defineTool schema or a z.object(...) shape",
					};
				}
				if (flowsFromArgs(parent.initializer)) {
					return { cls: "use", reason: "forwards the bound args' value" };
				}
				return {
					cls: null,
					reason:
						"acting-name property whose value does not flow from the bound args " +
						`(${ts.SyntaxKind[parent.initializer.kind]})`,
				};
			}

			// `{ callerOrchestrator }` shorthand.
			if (ts.isShorthandPropertyAssignment(parent) && parent.name === id) {
				// `({ callerOrchestrator = d } = o)` — a destructuring ASSIGNMENT with a default.
				if (parent.objectAssignmentInitializer !== undefined) {
					return { cls: null, reason: DEFAULT_INITIALIZER };
				}
				// `({ callerOrchestrator } = o)` — the same shorthand as a write target.
				if (writeContext(id) !== null) {
					return { cls: null, reason: WRITE_TARGET };
				}
				return flowsFromArgs(id)
					? { cls: "use", reason: "shorthand forward of the bound args' value" }
					: {
							cls: null,
							reason:
								"shorthand acting-name property that does not resolve to the bound args",
						};
			}

			// `x.callerOrchestrator` (read or assignment target).
			if (ts.isPropertyAccessExpression(parent) && parent.name === id) {
				const w = writeContext(parent);
				if (w?.kind === "plain") {
					return flowsFromArgs(w.assign.right)
						? { cls: "use", reason: "assigns the bound args' value" }
						: {
								cls: null,
								reason:
									"assigns an acting name that does not flow from the bound args",
							};
				}
				// compound assignment, ++/--, for-in/of target, destructuring target,
				// or a default inside a destructuring assignment.
				if (w !== null) return { cls: null, reason: WRITE_TARGET };
				return isArgsObject(parent.expression)
					? { cls: "use", reason: "read off the bound args" }
					: {
							cls: null,
							reason:
								"acting name read off an object that is not the bound args",
						};
			}

			// A reference: must resolve to the bound args.
			const decls = declsOf(id);
			const isDeclarationName =
				(ts.isVariableDeclaration(parent) && parent.name === id) ||
				(ts.isParameter(parent) && parent.name === id) ||
				ts.isPropertySignature(parent) ||
				ts.isPropertyDeclaration(parent) ||
				ts.isFunctionDeclaration(parent) ||
				ts.isTypeAliasDeclaration(parent);
			if (isDeclarationName) {
				return {
					cls: null,
					reason:
						"declares a binding or member spelled as the acting name outside the bound args",
				};
			}
			if (decls.length === 0 || !decls.every(isArgsBinding)) {
				return {
					cls: null,
					reason:
						"identifier spelled as the acting name that does NOT resolve to the bound args " +
						"(a same-named variable is not the actor)",
				};
			}
			if (writeContext(id) !== null) {
				return { cls: null, reason: WRITE_TARGET };
			}
			if (
				ts.isCallExpression(parent) &&
				ts.isIdentifier(parent.expression) &&
				parent.expression.text === "guardFrom" &&
				parent.arguments.length === 1 &&
				parent.arguments[0] === id
			) {
				return { cls: "guard", reason: "guardFrom(<bound args' name>)" };
			}
			return { cls: "use", reason: "reference to the bound args' value" };
		};

		visit(sf);

		// Comments: every comment range attached to any token.
		const seen = new Set<number>();
		const scanTrivia = (n: ts.Node): void => {
			const kids = n.getChildren(sf);
			if (kids.length === 0) {
				const ranges = [
					...(ts.getLeadingCommentRanges(sf.text, n.getFullStart()) ?? []),
					...(ts.getTrailingCommentRanges(sf.text, n.getEnd()) ?? []),
				];
				for (const r of ranges) {
					if (seen.has(r.pos)) continue;
					seen.add(r.pos);
					const body = sf.text.slice(r.pos, r.end);
					for (
						let at = body.indexOf(ACTING_TOKEN);
						at !== -1;
						at = body.indexOf(ACTING_TOKEN, at + 1)
					) {
						push(r.pos + at, "comment", "prose", "comment");
					}
				}
			}
			for (const k of kids) scanTrivia(k);
		};
		scanTrivia(sf);
	}

	sites.sort((a, b) =>
		a.file === b.file
			? a.line - b.line || a.column - b.column
			: a.file < b.file
				? -1
				: 1,
	);
	return sites;
}

export function tally(sites: readonly Site[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const s of sites)
		out[s.cls ?? "BLOCKED"] = (out[s.cls ?? "BLOCKED"] ?? 0) + 1;
	return out;
}
