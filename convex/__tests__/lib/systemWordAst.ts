/**
 * Finds every COMPARISON against the word "system" in the convex tree, through
 * the TypeScript AST, never through a regex over a line of text.
 *
 * task k171rnbk3k5a75x6y9s0wtmgj58fbmh0 (REVISE of PR #1357). The previous
 * control was a regex over `../*.ts` and `../lib/*.ts`. It was the ONLY proof
 * for the three `mandates.*` sites (their behavioural mutants are equivalent:
 * only master reaches them) and it stayed 24/24 GREEN on four foreign
 * spellings of the same comparison — Yoda order, a template literal, an alias,
 * a computed string — and it never read `convex/migrations/` at all. This
 * module decides by SYNTAX and SYMBOL FLOW, on the model of
 * mcp-server/test/lib/actingNameAst.ts (PR #1355).
 *
 * KNOWN LIMITS, DECLARED — read these before you read the green.
 *
 *   A value built at runtime has no literal node, so a syntactic instrument
 *   has nothing to see. Not seen here: `"sys" + "tem"`, a template with a
 *   substitution (`${a}${b}`), `["sys","tem"].join("")`, `.concat`, `.slice`,
 *   `.replace`, `String.fromCharCode(...)`, a string read from the database, an
 *   env var or another argument. The same limit is disclosed in
 *   mcp-server/test/lib/actingNameAst.ts ("a value built at runtime out of
 *   pieces has no such node and is not seen here"). That is the boundary of a
 *   syntactic instrument; for the mandates.* sites the verified-master gate
 *   (`requireFleetMaster`) and the shared predicate are what cover it.
 *
 *   Also not seen, for the same reason (no comparison node names the word):
 *   a value carried to the comparison inside a container or a call
 *   (`const cfg = { who: "system" }; x === cfg.who`, `eq(x, "system")` with
 *   the compare inside `eq`), and key-membership (`x in { system: 1 }`,
 *   `({ system: true })[x]`).
 *
 * WHAT IS SEEN. The literal operand, on EITHER side, resolved through the tree:
 *
 *   equality      `===` `!==` `==` `!=` with a system-valued operand on the
 *                 left OR the right (Yoda order included).
 *   switch        `switch (x) { case <system>: }` and `switch (<system>)`.
 *   membership    `[<system>, ...].includes(x)` / `.indexOf` / `.some`-style
 *                 receivers, `new Set([<system>])`, and the compare methods
 *                 (`.has` `.includes` `.startsWith` `.endsWith`
 *                 `.localeCompare` `.equals` `Object.is`) called with a
 *                 system-valued argument or on a system-valued receiver.
 *   pattern       a regular expression literal, or `new RegExp("...")`, whose
 *                 text is the word between optional anchors (`^system$`).
 *
 * "system-valued" means: a string / no-substitution-template / `String.raw`
 * literal whose text, trimmed and lower-cased, IS the word (so `"System"` and
 * `" system "` count); parentheses, `as`, `satisfies`, `!` and `<T>` around it
 * are transparent; an identifier (const, let, var, parameter default) whose
 * initializer is system-valued, including through an import in another convex
 * module; an enum member or `as const` property whose literal type is the word.
 * A `let` that is later reassigned is still counted: over-approximate, never
 * under-approximate.
 *
 * There is no exemption list. Exactly one site is the definition of the
 * predicate itself — the classification `predicate` requires the whole shape:
 * file convex/lib/systemCaller.ts, inside `function isFleetSystemCaller`,
 * `<param0>.isMaster && <param1> === "system"`. The same comparison anywhere
 * else, or in that function with any other shape, is BLOCKED.
 */

import ts from "typescript";

// Built from two pieces ON PURPOSE. This module is itself under the scan (it
// lives in convex/**, and there is no exemption list), and it has to compare
// text against the word. Spelled as a literal, every one of those comparisons
// would be — correctly — a BLOCKED site. Spelled from pieces it is a runtime
// value, which is exactly the declared limit at the top of this file; the
// "M4 computed string" fixtures in systemWordAuthority.test.ts pin that.
export const WORD: string = ["sys", "tem"].join("");
export const PREDICATE_FILE = "convex/lib/systemCaller.ts";
export const PREDICATE_FN = "isFleetSystemCaller";

export type Form = "equality" | "switch" | "membership" | "pattern";

export type Site = {
	file: string;
	line: number;
	column: number;
	form: Form;
	cls: "predicate" | null;
	reason: string;
	text: string;
};

const EQ_OPS = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.EqualsEqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsEqualsToken,
	ts.SyntaxKind.EqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsToken,
]);

