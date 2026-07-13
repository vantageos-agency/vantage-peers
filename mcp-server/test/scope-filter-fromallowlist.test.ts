/**
 * Day 92 — fromAllowList gate regression for list_tasks (and symmetric audit
 * of list_messages, list_briefing_notes, list_peers).
 *
 * Root cause: PR #625 commit 28db616 introduced a pre-gate in list_tasks that
 * compares assignedTo|createdBy to oauthCtx.userId ("zoe-acme-hr") instead
 * of checking membership in oauthCtx.fromAllowList (["Milo","milo","Zoé",
 * "Zoe","zoe","zoé","Victor","victor"]).
 *
 * Reference fix pattern: tools.ts L1383-1399 check_messages (commit 24b39c5).
 *
 * Task: k175dqksb5yqc6scsnv19j1cjs883p40
 *
 * TDD order: this file is committed BEFORE any source edit (RED phase).
 *
 * NOTE: gate logic is imported from src/list-tasks-gate.ts — a thin module
 * that exports the predicate extracted from tools.ts so it is unit-testable
 * without bootstrapping the full McpServer. The module does NOT exist yet in
 * the RED phase, causing an import error and making all tests FAIL.
 * GREEN phase: create src/list-tasks-gate.ts with the fixed implementation.
 */

import { describe, expect, it } from "vitest";
import type { OAuthCtx } from "@vantageos/cloud-identity";
import { scopeFilterList } from "@vantageos/cloud-identity";
import type { OAuthContext } from "../src/auth.js";
import { listTasksGate } from "../src/list-tasks-gate.js";

// ─────────────────────────────────────────────────────────────────────────────
// TRIO fromAllowList fixture (Zoé + Milo + Victor cross-persona, Day 92)
// ─────────────────────────────────────────────────────────────────────────────

const TRIO_FROM_ALLOW_LIST = [
	"Milo",
	"milo",
	"Zoé",
	"Zoe",
	"zoe",
	"zoé",
	"Victor",
	"victor",
];

function zoeCtx(): OAuthContext {
	return {
		clientId: "2e5d41df-b8f8-4f1a-95aa-2eb0d6bdadb7",
		userId: "zoe-acme-hr",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "zoe-acme-hr",
		fromAllowList: TRIO_FROM_ALLOW_LIST,
		namespaceReadPrefixes: ["orchestrator/zoe-acme-hr"],
		namespaceWritePrefixes: ["orchestrator/zoe-acme-hr"],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
	};
}

