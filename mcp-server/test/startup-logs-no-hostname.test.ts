/**
 * HTTP startup logs carry only allow-listed interpolations.
 * VantagePeers Cloud and Self-host. mcp-doctor DServer6 (C-6: never log
 * internal system detail). Task k170z6dkshhs6kycqtjdjxkmd98jwb6g.
 *
 * Class: any value reaching a `[vantage-peers-mcp]` console call that is not
 * a pinned expression. The domain is derived from the file itself with the
 * TypeScript compiler API (every console.* call whose first argument starts
 * with the tag; every argument of such a call; every `${...}` span of a
 * template). The guard is an ALLOW-LIST, so any form that reaches the log
 * (property access, element access, destructured identifier, call,
 * concatenation, extra non-literal argument) fails by default, naming the
 * expression. Nothing is skipped silently: an argument kind the guard does
 * not know how to read is reported as a violation.
 *
 * Second guard, keyed on the BINDING rather than on message spelling: the
 * `Bun.serve(...)` result is bound once, and every reference to that
 * identifier in its scope other than the member access `<binding>.port` is a
 * violation, wherever it flows (a variable, a differently tagged or untagged
 * log, an alias, a destructuring, a call argument, a spread, element access).
 * Aliases are not followed: any non-`.port` reference is itself the violation.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, "../server-http.ts");
const source = readFileSync(file, "utf8");
const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

const TAG = "[vantage-peers-mcp]";
const CONSOLE_METHODS = new Set(["log", "info", "warn", "error", "debug"]);

/**
 * Allow-list: the only expressions that may be interpolated into a tagged
 * startup log. `server.port` is the port Bun bound (server-http.ts, the
 * "HTTP transport listening" line). Adding an entry is a reviewed decision.
 */
const ALLOWED_INTERPOLATIONS = new Set(["server.port"]);

interface Call {
	node: ts.CallExpression;
	line: number;
	text: string;
}

function lineOf(node: ts.Node): number {
	return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function taggedConsoleCalls(): Call[] {
	const out: Call[] = [];
	const visit = (n: ts.Node): void => {
		if (
			ts.isCallExpression(n) &&
			ts.isPropertyAccessExpression(n.expression) &&
			ts.isIdentifier(n.expression.expression) &&
			n.expression.expression.text === "console" &&
			CONSOLE_METHODS.has(n.expression.name.text) &&
			n.arguments.length > 0 &&
			n.arguments[0]
				.getText(sf)
				.replace(/^["'`]/, "")
				.startsWith(TAG)
		) {
			out.push({ node: n, line: lineOf(n), text: n.getText(sf) });
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return out;
}

/** Violations: the source text of every expression not on the allow-list. */
function violations(call: ts.CallExpression): string[] {
	const bad: string[] = [];
	for (const arg of call.arguments) {
		if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
			continue;
		}
		if (ts.isTemplateExpression(arg)) {
			for (const span of arg.templateSpans) {
				const expr = span.expression.getText(sf);
				if (!ALLOWED_INTERPOLATIONS.has(expr)) {
					bad.push(`line ${lineOf(span.expression)}: \${${expr}}`);
				}
			}
			continue;
		}
		bad.push(`line ${lineOf(arg)}: non-literal argument ${arg.getText(sf)}`);
	}
	return bad;
}

/** The one Bun.serve binding: found on the syntax tree, loud on 0 or many. */
function bunServeBinding(): ts.VariableDeclaration {
	const found: ts.VariableDeclaration[] = [];
	const visit = (n: ts.Node): void => {
		if (
			ts.isVariableDeclaration(n) &&
			n.initializer !== undefined &&
			ts.isCallExpression(n.initializer) &&
			ts.isPropertyAccessExpression(n.initializer.expression) &&
			ts.isIdentifier(n.initializer.expression.expression) &&
			n.initializer.expression.expression.text === "Bun" &&
			n.initializer.expression.name.text === "serve"
		) {
			found.push(n);
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
	// Also any Bun.serve(...) call that is NOT the initializer of a binding.
	let calls = 0;
	const count = (n: ts.Node): void => {
		if (
			ts.isCallExpression(n) &&
			ts.isPropertyAccessExpression(n.expression) &&
			ts.isIdentifier(n.expression.expression) &&
			n.expression.expression.text === "Bun" &&
			n.expression.name.text === "serve"
		) {
			calls++;
		}
		ts.forEachChild(n, count);
	};
	count(sf);
	if (found.length !== 1 || calls !== 1 || !ts.isIdentifier(found[0].name)) {
		throw new Error(
			`expected exactly one \`const <identifier> = Bun.serve(...)\` binding and one Bun.serve call; found ${found.length} binding(s), ${calls} call(s)`,
		);
	}
	return found[0];
}

/** Every reference to the binding in its scope, other than the declaration. */
function bindingReferences(decl: ts.VariableDeclaration): ts.Identifier[] {
	const name = (decl.name as ts.Identifier).text;
	let scope: ts.Node = decl;
	while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) {
		scope = scope.parent;
	}
	const refs: ts.Identifier[] = [];
	const visit = (n: ts.Node): void => {
		if (ts.isIdentifier(n) && n.text === name && n !== decl.name) {
			const p = n.parent;
			const isMemberName = ts.isPropertyAccessExpression(p) && p.name === n;
			const isKey =
				(ts.isPropertyAssignment(p) && p.name === n) ||
				(ts.isBindingElement(p) && p.propertyName === n);
			if (!isMemberName && !isKey) refs.push(n);
		}
		ts.forEachChild(n, visit);
	};
	visit(scope);
	return refs;
}

function bindingViolations(): string[] {
	return bindingReferences(bunServeBinding())
		.filter((id) => {
			const p = id.parent;
			return !(
				ts.isPropertyAccessExpression(p) &&
				p.expression === id &&
				p.name.text === "port"
			);
		})
		.map(
			(id) =>
				`${file}:${lineOf(id)}: ${id.parent.getText(sf)} (only \`${id.text}.port\` may reference the Bun.serve binding)`,
		);
}

describe("server-http Bun.serve binding", () => {
	it("is found exactly once and only .port is referenced (positive pin)", () => {
		const refs = bindingReferences(bunServeBinding()).map((id) =>
			id.parent.getText(sf),
		);
		expect(refs).toEqual(["server.port"]);
	});

	it("no reference to the binding other than .port", () => {
		expect(bindingViolations()).toEqual([]);
	});
});

describe("server-http startup logs", () => {
	const calls = taggedConsoleCalls();

	it("positive control: the exact startup lines are found and pinned", () => {
		expect(
			calls.map((c) => c.node.arguments.map((a) => a.getText(sf)).join(", ")),
		).toEqual([
			"`[vantage-peers-mcp] HTTP transport listening on port ${server.port}`",
			"`[vantage-peers-mcp] Health: /health`",
			"`[vantage-peers-mcp] MCP:    /mcp`",
		]);
	});

	it("every interpolation in a tagged console call is allow-listed", () => {
		const offenders = calls.flatMap((c) => violations(c.node));
		expect(offenders).toEqual([]);
	});

	it("allow-list entries are all in use (no dead entry widens the guard)", () => {
		const used = new Set<string>();
		for (const c of calls) {
			for (const arg of c.node.arguments) {
				if (ts.isTemplateExpression(arg)) {
					for (const s of arg.templateSpans) used.add(s.expression.getText(sf));
				}
			}
		}
		expect([...ALLOWED_INTERPOLATIONS].sort()).toEqual([...used].sort());
	});
});
