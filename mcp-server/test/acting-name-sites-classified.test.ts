/**
 * Every place the acting-name token appears in the MCP server's production
 * sources is classified through the TypeScript AST (test/lib/actingNameAst.ts),
 * and there is no exemption list, no allow-list file.
 *
 * task k173ny6as0gsq996xtbtzn5rjd8fbj9m, reworked in k17dbtczxy047kav3qtxx1dpe18fbzf5.
 *
 * `callerOrchestrator` stopped being an authority: defineTool (registerTool.ts)
 * binds it to the credential-resolved actor for EVERY tool whose schema
 * declares it. What is left at a site is one of six classes (see the helper's
 * header for the exact syntactic definition of each): scope-decl, schema-decl,
 * guard, prose, use, mechanism. A site that fits none is a BLOCK and fails the
 * suite.
 *
 * WHY AST, not regex. The first version classified lines by regex and was
 * blind in both directions. Measured before this rewrite, by appending to
 * src/tools.ts
 *
 *     const _probeA = { callerOrchestrator: "system" };
 *     const _probeB = { callerOrchestrator: _probeA };
 *
 * and running the old suite: 4 passed of 4, green with both hostile shapes
 * present. The reviewer found the same independently: a literal-valued
 * `{ callerOrchestrator: "system" }` classified as prose (a quoted string on
 * the line), and `{ callerOrchestrator: <raw value> }` classified as use (the
 * token followed by `:`). The MUST_BLOCK table below pins each, with its
 * origin, and the "real tools.ts + hostile shape" cases prove the suite goes
 * RED on the real file, not just on a toy fixture.
 *
 * SECOND REVISE (same PR): the classifier never read a BindingElement's
 * `initializer`, so `async ({ callerOrchestrator = "system" })` was a plain
 * `use` (measured on src/tools.ts:4629: 23/23 green). This shape does NOT
 * exist in the source today; it is a latent gap in the instrument. It matters
 * because in permissive mode an organisation-only caller OMITS the name, and a
 * handler with such a default would forward the literal "system". The sweep of
 * the neighbourhood (every grammar position that carries a default, plus every
 * assignment operator) found the gap wider than the one shape: every WRITE to
 * the args binding was also a `use`. Each position is a MUST_BLOCK row below,
 * with its origin.
 *
 * SCOPE OF THE SCAN (stated, not implied): every .ts under src/ except
 * __tests__ and *.test.ts (tests legitimately type mismatching names), plus
 * the entry points server.ts and server-http.ts. api.ts (the generated
 * Convex type mirror) is checked separately: it may carry the token only as a
 * TYPE MEMBER, never in a value position.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { analyse, type Site, tally } from "./lib/actingNameAst.js";

const ROOT = join(__dirname, "..");

function productionSources(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) {
			if (entry !== "__tests__") productionSources(p, out);
		} else if (
			/\.(ts|tsx|mts|cts)$/.test(entry) &&
			!/\.test\.ts$/.test(entry)
		) {
			out.push(p);
		}
	}
	return out;
}

function loadReal(): Record<string, string> {
	const files: Record<string, string> = {};
	const paths = [
		...productionSources(join(ROOT, "src")),
		join(ROOT, "server.ts"),
		join(ROOT, "server-http.ts"),
	];
	for (const p of paths) files[relative(ROOT, p)] = readFileSync(p, "utf8");
	return files;
}

const REAL = loadReal();
const SITES = analyse(REAL);
const blocked = (sites: readonly Site[]): Site[] =>
	sites.filter((s) => s.cls === null);
const where = (s: Site): string =>
	`${s.file}:${s.line}  ${s.reason}  | ${s.text}`;

describe("callerOrchestrator sites — every one classified through the AST, every declaration annotated", () => {
	it("finds the sites it is supposed to (the count is a measurement, printed on failure)", () => {
		expect(SITES.length).toBeGreaterThan(100);
	});

	it("EVERY class is exercised by the real sources (a degenerate classifier that collapses everything into one class is caught)", () => {
		const counts = tally(SITES);
		for (const cls of [
			"scope-decl",
			"schema-decl",
			"guard",
			"prose",
			"use",
			"mechanism",
		]) {
			expect(
				counts[cls] ?? 0,
				`class ${cls} in ${JSON.stringify(counts)}`,
			).toBeGreaterThan(0);
		}
	});

	it("EVERY site fits a documented class; none is left BLOCKED", () => {
		expect(blocked(SITES).map(where)).toEqual([]);
	});

	it("EVERY schema declaration carries an ACTING-NAME comment on the line above", () => {
		const bare = SITES.filter((s) => s.cls === "schema-decl")
			.filter((s) => !s.prev.includes("// ACTING-NAME:"))
			.map((s) => `${s.file}:${s.line}`);
		expect(bare).toEqual([]);
	});

	it("outside tools.ts the only sites are the wrapper's own: registerTool.ts (mechanism, or its prose) — nothing in auth.ts, nothing in the entry points", () => {
		const outside = SITES.filter((s) => s.file !== "src/tools.ts");
		expect(
			outside.filter((s) => s.file !== "src/registerTool.ts").map(where),
		).toEqual([]);
		expect(
			outside
				.filter((s) => s.cls !== "mechanism" && s.cls !== "prose")
				.map(where),
		).toEqual([]);
	});

	it("api.ts (the generated Convex type mirror) carries the token only as a TYPE MEMBER", () => {
		const api = analyse({
			"api.ts": readFileSync(join(ROOT, "api.ts"), "utf8"),
		});
		expect(api.length).toBeGreaterThan(0);
		expect(
			api
				.filter((s) => !/declares a binding or member/.test(s.reason))
				.map(where),
		).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// MUST_BLOCK — shapes the classifier is required to REFUSE. Each carries its
// origin so a later reader knows why the case exists. Adding a case here needs
// no change to the classifier's allow-side: a new hostile shape is one row.
// ─────────────────────────────────────────────────────────────────────────────

const PRELUDE =
	"declare const defineTool: any; declare const server: any; declare const ctx: any;\n" +
	"declare const guardFrom: any; declare const convex: any; declare const somethingElse: any;\n";

/** Source with `body` inside a real defineTool handler destructuring the acting name. */
const inHandler = (body: string): string =>
	`${PRELUDE}defineTool(server, ctx, { kind: "public", reason: "fixture" }, "t", "d", {}, ` +
	`async ({ taskId, callerOrchestrator }: any) => {\n${body}\n});\n`;

