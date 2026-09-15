// Structural (AST-based) scan: every `.withIndex(...)` call anywhere under
// convex/ that targets a "*_unread" index on `messageReceipts` (as declared
// in schema.ts — the required-fields list is DERIVED from schema.ts, not
// hand-duplicated here) must bind ALL of that index's fields — including
// `readAt` — inside the withIndex call's own range-builder chain, not in a
// later `.filter()`.
//
// This replaces a prior literal-string-match version
// (`expect(call).toContain('.eq("readAt", undefined)')`) that Eta correctly
// refused to gate on: PR #1287 comment
// https://github.com/vantageos-agency/vantage-peers/pull/1287#issuecomment-5670085757
// — it only bit on the exact string it was written against, and its own
// "bite proof" mutated that same string.
//
// Design goals per the hardening brief:
//   (a) index name passed via a same-file `const` — RESOLVED (see
//       `collectTopLevelStringConsts`, consulted in `scanUnreadIndexBindings`).
//   (b) the range bound built inside a helper function — RESOLVED for
//       helpers declared in the SAME file, in three shapes: a bare
//       reference used directly as the callback, a curried helper called
//       with an argument, or a non-curried helper called directly — see
//       `resolveRangeBuilder`.
//   (c) a receipt read added in a file other than messages.ts — RESOLVED:
//       every non-generated, non-test `.ts` file under convex/ is scanned.
//   (d) readAt bound but a required prefix field dropped — RESOLVED: the
//       check requires the FULL field list from schema.ts, not just
//       "readAt".
//
// FAIL-CLOSED on anything this scan cannot statically prove: an unresolved
// INDEX NAME on a chain that is NOT provably `.query("messageReceipts")` is
// SKIPPED as "not relevant" — we cannot tell whether it names one of our
// tracked unread indexes, so it is neither a pass nor a violation, just
// invisible (see NAMED GAPS). An unresolved withIndex CALLBACK shape (index
// name IS one of ours, but the range-builder argument cannot be resolved to
// a param+body by `resolveRangeBuilder`), a withIndex call missing its
// range-builder argument entirely, an unresolvable index name on a chain
// that DOES provably read `.query("messageReceipts")`, and any template
// literal with an interpolated (non-const) value are all treated as
// VIOLATIONS, never a silent pass — see `NAMED GAPS` below and in the test
// file header.
//
// NAMED GAPS (this scan does NOT catch, by construction):
//   - Index names built from string concatenation or destructured/imported
//     from another module, ON A NON-`messageReceipts` CHAIN — these are
//     indistinguishable from an unrelated index name on an unrelated table
//     and are silently skipped (not flagged as a violation, not flagged as
//     a pass — simply invisible to this scan). The SAME shapes on a chain
//     that provably reads `.query("messageReceipts")` ARE now flagged as
//     violations (fail-closed) — see `chainHasMessageReceiptsQuery` — because
//     we know statically which table is involved even when we cannot
//     resolve which index. Template literals are no longer categorically
//     invisible: a `` `by_recipient_unread` `` (no-substitution) template
//     literal resolves exactly like the equivalent string literal, and a
//     template literal WITH an interpolated value (`` `${x}_unread` ``)
//     fails closed as a violation regardless of which table it chains from,
//     since a dynamically-built index name on ANY table is itself a red
//     flag for this class of bug.
//   - Helper functions for shape (b) that live in ANOTHER file (imported)
//     rather than the same file — these fall through to the fail-closed
//     "unresolved shape" violation, which means a LEGITIMATE cross-file
//     helper would currently be (correctly, conservatively) flagged as a
//     violation. There is no such helper in the codebase today.
//   - The VALUE bound to a field, only the field NAME. `.eq("readAt", 42)`
//     (a wrong, non-`undefined` value) satisfies this scan exactly the same
//     as `.eq("readAt", undefined)` — semantic correctness of the bound
//     value is out of scope for a static shape scan and is covered instead
//     by the behavioural parity test in the same test file.
//   - Convex's actual index-range validity rules (e.g. that only the LAST
//     bound field may be a non-`.eq` range operator) — this scan only
//     checks presence of a `.eq(fieldName, ...)` call per required field,
//     not that the resulting range is a well-formed Convex IndexRange.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

export interface UnreadIndexMatch {
	file: string;
	line: number;
	indexName: string;
	requiredFields: string[];
	boundFields: string[];
	missingFields: string[];
	resolved: boolean;
	reason?: string;
}

