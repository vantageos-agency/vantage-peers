/**
 * Day 88 P0 regression, kind-based rewrite (Eta review on
 * sigma/count-unguarded-doors) — every MCP tool door's DECLARED SCOPE KIND
 * is itself the guard for `master`/`read`/`write`/`from` (the `defineTool`
 * wrapper's `enforceScope` runs BEFORE the handler, see
 * mcp-server/src/registerTool.ts). Searching the handler body for an
 * in-handler marker was the wrong measurement for those kinds: it is blind
 * to the real gate (the wrapper, not the body) and gameable (a redundant
 * in-handler marker added to an already-envelope-guarded door lowers the
 * count while closing nothing).
 *
 * The one kind the wrapper CANNOT auto-apply is `filtered` (it needs
 * post-query rows). A `filtered`-kind door is guarded by a PER-DOOR
 * DECLARED-AND-VERIFIED rule, NOT by a central marker list: the door's own
 * `reason` must NAME a mechanism (a call-shaped identifier `ident(`, e.g.
 * `scopeFilterList(`/`scopeFilterGet(`/`listRowsScopedTo(`) AND that named
 * mechanism must actually appear, call-shaped, in the door's own handler
 * slice. A reason naming no mechanism => unguarded; a reason naming a
 * mechanism absent from the handler (a LYING declaration) => unguarded.
 * `public` is a separate, deliberate bucket, never folded into "unguarded".
 * This mirrors scripts/count_unguarded_doors.py's classification exactly
 * (same declared-and-verified rule) — see that script's module docstring for
 * the full rationale.
 *
 * Static analysis, no hand-typed tool-name list: every tool name and its
 * scope kind are DERIVED from the source text.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "../tools.ts"), "utf-8");
const REPO_ROOT = resolve(__dirname, "../../..");

const VALID_SCOPE_KINDS = [
	"public",
	"master",
	"read",
	"write",
	"from",
	"filtered",
] as const;
type ScopeKind = (typeof VALID_SCOPE_KINDS)[number];

const ENVELOPE_GUARANTEED_KINDS: ReadonlySet<ScopeKind> = new Set([
	"master",
	"read",
	"write",
	"from",
]);

// Anchor: each tool's own registration-name line, e.g. `\t\t"list_peers",`.
// This is registration-shape-agnostic (legacy `server.tool(...)` or the
// mandatory-scope `defineTool(...)` wrapper form) by construction.
const TOOL_NAME_LINE_RE = /^\t+"([a-zA-Z_][a-zA-Z0-9_]*)",$/gm;

// A handful of registrations pass the tool name as a named constant instead
// of an inline literal (e.g. `BULK_COMPLETE_TASKS_TOOL_NAME`), declared
// elsewhere as `export const X_TOOL_NAME = "literal";`. Same derivation as
// scripts/count_unguarded_doors.py's `_build_const_string_table` — resolve
// the identifier back to its own literal declaration rather than refusing
// to judge every constant-named door.
const CONST_NAME_LINE_RE = /^\t+([A-Z][A-Z0-9_]*_TOOL_NAME),$/gm;
const CONST_STRING_DECL_RE = /const\s+([A-Za-z_$][\w$]*)\s*=\s*"([^"]*)"/g;

function buildConstStringTable(src: string): Map<string, string> {
	const table = new Map<string, string>();
	for (const m of src.matchAll(CONST_STRING_DECL_RE)) {
		table.set(m[1], m[2]);
	}
	return table;
}

const CONST_TABLE = buildConstStringTable(SRC);

// Only the five real ToolScope union members -- deliberately excludes the
// unrelated `kind: "..."` string literals used elsewhere in tools.ts for UI
// marker payloads (e.g. `kind: "tasks-table"`, `kind: "briefing-note"`),
// which are NOT scope declarations and must never be mistaken for one.
const SCOPE_KIND_RE = /kind:\s*"(public|master|read|write|from|filtered)"/g;

interface DerivedDoor {
	name: string;
	nameIndex: number;
	kind: ScopeKind | null;
	// Byte offset of this door's own `kind: "..."` scope match — the start of
	// the region (up to nameIndex) in which its `reason:` field lives.
	scopeIndex: number;
}

/**
 * Derive every registered tool's own declared scope kind AND its name.
 *
 * Driven from the `kind:` matches, not from the name-line matches: a
 * `^\t+"...",$`-shaped line also matches plenty of unrelated string-literal
 * lines that happen to sit alone on their own line at that indentation (zod
 * enum members like `"blocked",`/`"done",`, error-code lists, etc) — those
 * are NOT tool registrations and would be false positives if scanned
 * directly. `kind: "..."` (restricted to the five real ToolScope members)
 * is unambiguous: it appears ONLY inside an actual scope object literal, so
 * walking FORWARD from each kind match to the next `"name",`-shaped line
 * lands on that door's own name, never a neighbour's (nothing else matching
 * the name-line shape sits between a scope object's closing `}` and its own
 * `name` argument in this codebase's registration style).
 */