/** A real defineTool handler with an arbitrary parameter list. */
const withParams = (params: string, body: string): string =>
	`${PRELUDE}defineTool(server, ctx, { kind: "public", reason: "fixture" }, "t", "d", {}, ` +
	`async (${params}) => {\n${body}\n});\n`;

const ARGS = "{ taskId, callerOrchestrator }: any";
/** The source text of a template literal that assembles "system" from pieces. */
const SYS_TEMPLATE = `\`sys$${"{"}"tem"}\``;
const DEFAULTED = /default-initializer/;
const WRITTEN = /write-target/;

type MustBlock = {
	name: string;
	origin: string;
	source: string;
	reason: RegExp;
};

const MUST_BLOCK: MustBlock[] = [
	{
		name: "literal-valued acting name",
		origin:
			'reviewer, PR #1355 REVISE: `{ callerOrchestrator: "system" }` inside a mutation call classified as PROSE (a quote on the line). Also the first appended probe, measured 4/4 green.',
		source: `${PRELUDE}const _probeA = { callerOrchestrator: "system" };\n`,
		reason: /does not flow from the bound args \(StringLiteral\)/,
	},
	{
		name: "raw value forwarded as the acting name",
		origin:
			"reviewer, PR #1355 REVISE: `{ callerOrchestrator: <raw value> }` classified as USE (token followed by `:`). Also the second appended probe, measured 4/4 green.",
		source:
			`${PRELUDE}const _probeA = { callerOrchestrator: "system" };\n` +
			"const _probeB = { callerOrchestrator: _probeA };\n",
		reason: /does not flow from the bound args \(Identifier\)/,
	},
	{
		name: "literal inside a mutation call, in a real handler",
		origin:
			"same reviewer finding, at the site the reviewer named: a mutation call in a handler.",
		source: inHandler(
			'await convex.mutation("tasks:complete", { taskId, callerOrchestrator: "system" });',
		),
		reason: /does not flow from the bound args \(StringLiteral\)/,
	},
	{
		name: "raw value inside a mutation call, in a real handler",
		origin:
			"same reviewer finding, USE side: a value that never came from the args.",
		source: inHandler(
			'await convex.mutation("tasks:complete", { taskId, callerOrchestrator: somethingElse });',
		),
		reason: /does not flow from the bound args \(Identifier\)/,
	},
	{
		name: "same-named local that shadows the bound args' value",
		origin:
			"AST rationale: a regex sees `guardFrom(callerOrchestrator)` and calls it a guard; the symbol is a local literal, not the actor.",
		source: inHandler(
			'const callerOrchestrator = "system"; guardFrom(callerOrchestrator);',
		),
		reason: /declares a binding or member|does NOT resolve to the bound args/,
	},
	{
		name: "acting name destructured from something that is not the bound args",
		origin:
			"AST rationale: `use` means flows from the bound args, not any occurrence of the token.",
		source: inHandler(
			"const { callerOrchestrator: c } = somethingElse; return c;",
		),
		reason: /destructures the acting name from something other than/,
	},
	{
		name: "another key rebound under the acting-name spelling",
		origin:
			"AST rationale: `{ createdBy: callerOrchestrator }` style aliasing swaps which claim is the actor.",
		source: inHandler(
			"const { taskId: callerOrchestrator } = somethingElse; return callerOrchestrator;",
		),
		reason: /another key is rebound under the acting-name spelling/,
	},
	{
		name: "assignment of a foreign value to an acting-name property",
		origin:
			"AST rationale: `updateArgs.callerOrchestrator = <x>` is a real shape in tools.ts; only the args' value may go there.",
		source: inHandler('const a: any = {}; a.callerOrchestrator = "system";'),
		reason: /assigns an acting name that does not flow from the bound args/,
	},
	{
		name: "acting name read off an object that is not the bound args",
		origin:
			"AST rationale: property read from an arbitrary object is not the actor.",
		source: inHandler("return somethingElse.callerOrchestrator;"),
		reason: /read off an object that is not the bound args/,
	},
	{
		name: "bare token used as a computed / element key",
		origin:
			"AST rationale: a whole-literal key is a read/write path no flow analysis follows; a string is prose only when it MENTIONS the token.",
		source: inHandler('return { ["callerOrchestrator"]: "system" };'),
		reason: /key-literal/,
	},
	{
		name: "bare token used as an element access",
		origin:
			'AST rationale: as above, on the read side (`args["callerOrchestrator"]`).',
		source: inHandler('return somethingElse["callerOrchestrator"];'),
		reason: /key-literal/,
	},
	{
		name: "zod-looking value outside any tool schema",
		origin:
			"AST rationale: schema-decl is a parameter DECLARATION inside a defineTool schema or z.object; a zod lookalike elsewhere is not one.",
		source: `${PRELUDE}declare const z: any;\nconst notASchema = { callerOrchestrator: z.string() };\n`,
		reason: /does not flow from the bound args \(CallExpression\)/,
	},

	// ── PR #1355 second REVISE: positions where a value reaches the acting-name
	// binding WITHOUT flowing from the bound args. The AST classifier never read a
	// BindingElement's `initializer`, so `({ callerOrchestrator = "system" })` was
	// classified `use` (measured on the real src/tools.ts:4629, 23/23 green). The
	// rows below are the neighbourhood sweep, enumerated from the grammar
	// (`readonly initializer` / `objectAssignmentInitializer` in typescript.d.ts,
	// plus the assignment operators FirstAssignment..LastAssignment).
	{
		name: "default on the destructured acting name (handler parameter)",
		origin:
			'reviewer + lead, PR #1355 2nd REVISE: `async ({ callerOrchestrator = "system" })` — in permissive mode an organisation-only caller OMITS the name and the default would forward the most privileged name. Measured green before the fix. LATENT: no such site exists in src/tools.ts.',
		source: withParams(
			'{ taskId, callerOrchestrator = "system" }: any',
			"return guardFrom(callerOrchestrator);",
		),
		reason: DEFAULTED,
	},
	{
		name: "default on the acting name, aliased ({ callerOrchestrator: c = ... })",
		origin:
			"sweep of the same position: the KEY is the token, the bound name is not, so no later reference carries the token spelling and only the key can be judged.",
		source: withParams(
			'{ callerOrchestrator: c = "system" }: any',
			"return c;",
		),
		reason: DEFAULTED,
	},
	{
		name: "default on the acting name in `const { ... } = args`",
		origin:
			"sweep: the second declaration form isArgsBinding accepts (destructuring the args inside the handler).",
		source: withParams(
			"args: any",
			'const { callerOrchestrator = "system" } = args; return guardFrom(callerOrchestrator);',
		),
		reason: DEFAULTED,
	},
	{
		name: "NON-literal default on the acting name",
		origin:
			"sweep: `= DEFAULT_ACTOR` / `= fn()` supply a value from outside the args exactly as a literal does; a literal-only rule would be the half-closed form.",
		source: withParams(
			"{ callerOrchestrator = somethingElse }: any",
			"return guardFrom(callerOrchestrator);",
		),
		reason: DEFAULTED,
	},
	{
		name: "default at ANY nesting depth of the pattern",
		origin:
			"sweep: `({ opts: { callerOrchestrator = ... } })` — nested patterns were already refused (not the handler's own args); pinned so the depth is never loosened without this row going red.",
		source: withParams(
			'{ opts: { callerOrchestrator = "system" } }: any',
			"return callerOrchestrator;",
		),
		reason: DEFAULTED,
	},
	{
		name: "default on the handler's own destructured parameter",
		origin:
			"sweep: `async ({ callerOrchestrator } = DEFAULTS)` supplies the WHOLE args object; no token is spelled in the default, so only the parameter's initializer betrays it (measured green before the fix).",
		source: withParams(
			"{ callerOrchestrator }: any = somethingElse",
			"return guardFrom(callerOrchestrator);",
		),
		reason: DEFAULTED,
	},
	{
		name: "default on a plain `args` handler parameter",
		origin:
			"sweep: `async (args = fallback) => args.callerOrchestrator` — the read is off a parameter that may be the default, not the bound args (measured green before the fix).",
		source: withParams(
			"args: any = somethingElse",
			"return args.callerOrchestrator;",
		),
		reason: /read off an object that is not the bound args/,
	},
	{
		name: "default on a NON-handler function parameter",
		origin:
			"sweep: `function f(callerOrchestrator = ...)` — refused as a declaration outside the bound args; pinned as part of the sweep.",
		source: `${PRELUDE}function f(callerOrchestrator = "system") { return callerOrchestrator; }\n`,
		reason: /declares a binding or member/,
	},
	{
		name: "default inside a destructuring ASSIGNMENT ({ callerOrchestrator = d } = o)",
		origin:
			"sweep: the assignment-pattern default is a ShorthandPropertyAssignment.objectAssignmentInitializer, a different node from BindingElement.initializer (measured green before the fix).",
		source: withParams(
			ARGS,
			'({ callerOrchestrator = "system" } = somethingElse); return callerOrchestrator;',
		),
		reason: DEFAULTED,
	},
	{
		name: "default on the key of a destructuring-assignment target ({ x: token = d } = o)",
		origin:
			"sweep: the assignment-pattern default in its `key: target = default` form (measured green before the fix).",
		source: withParams(
			ARGS,
			'({ x: callerOrchestrator = "system" } = somethingElse); return callerOrchestrator;',
		),
		reason: WRITTEN,
	},
	{
		name: "plain reassignment of the args binding",
		origin:
			'sweep: `callerOrchestrator = "system"` resolves to the args binding, so the old reference rule called it a `use` (measured green before the fix). Found by the sweep, wider than the reported shape.',
		source: withParams(
			ARGS,
			'callerOrchestrator = "system"; return guardFrom(callerOrchestrator);',
		),
		reason: WRITTEN,
	},
	{
		name: "`??=` on the args binding",
		origin:
			"sweep: the compound-assignment form of the same default (`x ??= d`) — the omission-to-default conversion, spelled as an operator.",
		source: withParams(
			ARGS,
			'callerOrchestrator ??= "system"; return callerOrchestrator;',
		),
		reason: WRITTEN,
	},
	{
		name: "`||=` on the args binding",
		origin: "sweep: as above, the falsy-default operator.",
		source: withParams(
			ARGS,
			'callerOrchestrator ||= "system"; return callerOrchestrator;',
		),
		reason: WRITTEN,
	},
	{
		name: "`+=` on the args binding",
		origin:
			"sweep: any operator in FirstAssignment..LastAssignment is a write; `+=` stands for the arithmetic ones.",
		source: withParams(
			ARGS,
			'callerOrchestrator += "x"; return callerOrchestrator;',
		),
		reason: WRITTEN,
	},
	{
		name: "`++` on the args binding",
		origin: "sweep: prefix/postfix ++/-- are writes too.",
		source: withParams(
			ARGS,
			"callerOrchestrator++; return callerOrchestrator;",
		),
		reason: WRITTEN,
	},
	{
		name: "the args binding as an object destructuring-assignment target",
		origin: "sweep: `({ x: callerOrchestrator } = o)` writes the binding.",
		source: withParams(
			ARGS,
			"({ x: callerOrchestrator } = somethingElse); return callerOrchestrator;",
		),
		reason: WRITTEN,
	},
	{
		name: "the args binding as a shorthand destructuring-assignment target",
		origin: "sweep: `({ callerOrchestrator } = o)` with no default.",
		source: withParams(
			ARGS,
			"({ callerOrchestrator } = somethingElse); return callerOrchestrator;",
		),
		reason: WRITTEN,
	},
	{
		name: "the args binding as an array destructuring-assignment target",
		origin: "sweep: `[callerOrchestrator] = arr`.",
		source: withParams(
			ARGS,
			'[callerOrchestrator] = ["system"]; return callerOrchestrator;',
		),
		reason: WRITTEN,
	},
	{
		name: "the args binding as an array target with a default",
		origin: "sweep: `[callerOrchestrator = d] = arr`.",
		source: withParams(
			ARGS,
			'[callerOrchestrator = "system"] = []; return callerOrchestrator;',
		),
		reason: WRITTEN,
	},
	{
		name: "the args binding as a rest target",
		origin: "sweep: `[...callerOrchestrator] = arr`.",
		source: withParams(
			ARGS,
			'[...callerOrchestrator] = ["system"]; return callerOrchestrator;',
		),
		reason: WRITTEN,
	},
	{
		name: "the args binding as a for-of target",
		origin: "sweep: `for (callerOrchestrator of xs)`.",
		source: withParams(
			ARGS,
			'for (callerOrchestrator of ["system"]) {} return callerOrchestrator;',
		),
		reason: WRITTEN,
	},
	{
		name: "the args binding as a for-in target",
		origin: "sweep: `for (callerOrchestrator in o)`.",
		source: withParams(
			ARGS,
			"for (callerOrchestrator in { system: 1 }) {} return callerOrchestrator;",
		),
		reason: WRITTEN,
	},
	{
		name: "write through an `as` wrapper",
		origin:
			"sweep, split after a surviving mutant: `(callerOrchestrator as any) = d` is a legal TS target. A wrapper on the target is transparent to the write check; one row per wrapper so removing ONE transparency cannot hide behind another line.",
		source: withParams(
			ARGS,
			'(callerOrchestrator as any) = "system"; return callerOrchestrator;',
		),
		reason: WRITTEN,
	},
	{
		name: "write through a non-null `!` wrapper",
		origin:
			"sweep, split after a surviving mutant: `callerOrchestrator! = d` is a legal TS target. A wrapper on the target is transparent to the write check; one row per wrapper so removing ONE transparency cannot hide behind another line.",
		source: withParams(
			ARGS,
			'callerOrchestrator! = "system"; return callerOrchestrator;',
		),
		reason: WRITTEN,
	},
	{
		name: "write through a `satisfies` wrapper",
		origin:
			"sweep, split after a surviving mutant: `(callerOrchestrator satisfies any) = d` is a legal TS target. A wrapper on the target is transparent to the write check; one row per wrapper so removing ONE transparency cannot hide behind another line.",
		source: withParams(
			ARGS,
			'(callerOrchestrator satisfies any) = "system"; return callerOrchestrator;',
		),
		reason: WRITTEN,
	},
	{
		name: "write through an angle-bracket assertion",
		origin:
			"sweep, split after a surviving mutant: `(<any>callerOrchestrator) = d` is a legal TS target in a .ts file. A wrapper on the target is transparent to the write check; one row per wrapper so removing ONE transparency cannot hide behind another line.",
		source: withParams(
			ARGS,
			'(<any>callerOrchestrator) = "system"; return callerOrchestrator;',
		),
		reason: WRITTEN,
	},
	{
		name: "write through a parenthesised property target",
		origin:
			'sweep: `(args.callerOrchestrator) = "system"` — the old rule required the assignment to be the direct parent, so parentheses slipped it to `read off the bound args`.',
		source: withParams(
			"args: any",
			'(args.callerOrchestrator) = "system"; return args.callerOrchestrator;',
		),
		reason: /assigns an acting name that does not flow from the bound args/,
	},
	{
		name: "compound assignment on the args object's property",
		origin:
			'sweep: `args.callerOrchestrator ??= "system"` — the old rule only looked at `=`, so every compound operator on the property was a `use`.',
		source: withParams(
			"args: any",
			'args.callerOrchestrator ??= "system"; return args.callerOrchestrator;',
		),
		reason: WRITTEN,
	},
	{
		name: "the args object's property as a destructuring-assignment target",
		origin:
			"sweep: `[args.callerOrchestrator] = arr`, `({ x: args.token } = o)`.",
		source: withParams(
			"args: any",
			'[args.callerOrchestrator] = ["system"]; ({ x: args.callerOrchestrator } = somethingElse); return 1;',
		),
		reason: WRITTEN,
	},
	{
		name: "a default inside a pattern whose default IS the args' value",
		origin:
			"sweep: `[a.callerOrchestrator = args.callerOrchestrator] = [x]` — the default looks honest but the element `x` wins when present; a plain `=` inside a pattern is not a plain assignment.",
		source: withParams(
			"args: any",
			"const a: any = {}; [a.callerOrchestrator = args.callerOrchestrator] = [somethingElse]; return a;",
		),
		reason: WRITTEN,
	},
	{
		name: "the args parameter is reassigned, then read",
		origin:
			"sweep: `args = other; args.callerOrchestrator` — the parameter no longer IS the bound args after a write to it.",
		source: withParams(
			"args: any",
			"args = somethingElse; return args.callerOrchestrator;",
		),
		reason: /read off an object that is not the bound args/,
	},
	{
		name: "the args parameter is reassigned, then destructured",
		origin: "sweep: same, on the `const { token } = args` side.",
		source: withParams(
			"args: any",
			"args = somethingElse; const { callerOrchestrator } = args; return guardFrom(callerOrchestrator);",
		),
		reason: /destructures the acting name from something other than/,
	},

	// ── positive controls: the two siblings the reviewer confirmed RED. They are
	// here so a later reader sees the neighbourhood was swept, and so a fix that
	// closes one shape while quietly reopening another turns THIS file red.
	{
		name: "SIBLING (already RED): a template that builds the literal",
		origin:
			"reviewer, PR #1355 2nd REVISE: a template literal assembling the name from pieces (sys + tem) as the forwarded value was confirmed RED; kept as a positive control for the initializer fix.",
		source: withParams(
			ARGS,
			`return convex.mutation("t", { taskId, callerOrchestrator: ${SYS_TEMPLATE} });`,
		),
		reason: /does not flow from the bound args/,
	},
	{
		name: 'SIBLING (already RED): `callerOrchestrator ?? "system"`',
		origin:
			"reviewer, PR #1355 2nd REVISE: the nullish default in a forwarded property was confirmed RED; the destructuring default is its binding-side twin.",
		source: withParams(
			ARGS,
			'return convex.mutation("t", { taskId, callerOrchestrator: callerOrchestrator ?? "system" });',
		),
		reason: /does not flow from the bound args/,
	},
];

