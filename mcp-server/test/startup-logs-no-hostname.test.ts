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
