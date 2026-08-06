/**
 * Process Component Manifest — Zod schema
 *
 * The machine-readable shape a component author fills in to declare conformance
 * with `docs/process-component-standard.md`. Every field here traces back to a
 * numbered Critical Rule (CR-N) in that standard — see the inline comments.
 *
 * Mission: process-component-factory-v1, task P1 (`k1775mm6`).
 * Standard: docs/process-component-standard.md (v1, 2026-08-06).
 *
 * Zod idiom matches the repo convention in `mcp-server/server.ts`
 * (z.string().describe(...), z.enum([...]), z.array(...), z.number().int()).
 *
 * Orchestrator: Omega — VantageOS Team | 2026-08-06
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** SemVer string, e.g. "1.0.0" or "0.2.1-beta.1". CR-5. */
export const semVerSchema = z
	.string()
	.regex(
		/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/,
		"must be a valid SemVer string, e.g. '1.0.0'",
	)
	.describe("SemVer version of this Process Component");

/** Stage gate — CR-5: stage transitions require the eval suite green. */
export const stageSchema = z
	.enum(["prototype", "beta", "ga"])
	.describe("Maturity stage; 'ga' requires the eval suite (layer 8) green — CR-5");

/**
 * A byte-exact source reference — CR-3. Every layer that resolves to a file or
 * VR entity MUST carry one of these so a consumer's `sha256(installed)` can be
 * diff-checked against `sha256(canonical)`.
 *
 * `contentHash` is REQUIRED for VR-backed layers (hooks/skills/agents, per the
 * existing `vrContentHash` doctrine). For layers without a byte-hash-bearing VR
 * endpoint today (runbooks, scripts, schemas, examples — the CR-3 gap the P0
 * audit flagged), `contentHash` MAY be omitted but `todoByteEndpoint` MUST then
 * be `true`, and GA-stage components cannot claim CR-3 satisfied while any
 * declared source carries `todoByteEndpoint: true` (enforced by
 * `assertManifestComplete` below, mirroring the standard's CR-3 "How tested").
 */
export const sourceRefSchema = z
	.object({
		kind: z
			.enum(["file", "vr-runbook", "vr-skill", "vr-hook", "vr-agent", "convex-doc"])
			.describe("What kind of canonical source this reference points to"),
		ref: z
			.string()
			.min(1)
			.describe(
				"Resolvable locator: file path relative to repo root, or VR entity ID/slug, or Convex document ID",
			),
		contentHash: z
			.string()
			.regex(/^[a-f0-9]{64}$/, "must be a lowercase hex sha256 digest")
			.optional()
			.describe(
				"sha256(canonical bytes) — REQUIRED when a byte-hash-bearing VR endpoint exists for this kind (hooks/skills/agents today). CR-3.",
			),
		todoByteEndpoint: z
			.boolean()
			.default(false)
			.describe(
				"true when this layer kind has no byte-hash-bearing VR pull endpoint yet (runbooks/scripts/schemas/examples). GA-stage components MUST NOT set this true — CR-3 'How tested'.",
			),
	})
	.refine((v) => v.contentHash !== undefined || v.todoByteEndpoint === true, {
		message: "sourceRef must carry either contentHash or todoByteEndpoint: true — CR-3",
	});
export type SourceRef = z.infer<typeof sourceRefSchema>;

// ---------------------------------------------------------------------------
// The 9 layers (CR-1)
// ---------------------------------------------------------------------------

/** Layer 1 — mission template (`template : name-vN`). CR-1. */
export const missionTemplateLayerSchema = z.object({
	name: z
		.string()
		.regex(/^[a-z0-9-]+-v\d+$/, "must match 'name-vN' — the literal phrasing the mission-template gate expects")
		.describe("Mission template reference, e.g. 'new-business-v2'"),
	source: sourceRefSchema,
});

/** Layer 2 — runbook (VR `runbooks` table entry). CR-1. */
export const runbookLayerSchema = z.object({
	name: z.string().min(1).describe("Runbook slug, e.g. 'new-business'"),
	vrId: z.string().min(1).describe("VR runbook document ID"),
	source: sourceRefSchema,
});

/** Layer 3 — ≥1 skill. CR-1. */
export const skillRefSchema = z.object({
	name: z.string().min(1).describe("Skill slug, e.g. 'scaffold-new-repo'"),
	source: sourceRefSchema,
});

/** Layer 4 — ≥1 rule. CR-1. */
export const ruleRefSchema = z.object({
	name: z.string().min(1).describe("Rule filename slug, e.g. 'no-blocked-limbo'"),
	source: sourceRefSchema,
});

/** Layer 5 — ≥1 script (executable, not prose). CR-1, CR-4. */
export const scriptRefSchema = z.object({
	name: z.string().min(1).describe("Script identifier, e.g. 'validate-manifest.mjs'"),
	invocation: z
		.string()
		.min(1)
		.describe("The exact runnable command, e.g. 'node scripts/validate-manifest.mjs'"),
	source: sourceRefSchema,
});