export interface ScanResult {
	schemaIndexes: Record<string, string[]>;
	matches: UnreadIndexMatch[];
}

const RANGE_METHODS = new Set(["eq", "gt", "gte", "lt", "lte"]);

/**
 * Resolve a node to a literal string IF it is either a plain string literal
 * or a no-substitution template literal (`` `by_recipient_unread` `` with no
 * `${...}` inside it) — the two shapes are semantically identical string
 * constants, so both are resolved identically. A template literal WITH a
 * substitution (`` `${x}_unread` ``) is deliberately NOT handled here — it is
 * left unresolved so callers can fail closed on it.
 */
function resolveStringLike(node: ts.Node): string | undefined {
	if (ts.isStringLiteral(node)) return node.text;
	if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	return undefined;
}

function listTsFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "_generated" || entry === "node_modules") continue;
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			listTsFiles(full, out);
		} else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
			out.push(full);
		}
	}
	return out;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
	return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/**
 * Extract `messageReceipts` index definitions from schema.ts:
 * indexName -> ordered field list, exactly as declared via `.index(name, [fields])`.
 * Only indexes whose field list includes "readAt" are relevant to this guard.
 */
export function extractSchemaUnreadIndexes(schemaPath: string): Record<string, string[]> {
	const source = readFileSync(schemaPath, "utf8");
	const sf = ts.createSourceFile(schemaPath, source, ts.ScriptTarget.Latest, true);
	const indexes: Record<string, string[]> = {};

	function collectIndexCalls(node: ts.Node) {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === "index" &&
			node.arguments.length === 2 &&
			ts.isStringLiteral(node.arguments[0]) &&
			ts.isArrayLiteralExpression(node.arguments[1])
		) {
			const name = node.arguments[0].text;
			const fields = node.arguments[1].elements
				.filter(ts.isStringLiteral)
				.map((e) => e.text);
			indexes[name] = fields;
		}
		ts.forEachChild(node, collectIndexCalls);
	}

	function visit(node: ts.Node) {
		if (
			ts.isPropertyAssignment(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === "messageReceipts"
		) {
			collectIndexCalls(node.initializer);
			return; // don't descend into siblings via the outer walk twice
		}
		ts.forEachChild(node, visit);
	}

	visit(sf);

	const unreadOnly: Record<string, string[]> = {};
	for (const [name, fields] of Object.entries(indexes)) {
		if (fields.includes("readAt")) unreadOnly[name] = fields;
	}
	return unreadOnly;
}

/** Walk down a chain of `.eq()/.gt()/...` calls or property accesses to find whether its root is `paramName`. */
function chainRootIsParam(expr: ts.Expression, paramName: string): boolean {
	let cur: ts.Expression = expr;
	for (;;) {
		if (ts.isParenthesizedExpression(cur)) {
			cur = cur.expression;
			continue;
		}
		if (ts.isIdentifier(cur)) return cur.text === paramName;
		if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
			cur = cur.expression.expression;
			continue;
		}
		if (ts.isPropertyAccessExpression(cur)) {
			cur = cur.expression;
			continue;
		}
		return false;
	}
}