const MUST_PASS: {
	name: string;
	source: string;
	expect: Record<string, number>;
}[] = [
	{
		name: "the honest handler: destructure, guard, forward, spread-forward",
		source: inHandler(
			"const denied = guardFrom(callerOrchestrator);\n" +
				'await convex.mutation("tasks:complete", { taskId, callerOrchestrator });\n' +
				'await convex.mutation("tasks:complete", { taskId, ...(callerOrchestrator ? { callerOrchestrator } : {}) });\n' +
				'await convex.mutation("tasks:complete", { taskId, callerOrchestrator: callerOrchestrator });\n' +
				"return denied;",
		),
		expect: { use: 6, guard: 1 },
	},
	{
		name: "the write and default refusals are not a blanket: reading, forwarding, and assigning the args' value onto another object stay classified",
		source: withParams(
			"args: any",
			"const a: any = {}; a.callerOrchestrator = args.callerOrchestrator;\n" +
				"const { callerOrchestrator } = args; const o = { x: callerOrchestrator, ...{ callerOrchestrator } };\n" +
				"const [q] = [callerOrchestrator]; return [a, o, q, guardFrom(callerOrchestrator)];",
		),
		expect: { use: 6, guard: 1 },
	},
	{
		name: "a function-expression handler is a handler too",
		source: `${PRELUDE}defineTool(server, ctx, { kind: "public", reason: "fixture" }, "t", "d", {}, async function ({ callerOrchestrator }: any) { return guardFrom(callerOrchestrator); });\n`,
		expect: { use: 1, guard: 1 },
	},
	{
		name: "prose: a comment and strings that merely mention the token",
		source:
			`${PRELUDE}// callerOrchestrator is a claim\n` +
			"const d = \"EXAMPLE: complete_task callerOrchestrator='beta'\";\n" +
			"const t = `use callerOrchestrator $" +
			"{1} here`;\n",
		expect: { prose: 3 },
	},
];