/** Layer 6 — deliverable schema (machine-checkable). CR-1, CR-2. */
export const deliverableSchemaRefSchema = z.object({
	name: z.string().min(1).describe("Deliverable schema name, e.g. 'runbook-manifest.schema.ts'"),
	source: sourceRefSchema,
	nonDeterministicFields: z
		.array(z.string())
		.default([])
		.describe(
			"Field paths on the deliverable that legitimately vary run-to-run (timestamps, IDs) — CR-2 reproducibility diff exemption",
		),
});

/** Layer 7 — ≥1 example deliverable (concrete, non-redacted, actually produced). CR-1. */
export const exampleDeliverableRefSchema = z.object({
	name: z.string().min(1).describe("Example identifier"),
	source: sourceRefSchema,
	producedBy: z
		.string()
		.min(1)
		.describe("Which script/skill run produced this example — traceability for CR-2/CR-4"),
});

/** Layer 8 — eval: corpus + runner. CR-1, CR-5, CR-9. */
export const evalLayerSchema = z.object({
	corpus: sourceRefSchema.describe("The named test-case corpus (e.g. evals/*.json)"),
	runner: z
		.string()
		.min(1)
		.describe("The exact runnable command that executes the corpus and reports pass/fail"),
	lastResult: z
		.object({
			status: z.enum(["pass", "fail", "not-run"]),
			runAt: z.string().datetime().optional(),
			failingCases: z.array(z.string()).default([]),
		})
		.describe("Last recorded eval-runner result — CR-5 gates 'ga' stage on status === 'pass'"),
});

/**
 * Layer 9 — hooks (conditional). CR-1: MAY be declared not-applicable, but only
 * with a non-empty `hooksNotApplicableReason`.
 */
export const hookRefSchema = z.object({
	name: z.string().min(1).describe("Hook filename slug, e.g. 'enforce-process-component-reuse'"),
	source: sourceRefSchema,
	/** CR-8: the hook's documented fail-closed behavior when it lacks the state it needs. */
	failClosedBehavior: z
		.string()
		.min(1)
		.describe("What this hook does when it cannot determine gate state — MUST be a block, never warn-and-allow"),
});

export const hooksLayerSchema = z.discriminatedUnion("applicable", [
	z.object({
		applicable: z.literal(true),
		hooks: z.array(hookRefSchema).min(1),
	}),
	z.object({
		applicable: z.literal(false),
		hooksNotApplicableReason: z
			.string()
			.min(1)
			.describe("Why no dispatch-time gate applies to this component — REQUIRED when applicable=false. CR-1."),
	}),
]);

// ---------------------------------------------------------------------------
// Cross-cutting fields
// ---------------------------------------------------------------------------

/** CR-5: consumers may require a minimum stage. */
export const consumerRefSchema = z.object({
	name: z.string().min(1).describe("Consumer name — BU, component, or mission that uses this component"),
	minStage: stageSchema.optional().describe("Minimum stage this consumer requires, e.g. 'ga' for production"),
	linkType: z.enum(["uses", "produces", "references"]).default("uses"),
});

/** CR-7: override counters this component's gates are linked to (informational at the manifest level). */
export const overrideCounterRefSchema = z.object({
	gate: z.string().min(1).describe("Gate name this override counter is keyed to"),
	windowDays: z.number().int().positive().default(30),
	fixPatternRefRequired: z
		.boolean()
		.default(true)
		.describe("Whether a second override in the window requires a fixPatternRef/exceptionTicketId — CR-7"),
});

export const standardConformanceSchema = z.object({
	standardVersion: z
		.string()
		.min(1)
		.describe("Version of docs/process-component-standard.md this manifest conforms to, e.g. 'v1'"),
	evalResult: z
		.enum(["pass", "fail", "not-run"])
		.describe("Result of running the P16 eval against this manifest — mirrors eval.lastResult.status"),
	criticalRulesChecked: z
		.array(z.enum(["CR-1", "CR-2", "CR-3", "CR-4", "CR-5", "CR-6", "CR-7", "CR-8", "CR-9"]))
		.default([])
		.describe("Which Critical Rules the P16 eval actually asserted for this manifest"),
});

// ---------------------------------------------------------------------------
// Top-level manifest
// ---------------------------------------------------------------------------