// Methods whose argument (or receiver) IS the thing being compared.
const COMPARE_METHODS = new Set([
	"has",
	"includes",
	"indexOf",
	"lastIndexOf",
	"startsWith",
	"endsWith",
	"localeCompare",
	"equals",
	"is",
	"test",
	"match",
]);
// Receivers that make an array/set literal of the word a membership test.
const MEMBERSHIP_RECEIVER_METHODS = new Set([
	"includes",
	"indexOf",
	"lastIndexOf",
	"some",
	"every",
	"find",
	"findIndex",
]);

const isWord = (s: string): boolean => s.trim().toLowerCase() === WORD;

// `^system$`, `\bsystem\b`, `(?:system)`, `^(system)$` -> "system"
function regexIsWord(source: string): boolean {
	const bare = source
		.replace(/\\b/g, "")
		.replace(/\(\?:|\(|\)/g, "")
		.replace(/^\^|\$$/g, "");
	return isWord(bare);
}

export function analyse(files: Record<string, string>): Site[] {
	const texts = new Map<string, string>();
	for (const [name, text] of Object.entries(files)) texts.set(`/${name}`, text);
	const options: ts.CompilerOptions = {
		noLib: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		allowJs: true,
		skipLibCheck: true,
		types: [],
	};
	const dirs = new Set<string>();
	for (const k of texts.keys()) {
		for (let d = k.slice(0, k.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) {
			dirs.add(d);
		}
	}
	dirs.add("/");
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
		directoryExists: (d) => dirs.has(d),
	};
	const program = ts.createProgram([...texts.keys()], options, host);
	const checker = program.getTypeChecker();
	const sites: Site[] = [];

	// ── what is "system-valued" ────────────────────────────────────────────

	const unwrap = (e: ts.Node): ts.Node => {
		let cur = e;
		for (;;) {
			if (
				ts.isParenthesizedExpression(cur) ||
				ts.isNonNullExpression(cur) ||
				ts.isAsExpression(cur) ||
				ts.isSatisfiesExpression(cur) ||
				ts.isTypeAssertionExpression(cur)
			) {
				cur = cur.expression;
			} else return cur;
		}
	};

	function isStringRaw(n: ts.Node): n is ts.TaggedTemplateExpression {
		return (
			ts.isTaggedTemplateExpression(n) &&
			ts.isPropertyAccessExpression(n.tag) &&
			ts.isIdentifier(n.tag.expression) &&
			n.tag.expression.text === "String" &&
			n.tag.name.text === "raw"
		);
	}

	const seenDecl = new Set<ts.Node>();
	function systemValued(raw: ts.Node): boolean {
		const e = unwrap(raw);
		if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
			return isWord(e.text);
		}
		if (isStringRaw(e)) {
			return ts.isNoSubstitutionTemplateLiteral(e.template)
				? isWord(e.template.text)
				: false;
		}
		if (ts.isIdentifier(e)) {
			let sym = checker.getSymbolAtLocation(e);
			if (sym && sym.flags & ts.SymbolFlags.Alias) {
				sym = checker.getAliasedSymbol(sym);
			}
			for (const d of sym?.declarations ?? []) {
				if (seenDecl.has(d)) continue;
				seenDecl.add(d);
				try {
					if (
						(ts.isVariableDeclaration(d) || ts.isParameter(d)) &&
						d.initializer &&
						systemValued(d.initializer)
					) {
						return true;
					}
					if (ts.isEnumMember(d) && d.initializer && systemValued(d.initializer)) {
						return true;
					}
				} finally {
					seenDecl.delete(d);
				}
			}
		}
		if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
			// enum member / `as const` property: the checker knows its literal type
			const t = checker.getTypeAtLocation(e);
			if (t.isStringLiteral() && isWord(t.value)) return true;
			const sym = checker.getSymbolAtLocation(
				ts.isPropertyAccessExpression(e) ? e.name : e.argumentExpression,
			);
			for (const d of sym?.declarations ?? []) {
				if (ts.isEnumMember(d) && d.initializer && systemValued(d.initializer)) {
					return true;
				}
			}
		}
		return false;
	}

	// ── one file at a time ─────────────────────────────────────────────────

	for (const sf of program.getSourceFiles()) {
		if (!texts.has(sf.fileName)) continue;
		const rel = sf.fileName.slice(1);
		const lines = sf.text.split("\n");

		const enclosingFunction = (n: ts.Node): ts.FunctionDeclaration | null => {
			for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
				if (ts.isFunctionDeclaration(p)) return p;
			}
			return null;
		};

		/** The one shape that IS the predicate. */
		const isPredicateShape = (bin: ts.BinaryExpression): boolean => {
			if (rel !== PREDICATE_FILE) return false;
			if (bin.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) {
				return false;
			}
			const fn = enclosingFunction(bin);
			if (!fn || fn.name?.text !== PREDICATE_FN || fn.parameters.length !== 2) {
				return false;
			}
			const [p0, p1] = fn.parameters.map((p) => p.name);
			if (!p0 || !p1 || !ts.isIdentifier(p0) || !ts.isIdentifier(p1)) return false;
			// right operand of `<p0>.isMaster && ...`
			const and = bin.parent;
			if (
				!ts.isBinaryExpression(and) ||
				and.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken ||
				and.right !== bin
			) {
				return false;
			}
			const l = and.left;
			if (
				!ts.isPropertyAccessExpression(l) ||
				l.name.text !== "isMaster" ||
				!ts.isIdentifier(l.expression) ||
				l.expression.text !== p0.text
			) {
				return false;
			}
			// `<p1> === "system"`, the bare literal, p1 on the left
			return (
				ts.isIdentifier(bin.left) &&
				bin.left.text === p1.text &&
				ts.isStringLiteral(bin.right) &&
				bin.right.text === WORD
			);
		};

		const push = (
			n: ts.Node,
			form: Form,
			cls: Site["cls"],
			reason: string,
		): void => {
			const { line, character } = sf.getLineAndCharacterOfPosition(
				n.getStart(sf),
			);
			sites.push({
				file: rel,
				line: line + 1,
				column: character + 1,
				form,
				cls,
				reason,
				text: (lines[line] ?? "").trim(),
			});
		};

		const visit = (n: ts.Node): void => {
			// equality, either side
			if (ts.isBinaryExpression(n) && EQ_OPS.has(n.operatorToken.kind)) {
				if (systemValued(n.left) || systemValued(n.right)) {
					if (isPredicateShape(n)) {
						push(n, "equality", "predicate", "the shared predicate itself");
					} else {
						push(
							n,
							"equality",
							null,
							`a comparison against the word "${WORD}" outside the shared predicate ` +
								`(${ts.SyntaxKind[n.operatorToken.kind]}, ${
									systemValued(n.left) ? "literal on the left" : "literal on the right"
								})`,
						);
					}
				}
			}
			// switch
			if (ts.isSwitchStatement(n)) {
				if (systemValued(n.expression)) {
					push(n, "switch", null, `switch on the word "${WORD}"`);
				}
				for (const c of n.caseBlock.clauses) {
					if (ts.isCaseClause(c) && systemValued(c.expression)) {
						push(c, "switch", null, `case "${WORD}" outside the shared predicate`);
					}
				}
			}
			// compare-method calls: <recv>.has(<system>) / <system>.includes(x) / Object.is
			if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
				const m = n.expression.name.text;
				if (COMPARE_METHODS.has(m)) {
					const argHit = n.arguments.some((a) => systemValued(a));
					const recvHit = systemValued(n.expression.expression);
					if (argHit || recvHit) {
						push(n, "membership", null, `.${m}(...) compares against the word "${WORD}"`);
					}
				}
				// [<system>, ...].includes(x)
				if (MEMBERSHIP_RECEIVER_METHODS.has(m)) {
					const recv = unwrap(n.expression.expression);
					if (
						ts.isArrayLiteralExpression(recv) &&
						recv.elements.some((el) => systemValued(el))
					) {
						push(n, "membership", null, `[..."${WORD}"...].${m}(...) membership test`);
					}
				}
			}
			// new Set([<system>]) / new Set(<system>)
			if (
				ts.isNewExpression(n) &&
				ts.isIdentifier(n.expression) &&
				(n.expression.text === "Set" || n.expression.text === "Map")
			) {
				const arg = n.arguments?.[0] ? unwrap(n.arguments[0]) : undefined;
				if (
					arg &&
					ts.isArrayLiteralExpression(arg) &&
					arg.elements.some((el) => {
						const u = unwrap(el);
						return systemValued(ts.isArrayLiteralExpression(u) ? (u.elements[0] ?? u) : u);
					})
				) {
					push(n, "membership", null, `${n.expression.text} built over the word "${WORD}"`);
				}
			}
			// /^system$/ and new RegExp("^system$")
			if (ts.isRegularExpressionLiteral(n)) {
				const body = n.text.slice(1, n.text.lastIndexOf("/"));
				if (regexIsWord(body)) push(n, "pattern", null, `regular expression of the word "${WORD}"`);
			}
			if (
				ts.isNewExpression(n) &&
				ts.isIdentifier(n.expression) &&
				n.expression.text === "RegExp" &&
				n.arguments?.[0]
			) {
				const a = unwrap(n.arguments[0]);
				if (
					(ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) &&
					regexIsWord(a.text)
				) {
					push(n, "pattern", null, `RegExp of the word "${WORD}"`);
				}
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
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
