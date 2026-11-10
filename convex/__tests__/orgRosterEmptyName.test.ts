import { describe, expect, it } from "vitest";
import { isOrchestratorOnOrgRoster } from "../lib/auth";

// An empty claimed name never matches an empty roster entry, in step with the
// @vantageos/cloud-identity 0.35.0 scope filters (task k1726h1v7hqdbk818bn8s1rgdx8hy0ts).
const scope = { allowedOrchestrators: ["", "Ada"] };

describe("isOrchestratorOnOrgRoster empty name", () => {
	it("refuses an empty claimed name against an empty roster entry", () => {
		expect(isOrchestratorOnOrgRoster(scope, "")).toBe(false);
	});
	it("refuses a whitespace-only claimed name (trimmed to empty)", () => {
		expect(isOrchestratorOnOrgRoster(scope, "  ")).toBe(false);
	});
	it("serves a case-twin of a listed name", () => {
		expect(isOrchestratorOnOrgRoster(scope, "ada")).toBe(true);
	});
	it("refuses an unlisted name", () => {
		expect(isOrchestratorOnOrgRoster(scope, "bram")).toBe(false);
	});
});
