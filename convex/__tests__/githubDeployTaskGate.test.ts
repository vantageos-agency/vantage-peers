// allow-missing-refs: convex/githubDeployGate.ts is the NEW module the GREEN
// step will create. This RED-step test asserts the module does not exist yet
// and specifies the required behavior of its two exported pure helpers.
//
// SECURITY CONTEXT (task k174khqgkhgps846dhypwfz8b58a4fe1, urgent):
// The GitHub pull_request.closed+merged handler (convex/http.ts:493-609)
// creates an urgent, autonomously-assigned deploy task on EVERY qualifying
// merge whose description embeds a paste-ready `npx convex deploy --yes`.
// That is the exact condition of the Day 103 incident (~50 PROD indexes
// wiped). Root cause: the "Day 102" diff gate at http.ts:523-574 uses the
// predicate /^convex\//.test(name) || /^apps\/[^/]+\/convex\//.test(name),
// which matches TEST files under convex/tests/ too. PR #209 changed only
// scripts/uc1/joeai-csv-interne.cjs, scripts/uc1/lib/joeai-csv-lib.cjs and
// convex/tests/uc1/joeai_csv.test.ts — no Convex function was served, yet
// hasConvex === true fired an urgent deploy task.
//
// This suite specifies two pure helpers from a NEW module
// convex/githubDeployGate.ts (NOT created here — GREEN step will create it):
//
//   export function prTouchesDeployableConvex(filenames: string[]): boolean
//   export function buildDeployTaskPayload(args: {
//     prNumber: number; prTitle: string; mergedBy: string; htmlUrl: string; project: string;
//   }): { title: string; description: string; priority: "medium"; assignedTo: "laurent" }
//
// Required end-state:
//   1. Emit ONLY if diff touches convex/ OUTSIDE convex/tests/ (also exclude
//      convex/__tests__/ and convex/_generated/). Otherwise: no task.
//   2. When emitted: priority "medium", assignee is a HUMAN ("laurent"), never
//      an autonomous orchestrator.
//   3. Description contains NO paste-ready deploy command — it states the gate:
//      PROD is token-gated, a Pi [PROD-DEPLOY-AUTHORIZED] token is required
//      (publish-protocol.md).
//   4. Title: `[Deploy?] PR #N merged — diff touche convex/, deploy PROD a arbitrer`.

import { describe, expect, test } from "vitest";
import {
	buildDeployTaskPayload,
	prTouchesDeployableConvex,
} from "../githubDeployGate";

describe("prTouchesDeployableConvex", () => {
	test("PR #209 regression payload: convex/tests/ only -> false (must NOT fire urgent deploy)", () => {
		const filenames = [
			"scripts/uc1/joeai-csv-interne.cjs",
			"scripts/uc1/lib/joeai-csv-lib.cjs",
			"convex/tests/uc1/joeai_csv.test.ts",
		];
		expect(prTouchesDeployableConvex(filenames)).toBe(false);
	});

	test("deployable convex/ path -> true", () => {
		expect(prTouchesDeployableConvex(["convex/uc1/foo.ts"])).toBe(true);
	});

	test("convex/tests/ path -> false", () => {
		expect(prTouchesDeployableConvex(["convex/tests/x.test.ts"])).toBe(false);
	});

	test("convex/__tests__/ path -> false", () => {
		expect(
			prTouchesDeployableConvex(["convex/__tests__/y.test.ts"]),
		).toBe(false);
	});

	test("convex/_generated/ path -> false", () => {
		expect(
			prTouchesDeployableConvex(["convex/_generated/api.d.ts"]),
		).toBe(false);
	});

	test("apps/<name>/convex/ deployable path -> true", () => {
		expect(
			prTouchesDeployableConvex(["apps/web/convex/foo.ts"]),
		).toBe(true);
	});

	test("apps/<name>/convex/tests/ path -> false", () => {
		expect(
			prTouchesDeployableConvex(["apps/web/convex/tests/foo.test.ts"]),
		).toBe(false);
	});

	test("unrelated file -> false", () => {
		expect(prTouchesDeployableConvex(["README.md"])).toBe(false);
	});

	test("mixed diff: one test-only file + one deployable file -> true", () => {
		expect(
			prTouchesDeployableConvex([
				"convex/tests/a.test.ts",
				"convex/schema.ts",
			]),
		).toBe(true);
	});
});

describe("buildDeployTaskPayload", () => {
	const args = {
		prNumber: 209,
		prTitle: "fix(uc1): joeai csv lib + test",
		mergedBy: "someone",
		htmlUrl: "https://github.com/org/vantage-memory/pull/209",
		project: "vantage-memory",
	};

	test("title matches [Deploy?] PR #209 merged pattern", () => {
		const p = buildDeployTaskPayload(args);
		expect(p.title).toMatch(/^\[Deploy\?\] PR #209 merged/);
	});

	test("priority is medium (never urgent)", () => {
		const p = buildDeployTaskPayload(args);
		expect(p.priority).toBe("medium");
	});

	test("assignedTo is the human laurent (never an autonomous orchestrator)", () => {
		const p = buildDeployTaskPayload(args);
		expect(p.assignedTo).toBe("laurent");
	});

	test("description contains NO paste-ready `npx convex deploy` command", () => {
		const p = buildDeployTaskPayload(args);
		expect(p.description).not.toMatch(/npx convex deploy/);
	});

	test("description contains NO `git checkout main` command", () => {
		const p = buildDeployTaskPayload(args);
		expect(p.description).not.toMatch(/git checkout main/);
	});

	test("description mentions the PROD-DEPLOY-AUTHORIZED gate", () => {
		const p = buildDeployTaskPayload(args);
		expect(p.description).toMatch(/PROD-DEPLOY-AUTHORIZED/);
	});

	test("description still carries the PR html_url", () => {
		const p = buildDeployTaskPayload(args);
		expect(p.description).toContain(args.htmlUrl);
	});
});