function deriveDoors(src: string): DerivedDoor[] {
	const kindMatches: { kind: ScopeKind; index: number }[] = [];
	for (const m of src.matchAll(SCOPE_KIND_RE)) {
		kindMatches.push({ kind: m[1] as ScopeKind, index: m.index ?? -1 });
	}

	return kindMatches.map(({ kind, index }) => {
		TOOL_NAME_LINE_RE.lastIndex = index;
		const literalMatch = TOOL_NAME_LINE_RE.exec(src);
		CONST_NAME_LINE_RE.lastIndex = index;
		const constMatch = CONST_NAME_LINE_RE.exec(src);

		// Whichever anchor (inline string literal, or named constant) occurs
		// FIRST after this kind match is this door's own name -- never a
		// neighbour's.
		const literalIndex = literalMatch
			? (literalMatch.index ?? Infinity)
			: Infinity;
		const constIndex = constMatch ? (constMatch.index ?? Infinity) : Infinity;

		if (literalMatch && literalIndex <= constIndex) {
			return {
				name: literalMatch[1],
				nameIndex: literalIndex,
				kind,
				scopeIndex: index,
			};
		}

		if (constMatch) {
			const resolved = CONST_TABLE.get(constMatch[1]);
			if (resolved !== undefined) {
				return {
					name: resolved,
					nameIndex: constIndex,
					kind,
					scopeIndex: index,
				};
			}
			return {
				name: `<unresolved:${constMatch[1]}>`,
				nameIndex: -1,
				kind: null,
				scopeIndex: index,
			};
		}

		return { name: "<unresolved>", nameIndex: -1, kind: null, scopeIndex: index };
	});
}

function extractHandlerRange(toolName: string): [number, number] | null {
	const startRe = new RegExp(`^\\t+"${toolName}",$`, "m");
	let m = startRe.exec(SRC);
	if (!m) {
		// Fall back to the named-constant registration form (e.g.
		// `BULK_COMPLETE_TASKS_TOOL_NAME`) whose own declaration resolves to
		// this tool's name.
		for (const [ident, literal] of CONST_TABLE) {
			if (literal === toolName) {
				const constRe = new RegExp(`^\\t+${ident},$`, "m");
				m = constRe.exec(SRC);
				break;
			}
		}
	}
	if (!m) return null;
	const asyncIdx = SRC.indexOf("async (", m.index);
	const tryIdx = SRC.indexOf("try {", m.index);
	if (tryIdx === -1) return null;
	const bodyStart = asyncIdx !== -1 && asyncIdx < tryIdx ? asyncIdx : tryIdx;
	TOOL_NAME_LINE_RE.lastIndex = m.index + 1;
	const next = TOOL_NAME_LINE_RE.exec(SRC);
	const hardCap = tryIdx + 3500;
	const upperBound = next && next.index < hardCap ? next.index : hardCap;
	return [bodyStart, upperBound];
}

function extractHandlerBody(toolName: string): string | null {
	const range = extractHandlerRange(toolName);
	return range === null ? null : SRC.slice(range[0], range[1]);
}

// A door's `reason:` value, reconstructed from the scope-object region that
// sits between its own `kind:` match and its own name line. The value may be
// a single string literal or a `+`-concatenated run across lines.
function extractReason(door: DerivedDoor): string {
	if (door.scopeIndex < 0 || door.nameIndex < 0) return "";
	const region = SRC.slice(door.scopeIndex, door.nameIndex);
	const m = /reason\s*:\s*((?:\s*"(?:[^"\\]|\\.)*"\s*\+?)+)/.exec(region);
	if (!m) return "";
	const parts = m[1].match(/"((?:[^"\\]|\\.)*)"/g) ?? [];
	return parts.map((p) => p.slice(1, -1)).join("");
}

