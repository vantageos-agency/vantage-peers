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
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "../tools.ts"), "utf-8");

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

function extractHandlerBody(toolName: string): string | null {
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
	return SRC.slice(bodyStart, upperBound);
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

type Bucket = "guarded" | "unguarded" | "public" | "unreadable";

function classify(door: DerivedDoor): Bucket {
	if (door.kind === null) return "unreadable";
	if (door.kind === "public") return "public";
	if (ENVELOPE_GUARANTEED_KINDS.has(door.kind)) return "guarded";
	// kind === "filtered": per-door declared-and-verified rule (no central
	// marker list). The reason must NAME a mechanism AND that mechanism must
	// be present, call-shaped, in this door's own handler slice.
	const body = extractHandlerBody(door.name);
	if (body === null) return "unreadable";
	const mechanisms = reasonNamedMechanisms(extractReason(door));
	const verified = mechanisms.some((mech) => mechanismInHandler(mech, body));
	return verified ? "guarded" : "unguarded";
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