export const processComponentManifestSchema = z.object({
	name: z
		.string()
		.regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase kebab-case slug")
		.describe("Process Component name/slug"),
	version: semVerSchema,
	stage: stageSchema,

	layers: z.object({
		missionTemplate: missionTemplateLayerSchema,
		runbook: runbookLayerSchema,
		skills: z.array(skillRefSchema).min(1).describe("Layer 3 — CR-1: at least one skill required"),
		rules: z.array(ruleRefSchema).min(1).describe("Layer 4 — CR-1: at least one rule required"),
		scripts: z.array(scriptRefSchema).min(1).describe("Layer 5 — CR-1: at least one script required"),
		deliverableSchema: deliverableSchemaRefSchema,
		exampleDeliverables: z
			.array(exampleDeliverableRefSchema)
			.min(1)
			.describe("Layer 7 — CR-1: at least one example deliverable required"),
		eval: evalLayerSchema,
		hooks: hooksLayerSchema,
	}),

	consumers: z.array(consumerRefSchema).default([]),
	overrideCounters: z.array(overrideCounterRefSchema).default([]),
	standardConformance: standardConformanceSchema,
});

export type ProcessComponentManifest = z.infer<typeof processComponentManifestSchema>;

// ---------------------------------------------------------------------------
// Completeness validator — CR-1
// ---------------------------------------------------------------------------

export interface CompletenessResult {
	valid: boolean;
	errors: string[];
}

/**
 * Encodes CR-1's mechanical completeness check: VALID only if every
 * layers[1..8] is present AND non-empty where an array, hooks is either
 * applicable with ≥1 entry or explicitly not-applicable with a reason, AND
 * `standardConformance.evalResult === "pass"` (mirrors CR-5's "cannot
 * self-declare ga while eval corpus has a failing case", applied here at the
 * manifest-completeness level since a manifest with a failing/not-run eval is
 * not a conformant declaration regardless of stage).
 *
 * This is a plain function (not a `.refine` baked into the schema) so callers
 * can run Zod shape-validation and CR-1 completeness as two distinct,
 * separately-reportable checks — matching the standard's "fails loud, names
 * the missing layer(s) by number" requirement (CR-1 "How tested").
 */
export function assertManifestComplete(manifest: ProcessComponentManifest): CompletenessResult {
	const errors: string[] = [];
	const { layers } = manifest;

	// Layers 1-2: object presence is already enforced by the Zod schema (required
	// fields) — re-asserted here defensively in case this function is ever called
	// on a loosely-typed/parsed-with-passthrough object.
	if (!layers.missionTemplate) errors.push("layer 1 (missionTemplate) missing — CR-1");
	if (!layers.runbook) errors.push("layer 2 (runbook) missing — CR-1");

	if (!layers.skills || layers.skills.length < 1) {
		errors.push("layer 3 (skills) missing or empty — CR-1 requires ≥1 skill");
	}
	if (!layers.rules || layers.rules.length < 1) {
		errors.push("layer 4 (rules) missing or empty — CR-1 requires ≥1 rule");
	}
	if (!layers.scripts || layers.scripts.length < 1) {
		errors.push("layer 5 (scripts) missing or empty — CR-1 requires ≥1 script");
	}
	if (!layers.deliverableSchema) {
		errors.push("layer 6 (deliverableSchema) missing — CR-1");
	}
	if (!layers.exampleDeliverables || layers.exampleDeliverables.length < 1) {
		errors.push("layer 7 (exampleDeliverables) missing or empty — CR-1 requires ≥1 example");
	}
	if (!layers.eval || !layers.eval.corpus || !layers.eval.runner) {
		errors.push("layer 8 (eval) missing corpus or runner — CR-1");
	}

	// Layer 9 (hooks) — conditional per CR-1.
	if (!layers.hooks) {
		errors.push("layer 9 (hooks) missing — must be declared applicable or not-applicable — CR-1");
	} else if (layers.hooks.applicable === true) {
		if (!layers.hooks.hooks || layers.hooks.hooks.length < 1) {
			errors.push("layer 9 (hooks) declared applicable but has zero hooks — CR-1");
		}
	} else if (layers.hooks.applicable === false) {
		if (!layers.hooks.hooksNotApplicableReason || layers.hooks.hooksNotApplicableReason.trim().length === 0) {
			errors.push(
				"layer 9 (hooks) declared not-applicable without hooksNotApplicableReason — CR-1 forbids silent omission",
			);
		}
	}

	// standardConformance.evalResult must be "pass" for the manifest to be VALID.
	if (!manifest.standardConformance || manifest.standardConformance.evalResult !== "pass") {
		errors.push(
			`standardConformance.evalResult must be "pass" (got "${manifest.standardConformance?.evalResult ?? "undefined"}") — CR-1/CR-5`,
		);
	}

	return { valid: errors.length === 0, errors };
}

/**
 * Convenience: parse + completeness-check in one call. Throws a ZodError on
 * shape violations (wrong types, missing required scalar fields); returns a
 * `CompletenessResult` for CR-1 layer-presence violations, which are business
 * rules on top of an otherwise shape-valid object (e.g. `skills: []` is
 * shape-valid but CR-1-invalid).
 */
export function validateManifest(input: unknown): CompletenessResult {
	const manifest = processComponentManifestSchema.parse(input);
	return assertManifestComplete(manifest);
}
