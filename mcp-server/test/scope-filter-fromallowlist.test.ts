/**
 * Day 92 — fromAllowList gate regression for list_tasks (and symmetric audit
 * of list_messages, list_briefing_notes, list_peers).
 *
 * Root cause: PR #625 commit 28db616 introduced a pre-gate in list_tasks that
 * compares assignedTo|createdBy to oauthCtx.userId ("helios-iris-rh") instead
 * of checking membership in oauthCtx.fromAllowList (["Clio","clio","Hélios",
 * "Helios","helios","hélios","Victor","victor"]).
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
import type { OAuthContext } from "../src/auth.js";
import { isMasterScope } from "../src/auth.js";
import { scopeFilterList } from "@vantageos/cloud-identity";
// RED: this import will fail until GREEN phase creates the module
import { listTasksGate } from "../src/list-tasks-gate.js";

// ─────────────────────────────────────────────────────────────────────────────
// TRIO fromAllowList fixture (Hélios + Clio + Victor cross-persona, Day 92)
// ─────────────────────────────────────────────────────────────────────────────

const TRIO_FROM_ALLOW_LIST = [
	"Clio",
	"clio",
	"Hélios",
	"Helios",
	"helios",
	"hélios",
	"Victor",
	"victor",
];

function heliosCtx(): OAuthContext {
	return {
		clientId: "2e5d41df-b8f8-4f1a-95aa-2eb0d6bdadb7",
		userId: "helios-iris-rh",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "helios-iris-rh",
		fromAllowList: TRIO_FROM_ALLOW_LIST,
		namespaceReadPrefixes: ["orchestrator/helios-iris-rh"],
		namespaceWritePrefixes: ["orchestrator/helios-iris-rh"],
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
		it("allows assignedTo=Helios", () => {
			expect(listTasksGate(masterCtx(), "Helios", undefined)).toBeNull();
		});
		it("allows assignedTo=attacker", () => {
			expect(listTasksGate(masterCtx(), "attacker", undefined)).toBeNull();
		});
		it("allows no filter", () => {
			expect(listTasksGate(masterCtx(), undefined, undefined)).toBeNull();
		});
	});

	describe("non-master helios-iris-rh scope with TRIO fromAllowList", () => {
		const ctx = heliosCtx();

		it("allows assignedTo=Helios (exact match in list)", () => {
			expect(listTasksGate(ctx, "Helios", undefined)).toBeNull();
		});

		it("allows assignedTo=Hélios (exact with accent)", () => {
			expect(listTasksGate(ctx, "Hélios", undefined)).toBeNull();
		});

		it("allows assignedTo=helios (lowercase variant — case-insensitive)", () => {
			expect(listTasksGate(ctx, "helios", undefined)).toBeNull();
		});

		it("allows assignedTo=HELIOS (uppercase variant — case-insensitive)", () => {
			expect(listTasksGate(ctx, "HELIOS", undefined)).toBeNull();
		});

		it("allows assignedTo=hélios (lowercase accent variant)", () => {
			expect(listTasksGate(ctx, "hélios", undefined)).toBeNull();
		});

		it("allows assignedTo=Clio", () => {
			expect(listTasksGate(ctx, "Clio", undefined)).toBeNull();
		});

		it("allows assignedTo=clio (lowercase)", () => {
			expect(listTasksGate(ctx, "clio", undefined)).toBeNull();
		});

		it("allows assignedTo=Victor", () => {
			expect(listTasksGate(ctx, "Victor", undefined)).toBeNull();
		});

		it("allows assignedTo=victor (lowercase)", () => {
			expect(listTasksGate(ctx, "victor", undefined)).toBeNull();
		});

		it("allows createdBy=Helios", () => {
			expect(listTasksGate(ctx, undefined, "Helios")).toBeNull();
		});

		it("allows createdBy=Clio", () => {
			expect(listTasksGate(ctx, undefined, "Clio")).toBeNull();
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

		it("rejects assignedTo=marie — not in TRIO list", () => {
			expect(listTasksGate(ctx, "marie", undefined)).toMatch(/Forbidden/);
		});

		it("rejects createdBy=Outsider", () => {
			expect(listTasksGate(ctx, undefined, "Outsider")).toMatch(/Forbidden/);
		});

		it("rejects assignedTo=helios-iris-rh (the profile name is NOT a valid filter)", () => {
			// The profile name "helios-iris-rh" is not in fromAllowList — it's not
			// an orchestrator identity. Orchestrators identify as "Helios"/"helios"/etc.
			expect(listTasksGate(ctx, "helios-iris-rh", undefined)).toMatch(
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
	const ctx = heliosCtx();

	it("master scope: any createdBy passes", () => {
		const rows = [{ createdBy: "Outsider", namespace: undefined }];
		expect(scopeFilterList(masterCtx() as any, rows)).toHaveLength(1);
	});

	it("non-master: row with createdBy=Helios passes (exact in fromAllowList)", () => {
		const rows = [{ createdBy: "Helios" }];
		expect(scopeFilterList(ctx as any, rows)).toHaveLength(1);
	});

	it("non-master: row with createdBy=Clio passes", () => {
		const rows = [{ createdBy: "Clio" }];
		expect(scopeFilterList(ctx as any, rows)).toHaveLength(1);
	});

	it("non-master: row with createdBy=Victor passes", () => {
		const rows = [{ createdBy: "Victor" }];
		expect(scopeFilterList(ctx as any, rows)).toHaveLength(1);
	});

	it("non-master: row with createdBy=Outsider is filtered out", () => {
		const rows = [{ createdBy: "Outsider" }];
		expect(scopeFilterList(ctx as any, rows)).toHaveLength(0);
	});

	it("non-master: mixed rows filtered correctly", () => {
		const rows = [
			{ createdBy: "Helios" },
			{ createdBy: "Outsider" },
			{ createdBy: "Clio" },
			{ createdBy: "attacker" },
		];
		const filtered = scopeFilterList(ctx as any, rows);
		expect(filtered).toHaveLength(2);
		expect(filtered.map((r) => r.createdBy)).toEqual(["Helios", "Clio"]);
	});

	it("non-master: no rows → empty (no crash)", () => {
		expect(scopeFilterList(ctx as any, [])).toHaveLength(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. list_briefing_notes — symmetric audit via scopeFilterList
// ─────────────────────────────────────────────────────────────────────────────

describe("list_briefing_notes — scopeFilterList symmetric audit", () => {
	const ctx = heliosCtx();

	it("master scope: any row passes", () => {
		const rows = [{ createdBy: "anyone" }];
		expect(scopeFilterList(masterCtx() as any, rows)).toHaveLength(1);
	});

	it("non-master: row with createdBy=Helios passes", () => {
		const rows = [{ createdBy: "Helios" }];
		expect(scopeFilterList(ctx as any, rows)).toHaveLength(1);
	});

	it("non-master: row with createdBy=hélios passes (accent variant in list)", () => {
		// "hélios" is in fromAllowList verbatim — exact match
		const rows = [{ createdBy: "hélios" }];
		expect(scopeFilterList(ctx as any, rows)).toHaveLength(1);
	});

	it("non-master: row with createdBy=Outsider is filtered out", () => {
		const rows = [{ createdBy: "Outsider" }];
		expect(scopeFilterList(ctx as any, rows)).toHaveLength(0);
	});

	it("non-master: row with namespace matching prefix passes", () => {
		const rows = [{ namespace: "orchestrator/helios-iris-rh/notes" }];
		expect(scopeFilterList(ctx as any, rows)).toHaveLength(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. list_peers — symmetric audit via scopeFilterList
// ─────────────────────────────────────────────────────────────────────────────

describe("list_peers — scopeFilterList symmetric audit", () => {
	const ctx = heliosCtx();

	it("master scope: any row passes", () => {
		const rows = [{ createdBy: "anyone" }];
		expect(scopeFilterList(masterCtx() as any, rows)).toHaveLength(1);
	});

	it("non-master: peer with createdBy=Helios passes", () => {
		const rows = [{ createdBy: "Helios" }];
		expect(scopeFilterList(ctx as any, rows)).toHaveLength(1);
	});

	it("non-master: peer with createdBy=Victor passes", () => {
		const rows = [{ createdBy: "Victor" }];
		expect(scopeFilterList(ctx as any, rows)).toHaveLength(1);
	});

	it("non-master: peer with createdBy=Outsider is filtered out", () => {
		const rows = [{ createdBy: "Outsider" }];
		expect(scopeFilterList(ctx as any, rows)).toHaveLength(0);
	});

	it("non-master: multiple peers, only TRIO members visible", () => {
		const rows = [
			{ createdBy: "Helios" },
			{ createdBy: "Clio" },
			{ createdBy: "Victor" },
			{ createdBy: "ExternalBot" },
		];
		const filtered = scopeFilterList(ctx as any, rows);
		expect(filtered).toHaveLength(3);
	});
});