// Mechanisms a reason NAMES: each call-shaped identifier (`ident(`, no
// intervening whitespace — a call, not a prose word before a parenthetical).
function reasonNamedMechanisms(reason: string): string[] {
	const seen = new Set<string>();
	for (const m of reason.matchAll(/([A-Za-z_$][\w$]*)\(/g)) {
		seen.add(m[1]);
	}
	return [...seen];
}

function mechanismInHandler(mechanism: string, body: string): boolean {
	const escaped = mechanism.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![\\w$])${escaped}\\(`).test(body);
}

// ── IDENTITY-BOUND `filtered` doors (task k1735h1xs805q1dwh3xd3vhzw98gygdy) ──
//
// Mirrors scripts/count_unguarded_doors.py (IDENTITY-BOUND): a `filtered` door
// whose caller gate lives in its CONVEX function. Derived from source, never a
// typed door list. ALL of:
//   (a)  the handler calls Convex (`.query(`/`.mutation(`/`.action(` with a
//        string-literal function) at least once, and EVERY function it calls is
//        in VERIFIED_ACTOR_DOORS (mcp-server/src/verifiedActor.ts, read from the
//        Set literal: the wrapped client injects `verifiedActor` there);
//   (a2) no call's argument text names `verifiedOrg` or spreads a call result
//        (the only route a verified organisation, which lets an inbox-style door
//        select its agent by NAME, reaches a door);
//   (b)  each function's Convex export (comments/strings masked) refuses a call
//        without the verified actor: `if (... args.verifiedActor === undefined
//        ...) { throw`.
// Any unreadable input leaves the door unguarded.

/**
 * `text` with every comment, string/template literal and regex literal blanked
 * to spaces (offsets and newlines preserved), from the TypeScript AST.
 */
function maskSource(text: string): string {
	const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
	const out = text.split("");
	const blank = (from: number, to: number) => {
		for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
	};
	const seen = new Set<number>();
	const comments = (pos: number) => {
		for (const r of [
			...(ts.getLeadingCommentRanges(text, pos) ?? []),
			...(ts.getTrailingCommentRanges(text, pos) ?? []),
		]) {
			if (seen.has(r.pos)) continue;
			seen.add(r.pos);
			blank(r.pos, r.end);
		}
	};
	const visit = (node: ts.Node) => {
		comments(node.getFullStart());
		comments(node.getEnd());
		if (
			ts.isStringLiteral(node) ||
			ts.isNoSubstitutionTemplateLiteral(node) ||
			ts.isRegularExpressionLiteral(node) ||
			node.kind === ts.SyntaxKind.TemplateHead ||
			node.kind === ts.SyntaxKind.TemplateMiddle ||
			node.kind === ts.SyntaxKind.TemplateTail
		) {
			blank(node.getStart(sf), node.getEnd());
			return;
		}
		for (const child of node.getChildren(sf)) visit(child);
	};
	visit(sf);
	return out.join("");
}

/** The members of `export const VERIFIED_ACTOR_DOORS = new Set([...])`. */
function parseVerifiedActorDoors(text: string): ReadonlySet<string> | null {
	const sf = ts.createSourceFile("v.ts", text, ts.ScriptTarget.Latest, true);
	let found: Set<string> | null = null;
	const visit = (node: ts.Node) => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === "VERIFIED_ACTOR_DOORS" &&
			node.initializer &&
			ts.isNewExpression(node.initializer) &&
			node.initializer.arguments?.[0] &&
			ts.isArrayLiteralExpression(node.initializer.arguments[0])
		) {
			found = new Set(
				node.initializer.arguments[0].elements
					.filter(ts.isStringLiteral)
					.map((e) => e.text),
			);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return found;
}

const CONVEX_CALL_RE = /\.(?:query|mutation|action)\(/g;
const ORG_CLAIM_RE = /verifiedOrg|\.\.\.\s*[A-Za-z_$][\w$]*\s*\(/;
const REFUSES_WITHOUT_ACTOR_RE =
	/\bif\s*\((?:(?!\bif\s*\()[^{};])*?\bargs\.verifiedActor\s*===\s*undefined(?:(?!\bif\s*\()[^{};])*?\)\s*\{?\s*throw\b/;

/** Every Convex call in a handler: [function | null, masked argument text]. */
function convexCalls(
	raw: string,
	masked: string,
): Array<[string | null, string]> | null {
	const calls: Array<[string | null, string]> = [];
	for (const m of masked.matchAll(CONVEX_CALL_RE)) {
		const open = (m.index ?? 0) + m[0].length - 1;
		let depth = 0;
		let close = -1;
		for (let i = open; i < masked.length; i++) {
			if (masked[i] === "(") depth++;
			else if (masked[i] === ")" && --depth === 0) {
				close = i;
				break;
			}
		}
		if (close === -1) return null;
		const argRaw = raw.slice(open + 1, close).replace(/^(?:\s*\/\/[^\n]*\n)*/, "");
		const lit = /^\s*"([\w/]+:\w+)"/.exec(argRaw);
		calls.push([lit ? lit[1] : null, masked.slice(open + 1, close)]);
	}
	return calls;
}

/** The masked `export const <name> =` slice of a Convex module, or null. */
function convexExportSlice(moduleText: string, name: string): string | null {
	const code = maskSource(moduleText);
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const m = new RegExp(`^export\\s+const\\s+${escaped}\\s*=`, "m").exec(code);
	if (!m) return null;
	const rest = code.slice(m.index + m[0].length);
	const next = /^export\s/m.exec(rest);
	return code.slice(m.index, next ? m.index + m[0].length + next.index : undefined);
}

interface IdentityInputs {
	verifiedActorDoors: ReadonlySet<string> | null;
	/** convex/<module>.ts source for `module`, or null when unreadable. */
	convexModule: (module: string) => string | null;
}

/** The Convex functions that make a `filtered` handler identity-bound, or []. */
function identityBoundDoorsOf(
	raw: string,
	masked: string,
	inputs: IdentityInputs,
): string[] {
	const doors = inputs.verifiedActorDoors;
	if (doors === null) return [];
	const calls = convexCalls(raw, masked);
	if (!calls || calls.length === 0) return [];
	const fns: string[] = [];
	for (const [fn, argMasked] of calls) {
		if (fn === null || !doors.has(fn)) return [];
		if (ORG_CLAIM_RE.test(argMasked)) return [];
		const [module, name] = fn.split(":");
		const text = inputs.convexModule(module);
		const slice = text === null ? null : convexExportSlice(text, name);
		if (slice === null || !REFUSES_WITHOUT_ACTOR_RE.test(slice)) return [];
		if (!fns.includes(fn)) fns.push(fn);
	}
	return fns;
}

function readOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

const REAL_IDENTITY: IdentityInputs = {
	verifiedActorDoors: (() => {
		const text = readOrNull(resolve(__dirname, "../verifiedActor.ts"));
		return text === null ? null : parseVerifiedActorDoors(text);
	})(),
	convexModule: (module) =>
		readOrNull(resolve(REPO_ROOT, "convex", `${module}.ts`)),
};

const MASKED_SRC = maskSource(SRC);

type Bucket = "guarded" | "unguarded" | "public" | "unreadable";

function classify(door: DerivedDoor): Bucket {
	if (door.kind === null) return "unreadable";
	if (door.kind === "public") return "public";
	if (ENVELOPE_GUARANTEED_KINDS.has(door.kind)) return "guarded";
	// kind === "filtered": per-door declared-and-verified rule (no central
	// marker list). The reason must NAME a mechanism AND that mechanism must
	// be present, call-shaped, in this door's own handler slice.
	const range = extractHandlerRange(door.name);
	if (range === null) return "unreadable";
	const body = SRC.slice(range[0], range[1]);
	const mechanisms = reasonNamedMechanisms(extractReason(door));
	const verified = mechanisms.some((mech) => mechanismInHandler(mech, body));
	if (verified) return "guarded";
	// The caller gate lives in the Convex door (IDENTITY-BOUND above).
	const masked = MASKED_SRC.slice(range[0], range[1]);
	return identityBoundDoorsOf(body, masked, REAL_IDENTITY).length > 0
		? "guarded"
		: "unguarded";
}

const DOORS = deriveDoors(SRC);

// Sibling of scripts/unguarded-doors.baseline — same kind-based population
// (whole-file door count, not naming-convention-filtered), same tracked
// snapshot pattern: a plain number file, never a hand-typed tool-name
// allowlist.
const BASELINE_UNGUARDED_COUNT = Number(
	readFileSync(
		resolve(__dirname, "../../../scripts/unguarded-doors.baseline"),
		"utf-8",
	).trim(),
);

describe("Day 88 P0 — MCP tool doors are guarded by declared scope kind", () => {
	it("every door's scope kind is readable (no UNREADABLE doors)", () => {
		const unreadable = DOORS.filter((d) => classify(d) === "unreadable");
		expect(
			unreadable.map((d) => d.name),
			"A tool's declared scope kind or handler body could not be located — " +
				"the registration shape may have changed.",
		).toEqual([]);
	});

	it("guard helpers are imported in tools.ts", () => {
		expect(SRC).toMatch(/from\s+"\.\/auth\.js"/);
		expect(SRC).toMatch(/isMasterScope/);
		expect(SRC).toMatch(/checkNamespaceRead/);
	});

	it("public-kind doors are never folded into the unguarded bucket", () => {
		const publicDoors = DOORS.filter((d) => classify(d) === "public");
		// At least the known-deliberate public exposures exist and classify
		// as their own bucket, not unguarded.
		expect(publicDoors.length).toBeGreaterThan(0);
		for (const d of publicDoors) {
			expect(classify(d)).not.toBe("unguarded");
		}
	});

	it("known-unguarded `filtered`-kind doors are tolerated exactly up to the tracked baseline", () => {
		const unguarded = DOORS.filter((d) => classify(d) === "unguarded");
		expect(
			unguarded.length,
			`Derived unguarded doors: [${unguarded.map((d) => d.name).join(", ")}]. ` +
				`If this count went UP, either a previously-guarded door lost its ` +
				`guard (fix it) or a genuinely new unguarded gap appeared (file the ` +
				`auth task and, once accepted, bump scripts/unguarded-doors.baseline). ` +
				`If it went DOWN, a gap was fixed — lower the baseline file to match.`,
		).toBe(BASELINE_UNGUARDED_COUNT);
	});

	it("auto-scoped tools force the caller's userId (no silent fleet read)", () => {
		// list_missions must require pilot = oauthCtx.userId
		const listMissionsBody = extractHandlerBody("list_missions") ?? "";
		expect(listMissionsBody).toMatch(/pilot/);
		expect(listMissionsBody).toMatch(/oauthCtx\.userId/);

		// list_diaries must require orchestrator = oauthCtx.userId
		const listDiariesBody = extractHandlerBody("list_diaries") ?? "";
		expect(listDiariesBody).toMatch(/orchestrator/);
		expect(listDiariesBody).toMatch(/oauthCtx\.userId/);

		// check_messages must require recipient = oauthCtx.userId
		const checkMessagesBody = extractHandlerBody("check_messages") ?? "";
		expect(checkMessagesBody).toMatch(/recipient/);
		expect(checkMessagesBody).toMatch(/oauthCtx\.userId/);
	});
});

describe("identity-bound `filtered` doors — the caller gate lives in the Convex door", () => {
	const VA_TS = [
		"export const VERIFIED_ACTOR_DOORS: ReadonlySet<string> = new Set([",
		'\t"widgets:mine",',
		'\t// "widgets:commented" is a comment, never a member',
		'\t"widgets:open",',
		"]);",
	].join("\n");
	const WIDGETS = [
		"export const mine = query({",
		"\targs: { verifiedActor: v.optional(verifiedActorValidator) },",
		"\thandler: async (ctx, args) => {",
		"\t\tconst scope = await withOrgScope(ctx);",
		"\t\tif (isMcpBoundMaster(scope) && args.verifiedActor === undefined) {",
		'\t\t\tthrow rbacDenied("widgets:mine", "claimless", "no agent");',
		"\t\t}",
		"\t\treturn [];",
		"\t},",
		"});",
		"",
		"export const open = query({",
		"\targs: { verifiedActor: v.optional(verifiedActorValidator) },",
		"\thandler: async (ctx, args) => {",
		"\t\t// if (args.verifiedActor === undefined) { throw ... } -- prose only",
		'\t\tconst note = "if (args.verifiedActor === undefined) { throw";',
		"\t\treturn [note];",
		"\t},",
		"});",
		"",
		"export const elsewhere = query({",
		"\targs: {},",
		"\thandler: async (ctx, args) => {",
		"\t\tif (args.verifiedActor === undefined) {",
		'\t\t\tthrow new ConvexError("RBAC_DENIED");',
		"\t\t}",
		"\t\treturn [];",
		"\t},",
		"});",
	].join("\n");
	const inputs = (vaText: string | null = VA_TS): IdentityInputs => ({
		verifiedActorDoors: vaText === null ? null : parseVerifiedActorDoors(vaText),
		convexModule: (m) => (m === "widgets" ? WIDGETS : null),
	});
	const call = (fn: string, argObj = "{ ...(tenantId !== undefined ? { tenantId } : {}) }") =>
		[
			"async ({ tenantId }) => {",
			"\ttry {",
			"\t\tconst r = await convex.query(",
			"\t\t\t// biome-ignore lint/suspicious/noExplicitAny: Convex string API",
			`\t\t\t"${fn}" as any,`,
			`\t\t\t${argObj},`,
			"\t\t);",
			"\t\treturn r;",
			"\t} catch (e) { return e; }",
			"}",
		].join("\n");
	const bound = (handler: string, i: IdentityInputs = inputs()) =>
		identityBoundDoorsOf(handler, maskSource(handler), i);

	it("GREEN: every called function is in the set and its Convex door refuses without verifiedActor", () => {
		expect(bound(call("widgets:mine"))).toEqual(["widgets:mine"]);
	});

	it("RED: in the set, but the Convex door only mentions the refusal in a comment or a string", () => {
		expect(bound(call("widgets:open"))).toEqual([]);
	});

	it("RED: the Convex door refuses, but the function is outside VERIFIED_ACTOR_DOORS", () => {
		expect(bound(call("widgets:elsewhere"))).toEqual([]);
	});

	it("RED: a commented-out set entry is not a member", () => {
		expect(bound(call("widgets:commented"))).toEqual([]);
	});

	it("RED: a call that forwards a verified organisation (by name, through a spread helper)", () => {
		expect(bound(call("widgets:mine", "{ ...inboxOrgArgs(recipient) }"))).toEqual([]);
		expect(bound(call("widgets:mine", "{ verifiedOrg: { orgSlug } }"))).toEqual([]);
	});

	it("RED: a second Convex call outside the set unbinds the door", () => {
		const two = call("widgets:mine").replace(
			"\t\treturn r;",
			'\t\tawait convex.query("widgets:elsewhere" as any, {});\n\t\treturn r;',
		);
		expect(bound(two)).toEqual([]);
	});

	it("RED: an unreadable verifiedActor.ts or Convex module flips nothing", () => {
		expect(bound(call("widgets:mine"), inputs(null))).toEqual([]);
		expect(
			bound(call("widgets:mine"), {
				verifiedActorDoors: new Set(["widgets:mine"]),
				convexModule: () => null,
			}),
		).toEqual([]);
	});

	it("real tree: list_blocked_on_me reads guarded at tasks:listBlockedOnMe; check_messages stays unguarded", () => {
		const doorOf = (name: string) => {
			const d = DOORS.find((x) => x.name === name);
			if (!d) throw new Error(`${name} not derived`);
			return d;
		};
		const range = (name: string) => {
			const r = extractHandlerRange(name);
			if (!r) throw new Error(`${name} handler not sliced`);
			return r;
		};
		const [s1, e1] = range("list_blocked_on_me");
		expect(doorOf("list_blocked_on_me").kind).toBe("filtered");
		expect(
			identityBoundDoorsOf(SRC.slice(s1, e1), MASKED_SRC.slice(s1, e1), REAL_IDENTITY),
		).toEqual(["tasks:listBlockedOnMe"]);
		expect(classify(doorOf("list_blocked_on_me"))).toBe("guarded");
		const [s2, e2] = range("check_messages");
		expect(
			identityBoundDoorsOf(SRC.slice(s2, e2), MASKED_SRC.slice(s2, e2), REAL_IDENTITY),
		).toEqual([]);
		expect(classify(doorOf("check_messages"))).toBe("unguarded");
	});
});
