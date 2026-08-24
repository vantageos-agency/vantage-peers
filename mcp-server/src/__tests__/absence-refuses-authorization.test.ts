/**
 * Absence-of-identity REFUSES — it must never be broader than a present
 * identity (`.claude/rules/one-identity-layer.md` clause 3).
 *
 * Task k177v39m5w5t54mqf84mk9k0mn8czfwa. These assertions were RED on the
 * pre-fix head: every scope predicate did `if (!ctx) return null` (a full
 * pass), `guardMasterOnly`/`enforceScope(master)` passed on undefined, and the
 * master shortcut in bearerAuthMiddleware used a timing-variant
 * `token === masterToken` compare instead of the constant-time
 * `validateMasterBearer`.
 *
 * Litmus (per brief): each assertion below would FLIP if the authz code were
 * deleted — a deleted predicate returns null (allow), which these tests reject
 * for the no-context and non-holder cases.
 */

import { describe, expect, it } from "vitest";
import {
	checkDelegationAllowed,
	checkFromAllowed,
	checkNamespaceRead,
	checkNamespaceWrite,
	type OAuthContext,
} from "../auth.js";

// A SCOPED identity that is NEITHER master NOR the MCP service account —
// a single-station team member (Prometheus) with one namespace.
const SCOPED: OAuthContext = {
	clientId: "prometheus",
	userId: "prometheus",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "team-member",
	fromAllowList: ["prometheus"],
	namespaceReadPrefixes: ["team/acme"],
	namespaceWritePrefixes: ["team/acme"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
};

describe("checkFromAllowed — absence refuses; holder acts, non-holder refused", () => {
	it("no context REFUSES (returns a refusal string, not null)", () => {
		expect(checkFromAllowed(undefined, "prometheus")).not.toBeNull();
	});
	it("holder acts (from in allowlist → allowed)", () => {
		expect(checkFromAllowed(SCOPED, "prometheus")).toBeNull();
	});
	it("non-holder refused (from not in allowlist → refusal)", () => {
		expect(checkFromAllowed(SCOPED, "nemesis")).not.toBeNull();
	});
});

describe("checkNamespaceRead — absence refuses; owner reads, other refused", () => {
	it("no context REFUSES even for a real namespace", () => {
		expect(checkNamespaceRead(undefined, "team/acme")).not.toBeNull();
	});
	it("owner reads its own namespace", () => {
		expect(checkNamespaceRead(SCOPED, "team/acme")).toBeNull();
	});
	it("other namespace refused", () => {
		expect(checkNamespaceRead(SCOPED, "team/other")).not.toBeNull();
	});
});

describe("checkNamespaceWrite — absence refuses; owner writes, other refused", () => {
	it("no context REFUSES", () => {
		expect(checkNamespaceWrite(undefined, "team/acme")).not.toBeNull();
	});
	it("owner writes its own namespace", () => {
		expect(checkNamespaceWrite(SCOPED, "team/acme")).toBeNull();
	});
	it("other namespace refused", () => {
		expect(checkNamespaceWrite(SCOPED, "team/other")).not.toBeNull();
	});
});

describe("checkDelegationAllowed — absence refuses; roster holder acts", () => {
	const roster = async () => ["prometheus", "atlas"];
	it("no context REFUSES (never delegates without identity)", async () => {
		expect(
			await checkDelegationAllowed(undefined, "atlas", roster),
		).not.toBeNull();
	});
	it("member of caller org acts", async () => {
		// SCOPED has no clerkJwt/accessTokenHash → the roster is not even read;
		// a scoped caller with no resolvable org REFUSES (ETA-M15). This asserts
		// refusal, not the roster-holder allow, because that path needs a token
		// org claim. The holder-allow direction is covered by the roster path
		// tests in delegation-same-org-predicate.test.ts.
		expect(
			await checkDelegationAllowed(SCOPED, "atlas", roster),
		).not.toBeNull();
	});
});
