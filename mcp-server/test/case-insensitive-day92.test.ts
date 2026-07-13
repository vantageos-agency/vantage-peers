/**
 * Day 92 C2 — case-insensitive + Unicode NFC normalization for orchestrator-id
 * fields. B2 standard §6 (case-insensitive) + §7 (NFC normalization).
 *
 * TDD order: RED phase first — this file is committed before the helper exists.
 * Import will fail on RED run; GREEN phase implements the helper + wires gates.
 *
 * Test variants:
 *  - Pure normalizeOrchestratorId helper (12 assertions)
 *  - isInAllowList helper (8 assertions)
 *  - listTasksGate via normalized comparison (10 assertions)
 *  Total: 30+ assertions
 *
 * Reference: mission k57a36y8w5t085bqr23dsmvb2d882506, task k171h140m044rpr0ayh4fmpqvd883sk4
 * Pi-authorized merge token: k17f493gw0cpbr3nxkvcc09ngn884n22
 */

import { describe, expect, it } from "vitest";
import {
	normalizeOrchestratorId,
	isInAllowList,
} from "../src/normalizeOrchestratorId.js";
import { listTasksGate } from "../src/list-tasks-gate.js";
import type { OAuthContext } from "../src/auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// TRIO fromAllowList fixture — Zoé + zoe + Zoé (NFD) + ZOE + Milo
// ─────────────────────────────────────────────────────────────────────────────

/** "Zoé" decomposed NFD form (Z + o + e + ́) */
const ZOE_NFD = "Zoé";
/** "Zoé" composed NFC form */
const ZOE_NFC = "Zoé";
/** "zoé" composed NFC lowercase */
const ZOE_LC_NFC = "zoé";

const TRIO_FROM_ALLOW_LIST = [
  "Milo",
  "milo",
  ZOE_NFC, // "Zoé" NFC
  "Zoe",
  "zoe",
  ZOE_LC_NFC, // "zoé" NFC
  "Victor",
  "victor",
];

