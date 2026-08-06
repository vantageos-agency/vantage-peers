/**
 * Validation smoke test for the Process Component Manifest schema.
 *
 * Two fixtures:
 *  1. `completeManifest` — all 9 layers present, eval PASS. MUST validate.
 *  2. `missingScriptManifest` — same as (1) but with `scripts: []`. MUST FAIL
 *     the CR-1 completeness validator (layer 5 missing).
 *
 * Fictional component: "changelog-fragment-rollup" — a small, believable
 * Process Component that scaffolds + validates + rolls up CHANGELOG fragments
 * (mirrors the real `changelog-release-fragments-fleet` runbook cited in
 * analysis/process-component-reuse-map.md §1.1, but this manifest and all its
 * IDs/hashes are fictional for test purposes only).
 *
 * Run: `npx vitest run schemas/process-component-manifest.schema.test.ts`
 * Orchestrator: Omega — VantageOS Team | 2026-08-06
 */
import { describe, expect, it } from "vitest";
import {
	assertManifestComplete,
	type ProcessComponentManifest,
	processComponentManifestSchema,
} from "./process-component-manifest.schema";

const FAKE_SHA = "a".repeat(64);

const baseSourceRef = (kind: "file" | "vr-runbook" | "vr-skill" | "vr-hook", ref: string) => ({
	kind,
	ref,
	contentHash: FAKE_SHA,
	todoByteEndpoint: false,
});

const completeManifest: ProcessComponentManifest = {
	name: "changelog-fragment-rollup",
	version: "1.0.0",
	stage: "ga",
	layers: {
		missionTemplate: {
			name: "changelog-rollup-v1",
			source: baseSourceRef("file", "missions/changelog-rollup-v1.json"),
		},
		runbook: {
			name: "changelog-release-fragments-fleet",
			vrId: "kd77zq77t367w8gecwrtsvq60989cxfq",
			source: { kind: "vr-runbook", ref: "kd77zq77t367w8gecwrtsvq60989cxfq", todoByteEndpoint: true },
		},
		skills: [
			{
				name: "changelog-fragment-scaffold",
				source: baseSourceRef("vr-skill", "changelog-fragment-scaffold"),
			},
		],
		rules: [
			{
				name: "changelog-fragments-doctrine",
				source: baseSourceRef("file", ".claude/rules/changelog-fragments-doctrine.md"),
			},
		],
		scripts: [
			{
				name: "changelog-release.mjs",
				invocation: "node scripts/changelog-release.mjs --dry-run",
				source: baseSourceRef("file", "scripts/changelog-release.mjs"),
			},
		],
		deliverableSchema: {
			name: "changelog-fragment.schema.ts",
			source: { kind: "file", ref: "schemas/changelog-fragment.schema.ts", todoByteEndpoint: true },
			nonDeterministicFields: ["mergedAt"],
		},
		exampleDeliverables: [
			{
				name: "example-fragment-fix-t3p3.md",
				source: { kind: "file", ref: "changes/fix-t3p3-ledger-purge-cron.md", todoByteEndpoint: true },
				producedBy: "changelog-fragment-scaffold",
			},
		],
		eval: {
			corpus: { kind: "file", ref: "evals/changelog-fragment-rollup.json", todoByteEndpoint: true },
			runner: "node scripts/tests/changelog-fragment-rollup.eval.mjs",
			lastResult: { status: "pass", runAt: "2026-08-06T00:00:00.000Z", failingCases: [] },
		},
		hooks: {
			applicable: true,
			hooks: [
				{
					name: "enforce-pr-docs-sync",
					source: baseSourceRef("vr-hook", "enforce-pr-docs-sync"),
					failClosedBehavior: "blocks the PR with an explicit error naming the missing changes/*.md fragment",
				},
			],
		},
	},
	consumers: [{ name: "vantage-registry", minStage: "ga", linkType: "uses" }],
	overrideCounters: [{ gate: "enforce-pr-docs-sync", windowDays: 30, fixPatternRefRequired: true }],
	standardConformance: {
		standardVersion: "v1",
		evalResult: "pass",
		criticalRulesChecked: ["CR-1", "CR-3", "CR-5"],
	},
};

describe("processComponentManifestSchema", () => {
	it("VALIDATES a complete manifest with all 9 layers + eval PASS", () => {
		const parsed = processComponentManifestSchema.parse(completeManifest);
		const result = assertManifestComplete(parsed);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("FAILS Zod shape-validation AND the CR-1 completeness validator when layer 5 (scripts) is empty", () => {
		const missingScriptManifest: ProcessComponentManifest = {
			...completeManifest,
			layers: {
				...completeManifest.layers,
				scripts: [],
			},
		};

		// The Zod schema itself already enforces `scripts: min(1)` — a manifest
		// with an empty scripts array is rejected at parse time. This is the
		// schema-layer half of CR-1's "missing layer" rejection.
		expect(() => processComponentManifestSchema.parse(missingScriptManifest)).toThrow(/scripts/);

		// The CR-1 completeness validator provides a second, independent line of
		// defense — it re-asserts layer-presence even against an object that
		// bypassed schema parsing (e.g. constructed programmatically, or parsed
		// with `.passthrough()`/partial validation upstream) — proving CR-1 is
		// enforced at the business-rule layer too, not only by the Zod shape.
		const result = assertManifestComplete(missingScriptManifest);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("layer 5 (scripts) missing or empty — CR-1 requires ≥1 script");
	});

	it("FAILS Zod shape-validation when hooks is not-applicable without a reason", () => {
		const badHooks = {
			...completeManifest,
			layers: {
				...completeManifest.layers,
				hooks: { applicable: false }, // missing hooksNotApplicableReason
			},
		};
		expect(() => processComponentManifestSchema.parse(badHooks)).toThrow();
	});
});
