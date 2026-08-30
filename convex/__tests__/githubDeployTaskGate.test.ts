// convex/__tests__/githubDeployTaskGate.test.ts
//
// UPDATE (task k1739e72yrkx4twyj6gwr2x6818dfggk): the deploy-notice generator
// `buildDeployTaskPayload()` (convex/githubDeployGate.ts) and its call site in
// convex/http.ts have been REMOVED. It filed an urgent-looking, autonomously
// assigned "laurent" task on EVERY merged PR whose diff touched a deployable
// convex/ path — 176 dead rows since April, because PROD is token-gated on a
// token only the coordinator (Pi) holds, so the row was never actionable.
// The deploy decision belongs to the coordinator's merge authorization, not a
// separate notice.
//
// SECURITY CONTEXT (task k174khqgkhgps846dhypwfz8b58a4fe1, prior incident):
// The pure predicate below (`prTouchesDeployableConvex`) SURVIVES this change
// — it has a second consumer in convex/http.ts (the `hasConvex` diagnostic-log
// branch, http.ts:569) independent of the removed task-filing call site. It
// remains load-bearing: do not remove it. See the module header in
// convex/githubDeployGate.ts for the Day 103 incident (~50 PROD indexes
// wiped) this predicate was built to prevent.
//
// This suite specifies the ONE surviving pure helper:
//
//   export function prTouchesDeployableConvex(filenames: string[]): boolean
//
// Required end-state (unchanged from before this task):
//   Deployable   : `convex/...` or `apps/<pkg>/convex/...`
//   NOT deployable: anything under convex/tests/, convex/__tests__/,
//                   convex/_generated/ (and the same three under
//                   apps/<pkg>/convex/). Everything else -> false.
//
// TWO-POLE EVIDENCE (buildDeployTaskPayload removal, task-filing behaviour):
// see convex/__tests__/auto-deploy-gating.test.ts, describe block
// "auto-deploy-on-merge gating (http.ts) — generator removed", test H:
//   RED  (before this change, old code): the SAME merged-PR-touching-
//         convex/schema.ts payload created exactly 1 "deploy"-tagged task
//         (this was the previous passing assertion,
//         `expect(countAfter).toBe(countBefore + 1)`, git-history in this
//         file's prior revision).
//   GREEN (after this change): the identical payload creates 0 tasks
//         (`expect(taskCountAfter).toBe(taskCountBefore)` with
//         taskCountBefore === 0 in a fresh convexTest instance) and sends
//         0 system notify messages.

import { describe, expect, test } from "vitest";
import { prTouchesDeployableConvex } from "../githubDeployGate";

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