/** Collect every field name bound via `.eq("field", ...)` (or other range op) rooted at `paramName`, anywhere in `bodyNode`. */
function collectBoundFields(bodyNode: ts.Node, paramName: string): Set<string> {
	const fields = new Set<string>();
	function visit(node: ts.Node) {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			RANGE_METHODS.has(node.expression.name.text) &&
			chainRootIsParam(node.expression.expression, paramName)
		) {
			const methodName = node.expression.name.text;
			const firstArg = node.arguments[0];
			if (methodName === "eq" && firstArg) {
				const fieldName = resolveStringLike(firstArg);
				if (fieldName !== undefined) fields.add(fieldName);
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(bodyNode);
	return fields;
}

type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** Find same-file top-level function/arrow-const declarations, keyed by name (raw nodes, not yet resolved to a q-param). */
function collectTopLevelFunctions(sf: ts.SourceFile): Map<string, FunctionLike> {
	const fns = new Map<string, FunctionLike>();

	function visit(node: ts.Node) {
		if (ts.isFunctionDeclaration(node) && node.name) {
			fns.set(node.name.text, node);
		}
		if (ts.isVariableStatement(node)) {
			for (const decl of node.declarationList.declarations) {
				if (
					ts.isIdentifier(decl.name) &&
					decl.initializer &&
					(ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
				) {
					fns.set(decl.name.text, decl.initializer);
				}
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sf);
	return fns;
}

/**
 * Resolve a withIndex range-builder ARGUMENT to its ultimate
 * (paramName, body) — the identifier that stands for the index-range `q`
 * builder, and the expression/block in which its `.eq(...)` chain lives.
 *
 * Handles, recursively (bounded depth to avoid infinite loops on
 * self-referential helpers):
 *   - an inline arrow/function expression: `(q) => q.eq(...)`             — base case
 *   - a bare reference to a same-file helper used AS the callback itself:
 *     `.withIndex(name, helperFn)` where `helperFn = (q) => q.eq(...)`    — case (b) variant 1
 *   - a CALL to a same-file CURRIED helper: `.withIndex(name, helperFn(r))`
 *     where `helperFn = (r) => (q) => q.eq("recipient", r)` — resolves
 *     through the call to the inner arrow, whose OWN param is the real `q` — case (b), brief's literal shape
 *   - a CALL to a same-file NON-curried helper whose body already binds
 *     against its own first parameter (`helperFn(q)` where `helperFn` is
 *     declared `(q) => ...`) is treated the same as the bare-reference case.
 *
 * Returns null (fail-closed at the call site) if it cannot resolve within
 * the SAME file — see the NAMED GAPS section at the top of this file.
 */
function resolveRangeBuilder(
	expr: ts.Expression,
	helperFns: Map<string, FunctionLike>,
	depth = 0,
): { paramName: string; body: ts.Node } | null {
	if (depth > 5) return null;

	if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
		const param = expr.parameters[0];
		if (!param || !ts.isIdentifier(param.name) || !expr.body) return null;
		return { paramName: param.name.text, body: expr.body };
	}

	if (ts.isIdentifier(expr)) {
		const fn = helperFns.get(expr.text);
		if (!fn) return null;
		const param = fn.parameters[0];
		if (!param || !ts.isIdentifier(param.name) || !fn.body) return null;
		return { paramName: param.name.text, body: fn.body };
	}

	if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
		const fn = helperFns.get(expr.expression.text);
		if (!fn || !fn.body) return null;

		// Curried helper: its body is (or returns) another arrow/function —
		// that INNER function's own param is the real `q`.
		if (ts.isArrowFunction(fn.body) || ts.isFunctionExpression(fn.body)) {
			return resolveRangeBuilder(fn.body, helperFns, depth + 1);
		}
		if (ts.isBlock(fn.body)) {
			for (const stmt of fn.body.statements) {
				if (
					ts.isReturnStatement(stmt) &&
					stmt.expression &&
					(ts.isArrowFunction(stmt.expression) || ts.isFunctionExpression(stmt.expression))
				) {
					return resolveRangeBuilder(stmt.expression, helperFns, depth + 1);
				}
			}
			return null;
		}

		// Non-curried: the helper's OWN first parameter is `q`.
		const param = fn.parameters[0];
		if (!param || !ts.isIdentifier(param.name)) return null;
		return { paramName: param.name.text, body: fn.body };
	}

	return null;
}

/**
 * Find same-file top-level `const NAME = "literal"` (or
 * `` const NAME = `literal` `` no-substitution template) string
 * declarations, keyed by name.
 */
function collectTopLevelStringConsts(sf: ts.SourceFile): Map<string, string> {
	const consts = new Map<string, string>();
	function visit(node: ts.Node) {
		if (ts.isVariableStatement(node)) {
			for (const decl of node.declarationList.declarations) {
				if (ts.isIdentifier(decl.name) && decl.initializer) {
					const literal = resolveStringLike(decl.initializer);
					if (literal !== undefined) consts.set(decl.name.text, literal);
				}
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sf);
	return consts;
}

/**
 * Walk the object chain a `.withIndex(...)` call is invoked on (e.g. the
 * `ctx.db.query("messageReceipts")` in
 * `ctx.db.query("messageReceipts").withIndex(...)`) looking for a
 * `.query("messageReceipts")` call anywhere in that chain. Used to decide
 * whether an UNRESOLVABLE index-name argument should fail closed (we know
 * statically which table is involved) or be silently skipped as a NAMED GAP
 * (we don't know the table, so we can't know if it's one of our tracked
 * indexes either).
 */
function chainHasMessageReceiptsQuery(expr: ts.Expression): boolean {
	let cur: ts.Expression = expr;
	for (;;) {
		if (ts.isParenthesizedExpression(cur)) {
			cur = cur.expression;
			continue;
		}
		if (ts.isCallExpression(cur)) {
			if (ts.isPropertyAccessExpression(cur.expression)) {
				if (cur.expression.name.text === "query") {
					const arg = cur.arguments[0];
					if (arg && resolveStringLike(arg) === "messageReceipts") return true;
				}
				cur = cur.expression.expression;
				continue;
			}
			return false;
		}
		if (ts.isPropertyAccessExpression(cur)) {
			cur = cur.expression;
			continue;
		}
		return false;
	}
}

export function scanUnreadIndexBindings(convexDir: string, schemaPath: string): ScanResult {
	const schemaIndexes = extractSchemaUnreadIndexes(schemaPath);
	const indexNames = new Set(Object.keys(schemaIndexes));
	const matches: UnreadIndexMatch[] = [];

	for (const file of listTsFiles(convexDir)) {
		const source = readFileSync(file, "utf8");
		const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
		const stringConsts = collectTopLevelStringConsts(sf);
		const helperFns = collectTopLevelFunctions(sf);

		function visit(node: ts.Node) {
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.name.text === "withIndex" &&
				node.arguments.length >= 1
			) {
				const nameArg = node.arguments[0];
				let resolvedName: string | undefined = resolveStringLike(nameArg);
				if (resolvedName === undefined && ts.isIdentifier(nameArg) && stringConsts.has(nameArg.text)) {
					resolvedName = stringConsts.get(nameArg.text);
				}
				const isDynamicTemplate = resolvedName === undefined && ts.isTemplateExpression(nameArg);

				if (resolvedName !== undefined && indexNames.has(resolvedName)) {
					const requiredFields = schemaIndexes[resolvedName];
					const rangeArg = node.arguments[1];

					if (!rangeArg) {
						// A withIndex call whose first argument resolves to one of our
						// tracked unread indexes but supplies NO range-builder argument
						// at all is a full index walk — every field is unbound.
						matches.push({
							file,
							line: lineOf(sf, node),
							indexName: resolvedName,
							requiredFields,
							boundFields: [],
							missingFields: requiredFields,
							resolved: true,
							reason: "withIndex called with no range-builder argument (arguments.length < 2) — full index walk, all fields unbound",
						});
					} else {
						const resolved = resolveRangeBuilder(rangeArg, helperFns);
						const reason = resolved
							? undefined
							: `range-builder argument (kind=${ts.SyntaxKind[rangeArg.kind]}) is not a same-file-resolvable arrow/function, bare helper reference, or (curried) helper call — fail-closed`;

						if (resolved) {
							const { paramName, body } = resolved;
							const boundFields = collectBoundFields(body, paramName);
							const missingFields = requiredFields.filter((f) => !boundFields.has(f));
							matches.push({
								file,
								line: lineOf(sf, node),
								indexName: resolvedName,
								requiredFields,
								boundFields: [...boundFields],
								missingFields,
								resolved: true,
							});
						} else {
							matches.push({
								file,
								line: lineOf(sf, node),
								indexName: resolvedName,
								requiredFields,
								boundFields: [],
								missingFields: requiredFields,
								resolved: false,
								reason,
							});
						}
					}
				} else if (resolvedName === undefined) {
					// The index name could not be resolved to a string literal, a
					// no-substitution template literal, or a same-file const. Fail
					// closed (rather than silently skip as a NAMED GAP) when either:
					//   - it's a template literal WITH an interpolated value — a
					//     dynamically-built index name is itself suspicious on ANY
					//     table, or
					//   - the withIndex call's object chain provably reads
					//     `.query("messageReceipts")` — we know the table, so an
					//     unresolvable name here could still be one of our tracked
					//     unread indexes and we cannot rule that out.
					// Otherwise (unresolvable name, chain does NOT provably read
					// messageReceipts) this remains the pre-existing NAMED GAP: we
					// cannot tell if it's even relevant, so it's skipped.
					const onMessageReceiptsChain = chainHasMessageReceiptsQuery(node.expression.expression);
					if (isDynamicTemplate || onMessageReceiptsChain) {
						matches.push({
							file,
							line: lineOf(sf, node),
							indexName: nameArg.getText(sf),
							requiredFields: [],
							boundFields: [],
							missingFields: ["<unresolved index name>"],
							resolved: false,
							reason: isDynamicTemplate
								? "index name is a template literal with an interpolated (non-const) value — cannot statically resolve; fails closed regardless of table"
								: 'index name argument could not be resolved to a string literal, no-substitution template literal, or same-file const, and this withIndex call chains from query("messageReceipts") — fails closed because it could name a tracked unread index',
						});
					}
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(sf);
	}

	return { schemaIndexes, matches };
}
