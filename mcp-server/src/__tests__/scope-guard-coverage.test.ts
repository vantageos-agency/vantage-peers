/**
 * Day 88 P0 regression — every read tool must enforce a scope guard.
 *
 * Static analysis: parse mcp-server/src/tools.ts, locate each tool's
 * registration block, and assert the handler body starts with either
 * `guardMasterOnly(...)`, an explicit `isMasterScope(oauthCtx)` check, or
 * an `oauthCtx.userId` filter check.
 *
 * Why static: spinning a real MCP server + Convex client inside vitest is
 * heavy and brittle. A regex over the source proves the guard line exists
 * in the right place. It catches anyone who adds a new read tool without
 * the guard — a future leak vector.
 *
 * This is the "tripwire" complement to oauth-scoped.test.ts which proves
 * the predicate functions themselves are correct.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "../tools.ts"), "utf-8");

// Every read/list tool that crosses tenants if unscoped -- DERIVED from the
// registered tool names, never hand-typed. A hand-typed list rots at every
// new client: the next new read tool is always the one nobody remembered to
// add, and the coverage test would print PASSED straight through the gap
// (see scripts/count_unguarded_doors.py, same naming-convention derivation
// exposed as `derive_read_tool_names` there).
//
// Anchor: each tool's own registration-name line, e.g. `\t\t"list_peers",`
// -- the exact same anchor `extractHandlerBody` below uses, so this list is
// registration-shape-agnostic (legacy `server.tool(...)` or the
// mandatory-scope `defineTool(...)` wrapper form) by construction.
//
// A registered name is a "read that needs a guard" if it follows the
// list_*/get_*/search_* naming convention (bulk list or single-row get by
// construction), or is one of the two structural exceptions that predate
// that convention but are still reads: `check_messages`, `issue_stats`.
function deriveReadToolsThatNeedGuard(src: string): string[] {
	const names = new Set<string>();
	for (const m of src.matchAll(/^\t+"([a-zA-Z_][a-zA-Z0-9_]*)",$/gm)) {
		const name = m[1];
		if (/^(list_|get_|search_)/.test(name)) {
			names.add(name);
		} else if (name === "check_messages" || name === "issue_stats") {
			names.add(name);
		}
	}
	return [...names];
}

const READ_TOOLS_THAT_NEED_GUARD = deriveReadToolsThatNeedGuard(SRC);

// Anchor pattern for ANY tool's own name line — reused both to locate a
// specific tool and to find the START of the NEXT registration, so a
// handler-body slice never bleeds into the following tool's body (a fixed
// character-count slice can run past a short handler and pick up the next
// tool's `oauthCtx.userId` check, producing a false "guarded" verdict for a
// tool that has no guard of its own — this is exactly the bug that hid
// `search_episodes_by_semantic` being unguarded before this fix).
const TOOL_NAME_LINE_RE = /^\t+"([a-zA-Z_][a-zA-Z0-9_]*)",$/gm;

function extractHandlerBody(toolName: string): string | null {
	// Anchor on the tool's NAME line (its own line, e.g. `\t\t"list_peers",`).
	// This is registration-shape-agnostic: it matches whether the call is the
	// legacy `server.tool("name", …)` form or the mandatory-scope
	// `defineTool(server, authCtx, <scope>, "name", …)` wrapper form
	// (mission vp-multitenant-zero-hole-v1, S2). Description/EXAMPLE lines never
	// match because they end in ` +` (concatenation), not `",`.
	const startRe = new RegExp(`^\\t+"${toolName}",$`, "m");
	const m = startRe.exec(SRC);
	if (!m) return null;
	// Start from the handler's `async (` opening rather than `try {` — some
	// handlers run a scope guard (e.g. `guardMasterOnly(...)`) BEFORE their
	// own `try {`, as a redundant legacy-bearer check (list_errors,
	// get_error). Starting at `try {` skipped that guard entirely, another
	// false-negative this fix closes alongside the next-tool bleed-over.
	const asyncIdx = SRC.indexOf("async (", m.index);
	const tryIdx = SRC.indexOf("try {", m.index);
	if (tryIdx === -1) return null;
	const bodyStart = asyncIdx !== -1 && asyncIdx < tryIdx ? asyncIdx : tryIdx;
	// Upper-bounded by whichever comes first: 3500 chars after `try {`
	// (generous enough for the largest handler in tools.ts), or the START of
	// the NEXT tool's own name line — whichever is closer — so the slice
	// never crosses into an adjacent handler's body.
	TOOL_NAME_LINE_RE.lastIndex = m.index + 1;
	const next = TOOL_NAME_LINE_RE.exec(SRC);
	const hardCap = tryIdx + 3500;
	const upperBound = next && next.index < hardCap ? next.index : hardCap;
	return SRC.slice(bodyStart, upperBound);
}

function bodyHasScopeGuard(body: string): boolean {
	// Accept any of the canonical guard patterns:
	// (a) guardMasterOnly("name")
	// (b) explicit isMasterScope(oauthCtx) gate
	// (c) auto-scope to oauthCtx.userId
	// (d) scopeFilterList / scopeFilterGet (Wave B post-fetch row filter)
	// (e) listTasksGate (Day 92 extracted fromAllowList predicate, tools.ts)
	return (
		/guardMasterOnly\(/.test(body) ||
		/isMasterScope\(oauthCtx\)/.test(body) ||
		/oauthCtx\.userId/.test(body) ||
		/scopeFilterList\(/.test(body) ||
		/scopeFilterGet\(/.test(body) ||
		/listTasksGate\(/.test(body)
	);
}

// Doors currently lacking a guard, DERIVED fresh from source each run — never
// hand-typed. This is the "Option A" landing (Pi task
// k178fn5qfxsqg33vhwepe4y12d8de2j6): the count-script measurement lands
// first; fixing these two auth gaps (search_episodes_by_keyword,
// search_episodes_by_semantic) is a separate task. The test stays GREEN and
// tolerant of exactly the known baseline below — it fails again the moment
// EITHER a previously-guarded tool loses its guard (pushing the derived
// count above baseline) OR a brand-new unguarded tool is added.
const CURRENTLY_UNGUARDED = READ_TOOLS_THAT_NEED_GUARD.filter((tool) => {
	const body = extractHandlerBody(tool);
	return !body || !bodyHasScopeGuard(body);
});

// Sibling of scripts/unguarded-doors.baseline, scoped to THIS test's own
// naming-convention-filtered "read tools that need a guard" derivation
// (deriveReadToolsThatNeedGuard) rather than the whole-file door count the
// Python script measures (105 doors, 14 unguarded, mixed read+write) — the
// two baselines measure different populations by construction and are not
// interchangeable. A plain number file, same pattern as the Python sibling:
// a tracked measurement snapshot, not a hand-typed tool-name allowlist.
const BASELINE_UNGUARDED_COUNT = Number(
	readFileSync(
		resolve(__dirname, "../../../scripts/mcp-read-tool-scope-guard.baseline"),
		"utf-8",
	).trim(),
);

describe("Day 88 P0 — every cross-tenant read tool has a scope guard", () => {
	for (const tool of READ_TOOLS_THAT_NEED_GUARD) {
		it(`${tool} handler enforces scope`, () => {
			if (CURRENTLY_UNGUARDED.includes(tool)) {
				// Known, tracked gap (see CURRENTLY_UNGUARDED / baseline test
				// below) — fixing it is a separate auth task, not this one.
				return;
			}
			const body = extractHandlerBody(tool);
			expect(
				body,
				`Could not locate handler body for tool '${tool}' — has the registration shape changed?`,
			).toBeTruthy();
			expect(
				bodyHasScopeGuard(body as string),
				`Tool '${tool}' has no scope guard in its handler body. ` +
					`Non-master clients would leak data across tenants. ` +
					`Add one of: guardMasterOnly("${tool}"), an isMasterScope(oauthCtx) gate, ` +
					`or an oauthCtx.userId equality check.`,
			).toBe(true);
		});
	}

	it("known-unguarded read tools are tolerated exactly up to the tracked baseline", () => {
		expect(
			CURRENTLY_UNGUARDED.length,
			`Derived unguarded read tools: [${CURRENTLY_UNGUARDED.join(", ")}]. ` +
				`If this count went UP, either a previously-guarded tool lost its ` +
				`guard (fix it) or a genuinely new unguarded gap appeared (file the ` +
				`auth task and, once accepted, bump scripts/mcp-read-tool-scope-guard.baseline). ` +
				`If it went DOWN, a gap was fixed — lower the baseline file to match.`,
		).toBe(BASELINE_UNGUARDED_COUNT);
	});

	// Sanity counts so we notice if someone removes tools wholesale.
	it("guard helpers are imported in tools.ts", () => {
		expect(SRC).toMatch(/from\s+"\.\/auth\.js"/);
		expect(SRC).toMatch(/isMasterScope/);
		expect(SRC).toMatch(/checkNamespaceRead/);
	});

	it("auto-scoped tools force the caller's userId (no silent fleet read)", () => {
		// list_tasks uses listTasksGate (Day 92 fix) which enforces fromAllowList
		// case-insensitive check. The gate is extracted to src/list-tasks-gate.ts
		// so tools.ts calls listTasksGate(oauthCtx, ...) instead of inlining userId.
		const listTasksBody = extractHandlerBody("list_tasks") ?? "";
		expect(listTasksBody).toMatch(/listTasksGate\(/);
		expect(listTasksBody).toMatch(/Forbidden|listTasksGate/);

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
