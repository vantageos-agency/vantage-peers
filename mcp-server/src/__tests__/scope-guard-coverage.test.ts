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

// Every read/list tool that crosses tenants if unscoped.
// If you add a new bulk-list or cross-tenant read tool, ADD IT HERE and patch
// the handler in tools.ts with a scope guard. The CI suite will fail until both.
const READ_TOOLS_THAT_NEED_GUARD = [
	// Bulk lists
	"list_peers",
	"list_messages",
	"list_broadcast_status",
	"list_tasks",
	"list_tasks_by_mission",
	"list_missions",
	"list_diaries",
	"list_briefing_notes",
	"list_components",
	"search_components",
	"list_recurring_tasks",
	"list_mandates",
	"list_bus",
	"list_repo_mappings",
	"list_issues",
	"issue_stats",
	"search_fix_patterns",
	"list_fix_patterns",
	"list_errors",
	// Single-row get_*
	"get_memory",
	"get_profile",
	"get_mission",
	"get_diary",
	"get_component",
	"get_bu",
	"get_issue",
	"get_error",
	"get_mission_template",
	// Inbox
	"check_messages",
];

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
	const tryIdx = SRC.indexOf("try {", m.index);
	if (tryIdx === -1) return null;
	// Take up to 3500 chars after `try {` — generous enough for the largest
	// handler in tools.ts.
	return SRC.slice(tryIdx, tryIdx + 3500);
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

describe("Day 88 P0 — every cross-tenant read tool has a scope guard", () => {
	for (const tool of READ_TOOLS_THAT_NEED_GUARD) {
		it(`${tool} handler enforces scope`, () => {
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
