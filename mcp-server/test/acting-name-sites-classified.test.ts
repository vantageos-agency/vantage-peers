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

	it("the same shapes appended to registerTool.ts (the file the old classifier exempted BY NAME) are refused too", () => {
		const rt = REAL["src/registerTool.ts"];
		const sites = analyse({
			...REAL,
			"src/registerTool.ts": `${rt}\nconst _p = { callerOrchestrator: "system" };\n`,
		});
		expect(blocked(sites).length).toBeGreaterThan(0);
	});
});
