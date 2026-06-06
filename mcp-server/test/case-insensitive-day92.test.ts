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
} from "../../convex/_helpers/normalizeOrchestratorId.js";
import { listTasksGate } from "../src/list-tasks-gate.js";
import type { OAuthContext } from "../src/auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// TRIO fromAllowList fixture — Hélios + helios + Hélios (NFD) + HELIOS + Clio
// ─────────────────────────────────────────────────────────────────────────────

/** "Hélios" decomposed NFD form (H + e + ́ + lios) */
const HELIOS_NFD = "Hélios";
/** "Hélios" composed NFC form */
const HELIOS_NFC = "Hélios";
/** "hélios" composed NFC lowercase */
const HELIOS_LC_NFC = "hélios";

const TRIO_FROM_ALLOW_LIST = [
  "Clio",
  "clio",
  HELIOS_NFC, // "Hélios" NFC
  "Helios",
  "helios",
  HELIOS_LC_NFC, // "hélios" NFC
  "Victor",
  "victor",
];

function heliosCtx(fromAllowList = TRIO_FROM_ALLOW_LIST): OAuthContext {
  return {
    clientId: "2e5d41df-b8f8-4f1a-95aa-2eb0d6bdadb7",
    userId: "helios-iris-rh",
    scopes: ["vantage:read", "vantage:write"],
    scopeProfile: "helios-iris-rh",
    fromAllowList,
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
// 1. normalizeOrchestratorId helper — 12 assertions
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeOrchestratorId", () => {
  it("lowercases ASCII identifiers", () => {
    expect(normalizeOrchestratorId("Helios")).toBe("helios");
  });

  it("lowercases ALL-CAPS identifiers", () => {
    expect(normalizeOrchestratorId("HELIOS")).toBe("helios");
  });

  it("leaves already-lowercase ASCII identifiers unchanged", () => {
    expect(normalizeOrchestratorId("helios")).toBe("helios");
  });

  it("NFC normalizes a composed accented string and lowercases", () => {
    // HELIOS_NFC = "Hélios" → normalize → "hélios"
    expect(normalizeOrchestratorId(HELIOS_NFC)).toBe(HELIOS_LC_NFC);
  });

  it("NFC normalizes a decomposed NFD string to the same canonical form", () => {
    // HELIOS_NFD = "Hélios" → NFC → "Hélios" → lower → "hélios"
    expect(normalizeOrchestratorId(HELIOS_NFD)).toBe(HELIOS_LC_NFC);
  });

  it("NFC+lowercase of composed == NFC+lowercase of decomposed (invariant)", () => {
    expect(normalizeOrchestratorId(HELIOS_NFC)).toBe(
      normalizeOrchestratorId(HELIOS_NFD),
    );
  });

  it("trims leading whitespace", () => {
    expect(normalizeOrchestratorId("  helios")).toBe("helios");
  });

  it("trims trailing whitespace", () => {
    expect(normalizeOrchestratorId("helios  ")).toBe("helios");
  });

  it("trims and normalizes combined", () => {
    expect(normalizeOrchestratorId("  HELIOS  ")).toBe("helios");
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
  it("matches HELIOS (uppercase) against list containing Helios", () => {
    expect(isInAllowList(TRIO_FROM_ALLOW_LIST, "HELIOS")).toBe(true);
  });

  it("matches Hélios NFC (composed) against list", () => {
    expect(isInAllowList(TRIO_FROM_ALLOW_LIST, HELIOS_NFC)).toBe(true);
  });

  it("matches Hélios NFD (decomposed) against list after NFC normalization", () => {
    expect(isInAllowList(TRIO_FROM_ALLOW_LIST, HELIOS_NFD)).toBe(true);
  });

  it("matches helios (lowercase) against list", () => {
    expect(isInAllowList(TRIO_FROM_ALLOW_LIST, "helios")).toBe(true);
  });

  it("matches Clio (capitalised) against list containing clio + Clio", () => {
    expect(isInAllowList(TRIO_FROM_ALLOW_LIST, "Clio")).toBe(true);
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
  it("allows HELIOS (all caps) as assignedTo with TRIO list", () => {
    const err = listTasksGate(heliosCtx(), "HELIOS", undefined);
    expect(err).toBeNull();
  });

  it("allows Hélios NFC (composed) as assignedTo", () => {
    const err = listTasksGate(heliosCtx(), HELIOS_NFC, undefined);
    expect(err).toBeNull();
  });

  it("allows Hélios NFD (decomposed) as assignedTo after normalize", () => {
    const err = listTasksGate(heliosCtx(), HELIOS_NFD, undefined);
    expect(err).toBeNull();
  });

  it("allows helios (lowercase) as assignedTo", () => {
    const err = listTasksGate(heliosCtx(), "helios", undefined);
    expect(err).toBeNull();
  });

  it("allows hélios (lowercase NFC) as assignedTo", () => {
    const err = listTasksGate(heliosCtx(), HELIOS_LC_NFC, undefined);
    expect(err).toBeNull();
  });

  it("allows Clio as createdBy", () => {
    const err = listTasksGate(heliosCtx(), undefined, "Clio");
    expect(err).toBeNull();
  });

  it("allows CLIO (all caps) as createdBy", () => {
    const err = listTasksGate(heliosCtx(), undefined, "CLIO");
    expect(err).toBeNull();
  });

  it("rejects Outsider as assignedTo (not in TRIO list)", () => {
    const err = listTasksGate(heliosCtx(), "Outsider", undefined);
    expect(err).not.toBeNull();
    expect(err).toContain("Forbidden");
  });

  it("master scope always passes through (null)", () => {
    const err = listTasksGate(masterCtx(), "HELIOS", undefined);
    expect(err).toBeNull();
  });

  it("undefined oauthCtx (legacy bearer) always passes through (null)", () => {
    const err = listTasksGate(undefined, "HELIOS", undefined);
    expect(err).toBeNull();
  });
});