describe("MUST_BLOCK — the classifier refuses each hostile shape, with the reason it exists", () => {
	for (const c of MUST_BLOCK) {
		it(`${c.name}  [origin: ${c.origin}]`, () => {
			const b = blocked(analyse({ "src/fixture.ts": c.source }));
			expect(b.length, `nothing blocked for: ${c.name}`).toBeGreaterThan(0);
			expect(
				b.some((s) => c.reason.test(s.reason)),
				`reasons: ${b.map((s) => s.reason).join(" || ")}`,
			).toBe(true);
		});
	}
});

describe("MUST_PASS — the honest shapes stay classified (the refusals are not a blanket)", () => {
	for (const c of MUST_PASS) {
		it(c.name, () => {
			const sites = analyse({ "src/fixture.ts": c.source });
			expect(blocked(sites).map(where)).toEqual([]);
			expect(tally(sites)).toEqual(c.expect);
		});
	}
});

describe("the REAL tools.ts, with each hostile shape appended, is refused (the suite goes RED on the real file)", () => {
	const real = REAL["src/tools.ts"];
	const shapes: Record<string, string> = {
		"literal-valued": '\nconst _probeA = { callerOrchestrator: "system" };\n',
		"raw-value":
			'\nconst _probeA = { callerOrchestrator: "system" };\nconst _probeB = { callerOrchestrator: _probeA };\n',
	};
	for (const [name, tail] of Object.entries(shapes)) {
		it(`${name} shape appended to src/tools.ts`, () => {
			expect(real).toBeDefined();
			const sites = analyse({ ...REAL, "src/tools.ts": real + tail });
			expect(blocked(sites).length).toBeGreaterThan(0);
			// and nothing else moved: the only blocks are the appended lines
			const baseline = blocked(SITES).length;
			expect(blocked(sites).length).toBeGreaterThan(baseline);
		});
	}

	// The shapes below are injected AT a real handler (tools.ts complete_task),
	// not appended: the binding is the real one, so this is the exact edit a
	// hostile or careless change would make. The suite must name file, line, shape.
	const HEADER = "async ({ taskId, completionNote, callerOrchestrator }) => {";
	/** 1-based number of the first line where `b` differs from `a`. */
	const firstDiffLine = (a: string, b: string): number => {
		const x = a.split("\n");
		const y = b.split("\n");
		const i = y.findIndex((l, k) => l !== x[k]);
		return i + 1;
	};
	const atSite: Record<string, { edit: (t: string) => string; shape: RegExp }> =
		{
			"a default on the destructured name (the latent shape)": {
				edit: (t) =>
					t.replace(
						HEADER,
						'async ({ taskId, completionNote, callerOrchestrator = "system" }) => {',
					),
				shape: DEFAULTED,
			},
			"a non-literal default on the destructured name": {
				edit: (t) =>
					t.replace(
						HEADER,
						"async ({ taskId, completionNote, callerOrchestrator = taskId }) => {",
					),
				shape: DEFAULTED,
			},
			"a default on the handler's whole parameter": {
				edit: (t) =>
					t.replace(
						HEADER,
						"async ({ taskId, completionNote, callerOrchestrator } = {} as any) => {",
					),
				shape: DEFAULTED,
			},
			"a reassignment of the destructured name": {
				edit: (t) =>
					t.replace(HEADER, `${HEADER}\n\t\t\tcallerOrchestrator = "system";`),
				shape: WRITTEN,
			},
			"a `??=` default on the destructured name": {
				edit: (t) =>
					t.replace(
						HEADER,
						`${HEADER}\n\t\t\tcallerOrchestrator ??= "system";`,
					),
				shape: WRITTEN,
			},
			"SIBLING: a nullish default at the forwarding site": {
				edit: (t) =>
					t.replace(
						"\t\t\t\t\tcompletionNote,\n\t\t\t\t\tcallerOrchestrator,\n",
						'\t\t\t\t\tcompletionNote,\n\t\t\t\t\tcallerOrchestrator: callerOrchestrator ?? "system",\n',
					),
				shape: /does not flow from the bound args/,
			},
			"SIBLING: a template that assembles the literal at the forwarding site": {
				edit: (t) =>
					t.replace(
						"\t\t\t\t\tcompletionNote,\n\t\t\t\t\tcallerOrchestrator,\n",
						`\t\t\t\t\tcompletionNote,\n\t\t\t\t\tcallerOrchestrator: ${SYS_TEMPLATE},\n`,
					),
				shape: /does not flow from the bound args/,
			},
		};
	for (const [name, c] of Object.entries(atSite)) {
		it(`injected at the real complete_task handler: ${name}`, () => {
			expect(real.split(HEADER).length - 1, "anchor occurs once").toBe(1);
			const mutated = c.edit(real);
			expect(mutated, "the edit landed").not.toBe(real);
			const b = blocked(analyse({ ...REAL, "src/tools.ts": mutated }));
			expect(b.length).toBeGreaterThan(blocked(SITES).length);
			const hit = b.find((s) => c.shape.test(s.reason));
			expect(hit, `blocked: ${b.map(where).join(" || ")}`).toBeDefined();
			expect(hit?.file).toBe("src/tools.ts");
			// the block names the injected line, not some other place in the file
			expect(hit?.line, where(hit as Site)).toBe(firstDiffLine(real, mutated));
		});
	}

	it("the same shapes appended to registerTool.ts (the file the old classifier exempted BY NAME) are refused too", () => {
		const rt = REAL["src/registerTool.ts"];
		const sites = analyse({
			...REAL,
			"src/registerTool.ts": `${rt}\nconst _p = { callerOrchestrator: "system" };\n`,
		});
		expect(blocked(sites).length).toBeGreaterThan(0);
	});
});