function masterCtx(): OAuthContext {
	return {
		clientId: "master",
		userId: "master",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "master",
		fromAllowList: ["*"],
		namespaceReadPrefixes: ["*"],
		namespaceWritePrefixes: ["*"],
		expiresAt: Date.now() + 3_600_000,
		isMaster: true,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. list_tasks — gate via exported listTasksGate (src/list-tasks-gate.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe("list_tasks — fromAllowList gate (Day 92 regression)", () => {
	describe("master scope — all filters pass", () => {
		it("allows assignedTo=Zoe", () => {
			expect(listTasksGate(masterCtx(), "Zoe", undefined)).toBeNull();
		});
		it("allows assignedTo=attacker", () => {
			expect(listTasksGate(masterCtx(), "attacker", undefined)).toBeNull();
		});
		it("allows no filter", () => {
			expect(listTasksGate(masterCtx(), undefined, undefined)).toBeNull();
		});
	});

	describe("non-master zoe-acme-hr scope with TRIO fromAllowList", () => {
		const ctx = zoeCtx();

		it("allows assignedTo=Zoe (exact match in list)", () => {
			expect(listTasksGate(ctx, "Zoe", undefined)).toBeNull();
		});

		it("allows assignedTo=Zoé (exact with accent)", () => {
			expect(listTasksGate(ctx, "Zoé", undefined)).toBeNull();
		});

		it("allows assignedTo=zoe (lowercase variant — case-insensitive)", () => {
			expect(listTasksGate(ctx, "zoe", undefined)).toBeNull();
		});

		it("allows assignedTo=ZOE (uppercase variant — case-insensitive)", () => {
			expect(listTasksGate(ctx, "ZOE", undefined)).toBeNull();
		});

		it("allows assignedTo=zoé (lowercase accent variant)", () => {
			expect(listTasksGate(ctx, "zoé", undefined)).toBeNull();
		});

		it("allows assignedTo=Milo", () => {
			expect(listTasksGate(ctx, "Milo", undefined)).toBeNull();
		});

		it("allows assignedTo=milo (lowercase)", () => {
			expect(listTasksGate(ctx, "milo", undefined)).toBeNull();
		});

		it("allows assignedTo=Victor", () => {
			expect(listTasksGate(ctx, "Victor", undefined)).toBeNull();
		});

		it("allows assignedTo=victor (lowercase)", () => {
			expect(listTasksGate(ctx, "victor", undefined)).toBeNull();
		});

		it("allows createdBy=Zoe", () => {
			expect(listTasksGate(ctx, undefined, "Zoe")).toBeNull();
		});

		it("allows createdBy=Milo", () => {
			expect(listTasksGate(ctx, undefined, "Milo")).toBeNull();
		});

		it("allows no filter (no assignedTo, no createdBy) — Convex handles intersection", () => {
			expect(listTasksGate(ctx, undefined, undefined)).toBeNull();
		});

		it("rejects assignedTo=Outsider — not in TRIO list", () => {
			expect(listTasksGate(ctx, "Outsider", undefined)).toMatch(/Forbidden/);
		});

		it("rejects assignedTo=attacker", () => {
			expect(listTasksGate(ctx, "attacker", undefined)).toMatch(/Forbidden/);
		});

		it("rejects assignedTo=alice — not in TRIO list", () => {
			expect(listTasksGate(ctx, "alice", undefined)).toMatch(/Forbidden/);
		});

		it("rejects createdBy=Outsider", () => {
			expect(listTasksGate(ctx, undefined, "Outsider")).toMatch(/Forbidden/);
		});

		it("rejects assignedTo=zoe-acme-hr (the profile name is NOT a valid filter)", () => {
			// The profile name "zoe-acme-hr" is not in fromAllowList — it's not
			// an orchestrator identity. Orchestrators identify as "Zoe"/"zoe"/etc.
			expect(listTasksGate(ctx, "zoe-acme-hr", undefined)).toMatch(
				/Forbidden/,
			);
		});
	});

	describe("undefined oauthCtx (legacy bearer)", () => {
		it("allows any filter when no oauthCtx (legacy path)", () => {
			expect(listTasksGate(undefined, "anyone", undefined)).toBeNull();
		});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. list_messages — symmetric audit via scopeFilterList
// ─────────────────────────────────────────────────────────────────────────────

describe("list_messages — scopeFilterList symmetric audit", () => {
	const ctx = zoeCtx();

	it("master scope: any createdBy passes", () => {
		const rows = [{ createdBy: "Outsider", namespace: undefined }];
		expect(scopeFilterList(masterCtx() as unknown as OAuthCtx, rows)).toHaveLength(1);
	});

	it("non-master: row with createdBy=Zoe passes (exact in fromAllowList)", () => {
		const rows = [{ createdBy: "Zoe" }];
		expect(scopeFilterList(ctx as unknown as OAuthCtx, rows)).toHaveLength(1);
	});

	it("non-master: row with createdBy=Milo passes", () => {
		const rows = [{ createdBy: "Milo" }];
		expect(scopeFilterList(ctx as unknown as OAuthCtx, rows)).toHaveLength(1);
	});

	it("non-master: row with createdBy=Victor passes", () => {
		const rows = [{ createdBy: "Victor" }];
		expect(scopeFilterList(ctx as unknown as OAuthCtx, rows)).toHaveLength(1);
	});

	it("non-master: row with createdBy=Outsider is filtered out", () => {
		const rows = [{ createdBy: "Outsider" }];
		expect(scopeFilterList(ctx as unknown as OAuthCtx, rows)).toHaveLength(0);
	});

	it("non-master: mixed rows filtered correctly", () => {
		const rows = [
			{ createdBy: "Zoe" },
			{ createdBy: "Outsider" },
			{ createdBy: "Milo" },
			{ createdBy: "attacker" },
		];
		const filtered = scopeFilterList(ctx as unknown as OAuthCtx, rows);
		expect(filtered).toHaveLength(2);
		expect(filtered.map((r) => r.createdBy)).toEqual(["Zoe", "Milo"]);
	});

	it("non-master: no rows → empty (no crash)", () => {
		expect(scopeFilterList(ctx as any, [])).toHaveLength(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. list_briefing_notes — symmetric audit via scopeFilterList
// ─────────────────────────────────────────────────────────────────────────────

describe("list_briefing_notes — scopeFilterList symmetric audit", () => {
	const ctx = zoeCtx();

	it("master scope: any row passes", () => {
		const rows = [{ createdBy: "anyone" }];
		expect(scopeFilterList(masterCtx() as unknown as OAuthCtx, rows)).toHaveLength(1);
	});

	it("non-master: row with createdBy=Zoe passes", () => {
		const rows = [{ createdBy: "Zoe" }];
		expect(scopeFilterList(ctx as unknown as OAuthCtx, rows)).toHaveLength(1);
	});

	it("non-master: row with createdBy=zoé passes (accent variant in list)", () => {
		// "zoé" is in fromAllowList verbatim — exact match
		const rows = [{ createdBy: "zoé" }];
		expect(scopeFilterList(ctx as unknown as OAuthCtx, rows)).toHaveLength(1);
	});

	it("non-master: row with createdBy=Outsider is filtered out", () => {
		const rows = [{ createdBy: "Outsider" }];
		expect(scopeFilterList(ctx as unknown as OAuthCtx, rows)).toHaveLength(0);
	});

	it("non-master: row with namespace matching prefix passes", () => {
		const rows = [{ namespace: "orchestrator/zoe-acme-hr/notes" }];
		expect(scopeFilterList(ctx as unknown as OAuthCtx, rows)).toHaveLength(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. list_peers — symmetric audit via scopeFilterList
// ─────────────────────────────────────────────────────────────────────────────

describe("list_peers — scopeFilterList symmetric audit", () => {
	const ctx = zoeCtx();

	it("master scope: any row passes", () => {
		const rows = [{ createdBy: "anyone" }];
		expect(scopeFilterList(masterCtx() as unknown as OAuthCtx, rows)).toHaveLength(1);
	});

	it("non-master: peer with createdBy=Zoe passes", () => {
		const rows = [{ createdBy: "Zoe" }];
		expect(scopeFilterList(ctx as unknown as OAuthCtx, rows)).toHaveLength(1);
	});

	it("non-master: peer with createdBy=Victor passes", () => {
		const rows = [{ createdBy: "Victor" }];
		expect(scopeFilterList(ctx as unknown as OAuthCtx, rows)).toHaveLength(1);
	});

	it("non-master: peer with createdBy=Outsider is filtered out", () => {
		const rows = [{ createdBy: "Outsider" }];
		expect(scopeFilterList(ctx as unknown as OAuthCtx, rows)).toHaveLength(0);
	});

	it("non-master: multiple peers, only TRIO members visible", () => {
		const rows = [
			{ createdBy: "Zoe" },
			{ createdBy: "Milo" },
			{ createdBy: "Victor" },
			{ createdBy: "ExternalBot" },
		];
		const filtered = scopeFilterList(ctx as unknown as OAuthCtx, rows);
		expect(filtered).toHaveLength(3);
	});
});