function zoeCtx(fromAllowList = TRIO_FROM_ALLOW_LIST): OAuthContext {
  return {
    clientId: "2e5d41df-b8f8-4f1a-95aa-2eb0d6bdadb7",
    userId: "zoe-acme-hr",
    scopes: ["vantage:read", "vantage:write"],
    scopeProfile: "zoe-acme-hr",
    fromAllowList,
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
// 1. normalizeOrchestratorId helper — 12 assertions
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeOrchestratorId", () => {
  it("lowercases ASCII identifiers", () => {
    expect(normalizeOrchestratorId("Zoe")).toBe("zoe");
  });

  it("lowercases ALL-CAPS identifiers", () => {
    expect(normalizeOrchestratorId("ZOE")).toBe("zoe");
  });

  it("leaves already-lowercase ASCII identifiers unchanged", () => {
    expect(normalizeOrchestratorId("zoe")).toBe("zoe");
  });

  it("NFC normalizes a composed accented string and lowercases", () => {
    // ZOE_NFC = "Zoé" → normalize → "zoé"
    expect(normalizeOrchestratorId(ZOE_NFC)).toBe(ZOE_LC_NFC);
  });

  it("NFC normalizes a decomposed NFD string to the same canonical form", () => {
    // ZOE_NFD = "Zoé" → NFC → "Zoé" → lower → "zoé"
    expect(normalizeOrchestratorId(ZOE_NFD)).toBe(ZOE_LC_NFC);
  });

  it("NFC+lowercase of composed == NFC+lowercase of decomposed (invariant)", () => {
    expect(normalizeOrchestratorId(ZOE_NFC)).toBe(
      normalizeOrchestratorId(ZOE_NFD),
    );
  });

  it("trims leading whitespace", () => {
    expect(normalizeOrchestratorId("  zoe")).toBe("zoe");
  });

  it("trims trailing whitespace", () => {
    expect(normalizeOrchestratorId("zoe  ")).toBe("zoe");
  });

  it("trims and normalizes combined", () => {
    expect(normalizeOrchestratorId("  ZOE  ")).toBe("zoe");
  });

  it("handles a simple lowercase identifier (pi)", () => {
    expect(normalizeOrchestratorId("pi")).toBe("pi");
  });

  it("lowercases Greek-named orchestrator (Pi)", () => {
    expect(normalizeOrchestratorId("Pi")).toBe("pi");
  });

  it("lowercases mixed orchestrator name (Sigma)", () => {
    expect(normalizeOrchestratorId("Sigma")).toBe("sigma");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. isInAllowList helper — 8 assertions
// ─────────────────────────────────────────────────────────────────────────────

describe("isInAllowList", () => {
  it("matches ZOE (uppercase) against list containing Zoe", () => {
    expect(isInAllowList(TRIO_FROM_ALLOW_LIST, "ZOE")).toBe(true);
  });

  it("matches Zoé NFC (composed) against list", () => {
    expect(isInAllowList(TRIO_FROM_ALLOW_LIST, ZOE_NFC)).toBe(true);
  });

  it("matches Zoé NFD (decomposed) against list after NFC normalization", () => {
    expect(isInAllowList(TRIO_FROM_ALLOW_LIST, ZOE_NFD)).toBe(true);
  });

  it("matches zoe (lowercase) against list", () => {
    expect(isInAllowList(TRIO_FROM_ALLOW_LIST, "zoe")).toBe(true);
  });

  it("matches Milo (capitalised) against list containing milo + Milo", () => {
    expect(isInAllowList(TRIO_FROM_ALLOW_LIST, "Milo")).toBe(true);
  });

  it("matches Victor (capitalised) against list", () => {
    expect(isInAllowList(TRIO_FROM_ALLOW_LIST, "Victor")).toBe(true);
  });

  it("rejects Outsider not in allowList", () => {
    expect(isInAllowList(TRIO_FROM_ALLOW_LIST, "Outsider")).toBe(false);
  });

  it("passes wildcard * regardless of presented value", () => {
    expect(isInAllowList(["*"], "anything")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. listTasksGate with NFC-normalized comparison — 10 assertions
// ─────────────────────────────────────────────────────────────────────────────

describe("listTasksGate — case-insensitive + NFC (Day 92 C2)", () => {
  it("allows ZOE (all caps) as assignedTo with TRIO list", () => {
    const err = listTasksGate(zoeCtx(), "ZOE", undefined);
    expect(err).toBeNull();
  });

  it("allows Zoé NFC (composed) as assignedTo", () => {
    const err = listTasksGate(zoeCtx(), ZOE_NFC, undefined);
    expect(err).toBeNull();
  });

  it("allows Zoé NFD (decomposed) as assignedTo after normalize", () => {
    const err = listTasksGate(zoeCtx(), ZOE_NFD, undefined);
    expect(err).toBeNull();
  });

  it("allows zoe (lowercase) as assignedTo", () => {
    const err = listTasksGate(zoeCtx(), "zoe", undefined);
    expect(err).toBeNull();
  });

  it("allows zoé (lowercase NFC) as assignedTo", () => {
    const err = listTasksGate(zoeCtx(), ZOE_LC_NFC, undefined);
    expect(err).toBeNull();
  });

  it("allows Milo as createdBy", () => {
    const err = listTasksGate(zoeCtx(), undefined, "Milo");
    expect(err).toBeNull();
  });

  it("allows MILO (all caps) as createdBy", () => {
    const err = listTasksGate(zoeCtx(), undefined, "MILO");
    expect(err).toBeNull();
  });

  it("rejects Outsider as assignedTo (not in TRIO list)", () => {
    const err = listTasksGate(zoeCtx(), "Outsider", undefined);
    expect(err).not.toBeNull();
    expect(err).toContain("Forbidden");
  });

  it("master scope always passes through (null)", () => {
    const err = listTasksGate(masterCtx(), "ZOE", undefined);
    expect(err).toBeNull();
  });

  it("undefined oauthCtx (legacy bearer) always passes through (null)", () => {
    const err = listTasksGate(undefined, "ZOE", undefined);
    expect(err).toBeNull();
  });
});
